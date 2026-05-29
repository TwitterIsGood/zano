import { describe, expect, it, vi } from "vitest";

const supabaseMockState = vi.hoisted(() => {
  class OmniFakeSupabaseTable {
    private operation: "select" | "insert" | "update" = "select";
    private filters: Array<{ column: string; value: unknown; operator: "eq" | "in" | "is" | "gte" }> = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private rowLimit: number | null = null;
    private insertRows: Record<string, unknown>[] = [];
    private updatePatch: Record<string, unknown> | null = null;

    constructor(private readonly rows: Record<string, unknown>[], private readonly error: { message: string } | null = null) {}

    select() { return this; }
    insert(row: Record<string, unknown> | Record<string, unknown>[]) {
      this.operation = "insert";
      this.insertRows = Array.isArray(row) ? row : [row];
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.operation = "update";
      this.updatePatch = patch;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push({ column, value, operator: "eq" });
      return this;
    }
    in(column: string, value: unknown[]) {
      this.filters.push({ column, value, operator: "in" });
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push({ column, value, operator: "is" });
      return this;
    }
    gte(column: string, value: unknown) {
      this.filters.push({ column, value, operator: "gte" });
      return this;
    }
    order(column: string, options: { ascending?: boolean } = {}) {
      this.orderBy = { column, ascending: options.ascending ?? true };
      return this;
    }
    limit(limit: number) {
      this.rowLimit = limit;
      return this;
    }
    async maybeSingle() {
      if (this.error) return { data: null, error: this.error };
      return { data: this.applySelect()[0] ?? null, error: null };
    }
    async single() {
      if (this.error) return { data: null, error: this.error };
      if (this.operation === "insert") {
        const row = {
          id: `fake-row-${this.rows.length + 1}`,
          created_at: "2026-05-22T00:00:00.000Z",
          ...this.insertRows[0],
        };
        this.rows.push(row);
        return { data: row, error: null };
      }
      if (this.operation === "update") {
        const row = this.applySelect()[0];
        if (!row) return { data: null, error: { message: "not found" } };
        Object.assign(row, this.updatePatch);
        return { data: row, error: null };
      }
      return { data: this.applySelect()[0] ?? null, error: null };
    }
    then(resolve: (value: { data: Record<string, unknown>[]; error: { message: string } | null }) => void, reject: (error: unknown) => void) {
      Promise.resolve(this.error ? { data: [], error: this.error } : { data: this.applySelect(), error: null }).then(resolve, reject);
    }
    private applySelect() {
      let result = this.rows.filter((row) => this.filters.every((filter) => {
        if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
        if (filter.operator === "is") return row[filter.column] === filter.value;
        if (filter.operator === "gte") return String(row[filter.column] ?? "") >= String(filter.value ?? "");
        return row[filter.column] === filter.value;
      }));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        result = [...result].sort((a, b) => {
          const av = a[column] as string | number;
          const bv = b[column] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (this.rowLimit !== null) result = result.slice(0, this.rowLimit);
      return result;
    }
  }

  class OmniFakeSupabaseClient {
    readonly deliveries: Record<string, unknown>[] = [];
    readonly traceEvents: Record<string, unknown>[] = [];
    readonly messages: Record<string, unknown>[] = [];
    readonly channelMembers: Record<string, unknown>[] = [];
    readonly channels: Record<string, unknown>[] = [];
    readonly agents: Record<string, unknown>[] = [];
    readonly tableErrors = new Map<string, { message: string }>();
    readonly sends: Array<{ channel: string; message: Record<string, unknown> }> = [];
    readonly realtime = { setAuth: () => undefined };
    readonly removeAllChannels = async () => undefined;
    readonly removeChannel = () => undefined;
    channel(name: string) {
      const client = this;
      return {
        on() { return this; },
        subscribe(callback?: (status: string) => void) {
          callback?.("SUBSCRIBED");
          return this;
        },
        track: async () => undefined,
        send: async (message: Record<string, unknown>) => {
          client.sends.push({ channel: name, message });
          return "ok";
        },
      };
    }
    from(table: string) {
      const error = this.tableErrors.get(table) ?? null;
      if (table === "daemon_deliveries") return new OmniFakeSupabaseTable(this.deliveries, error);
      if (table === "daemon_trace_events") return new OmniFakeSupabaseTable(this.traceEvents, error);
      if (table === "messages") return new OmniFakeSupabaseTable(this.messages, error);
      if (table === "channel_members") return new OmniFakeSupabaseTable(this.channelMembers, error);
      if (table === "channels") return new OmniFakeSupabaseTable(this.channels, error);
      if (table === "agents") return new OmniFakeSupabaseTable(this.agents, error);
      return new OmniFakeSupabaseTable([], error);
    }
  }

  return { clients: [] as OmniFakeSupabaseClient[], OmniFakeSupabaseClient };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    const client = new supabaseMockState.OmniFakeSupabaseClient();
    supabaseMockState.clients.push(client);
    return client;
  }),
}));

import { AgentSupervisor, DeliveryLedger, DeliveryRuntime, InMemoryDeliveryLedgerStore, StartCoordinator } from "./runtime/index.js";
import { Omni, buildRuntimeDeliveryInput, type DbMessage, type RoutingDelivery } from "./omni.js";

const msg: DbMessage = {
  id: "msg-1",
  channel_id: "channel-1",
  sender_id: "human-1",
  sender_type: "human",
  content: "continue",
  thread_parent_id: null,
  created_at: "2026-05-22T00:00:00.000Z",
};

function makeDelivery(reasons: RoutingDelivery["candidate"]["reasons"] = ["channel_broadcast"]): RoutingDelivery {
  return makeDeliveryForAgent("agent-1", "Alpha", reasons);
}

function makeDeliveryForAgent(agentId: string, displayName: string, reasons: RoutingDelivery["candidate"]["reasons"] = ["channel_broadcast"]): RoutingDelivery {
  return {
    candidate: { agentId, strength: "medium", reasons },
    agent: { id: agentId, name: displayName.toLowerCase(), display_name: displayName, description: null, system_prompt: null, model: "opus", status: "online" },
    prompt: "[target=#general msg=msg1 time=2026-05-22T00:00:00.000Z sender=@Human type=human] continue",
  };
}

function makeBridge(overrides: Record<string, unknown> = {}) {
  const agentManager = {
    sendToAgent: vi.fn(),
    initAgent: vi.fn(),
    getRuntimeAgentState: vi.fn(),
    stopAgent: vi.fn(),
    purgeCredentialsForInactiveAgents: vi.fn(),
    ...((overrides.agentManager as Record<string, unknown> | undefined) ?? {}),
  };

  return Object.assign(Object.create(Omni.prototype), {
    config: { serverId: "server-1" },
    supabase: new supabaseMockState.OmniFakeSupabaseClient(),
    agentManager,
    channelAgents: new Map(),
    channelTypes: new Map(),
    channelNames: new Map(),
    agentRecords: new Map(),
    processedMessageIds: new Set(),
    processingMessageIds: new Set(),
    pendingMessageRetries: new Map(),
    scheduledMessageRetries: new Map(),
    deliveredMessageAgentIds: new Map(),
    channelsWithMissingAgentCredentials: new Set(),
    activationCooldowns: new Map(),
    topicHopCounts: new Map(),
    deliveryRuntime: null,
    runtimeSupervisor: null,
    ...overrides,
    agentManager,
  }) as Omni & Record<string, any>;
}

