import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from "fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { spawn, ChildProcess } from "child_process";
import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { buildSystemPrompt } from "./system-prompt.js";
import { materializeAutonomousSkills } from "./autonomous-skills.js";
import { mapClaudeStreamJsonToGatedEvent } from "./runtime/claude-stream-events.js";
import { CliTransportMaterializer, type CliTransportCredentialProxyInput } from "./runtime/cli-transport.js";
import { decideGatedFlush } from "./runtime/gated-steering.js";
import { PromptMaterializer } from "./runtime/prompt-materializer.js";
import { redactRuntimeText, serializeRuntimeError } from "./runtime/redaction.js";
import { observeRuntimeProfileMigrationDone, type RuntimeProfileControl, type RuntimeProfileControlAck } from "./runtime/runtime-profile-controls.js";
import { resolveRuntimeSessionRef } from "./runtime/runtime-session-ref.js";
import type { RuntimeSessionLedger } from "./runtime/session-ledger.js";
import type { ClaudeGatedSteeringEvent, GatedSteeringState, RuntimeSessionState } from "./runtime/types.js";

type AgentActivity = "idle" | "thinking" | "working" | "working_silently" | "observing" | "blocked" | "error";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACTIVITY_HEARTBEAT_MS = 60_000; // Re-broadcast active state every 60s
const RUNTIME_BACKLOG_ACTIVITY_LABEL = "Waiting for safe runtime boundary";
const DEFAULT_RUNTIME_CONTROL_MCP_URL = "http://127.0.0.1:8732/runtime-control/mcp";
const RUNTIME_CREDENTIAL_ENV_KEYS = [
  "ZANO_API_KEY",
  "ZANO_AUTH_TOKEN",
  "ZANO_AGENT_AUTH_TOKEN",
  "ZANO_AGENT_TOKEN",
  "ZANO_PROXY_TOKEN",
  "ZANO_AGENT_PROXY_TOKEN",
  "ZANO_MCP_TOKEN",
  "ZANO_MACHINE_LOCK_TOKEN",
  "ZANO_SUPABASE_KEY",
  "ZANO_SUPABASE_KEY_FILE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "ZANO_HOME",
  "ZANO_AGENT_ID",
  "ZANO_AGENT_LAUNCH_ID",
  "ZANO_SERVER_URL",
  "ZANO_AGENT_LOCAL_STATE",
  "ZANO_AGENT_TOKEN_FILE",
  "ZANO_AGENT_PROXY_URL",
  "ZANO_AGENT_PROXY_TOKEN_FILE",
  "ZANO_AGENT_ACTIVE_CAPABILITIES",
] as const;

function childProcessBaseEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of RUNTIME_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

interface AgentRecord {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string;
  status: string;
  server_id?: string;
}

interface AgentSession {
  id: string;
  name: string;
  displayName: string;
  workDir: string;
  serverId?: string;
}

export interface ActivityScope {
  channelId?: string | null;
  sourceMessageId?: string | null;
  threadParentId?: string | null;
  taskId?: string | null;
}

export interface AgentManagerCredentialProxyOptions {
  proxyUrl: string;
  proxyTokens: Record<string, string>;
  activeCapabilities: readonly string[];
}

export interface AgentManagerRuntimeOptions {
  workspaceId: string;
  workspaceName: string;
  machineId: string;
  hostname: string;
  platform: string;
  arch: string;
  omniVersion: string;
  runtimeControlMcpUrl?: string;
  credentialProxy?: AgentManagerCredentialProxyOptions;
}

interface PreparedCliTransport {
  pathDir: string;
  wrapperHash: string | null;
  tokenFilePath: string | null;
  proxyTokenFilePath: string | null;
  supabaseKeyFilePath: string | null;
  proxyUrl: string | null;
  activeCapabilities: readonly string[] | null;
  launchId: string;
}

interface RuntimePromptSnapshot {
  content: string;
  mcpConfigPath: string;
  promptHash: string;
}

export interface RuntimeBoundaryObserver {
  recordGatedEvent(agentId: string, event: ClaudeGatedSteeringEvent): void;
  getGatedState(agentId: string): GatedSteeringState;
  getPendingMessageCount(agentId: string): number;
  markPendingNotification?(agentId: string, count: number): void;
  sendPendingNotification(agentId: string, count: number): Promise<void> | void;
  flushDaemonInbox(agentId: string, reason: "idle" | "turn_end"): Promise<void> | void;
}

interface QueuedMessage {
  userMessage: string;
  scope: ActivityScope;
  resolve: () => void;
  reject: (err: Error) => void;
}

type RuntimeSessionTerminalState = "failed" | "ended";

export class RuntimeSessionUpdateQueue {
  private chain: Promise<void> = Promise.resolve();
  private terminalState: RuntimeSessionTerminalState | null = null;
  private terminalQueuedAt: number | null = null;
  private nextSequence = 0;

  enqueue(state: RuntimeSessionState, apply: () => Promise<void>): Promise<void> {
    const sequence = this.nextSequence++;
    const isTerminal = state === "failed" || state === "ended";

    if (this.terminalState && !isTerminal) {
      return this.chain;
    }

    if (state === "failed") {
      this.terminalState = "failed";
      this.terminalQueuedAt = this.terminalQueuedAt ?? sequence;
    } else if (state === "ended" && this.terminalState !== "failed") {
      this.terminalState = "ended";
      this.terminalQueuedAt = this.terminalQueuedAt ?? sequence;
    }

    this.chain = this.chain
      .then(async () => {
        if (this.terminalState === "failed" && state === "ended") return;
        if (this.terminalQueuedAt !== null && sequence > this.terminalQueuedAt && state !== this.terminalState) return;
        await apply();
      })
      .catch((error) => {
        console.warn("[AgentManager] Failed to update runtime session", serializeRuntimeError(error));
      });

    return this.chain;
  }
}

