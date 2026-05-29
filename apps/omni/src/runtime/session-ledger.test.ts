import { describe, expect, it } from "vitest";
import {
  InMemoryRuntimeSessionStore,
  RuntimeSessionLedger,
  SupabaseRuntimeSessionStore,
  mapRuntimeSessionRecordToInsert,
} from "./session-ledger";
import type { RuntimeSessionRecord } from "./types";

const baseStartInput = (overrides: Partial<Parameters<RuntimeSessionLedger["startSession"]>[0]> = {}): Parameters<RuntimeSessionLedger["startSession"]>[0] => ({
  workspaceId: "server-1",
  agentId: "agent-1",
  machineId: "machine-1",
  runtimeModel: "opus",
  sessionId: "claude-session-0",
  processId: 123,
  promptHash: "a".repeat(64),
  wrapperHash: "b".repeat(64),
  ...overrides,
});

const persistedRecord = (overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord => ({
  id: "runtime-1",
  workspaceId: "server-1",
  agentId: "agent-1",
  machineId: "machine-1",
  runtime: "claude-code",
  runtimeModel: "opus",
  sessionId: "claude-session-1",
  processId: 123,
  state: "ready",
  promptHash: "a".repeat(64),
  wrapperHash: "b".repeat(64),
  startedAt: "2026-05-22T00:00:00.000Z",
  lastActiveAt: "2026-05-22T00:00:01.000Z",
  idleAt: null,
  endedAt: null,
  lastError: null,
  launchId: "launch-1",
  sessionRef: "/Users/test/.claude/projects/repo/session-1.jsonl",
  sessionRefReachable: true,
  workspacePathRef: "/Users/test/.zano/agents/agent-1",
  runtimeProfile: "claude",
  metadata: { safe: true },
  ...overrides,
});

describe("RuntimeSessionLedger", () => {
  it("creates starting claude-code runtime session records with injected timestamps and identities", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const session = await ledger.startSession(baseStartInput({ sessionId: null }));

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session).toMatchObject({
      workspaceId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      runtime: "claude-code",
      runtimeModel: "opus",
      sessionId: null,
      processId: 123,
      state: "starting",
      promptHash: "a".repeat(64),
      wrapperHash: "b".repeat(64),
      startedAt: "2026-05-22T00:00:00.000Z",
      lastActiveAt: "2026-05-22T00:00:00.000Z",
      idleAt: null,
      endedAt: null,
      lastError: null,
      metadata: {},
    });
    expect(store.sessions.get(session.id)).toMatchObject({ agentId: "agent-1", processId: 123 });
  });

  it("records runtime session refs separately from local files", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const record = await ledger.startSession(baseStartInput({
      launchId: "launch-1",
      sessionRef: "/Users/test/.claude/projects/repo/session-1.jsonl",
      sessionRefReachable: true,
      workspacePathRef: "/Users/test/.zano/agents/agent-1",
      runtimeProfile: "claude",
    }));

    expect(record.launchId).toBe("launch-1");
    expect(record.sessionRef).toBe("/Users/test/.claude/projects/repo/session-1.jsonl");
    expect(record.sessionRefReachable).toBe(true);
    expect(record.workspacePathRef).toBe("/Users/test/.zano/agents/agent-1");
    expect(record.runtimeProfile).toBe("claude");
  });

  it("updates state, session identity, lifecycle timestamps, and explicit patch fields", async () => {
    const times = [
      "2026-05-22T00:00:00.000Z",
      "2026-05-22T00:00:01.000Z",
      "2026-05-22T00:00:02.000Z",
      "2026-05-22T00:00:03.000Z",
      "2026-05-22T00:00:04.000Z",
      "2026-05-22T00:00:05.000Z",
      "2026-05-22T00:00:06.000Z",
    ];
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => times.shift() ?? "unexpected" });
    const session = await ledger.startSession(baseStartInput({ sessionId: null }));

    const ready = await ledger.updateState(session.id, "ready", { sessionId: "claude-session-1", processId: 456 });
    const busy = await ledger.updateState(session.id, "busy", { lastError: "waiting for tool", metadata: { phase: "tool" } });
    const gated = await ledger.updateState(session.id, "gated", { lastActiveAt: "2026-05-22T00:00:44.000Z" });
    const idle = await ledger.updateState(session.id, "idle");
    const ended = await ledger.updateState(session.id, "ended", { processId: null });
    const failed = await ledger.updateState(session.id, "failed", { endedAt: "2026-05-22T00:00:55.000Z", lastError: "exit code 1" });

    expect(ready).toMatchObject({ state: "ready", sessionId: "claude-session-1", processId: 456, lastActiveAt: "2026-05-22T00:00:01.000Z" });
    expect(busy).toMatchObject({ state: "busy", lastActiveAt: "2026-05-22T00:00:02.000Z", lastError: "waiting for tool", metadata: { phase: "tool" } });
    expect(gated).toMatchObject({ state: "gated", lastActiveAt: "2026-05-22T00:00:44.000Z" });
    expect(idle).toMatchObject({ state: "idle", idleAt: "2026-05-22T00:00:04.000Z" });
    expect(ended).toMatchObject({ state: "ended", processId: null, endedAt: "2026-05-22T00:00:05.000Z" });
    expect(failed).toMatchObject({ state: "failed", endedAt: "2026-05-22T00:00:55.000Z", lastError: "exit code 1" });
  });

  it("returns the newest session scoped by workspace and agent", async () => {
    const times = [
      "2026-05-22T00:00:00.000Z",
      "2026-05-22T00:00:02.000Z",
      "2026-05-22T00:00:01.000Z",
      "2026-05-22T00:00:03.000Z",
    ];
    const ledger = new RuntimeSessionLedger({ store: new InMemoryRuntimeSessionStore(), now: () => times.shift() ?? "unexpected" });
    const oldMatch = await ledger.startSession(baseStartInput({ processId: 1 }));
    const newestMatch = await ledger.startSession(baseStartInput({ processId: 2 }));
    await ledger.startSession(baseStartInput({ workspaceId: "server-2", processId: 3 }));
    await ledger.startSession(baseStartInput({ agentId: "agent-2", processId: 4 }));

    await expect(ledger.latestForAgent("server-1", "agent-1")).resolves.toMatchObject({ id: newestMatch.id, processId: 2 });
    await expect(ledger.latestForAgent("server-2", "agent-1")).resolves.toMatchObject({ processId: 3 });
    await expect(ledger.latestForAgent("server-1", "missing-agent")).resolves.toBeNull();
    expect(oldMatch.startedAt).toBe("2026-05-22T00:00:00.000Z");
  });

  it("returns cloned in-memory records so callers cannot mutate stored metadata", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const session = await ledger.startSession(baseStartInput());
    const updated = await ledger.updateState(session.id, "ready", { metadata: { nested: { safe: "visible" } } });

    (updated.metadata.nested as { safe: string }).safe = "mutated";
    const latest = await ledger.latestForAgent("server-1", "agent-1");
    (latest!.metadata.nested as { safe: string }).safe = "mutated-again";

    expect((store.sessions.get(session.id)!.metadata.nested as { safe: string }).safe).toBe("visible");
  });
});