describe("buildRuntimeDeliveryInput", () => {
  it("converts routing deliveries to runtime inputs", () => {
    const result = buildRuntimeDeliveryInput({
      workspaceId: "server-1",
      msg,
      delivery: makeDelivery(),
      target: "#general",
      taskId: null,
    });

    expect(result).toMatchObject({
      workspaceId: "server-1",
      agentId: "agent-1",
      channelId: "channel-1",
      sourceMessageId: "msg-1",
      threadParentId: null,
      taskId: null,
      target: "#general",
      activationReasons: ["channel_broadcast"],
      activationStrength: "medium",
      prompt: "[target=#general msg=msg1 time=2026-05-22T00:00:00.000Z sender=@Human type=human] continue",
      sourceCreatedAt: "2026-05-22T00:00:00.000Z",
      senderId: "human-1",
      senderType: "human",
    });
  });

  it("includes task context and clones activation reasons", () => {
    const reasons: RoutingDelivery["candidate"]["reasons"] = ["direct_mention"];
    const result = buildRuntimeDeliveryInput({
      workspaceId: "server-1",
      msg,
      delivery: makeDelivery(reasons),
      target: "#task-42",
      taskId: "task-1",
    });

    reasons.push("channel_broadcast");

    expect(result.taskId).toBe("task-1");
    expect(result.target).toBe("#task-42");
    expect(result.activationReasons).toEqual(["direct_mention"]);
  });
});