interface AgentProcess {
  proc: ChildProcess;
  sessionId: string | null;
  workDir: string;
  launchId: string;
  runtimeProfile: string | null;
  runtimeSessionId: string | null;
  runtimeSessionStart: Promise<string | null> | null;
  runtimeSessionUpdate: Promise<void>;
  runtimeSessionTerminalState: RuntimeSessionTerminalState | null;
  runtimeSessionUpdateQueue: RuntimeSessionUpdateQueue;
  turnId: string | null;
  busy: boolean;
  stdoutBuffer: string;
  stdoutLineQueue: Promise<void>;
  activity: AgentActivity;
  activityLabel: string;
  activityDetail: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  messageQueue: QueuedMessage[];
  currentDelivery: ActivityScope | null;
  /** Accumulated text content from assistant text events */
  pendingText: string;
  pendingRuntimeProfileControl: RuntimeProfileControl | null;
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private processes = new Map<string, AgentProcess>();
  private agentsDir: string;
  private supabase: SupabaseClient;
  private supabaseUrl: string;
  private supabaseKey: string;
  private authToken: string;
  private agentAuthTokens: Record<string, string>;
  private activityChannel: RealtimeChannel;
  private lastPersistedActivity = new Map<string, string>();
  private pendingActivityScopes = new Map<string, ActivityScope>();
  private autonomousSkillFingerprints = new Map<string, string>();
  private pendingAutonomousSkillRestarts = new Set<string>();
  private autonomousEvidenceEnabled = process.env.ZANO_ENABLE_AUTONOMOUS_EVIDENCE === "1";
  private autonomousSkillsEnabled = process.env.ZANO_ENABLE_AUTONOMOUS_SKILLS === "1";
  private runtimeOptions: AgentManagerRuntimeOptions | null = null;
  private runtimeSessionLedger: RuntimeSessionLedger | null = null;
  private runtimeBoundaryObserver: RuntimeBoundaryObserver | null = null;
  private runtimeProfileControlAcks: RuntimeProfileControlAck[] = [];
  private pendingRuntimeProfileControls = new Map<string, RuntimeProfileControl>();

  constructor(
    agentsDir: string,
    supabase: SupabaseClient,
    supabaseUrl: string,
    supabaseKey: string,
    authToken: string = "",
    agentAuthTokens: Record<string, string> = {}
  ) {
    this.agentsDir = agentsDir;
    this.supabase = supabase;
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.authToken = authToken;
    this.agentAuthTokens = agentAuthTokens;

    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }

    // Set up Realtime Broadcast channel for agent activity
    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  configureDaemonRuntime(options: AgentManagerRuntimeOptions, sessionLedger: RuntimeSessionLedger | null = null) {
    this.runtimeOptions = options;
    this.runtimeSessionLedger = sessionLedger;
  }

  configureRuntimeBoundaryObserver(observer: RuntimeBoundaryObserver | null) {
    this.runtimeBoundaryObserver = observer;
  }

  deliverRuntimeProfileControl(control: RuntimeProfileControl): void {
    if (control.type !== "agent:runtime_profile:migration") return;

    this.pendingRuntimeProfileControls.set(control.agentId, control);
    const agentProc = this.processes.get(control.agentId);
    if (agentProc) agentProc.pendingRuntimeProfileControl = control;
  }

  getRuntimeProfileControlAcks(): RuntimeProfileControlAck[] {
    return [...this.runtimeProfileControlAcks];
  }

  private broadcastRuntimeProfileControlAck(ack: RuntimeProfileControlAck): void {
    this.activityChannel.send({
      type: "broadcast",
      event: "runtime_profile_control_ack",
      payload: ack,
    });
  }

  async observeRuntimeStreamEvent(agentId: string, value: unknown): Promise<void> {
    const observer = this.runtimeBoundaryObserver;
    if (!observer) return;

    const gatedEvent = mapClaudeStreamJsonToGatedEvent(value);
    if (!gatedEvent) return;

    observer.recordGatedEvent(agentId, gatedEvent);
    const state = observer.getGatedState(agentId);

    if (gatedEvent.type === "tool_result") {
      const decision = decideGatedFlush(state, "tool_boundary");
      if (decision.action === "notify") {
        const count = observer.getPendingMessageCount(agentId);
        if (count > 0) {
          observer.markPendingNotification?.(agentId, count);
          await observer.sendPendingNotification(agentId, count);
        }
      }
    }

    if (gatedEvent.type === "turn_end") {
      const decision = decideGatedFlush(state, "turn_end");
      if (decision.action === "deliver_full") {
        await observer.flushDaemonInbox(agentId, "turn_end");
      }
    }
  }

