import { describe, expect, it } from "vitest";
import {
  DeliveryLedger,
  InMemoryDeliveryLedgerStore,
  SupabaseDeliveryLedgerStore,
  mapDeliveryRecordToInsert,
  mapDeliveryRow,
} from "./delivery-ledger";
import type { RuntimeDeliveryInput, RuntimeDeliveryRecord } from "./types";

const baseInput = (overrides: Partial<RuntimeDeliveryInput> = {}): RuntimeDeliveryInput => ({
  workspaceId: "server-1",
  agentId: "agent-1",
  channelId: "channel-1",
  sourceMessageId: "msg-1",
  threadParentId: null,
  taskId: null,
  target: "#general",
  activationReasons: ["channel_broadcast"],
  activationStrength: "medium",
  prompt: "hello",
  sourceCreatedAt: "2026-05-22T00:00:00.000Z",
  senderId: "human-1",
  senderType: "human",
  ...overrides,
});

describe("DeliveryLedger", () => {
  it("creates delivery records with monotonic per-agent seq", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const first = await ledger.createOrReuseDelivery(baseInput());
    const second = await ledger.createOrReuseDelivery(baseInput({ sourceMessageId: "msg-2", prompt: "again" }));

    expect(first.deliverySeq).toBe(1);
    expect(second.deliverySeq).toBe(2);
  });

  it("dedupes by idempotency key", async () => {
    const ledger = new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore(), now: () => "2026-05-22T00:00:00.000Z" });
    const input = baseInput();

    const first = await ledger.createOrReuseDelivery(input);
    const second = await ledger.createOrReuseDelivery(input);

    expect(second.id).toBe(first.id);
    expect(second.state).toBe("deduped");
  });

  it("does not dedupe matching idempotency keys across workspaces", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const input = baseInput();

    const first = await ledger.createOrReuseDelivery(input);
    const second = await ledger.createOrReuseDelivery({ ...input, workspaceId: "server-2" });

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe("planned");
    expect(store.deliveries.size).toBe(2);
  });

  it("rejects invalid delivery transitions", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const delivery = await ledger.createOrReuseDelivery(baseInput());

    await expect(ledger.transition(delivery.id, "completed", { eventName: "delivery.completed" })).rejects.toThrow(
      "Invalid delivery transition: planned -> completed",
    );

    expect((await store.getDelivery(delivery.id))?.state).toBe("planned");
    expect(store.traceEvents).toHaveLength(0);
  });

  it("records ACK custody metadata without setting completion", async () => {
    const ledger = new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore() });
    const delivery = await ledger.createOrReuseDelivery(baseInput({ sourceMessageId: "ack-custody" }));
    const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
    const accepted = await ledger.transition(received.id, "accepted", {
      eventName: "delivery.ack.accepted",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    });

    expect(accepted.acceptedAt).toEqual(expect.any(String));
    expect(accepted.ackTraceparent).toBe("00-11111111111111111111111111111111-2222222222222222-01");
    expect(accepted.completedAt).toBeNull();
  });

  it("rejects ACK-to-completed as an ordinary delivery transition", async () => {
    const ledger = new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore() });
    const delivery = await ledger.createOrReuseDelivery(baseInput({ sourceMessageId: "no-completed-transition" }));
    const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
    const accepted = await ledger.transition(received.id, "accepted", { eventName: "delivery.ack.accepted" });

    await expect(ledger.transition(accepted.id, "completed", { eventName: "delivery.completed" })).rejects.toThrow(
      "Invalid delivery transition: accepted -> completed",
    );
  });

  it("patches timestamps for state-specific acknowledgements", async () => {
    const times = [
      "2026-05-22T00:00:00.000Z",
      "2026-05-22T00:00:01.000Z",
      "2026-05-22T00:00:02.000Z",
      "2026-05-22T00:00:03.000Z",
      "2026-05-22T00:00:04.000Z",
    ];
    const ledger = new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore(), now: () => times.shift() ?? "unexpected" });
    const delivery = await ledger.createOrReuseDelivery(baseInput());

    const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
    const accepted = await ledger.transition(received.id, "accepted", { eventName: "delivery.accepted" });
    const delivering = await ledger.transition(accepted.id, "delivering", { eventName: "delivery.delivering" });
    const delivered = await ledger.transition(delivering.id, "delivered", { eventName: "delivery.delivered" });

    expect(received).toMatchObject({ receivedAt: "2026-05-22T00:00:01.000Z", deliveredAt: null, acceptedAt: null, completedAt: null });
    expect(accepted).toMatchObject({ acceptedAt: "2026-05-22T00:00:02.000Z", completedAt: null });
    expect(delivering).toMatchObject({ receivedAt: "2026-05-22T00:00:01.000Z", deliveredAt: null, acceptedAt: "2026-05-22T00:00:02.000Z", completedAt: null });
    expect(delivered).toMatchObject({ deliveredAt: "2026-05-22T00:00:04.000Z", acceptedAt: "2026-05-22T00:00:02.000Z", completedAt: null });
  });

  it("stores lastError only when failed transition includes one", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const delivery = await ledger.createOrReuseDelivery(baseInput());

    const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received", lastError: "ignored" });
    const failed = await ledger.transition(received.id, "failed", { eventName: "delivery.failed", lastError: "redacted failure" });

    expect(received.lastError).toBeNull();
    expect(failed.lastError).toBe("redacted failure");
    expect((await store.getDelivery(delivery.id))?.lastError).toBe("redacted failure");
  });

  it("updates delivery state and writes redacted trace events", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const delivery = await ledger.createOrReuseDelivery(baseInput());

    await ledger.transition(delivery.id, "received", {
      eventName: "delivery.received",
      attributes: {
        token: "secret-token",
        nested: { authorization: "Bearer secret", safe: "visible" },
        list: [{ serviceRoleKey: "service-key" }],
      },
    });

    expect((await store.getDelivery(delivery.id))?.state).toBe("received");
    expect(store.traceEvents[0]).toMatchObject({
      deliveryId: delivery.id,
      eventName: "delivery.received",
      attributes: {
        token: "[REDACTED]",
        nested: { authorization: "[REDACTED]", safe: "visible" },
        list: [{ serviceRoleKey: "[REDACTED]" }],
      },
    });
  });

  it("returns cloned deliveries so deduped nested arrays cannot mutate stored records", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const input = baseInput();

    const first = await ledger.createOrReuseDelivery(input);
    first.activationReasons.push("mention");
    const storedAfterFirstMutation = await store.getDelivery(first.id);

    const deduped = await ledger.createOrReuseDelivery(input);
    deduped.activationReasons.push("direct_message");
    const storedAfterDedupedMutation = await store.getDelivery(first.id);

    expect(storedAfterFirstMutation?.activationReasons).toEqual(["channel_broadcast"]);
    expect(storedAfterDedupedMutation?.activationReasons).toEqual(["channel_broadcast"]);
  });

  it("returns cloned inspection data so callers cannot mutate stored records", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const delivery = await ledger.createOrReuseDelivery(baseInput());
    await ledger.transition(delivery.id, "received", { eventName: "delivery.received", attributes: { nested: { safe: "visible" } } });

    store.deliveries.get(delivery.id)?.activationReasons.push("mutated");
    (store.traceEvents[0].attributes.nested as { safe: string }).safe = "mutated";

    expect(store.deliveries.get(delivery.id)?.activationReasons).toEqual(["channel_broadcast"]);
    expect(store.traceEvents[0].attributes).toEqual({ nested: { safe: "visible" } });
  });

  it("atomically dedupes concurrent identical creates", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const input = baseInput();

    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.createOrReuseDelivery(input)));
    const ids = new Set(results.map((result) => result.id));

    expect(ids.size).toBe(1);
    expect(store.deliveries.size).toBe(1);
    expect(results.filter((result) => result.state === "planned")).toHaveLength(1);
    expect(results.filter((result) => result.state === "deduped")).toHaveLength(19);
  });
});