describe("runtime session row mapping", () => {
  it("maps runtime session records to daemon_runtime_sessions insert rows", () => {
    expect(mapRuntimeSessionRecordToInsert(persistedRecord())).toEqual({
      id: "runtime-1",
      workspace_id: "server-1",
      agent_id: "agent-1",
      machine_id: "machine-1",
      runtime: "claude-code",
      runtime_model: "opus",
      session_id: "claude-session-1",
      process_id: 123,
      state: "ready",
      prompt_hash: "a".repeat(64),
      wrapper_hash: "b".repeat(64),
      launch_id: "launch-1",
      session_ref: "/Users/test/.claude/projects/repo/session-1.jsonl",
      session_ref_reachable: true,
      workspace_path_ref: "/Users/test/.zano/agents/agent-1",
      runtime_profile: "claude",
      started_at: "2026-05-22T00:00:00.000Z",
      last_active_at: "2026-05-22T00:00:01.000Z",
      idle_at: null,
      ended_at: null,
      last_error: null,
      metadata: { safe: true },
    });
  });
});

class FakeRuntimeSessionTable {
  private operation: "select" | "insert" | "update" = "select";
  private filters: Array<{ column: string; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private insertRows: Record<string, unknown>[] = [];
  private updatePatch: Record<string, unknown> | null = null;

  constructor(private readonly rows: Record<string, unknown>[]) {}

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
    this.filters.push({ column, value });
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
    return { data: this.applySelect()[0] ?? null, error: null };
  }
  async single() {
    if (this.operation === "insert") {
      const row = { ...this.insertRows[0] };
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
  private applySelect() {
    let result = this.rows.filter((row) => this.filters.every((filter) => row[filter.column] === filter.value));
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

class FakeRuntimeSessionClient {
  readonly sessions: Record<string, unknown>[] = [];

  from(table: string) {
    if (table === "daemon_runtime_sessions") return new FakeRuntimeSessionTable(this.sessions);
    throw new Error(`Unexpected table: ${table}`);
  }
}

describe("SupabaseRuntimeSessionStore", () => {
  it("inserts and maps daemon runtime session rows", async () => {
    const client = new FakeRuntimeSessionClient();
    const store = new SupabaseRuntimeSessionStore(client as never);
    const inserted = await store.insertSession(persistedRecord());

    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]).toMatchObject({ workspace_id: "server-1", agent_id: "agent-1", state: "ready" });
    expect(inserted).toMatchObject({ id: "runtime-1", workspaceId: "server-1", agentId: "agent-1", metadata: { safe: true } });
  });

  it("updates only mutable columns in Supabase patches", async () => {
    const original = mapRuntimeSessionRecordToInsert(persistedRecord());
    const client = new FakeRuntimeSessionClient();
    client.sessions.push({ ...original });
    const store = new SupabaseRuntimeSessionStore(client as never);

    const updated = await store.updateSession("runtime-1", {
      workspaceId: "changed-workspace",
      agentId: "changed-agent",
      machineId: "changed-machine",
      runtimeModel: "haiku",
      promptHash: "c".repeat(64),
      wrapperHash: "d".repeat(64),
      state: "failed",
      sessionId: "claude-session-2",
      processId: null,
      endedAt: "2026-05-22T00:00:03.000Z",
      lastError: "exit code 1",
      launchId: "launch-2",
      sessionRef: "/Users/test/.zano/runtime-sessions/claude-launch-launch-2.jsonl",
      sessionRefReachable: false,
      workspacePathRef: "/Users/test/.zano/agents/agent-1",
      runtimeProfile: "claude",
      metadata: { safe: false },
    });

    expect(client.sessions[0]).toMatchObject({
      workspace_id: original.workspace_id,
      agent_id: original.agent_id,
      machine_id: original.machine_id,
      runtime_model: original.runtime_model,
      prompt_hash: original.prompt_hash,
      wrapper_hash: original.wrapper_hash,
      state: "failed",
      session_id: "claude-session-2",
      process_id: null,
      ended_at: "2026-05-22T00:00:03.000Z",
      last_error: "exit code 1",
      launch_id: "launch-2",
      session_ref: "/Users/test/.zano/runtime-sessions/claude-launch-launch-2.jsonl",
      session_ref_reachable: false,
      workspace_path_ref: "/Users/test/.zano/agents/agent-1",
      runtime_profile: "claude",
      metadata: { safe: false },
    });
    expect(updated).toMatchObject({ workspaceId: "server-1", agentId: "agent-1", state: "failed", lastError: "exit code 1" });
  });

  it("queries latest runtime session scoped by workspace and agent", async () => {
    const client = new FakeRuntimeSessionClient();
    client.sessions.push(
      mapRuntimeSessionRecordToInsert(persistedRecord({ id: "old-match", startedAt: "2026-05-22T00:00:00.000Z" })),
      mapRuntimeSessionRecordToInsert(persistedRecord({ id: "new-match", startedAt: "2026-05-22T00:00:02.000Z" })),
      mapRuntimeSessionRecordToInsert(persistedRecord({ id: "other-agent", agentId: "agent-2", startedAt: "2026-05-22T00:00:03.000Z" })),
      mapRuntimeSessionRecordToInsert(persistedRecord({ id: "other-workspace", workspaceId: "server-2", startedAt: "2026-05-22T00:00:04.000Z" })),
    );
    const store = new SupabaseRuntimeSessionStore(client as never);

    await expect(store.latestForAgent("server-1", "agent-1")).resolves.toMatchObject({ id: "new-match" });
    await expect(store.latestForAgent("missing", "agent-1")).resolves.toBeNull();
  });
});