  /** Update the Supabase client and auth token (called on token refresh) */
  updateSupabaseClient(
    supabase: SupabaseClient,
    authToken: string,
    agentAuthTokens: Record<string, string> = {}
  ) {
    // Remove old activity channel
    this.supabase.removeChannel(this.activityChannel);

    this.supabase = supabase;
    this.authToken = authToken;
    this.updateAgentAuthTokens(agentAuthTokens);

    // Re-subscribe activity channel on new client
    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  updateAgentAuthTokens(agentAuthTokens: Record<string, string>) {
    this.agentAuthTokens = agentAuthTokens;

    for (const [agentId, session] of this.sessions) {
      const tokenPath = join(session.workDir, ".zano", "agent-token");
      const token = agentAuthTokens[agentId];
      if (token) {
        mkdirSync(dirname(tokenPath), { recursive: true });
        writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
        chmodSync(tokenPath, 0o600);
      } else if (existsSync(tokenPath)) {
        rmSync(tokenPath);
      }
    }
  }

  private async persistActivityEvent(
    agentId: string,
    eventType: string,
    label: string,
    summary: string,
    scope: ActivityScope | null = this.processes.get(agentId)?.currentDelivery ?? null
  ) {
    const safeSummary = summary ? redactRuntimeText(summary) : "";
    const key = `${agentId}:${eventType}:${label}:${safeSummary}:${scope?.channelId ?? ""}:${scope?.sourceMessageId ?? ""}:${scope?.taskId ?? ""}`;
    if (this.lastPersistedActivity.get(agentId) === key) return;

    const session = this.sessions.get(agentId);
    if (!session?.serverId) return;

    try {
      const { error } = await this.supabase.from("member_activity_events").insert({
        server_id: session.serverId,
        channel_id: scope?.channelId ?? null,
        actor_id: agentId,
        actor_type: "agent",
        event_type: eventType,
        label,
        summary: safeSummary ? safeSummary.slice(0, 500) : null,
        metadata: { runtime: "claude-code" },
        visibility: "server",
        message_id: scope?.sourceMessageId ?? null,
        thread_parent_id: scope?.threadParentId ?? null,
        task_id: scope?.taskId ?? null,
        agent_id: agentId,
      });

      if (error) {
        console.warn("[AgentManager] Failed to persist activity", serializeRuntimeError(error));
        return;
      }

      this.lastPersistedActivity.set(agentId, key);
    } catch (error) {
      console.warn("[AgentManager] Failed to persist activity", serializeRuntimeError(error));
    }
  }

  private async beginAutonomousTurn(
    agentId: string,
    agentProc: AgentProcess,
    session: AgentSession,
    userMessage: string
  ) {
    if (!this.autonomousEvidenceEnabled || !session.serverId) return;

    try {
      const { data, error } = await this.supabase
        .from("agent_turns")
        .insert({
          server_id: session.serverId,
          agent_id: agentId,
          session_id: agentProc.sessionId,
          activation_reason: {
            source: "omni_message",
            input_preview: redactRuntimeText(userMessage).slice(0, 500),
          },
          status: "running",
        })
        .select("id")
        .single();

      if (error) {
        console.warn("[AgentManager] Failed to begin autonomous turn", serializeRuntimeError(error));
        return;
      }

      agentProc.turnId = data.id;
    } catch (error) {
      console.warn("[AgentManager] Failed to begin autonomous turn", serializeRuntimeError(error));
    }
  }

  private async completeAutonomousTurn(
    agentProc: AgentProcess,
    status: "completed" | "interrupted" | "failed",
    summary: string
  ) {
    if (!this.autonomousEvidenceEnabled || !agentProc.turnId) return;

    const turnId = agentProc.turnId;
    agentProc.turnId = null;
    const safeSummary = redactRuntimeText(summary);

    try {
      const { error } = await this.supabase
        .from("agent_turns")
        .update({
          completed_at: new Date().toISOString(),
          status,
          ...(status === "failed"
            ? { error_summary: safeSummary.slice(0, 500) }
            : { output_summary: safeSummary.slice(0, 500) }),
        })
        .eq("id", turnId);

      if (error) {
        console.warn("[AgentManager] Failed to complete autonomous turn", serializeRuntimeError(error));
      }
    } catch (error) {
      console.warn("[AgentManager] Failed to complete autonomous turn", serializeRuntimeError(error));
    }
  }

  private async recordAutonomousToolEvent(
    agentId: string,
    agentProc: AgentProcess,
    toolName: string,
    inputSummary: string
  ) {
    if (!this.autonomousEvidenceEnabled || !agentProc.turnId) return;

    const session = this.sessions.get(agentId);
    if (!session?.serverId) return;

    try {
      const { error } = await this.supabase.from("agent_tool_events").insert({
        turn_id: agentProc.turnId,
        server_id: session.serverId,
        agent_id: agentId,
        tool_name: toolName,
        tool_kind: "claude_code",
        input_summary: redactRuntimeText(inputSummary).slice(0, 500),
        metadata: { source: "stream-json" },
      });

      if (error) {
        console.warn("[AgentManager] Failed to record autonomous tool event", serializeRuntimeError(error));
      }
    } catch (error) {
      console.warn("[AgentManager] Failed to record autonomous tool event", serializeRuntimeError(error));
    }
  }

  private async refreshAutonomousSkills(agentId: string, session: AgentSession): Promise<string> {
    if (!this.autonomousSkillsEnabled || !session.serverId) return "";

    try {
      const result = await materializeAutonomousSkills({
        displayName: session.displayName,
        serverId: session.serverId,
        supabase: this.supabase,
        workDir: session.workDir,
      });
      const previousFingerprint = this.autonomousSkillFingerprints.get(agentId);
      this.autonomousSkillFingerprints.set(agentId, result.fingerprint);

      if (result.count > 0) {
        console.log(
          `  [${session.displayName}] Materialized ${result.count} autonomous shared skill(s).`
        );
      }

      if (previousFingerprint !== undefined && previousFingerprint !== result.fingerprint) {
        this.pendingAutonomousSkillRestarts.add(agentId);
      }

      return result.promptContext;
    } catch (error) {
      console.warn("[AgentManager] Failed to materialize autonomous skills", serializeRuntimeError(error));
      return "";
    }
  }

  private async restartForAutonomousSkillChangeIfNeeded(agentId: string): Promise<boolean> {
    if (!this.pendingAutonomousSkillRestarts.has(agentId)) return false;

    const session = this.sessions.get(agentId);
    const agentProc = this.processes.get(agentId);
    if (!session || !agentProc || agentProc.busy || agentProc.proc.killed || agentProc.proc.exitCode !== null) {
      return false;
    }

    this.pendingAutonomousSkillRestarts.delete(agentId);
    console.log(
      `  [${session.displayName}] Autonomous skill set changed — restarting process for fresh system prompt.`
    );
    await this.restartProcess(agentId);
    return true;
  }

  reportRuntimeBacklog(agentId: string, queueDepth: number): void {
    const detail = queueDepth === 1 ? "1 queued message" : `${queueDepth} queued messages`;
    this.broadcastActivity(agentId, "working", RUNTIME_BACKLOG_ACTIVITY_LABEL, detail);
  }

  /** Broadcast agent activity to all connected frontend clients */
  private broadcastActivity(
    agentId: string,
    activity: AgentActivity,
    label: string = "",
    detail: string = ""
  ) {
    const safeDetail = detail ? redactRuntimeText(detail) : "";
    const occurredAt = new Date().toISOString();
    const agentProc = this.processes.get(agentId);
    const session = this.sessions.get(agentId);
    const scope = agentProc?.currentDelivery ?? null;
    if (agentProc) {
      agentProc.activity = activity;
      agentProc.activityLabel = label;
      agentProc.activityDetail = safeDetail;

      // Manage heartbeat: only active for thinking/working
      if (activity === "thinking" || activity === "working") {
        if (!agentProc.heartbeatTimer) {
          agentProc.heartbeatTimer = setInterval(() => {
            this.activityChannel.send({
              type: "broadcast",
              event: "activity",
              payload: {
                serverId: session?.serverId ?? null,
                agentId,
                activity: agentProc.activity,
                label: agentProc.activityLabel,
                detail: agentProc.activityDetail,
                channelId: agentProc.currentDelivery?.channelId ?? null,
                sourceMessageId: agentProc.currentDelivery?.sourceMessageId ?? null,
                threadParentId: agentProc.currentDelivery?.threadParentId ?? null,
                taskId: agentProc.currentDelivery?.taskId ?? null,
                occurredAt: new Date().toISOString(),
              },
            });
          }, ACTIVITY_HEARTBEAT_MS);
        }
      } else {
        if (agentProc.heartbeatTimer) {
          clearInterval(agentProc.heartbeatTimer);
          agentProc.heartbeatTimer = null;
        }
      }
    }

    this.activityChannel.send({
      type: "broadcast",
      event: "activity",
      payload: {
        serverId: session?.serverId ?? null,
        agentId,
        activity,
        label,
        detail: safeDetail,
        channelId: scope?.channelId ?? null,
        sourceMessageId: scope?.sourceMessageId ?? null,
        threadParentId: scope?.threadParentId ?? null,
        taskId: scope?.taskId ?? null,
        occurredAt,
      },
    });

    // Persist broadcast activity with correct event mapping
    const eventType = activity === "working" && label && label !== "Working" && label !== RUNTIME_BACKLOG_ACTIVITY_LABEL
      ? "agent.tool_use"
      : `agent.${activity}`;
    void this.persistActivityEvent(agentId, eventType, label || activity, safeDetail, scope);
  }

  /**
   * Map a tool_use event to a human-readable label and detail string.
   * e.g. Read → ("Reading file", "/path/to/file")
   */
  private describeToolUse(contentBlock: any): { label: string; detail: string } {
    const toolName: string = contentBlock.name || "tool";
    const input = contentBlock.input || {};

    switch (toolName) {
      case "Read":
        return { label: "Reading file", detail: input.file_path || "" };

      case "Write":
        return { label: "Writing file", detail: input.file_path || "" };

      case "Edit":
        return { label: "Editing file", detail: input.file_path || "" };

      case "Bash": {
        const cmd: string = input.command || "";
        // Detect zano/slock message send
        const msgMatch = cmd.match(/(?:zano|slock)\s+message\s+send\s+--target\s+"?([^"]+)"?/);
        if (msgMatch) {
          return { label: "Sending message", detail: msgMatch[1] };
        }
        // Truncate long commands
        return { label: "Running command", detail: cmd.length > 120 ? cmd.substring(0, 120) + "…" : cmd };
      }

      case "Grep":
        return { label: "Searching", detail: input.pattern || "" };

      case "Glob":
        return { label: "Finding files", detail: input.pattern || "" };

      case "Agent":
        return { label: "Running agent", detail: input.description || "" };

      case "WebSearch":
        return { label: "Searching web", detail: input.query || "" };

      case "WebFetch":
        return { label: "Fetching URL", detail: input.url || "" };

      case "Skill":
        return { label: "Running skill", detail: input.skill || "" };

      case "TodoWrite":
        return { label: "Updating tasks", detail: "" };

      default:
        return { label: `Running ${toolName}`, detail: "" };
    }
  }