const persistedRecord = (overrides: Partial<RuntimeDeliveryRecord> = {}): RuntimeDeliveryRecord => ({
  ...baseInput(),
  id: "delivery-1",
  idempotencyKey: "idem-1",
  deliverySeq: 7,
  traceId: "trace-1",
  spanId: "span-1",
  traceparent: "00-trace-1-span-1-01",
  state: "queued_busy",
  queueReason: "agent_busy",
  attempts: 2,
  lastError: "last failure",
  receivedAt: "2026-05-22T00:00:01.000Z",
  deliveredAt: "2026-05-22T00:00:02.000Z",
  acceptedAt: "2026-05-22T00:00:03.000Z",
  ackTraceparent: "00-ack-trace-ack-span-01",
  lastRuntimeEventAt: "2026-05-22T00:00:03.500Z",
  runtimeOutcome: "queued_busy",
  completedAt: null,
  failedAt: null,
  createdAt: "2026-05-22T00:00:00.000Z",
  updatedAt: "2026-05-22T00:00:04.000Z",
  ...overrides,
});

class FakeSupabaseTable {
  private operation: "select" | "insert" | "update" = "select";
  private filters: Array<{ column: string; value: unknown }> = [];
  private inFilters: Array<{ column: string; values: unknown[] }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private insertRows: Record<string, unknown>[] = [];
  private updatePatch: Record<string, unknown> | null = null;

  constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly hooks: FakeSupabaseHooks = {},
  ) {}

  select() {
    return this;
  }

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
    this.filters.push({ column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inFilters.push({ column, values });
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
    const selected = this.applySelect();
    const data = this.hooks.onMaybeSingle?.(this.rows, selected, this.filters) ?? selected[0] ?? null;
    return { data, error: null };
  }

  async single() {
    if (this.operation === "insert") return this.performInsert();
    if (this.operation === "update") return this.performUpdate();
    return { data: this.applySelect()[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => void, reject: (error: unknown) => void) {
    this.executeArray().then(resolve, reject);
  }

  private async executeArray() {
    return { data: this.applySelect(), error: null };
  }

  private performInsert() {
    const row = { ...this.insertRows[0] };
    const hookResult = this.hooks.onInsert?.(row, this.rows);
    if (hookResult) return hookResult;
    const existingIdempotency = this.rows.find(
      (existing) => existing.workspace_id === row.workspace_id && existing.idempotency_key === row.idempotency_key,
    );
    if (existingIdempotency) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const existingSeq = this.rows.find(
      (existing) => existing.workspace_id === row.workspace_id && existing.agent_id === row.agent_id && existing.delivery_seq === row.delivery_seq,
    );
    if (existingSeq) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint daemon_deliveries_workspace_agent_seq_idx" } };
    this.rows.push(row);
    return { data: row, error: null };
  }

  private performUpdate() {
    const row = this.applySelect()[0];
    if (!row) return { data: null, error: { message: "not found" } };
    Object.assign(row, this.updatePatch);
    return { data: row, error: null };
  }

  private applySelect() {
    let result = this.rows.filter((row) => this.filters.every((filter) => row[filter.column] === filter.value));
    result = result.filter((row) => this.inFilters.every((filter) => filter.values.includes(row[filter.column])));
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

interface FakeSupabaseHooks {
  onInsert?: (
    row: Record<string, unknown>,
    rows: Record<string, unknown>[],
  ) => { data: Record<string, unknown> | null; error: { code?: string; message: string } | null } | null;
  onMaybeSingle?: (
    rows: Record<string, unknown>[],
    selected: Record<string, unknown>[],
    filters: Array<{ column: string; value: unknown }>,
  ) => Record<string, unknown> | null | undefined;
}

class FakeSupabaseClient {
  readonly deliveries: Record<string, unknown>[] = [];
  readonly traceEvents: Record<string, unknown>[] = [];

  constructor(private readonly hooks: FakeSupabaseHooks = {}) {}

  from(table: string) {
    if (table === "daemon_deliveries") return new FakeSupabaseTable(this.deliveries, this.hooks);
    if (table === "daemon_trace_events") return new FakeSupabaseTable(this.traceEvents, this.hooks);
    throw new Error(`Unexpected table: ${table}`);
  }
}

describe("SupabaseDeliveryLedgerStore", () => {
  it("maps runtime delivery records to daemon_deliveries insert rows", () => {
    expect(mapDeliveryRecordToInsert(persistedRecord())).toEqual({
      id: "delivery-1",
      workspace_id: "server-1",
      agent_id: "agent-1",
      channel_id: "channel-1",
      source_message_id: "msg-1",
      thread_parent_id: null,
      task_id: null,
      delivery_seq: 7,
      idempotency_key: "idem-1",
      trace_id: "trace-1",
      span_id: "span-1",
      traceparent: "00-trace-1-span-1-01",
      target: "#general",
      activation_strength: "medium",
      activation_reasons: ["channel_broadcast"],
      state: "queued_busy",
      queue_reason: "agent_busy",
      attempts: 2,
      last_error: "last failure",
      received_at: "2026-05-22T00:00:01.000Z",
      delivered_at: "2026-05-22T00:00:02.000Z",
      accepted_at: "2026-05-22T00:00:03.000Z",
      ack_traceparent: "00-ack-trace-ack-span-01",
      last_runtime_event_at: "2026-05-22T00:00:03.500Z",
      runtime_outcome: "queued_busy",
      completed_at: null,
      failed_at: null,
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:00:04.000Z",
    });
  });

  it("maps daemon_deliveries rows to runtime records with explicit non-persisted defaults and cloned reasons", () => {
    const activationReasons = ["channel_broadcast"];
    const row = mapDeliveryRecordToInsert(persistedRecord({ activationReasons }));
    const mapped = mapDeliveryRow(row);

    activationReasons.push("direct_mention");
    mapped.activationReasons.push("mention");

    expect(mapped).toMatchObject({
      workspaceId: "server-1",
      agentId: "agent-1",
      sourceMessageId: "msg-1",
      prompt: "",
      sourceCreatedAt: "",
      senderId: "",
      senderType: "system",
      activationReasons: ["channel_broadcast", "mention"],
    });
    expect(mapDeliveryRow(row).activationReasons).toEqual(["channel_broadcast"]);
  });

  it("creates or reuses a Supabase delivery atomically and lets the ledger mark duplicate input deduped", async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseDeliveryLedgerStore(client as never);
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const input = baseInput();

    const first = await ledger.createOrReuseDelivery(input);
    const duplicate = await ledger.createOrReuseDelivery(input);

    expect(client.deliveries).toHaveLength(1);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.state).toBe("deduped");
  });

  it("dedupes when the initial find misses but insert hits an idempotency conflict", async () => {
    let skippedInitialFind = false;
    const client = new FakeSupabaseClient({
      onMaybeSingle(_rows, selected, filters) {
        const isIdempotencyFind = filters.some((filter) => filter.column === "idempotency_key");
        if (isIdempotencyFind && !skippedInitialFind) {
          skippedInitialFind = true;
          return null;
        }
        return selected[0] ?? null;
      },
    });
    client.deliveries.push(mapDeliveryRecordToInsert(persistedRecord({ id: "existing-delivery", idempotencyKey: JSON.stringify(["msg-1", "agent-1", "#general", ["channel_broadcast"]]) })));
    const store = new SupabaseDeliveryLedgerStore(client as never);
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const duplicate = await ledger.createOrReuseDelivery(baseInput());

    expect(client.deliveries).toHaveLength(1);
    expect(duplicate).toMatchObject({ id: "existing-delivery", state: "deduped" });
  });

  it("retries distinct delivery inserts after a delivery_seq unique conflict", async () => {
    let seqConflictInjected = false;
    const client = new FakeSupabaseClient({
      onInsert(row, rows) {
        if (!seqConflictInjected && row.idempotency_key === JSON.stringify(["msg-2", "agent-1", "#general", ["channel_broadcast"]])) {
          seqConflictInjected = true;
          rows.push(mapDeliveryRecordToInsert(persistedRecord({
            id: "concurrent-delivery",
            sourceMessageId: "msg-concurrent",
            idempotencyKey: JSON.stringify(["msg-concurrent", "agent-1", "#general", ["channel_broadcast"]]),
            deliverySeq: row.delivery_seq as number,
          })));
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint daemon_deliveries_workspace_agent_seq_idx" } };
        }
        return null;
      },
    });
    client.deliveries.push(mapDeliveryRecordToInsert(persistedRecord({ id: "first-delivery", deliverySeq: 1 })));
    const store = new SupabaseDeliveryLedgerStore(client as never);
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const created = await ledger.createOrReuseDelivery(baseInput({ sourceMessageId: "msg-2", prompt: "second" }));

    expect(seqConflictInjected).toBe(true);
    expect(created).toMatchObject({ sourceMessageId: "msg-2", deliverySeq: 3, state: "planned" });
    expect(client.deliveries.map((row) => row.delivery_seq)).toEqual([1, 2, 3]);
  });

  it("updates only mutable transition columns in Supabase patches", async () => {
    const original = mapDeliveryRecordToInsert(persistedRecord());
    const client = new FakeSupabaseClient();
    client.deliveries.push({ ...original });
    const store = new SupabaseDeliveryLedgerStore(client as never);

    const updated = await store.updateDelivery("delivery-1", {
      workspaceId: "changed-workspace",
      agentId: "changed-agent",
      sourceMessageId: "changed-message",
      deliverySeq: 99,
      idempotencyKey: "changed-idempotency",
      target: "#changed",
      activationReasons: ["direct_mention"],
      state: "delivered",
      deliveredAt: "2026-05-22T00:00:05.000Z",
      updatedAt: "2026-05-22T00:00:05.000Z",
    });

    expect(client.deliveries[0]).toMatchObject({
      workspace_id: original.workspace_id,
      agent_id: original.agent_id,
      source_message_id: original.source_message_id,
      delivery_seq: original.delivery_seq,
      idempotency_key: original.idempotency_key,
      target: original.target,
      activation_reasons: original.activation_reasons,
      state: "delivered",
      delivered_at: "2026-05-22T00:00:05.000Z",
      updated_at: "2026-05-22T00:00:05.000Z",
    });
    expect(updated).toMatchObject({ workspaceId: "server-1", agentId: "agent-1", state: "delivered" });
  });

  it("queries recoverable deliveries scoped by workspace and optional agent", async () => {
    const client = new FakeSupabaseClient();
    client.deliveries.push(
      mapDeliveryRecordToInsert(persistedRecord({ id: "d1", workspaceId: "server-1", agentId: "agent-1", state: "delivering", updatedAt: "2026-05-22T00:00:03.000Z" })),
      mapDeliveryRecordToInsert(persistedRecord({ id: "d2", workspaceId: "server-1", agentId: "agent-2", state: "queued_busy", updatedAt: "2026-05-22T00:00:02.000Z" })),
      mapDeliveryRecordToInsert(persistedRecord({ id: "d3", workspaceId: "server-1", agentId: "agent-1", state: "completed", updatedAt: "2026-05-22T00:00:01.000Z" })),
      mapDeliveryRecordToInsert(persistedRecord({ id: "d4", workspaceId: "server-2", agentId: "agent-1", state: "delivering", updatedAt: "2026-05-22T00:00:00.000Z" })),
    );
    const store = new SupabaseDeliveryLedgerStore(client as never);

    await expect(store.recoverableDeliveries("server-1", { agentId: "agent-1", limit: 10 })).resolves.toMatchObject([
      { id: "d1", workspaceId: "server-1", agentId: "agent-1", state: "delivering" },
    ]);
  });
});
