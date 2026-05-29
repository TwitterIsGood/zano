import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { readdir, readFile, stat, lstat } from "fs/promises";
import { join, resolve, sep } from "path";
import { homedir } from "os";
import { AgentManager, type RuntimeBoundaryObserver } from "./agent-manager.js";
import { redactRuntimeText, serializeRuntimeError } from "./runtime/redaction.js";
import {
  AgentSupervisor,
  DeliveryLedger,
  DeliveryRuntime,
  RuntimeSessionLedger,
  StartCoordinator,
  SupabaseDeliveryLedgerStore,
  SupabaseRuntimeSessionStore,
  type RuntimeDeliveryInput,
  type RuntimeDeliveryRecord,
} from "./runtime/index.js";
import {
  buildActivationEnvelope,
  buildCooldownKey,
  classifyConversationSpace,
  classifyMessageIntent,
  deriveTopicKey,
  planA2ADeliveries,
  selectActivationCandidates,
  shouldSuppressForCooldown,
  type A2AMessageSummary,
  type ActivationCandidate,
  type ActivationCooldownEntry,
  type ActivationReason,
  type DeliveryThreadContext,
  type ProtocolAgent,
  type ProtocolMessage,
  type ProtocolRecentMessage,
  type ProtocolTaskRef,
  type SuppressedCandidate,
} from "./a2a-protocol.js";

interface OmniCredentialRefresh {
  token: string;
  agentAuthTokens: Record<string, string>;
}

interface OmniConfig {
  supabaseUrl: string;
  supabaseKey: string;    // anon key
  authToken: string;       // JWT for authenticated Supabase operations
  agentAuthTokens?: Record<string, string>; // per-agent actor JWTs for spawned agent processes
  refreshCredentials?: () => Promise<OmniCredentialRefresh>;
  userId: string;
  serverId: string;
  serverName?: string;
  agentsDir: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  omniVersion?: string;
}

export interface DbMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  thread_parent_id: string | null;
  created_at: string;
}

export interface DbAgent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string;
  status: string;
  server_id?: string;
  archived_at?: string | null;
}

interface DbChannelMember {
  channel_id: string;
  member_id: string;
  member_type: string;
}

interface DbTaskRoutingRef {
  id: string;
  task_number: number;
  message_id: string | null;
  source_message_id: string | null;
  source_thread_parent_id: string | null;
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by_id: string | null;
}

interface DbAgentBlueprint {
  id: string;
  slug: string;
  display_name_template: string;
  description: string;
  system_prompt_template: string;
  default_model: string;
  state: string;
  server_id: string;
}

interface DbAgentSpawnEvent {
  id: string;
  server_id: string;
  blueprint_id: string | null;
  agent_id: string | null;
  request_event_id: string | null;
  event_type: string;
  actor_id: string;
  actor_type: "human" | "agent" | "system";
  reason: string;
  source_refs: unknown[];
}

interface DbReminder {
  id: string;
  server_id: string;
  created_by_id: string;
  created_by_type: "human" | "agent" | "system";
  recipient_id: string;
  recipient_type: "human" | "agent";
  channel_id: string;
  source_message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  target: string;
  body: string;
  due_at: string;
  snoozed_until: string | null;
  state: "pending" | "snoozed" | "firing" | "fired" | "completed" | "cancelled" | "failed";
  fired_at: string | null;
  fired_delivery_id: string | null;
  last_error: string | null;
}
export interface RoutingDelivery {
  candidate: ActivationCandidate;
  agent: DbAgent;
  prompt: string;
  threadContext?: DeliveryThreadContext;
}

export interface BuildRuntimeDeliveryInputParams {
  workspaceId: string;
  msg: DbMessage;
  delivery: RoutingDelivery;
  target: string;
  taskId: string | null;
}

export function buildRuntimeDeliveryInput(input: BuildRuntimeDeliveryInputParams): RuntimeDeliveryInput {
  return {
    workspaceId: input.workspaceId,
    agentId: input.delivery.candidate.agentId,
    channelId: input.msg.channel_id,
    sourceMessageId: input.msg.id,
    threadParentId: input.msg.thread_parent_id,
    taskId: input.taskId,
    target: input.target,
    activationReasons: [...input.delivery.candidate.reasons],
    activationStrength: input.delivery.candidate.strength,
    prompt: input.delivery.prompt,
    sourceCreatedAt: input.msg.created_at,
    senderId: input.msg.sender_id,
    senderType: input.msg.sender_type,
  };
}

const MESSAGE_CATCHUP_INTERVAL_MS = 15_000;
const MESSAGE_CATCHUP_OVERLAP_MS = 5_000;

type RoutingSuppressedCandidate = SuppressedCandidate | { agentId: string; reason: string; reasons: ActivationReason[] };

interface RoutingPlan {
  msg: DbMessage;
  topicKey: string;
  activated: ActivationCandidate[];
  suppressed: RoutingSuppressedCandidate[];
  deliveries: RoutingDelivery[];
  target: string;
  taskId: string | null;
}

interface RoutingExecutionResult {
  deliveredAgentIds: string[];
  failedAgentIds: string[];
}

export class Omni {
  private supabase: SupabaseClient;
  private agentManager: AgentManager;
  private config: OmniConfig;
  // Maps channel_id -> Set of agent_ids in that channel
  private channelAgents = new Map<string, Set<string>>();
  private channelsWithMissingAgentCredentials = new Set<string>();
  // Maps channel_id -> channel type ('dm' | 'public' | 'private')
  private channelTypes = new Map<string, string>();
  // Maps channel_id -> channel name
  private channelNames = new Map<string, string>();
  // Maps agent_id -> agent DB record
  private agentRecords = new Map<string, DbAgent>();
  // Realtime channel for workspace file RPC (web UI ↔ Omni)
  private workspaceRpcChannel: RealtimeChannel | null = null;
  // Presence channel for online status (auto-offline on disconnect)
  private presenceChannel: RealtimeChannel | null = null;
  private spawnGovernorChannel: RealtimeChannel | null = null;
  // Heartbeat timer for machine_keys.last_used_at (polling fallback for online status)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private messageCatchupInterval: ReturnType<typeof setInterval> | null = null;
  private messageCatchupCursor: string | null = null;
  private processedMessageIds = new Set<string>();
  private processingMessageIds = new Set<string>();
  private pendingMessageRetries = new Map<string, DbMessage>();
  private scheduledMessageRetries = new Map<string, { msg: DbMessage; attempts: number; timer: ReturnType<typeof setTimeout> | null }>();
  private deliveredMessageAgentIds = new Map<string, Set<string>>();
  private activationCooldowns = new Map<string, ActivationCooldownEntry>();
  private topicHopCounts = new Map<string, number>();
  private autonomousSpawnEnabled = process.env.ZANO_ENABLE_AUTONOMOUS_SPAWN === "1";
  private deliveryRuntime: DeliveryRuntime | null = null;
  private runtimeSupervisor: AgentSupervisor | null = null;
  private daemonV2Enabled = process.env.ZANO_DAEMON_V2 === "1";

