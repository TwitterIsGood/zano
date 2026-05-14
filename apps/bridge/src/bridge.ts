import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { readdir, readFile, stat, lstat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { AgentManager } from "./agent-manager.js";
import {
  buildActivationEnvelope,
  buildCooldownKey,
  classifyConversationSpace,
  classifyMessageIntent,
  deriveTopicKey,
  selectActivationCandidates,
  shouldSuppressForCooldown,
  type ActivationCooldownEntry,
  type ActivationReason,
  type ProtocolAgent,
  type ProtocolMessage,
  type ProtocolRecentMessage,
  type ProtocolTaskRef,
} from "./a2a-protocol.js";

interface BridgeConfig {
  supabaseUrl: string;
  supabaseKey: string;    // anon key
  authToken: string;       // JWT for authenticated Supabase operations
  userId: string;
  serverId: string;
  agentsDir: string;
  hostname?: string;
  platform?: string;
  arch?: string;
}

interface DbMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  thread_parent_id: string | null;
  created_at: string;
}

interface DbAgent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string;
  status: string;
  server_id?: string;
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
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by_id: string | null;
}

export class Bridge {
  private supabase: SupabaseClient;
  private agentManager: AgentManager;
  private config: BridgeConfig;
  // Maps channel_id -> Set of agent_ids in that channel
  private channelAgents = new Map<string, Set<string>>();
  // Maps channel_id -> channel type ('dm' | 'public' | 'private')
  private channelTypes = new Map<string, string>();
  // Maps channel_id -> channel name
  private channelNames = new Map<string, string>();
  // Maps agent_id -> agent DB record
  private agentRecords = new Map<string, DbAgent>();
  // Realtime channel for workspace file RPC (web UI ↔ bridge)
  private workspaceRpcChannel: RealtimeChannel | null = null;
  // Presence channel for online status (auto-offline on disconnect)
  private presenceChannel: RealtimeChannel | null = null;
  // Heartbeat timer for machine_keys.last_used_at (polling fallback for online status)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private processedMessageIds = new Set<string>();
  private activationCooldowns = new Map<string, ActivationCooldownEntry>();
  private topicHopCounts = new Map<string, number>();

