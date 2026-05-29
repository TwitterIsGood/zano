import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, RuntimeSessionUpdateQueue } from "./agent-manager";
import { createGatedSteeringState, recordGatedSteeringEvent } from "./runtime/gated-steering";
import type { ClaudeGatedSteeringEvent, GatedSteeringState, RuntimeSessionState } from "./runtime/types";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createSupabaseStub = (activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string; channelId?: string | null; sourceMessageId?: string | null; threadParentId?: string | null; taskId?: string | null }> = []) => ({
  channel: () => ({
    subscribe: () => undefined,
    send: (message: { event?: string; payload?: { agentId: string; activity: string; label: string; detail: string; channelId?: string | null; sourceMessageId?: string | null; threadParentId?: string | null; taskId?: string | null } }) => {
      if (message.event === "activity" && message.payload) activityPayloads.push(message.payload);
      return undefined;
    },
  }),
  removeChannel: () => undefined,
  from: (table: string) => {
    if (table !== "agents") throw new Error(`Unexpected table: ${table}`);
    const query = {
      select: () => query,
      update: () => query,
      eq: () => query,
      is: () => query,
      single: async () => ({
        data: {
          id: "agent-1",
          name: "agent-1",
          display_name: "Agent One",
          description: null,
          system_prompt: null,
          model: "opus",
          status: "active",
        },
        error: null,
      }),
    };
    return query;
  },
});

const createBoundaryObserver = (pendingCount = 2) => {
  let state: GatedSteeringState = createGatedSteeringState();
  const pendingNotifications: number[] = [];
  const pendingNotificationMarks: number[] = [];
  const fullFlushes: Array<"idle" | "turn_end"> = [];

  return {
    observer: {
      recordGatedEvent: (_agentId: string, event: ClaudeGatedSteeringEvent) => {
        state = recordGatedSteeringEvent(state, event);
      },
      getGatedState: () => state,
      getPendingMessageCount: () => pendingCount,
      markPendingNotification: (_agentId: string, count: number) => {
        pendingNotificationMarks.push(count);
      },
      sendPendingNotification: (_agentId: string, count: number) => {
        pendingNotifications.push(count);
      },
      flushDaemonInbox: (_agentId: string, reason: "idle" | "turn_end") => {
        fullFlushes.push(reason);
      },
    },
    pendingNotifications,
    pendingNotificationMarks,
    fullFlushes,
  };
};

const createRuntimeAgentProcess = (writes: string[], busy = true) => ({
  proc: {
    pid: 123,
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
    },
    stdin: {
      write: (message: string) => {
        writes.push(message);
        return true;
      },
    },
  },
  sessionId: "session-1",
  workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
  launchId: "launch-1",
  runtimeProfile: "claude",
  runtimeSessionId: null,
  runtimeSessionStart: null,
  runtimeSessionUpdate: Promise.resolve(),
  runtimeSessionTerminalState: null,
  runtimeSessionUpdateQueue: new RuntimeSessionUpdateQueue(),
  turnId: null,
  busy,
  stdoutBuffer: "",
  stdoutLineQueue: Promise.resolve(),
  activity: "working" as const,
  activityLabel: "Working",
  activityDetail: "Message received",
  heartbeatTimer: null,
  messageQueue: [],
  currentDelivery: null,
  pendingText: "",
  pendingRuntimeProfileControl: null,
});

const seedRuntimeAgent = (
  manager: AgentManager,
  agentProc: ReturnType<typeof createRuntimeAgentProcess>,
) => {
  (manager as never as { sessions: Map<string, unknown>; processes: Map<string, unknown> }).sessions.set("agent-1", {
    id: "agent-1",
    name: "agent-1",
    displayName: "Agent One",
    workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
  });
  (manager as never as { sessions: Map<string, unknown>; processes: Map<string, unknown> }).processes.set("agent-1", agentProc);
};

const waitForOutcome = (promise: Promise<void>) => Promise.race([
  promise.then(() => "handled" as const),
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
]);