  /**
   * Flush accumulated assistant text as an activity broadcast.
   * Called before switching to a different activity type.
   */
  private flushPendingText(agentId: string, agentProc: AgentProcess) {
    if (!agentProc.pendingText) return;

    const text = agentProc.pendingText.trim();
    if (text) {
      void this.persistActivityEvent(agentId, "agent.output", "Output", text);
    }
    agentProc.pendingText = "";
  }

  /** Save session ID to Supabase so it survives Omni restarts */
  private async saveSessionId(agentId: string, sessionId: string) {
    await this.supabase
      .from("agents")
      .update({ session_id: sessionId })
      .eq("id", agentId);
  }

  /** Load session ID from Supabase */
  private async loadSessionId(agentId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("agents")
      .select("session_id")
      .eq("id", agentId)
      .single();
    return data?.session_id || null;
  }

  private materializeRuntimePrompt(
    agentId: string,
    session: AgentSession,
    agent: AgentRecord,
    memoryContext: string,
    autonomousSkillContext: string,
    model: string,
  ): RuntimePromptSnapshot | null {
    if (!this.runtimeOptions) return null;

    const materialized = new PromptMaterializer({ rootDir: resolve(this.agentsDir, ".."), agentsDir: this.agentsDir }).materialize({
      agentId,
      displayName: session.displayName,
      name: session.name,
      description: agent.description,
      systemPrompt: agent.system_prompt,
      memoryContext,
      autonomousSkillContext,
      workspaceId: this.runtimeOptions.workspaceId,
      workspaceName: this.runtimeOptions.workspaceName,
      machineId: this.runtimeOptions.machineId,
      hostname: this.runtimeOptions.hostname,
      platform: this.runtimeOptions.platform,
      workDir: session.workDir,
      omniVersion: this.runtimeOptions.omniVersion,
      model,
      runtimeControlMcpUrl: this.runtimeOptions.runtimeControlMcpUrl ?? DEFAULT_RUNTIME_CONTROL_MCP_URL,
    });

    return { content: materialized.content, mcpConfigPath: materialized.mcpConfigPath, promptHash: materialized.promptHash };
  }

  private startRuntimeSession(
    agentId: string,
    model: string,
    sessionId: string | null,
    processId: number | null,
    promptHash: string,
    wrapperHash: string | null,
    launchId: string,
    workspacePathRef: string,
    runtimeProfile: string,
  ): Promise<string | null> | null {
    if (!this.runtimeOptions || !this.runtimeSessionLedger) return null;

    return this.runtimeSessionLedger
      .startSession({
        workspaceId: this.runtimeOptions.workspaceId,
        agentId,
        machineId: this.runtimeOptions.machineId,
        runtimeModel: model,
        sessionId,
        processId,
        promptHash,
        wrapperHash,
        launchId,
        sessionRef: null,
        sessionRefReachable: false,
        workspacePathRef,
        runtimeProfile,
      })
      .then((session) => session.id)
      .catch((error) => {
        console.warn("[AgentManager] Failed to persist runtime session", serializeRuntimeError(error));
        return null;
      });
  }

  private resolveRuntimeSessionPatch(agentProc: AgentProcess, sessionId: string): Parameters<RuntimeSessionLedger["updateState"]>[2] {
    try {
      const sessionRef = resolveRuntimeSessionRef({
        runtime: "claude",
        sessionId,
        homeDir: homedir(),
        fallbackDir: join(agentProc.workDir, ".zano", "runtime-sessions"),
        launchId: agentProc.launchId,
      });

      return {
        sessionId,
        sessionRef: sessionRef.path,
        sessionRefReachable: sessionRef.reachable,
        workspacePathRef: agentProc.workDir,
        runtimeProfile: agentProc.runtimeProfile ?? "claude",
      };
    } catch (error) {
      console.warn("[AgentManager] Failed to resolve runtime session ref", serializeRuntimeError(error));
      return {
        sessionId,
        sessionRef: null,
        sessionRefReachable: false,
        workspacePathRef: agentProc.workDir,
        runtimeProfile: agentProc.runtimeProfile ?? "claude",
      };
    }
  }

  private updateRuntimeSessionState(
    agentProc: AgentProcess,
    state: RuntimeSessionState,
    patch: Parameters<RuntimeSessionLedger["updateState"]>[2] = {},
  ): Promise<void> {
    if (!this.runtimeSessionLedger) return agentProc.runtimeSessionUpdate;

    const safePatch = typeof patch.lastError === "string"
      ? { ...patch, lastError: redactRuntimeText(patch.lastError) }
      : patch;

    agentProc.runtimeSessionUpdate = agentProc.runtimeSessionUpdateQueue.enqueue(state, async () => {
      const runtimeSessionId = agentProc.runtimeSessionId ?? (await agentProc.runtimeSessionStart);
      if (!runtimeSessionId) return;
      agentProc.runtimeSessionId = runtimeSessionId;

      await this.runtimeSessionLedger?.updateState(runtimeSessionId, state, safePatch);
    });
    agentProc.runtimeSessionTerminalState = state === "failed" || state === "ended"
      ? state === "failed" || agentProc.runtimeSessionTerminalState !== "failed"
        ? state
        : agentProc.runtimeSessionTerminalState
      : agentProc.runtimeSessionTerminalState;

    return agentProc.runtimeSessionUpdate;
  }

  setNextActivityScope(agentId: string, scope: ActivityScope) {
    this.pendingActivityScopes.set(agentId, scope);
    const agentProc = this.processes.get(agentId);
    if (agentProc) agentProc.currentDelivery = scope;
  }