describe("Omni runtime routing", () => {
  it("uses raw channel ids for DM delivery targets", () => {
    const bridge = makeBridge({
      channelTypes: new Map([["dm-channel-1", "dm"]]),
      channelNames: new Map([["dm-channel-1", "QA 工程师"]]),
    });

    expect(bridge.buildChannelTarget("dm-channel-1", "E2E Probe", null)).toBe("dm-channel-1");
    expect(bridge.buildChannelTarget("dm-channel-1", "E2E Probe", "thread-parent-1234567890")).toBe("dm-channel-1:threadpa");
  });

  it("builds selected delivery prompts with canonical bounded thread join context", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.messages.push(
      { id: "thread-parent-1234567890", channel_id: "channel-1", sender_id: "human-1", sender_type: "human", content: "Parent problem statement", thread_parent_id: null, created_at: "2026-05-23T10:00:00.000Z" },
      { id: "thread-recent-1", channel_id: "channel-1", sender_id: "agent-2", sender_type: "agent", content: "Prior analysis", thread_parent_id: "thread-parent-1234567890", created_at: "2026-05-23T10:05:00.000Z" },
      { id: "msg-thread-latest", channel_id: "channel-1", sender_id: "human-1", sender_type: "human", content: "@Alpha please continue", thread_parent_id: "thread-parent-1234567890", created_at: "2026-05-23T10:10:00.000Z" },
    );
    const bridge = makeBridge({
      supabase,
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["agent-1", "agent-2"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: "Reviews direct asks", system_prompt: null, model: "opus", status: "online" }],
        ["agent-2", { id: "agent-2", name: "beta", display_name: "Beta", description: "Observes", system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    const plan = await bridge.buildRoutingPlan({
      id: "msg-thread-latest",
      channel_id: "channel-1",
      sender_id: "human-1",
      sender_type: "human",
      content: "@Alpha please continue",
      thread_parent_id: "thread-parent-1234567890",
      created_at: "2026-05-23T10:10:00.000Z",
    }, new Set(["agent-1", "agent-2"]));

    const alphaDelivery = plan?.deliveries.find((delivery) => delivery.agent.id === "agent-1");

    expect(alphaDelivery).toBeDefined();
    expect(plan?.target).toBe("#general:threadpa");
    expect(alphaDelivery?.prompt).toContain("Thread join context");
    expect(alphaDelivery?.prompt).toContain("threadTarget=#general:threadpa");
    expect(alphaDelivery?.prompt).toContain("suggestedReadTarget=#general:threadpa");
    expect(alphaDelivery?.prompt).toContain("Parent problem statement");
    expect(alphaDelivery?.prompt).toContain("Prior analysis");
  });

  it("omits thread join context when parent facts do not match the message thread", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.messages.push(
      { id: "thread-parent-1234567890", channel_id: "other-channel", sender_id: "human-1", sender_type: "human", content: "Wrong channel parent", thread_parent_id: null, created_at: "2026-05-23T10:00:00.000Z" },
      { id: "msg-thread-latest", channel_id: "channel-1", sender_id: "human-1", sender_type: "human", content: "@Alpha please continue", thread_parent_id: "thread-parent-1234567890", created_at: "2026-05-23T10:10:00.000Z" },
    );
    const bridge = makeBridge({
      supabase,
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["agent-1"])]]),
      agentRecords: new Map([["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: "Reviews direct asks", system_prompt: null, model: "opus", status: "online" }]]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    const plan = await bridge.buildRoutingPlan({
      id: "msg-thread-latest",
      channel_id: "channel-1",
      sender_id: "human-1",
      sender_type: "human",
      content: "@Alpha please continue",
      thread_parent_id: "thread-parent-1234567890",
      created_at: "2026-05-23T10:10:00.000Z",
    }, new Set(["agent-1"]));

    expect(plan?.deliveries).toHaveLength(1);
    expect(plan?.deliveries[0].prompt).not.toContain("Thread join context");
    expect(plan?.deliveries[0].prompt).not.toContain("Wrong channel parent");
  });

  it("does not load agents from other servers at Omni startup", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.agents.push(
      { id: "agent-active", name: "active", display_name: "Active", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null },
      { id: "agent-other-server", name: "other", display_name: "Other", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "other-server", archived_at: null },
    );
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-active": "agent-token" } },
      agentRecords: new Map(),
    });

    await bridge.loadAgents();

    expect(bridge.agentRecords.has("agent-active")).toBe(true);
    expect(bridge.agentRecords.has("agent-other-server")).toBe(false);
  });

  it("does not load tokenless agents at Omni startup", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.agents.push(
      { id: "agent-tokened", name: "tokened", display_name: "Tokened", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null },
      { id: "agent-tokenless", name: "tokenless", display_name: "Tokenless", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null },
    );
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-tokened": "agent-token" } },
      agentRecords: new Map(),
    });

    await bridge.loadAgents();

    expect(bridge.agentRecords.has("agent-tokened")).toBe(true);
    expect(bridge.agentRecords.has("agent-tokenless")).toBe(false);
  });

  it("does not load archived agents at Omni startup", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.agents.push(
      { id: "agent-active", name: "active", display_name: "Active", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null },
      { id: "agent-archived", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: "2026-05-26T12:00:00.000Z" },
    );
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-active": "agent-token" } },
      agentRecords: new Map(),
    });

    await bridge.loadAgents();

    expect(bridge.agentRecords.has("agent-active")).toBe(true);
    expect(bridge.agentRecords.has("agent-archived")).toBe(false);
  });

  it("purges credentials for agents not loaded at Omni startup", async () => {
    const purgeCredentialsForInactiveAgents = vi.fn();
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.agents.push(
      { id: "agent-active", name: "active", display_name: "Active", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null },
      { id: "agent-archived", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: "2026-05-26T12:00:00.000Z" },
    );
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-active": "active-token", "agent-archived": "archived-token" } },
      agentManager: { purgeCredentialsForInactiveAgents },
      agentRecords: new Map(),
    });

    await bridge.loadAgents();

    expect(purgeCredentialsForInactiveAgents).toHaveBeenCalledWith(["agent-active"]);
  });

  it("prunes archived agents from routing state when realtime archive updates arrive", async () => {
    const transition = vi.fn().mockResolvedValue({});
    const bridge = makeBridge({
      channelAgents: new Map([
        ["channel-1", new Set(["agent-active", "agent-archived"])],
        ["channel-2", new Set(["agent-archived"])],
        ["child-dm", new Set(["agent-active", "agent-archived"])],
      ]),
      channelTypes: new Map([["child-dm", "dm"]]),
      channelNames: new Map([["child-dm", "dm-agent-archived"]]),
      agentRecords: new Map([
        ["agent-active", { id: "agent-active", name: "active", display_name: "Active", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["agent-archived", { id: "agent-archived", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      runtimeSupervisor: { drainInbox: vi.fn(() => ["delivery-1", "delivery-2"]), markStale: vi.fn() },
      deliveryRuntime: { ledger: { transition } },
      updatePresence: vi.fn(),
    });

    bridge.pruneArchivedAgent("agent-archived");

    expect(bridge.agentManager.stopAgent).toHaveBeenCalledWith("agent-archived", "Agent archived");
    expect(bridge.runtimeSupervisor.drainInbox).toHaveBeenCalledWith("agent-archived");
    await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
    expect(transition).toHaveBeenCalledWith("delivery-1", "cancelled", expect.objectContaining({ runtimeOutcome: "agent_archived" }));
    expect(transition).toHaveBeenCalledWith("delivery-2", "cancelled", expect.objectContaining({ runtimeOutcome: "agent_archived" }));
    expect(bridge.runtimeSupervisor.markStale).toHaveBeenCalledWith("agent-archived");
    expect(bridge.agentRecords.has("agent-active")).toBe(true);
    expect(bridge.agentRecords.has("agent-archived")).toBe(false);
    expect(bridge.channelAgents.get("channel-1")).toEqual(new Set(["agent-active"]));
    expect(bridge.channelAgents.has("channel-2")).toBe(false);
    expect(bridge.channelAgents.has("child-dm")).toBe(false);
    expect(bridge.updatePresence).toHaveBeenCalledOnce();
  });

  it("prunes archived child DM routing even when the archived child was not loaded", async () => {
    const bridge = makeBridge({
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      channelTypes: new Map([["child-dm", "dm"]]),
      channelNames: new Map([["child-dm", "dm-child-agent"]]),
      channelsWithMissingAgentCredentials: new Set(["child-dm"]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      updatePresence: vi.fn(),
    });

    bridge.pruneArchivedAgent("child-agent");

    expect(bridge.agentManager.stopAgent).not.toHaveBeenCalled();
    expect(bridge.channelAgents.has("child-dm")).toBe(false);
    expect(bridge.channelsWithMissingAgentCredentials.has("child-dm")).toBe(false);
    expect(bridge.updatePresence).toHaveBeenCalledOnce();
  });

  it("routes child DMs only to the canonical target agent", async () => {
    const bridge = makeBridge({
      channelTypes: new Map([["child-dm", "dm"]]),
      channelNames: new Map([["child-dm", "dm-child-agent"]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["child-agent", { id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      formatRoutingLog: vi.fn(),
    });

    const plan = await bridge.buildRoutingPlan({
      ...msg,
      id: "msg-child-dm-target",
      channel_id: "child-dm",
      content: "Please inspect this independently.",
    }, new Set(["parent-agent", "child-agent"]));

    expect(plan?.deliveries.map((delivery) => delivery.candidate.agentId)).toEqual(["child-agent"]);
    expect(plan?.deliveries[0].candidate.reasons).toContain("dm_recipient");
  });

  it("keeps active child DMs retryable at startup when the child token is missing", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
      { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "child-dm", name: "dm-child-agent", type: "dm" });
    supabase.agents.push({ id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" } },
      channelAgents: new Map(),
      channelTypes: new Map(),
      channelNames: new Map(),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
    });

    await bridge.loadChannelMemberships();

    expect(bridge.channelAgents.get("child-dm")).toEqual(new Set(["parent-agent"]));
    expect(bridge.channelsWithMissingAgentCredentials.has("child-dm")).toBe(true);
    expect(bridge.agentRecords.has("child-agent")).toBe(false);
  });

  it("prunes agents omitted from refreshed agent tokens", async () => {
    const updateSupabaseClient = vi.fn();
    const stopAgent = vi.fn();
    const transition = vi.fn().mockResolvedValue({});
    const bridge = makeBridge({
      config: {
        supabaseUrl: "https://supabase.example.test",
        supabaseKey: "fake-anon-key",
        authToken: "old-omni-token",
        serverId: "server-1",
        agentAuthTokens: { "agent-current": "old-current-token", "agent-stale": "old-stale-token" },
      },
      agentManager: { updateSupabaseClient, stopAgent },
      runtimeSupervisor: { drainInbox: vi.fn(() => ["stale-delivery"]), markStale: vi.fn() },
      deliveryRuntime: { ledger: { transition } },
      channelAgents: new Map([
        ["channel-1", new Set(["agent-current", "agent-stale"])],
        ["channel-2", new Set(["agent-stale"])],
      ]),
      agentRecords: new Map([
        ["agent-current", { id: "agent-current", name: "current", display_name: "Current", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["agent-stale", { id: "agent-stale", name: "stale", display_name: "Stale", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      configureDeliveryRuntime: vi.fn(),
      subscribeToMessages: vi.fn(),
      subscribeToNewAgents: vi.fn(),
      subscribeToSpawnRequests: vi.fn(),
      subscribeToWorkspaceRpc: vi.fn(),
      trackPresence: vi.fn(),
      startReminderScheduler: vi.fn(),
    });

    await bridge.updateAuthToken("fresh-omni-token", { "agent-current": "fresh-current-token" });

    expect(bridge.config.agentAuthTokens).toEqual({ "agent-current": "fresh-current-token" });
    expect(bridge.agentRecords.has("agent-current")).toBe(true);
    expect(bridge.agentRecords.has("agent-stale")).toBe(false);
    expect(bridge.channelAgents.get("channel-1")).toEqual(new Set(["agent-current"]));
    expect(bridge.channelAgents.has("channel-2")).toBe(false);
    expect(stopAgent).toHaveBeenCalledWith("agent-stale", "Agent credentials removed");
    expect(bridge.runtimeSupervisor.drainInbox).toHaveBeenCalledWith("agent-stale");
    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith("stale-delivery", "cancelled", expect.objectContaining({ runtimeOutcome: "agent_token_removed" })));
    expect(bridge.runtimeSupervisor.markStale).toHaveBeenCalledWith("agent-stale");
    expect(updateSupabaseClient).toHaveBeenCalledWith(expect.anything(), "fresh-omni-token", { "agent-current": "fresh-current-token" });
  });

  it("does not route to agents that were archived while Omni missed realtime", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push({ channel_id: "channel-1", member_id: "agent-archived", member_type: "agent" });
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    supabase.agents.push({ id: "agent-archived", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "online", owner_id: "user-1", server_id: "server-1", archived_at: "2026-05-26T12:00:00.000Z" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-archived": "archived-token" } },
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["agent-archived"])]]),
      agentRecords: new Map([
        ["agent-archived", { id: "agent-archived", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "online", archived_at: null }],
      ]),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-missed-archive", content: "is anyone active?" });

    expect(bridge.agentManager.sendToAgent).not.toHaveBeenCalled();
    expect(bridge.agentRecords.has("agent-archived")).toBe(false);
    expect(bridge.channelAgents.has("channel-1")).toBe(false);
  });

  it("does not keep existing tokenless agents after channel membership refresh", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-current", member_type: "agent" },
      { channel_id: "channel-1", member_id: "agent-stale", member_type: "agent" },
    );
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-current": "current-token" } },
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["agent-current", "agent-stale"])]]),
      agentRecords: new Map([
        ["agent-current", { id: "agent-current", name: "current", display_name: "Current", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["agent-stale", { id: "agent-stale", name: "stale", display_name: "Stale", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-tokenless-stale-membership", content: "roundtable please" });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-current", expect.stringContaining("roundtable please"));
    expect(bridge.agentManager.sendToAgent).not.toHaveBeenCalledWith("agent-stale", expect.any(String));
    expect(bridge.channelAgents.get("channel-1")).toEqual(new Set(["agent-current"]));
    expect(bridge.channelsWithMissingAgentCredentials.has("channel-1")).toBe(false);
  });

  it("replaces stale agent tokens during dynamic credential refresh", async () => {
    const refreshCredentials = vi.fn().mockResolvedValue({ token: "fresh-omni-token", agentAuthTokens: { "child-agent": "child-agent-token" } });
    const setAuth = vi.fn();
    const updateAgentAuthTokens = vi.fn();
    const bridge = makeBridge({
      supabase: { realtime: { setAuth } },
      agentManager: { updateAgentAuthTokens },
      config: {
        serverId: "server-1",
        refreshCredentials,
        agentAuthTokens: { "agent-stale": "stale-token" },
      },
    });

    await bridge.refreshCredentialsForAgents(["child-agent"]);

    expect(bridge.config.agentAuthTokens).toEqual({ "child-agent": "child-agent-token" });
    expect(setAuth).toHaveBeenCalledWith("fresh-omni-token");
    expect(updateAgentAuthTokens).toHaveBeenCalledWith({ "child-agent": "child-agent-token" });
  });

  it("hydrates newly created child agents before routing their first DM task", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
      { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "child-dm", name: "dm-child-agent", type: "dm" });
    supabase.agents.push({ id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null });
    const agentManager = { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() };
    const refreshCredentials = vi.fn().mockResolvedValue({ token: "fresh-omni-token", agentAuthTokens: { "child-agent": "child-agent-token" } });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" }, refreshCredentials },
      agentManager,
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({
      id: "first-task-message",
      channel_id: "child-dm",
      sender_id: "parent-agent",
      sender_type: "agent",
      content: "Please inspect this independently and report evidence.",
      thread_parent_id: null,
      created_at: "2026-05-26T12:00:00.000Z",
    });

    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(agentManager.updateAgentAuthTokens).toHaveBeenCalledWith(expect.objectContaining({ "child-agent": "child-agent-token" }));
    expect(agentManager.initAgent).toHaveBeenCalledWith("child-agent", expect.objectContaining({ display_name: "Child" }));
    expect(agentManager.sendToAgent).toHaveBeenCalledWith("child-agent", expect.stringContaining("Please inspect this independently"));
    expect(bridge.agentRecords.has("child-agent")).toBe(true);
    expect(bridge.processedMessageIds.has("first-task-message")).toBe(true);
  });

  it("refreshes credentials before initializing newly inserted child agents", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const agentManager = { initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() };
    const refreshCredentials = vi.fn().mockResolvedValue({ token: "fresh-omni-token", agentAuthTokens: { "child-agent": "child-agent-token" } });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: {}, refreshCredentials },
      agentManager,
      agentRecords: new Map(),
      updatePresence: vi.fn(),
    });

    await bridge.initializeNewAgentRecord({
      id: "child-agent",
      name: "child",
      display_name: "Child",
      description: null,
      system_prompt: null,
      model: "opus",
      status: "offline",
    });

    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(agentManager.updateAgentAuthTokens).toHaveBeenCalledWith(expect.objectContaining({ "child-agent": "child-agent-token" }));
    expect(agentManager.initAgent).toHaveBeenCalledWith("child-agent", expect.objectContaining({ display_name: "Child" }));
    expect(bridge.agentRecords.has("child-agent")).toBe(true);
  });

  it("does not route stale archived child DMs to the parent co-member", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
      { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "child-dm", name: "dm-child-agent", type: "dm" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" } },
      agentManager: { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({
      id: "stale-child-dm-message",
      channel_id: "child-dm",
      sender_id: "human-1",
      sender_type: "human",
      content: "Are you still there?",
      thread_parent_id: null,
      created_at: "2026-05-26T12:00:00.000Z",
    });

    expect(bridge.agentManager.sendToAgent).not.toHaveBeenCalled();
    expect(bridge.channelAgents.has("child-dm")).toBe(false);
    expect(bridge.channelsWithMissingAgentCredentials.has("child-dm")).toBe(false);
  });

  it("does not mark first child DM messages processed when child credentials are missing", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
      { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
    );
    supabase.agents.push({ id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" } },
      agentManager: { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({
      id: "first-task-missing-token",
      channel_id: "child-dm",
      sender_id: "parent-agent",
      sender_type: "agent",
      content: "Please inspect this independently and report evidence.",
      thread_parent_id: null,
      created_at: "2026-05-26T12:00:00.000Z",
    });

    expect(bridge.processedMessageIds.has("first-task-missing-token")).toBe(false);
    expect(bridge.agentManager.sendToAgent).not.toHaveBeenCalled();
  });

  it("does not mark child DM messages processed when membership refresh fails", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.tableErrors.set("channel_members", { message: "membership refresh failed" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" } },
      agentManager: { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() },
      channelTypes: new Map([["child-dm", "dm"]]),
      channelNames: new Map([["child-dm", "dm-child-agent"]]),
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({
      id: "first-task-membership-refresh-error",
      channel_id: "child-dm",
      sender_id: "parent-agent",
      sender_type: "agent",
      content: "Please inspect this independently and report evidence.",
      thread_parent_id: null,
      created_at: "2026-05-26T12:00:00.000Z",
    });

    expect(bridge.processedMessageIds.has("first-task-membership-refresh-error")).toBe(false);
    expect(bridge.agentManager.sendToAgent).not.toHaveBeenCalled();
  });

  it("retries child DM routing asynchronously when credentials arrive after synchronous refreshes", async () => {
    vi.useFakeTimers();
    try {
      const supabase = new supabaseMockState.OmniFakeSupabaseClient();
      supabase.channelMembers.push(
        { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
        { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
      );
      supabase.agents.push({ id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null });
      supabase.channels.push({ id: "child-dm", name: "dm-child-agent", type: "dm" });
      const agentManager = { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() };
      const refreshCredentials = vi.fn()
        .mockResolvedValueOnce({ token: "fresh-omni-token", agentAuthTokens: {} })
        .mockResolvedValueOnce({ token: "fresh-omni-token", agentAuthTokens: {} })
        .mockResolvedValueOnce({ token: "fresh-omni-token", agentAuthTokens: { "child-agent": "child-agent-token" } });
      const bridge = makeBridge({
        supabase,
        config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" }, refreshCredentials },
        agentManager,
        channelTypes: new Map(),
        channelNames: new Map(),
        channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
        agentRecords: new Map([
          ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
        ]),
        activationCooldowns: new Map(),
        topicHopCounts: new Map(),
        findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
        getChannelContext: vi.fn().mockResolvedValue(""),
        formatRoutingLog: vi.fn(),
      });

      await bridge.handleNewMessage({
        id: "first-task-async-refresh",
        channel_id: "child-dm",
        sender_id: "parent-agent",
        sender_type: "agent",
        content: "Please inspect this independently and report evidence.",
        thread_parent_id: null,
        created_at: "2026-05-26T12:00:00.000Z",
      });

      expect(bridge.processedMessageIds.has("first-task-async-refresh")).toBe(false);
      expect(agentManager.sendToAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(refreshCredentials).toHaveBeenCalledTimes(3);
      expect(agentManager.initAgent).toHaveBeenCalledWith("child-agent", expect.objectContaining({ display_name: "Child" }));
      expect(agentManager.sendToAgent).toHaveBeenCalledWith("child-agent", expect.stringContaining("Please inspect this independently"));
      expect(bridge.processedMessageIds.has("first-task-async-refresh")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries child DM routing after a second credential refresh succeeds", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "child-dm", member_id: "parent-agent", member_type: "agent" },
      { channel_id: "child-dm", member_id: "child-agent", member_type: "agent" },
    );
    supabase.agents.push({ id: "child-agent", name: "child", display_name: "Child", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: null });
    supabase.channels.push({ id: "child-dm", name: "dm-child-agent", type: "dm" });
    const agentManager = { sendToAgent: vi.fn(), initAgent: vi.fn(), updateAgentAuthTokens: vi.fn(), getRuntimeAgentState: vi.fn() };
    const refreshCredentials = vi.fn()
      .mockResolvedValueOnce({ token: "fresh-omni-token", agentAuthTokens: {} })
      .mockResolvedValueOnce({ token: "fresh-omni-token", agentAuthTokens: { "child-agent": "child-agent-token" } });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "parent-agent": "parent-agent-token" }, refreshCredentials },
      agentManager,
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["child-dm", new Set(["parent-agent"])]]),
      agentRecords: new Map([
        ["parent-agent", { id: "parent-agent", name: "parent", display_name: "Parent", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({
      id: "first-task-second-refresh",
      channel_id: "child-dm",
      sender_id: "parent-agent",
      sender_type: "agent",
      content: "Please inspect this independently and report evidence.",
      thread_parent_id: null,
      created_at: "2026-05-26T12:00:00.000Z",
    });

    expect(refreshCredentials).toHaveBeenCalledTimes(2);
    expect(agentManager.initAgent).toHaveBeenCalledWith("child-agent", expect.objectContaining({ display_name: "Child" }));
    expect(agentManager.sendToAgent).toHaveBeenCalledWith("child-agent", expect.stringContaining("Please inspect this independently"));
    expect(bridge.processedMessageIds.has("first-task-second-refresh")).toBe(true);
  });

  it("refreshes channel membership before routing human channel broadcasts", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-1", member_type: "agent" },
      { channel_id: "channel-1", member_id: "agent-2", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-1": "agent-1-token", "agent-2": "agent-2-token" } },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["channel-1", new Set(["agent-1"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["agent-2", { id: "agent-2", name: "beta", display_name: "Beta", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-human-broadcast", content: "roundtable please" });

    expect(bridge.agentManager.sendToAgent.mock.calls.map(([agentId]) => agentId).sort()).toEqual(["agent-1", "agent-2"]);
    expect(bridge.channelAgents.get("channel-1")).toEqual(new Set(["agent-1", "agent-2"]));
    expect(bridge.channelTypes.get("channel-1")).toBe("public");
    expect(bridge.channelNames.get("channel-1")).toBe("general");
  });

  it("catches up missed human channel messages when realtime misses an insert", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.messages.push(
      { ...msg, id: "msg-before-catchup", content: "old ping", created_at: "2026-05-28T02:59:00.000Z" },
      { ...msg, id: "msg-missed-human", content: "roundtable please", created_at: "2026-05-28T03:01:00.000Z" },
    );
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-1", member_type: "agent" },
      { channel_id: "channel-1", member_id: "agent-2", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-1": "agent-1-token", "agent-2": "agent-2-token" } },
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["agent-1", "agent-2"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
        ["agent-2", { id: "agent-2", name: "beta", display_name: "Beta", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });
    bridge.messageCatchupCursor = "2026-05-28T03:00:00.000Z";

    await bridge.processMissedMessages();

    expect(bridge.agentManager.sendToAgent.mock.calls.map(([agentId]) => agentId).sort()).toEqual(["agent-1", "agent-2"]);
    expect(bridge.processedMessageIds.has("msg-missed-human")).toBe(true);
    expect(bridge.processedMessageIds.has("msg-before-catchup")).toBe(false);
  });

  it("catches up missed agent direct mentions when realtime misses an insert", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.messages.push({
      ...msg,
      id: "msg-missed-agent-mention",
      sender_id: "reviewer-agent",
      sender_type: "agent",
      content: "@前端工程师 复查通过了，请继续实现剩下的 UI 修复。",
      created_at: "2026-05-28T03:05:00.000Z",
    });
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "reviewer-agent", member_type: "agent" },
      { channel_id: "channel-1", member_id: "frontend-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "reviewer-agent": "reviewer-token", "frontend-agent": "frontend-token" } },
      channelTypes: new Map([["channel-1", "public"]]),
      channelNames: new Map([["channel-1", "general"]]),
      channelAgents: new Map([["channel-1", new Set(["reviewer-agent", "frontend-agent"])]]),
      agentRecords: new Map([
        ["reviewer-agent", { id: "reviewer-agent", name: "reviewer", display_name: "Reviewer", description: "负责代码审查", system_prompt: null, model: "opus", status: "online" }],
        ["frontend-agent", { id: "frontend-agent", name: "frontend", display_name: "前端工程师", description: "负责前端实现", system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Reviewer"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });
    bridge.messageCatchupCursor = "2026-05-28T03:00:00.000Z";

    await bridge.processMissedMessages();

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("frontend-agent", expect.stringContaining("@前端工程师"));
    expect(bridge.processedMessageIds.has("msg-missed-agent-mention")).toBe(true);
  });

  it("routes active agents when stale memberships reference archived owned agents", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-1", member_type: "agent" },
      { channel_id: "channel-1", member_id: "archived-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    supabase.agents.push({ id: "archived-agent", name: "archived", display_name: "Archived", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "server-1", archived_at: "2026-05-26T12:00:00.000Z" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-1": "agent-1-token" } },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["channel-1", new Set(["agent-1"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-stale-archived-membership", content: "roundtable please" });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-1", expect.stringContaining("roundtable please"));
    expect(bridge.agentRecords.has("archived-agent")).toBe(false);
    expect(bridge.channelsWithMissingAgentCredentials.has("channel-1")).toBe(false);
  });

  it("routes active agents when stale memberships reference agents from another server", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-1", member_type: "agent" },
      { channel_id: "channel-1", member_id: "other-server-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    supabase.agents.push({ id: "other-server-agent", name: "other", display_name: "Other", description: null, system_prompt: null, model: "opus", status: "offline", owner_id: "user-1", server_id: "other-server", archived_at: null });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-1": "agent-1-token" } },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["channel-1", new Set(["agent-1"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-stale-other-server-membership", content: "roundtable please" });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-1", expect.stringContaining("roundtable please"));
    expect(bridge.agentRecords.has("other-server-agent")).toBe(false);
    expect(bridge.channelsWithMissingAgentCredentials.has("channel-1")).toBe(false);
  });

  it("routes to owned agents when shared channels include foreign agents", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    supabase.channelMembers.push(
      { channel_id: "channel-1", member_id: "agent-1", member_type: "agent" },
      { channel_id: "channel-1", member_id: "foreign-agent", member_type: "agent" },
    );
    supabase.channels.push({ id: "channel-1", name: "general", type: "public" });
    supabase.agents.push({ id: "foreign-agent", name: "foreign", display_name: "Foreign", description: null, system_prompt: null, model: "opus", status: "online", owner_id: "other-user" });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1", agentAuthTokens: { "agent-1": "agent-1-token" } },
      channelTypes: new Map(),
      channelNames: new Map(),
      channelAgents: new Map([["channel-1", new Set(["agent-1"])]]),
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      activationCooldowns: new Map(),
      topicHopCounts: new Map(),
      findRoutingTaskForMessage: vi.fn().mockResolvedValue(null),
      resolveSenderName: vi.fn().mockResolvedValue("Biang"),
      getChannelContext: vi.fn().mockResolvedValue(""),
      formatRoutingLog: vi.fn(),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-shared-channel", content: "roundtable please" });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-1", expect.stringContaining("roundtable please"));
    expect(bridge.channelAgents.get("channel-1")).toEqual(new Set(["agent-1"]));
    expect(bridge.channelsWithMissingAgentCredentials.has("channel-1")).toBe(false);
  });

  it("retries a concurrent duplicate after the first handling exits unsafely", async () => {
    const delivery = makeDeliveryForAgent("child-agent", "Child", ["dm_recipient"]);
    let releaseFirstRefresh: () => void = () => undefined;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const executeRoutingPlan = vi.fn().mockResolvedValue({ deliveredAgentIds: ["agent-1"], failedAgentIds: [] });
    let refreshCount = 0;
    let bridge: Omni & Record<string, any>;
    const refreshChannelAgents = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 1) await firstRefreshGate;
      if (refreshCount <= 2) {
        bridge.channelsWithMissingAgentCredentials.add("child-dm");
        return new Set<string>();
      }
      bridge.channelsWithMissingAgentCredentials.delete("child-dm");
      return new Set(["child-agent"]);
    });
    bridge = makeBridge({
      refreshChannelAgents,
      buildRoutingPlan: vi.fn().mockResolvedValue({
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "child-dm",
        taskId: null,
      }),
      executeRoutingPlan,
    });

    const concurrentMsg = { ...msg, id: "msg-concurrent-unsafe", channel_id: "child-dm" };
    const first = bridge.handleNewMessage(concurrentMsg);
    const second = bridge.handleNewMessage(concurrentMsg);
    releaseFirstRefresh();
    await Promise.all([first, second]);

    expect(refreshChannelAgents).toHaveBeenCalledTimes(3);
    expect(executeRoutingPlan).toHaveBeenCalledTimes(1);
    expect(bridge.processedMessageIds.has("msg-concurrent-unsafe")).toBe(true);
  });

  it("deduplicates concurrent handling of the same message", async () => {
    const delivery = makeDelivery();
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const executeRoutingPlan = vi.fn().mockResolvedValue({ deliveredAgentIds: ["agent-1"], failedAgentIds: [] });
    const bridge = makeBridge({
      refreshChannelAgents: vi.fn(async () => {
        await refreshGate;
        return new Set(["agent-1"]);
      }),
      buildRoutingPlan: vi.fn().mockResolvedValue({
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "#general",
        taskId: null,
      }),
      executeRoutingPlan,
    });

    const concurrentMsg = { ...msg, id: "msg-concurrent" };
    const first = bridge.handleNewMessage(concurrentMsg);
    const second = bridge.handleNewMessage(concurrentMsg);
    releaseRefresh();
    await Promise.all([first, second]);

    expect(executeRoutingPlan).toHaveBeenCalledTimes(1);
    expect(bridge.processedMessageIds.has("msg-concurrent")).toBe(true);
  });

  it("uses the original delivery prompt when daemon v2 is disabled", async () => {
    const delivery = makeDelivery();
    const bridge = makeBridge();

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "#general",
      taskId: "task-1",
    });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-1", delivery.prompt);
  });

  it("rolls back planning-error cooldowns before a pending retry", async () => {
    const delivery = makeDeliveryForAgent("agent-2", "Beta", ["conversation_continuation"]);
    let releaseFirstRefresh: () => void = () => undefined;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let refreshCount = 0;
    let buildCount = 0;
    let bridge: Omni & Record<string, any>;
    const executeRoutingPlan = vi.fn().mockResolvedValue({ deliveredAgentIds: ["agent-2"], failedAgentIds: [] });
    const buildRoutingPlan = vi.fn(async () => {
      buildCount += 1;
      if (bridge.activationCooldowns.has("planning-error-cooldown")) {
        return {
          msg,
          topicKey: "topic-1",
          activated: [],
          suppressed: [{ agentId: "agent-2", reason: "cooldown", reasons: ["conversation_continuation"] }],
          deliveries: [],
          target: "#general",
          taskId: null,
        };
      }
      bridge.activationCooldowns.set("planning-error-cooldown", { lastActivatedAt: Date.now(), sourceMessageId: "msg-planning-error" });
      if (buildCount === 1) throw new Error("context load failed");
      return {
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "#general",
        taskId: null,
      };
    });
    bridge = makeBridge({
      refreshChannelAgents: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 1) await firstRefreshGate;
        return new Set(["agent-2"]);
      }),
      buildRoutingPlan,
      executeRoutingPlan,
    });

    const concurrentMsg = { ...msg, id: "msg-planning-error", sender_id: "agent-1", sender_type: "agent" as const };
    const first = bridge.handleNewMessage(concurrentMsg);
    const second = bridge.handleNewMessage(concurrentMsg);
    releaseFirstRefresh();
    await Promise.allSettled([first, second]);

    expect(executeRoutingPlan).toHaveBeenCalledTimes(1);
    expect(bridge.processedMessageIds.has("msg-planning-error")).toBe(true);
  });

  it("rolls back failed delivery cooldowns before a pending retry", async () => {
    const delivery = makeDeliveryForAgent("agent-2", "Beta", ["conversation_continuation"]);
    let releaseFirstRefresh: () => void = () => undefined;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let refreshCount = 0;
    let bridge: Omni & Record<string, any>;
    const executeRoutingPlan = vi.fn()
      .mockResolvedValueOnce({ deliveredAgentIds: [], failedAgentIds: ["agent-2"] })
      .mockResolvedValueOnce({ deliveredAgentIds: ["agent-2"], failedAgentIds: [] });
    const buildRoutingPlan = vi.fn(async () => {
      if (bridge.activationCooldowns.has("failed-cooldown")) {
        return {
          msg,
          topicKey: "topic-1",
          activated: [],
          suppressed: [{ agentId: "agent-2", reason: "cooldown", reasons: ["conversation_continuation"] }],
          deliveries: [],
          target: "#general",
          taskId: null,
        };
      }
      bridge.activationCooldowns.set("failed-cooldown", { lastActivatedAt: Date.now(), sourceMessageId: "msg-cooldown-failed" });
      return {
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "#general",
        taskId: null,
      };
    });
    bridge = makeBridge({
      refreshChannelAgents: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 1) await firstRefreshGate;
        return new Set(["agent-2"]);
      }),
      buildRoutingPlan,
      executeRoutingPlan,
    });

    const concurrentMsg = { ...msg, id: "msg-cooldown-failed", sender_id: "agent-1", sender_type: "agent" as const };
    const first = bridge.handleNewMessage(concurrentMsg);
    const second = bridge.handleNewMessage(concurrentMsg);
    releaseFirstRefresh();
    await Promise.all([first, second]);

    expect(executeRoutingPlan).toHaveBeenCalledTimes(2);
    expect(bridge.processedMessageIds.has("msg-cooldown-failed")).toBe(true);
  });

  it("does not mark messages processed when direct delivery fails", async () => {
    const delivery = makeDelivery();
    const bridge = makeBridge({
      refreshChannelAgents: vi.fn().mockResolvedValue(new Set(["agent-1"])),
      buildRoutingPlan: vi.fn().mockResolvedValue({
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "#general",
        taskId: null,
      }),
      agentManager: {
        sendToAgent: vi.fn().mockRejectedValue(new Error("agent unavailable")),
        getRuntimeAgentState: vi.fn(),
      },
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-delivery-fails" });

    expect(bridge.agentManager.sendToAgent).toHaveBeenCalledWith("agent-1", delivery.prompt);
    expect(bridge.processedMessageIds.has("msg-delivery-fails")).toBe(false);
  });

  it("keeps runtime-accepted messages processed when ack broadcast fails", async () => {
    const delivery = makeDelivery();
    const accept = vi.fn().mockResolvedValue({
      id: "delivery-ack-fails",
      agentId: "agent-1",
      deliverySeq: 9,
      traceparent: "trace-original",
      ackTraceparent: "trace-ack",
      acceptedAt: "2026-05-22T00:00:00.000Z",
      state: "queued_gated",
    });
    const bridge = makeBridge({
      refreshChannelAgents: vi.fn().mockResolvedValue(new Set(["agent-1"])),
      buildRoutingPlan: vi.fn().mockResolvedValue({
        msg,
        topicKey: "topic-1",
        activated: [delivery.candidate],
        suppressed: [],
        deliveries: [delivery],
        target: "#general",
        taskId: null,
      }),
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "ready", busy: false, queueDepth: 0, sessionId: "session-1", processId: 123 }),
      },
      deliveryRuntime: { accept },
      runtimeSupervisor: new AgentSupervisor(),
      emitDeliveryAck: vi.fn().mockRejectedValue(new Error("ack broadcast failed")),
    });

    await bridge.handleNewMessage({ ...msg, id: "msg-ack-broadcast-fails" });

    expect(accept).toHaveBeenCalledOnce();
    expect(bridge.processedMessageIds.has("msg-ack-broadcast-fails")).toBe(true);
  });

  it("retries only failed recipients after partial fanout failure", async () => {
    const alphaDelivery = makeDeliveryForAgent("agent-1", "Alpha");
    const betaDelivery = makeDeliveryForAgent("agent-2", "Beta");
    let releaseFirstRefresh: () => void = () => undefined;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let refreshCount = 0;
    let betaFailureUsed = false;
    const sendToAgent = vi.fn(async (agentId: string) => {
      if (agentId === "agent-2" && !betaFailureUsed) {
        betaFailureUsed = true;
        throw new Error("beta unavailable");
      }
    });
    const bridge = makeBridge({
      refreshChannelAgents: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 1) await firstRefreshGate;
        return new Set(["agent-1", "agent-2"]);
      }),
      buildRoutingPlan: vi.fn().mockResolvedValue({
        msg,
        topicKey: "topic-1",
        activated: [alphaDelivery.candidate, betaDelivery.candidate],
        suppressed: [],
        deliveries: [alphaDelivery, betaDelivery],
        target: "#general",
        taskId: null,
      }),
      agentManager: {
        sendToAgent,
        getRuntimeAgentState: vi.fn(),
      },
    });

    const concurrentMsg = { ...msg, id: "msg-partial-fanout" };
    const first = bridge.handleNewMessage(concurrentMsg);
    const second = bridge.handleNewMessage(concurrentMsg);
    releaseFirstRefresh();
    await Promise.all([first, second]);

    expect(sendToAgent.mock.calls.map(([agentId]) => agentId)).toEqual(["agent-1", "agent-2", "agent-2"]);
    expect(bridge.processedMessageIds.has("msg-partial-fanout")).toBe(true);
  });

  it("passes routing target and task id into runtime delivery input", async () => {
    const delivery = makeDelivery();
    const accept = vi.fn().mockResolvedValue({ state: "delivered", acceptedAt: null });
    const bridge = makeBridge({
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "ready", busy: false, queueDepth: 0, sessionId: "session-1", processId: 123 }),
      },
      deliveryRuntime: { accept },
      runtimeSupervisor: new AgentSupervisor(),
    });

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "dm:@Alice:thread1",
      taskId: "task-1",
    });

    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      target: "dm:@Alice:thread1",
      taskId: "task-1",
    }));
  });

  it("sends delivery ack only after runtime accepts custody", async () => {
    const delivery = makeDelivery();
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const accept = vi.fn().mockResolvedValue({
      id: "delivery-1",
      agentId: "agent-1",
      deliverySeq: 7,
      traceparent: "trace-original",
      ackTraceparent: "trace-ack",
      acceptedAt: "2026-05-22T00:00:00.000Z",
      state: "queued_gated",
    });
    const bridge = makeBridge({
      supabase,
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "ready", busy: false, queueDepth: 0, sessionId: "session-1", processId: 123 }),
      },
      deliveryRuntime: { accept },
      runtimeSupervisor: new AgentSupervisor(),
    });

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "#general",
      taskId: null,
    });

    expect(supabase.sends).toEqual([
      {
        channel: "agent-deliveries:server-1",
        message: {
          type: "broadcast",
          event: "agent:deliver:ack",
          payload: { agentId: "agent-1", seq: 7, deliverySeq: 7, traceparent: "trace-ack", deliveryId: "delivery-1" },
        },
      },
    ]);
    expect(supabase.sends.some((send) => send.message.event === "agent:deliver:completed")).toBe(false);
  });

  it("does not send delivery ack or completion when runtime rejects custody", async () => {
    const delivery = makeDelivery();
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const accept = vi.fn().mockResolvedValue({
      id: "delivery-1",
      agentId: "agent-1",
      deliverySeq: 7,
      traceparent: "trace-original",
      ackTraceparent: null,
      acceptedAt: null,
      state: "failed",
      runtimeOutcome: "rejected_no_process",
    });
    const bridge = makeBridge({
      supabase,
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "stopped", busy: false, queueDepth: 0, sessionId: null, processId: null }),
      },
      deliveryRuntime: { accept },
      runtimeSupervisor: new AgentSupervisor(),
    });

    const delivered = await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "#general",
      taskId: null,
    });

    expect(delivered).toEqual({ deliveredAgentIds: [], failedAgentIds: ["agent-1"] });
    expect(supabase.sends).toEqual([]);
  });

  it("queues busy agent manager deliveries as gated custody without immediate delivery", async () => {
    const delivery = makeDelivery();
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const supervisor = new AgentSupervisor();
    const store = new InMemoryDeliveryLedgerStore();
    const driver = { deliver: vi.fn(), setCurrentDelivery: vi.fn() };
    const deliveryRuntime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 2, startIntervalMs: 1_000 }),
      driver,
      machineId: "machine-1",
    });
    const bridge = makeBridge({
      supabase,
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "busy", busy: true, queueDepth: 2, sessionId: "session-1", processId: 123 }),
      },
      deliveryRuntime,
      runtimeSupervisor: supervisor,
    });

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "#general",
      taskId: null,
    });

    const records = [...store.deliveries.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      state: "queued_gated",
      runtimeOutcome: "queued_busy_gated",
      agentId: "agent-1",
    });
    expect(records[0].acceptedAt).toEqual(expect.any(String));
    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "gated",
      busy: true,
      queueDepth: 1,
      sessionId: "session-1",
      processId: 123,
    });
    expect(driver.deliver).not.toHaveBeenCalled();
    expect(supabase.sends).toEqual([
      {
        channel: "agent-deliveries:server-1",
        message: {
          type: "broadcast",
          event: "agent:deliver:ack",
          payload: {
            agentId: "agent-1",
            seq: records[0].deliverySeq,
            deliverySeq: records[0].deliverySeq,
            traceparent: records[0].ackTraceparent,
            deliveryId: records[0].id,
          },
        },
      },
    ]);
    expect(supabase.sends.some((send) => send.message.event === "agent:deliver:completed")).toBe(false);
  });

  it("cold-starts stopped daemon v2 agents through queued_starting custody", async () => {
    const delivery = makeDelivery();
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const supervisor = new AgentSupervisor();
    const store = new InMemoryDeliveryLedgerStore();
    const driver = { deliver: vi.fn(), setCurrentDelivery: vi.fn() };
    const deliveryRuntime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 2, startIntervalMs: 0 }),
      driver,
      machineId: "machine-1",
    });
    const getRuntimeAgentState = vi.fn()
      .mockReturnValueOnce({ state: "stopped", busy: false, queueDepth: 0, sessionId: null, processId: null })
      .mockReturnValue({ state: "ready", busy: false, queueDepth: 0, sessionId: null, processId: 123 });
    const bridge = makeBridge({
      supabase,
      agentManager: {
        sendToAgent: vi.fn(),
        ensureRuntimeProcess: vi.fn().mockResolvedValue(undefined),
        getRuntimeAgentState,
      },
      deliveryRuntime,
      runtimeSupervisor: supervisor,
    });

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: [delivery.candidate],
      suppressed: [],
      deliveries: [delivery],
      target: "#general",
      taskId: null,
    });

    const records = [...store.deliveries.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      state: "delivered",
      runtimeOutcome: "stdin_idle_delivery",
      acceptedAt: expect.any(String),
    });
    expect(bridge.agentManager.ensureRuntimeProcess).toHaveBeenCalledWith("agent-1");
    expect(driver.deliver).toHaveBeenCalledWith("agent-1", expect.stringContaining("continue"));
    expect(deliveryRuntime.startQueueSnapshot()).toMatchObject([{ agentId: "agent-1", state: "started" }]);
    expect(supabase.sends).toEqual([
      {
        channel: "agent-deliveries:server-1",
        message: {
          type: "broadcast",
          event: "agent:deliver:ack",
          payload: {
            agentId: "agent-1",
            seq: records[0].deliverySeq,
            deliverySeq: records[0].deliverySeq,
            traceparent: records[0].ackTraceparent,
            deliveryId: records[0].id,
          },
        },
      },
    ]);
    expect(supabase.sends.some((send) => send.message.event === "agent:deliver:completed")).toBe(false);
  });

  it("starts every queued channel broadcast recipient in the same cold-start fanout batch", async () => {
    const deliveries = [
      makeDeliveryForAgent("agent-1", "Alpha"),
      makeDeliveryForAgent("agent-2", "Beta"),
      makeDeliveryForAgent("agent-3", "Gamma"),
      makeDeliveryForAgent("agent-4", "Delta"),
      makeDeliveryForAgent("agent-5", "Epsilon"),
      makeDeliveryForAgent("agent-6", "Zeta"),
    ];
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const supervisor = new AgentSupervisor();
    const store = new InMemoryDeliveryLedgerStore();
    const driver = { deliver: vi.fn(), setCurrentDelivery: vi.fn() };
    const deliveryRuntime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 5, startIntervalMs: 0 }),
      driver,
      machineId: "machine-1",
    });
    const readyAgents = new Set<string>();
    const ensureRuntimeProcess = vi.fn(async (agentId: string) => {
      readyAgents.add(agentId);
    });
    const getRuntimeAgentState = vi.fn((agentId: string) => readyAgents.has(agentId)
      ? { state: "ready", busy: false, queueDepth: 0, sessionId: `session-${agentId}`, processId: 123 }
      : { state: "stopped", busy: false, queueDepth: 0, sessionId: null, processId: null });
    const bridge = makeBridge({
      supabase,
      agentManager: {
        sendToAgent: vi.fn(),
        ensureRuntimeProcess,
        getRuntimeAgentState,
      },
      deliveryRuntime,
      runtimeSupervisor: supervisor,
    });

    await bridge.executeRoutingPlan({
      msg,
      topicKey: "topic-1",
      activated: deliveries.map((delivery) => delivery.candidate),
      suppressed: [],
      deliveries,
      target: "#general",
      taskId: null,
    });

    const records = [...store.deliveries.values()];
    expect(records).toHaveLength(6);
    expect(records.map((record) => record.state)).toEqual(Array(6).fill("delivered"));
    expect(records.map((record) => record.runtimeOutcome)).toEqual(Array(6).fill("stdin_idle_delivery"));
    expect(ensureRuntimeProcess.mock.calls.map(([agentId]) => agentId).sort()).toEqual(deliveries.map((delivery) => delivery.agent.id).sort());
    expect(driver.deliver.mock.calls.map(([agentId]) => agentId).sort()).toEqual(deliveries.map((delivery) => delivery.agent.id).sort());
    expect(deliveryRuntime.startQueueSnapshot().map((entry) => entry.state)).toEqual(Array(6).fill("started"));
    expect(supabase.sends.filter((send) => send.message.event === "agent:deliver:ack")).toHaveLength(6);
  });

  it("keeps accepted reminder custody fired when ack broadcast fails", async () => {
    const supabase = new supabaseMockState.OmniFakeSupabaseClient();
    const accept = vi.fn().mockResolvedValue({
      id: "reminder-delivery-1",
      agentId: "agent-1",
      deliverySeq: 3,
      traceparent: "trace-original",
      ackTraceparent: "trace-ack",
      acceptedAt: "2026-05-22T00:00:00.000Z",
      state: "queued_gated",
    });
    const bridge = makeBridge({
      supabase,
      config: { serverId: "server-1", userId: "user-1" },
      agentRecords: new Map([
        ["agent-1", { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" }],
      ]),
      agentManager: {
        sendToAgent: vi.fn(),
        getRuntimeAgentState: vi.fn().mockReturnValue({ state: "ready", busy: false, queueDepth: 0, sessionId: "session-1", processId: 123 }),
      },
      deliveryRuntime: { accept },
      runtimeSupervisor: new AgentSupervisor(),
      emitDeliveryAck: vi.fn().mockRejectedValue(new Error("ack broadcast failed")),
    });

    await expect(bridge.fireReminder({
      id: "reminder-1",
      server_id: "server-1",
      created_by_id: "user-1",
      created_by_type: "human",
      recipient_id: "agent-1",
      recipient_type: "agent",
      channel_id: "channel-1",
      source_message_id: null,
      thread_parent_id: null,
      task_id: null,
      target: "#general",
      body: "follow up",
      due_at: "2026-05-22T00:00:00.000Z",
      snoozed_until: null,
      state: "firing",
      fired_at: null,
      fired_delivery_id: null,
      last_error: null,
    })).resolves.toBeUndefined();
    expect(accept).toHaveBeenCalledOnce();
    expect(bridge.emitDeliveryAck).toHaveBeenCalledOnce();
  });

  it("rebuilds daemon v2 delivery runtime against the refreshed Supabase client", async () => {
    const previousFlag = process.env.ZANO_DAEMON_V2;
    process.env.ZANO_DAEMON_V2 = "1";
    supabaseMockState.clients.length = 0;
    try {
      const bridge = new Omni({
        supabaseUrl: "http://local.supabase",
        supabaseKey: "anon-key",
        authToken: "initial-token",
        userId: "user-1",
        serverId: "server-1",
        agentsDir: "/tmp/omni-runtime-test-agents",
        hostname: "machine-1",
      });
      (bridge as any).agentManager.deliverRuntimeMessage = vi.fn().mockResolvedValue(undefined);

      await bridge.updateAuthToken("refreshed-token");
      (bridge as any).runtimeSupervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
      await (bridge as any).deliveryRuntime.accept(buildRuntimeDeliveryInput({
        workspaceId: "server-1",
        msg,
        delivery: makeDelivery(),
        target: "#general",
        taskId: null,
      }));

      expect(supabaseMockState.clients).toHaveLength(2);
      expect(supabaseMockState.clients[0].deliveries).toHaveLength(0);
      expect(supabaseMockState.clients[1].deliveries).toHaveLength(1);
    } finally {
      if (previousFlag === undefined) delete process.env.ZANO_DAEMON_V2;
      else process.env.ZANO_DAEMON_V2 = previousFlag;
    }
  });
});