  constructor(config: OmniConfig) {
    this.config = config;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${config.authToken}` },
      },
    });
    // Set auth token for Realtime WebSocket (global headers only cover REST)
    this.supabase.realtime.setAuth(config.authToken);
    this.agentManager = new AgentManager(
      config.agentsDir,
      this.supabase,
      config.supabaseUrl,
      config.supabaseKey,
      config.authToken,
      config.agentAuthTokens ?? {}
    );

    this.configureDeliveryRuntime();
  }

  private configureDeliveryRuntime(): void {
    if (!this.daemonV2Enabled) {
      this.runtimeSupervisor = null;
      this.deliveryRuntime = null;
      this.agentManager.configureRuntimeBoundaryObserver(null);
      return;
    }

    const machineId = this.config.hostname ?? this.config.serverId;
    const supervisor = new AgentSupervisor();
    const runtimeSessionLedger = new RuntimeSessionLedger({ store: new SupabaseRuntimeSessionStore(this.supabase) });
    this.agentManager.configureDaemonRuntime({
      workspaceId: this.config.serverId,
      workspaceName: this.config.serverName ?? this.config.serverId,
      machineId,
      hostname: this.config.hostname ?? machineId,
      platform: this.config.platform ?? process.platform,
      arch: this.config.arch ?? process.arch,
      omniVersion: this.config.omniVersion ?? process.env.npm_package_version ?? "0.1.5",
    }, runtimeSessionLedger);
    this.runtimeSupervisor = supervisor;
    const deliveryRuntime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store: new SupabaseDeliveryLedgerStore(this.supabase) }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 5, startIntervalMs: 500 }),
      driver: {
        deliver: (agentId, prompt) => this.agentManager.deliverRuntimeMessage(agentId, prompt),
        setCurrentDelivery: (agentId, context) => this.agentManager.setCurrentDelivery(agentId, context),
      },
      machineId,
      onQueuedGated: ({ agentId, queueDepth }) => this.agentManager.reportRuntimeBacklog(agentId, queueDepth),
    });
    this.deliveryRuntime = deliveryRuntime;

    const boundaryObserver: RuntimeBoundaryObserver = {
      recordGatedEvent: (agentId, event) => supervisor.recordGatedEvent(agentId, event),
      getGatedState: (agentId) => supervisor.getState(agentId).gatedSteering,
      getPendingMessageCount: (agentId) => supervisor.getState(agentId).queueDepth,
      markPendingNotification: (agentId, count) => supervisor.markPendingNotification(agentId, count),
      sendPendingNotification: (agentId, count) => this.agentManager.sendRuntimePendingNotification(agentId, count),
      flushDaemonInbox: async (agentId, reason) => {
        await deliveryRuntime.flushQueuedDeliveries(agentId, reason);
      },
    };
    this.agentManager.configureRuntimeBoundaryObserver(boundaryObserver);
  }

  /** Update the auth token (called on periodic refresh) */
  async updateAuthToken(token: string, agentAuthTokens: Record<string, string> = {}) {
    this.config.authToken = token;
    this.config.agentAuthTokens = agentAuthTokens;
    this.pruneAgentsWithoutTokens(agentAuthTokens);
    // Remove all channels before recreating client
    await this.supabase.removeAllChannels();
    this.workspaceRpcChannel = null;
    this.presenceChannel = null;
    this.spawnGovernorChannel = null;
    // Recreate the Supabase client with the new token
    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    this.supabase.realtime.setAuth(token);
    // Update agent manager's client too
    this.agentManager.updateSupabaseClient(this.supabase, token, agentAuthTokens);
    this.configureDeliveryRuntime();
    // Re-subscribe everything on new client
    this.subscribeToMessages();
    this.startMessageCatchup();
    this.subscribeToNewAgents();
    this.subscribeToSpawnRequests();
    this.subscribeToWorkspaceRpc();
    this.trackPresence();
    this.startReminderScheduler();
  }

  private pruneArchivedAgent(agentId: string): void {
    const agent = this.agentRecords.get(agentId);
    let changed = false;

    if (agent) {
      this.agentManager.stopAgent(agentId, "Agent archived");
      const drainedDeliveryIds = this.runtimeSupervisor?.drainInbox(agentId) ?? [];
      this.cancelArchivedAgentDeliveries(agentId, drainedDeliveryIds);
      this.runtimeSupervisor?.markStale(agentId);
      this.agentRecords.delete(agentId);
      changed = true;
    }

    for (const [channelId, agentIds] of Array.from(this.channelAgents.entries())) {
      const isArchivedDmTarget = this.dmTargetAgentId(channelId) === agentId;
      if (agentIds.delete(agentId)) changed = true;
      if (isArchivedDmTarget) {
        this.channelAgents.delete(channelId);
        this.channelsWithMissingAgentCredentials.delete(channelId);
        changed = true;
        continue;
      }
      if (agentIds.size === 0 || this.pruneMissingDmTarget(channelId, agentIds)) {
        this.channelAgents.delete(channelId);
        changed = true;
      }
    }

    if (!changed) return;

    this.updatePresence();
    console.log(`  [Omni] Archived agent pruned: ${agent?.display_name ?? agentId}`);
  }

  private cancelArchivedAgentDeliveries(agentId: string, deliveryIds: string[]): void {
    this.cancelPrunedAgentDeliveries(agentId, deliveryIds, "agent_archived", "delivery.cancelled_archived_agent");
  }

  private cancelTokenRemovedAgentDeliveries(agentId: string, deliveryIds: string[]): void {
    this.cancelPrunedAgentDeliveries(agentId, deliveryIds, "agent_token_removed", "delivery.cancelled_agent_token_removed");
  }

  private cancelPrunedAgentDeliveries(agentId: string, deliveryIds: string[], runtimeOutcome: "agent_archived" | "agent_token_removed", eventName: string): void {
    if (!this.deliveryRuntime || deliveryIds.length === 0) return;

    void Promise.all(deliveryIds.map(async (deliveryId) => {
      try {
        await this.deliveryRuntime!.ledger.transition(deliveryId, "cancelled", {
          eventName,
          attributes: { agentId, reason: runtimeOutcome },
          runtimeOutcome,
        });
      } catch (error) {
        console.warn(`  [Omni] Failed to cancel pruned-agent delivery ${deliveryId}:`, serializeRuntimeError(error));
      }
    }));
  }

  private pruneAgentsWithoutTokens(agentAuthTokens: Record<string, string>): void {
    for (const agentId of Array.from(this.agentRecords.keys())) {
      if (agentAuthTokens[agentId]) continue;

      this.agentManager.stopAgent(agentId, "Agent credentials removed");
      const drainedDeliveryIds = this.runtimeSupervisor?.drainInbox(agentId) ?? [];
      this.cancelTokenRemovedAgentDeliveries(agentId, drainedDeliveryIds);
      this.runtimeSupervisor?.markStale(agentId);
      this.agentRecords.delete(agentId);
      for (const [channelId, agentIds] of Array.from(this.channelAgents.entries())) {
        agentIds.delete(agentId);
        if (agentIds.size === 0 || this.pruneMissingDmTarget(channelId, agentIds)) this.channelAgents.delete(channelId);
      }
    }
  }

  async start() {
    // 1. Load this user's agents from DB
    await this.loadAgents();

    // 2. Load channel memberships for these agents
    await this.loadChannelMemberships();

    // 3. Initialize agent workspaces
    for (const [agentId, agent] of this.agentRecords) {
      await this.agentManager.initAgent(agentId, agent);
    }

    // 4. Update agent statuses to 'online' (best-effort DB backup)
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length > 0) {
      await this.supabase
        .from("agents")
        .update({ status: "online" })
        .in("id", agentIds);
    }

    // 5. Subscribe to new messages in channels where agents are members
    this.subscribeToMessages();
    this.startMessageCatchup();
    await this.processRecentHumanMessages();

    // 6. Subscribe to new agents and channel memberships (for agents created via UI)
    this.subscribeToNewAgents();

    // 7. Subscribe to autonomous spawn requests (disabled unless explicitly enabled)
    this.subscribeToSpawnRequests();

    // 8. Subscribe to workspace file RPC (web UI requests files via Realtime)
    this.subscribeToWorkspaceRpc();

    // 9. Track presence (auto-offline on disconnect — no SIGINT needed)
    this.trackPresence();

    // 10. Start heartbeat (updates machine_keys.last_used_at every 30s for polling-based status)
    this.startHeartbeat();

    // 11. Start persisted reminder wake-ups.
    this.startReminderScheduler();

    console.log(
      `  Omni ready. Listening for messages across ${this.channelAgents.size} channel(s).`
    );
    console.log(
      `  Managing ${this.agentRecords.size} agent(s): ${Array.from(this.agentRecords.values()).map((a) => a.display_name).join(", ")}`
    );
  }

  private async loadAgents() {
    const { data: agents, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("owner_id", this.config.userId)
      .eq("server_id", this.config.serverId)
      .is("archived_at", null);

    if (error) {
      console.error("  Failed to load agents:", serializeRuntimeError(error));
      return;
    }

    for (const agent of agents || []) {
      if (!this.config.agentAuthTokens?.[agent.id]) {
        console.warn(`  Skipping ${agent.display_name}: missing agent auth token.`);
        continue;
      }
      this.agentRecords.set(agent.id, agent as DbAgent);
    }

    this.agentManager.purgeCredentialsForInactiveAgents(Array.from(this.agentRecords.keys()));

    console.log(`  Loaded ${this.agentRecords.size} agent(s) from database.`);
  }

  private async loadChannelMemberships() {
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length === 0) return;

    const { data: memberships, error } = await this.supabase
      .from("channel_members")
      .select("channel_id, member_id")
      .eq("member_type", "agent")
      .in("member_id", agentIds);

    if (error) {
      console.error("  Failed to load memberships:", serializeRuntimeError(error));
      return;
    }

    const channelIds = new Set<string>();
    for (const m of memberships || []) {
      const mem = m as DbChannelMember;
      if (!this.channelAgents.has(mem.channel_id)) {
        this.channelAgents.set(mem.channel_id, new Set());
      }
      this.channelAgents.get(mem.channel_id)!.add(mem.member_id);
      channelIds.add(mem.channel_id);
    }

    // Load channel types and names
    if (channelIds.size > 0) {
      const { data: channels } = await this.supabase
        .from("channels")
        .select("id, name, type")
        .in("id", Array.from(channelIds));

      for (const ch of channels || []) {
        this.channelTypes.set(ch.id, ch.type);
        this.channelNames.set(ch.id, ch.name);
      }

      for (const [channelId, memberAgentIds] of Array.from(this.channelAgents.entries())) {
        const targetAgentId = this.dmTargetAgentId(channelId);
        if (targetAgentId && !memberAgentIds.has(targetAgentId)) {
          const uninitializedOwnedAgentIds = await this.hydrateMissingAgentRecords([targetAgentId]);
          if (this.agentRecords.has(targetAgentId) && this.config.agentAuthTokens?.[targetAgentId]) {
            memberAgentIds.add(targetAgentId);
            this.channelsWithMissingAgentCredentials.delete(channelId);
            continue;
          }
          if (uninitializedOwnedAgentIds.has(targetAgentId)) {
            this.channelsWithMissingAgentCredentials.add(channelId);
            continue;
          }
        }
        this.pruneMissingDmTarget(channelId, memberAgentIds);
      }
    }
  }

  private async refreshCredentialsForAgents(agentIds: string[]): Promise<void> {
    const missingCredentialIds = agentIds.filter((agentId) => !this.config.agentAuthTokens?.[agentId]);
    if (missingCredentialIds.length === 0 || !this.config.refreshCredentials) return;

    try {
      const fresh = await this.config.refreshCredentials();
      const agentAuthTokens = fresh.agentAuthTokens;
      this.config.authToken = fresh.token;
      this.config.agentAuthTokens = agentAuthTokens;
      this.pruneAgentsWithoutTokens(agentAuthTokens);
      this.supabase.realtime.setAuth(fresh.token);
      this.agentManager.updateAgentAuthTokens(agentAuthTokens);
    } catch (error) {
      console.warn("  Failed to refresh agent credentials:", serializeRuntimeError(error));
    }
  }

  private async initializeNewAgentRecord(agent: DbAgent): Promise<boolean> {
    if (this.agentRecords.has(agent.id)) return false;

    await this.refreshCredentialsForAgents([agent.id]);
    if (!this.config.agentAuthTokens?.[agent.id]) {
      console.warn(`  Skipping ${agent.display_name}: missing agent auth token.`);
      return false;
    }

    this.agentRecords.set(agent.id, agent);
    await this.agentManager.initAgent(agent.id, agent);
    return true;
  }

  private async hydrateMissingAgentRecords(agentIds: string[]): Promise<Set<string>> {
    const missingAgentIds = [...new Set(agentIds)].filter((agentId) => !this.agentRecords.has(agentId));
    if (missingAgentIds.length === 0) return new Set();

    const { data: agents, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("owner_id", this.config.userId)
      .eq("server_id", this.config.serverId)
      .is("archived_at", null)
      .in("id", missingAgentIds);

    if (error) {
      console.warn("  Failed to hydrate new channel agents:", serializeRuntimeError(error));
      return new Set(missingAgentIds);
    }

    const initializedAgentIds: string[] = [];
    const uninitializedOwnedAgentIds = new Set<string>();
    for (const agentRecord of agents || []) {
      const agent = agentRecord as DbAgent;
      if (await this.initializeNewAgentRecord(agent)) {
        initializedAgentIds.push(agent.id);
      } else if (!this.agentRecords.has(agent.id)) {
        uninitializedOwnedAgentIds.add(agent.id);
      }
    }

    if (initializedAgentIds.length > 0) {
      await this.supabase.from("agents").update({ status: "online" }).in("id", initializedAgentIds);
      this.updatePresence();
    }

    return uninitializedOwnedAgentIds;
  }

  private async refreshChannelAgents(channelId: string): Promise<Set<string>> {
    const { data: memberships, error } = await this.supabase
      .from("channel_members")
      .select("channel_id, member_id")
      .eq("channel_id", channelId)
      .eq("member_type", "agent");

    if (error) {
      console.warn("  Failed to refresh channel memberships:", serializeRuntimeError(error));
      this.channelsWithMissingAgentCredentials.add(channelId);
      return new Set();
    }

    const memberAgentIds = (memberships || []).map((membership) => (membership as DbChannelMember).member_id);
    const inactiveMemberAgentIds = new Set<string>();

    if (memberAgentIds.length > 0) {
      const { data: memberAgentRows, error: memberAgentError } = await this.supabase
        .from("agents")
        .select("id, owner_id, server_id, archived_at")
        .in("id", memberAgentIds);

      if (memberAgentError) {
        console.warn("  Failed to refresh channel agents:", serializeRuntimeError(memberAgentError));
        this.channelsWithMissingAgentCredentials.add(channelId);
        this.channelAgents.delete(channelId);
        return new Set();
      }

      for (const row of (memberAgentRows || []) as Array<{ id: string; owner_id?: string | null; server_id?: string | null; archived_at?: string | null }>) {
        const isActiveOwnedAgent = row.owner_id === this.config.userId && row.server_id === this.config.serverId && row.archived_at == null;
        if (!isActiveOwnedAgent) inactiveMemberAgentIds.add(row.id);
      }

      for (const agentId of inactiveMemberAgentIds) {
        this.pruneArchivedAgent(agentId);
      }
    }

    const refreshableMemberAgentIds = memberAgentIds.filter((agentId) => !inactiveMemberAgentIds.has(agentId));
    const missingMemberAgentIds = refreshableMemberAgentIds.filter((agentId) => !this.agentRecords.has(agentId));
    this.pruneAgentsWithoutTokens(this.config.agentAuthTokens ?? {});
    const uninitializedOwnedAgentIds = await this.hydrateMissingAgentRecords(missingMemberAgentIds);

    const refreshed = new Set<string>();
    for (const agentId of refreshableMemberAgentIds) {
      if (this.agentRecords.has(agentId) && this.config.agentAuthTokens?.[agentId]) {
        refreshed.add(agentId);
      }
    }

    if (!this.channelTypes.has(channelId) || !this.channelNames.has(channelId)) {
      const { data: channel } = await this.supabase
        .from("channels")
        .select("id, name, type")
        .eq("id", channelId)
        .maybeSingle();

      if (channel) {
        this.channelTypes.set(channelId, channel.type);
        this.channelNames.set(channelId, channel.name);
      }
    }

    if (uninitializedOwnedAgentIds.size > 0) {
      this.channelsWithMissingAgentCredentials.add(channelId);
    } else {
      this.channelsWithMissingAgentCredentials.delete(channelId);
      if (this.pruneMissingDmTarget(channelId, refreshed)) return new Set();
    }

    if (refreshed.size > 0) this.channelAgents.set(channelId, refreshed);
    else this.channelAgents.delete(channelId);

    return refreshed;
  }

  private subscribeToMessages() {
    const subscription = this.supabase
      .channel("omni-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          const msg = payload.new as DbMessage;
          this.handleNewMessage(msg);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Subscribed to Supabase Realtime.");
        } else if (status === "CHANNEL_ERROR") {
          console.error("  Supabase Realtime subscription error.");
        }
      });
  }

  private toProtocolAgents(agentIds: Set<string>): ProtocolAgent[] {
    return Array.from(agentIds)
      .map((agentId) => {
        const agent = this.agentRecords.get(agentId);
        if (!agent) return null;
        return {
          id: agentId,
          name: agent.name,
          displayName: agent.display_name,
          description: agent.description,
        } satisfies ProtocolAgent;
      })
      .filter((agent): agent is ProtocolAgent => agent !== null);
  }

  private async findRoutingTaskForMessage(msg: DbMessage): Promise<ProtocolTaskRef | null> {
    const messageIds = [msg.id, msg.thread_parent_id].filter(Boolean) as string[];
    if (messageIds.length === 0) return null;

    const { data } = await this.supabase
      .from("tasks")
      .select("id, task_number, message_id, source_message_id, source_thread_parent_id, assignee_id, reviewer_id, created_by_id")
      .or(messageIds.map((id) => `message_id.eq.${id},source_message_id.eq.${id},source_thread_parent_id.eq.${id}`).join(","))
      .limit(1)
      .maybeSingle();

    if (!data) return null;
    const task = data as DbTaskRoutingRef;
    return {
      id: task.id,
      taskNumber: task.task_number,
      messageId: task.message_id,
      sourceMessageId: task.source_message_id,
      assigneeId: task.assignee_id,
      reviewerId: task.reviewer_id,
      createdById: task.created_by_id,
    };
  }

  private async getRecentProtocolMessages(channelId: string, threadParentId: string | null): Promise<ProtocolRecentMessage[]> {
    let query = this.supabase
      .from("messages")
      .select("sender_id, sender_type, content, created_at")
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (threadParentId) query = query.eq("thread_parent_id", threadParentId);
    else query = query.is("thread_parent_id", null);

    const { data } = await query;
    return (data || []).reverse().map((message) => ({
      senderId: message.sender_id,
      senderType: message.sender_type,
      content: message.content,
      createdAt: message.created_at,
    }));
  }

  private async getThreadParticipantAgentIds(threadParentId: string | null, agentIdsInChannel: Set<string>): Promise<string[]> {
    if (!threadParentId) return [];

    const { data, error } = await this.supabase
      .from("thread_participants")
      .select("participant_id")
      .eq("thread_parent_id", threadParentId)
      .eq("participant_type", "agent");

    if (error) {
      console.warn("  [A2A] Failed to load thread participants:", serializeRuntimeError(error));
      return [];
    }

    return (data || [])
      .map((participant) => participant.participant_id as string)
      .filter((agentId) => agentIdsInChannel.has(agentId));
  }

  private async getThreadJoinFacts(msg: DbMessage): Promise<{ id: string; parentMessage: A2AMessageSummary; recentMessages: A2AMessageSummary[] } | undefined> {
    if (!msg.thread_parent_id) return undefined;

    const { data: parent, error: parentError } = await this.supabase
      .from("messages")
      .select("id, channel_id, content, thread_parent_id, created_at")
      .eq("id", msg.thread_parent_id)
      .maybeSingle();

    if (parentError) {
      console.warn("  [A2A] Failed to load thread parent:", serializeRuntimeError(parentError));
      return undefined;
    }

    if (!parent || parent.id !== msg.thread_parent_id || parent.channel_id !== msg.channel_id || parent.thread_parent_id !== null) {
      return undefined;
    }

    const { data: recent, error: recentError } = await this.supabase
      .from("messages")
      .select("id, content, created_at")
      .eq("channel_id", msg.channel_id)
      .eq("thread_parent_id", msg.thread_parent_id)
      .order("created_at", { ascending: false })
      .limit(11);

    if (recentError) {
      console.warn("  [A2A] Failed to load thread recent messages:", serializeRuntimeError(recentError));
      return undefined;
    }

    return {
      id: msg.thread_parent_id,
      parentMessage: {
        id: parent.id,
        text: parent.content,
        createdAt: parent.created_at,
      },
      recentMessages: (recent || [])
        .filter((message) => message.id !== msg.id)
        .slice(0, 10)
        .reverse()
        .map((message) => ({
          id: message.id,
          text: message.content,
          createdAt: message.created_at,
        })),
    };
  }

  private formatThreadJoinContext(context: DeliveryThreadContext): string {
    const recentMessages = context.recentMessages.length > 0
      ? context.recentMessages.map((message) => `- [${message.createdAt}] ${message.text}`).join("\n")
      : "- none";

    return [
      "--- Thread join context (bounded) ---",
      `threadTarget=${context.threadTarget}`,
      `suggestedReadTarget=${context.suggestedReadTarget}`,
      `parent [${context.parentMessage.createdAt}] ${context.parentMessage.text}`,
      "recentMessages:",
      recentMessages,
      "---",
    ].join("\n");
  }

  private formatRoutingLog(input: {
    messageId: string;
    topicKey: string;
    activated: Array<{ agentId: string; reasons: ActivationReason[]; strength: string }>;
    suppressed: Array<{ agentId: string; reason: string; reasons: ActivationReason[] }>;
  }) {
    const activated = input.activated.map((candidate) => {
      const agent = this.agentRecords.get(candidate.agentId);
      return `${agent?.display_name || candidate.agentId}:${candidate.strength}:${candidate.reasons.join("+")}`;
    });
    const suppressed = input.suppressed.map((candidate) => {
      const agent = this.agentRecords.get(candidate.agentId);
      return `${agent?.display_name || candidate.agentId}:${candidate.reason}:${candidate.reasons.join("+")}`;
    });
    console.log(`  [A2A] route msg=${input.messageId.slice(0, 8)} topic=${input.topicKey} activated=[${activated.join(", ")}] suppressed=[${suppressed.join(", ")}]`);
  }

  /**
   * Fetch recent channel history for context.
   */
  private async getChannelContext(
    channelId: string,
    limit: number = 10
  ): Promise<string> {
    const { data: messages } = await this.supabase
      .from("messages")
      .select("sender_id, sender_type, content, created_at")
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!messages || messages.length === 0) return "";

    const lines = messages.reverse().map((m) => {
      let senderName = "Unknown";
      if (m.sender_type === "human") {
        senderName = "User";
      } else if (m.sender_type === "system") {
        senderName = "System";
      } else {
        const agent = this.agentRecords.get(m.sender_id);
        senderName = agent?.display_name || "Agent";
      }
      return `[${senderName}]: ${m.content.substring(0, 300)}`;
    });

    return `\n--- Recent channel messages ---\n${lines.join("\n")}\n---`;
  }

  /**
   * Resolve the display name for a sender_id (human or agent).
   */
  private async resolveSenderName(
    senderId: string,
    senderType: string
  ): Promise<string> {
    if (senderType === "agent") {
      const agent = this.agentRecords.get(senderId);
      if (agent) return agent.display_name;
    }

    // Try profiles table for humans
    const { data } = await this.supabase
      .from("profiles")
      .select("display_name")
      .eq("id", senderId)
      .single();
    return data?.display_name || "User";
  }

  private shortId(id: string): string {
    return id.replace(/-/g, "").slice(0, 8);
  }

  private agentIdFromDmChannelName(name: string | undefined): string | null {
    return name?.startsWith("dm-") ? name.slice(3) : null;
  }

  private dmTargetAgentId(channelId: string): string | null {
    if (this.channelTypes.get(channelId) !== "dm") return null;
    return this.agentIdFromDmChannelName(this.channelNames.get(channelId));
  }

  private isMissingDmTarget(channelId: string, agentIds: Set<string>): boolean {
    const targetAgentId = this.dmTargetAgentId(channelId);
    return Boolean(targetAgentId && !agentIds.has(targetAgentId));
  }

  private pruneMissingDmTarget(channelId: string, agentIds: Set<string>): boolean {
    if (!this.isMissingDmTarget(channelId, agentIds)) return false;
    this.channelAgents.delete(channelId);
    this.channelsWithMissingAgentCredentials.delete(channelId);
    return true;
  }

  /**
   * Build a target string for the channel (e.g. "#general" or a raw DM channel id).
   */
  private buildChannelTarget(channelId: string, senderName?: string, threadParentId?: string | null): string {
    const ch = this.channelTypes.get(channelId);
    let target = channelId;
    if (ch !== "dm") {
      for (const [id, info] of this.channelNames) {
        if (id === channelId) {
          target = `#${info}`;
          break;
        }
      }
    }
    return threadParentId ? `${target}:${this.shortId(threadParentId)}` : target;
  }

  private startMessageCatchup(): void {
    if (this.messageCatchupInterval) clearInterval(this.messageCatchupInterval);
    this.messageCatchupCursor ??= new Date().toISOString();
    this.messageCatchupInterval = setInterval(() => {
      void this.processMissedMessages();
    }, MESSAGE_CATCHUP_INTERVAL_MS);
    (this.messageCatchupInterval as { unref?: () => void }).unref?.();
  }

  private async processMissedMessages() {
    const channelIds = Array.from(this.channelAgents.keys());
    if (channelIds.length === 0) {
      this.messageCatchupCursor = new Date().toISOString();
      return;
    }

    const since = this.messageCatchupCursor ?? new Date(Date.now() - MESSAGE_CATCHUP_INTERVAL_MS).toISOString();
    const { data: messages, error } = await this.supabase
      .from("messages")
      .select("id, channel_id, sender_id, sender_type, content, thread_parent_id, created_at")
      .in("channel_id", channelIds)
      .in("sender_type", ["human", "agent"])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      console.warn("  [A2A] Failed to catch up missed messages:", serializeRuntimeError(error));
      return;
    }

    for (const msg of messages || []) {
      await this.handleNewMessage(msg as DbMessage);
    }

    this.messageCatchupCursor = new Date(Date.now() - MESSAGE_CATCHUP_OVERLAP_MS).toISOString();
  }

  private async processRecentHumanMessages() {
    const channelIds = Array.from(this.channelAgents.keys());
    if (channelIds.length === 0) return;

    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: messages, error } = await this.supabase
      .from("messages")
      .select("id, channel_id, sender_id, sender_type, content, thread_parent_id, created_at")
      .in("channel_id", channelIds)
      .eq("sender_type", "human")
      .is("thread_parent_id", null)
      .gte("created_at", since)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("  Failed to process recent messages:", serializeRuntimeError(error));
      return;
    }

    for (const msg of messages || []) {
      await this.handleNewMessage(msg as DbMessage);
    }
  }

  private clearActivationCooldownsForMessage(messageId: string): void {
    for (const [key, entry] of this.activationCooldowns) {
      if (entry.sourceMessageId === messageId) this.activationCooldowns.delete(key);
    }
  }

  private markMessageDeliveries(messageId: string, agentIds: string[]): void {
    if (agentIds.length === 0) return;
    const delivered = this.deliveredMessageAgentIds.get(messageId) ?? new Set<string>();
    for (const agentId of agentIds) delivered.add(agentId);
    this.deliveredMessageAgentIds.set(messageId, delivered);
  }

  private clearScheduledMessageRetry(messageId: string): void {
    const retry = this.scheduledMessageRetries.get(messageId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.scheduledMessageRetries.delete(messageId);
  }

  private scheduleMessageRetry(msg: DbMessage): void {
    if (this.processedMessageIds.has(msg.id)) return;
    const existing = this.scheduledMessageRetries.get(msg.id);
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > 30) {
      console.warn(`  [A2A] Giving up deferred retry for message ${this.shortId(msg.id)} after missing credentials.`);
      return;
    }
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const retry = this.scheduledMessageRetries.get(msg.id);
      if (!retry) return;
      this.scheduledMessageRetries.set(msg.id, { ...retry, timer: null });
      void this.handleNewMessage(retry.msg);
    }, 1_000);
    (timer as { unref?: () => void }).unref?.();
    this.scheduledMessageRetries.set(msg.id, { msg, attempts, timer });
  }

  private async handleNewMessage(msg: DbMessage) {
    if (this.processedMessageIds.has(msg.id)) return;
    if (this.processingMessageIds.has(msg.id)) {
      this.pendingMessageRetries.set(msg.id, msg);
      return;
    }
    this.processingMessageIds.add(msg.id);

    try {
      if (msg.sender_type === "system") {
        this.processedMessageIds.add(msg.id);
        return;
      }

      let agentIdsInChannel = await this.refreshChannelAgents(msg.channel_id);
      if (this.channelsWithMissingAgentCredentials.has(msg.channel_id)) {
        agentIdsInChannel = await this.refreshChannelAgents(msg.channel_id);
        if (this.channelsWithMissingAgentCredentials.has(msg.channel_id)) {
          this.scheduleMessageRetry(msg);
          return;
        }
      }
      if (agentIdsInChannel.size === 0) return;

      const plan = await this.buildRoutingPlan(msg, agentIdsInChannel);
      if (!plan) {
        this.processedMessageIds.add(msg.id);
        this.deliveredMessageAgentIds.delete(msg.id);
        this.clearScheduledMessageRetry(msg.id);
        return;
      }

      const deliveredAgentIds = this.deliveredMessageAgentIds.get(msg.id) ?? new Set<string>();
      const pendingDeliveries = plan.deliveries.filter((delivery) => !deliveredAgentIds.has(delivery.candidate.agentId));
      if (pendingDeliveries.length === 0) {
        this.processedMessageIds.add(msg.id);
        this.deliveredMessageAgentIds.delete(msg.id);
        this.clearScheduledMessageRetry(msg.id);
        return;
      }

      const execution = await this.executeRoutingPlan({ ...plan, deliveries: pendingDeliveries });
      this.markMessageDeliveries(msg.id, execution.deliveredAgentIds);
      if (execution.failedAgentIds.length === 0) {
        this.processedMessageIds.add(msg.id);
        this.deliveredMessageAgentIds.delete(msg.id);
        this.clearScheduledMessageRetry(msg.id);
      } else {
        this.clearActivationCooldownsForMessage(msg.id);
      }
    } catch (error) {
      this.clearActivationCooldownsForMessage(msg.id);
      console.error("  [A2A] Failed to handle message:", serializeRuntimeError(error));
    } finally {
      this.processingMessageIds.delete(msg.id);
      const retryMsg = this.pendingMessageRetries.get(msg.id);
      this.pendingMessageRetries.delete(msg.id);
      if (!this.processedMessageIds.has(msg.id) && retryMsg) {
        await this.handleNewMessage(retryMsg);
      }
    }
  }

  private async buildRoutingPlan(msg: DbMessage, agentIdsInChannel: Set<string>): Promise<RoutingPlan | null> {
    const channelType = this.channelTypes.get(msg.channel_id) as "dm" | "public" | "private" | undefined;
    const isDm = channelType === "dm";
    const dmTargetAgentId = isDm ? this.dmTargetAgentId(msg.channel_id) : null;
    const routingAgentIds = dmTargetAgentId
      ? new Set(agentIdsInChannel.has(dmTargetAgentId) ? [dmTargetAgentId] : [])
      : agentIdsInChannel;
    const task = await this.findRoutingTaskForMessage(msg);
    const space = classifyConversationSpace({ channelType: channelType || "private", threadParentId: msg.thread_parent_id, task });
    const protocolMessage: ProtocolMessage = {
      id: msg.id,
      channelId: msg.channel_id,
      senderId: msg.sender_id,
      senderType: msg.sender_type,
      content: msg.content,
      threadParentId: msg.thread_parent_id,
      createdAt: msg.created_at,
    };
    const intents = classifyMessageIntent(msg.content);
    const topicKey = deriveTopicKey(protocolMessage, task);
    const [recentMessages, threadParticipantAgentIds] = await Promise.all([
      this.getRecentProtocolMessages(msg.channel_id, msg.thread_parent_id),
      this.getThreadParticipantAgentIds(msg.thread_parent_id, routingAgentIds),
    ]);
    const selection = selectActivationCandidates({
      message: protocolMessage,
      agents: this.toProtocolAgents(routingAgentIds),
      space,
      intents,
      topicKey,
      recentMessages,
      task,
      threadParticipantAgentIds,
    });

    const now = Date.now();
    const activated: ActivationCandidate[] = [];
    const cooldownSuppressed: RoutingSuppressedCandidate[] = [];
    for (const candidate of selection.activated) {
      const bypass = candidate.reasons.includes("direct_mention") || candidate.reasons.includes("dm_recipient") || msg.sender_type === "human";
      const reason = candidate.reasons[0] || "conversation_continuation";
      const key = buildCooldownKey({
        topicKey,
        channelId: msg.channel_id,
        sourceAgentId: msg.sender_id,
        targetAgentId: candidate.agentId,
        reason,
      });
      const cooldown = shouldSuppressForCooldown({
        key,
        entries: this.activationCooldowns,
        now,
        cooldownMs: 10 * 60 * 1000,
        bypass,
      });
      if (cooldown.suppress) {
        cooldownSuppressed.push({ agentId: candidate.agentId, reason: cooldown.reason || "cooldown", reasons: candidate.reasons });
        continue;
      }
      this.activationCooldowns.set(key, { lastActivatedAt: now, sourceMessageId: msg.id });
      activated.push(candidate);
    }

    const suppressed = [...selection.suppressed, ...cooldownSuppressed];
    this.formatRoutingLog({ messageId: msg.id, topicKey, activated, suppressed });

    if (activated.length === 0) {
      return {
        msg,
        topicKey,
        activated,
        suppressed,
        deliveries: [],
        target: this.buildChannelTarget(msg.channel_id, undefined, msg.thread_parent_id),
        taskId: task?.id ?? null,
      };
    }

    const senderName = await this.resolveSenderName(msg.sender_id, msg.sender_type);
    const channelTarget = this.buildChannelTarget(msg.channel_id, senderName, msg.thread_parent_id);
    const contextPrefix = isDm ? "" : await this.getChannelContext(msg.channel_id);
    const previousHop = this.topicHopCounts.get(topicKey) || 0;
    const hopCount = msg.sender_type === "agent" ? previousHop + 1 : 0;
    this.topicHopCounts.set(topicKey, hopCount);

    const baseDeliveries = activated
      .map((candidate) => {
        const agent = this.agentRecords.get(candidate.agentId);
        if (!agent) return null;
        return { candidate, agent };
      })
      .filter((delivery): delivery is { candidate: ActivationCandidate; agent: DbAgent } => delivery !== null);
    const threadFacts = await this.getThreadJoinFacts(msg);
    const plannedDeliveries = planA2ADeliveries({
      message: {
        ...protocolMessage,
        text: msg.content,
        threadId: msg.thread_parent_id ?? undefined,
      },
      deliveries: baseDeliveries,
      thread: threadFacts,
      suggestedReadTarget: channelTarget,
      threadTarget: channelTarget,
    }).deliveries;

    const deliveries: RoutingDelivery[] = [];
    for (const delivery of plannedDeliveries) {
      const envelope = buildActivationEnvelope({
        targetAgentName: delivery.agent.display_name,
        space,
        intents,
        reasons: delivery.candidate.reasons,
        strength: delivery.candidate.strength,
        sourceMessageId: msg.id,
        topicKey,
        hopCount,
        loopConstraints: ["response-value-required", "no-idle-narration", "respect-ownership"],
      });
      const msgHeader = `[target=${channelTarget} msg=${this.shortId(msg.id)} time=${msg.created_at} sender=@${senderName} type=${msg.sender_type}]`;
      const promptSections = [envelope];
      if (contextPrefix) promptSections.push(contextPrefix);
      if (delivery.threadContext) promptSections.push(this.formatThreadJoinContext(delivery.threadContext));
      const prompt = `${promptSections.join("\n\n")}\n\n${msgHeader} ${msg.content}`;

      deliveries.push({ ...delivery, prompt });
    }

    return { msg, topicKey, activated, suppressed, deliveries, target: channelTarget, taskId: task?.id ?? null };
  }

  private prepareRuntimeSupervisorForDelivery(agentId: string): void {
    if (!this.runtimeSupervisor) return;

    const managerState = this.agentManager.getRuntimeAgentState(agentId);
    if (managerState.state === "stopped" || (managerState.sessionId === null && managerState.processId === null)) {
      this.runtimeSupervisor.markStarting(agentId);
      return;
    }

    this.syncRuntimeSupervisor(agentId);
  }

  private async pumpRuntimeStarts(): Promise<void> {
    if (!this.deliveryRuntime) return;

    const starter = async (entry: { agentId: string }) => {
      await this.agentManager.ensureRuntimeProcess(entry.agentId);
      this.syncRuntimeSupervisor(entry.agentId);
      await this.deliveryRuntime?.flushQueuedDeliveries(entry.agentId, "idle");
    };

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const queued = this.deliveryRuntime.startQueueSnapshot().filter((entry) => entry.state === "queued");
      if (queued.length === 0) return;

      await Promise.all(queued.map(() => this.deliveryRuntime!.pumpStarts(starter)));

      const remainingQueued = this.deliveryRuntime.startQueueSnapshot().filter((entry) => entry.state === "queued");
      if (remainingQueued.length >= queued.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private startReminderScheduler(): void {
    if (this.reminderInterval) clearInterval(this.reminderInterval);
    this.reminderInterval = setInterval(() => {
      void this.processDueReminders();
    }, 15_000);
    void this.processDueReminders();
  }

  private reminderDueTime(reminder: DbReminder): string {
    return reminder.state === "snoozed" && reminder.snoozed_until ? reminder.snoozed_until : reminder.due_at;
  }

  private isReminderDue(reminder: DbReminder): boolean {
    return Date.parse(this.reminderDueTime(reminder)) <= Date.now();
  }

  private async processDueReminders(): Promise<void> {
    const { data, error } = await this.supabase
      .from("reminders")
      .select("id, server_id, created_by_id, created_by_type, recipient_id, recipient_type, channel_id, source_message_id, thread_parent_id, task_id, target, body, due_at, snoozed_until, state, fired_at, fired_delivery_id, last_error")
      .eq("server_id", this.config.serverId)
      .eq("recipient_type", "agent")
      .in("state", ["pending", "snoozed"])
      .order("due_at", { ascending: true })
      .limit(50);

    if (error) {
      console.warn("  [Reminder] Failed to load due reminders:", serializeRuntimeError(error));
      return;
    }

    const dueReminders = ((data ?? []) as DbReminder[])
      .filter((reminder) => this.agentRecords.has(reminder.recipient_id))
      .filter((reminder) => this.isReminderDue(reminder));

    for (const reminder of dueReminders) {
      const claimed = await this.claimReminder(reminder);
      if (!claimed) continue;

      try {
        await this.fireReminder(claimed);
      } catch (error) {
        await this.markReminderFailed(claimed.id, error);
      }
    }
  }

  private async claimReminder(reminder: DbReminder): Promise<DbReminder | null> {
    const { data, error } = await this.supabase
      .from("reminders")
      .update({ state: "firing", updated_at: new Date().toISOString(), last_error: null })
      .eq("id", reminder.id)
      .eq("state", reminder.state)
      .select("id, server_id, created_by_id, created_by_type, recipient_id, recipient_type, channel_id, source_message_id, thread_parent_id, task_id, target, body, due_at, snoozed_until, state, fired_at, fired_delivery_id, last_error")
      .maybeSingle();

    if (error) {
      console.warn("  [Reminder] Failed to claim reminder:", serializeRuntimeError(error));
      return null;
    }

    return data as DbReminder | null;
  }

  private async fireReminder(reminder: DbReminder): Promise<void> {
    const agent = this.agentRecords.get(reminder.recipient_id);
    if (!agent) return;

    const content = `[Reminder for ${agent.display_name}] ${reminder.body}`;
    const { data: message, error: messageError } = await this.supabase
      .from("messages")
      .insert({
        channel_id: reminder.channel_id,
        sender_id: this.config.userId,
        sender_type: "system",
        content,
        thread_parent_id: reminder.thread_parent_id,
      })
      .select("id, channel_id, sender_id, sender_type, content, thread_parent_id, created_at")
      .single();

    if (messageError || !message) {
      throw new Error(messageError?.message ?? "Failed to create reminder wake message");
    }

    const msg = message as DbMessage;
    const prompt = this.buildReminderPrompt(reminder, msg, agent);
    let firedDeliveryId: string | null = null;

    if (this.deliveryRuntime) {
      this.prepareRuntimeSupervisorForDelivery(reminder.recipient_id);
      const record = await this.deliveryRuntime.accept({
        workspaceId: this.config.serverId,
        agentId: reminder.recipient_id,
        channelId: reminder.channel_id,
        sourceMessageId: msg.id,
        threadParentId: reminder.thread_parent_id,
        taskId: reminder.task_id,
        target: reminder.target,
        activationReasons: ["system_assignment"],
        activationStrength: "strong",
        prompt,
        sourceCreatedAt: msg.created_at,
        senderId: msg.sender_id,
        senderType: "system",
      });
      firedDeliveryId = record.id;
      if (!record.acceptedAt) {
        throw new Error(`delivery_not_accepted:${record.runtimeOutcome ?? record.state}`);
      }
      try {
        await this.emitDeliveryAck(record);
      } catch (error) {
        console.warn(`  [${agent.display_name}] Reminder delivery ack failed:`, serializeRuntimeError(error));
      }
      if (record.state === "queued_starting") {
        try {
          await this.pumpRuntimeStarts();
        } catch (error) {
          console.warn(`  [${agent.display_name}] Reminder runtime start pump failed:`, serializeRuntimeError(error));
        }
      }
    } else {
      this.agentManager.setNextActivityScope?.(reminder.recipient_id, {
        channelId: reminder.channel_id,
        sourceMessageId: msg.id,
        threadParentId: reminder.thread_parent_id,
        taskId: reminder.task_id,
      });
      await this.agentManager.sendToAgent(reminder.recipient_id, prompt);
    }

    const { error } = await this.supabase
      .from("reminders")
      .update({
        state: "fired",
        fired_at: new Date().toISOString(),
        fired_delivery_id: firedDeliveryId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reminder.id);

    if (error) {
      console.warn("  [Reminder] Failed to mark reminder fired:", serializeRuntimeError(error));
    }
  }

  private buildReminderPrompt(reminder: DbReminder, msg: DbMessage, agent: DbAgent): string {
    const taskLine = reminder.task_id ? "Linked task: update the task thread/status if this follow-up changes the work state." : "No linked task.";
    return [
      "A scheduled Zano reminder you created is due.",
      "Treat this as a wake-up signal, not as completed work.",
      "Do not echo the reminder marker or explain reminder mechanics; act on the reminder body.",
      taskLine,
      `Reminder id: ${this.shortId(reminder.id)}`,
      `Reminder target: ${reminder.target}`,
      `Reminder due: ${this.reminderDueTime(reminder)}`,
      `Recipient: ${agent.display_name}`,
      "If the follow-up is still needed, act now and report only a result, blocker, decision request, or handoff.",
      `If the follow-up is no longer needed, run \`zano reminder done --id ${this.shortId(reminder.id)}\` or \`zano reminder cancel --id ${this.shortId(reminder.id)}\`.`,
      `[target=${reminder.target} msg=${this.shortId(msg.id)} time=${msg.created_at} sender=@Zano type=system] ${reminder.body}`,
    ].join("\n");
  }

  private async markReminderFailed(reminderId: string, error: unknown): Promise<void> {
    await this.supabase
      .from("reminders")
      .update({
        state: "failed",
        last_error: redactRuntimeText(serializeRuntimeError(error)).slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", reminderId);
  }

  private syncRuntimeSupervisor(agentId: string): void {
    if (!this.runtimeSupervisor) return;

    const managerState = this.agentManager.getRuntimeAgentState(agentId);
    const managerStateName = String(managerState.state);
    const stoppedStates = new Set(["stopped", "dead", "killed", "exited"]);
    const hasLiveIdentity = managerState.sessionId !== null || managerState.processId !== null;

    if (stoppedStates.has(managerStateName) || !hasLiveIdentity) {
      this.runtimeSupervisor.markStale(agentId);
      return;
    }

    if (managerStateName === "starting") {
      this.runtimeSupervisor.markStarting(agentId);
      return;
    }

    this.runtimeSupervisor.registerReady({
      agentId,
      sessionId: managerState.sessionId,
      processId: managerState.processId,
    });

    if (managerStateName === "busy" || managerState.busy) {
      this.runtimeSupervisor.markBusy(agentId);
      return;
    }

    if (managerStateName === "gated") {
      this.runtimeSupervisor.markGated(agentId);
      return;
    }

    if (managerStateName === "idle") {
      this.runtimeSupervisor.markIdle(agentId);
    }
  }

  private async emitDeliveryAck(record: RuntimeDeliveryRecord): Promise<void> {
    await this.supabase.channel(`agent-deliveries:${this.config.serverId}`).send({
      type: "broadcast",
      event: "agent:deliver:ack",
      payload: {
        agentId: record.agentId,
        seq: record.deliverySeq,
        deliverySeq: record.deliverySeq,
        traceparent: record.ackTraceparent ?? record.traceparent,
        deliveryId: record.id,
      },
    });
  }

  private async executeRoutingPlan(plan: RoutingPlan): Promise<RoutingExecutionResult> {
    const results = await Promise.allSettled(
      plan.deliveries.map(async (delivery) => {
        const safeContentPreview = redactRuntimeText(plan.msg.content);
        console.log(
          `  [${delivery.agent.display_name}] A2A activated (${delivery.candidate.strength}:${delivery.candidate.reasons.join("+")}): "${safeContentPreview.substring(0, 60)}${safeContentPreview.length > 60 ? "..." : ""}"`
        );
        if (this.deliveryRuntime) {
          this.prepareRuntimeSupervisorForDelivery(delivery.candidate.agentId);
          const record = await this.deliveryRuntime.accept(buildRuntimeDeliveryInput({
            workspaceId: this.config.serverId,
            msg: plan.msg,
            delivery,
            target: plan.target,
            taskId: plan.taskId,
          }));
          if (!record.acceptedAt) {
            throw new Error(`delivery_not_accepted:${record.runtimeOutcome ?? record.state}`);
          }
          try {
            await this.emitDeliveryAck(record);
          } catch (error) {
            console.warn(`  [${delivery.agent.display_name}] Delivery ack failed:`, serializeRuntimeError(error));
          }
          if (record.state === "queued_starting") {
            try {
              await this.pumpRuntimeStarts();
            } catch (error) {
              console.warn(`  [${delivery.agent.display_name}] Runtime start pump failed:`, serializeRuntimeError(error));
            }
          }
          return delivery.candidate.agentId;
        }

        this.agentManager.setNextActivityScope?.(delivery.candidate.agentId, {
          channelId: plan.msg.channel_id,
          sourceMessageId: plan.msg.id,
          threadParentId: plan.msg.thread_parent_id,
          taskId: plan.taskId,
        });
        await this.agentManager.sendToAgent(delivery.candidate.agentId, delivery.prompt);
        return delivery.candidate.agentId;
      }),
    );

    const deliveredAgentIds: string[] = [];
    const failedAgentIds: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        deliveredAgentIds.push(result.value);
        continue;
      }
      const delivery = plan.deliveries[index];
      failedAgentIds.push(delivery.candidate.agentId);
      console.error(
        `  [${delivery.agent.display_name}] Error:`,
        serializeRuntimeError(result.reason)
      );
    }

    return { deliveredAgentIds, failedAgentIds };
  }

  private subscribeToNewAgents() {
    // Watch for new agents belonging to this user
    this.supabase
      .channel("omni-new-agents")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agents",
          filter: `owner_id=eq.${this.config.userId}`,
        },
        async (payload) => {
          const agent = payload.new as DbAgent;
          if (agent.archived_at) return;
          if (agent.server_id && agent.server_id !== this.config.serverId) return;
          if (this.agentRecords.has(agent.id)) return;

          console.log(
            `  [Omni] New agent detected: ${agent.display_name}`
          );
          if (!(await this.initializeNewAgentRecord(agent))) return;

          // Mark as active (best-effort DB backup)
          await this.supabase
            .from("agents")
            .update({ status: "online" })
            .eq("id", agent.id);

          // Update presence with new agent list
          this.updatePresence();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "agents",
          filter: `owner_id=eq.${this.config.userId}`,
        },
        (payload) => {
          const agent = payload.new as DbAgent;
          if (agent.archived_at) this.pruneArchivedAgent(agent.id);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "channel_members",
        },
        async (payload) => {
          const member = payload.new as DbChannelMember;
          // Only track agent memberships for our agents
          if (
            member.member_type !== "agent" ||
            !this.agentRecords.has(member.member_id)
          )
            return;

          console.log(
            `  [Omni] Agent ${this.agentRecords.get(member.member_id)?.display_name} joined channel ${member.channel_id}`
          );
          if (!this.channelAgents.has(member.channel_id)) {
            this.channelAgents.set(member.channel_id, new Set());
          }
          this.channelAgents.get(member.channel_id)!.add(member.member_id);

          // Load channel type and name if not known
          if (!this.channelTypes.has(member.channel_id)) {
            const { data: ch } = await this.supabase
              .from("channels")
              .select("name, type")
              .eq("id", member.channel_id)
              .single();
            if (ch) {
              this.channelTypes.set(member.channel_id, ch.type);
              this.channelNames.set(member.channel_id, ch.name);
            }
          }
        }
      )
      .subscribe();
  }

  private subscribeToSpawnRequests() {
    if (!this.autonomousSpawnEnabled) return;
    if (this.spawnGovernorChannel) {
      this.supabase.removeChannel(this.spawnGovernorChannel);
      this.spawnGovernorChannel = null;
    }

    this.spawnGovernorChannel = this.supabase
      .channel("omni-agent-spawn-governor")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agent_spawn_events",
          filter: `server_id=eq.${this.config.serverId}`,
        },
        (payload) => {
          const event = payload.new as DbAgentSpawnEvent;
          if (event.event_type !== "spawn_requested") return;
          void this.fulfillSpawnRequest(event);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  [Omni] Autonomous spawn governor subscribed.");
        }
      });
  }

  private renderSpawnDisplayName(blueprint: DbAgentBlueprint, request: DbAgentSpawnEvent): string {
    const reason = request.reason.replace(/\s+/g, " ").slice(0, 48);
    const requestShortId = request.id.replace(/-/g, "").slice(0, 8);
    const rendered = blueprint.display_name_template
      .replace(/\{\{\s*reason\s*\}\}/g, reason)
      .replace(/\{\{\s*slug\s*\}\}/g, blueprint.slug)
      .replace(/\{\{\s*request_short_id\s*\}\}/g, requestShortId)
      .replace(/\{\{[^}]+\}\}/g, "")
      .trim();

    return rendered || blueprint.slug;
  }

  private buildAgentName(displayName: string): string {
    const handle = displayName
      .trim()
      .replace(/\s+/gu, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "");
    return handle || "Agent";
  }

  private async recordSpawnOutcome(
    request: DbAgentSpawnEvent,
    eventType: string,
    agentId: string | null,
    reason: string
  ) {
    const { error } = await this.supabase.from("agent_spawn_events").insert({
      server_id: request.server_id,
      blueprint_id: request.blueprint_id,
      agent_id: agentId,
      request_event_id: request.id,
      event_type: eventType,
      actor_id: request.actor_id,
      actor_type: request.actor_type,
      reason,
      source_refs: [
        ...request.source_refs,
        { type: "agent_spawn_request", id: request.id },
      ],
      policy_result: {},
    });

    if (error && !/duplicate/i.test(error.message)) {
      console.warn("  [Omni] Failed to record spawn outcome:", serializeRuntimeError(error));
    }
  }

  private async fulfillSpawnRequest(request: DbAgentSpawnEvent) {
    if (request.server_id !== this.config.serverId) return;

    const { data: existingOutcome } = await this.supabase
      .from("agent_spawn_events")
      .select("id")
      .eq("request_event_id", request.id)
      .eq("event_type", "spawn_created")
      .maybeSingle();
    if (existingOutcome) return;

    if (!request.blueprint_id) {
      await this.recordSpawnOutcome(request, "spawn_deferred", null, "Spawn request has no blueprint_id");
      return;
    }

    try {
      const { data: blueprint, error: blueprintError } = await this.supabase
        .from("agent_blueprints")
        .select("*")
        .eq("id", request.blueprint_id)
        .eq("server_id", request.server_id)
        .single();

      if (blueprintError || !blueprint) {
        throw new Error(blueprintError?.message ?? "Blueprint not found");
      }

      const typedBlueprint = blueprint as DbAgentBlueprint;
      if (!["active", "probation"].includes(typedBlueprint.state)) {
        await this.recordSpawnOutcome(
          request,
          "spawn_deferred",
          null,
          `Blueprint is not spawnable: ${typedBlueprint.state}`
        );
        return;
      }

      const displayName = this.renderSpawnDisplayName(typedBlueprint, request);
      const name = this.buildAgentName(displayName);

      const { data: agent, error: agentError } = await this.supabase
        .from("agents")
        .insert({
          name,
          display_name: displayName,
          description: typedBlueprint.description,
          system_prompt: typedBlueprint.system_prompt_template,
          status: "offline",
          owner_id: this.config.userId,
          server_id: request.server_id,
        })
        .select("*")
        .single();

      if (agentError || !agent) {
        throw new Error(agentError?.message ?? "Failed to create agent");
      }

      const createdAgent = agent as DbAgent;
      const { data: dmChannel, error: channelError } = await this.supabase
        .from("channels")
        .insert({
          name: displayName,
          description: `Direct chat with ${displayName}`,
          type: "dm",
          server_id: request.server_id,
          created_by: this.config.userId,
        })
        .select("*")
        .single();

      if (channelError || !dmChannel) {
        await this.supabase.from("agents").delete().eq("id", createdAgent.id);
        throw new Error(channelError?.message ?? "Failed to create DM channel");
      }

      const { error: channelMemberError } = await this.supabase.from("channel_members").insert([
        { channel_id: dmChannel.id, member_id: this.config.userId, member_type: "human" },
        { channel_id: dmChannel.id, member_id: createdAgent.id, member_type: "agent" },
      ]);

      if (channelMemberError) {
        await this.supabase.from("channels").delete().eq("id", dmChannel.id);
        await this.supabase.from("agents").delete().eq("id", createdAgent.id);
        throw new Error(channelMemberError.message);
      }

      const { error: serverMemberError } = await this.supabase.from("server_members").insert({
        server_id: request.server_id,
        member_id: createdAgent.id,
        member_type: "agent",
        role: "member",
      });

      if (serverMemberError) {
        await this.supabase.from("channels").delete().eq("id", dmChannel.id);
        await this.supabase.from("agents").delete().eq("id", createdAgent.id);
        throw new Error(serverMemberError.message);
      }

      await this.recordSpawnOutcome(
        request,
        "spawn_created",
        createdAgent.id,
        `Created agent ${displayName} from blueprint ${typedBlueprint.slug}`
      );
      console.log(`  [Omni] Autonomous spawn created agent: ${displayName}`);
    } catch (error) {
      const message = serializeRuntimeError(error);
      console.warn("  [Omni] Autonomous spawn failed:", message);
      await this.recordSpawnOutcome(request, "spawn_failed", null, message);
    }
  }

  /**
   * Track Omni presence. Supabase automatically removes presence
   * when the WebSocket disconnects (crash, network loss, terminal close).
   */
  private trackPresence() {
    const channelName = `omni-presence:${this.config.serverId}`;
    this.presenceChannel = this.supabase
      .channel(channelName)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await this.updatePresence();
          console.log("  Omni presence tracked.");
        }
      });
  }

  /** Periodically update machine_keys.last_used_at as a heartbeat for polling-based status. */
  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    const sendHeartbeat = async () => {
      try {
        await this.supabase
          .from("machine_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("user_id", this.config.userId)
          .eq("server_id", this.config.serverId);
      } catch {
        // Ignore heartbeat errors
      }
    };

    // Send immediately, then every 30 seconds
    sendHeartbeat();
    this.heartbeatInterval = setInterval(sendHeartbeat, 30_000);
  }

  /** Update the presence payload (e.g. when new agents are added). */
  private async updatePresence() {
    if (!this.presenceChannel) return;
    await this.presenceChannel.track({
      hostname: this.config.hostname || "unknown",
      platform: this.config.platform || "",
      arch: this.config.arch || "",
      agentIds: Array.from(this.agentRecords.keys()),
    });
  }

  /**
   * Subscribe to workspace file RPC requests from the web UI.
   * The web UI sends broadcast events; Omni reads local files and responds.
   */
  private subscribeToWorkspaceRpc() {
    this.workspaceRpcChannel = this.supabase
      .channel("omni-rpc")
      .on(
        "broadcast",
        { event: "rpc:request" },
        async ({ payload }) => {
          const { requestId, agentId, action, filePath } = payload;
          if (!requestId) return;

          try {
            let responsePayload: Record<string, unknown>;

            if (action === "skills:list") {
              // Skills are machine-wide, no agentId needed
              responsePayload = await this.listSkills();
            } else if (agentId && this.agentRecords.has(agentId)) {
              const workDir = this.agentManager.getWorkspaceDir(agentId);
              if (action === "list") {
                responsePayload = await this.listWorkspaceFiles(workDir);
              } else if (action === "read" && filePath) {
                responsePayload = await this.readWorkspaceFile(
                  workDir,
                  filePath
                );
              } else {
                responsePayload = { error: "Unknown action" };
              }
            } else {
              responsePayload = { error: "Unknown action or agent" };
            }

            this.workspaceRpcChannel!.send({
              type: "broadcast",
              event: "rpc:response",
              payload: { requestId, ...responsePayload },
            });
          } catch (err) {
            this.workspaceRpcChannel!.send({
              type: "broadcast",
              event: "rpc:response",
              payload: {
                requestId,
                error: serializeRuntimeError(err),
              },
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Omni RPC channel ready.");
        }
      });
  }

  private async listWorkspaceFiles(workDir: string) {
    const files: Array<{
      name: string;
      type: "file" | "directory";
      size: number;
      modified: string;
    }> = [];

    let entries: string[];
    try {
      entries = await readdir(workDir);
    } catch {
      return { workspace_path: workDir, files, notes_files: [] };
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const entryPath = join(workDir, entry);
      const entryStat = await stat(entryPath);
      files.push({
        name: entry,
        type: entryStat.isDirectory() ? "directory" : "file",
        size: entryStat.size,
        modified: entryStat.mtime.toISOString(),
      });
    }

    // Also list files inside notes/
    const notesDir = join(workDir, "notes");
    const notesFiles: typeof files = [];
    try {
      const notesEntries = await readdir(notesDir);
      for (const entry of notesEntries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(notesDir, entry);
        const entryStat = await stat(entryPath);
        notesFiles.push({
          name: `notes/${entry}`,
          type: entryStat.isDirectory() ? "directory" : "file",
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        });
      }
    } catch {
      // notes/ may not exist yet
    }

    return { workspace_path: workDir, files, notes_files: notesFiles };
  }

  private async readWorkspaceFile(workDir: string, filePath: string) {
    const root = resolve(workDir);
    const resolvedPath = resolve(root, filePath);
    if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
      throw new Error("Invalid file path");
    }
    const content = await readFile(resolvedPath, "utf-8");
    return { file: filePath, content };
  }

  private async listSkills() {
    const skillsDir = join(homedir(), ".claude", "skills");
    const skills: Array<{ name: string; description: string }> = [];

    try {
      const entries = await readdir(skillsDir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(skillsDir, entry);
        const entryStat = await lstat(entryPath);
        const resolvedPath = entryStat.isSymbolicLink()
          ? resolve(skillsDir, entry)
          : entryPath;

        for (const filename of ["SKILL.md", "skill.md"]) {
          try {
            const content = await readFile(
              join(resolvedPath, filename),
              "utf-8"
            );
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let description = "";
            if (fmMatch) {
              const descMatch = fmMatch[1].match(
                /^description:\s*(.+)$/m
              );
              if (descMatch) {
                description = descMatch[1]
                  .trim()
                  .replace(/^['"]|['"]$/g, "");
              }
            }
            skills.push({ name: entry, description: description || entry });
            break;
          } catch {
            // File doesn't exist, try next
          }
        }
      }
    } catch {
      // Skills directory doesn't exist
    }

    return { skills };
  }

  async stop() {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.messageCatchupInterval) {
      clearInterval(this.messageCatchupInterval);
      this.messageCatchupInterval = null;
    }

    // Mark agents as offline
    const agentIds = Array.from(this.agentRecords.keys());
    if (agentIds.length > 0) {
      await this.supabase
        .from("agents")
        .update({ status: "offline" })
        .in("id", agentIds);
    }

    // Stop all agent sessions
    this.agentManager.stopAll();

    // Disconnect from Supabase (removes all channels including workspace RPC + presence)
    this.workspaceRpcChannel = null;
    this.presenceChannel = null;
    await this.supabase.removeAllChannels();

    console.log("  Omni stopped.");
  }
}