  async setCurrentDelivery(agentId: string, context: {
    deliveryId: string;
    deliverySeq: number;
    traceparent: string;
    target: string;
    channelId: string;
    sourceMessageId: string;
    threadParentId: string | null;
    taskId: string | null;
    messageCreatedAt: string;
  }) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    this.setNextActivityScope(agentId, {
      channelId: context.channelId,
      sourceMessageId: context.sourceMessageId,
      threadParentId: context.threadParentId,
      taskId: context.taskId,
    });

    const statePath = join(session.workDir, ".zano", "state.json");
    let current: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ ...current, currentDelivery: context }, null, 2) + "\n", "utf8");
  }

  async initAgent(agentId: string, agent: AgentRecord) {
    const workDir = join(this.agentsDir, agentId);

    // Create workspace if it doesn't exist
    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true });
      mkdirSync(join(workDir, "notes"), { recursive: true });

      // Write initial MEMORY.md
      const memoryContent = `# ${agent.display_name}

## Role
${agent.description || agent.display_name}

## Key Knowledge
- No notes saved yet. Knowledge will accumulate through conversations.

## Active Context
- Status: First startup — no prior conversations.
- Workspace initialized at: ${new Date().toISOString().split("T")[0]}
`;
      writeFileSync(join(workDir, "MEMORY.md"), memoryContent);
      console.log(`  [${agent.display_name}] Workspace created: ${workDir}`);
    } else {
      console.log(`  [${agent.display_name}] Workspace exists: ${workDir}`);
    }

    // Initialize session
    this.sessions.set(agentId, {
      id: agentId,
      name: agent.name,
      displayName: agent.display_name,
      workDir,
      serverId: agent.server_id,
    });

  }

  /**
   * Send a message to an agent. Messages are queued and processed
   * sequentially — the next message is only sent after the current
   * turn completes (indicated by a "result" stream-json event).
   */
  getRuntimeAgentState(agentId: string) {
    const agentProc = this.processes.get(agentId);
    if (!agentProc || agentProc.proc.killed || agentProc.proc.exitCode !== null) {
      return { state: "stopped" as const, busy: false, queueDepth: 0, sessionId: null, processId: null };
    }
    return {
      state: agentProc.busy ? "busy" as const : "ready" as const,
      busy: agentProc.busy,
      queueDepth: agentProc.messageQueue.length,
      sessionId: agentProc.sessionId,
      processId: agentProc.proc.pid ?? null,
    };
  }

  async deliverRuntimeMessage(agentId: string, prompt: string): Promise<void> {
    await this.sendToAgent(agentId, prompt);
  }

  async ensureRuntimeProcess(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error(`Agent ${agentId} not initialized`);

    const existing = this.processes.get(agentId);
    if (existing && !existing.proc.killed && existing.proc.exitCode === null) return;

    const { data: agent, error: agentError } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .is("archived_at", null)
      .single();

    if (agentError || !agent) {
      throw new Error(`Agent ${agentId} archived or not initialized`);
    }

    if (this.sessions.get(agentId) !== session) {
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    let memoryContext = "";
    const memoryPath = join(session.workDir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memoryContext = readFileSync(memoryPath, "utf-8");
    }

    const autonomousSkillContext = await this.refreshAutonomousSkills(agentId, session);
    if (this.sessions.get(agentId) !== session) {
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    const systemPrompt = buildSystemPrompt(agent, memoryContext, autonomousSkillContext);
    const agentProc = await this.spawnProcess(
      agentId,
      session,
      agent as AgentRecord,
      memoryContext,
      autonomousSkillContext,
      systemPrompt,
      agent?.model || "opus"
    );

    if (this.sessions.get(agentId) !== session) {
      if (!agentProc.proc.killed) agentProc.proc.kill();
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    this.processes.set(agentId, agentProc);
  }

  sendRuntimePendingNotification(agentId: string, count: number): void {
    const agentProc = this.processes.get(agentId);
    if (!agentProc || agentProc.proc.killed || agentProc.proc.exitCode !== null) return;

    const messageCount = count === 1 ? "1 queued message" : `${count} queued messages`;
    const stdinMsg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: `You have ${messageCount} waiting. This is only a pending notification; continue safely and the full inbox will be delivered after this turn ends.` }],
      },
      ...(agentProc.sessionId ? { session_id: agentProc.sessionId } : {}),
    });

    agentProc.proc.stdin?.write(stdinMsg + "\n");
  }

  async sendToAgent(agentId: string, userMessage: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    // Get agent record for system prompt
    const { data: agent, error: agentError } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .is("archived_at", null)
      .single();

    if (agentError || !agent) {
      throw new Error(`Agent ${agentId} archived or not initialized`);
    }

    if (this.sessions.get(agentId) !== session) {
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    // Get MEMORY.md content
    let memoryContext = "";
    const memoryPath = join(session.workDir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memoryContext = readFileSync(memoryPath, "utf-8");
    }

    const autonomousSkillContext = await this.refreshAutonomousSkills(agentId, session);
    if (this.sessions.get(agentId) !== session) {
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    const systemPrompt = buildSystemPrompt(agent, memoryContext, autonomousSkillContext);

    // Ensure a persistent process is running
    let agentProc = this.processes.get(agentId);
    if (!agentProc || agentProc.proc.killed || agentProc.proc.exitCode !== null) {
      if (this.sessions.get(agentId) !== session) {
        throw new Error(`Agent ${agentId} stopped or archived`);
      }

      agentProc = await this.spawnProcess(
        agentId,
        session,
        agent as AgentRecord,
        memoryContext,
        autonomousSkillContext,
        systemPrompt,
        agent?.model || "opus"
      );

      if (this.sessions.get(agentId) !== session) {
        if (!agentProc.proc.killed) agentProc.proc.kill();
        throw new Error(`Agent ${agentId} stopped or archived`);
      }

      this.processes.set(agentId, agentProc);
    }

    const scope = this.pendingActivityScopes.get(agentId) ?? {};
    this.pendingActivityScopes.delete(agentId);

    // If the agent is busy, queue the message and wait
    if (agentProc.busy) {
      const displayName = session.displayName;
      console.log(
        `  [${displayName}] Agent busy, queueing message (${userMessage.length} chars, queue size: ${agentProc.messageQueue.length + 1})...`
      );
      return new Promise<void>((resolve, reject) => {
        agentProc!.messageQueue.push({ userMessage, scope, resolve, reject });
      });
    }

    if (await this.restartForAutonomousSkillChangeIfNeeded(agentId)) {
      agentProc = this.processes.get(agentId) ?? agentProc;
    }

    if (this.sessions.get(agentId) !== session) {
      throw new Error(`Agent ${agentId} stopped or archived`);
    }

    // Send immediately
    this.deliverMessage(agentId, agentProc, session, userMessage, scope);
  }

  /** Write a message to the agent's stdin and mark it as busy */
  private deliverMessage(
    agentId: string,
    agentProc: AgentProcess,
    session: AgentSession,
    userMessage: string,
    scope: ActivityScope
  ) {
    agentProc.busy = true;
    agentProc.currentDelivery = scope;

    const stdinMsg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: userMessage }],
      },
      ...(agentProc.sessionId ? { session_id: agentProc.sessionId } : {}),
    });

    const displayName = session.displayName;
    console.log(
      `  [${displayName}] Forwarding message (${userMessage.length} chars)...`
    );
    this.broadcastActivity(agentId, "working", "Working", "Message received");
    void this.updateRuntimeSessionState(agentProc, "busy", {
      sessionId: agentProc.sessionId,
      processId: agentProc.proc.pid ?? null,
    });
    // Keep received_message as a semantic event in addition to the live working activity.
    void this.persistActivityEvent(agentId, "agent.received_message", "Message received", "");
    void this.beginAutonomousTurn(agentId, agentProc, session, userMessage);
    agentProc.proc.stdin?.write(stdinMsg + "\n");
  }

  /** Process the next queued message, if any */
  private drainQueue(agentId: string, agentProc: AgentProcess) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const next = agentProc.messageQueue.shift();
    if (next) {
      console.log(
        `  [${session.displayName}] Draining queue (${agentProc.messageQueue.length} remaining)...`
      );
      this.deliverMessage(agentId, agentProc, session, next.userMessage, next.scope);
      // Resolve the queued promise — message has been delivered
      next.resolve();
    }
  }

  /**
   * Restart the agent process to pick up a fresh system prompt
   * (with updated MEMORY.md). Uses --resume to continue the session.
   */
  private async restartProcess(agentId: string) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const agentProc = this.processes.get(agentId);
    if (!agentProc) return;

    const displayName = session.displayName;
    const sessionId = agentProc.sessionId;

    console.log(
      `  [${displayName}] Restarting process for fresh system prompt (session: ${sessionId?.substring(0, 8) || "none"})...`
    );

    // Clean up old process
    if (agentProc.heartbeatTimer) {
      clearInterval(agentProc.heartbeatTimer);
    }

    // Save any queued messages before killing the process
    const pendingQueue = [...agentProc.messageQueue];
    agentProc.messageQueue = [];

    if (!agentProc.proc.killed) {
      agentProc.proc.kill();
    }

    // Build fresh system prompt with current MEMORY.md
    const { data: agent, error: agentError } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .is("archived_at", null)
      .single();

    if (agentError || !agent || this.sessions.get(agentId) !== session) {
      const error = new Error(`Agent ${agentId} stopped or archived`);
      for (const queued of pendingQueue) queued.reject(error);
      this.processes.delete(agentId);
      throw error;
    }

    let memoryContext = "";
    const memoryPath = join(session.workDir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memoryContext = readFileSync(memoryPath, "utf-8");
    }

    const autonomousSkillContext = await this.refreshAutonomousSkills(agentId, session);
    if (this.sessions.get(agentId) !== session) {
      const error = new Error(`Agent ${agentId} stopped or archived`);
      for (const queued of pendingQueue) queued.reject(error);
      this.processes.delete(agentId);
      throw error;
    }

    const systemPrompt = buildSystemPrompt(agent, memoryContext, autonomousSkillContext);

    // Spawn new process — will resume the session via saved sessionId
    const newProc = await this.spawnProcess(
      agentId,
      session,
      agent as AgentRecord,
      memoryContext,
      autonomousSkillContext,
      systemPrompt,
      agent?.model || "opus"
    );

    if (this.sessions.get(agentId) !== session) {
      const error = new Error(`Agent ${agentId} stopped or archived`);
      if (!newProc.proc.killed) newProc.proc.kill();
      for (const queued of pendingQueue) queued.reject(error);
      this.processes.delete(agentId);
      throw error;
    }

    // Restore pending queue
    newProc.messageQueue = pendingQueue;

    this.processes.set(agentId, newProc);

    console.log(
      `  [${displayName}] Process restarted with fresh MEMORY.md.`
    );
  }

  /**
   * Set up CLI transport for the agent — writes a bash wrapper script
   * and env config into .zano/ directory in agent workspace.
   * Returns the .zano/ directory path (to prepend to PATH).
   */
  private prepareCliTransport(agentId: string, session: AgentSession, launchId: string): PreparedCliTransport {
    let cliPath: string;
    let mode: "node" | "tsx";
    const omniRoot = resolve(__dirname, "..");
    const localCliPath = resolve(omniRoot, "..", "..", "packages", "cli", "src", "index.ts");

    if (existsSync(localCliPath)) {
      cliPath = localCliPath;
      mode = "tsx";
      console.log(`  [${session.displayName}] CLI resolved from monorepo dev path: ${cliPath}`);
    } else {
      const req = createRequire(import.meta.url);
      cliPath = req.resolve("@fehey/zano-cli/dist/index.js");
      mode = "node";
      console.log(`  [${session.displayName}] CLI resolved from npm package: ${cliPath}`);
    }

    const proxyOptions = this.runtimeOptions?.credentialProxy;
    const proxyToken = proxyOptions?.proxyTokens[agentId];
    const credentialProxy: CliTransportCredentialProxyInput | undefined = proxyOptions && proxyToken
      ? {
        proxyUrl: proxyOptions.proxyUrl,
        proxyToken,
        activeCapabilities: proxyOptions.activeCapabilities,
      }
      : undefined;
    const directAgentToken = credentialProxy ? undefined : this.agentAuthTokens[agentId];
    const wrapper = new CliTransportMaterializer({ rootDir: resolve(this.agentsDir, ".."), agentsDir: this.agentsDir, nodePath: process.execPath }).materialize({
      agentId,
      cliEntrypoint: cliPath,
      mode,
      launchId,
      serverUrl: this.supabaseUrl,
      supabaseKey: this.supabaseKey,
      ...(credentialProxy
        ? { credentialProxy }
        : directAgentToken
          ? { agentToken: directAgentToken }
          : {}),
    });

    console.log(`  [${session.displayName}] CLI wrapper written: ${wrapper.wrapperPath}`);
    return {
      pathDir: wrapper.pathDir,
      wrapperHash: wrapper.wrapperHash,
      tokenFilePath: wrapper.tokenFilePath,
      proxyTokenFilePath: wrapper.proxyTokenFilePath,
      supabaseKeyFilePath: wrapper.supabaseKeyFilePath,
      proxyUrl: credentialProxy?.proxyUrl ?? null,
      activeCapabilities: credentialProxy?.activeCapabilities ?? null,
      launchId,
    };
  }

  private async spawnProcess(
    agentId: string,
    session: AgentSession,
    agent: AgentRecord,
    memoryContext: string,
    autonomousSkillContext: string,
    systemPrompt: string,
    model: string = "opus"
  ): Promise<AgentProcess> {
    const runtimePrompt = this.materializeRuntimePrompt(agentId, session, agent, memoryContext, autonomousSkillContext, model);
    const appendSystemPrompt = runtimePrompt?.content ?? systemPrompt;

    // Prepare CLI transport (.zano/ wrapper + env vars)
    const launchId = randomUUID();
    const cliTransport = this.prepareCliTransport(agentId, session, launchId);

    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      appendSystemPrompt,
      ...(runtimePrompt?.mcpConfigPath ? ["--mcp-config", runtimePrompt.mcpConfigPath] : []),
      "--permission-mode",
      "bypassPermissions",
      "--model",
      model,
    ];

    // Resume previous session: check in-memory first, then Supabase
    const prevProc = this.processes.get(agentId);
    const sessionId =
      prevProc?.sessionId || (await this.loadSessionId(agentId));
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(
      `  [${session.displayName}] Spawning Claude Code (stream-json + CLI, ${sessionId ? `resume: ${sessionId.substring(0, 8)}` : "new session"})...`
    );

    const baseEnv = childProcessBaseEnv(process.env);
    const childEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ZANO_HOME: cliTransport.pathDir,
      ZANO_AGENT_ID: agentId,
      ZANO_AGENT_LAUNCH_ID: cliTransport.launchId,
      ZANO_SERVER_URL: this.supabaseUrl,
      ZANO_AGENT_LOCAL_STATE: join(cliTransport.pathDir, "state.json"),
      ...(cliTransport.tokenFilePath ? { ZANO_AGENT_TOKEN_FILE: cliTransport.tokenFilePath } : {}),
      ...(cliTransport.supabaseKeyFilePath ? { ZANO_SUPABASE_KEY_FILE: cliTransport.supabaseKeyFilePath } : {}),
      ...(cliTransport.proxyUrl ? { ZANO_AGENT_PROXY_URL: cliTransport.proxyUrl } : {}),
      ...(cliTransport.proxyTokenFilePath ? { ZANO_AGENT_PROXY_TOKEN_FILE: cliTransport.proxyTokenFilePath } : {}),
      ...(cliTransport.activeCapabilities?.length ? { ZANO_AGENT_ACTIVE_CAPABILITIES: JSON.stringify(cliTransport.activeCapabilities) } : {}),
      // Prepend .zano/ to PATH so `zano` command is available.
      PATH: `${cliTransport.pathDir}:${baseEnv.PATH ?? ""}`,
    };

    const proc = spawn("claude", args, {
      cwd: session.workDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const agentProc: AgentProcess = {
      proc,
      sessionId: prevProc?.sessionId || null,
      workDir: session.workDir,
      launchId: cliTransport.launchId,
      runtimeProfile: "claude",
      runtimeSessionId: null,
      runtimeSessionStart: null,
      runtimeSessionUpdate: Promise.resolve(),
      runtimeSessionTerminalState: null,
      runtimeSessionUpdateQueue: new RuntimeSessionUpdateQueue(),
      turnId: null,
      busy: false,
      stdoutBuffer: "",
      stdoutLineQueue: Promise.resolve(),
      activity: "working",
      activityLabel: "Working",
      activityDetail: "Starting…",
      heartbeatTimer: null,
      messageQueue: [],
      currentDelivery: prevProc?.currentDelivery ?? null,
      pendingText: "",
      pendingRuntimeProfileControl: prevProc?.pendingRuntimeProfileControl ?? this.pendingRuntimeProfileControls.get(agentId) ?? null,
    };

    const promptHash = runtimePrompt?.promptHash ?? createHash("sha256").update(systemPrompt).digest("hex");
    agentProc.runtimeSessionStart = this.startRuntimeSession(
      agentId,
      model,
      sessionId ?? null,
      proc.pid ?? null,
      promptHash,
      cliTransport.wrapperHash,
      cliTransport.launchId,
      session.workDir,
      "claude",
    );
    void agentProc.runtimeSessionStart?.then((runtimeSessionId) => {
      agentProc.runtimeSessionId = runtimeSessionId;
    });

    // Broadcast initial activity
    this.broadcastActivity(agentId, "working", "Working", "Starting…");
    void this.persistActivityEvent(agentId, "agent.started", "Started", "");

    // Parse stdout line by line for stream-json events
    proc.stdout?.on("data", (chunk: Buffer) => {
      agentProc.stdoutBuffer += chunk.toString();
      const lines = agentProc.stdoutBuffer.split("\n");
      agentProc.stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        agentProc.stdoutLineQueue = agentProc.stdoutLineQueue
          .then(() => this.handleStreamEvent(agentId, agentProc, trimmed))
          .catch((error) => {
            console.warn("[AgentManager] Failed to handle stream event", serializeRuntimeError(error));
          });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      // Filter out noisy reconnection messages
      if (/Reconnecting\.\.\.|Falling back from WebSockets/i.test(text)) return;
      console.error(`  [${session.displayName}] stderr: ${redactRuntimeText(text).substring(0, 200)}`);
    });

    proc.on("error", (err: Error) => {
      const safeMessage = redactRuntimeText(err.message);
      console.error(
        `  [${session.displayName}] Process error: ${safeMessage}`
      );
      void this.persistActivityEvent(agentId, "agent.error", "Error", safeMessage);
      void this.updateRuntimeSessionState(agentProc, "failed", {
        processId: null,
        lastError: safeMessage,
      });
      void this.completeAutonomousTurn(agentProc, "failed", safeMessage);
    });

    proc.on("close", (code: number | null) => {
      console.log(
        `  [${session.displayName}] Process exited with code ${code}`
      );
      void this.persistActivityEvent(agentId, "agent.disconnected", "Disconnected", `Process exited with code ${code}`);
      void this.updateRuntimeSessionState(agentProc, code === 0 || code === null ? "ended" : "failed", {
        processId: null,
        ...(code === 0 || code === null ? {} : { lastError: `Process exited with code ${code}` }),
      });
      void this.completeAutonomousTurn(agentProc, code === 0 ? "interrupted" : "failed", `Process exited with code ${code}`);
      // Reject any remaining queued messages
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error(`Agent process exited with code ${code}`));
      }
      agentProc.messageQueue = [];
    });

    return agentProc;
  }

  private async handleStreamEvent(
    agentId: string,
    agentProc: AgentProcess,
    line: string
  ): Promise<void> {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    if (event.type !== "result") {
      await this.observeRuntimeStreamEvent(agentId, event);
    }

    const session = this.sessions.get(agentId);
    const displayName = session?.displayName || agentId;

    switch (event.type) {
      case "system":
        if (event.subtype === "init" && event.session_id) {
          agentProc.sessionId = event.session_id;
          this.saveSessionId(agentId, event.session_id);
          void this.updateRuntimeSessionState(agentProc, "ready", {
            ...this.resolveRuntimeSessionPatch(agentProc, event.session_id),
            processId: agentProc.proc.pid ?? null,
          });
          console.log(
            `  [${displayName}] Session initialized: ${event.session_id.substring(0, 8)}...`
          );
        }
        if (event.subtype === "compacting") {
          this.flushPendingText(agentId, agentProc);
          this.broadcastActivity(agentId, "working", "Optimizing context", "");
          // Restart the process to pick up fresh MEMORY.md in system prompt
          console.log(
            `  [${displayName}] Context compaction detected — scheduling process restart for fresh MEMORY.md...`
          );
          this.restartProcess(agentId).catch((err) => {
            console.error(
              `  [${displayName}] Failed to restart after compaction: ${redactRuntimeText(err.message)}`
            );
          });
        }
        break;

      case "assistant": {
        // Claude Code stream-json nests content inside event.message.content[]
        // Each assistant event contains one content block in the array.
        const contentBlock = event.message?.content?.[0];
        if (!contentBlock) break;

        const blockType = contentBlock.type;

        if (blockType === "thinking") {
          // Flush any accumulated text before switching to thinking
          this.flushPendingText(agentId, agentProc);
          this.broadcastActivity(agentId, "thinking", "Thinking", "");
        } else if (blockType === "text") {
          // Store latest text output — will be flushed when next non-text event arrives
          agentProc.pendingText = contentBlock.text || "";
        } else if (blockType === "tool_use") {
          // Flush accumulated text first
          this.flushPendingText(agentId, agentProc);
          const toolUseName = contentBlock.name || "";
          const toolUseArguments = contentBlock.input && typeof contentBlock.input === "object" && !Array.isArray(contentBlock.input)
            ? (contentBlock.input as Record<string, unknown>)
            : {};
          if (agentProc.pendingRuntimeProfileControl) {
            const ack = observeRuntimeProfileMigrationDone(agentProc.pendingRuntimeProfileControl, {
              toolName: toolUseName,
              arguments: toolUseArguments,
            });
            if (ack) {
              this.runtimeProfileControlAcks.push(ack);
              this.broadcastRuntimeProfileControlAck(ack);
              this.pendingRuntimeProfileControls.delete(agentId);
              agentProc.pendingRuntimeProfileControl = null;
            }
          }
          // Map tool to human-readable label + detail
          const { label, detail } = this.describeToolUse(contentBlock);
          this.broadcastActivity(agentId, "working", label, detail);
          void this.recordAutonomousToolEvent(
            agentId,
            agentProc,
            contentBlock.name || "tool",
            detail || label
          );
        }
        break;
      }

      case "result": {
        // Flush any final text and release the completed turn before turn-end daemon delivery.
        this.flushPendingText(agentId, agentProc);
        if (event.session_id) {
          agentProc.sessionId = event.session_id;
          await this.saveSessionId(agentId, event.session_id);
        }
        agentProc.busy = false;
        await this.completeAutonomousTurn(agentProc, "completed", "Turn complete");

        await this.observeRuntimeStreamEvent(agentId, event);

        console.log(`  [${displayName}] Turn complete.`);
        if (agentProc.busy) {
          break;
        }

        this.broadcastActivity(agentId, "idle", "Idle", "");
        agentProc.currentDelivery = null;
        void this.updateRuntimeSessionState(agentProc, "idle", {
          ...(agentProc.sessionId ? this.resolveRuntimeSessionPatch(agentProc, agentProc.sessionId) : { sessionId: agentProc.sessionId }),
          processId: agentProc.proc.pid ?? null,
        });

        if (this.pendingAutonomousSkillRestarts.has(agentId)) {
          this.restartForAutonomousSkillChangeIfNeeded(agentId)
            .then((restarted) => {
              if (restarted) {
                const restartedProc = this.processes.get(agentId);
                if (restartedProc && !restartedProc.busy) this.drainQueue(agentId, restartedProc);
              }
            })
            .catch((err) => {
              console.error(
                `  [${displayName}] Failed to restart after autonomous skill change: ${redactRuntimeText(err.message)}`
              );
            });
          break;
        }

        // Process next queued message if no boundary delivery started a new turn.
        this.drainQueue(agentId, agentProc);
        break;
      }
    }
  }

  /** Get the workspace directory for an agent */
  getWorkspaceDir(agentId: string): string {
    return this.sessions.get(agentId)?.workDir ?? join(this.agentsDir, agentId);
  }

  purgeCredentialsForInactiveAgents(activeAgentIds: Iterable<string>): void {
    const activeAgentIdSet = new Set(activeAgentIds);
    for (const entry of readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || activeAgentIdSet.has(entry.name)) continue;
      this.removeAgentCredentialFiles(entry.name, join(this.agentsDir, entry.name));
    }

    const proxyTokensDir = join(resolve(this.agentsDir, ".."), "agent-proxy-tokens");
    if (!existsSync(proxyTokensDir)) return;

    for (const entry of readdirSync(proxyTokensDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || activeAgentIdSet.has(entry.name)) continue;
      rmSync(join(proxyTokensDir, entry.name), { recursive: true, force: true });
    }
  }

  private removeAgentCredentialFiles(agentId: string, workDir?: string): void {
    const directTokenPaths = new Set([
      ...(workDir ? [join(workDir, ".zano", "agent-token")] : []),
      join(this.agentsDir, agentId, ".zano", "agent-token"),
    ]);

    for (const tokenPath of directTokenPaths) {
      rmSync(tokenPath, { force: true });
    }

    rmSync(join(resolve(this.agentsDir, ".."), "agent-proxy-tokens", agentId), { recursive: true, force: true });
  }

  stopAgent(agentId: string, reason = "Agent manager stopped") {
    const session = this.sessions.get(agentId);
    const agentProc = this.processes.get(agentId);
    if (agentProc) {
      if (agentProc.heartbeatTimer) {
        clearInterval(agentProc.heartbeatTimer);
      }
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error(reason));
      }
      agentProc.messageQueue = [];
      if (!agentProc.proc.killed) {
        console.log(`  Stopping agent process: ${agentId}`);
        agentProc.proc.kill();
      }
      this.processes.delete(agentId);
    }

    this.removeAgentCredentialFiles(agentId, session?.workDir ?? agentProc?.workDir);
    this.sessions.delete(agentId);
    this.autonomousSkillFingerprints.delete(agentId);
    this.pendingAutonomousSkillRestarts.delete(agentId);
    this.pendingRuntimeProfileControls.delete(agentId);
    this.lastPersistedActivity.delete(agentId);
  }

  stopAll() {
    // Kill all running processes and clean up heartbeats
    for (const [agentId, agentProc] of this.processes) {
      if (agentProc.heartbeatTimer) {
        clearInterval(agentProc.heartbeatTimer);
      }
      // Reject any queued messages
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error("Agent manager stopped"));
      }
      agentProc.messageQueue = [];
      if (!agentProc.proc.killed) {
        console.log(`  Stopping agent process: ${agentId}`);
        agentProc.proc.kill();
      }
    }
    this.processes.clear();
    this.sessions.clear();
    this.supabase.removeChannel(this.activityChannel);
  }
}