  constructor(config: BridgeConfig) {
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
      config.authToken
    );
  }

  /** Update the auth token (called on periodic refresh) */
  async updateAuthToken(token: string) {
    this.config.authToken = token;
    // Remove all channels before recreating client
    await this.supabase.removeAllChannels();
    this.workspaceRpcChannel = null;
    this.presenceChannel = null;
    // Recreate the Supabase client with the new token
    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    this.supabase.realtime.setAuth(token);
    // Update agent manager's client too
    this.agentManager.updateSupabaseClient(this.supabase, token);
    // Re-subscribe everything on new client
    this.subscribeToMessages();
    this.subscribeToNewAgents();
    this.subscribeToWorkspaceRpc();
    this.trackPresence();
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
    await this.processRecentHumanMessages();

    // 6. Subscribe to new agents and channel memberships (for agents created via UI)
    this.subscribeToNewAgents();

    // 7. Subscribe to workspace file RPC (web UI requests files via Realtime)
    this.subscribeToWorkspaceRpc();

    // 8. Track presence (auto-offline on disconnect — no SIGINT needed)
    this.trackPresence();

    // 9. Start heartbeat (updates machine_keys.last_used_at every 30s for polling-based status)
    this.startHeartbeat();

    console.log(
      `  Bridge ready. Listening for messages across ${this.channelAgents.size} channel(s).`
    );
    console.log(
      `  Managing ${this.agentRecords.size} agent(s): ${Array.from(this.agentRecords.values()).map((a) => a.display_name).join(", ")}`
    );
  }

  private async loadAgents() {
    const { data: agents, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("owner_id", this.config.userId);

    if (error) {
      console.error("  Failed to load agents:", error.message);
      return;
    }

    for (const agent of agents || []) {
      this.agentRecords.set(agent.id, agent as DbAgent);
    }

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
      console.error("  Failed to load memberships:", error.message);
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
    }
  }

  private subscribeToMessages() {
    const subscription = this.supabase
      .channel("bridge-messages")
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
      .select("id, task_number, message_id, source_message_id, assignee_id, reviewer_id, created_by_id")
      .or(messageIds.map((id) => `message_id.eq.${id},source_message_id.eq.${id}`).join(","))
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

  /**
   * Build a target string for the channel (e.g. "#general", "dm:@alice").
   */
  private buildChannelTarget(channelId: string, senderName?: string): string {
    const ch = this.channelTypes.get(channelId);
    if (ch === "dm" && senderName) {
      return `dm:@${senderName}`;
    }
    // For non-DM channels, find the channel name
    for (const [id, info] of this.channelNames) {
      if (id === channelId) return `#${info}`;
    }
    return channelId;
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
      console.error("  Failed to process recent messages:", error.message);
      return;
    }

    for (const msg of messages || []) {
      await this.handleNewMessage(msg as DbMessage);
    }
  }

  private async handleNewMessage(msg: DbMessage) {
    if (this.processedMessageIds.has(msg.id)) return;
    this.processedMessageIds.add(msg.id);

    if (msg.sender_type === "system") return;

    // Check if any of our agents are in this channel
    const agentIdsInChannel = this.channelAgents.get(msg.channel_id);
    if (!agentIdsInChannel || agentIdsInChannel.size === 0) return;

    const channelType = this.channelTypes.get(msg.channel_id) as "dm" | "public" | "private" | undefined;
    const isDm = channelType === "dm";
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
    const recentMessages = await this.getRecentProtocolMessages(msg.channel_id, msg.thread_parent_id);
    const selection = selectActivationCandidates({
      message: protocolMessage,
      agents: this.toProtocolAgents(agentIdsInChannel),
      space,
      intents,
      topicKey,
      recentMessages,
      task,
    });

    const now = Date.now();
    const activated: typeof selection.activated = [];
    const cooldownSuppressed: Array<{ agentId: string; reason: string; reasons: ActivationReason[] }> = [];
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

    this.formatRoutingLog({
      messageId: msg.id,
      topicKey,
      activated,
      suppressed: [...selection.suppressed, ...cooldownSuppressed],
    });

    if (activated.length === 0) return;

    const senderName = await this.resolveSenderName(msg.sender_id, msg.sender_type);
    const channelTarget = this.buildChannelTarget(msg.channel_id, senderName);
    let contextPrefix = "";
    if (!isDm) contextPrefix = await this.getChannelContext(msg.channel_id);
    const previousHop = this.topicHopCounts.get(topicKey) || 0;
    const hopCount = msg.sender_type === "agent" ? previousHop + 1 : 0;
    this.topicHopCounts.set(topicKey, hopCount);

    for (const candidate of activated) {
      const agent = this.agentRecords.get(candidate.agentId);
      if (!agent) continue;

      console.log(
        `  [${agent.display_name}] A2A activated (${candidate.strength}:${candidate.reasons.join("+")}): "${msg.content.substring(0, 60)}${msg.content.length > 60 ? "..." : ""}"`
      );

      try {
        const envelope = buildActivationEnvelope({
          targetAgentName: agent.display_name,
          space,
          intents,
          reasons: candidate.reasons,
          strength: candidate.strength,
          sourceMessageId: msg.id,
          topicKey,
          hopCount,
          loopConstraints: ["response-value-required", "no-idle-narration", "respect-ownership"],
        });
        const msgHeader = `[target=${channelTarget} sender=@${senderName} type=${msg.sender_type}]`;
        const prompt = contextPrefix
          ? `${envelope}\n\n${contextPrefix}\n\n${msgHeader} ${msg.content}`
          : `${envelope}\n\n${msgHeader} ${msg.content}`;

        await this.agentManager.sendToAgent(candidate.agentId, prompt);
      } catch (err) {
        console.error(
          `  [${agent.display_name}] Error:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  private subscribeToNewAgents() {
    // Watch for new agents belonging to this user
    this.supabase
      .channel("bridge-new-agents")
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
          if (this.agentRecords.has(agent.id)) return;

          console.log(
            `  [Bridge] New agent detected: ${agent.display_name}`
          );
          this.agentRecords.set(agent.id, agent);
          await this.agentManager.initAgent(agent.id, agent);

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
            `  [Bridge] Agent ${this.agentRecords.get(member.member_id)?.display_name} joined channel ${member.channel_id}`
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

  /**
   * Track this bridge's presence. Supabase automatically removes presence
   * when the WebSocket disconnects (crash, network loss, terminal close).
   */
  private trackPresence() {
    const channelName = `bridge-presence:${this.config.serverId}`;
    this.presenceChannel = this.supabase
      .channel(channelName)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await this.updatePresence();
          console.log("  Bridge presence tracked.");
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
   * The web UI sends broadcast events; the bridge reads local files and responds.
   */
  private subscribeToWorkspaceRpc() {
    this.workspaceRpcChannel = this.supabase
      .channel("bridge-rpc")
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
              if (!workDir) {
                responsePayload = { error: "Agent workspace not found" };
              } else if (action === "list") {
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
                error:
                  err instanceof Error ? err.message : "Unknown error",
              },
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("  Bridge RPC channel ready.");
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

    const entries = await readdir(workDir);
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
    // Security: prevent path traversal
    const resolvedPath = join(workDir, filePath);
    if (!resolvedPath.startsWith(workDir)) {
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

    console.log("  Bridge stopped.");
  }
}