describe("AgentManager runtime stream boundary handling", () => {
  it("does not resurrect a stopped agent while fetching its record for delivery", async () => {
    const fetchGate = deferred();
    const writes: string[] = [];
    const supabase = {
      channel: () => ({ subscribe: () => undefined, send: () => undefined }),
      removeChannel: () => undefined,
      from: (table: string) => {
        if (table !== "agents") throw new Error(`Unexpected table: ${table}`);
        const query = {
          select: () => query,
          eq: () => query,
          is: () => query,
          single: async () => {
            await fetchGate.promise;
            return {
              data: {
                id: "agent-1",
                name: "agent-1",
                display_name: "Agent One",
                description: null,
                system_prompt: null,
                model: "opus",
                status: "online",
                archived_at: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", supabase as never, "", "");
    (manager as never as { sessions: Map<string, unknown> }).sessions.set("agent-1", {
      id: "agent-1",
      name: "agent-1",
      displayName: "Agent One",
      workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
    });
    const spawnProcess = vi.fn(async () => createRuntimeAgentProcess(writes, false));
    (manager as never as { spawnProcess: typeof spawnProcess }).spawnProcess = spawnProcess;
    (manager as never as { refreshAutonomousSkills: () => Promise<string> }).refreshAutonomousSkills = async () => "";

    const delivery = manager.sendToAgent("agent-1", "hello");
    manager.stopAgent("agent-1", "Agent archived");
    fetchGate.resolve();

    await expect(delivery).rejects.toThrow(/stopped|archived|not initialized/);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("does not cold-start a stopped agent while ensuring a runtime process", async () => {
    const fetchGate = deferred();
    const writes: string[] = [];
    const supabase = {
      channel: () => ({ subscribe: () => undefined, send: () => undefined }),
      removeChannel: () => undefined,
      from: (table: string) => {
        if (table !== "agents") throw new Error(`Unexpected table: ${table}`);
        const query = {
          select: () => query,
          eq: () => query,
          is: () => query,
          single: async () => {
            await fetchGate.promise;
            return {
              data: {
                id: "agent-1",
                name: "agent-1",
                display_name: "Agent One",
                description: null,
                system_prompt: null,
                model: "opus",
                status: "online",
                archived_at: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", supabase as never, "", "");
    (manager as never as { sessions: Map<string, unknown> }).sessions.set("agent-1", {
      id: "agent-1",
      name: "agent-1",
      displayName: "Agent One",
      workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
    });
    const spawnProcess = vi.fn(async () => createRuntimeAgentProcess(writes, false));
    (manager as never as { spawnProcess: typeof spawnProcess }).spawnProcess = spawnProcess;
    (manager as never as { refreshAutonomousSkills: () => Promise<string> }).refreshAutonomousSkills = async () => "";

    const ensured = manager.ensureRuntimeProcess("agent-1");
    manager.stopAgent("agent-1", "Agent archived");
    fetchGate.resolve();

    await expect(ensured).rejects.toThrow(/stopped|archived|not initialized/);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("queries active agent rows before cold-starting or restarting runtime processes", async () => {
    const activeFilters: string[] = [];
    const supabase = {
      channel: () => ({ subscribe: () => undefined, send: () => undefined }),
      removeChannel: () => undefined,
      from: (table: string) => {
        if (table !== "agents") throw new Error(`Unexpected table: ${table}`);
        const query = {
          select: () => query,
          eq: () => query,
          is: (column: string, value: unknown) => {
            activeFilters.push(`${column}:${String(value)}`);
            return query;
          },
          single: async () => ({
            data: {
              id: "agent-1",
              name: "agent-1",
              display_name: "Agent One",
              description: null,
              system_prompt: null,
              model: "opus",
              status: "online",
              archived_at: null,
            },
            error: null,
          }),
        };
        return query;
      },
    };
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", supabase as never, "", "");
    (manager as never as { sessions: Map<string, unknown> }).sessions.set("agent-1", {
      id: "agent-1",
      name: "agent-1",
      displayName: "Agent One",
      workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
    });
    const spawnProcess = vi.fn(async () => createRuntimeAgentProcess([], false));
    (manager as never as { spawnProcess: typeof spawnProcess }).spawnProcess = spawnProcess;
    (manager as never as { refreshAutonomousSkills: () => Promise<string> }).refreshAutonomousSkills = async () => "";

    await manager.ensureRuntimeProcess("agent-1");
    await (manager as never as { restartProcess: (agentId: string) => Promise<void> }).restartProcess("agent-1");

    expect(activeFilters).toEqual(["archived_at:null", "archived_at:null"]);
  });

  it("sends a pending notification at a safe tool boundary without a full flush", async () => {
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub() as never, "", "");
    const boundary = createBoundaryObserver(3);
    manager.configureRuntimeBoundaryObserver(boundary.observer);

    await manager.observeRuntimeStreamEvent("agent-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } });
    await manager.observeRuntimeStreamEvent("agent-1", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } });

    expect(boundary.pendingNotificationMarks).toEqual([3]);
    expect(boundary.pendingNotifications).toEqual([3]);
    expect(boundary.fullFlushes).toEqual([]);
  });

  it("flushes the daemon inbox at turn end", async () => {
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub() as never, "", "");
    const boundary = createBoundaryObserver(4);
    manager.configureRuntimeBoundaryObserver(boundary.observer);

    await manager.observeRuntimeStreamEvent("agent-1", { type: "result", subtype: "success" });

    expect(boundary.fullFlushes).toEqual(["turn_end"]);
    expect(boundary.pendingNotifications).toEqual([]);
  });

  it("ignores runtime stream boundary handling when no observer is configured", async () => {
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub() as never, "", "");

    await expect(manager.observeRuntimeStreamEvent("agent-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } })).resolves.toBeUndefined();
    await expect(manager.observeRuntimeStreamEvent("agent-1", { type: "result", subtype: "success" })).resolves.toBeUndefined();
  });

  it("ACKs runtime-profile migration only after reserved MCP action", async () => {
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub() as never, "", "");
    const agentProc = createRuntimeAgentProcess([], true);
    seedRuntimeAgent(manager, agentProc);

    (manager as never as { deliverRuntimeProfileControl: (control: { type: "agent:runtime_profile:migration"; agentId: string; key: string; requiresAck: boolean }) => void }).deliverRuntimeProfileControl({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      key: "migration-1",
      requiresAck: true,
    });
    const pendingControls = (manager as never as { pendingRuntimeProfileControls: Map<string, unknown> }).pendingRuntimeProfileControls;
    expect(pendingControls.get("agent-1")).toMatchObject({ key: "migration-1" });

    await (manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "zano message send", input: { key: "migration-1" } }] } }),
    );
    expect((manager as never as { getRuntimeProfileControlAcks: () => unknown[] }).getRuntimeProfileControlAcks()).toEqual([]);
    expect(pendingControls.get("agent-1")).toMatchObject({ key: "migration-1" });

    await (manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2", name: "runtime_profile_migration_done", input: { key: "migration-1" } }] } }),
    );

    expect((manager as never as { getRuntimeProfileControlAcks: () => unknown[] }).getRuntimeProfileControlAcks()).toEqual([{ type: "agent:runtime_profile:migration:ack", agentId: "agent-1", key: "migration-1" }]);
    expect(agentProc.pendingRuntimeProfileControl).toBeNull();
    expect(pendingControls.has("agent-1")).toBe(false);
  });

  it("releases the completed result turn before awaiting turn-end daemon delivery", async () => {
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub() as never, "", "");
    const writes: string[] = [];
    const agentProc = createRuntimeAgentProcess(writes, true);
    seedRuntimeAgent(manager, agentProc);
    let state: GatedSteeringState = createGatedSteeringState();
    let flushStartedWithBusy: boolean | null = null;
    let flushCompleted = false;

    manager.configureRuntimeBoundaryObserver({
      recordGatedEvent: (_agentId: string, event: ClaudeGatedSteeringEvent) => {
        state = recordGatedSteeringEvent(state, event);
      },
      getGatedState: () => state,
      getPendingMessageCount: () => 0,
      sendPendingNotification: () => undefined,
      flushDaemonInbox: async () => {
        flushStartedWithBusy = agentProc.busy;
        await manager.deliverRuntimeMessage("agent-1", "boundary delivery");
        flushCompleted = true;
      },
    });

    const handled = (manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "result", subtype: "success" }),
    );

    const outcome = await waitForOutcome(handled);

    if (outcome === "timeout") {
      agentProc.busy = false;
      const queued = agentProc.messageQueue.shift();
      if (queued) queued.resolve();
    }

    expect(outcome).toBe("handled");
    expect(flushStartedWithBusy).toBe(false);
    expect(flushCompleted).toBe(true);
    expect(writes).toHaveLength(1);
    expect(agentProc.busy).toBe(true);
  });

  it("does not broadcast idle or drain ordinary queue when turn-end flush starts a new turn", async () => {
    const activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string }> = [];
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub(activityPayloads) as never, "", "");
    const writes: string[] = [];
    const agentProc = createRuntimeAgentProcess(writes, true);
    agentProc.messageQueue.push({ userMessage: "ordinary queued delivery", scope: {}, resolve: () => undefined, reject: () => undefined });
    seedRuntimeAgent(manager, agentProc);
    let state: GatedSteeringState = createGatedSteeringState();

    manager.configureRuntimeBoundaryObserver({
      recordGatedEvent: (_agentId: string, event: ClaudeGatedSteeringEvent) => {
        state = recordGatedSteeringEvent(state, event);
      },
      getGatedState: () => state,
      getPendingMessageCount: () => 0,
      sendPendingNotification: () => undefined,
      flushDaemonInbox: async () => {
        await manager.deliverRuntimeMessage("agent-1", "boundary delivery");
      },
    });

    const handled = (manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "result", subtype: "success" }),
    );

    const outcome = await waitForOutcome(handled);

    if (outcome === "timeout") {
      agentProc.busy = false;
      const queued = agentProc.messageQueue.shift();
      if (queued) queued.resolve();
    }

    expect(outcome).toBe("handled");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("boundary delivery");
    expect(agentProc.messageQueue.map((message) => message.userMessage)).toEqual(["ordinary queued delivery"]);
    expect(agentProc.busy).toBe(true);
    expect(activityPayloads.some((payload) => payload.activity === "idle")).toBe(false);
    expect(activityPayloads.at(-1)).toMatchObject({ activity: "working", label: "Working", detail: "Message received" });
  });

  it("records resolved runtime session refs when Claude initializes a session", async () => {
    const rootDir = "/tmp/zano-agent-manager-runtime-session-ref-test";
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
    const patches: Record<string, unknown>[] = [];
    const manager = new AgentManager(rootDir, createSupabaseStub() as never, "", "");
    const writes: string[] = [];
    const agentProc = createRuntimeAgentProcess(writes, true);
    agentProc.runtimeSessionId = "runtime-1";
    agentProc.launchId = "launch-1";
    agentProc.workDir = join(rootDir, "agent-1");
    seedRuntimeAgent(manager, agentProc);
    manager.configureDaemonRuntime(
      {
        workspaceId: "workspace-1",
        workspaceName: "Workspace One",
        machineId: "machine-1",
        hostname: "host-1",
        platform: "darwin",
        arch: "arm64",
        bridgeVersion: "test",
      },
      {
        updateState: async (_id: string, _state: RuntimeSessionState, patch: Record<string, unknown>) => {
          patches.push(patch);
          return {} as never;
        },
      } as never,
    );

    await (manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-ref-1" }),
    );
    await agentProc.runtimeSessionUpdate;

    expect(patches.at(-1)).toMatchObject({
      sessionId: "claude-session-ref-1",
      sessionRefReachable: false,
      workspacePathRef: join(rootDir, "agent-1"),
      runtimeProfile: "claude",
    });
    expect(patches.at(-1)?.sessionRef).toBe(join(rootDir, "agent-1", ".zano", "runtime-sessions", "claude-launch-launch-1.jsonl"));
  });

  it("drains queued messages when session-ref fallback writing fails at turn completion", async () => {
    const rootDir = "/tmp/zano-agent-manager-runtime-session-ref-failure-test";
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(rootDir, { recursive: true });
    const blockedWorkDir = join(rootDir, "agent-1-file");
    writeFileSync(blockedWorkDir, "not a directory");
    const patches: Record<string, unknown>[] = [];
    const manager = new AgentManager(rootDir, createSupabaseStub() as never, "", "");
    const writes: string[] = [];
    const agentProc = createRuntimeAgentProcess(writes, true);
    agentProc.runtimeSessionId = "runtime-1";
    agentProc.sessionId = "claude-session-ref-1";
    agentProc.launchId = "launch-1";
    agentProc.workDir = blockedWorkDir;
    agentProc.messageQueue.push({ userMessage: "ordinary queued delivery", scope: {}, resolve: () => undefined, reject: () => undefined });
    seedRuntimeAgent(manager, agentProc);
    manager.configureDaemonRuntime(
      {
        workspaceId: "workspace-1",
        workspaceName: "Workspace One",
        machineId: "machine-1",
        hostname: "host-1",
        platform: "darwin",
        arch: "arm64",
        bridgeVersion: "test",
      },
      {
        updateState: async (_id: string, _state: RuntimeSessionState, patch: Record<string, unknown>) => {
          patches.push(patch);
          return {} as never;
        },
      } as never,
    );

    await expect((manager as never as { handleStreamEvent: (agentId: string, agentProc: typeof agentProc, line: string) => Promise<void> }).handleStreamEvent(
      "agent-1",
      agentProc,
      JSON.stringify({ type: "result", subtype: "success" }),
    )).resolves.toBeUndefined();
    await agentProc.runtimeSessionUpdate;

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("ordinary queued delivery");
    expect(agentProc.messageQueue).toEqual([]);
    expect(patches).toContainEqual(expect.objectContaining({
      sessionId: "claude-session-ref-1",
      sessionRef: null,
      sessionRefReachable: false,
      workspacePathRef: blockedWorkDir,
      runtimeProfile: "claude",
    }));
  });

  it("redacts activity details before broadcasting", () => {
    const activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string }> = [];
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub(activityPayloads) as never, "", "");

    (manager as never as { broadcastActivity: (agentId: string, activity: "working", label: string, detail: string) => void }).broadcastActivity(
      "agent-1",
      "working",
      "Running command",
      "Authorization: Bearer fake-activity-secret",
    );

    expect(activityPayloads[0].detail).toBe("Authorization: Bearer [REDACTED]");
    expect(activityPayloads[0].detail).not.toContain("fake-activity-secret");
  });

  it("broadcasts activity with the current delivery channel scope", async () => {
    const activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string; channelId?: string | null; sourceMessageId?: string | null; taskId?: string | null }> = [];
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub(activityPayloads) as never, "", "");
    seedRuntimeAgent(manager, createRuntimeAgentProcess([]));

    await manager.setCurrentDelivery("agent-1", {
      deliveryId: "delivery-1",
      deliverySeq: 1,
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      target: "#general",
      channelId: "channel-1",
      sourceMessageId: "message-1",
      threadParentId: null,
      taskId: "task-1",
      messageCreatedAt: "2026-05-28T00:00:00.000Z",
    });
    (manager as never as { broadcastActivity: (agentId: string, activity: "working", label: string, detail: string) => void }).broadcastActivity(
      "agent-1",
      "working",
      "Working",
      "Message received",
    );

    expect(activityPayloads[0]).toMatchObject({
      agentId: "agent-1",
      channelId: "channel-1",
      sourceMessageId: "message-1",
      taskId: "task-1",
    });
  });

  it("reports gated runtime backlog as live working activity", () => {
    const activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string }> = [];
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub(activityPayloads) as never, "", "");
    seedRuntimeAgent(manager, createRuntimeAgentProcess([]));

    manager.reportRuntimeBacklog("agent-1", 3);

    expect(activityPayloads[0]).toMatchObject({
      agentId: "agent-1",
      activity: "working",
      label: "Waiting for safe runtime boundary",
      detail: "3 queued messages",
    });
  });

  it("persists gated runtime backlog as working activity instead of tool use", async () => {
    const activityRows: Record<string, unknown>[] = [];
    const supabase = {
      channel: () => ({ subscribe: () => undefined, send: () => undefined }),
      removeChannel: () => undefined,
      from: (table: string) => {
        if (table !== "member_activity_events") throw new Error(`Unexpected table: ${table}`);
        return {
          insert: async (row: Record<string, unknown>) => {
            activityRows.push(row);
            return { error: null };
          },
        };
      },
    };
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", supabase as never, "", "");
    seedRuntimeAgent(manager, createRuntimeAgentProcess([]));
    const session = (manager as never as { sessions: Map<string, { serverId?: string }> }).sessions.get("agent-1");
    if (session) session.serverId = "server-1";

    manager.reportRuntimeBacklog("agent-1", 3);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(activityRows[0]).toMatchObject({
      server_id: "server-1",
      actor_id: "agent-1",
      actor_type: "agent",
      event_type: "agent.working",
      label: "Waiting for safe runtime boundary",
      summary: "3 queued messages",
    });
    expect(activityRows[0]?.event_type).not.toBe("agent.tool_use");
  });

  it("does not broadcast assistant text output as live thinking activity", () => {
    const activityPayloads: Array<{ agentId: string; activity: string; label: string; detail: string }> = [];
    const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", createSupabaseStub(activityPayloads) as never, "", "");
    const agentProc = createRuntimeAgentProcess([]);
    agentProc.pendingText = "Visible channel reply draft";
    seedRuntimeAgent(manager, agentProc);

    (manager as never as { flushPendingText: (agentId: string, agentProc: typeof agentProc) => void }).flushPendingText("agent-1", agentProc);

    expect(activityPayloads).toEqual([]);
    expect(agentProc.pendingText).toBe("");
  });

  it("redacts autonomous evidence summaries before persisting", async () => {
    const previousEvidenceFlag = process.env.ZANO_ENABLE_AUTONOMOUS_EVIDENCE;
    process.env.ZANO_ENABLE_AUTONOMOUS_EVIDENCE = "1";
    const agentTurns: Record<string, any>[] = [];
    const toolEvents: Record<string, any>[] = [];

    const supabase = {
      channel: () => ({ subscribe: () => undefined, send: () => undefined }),
      removeChannel: () => undefined,
      from: (table: string) => {
        if (table === "agent_turns") {
          return {
            insert: (row: Record<string, any>) => {
              agentTurns.push(row);
              return { select: () => ({ single: async () => ({ data: { id: "turn-1" }, error: null }) }) };
            },
          };
        }
        if (table === "agent_tool_events") {
          return {
            insert: async (row: Record<string, any>) => {
              toolEvents.push(row);
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };

    try {
      const manager = new AgentManager("/tmp/zano-agent-manager-runtime-session-test", supabase as never, "", "");
      const agentProc = createRuntimeAgentProcess([], false);
      const session = {
        id: "agent-1",
        name: "agent-1",
        displayName: "Agent One",
        workDir: "/tmp/zano-agent-manager-runtime-session-test/agent-1",
        serverId: "server-1",
      };
      (manager as never as { sessions: Map<string, unknown> }).sessions.set("agent-1", session);

      await (manager as never as {
        beginAutonomousTurn: (agentId: string, agentProc: typeof agentProc, session: typeof session, userMessage: string) => Promise<void>;
        recordAutonomousToolEvent: (agentId: string, agentProc: typeof agentProc, toolName: string, inputSummary: string) => Promise<void>;
      }).beginAutonomousTurn("agent-1", agentProc, session, "please use access_token=fake-bridge-secret");
      await (manager as never as {
        recordAutonomousToolEvent: (agentId: string, agentProc: typeof agentProc, toolName: string, inputSummary: string) => Promise<void>;
      }).recordAutonomousToolEvent("agent-1", agentProc, "Bash", "Authorization: Bearer fake-tool-secret");

      expect(agentTurns[0].activation_reason.input_preview).toContain("access_token=[REDACTED]");
      expect(agentTurns[0].activation_reason.input_preview).not.toContain("fake-bridge-secret");
      expect(toolEvents[0].input_summary).toContain("Authorization: Bearer [REDACTED]");
      expect(toolEvents[0].input_summary).not.toContain("fake-tool-secret");
    } finally {
      if (previousEvidenceFlag === undefined) delete process.env.ZANO_ENABLE_AUTONOMOUS_EVIDENCE;
      else process.env.ZANO_ENABLE_AUTONOMOUS_EVIDENCE = previousEvidenceFlag;
    }
  });
});

describe("RuntimeSessionUpdateQueue", () => {
  it("serializes updates and prevents non-terminal regression after failed is queued", async () => {
    const applied: RuntimeSessionState[] = [];
    const busyGate = deferred();
    const queue = new RuntimeSessionUpdateQueue();

    const busyUpdate = queue.enqueue("busy", async () => {
      await busyGate.promise;
      applied.push("busy");
    });
    const failedUpdate = queue.enqueue("failed", async () => {
      applied.push("failed");
    });
    const idleUpdate = queue.enqueue("idle", async () => {
      applied.push("idle");
    });

    await Promise.resolve();
    expect(applied).toEqual([]);

    busyGate.resolve();
    await Promise.all([busyUpdate, failedUpdate, idleUpdate]);

    expect(applied).toEqual(["busy", "failed"]);
    expect(applied.at(-1)).toBe("failed");
  });

  it("keeps failed terminal state when ended is queued later", async () => {
    const applied: RuntimeSessionState[] = [];
    const queue = new RuntimeSessionUpdateQueue();

    await Promise.all([
      queue.enqueue("failed", async () => {
        applied.push("failed");
      }),
      queue.enqueue("ended", async () => {
        applied.push("ended");
      }),
    ]);

    expect(applied).toEqual(["failed"]);
  });
});
