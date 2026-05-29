import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeSessionRecord, RuntimeSessionState } from "./types.js";

export interface RuntimeSessionStartInput {
  workspaceId: string;
  agentId: string;
  machineId: string;
  runtimeModel: string | null;
  sessionId: string | null;
  processId: number | null;
  promptHash: string;
  wrapperHash: string | null;
  launchId?: string | null;
  sessionRef?: string | null;
  sessionRefReachable?: boolean;
  workspacePathRef?: string | null;
  runtimeProfile?: string | null;
}

export interface RuntimeSessionStore {
  insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord>;
  updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord>;
  latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null>;
}

export type RuntimeSessionInsertRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  machine_id: string;
  runtime: "claude-code";
  runtime_model: string | null;
  session_id: string | null;
  process_id: number | null;
  state: RuntimeSessionState;
  prompt_hash: string;
  wrapper_hash: string | null;
  launch_id: string | null;
  session_ref: string | null;
  session_ref_reachable: boolean;
  workspace_path_ref: string | null;
  runtime_profile: string | null;
  started_at: string;
  last_active_at: string | null;
  idle_at: string | null;
  ended_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
};

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly sessionRecords = new Map<string, RuntimeSessionRecord>();

  get sessions(): ReadonlyMap<string, RuntimeSessionRecord> {
    return new Map(Array.from(this.sessionRecords.entries(), ([id, session]) => [id, cloneRuntimeSession(session)]));
  }

  async insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    const stored = cloneRuntimeSession(record);
    this.sessionRecords.set(stored.id, stored);
    return cloneRuntimeSession(stored);
  }

  async updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord> {
    const existing = this.sessionRecords.get(id);
    if (!existing) throw new Error(`Runtime session not found: ${id}`);

    const updated = cloneRuntimeSession({ ...existing, ...cloneRuntimeSessionPatch(patch) });
    this.sessionRecords.set(id, updated);
    return cloneRuntimeSession(updated);
  }

  async latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    const session = [...this.sessionRecords.values()]
      .filter((record) => record.workspaceId === workspaceId && record.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return session ? cloneRuntimeSession(session) : null;
  }
}

export interface RuntimeSessionLedgerOptions {
  store: RuntimeSessionStore;
  now?: () => string;
}

export class RuntimeSessionLedger {
  private readonly store: RuntimeSessionStore;
  private readonly now: () => string;

  constructor(options: RuntimeSessionLedgerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async startSession(input: RuntimeSessionStartInput): Promise<RuntimeSessionRecord> {
    const now = this.now();
    return this.store.insertSession({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      machineId: input.machineId,
      runtime: "claude-code",
      runtimeModel: input.runtimeModel,
      sessionId: input.sessionId,
      processId: input.processId,
      state: "starting",
      promptHash: input.promptHash,
      wrapperHash: input.wrapperHash,
      launchId: input.launchId ?? null,
      sessionRef: input.sessionRef ?? null,
      sessionRefReachable: input.sessionRefReachable ?? false,
      workspacePathRef: input.workspacePathRef ?? null,
      runtimeProfile: input.runtimeProfile ?? null,
      startedAt: now,
      lastActiveAt: now,
      idleAt: null,
      endedAt: null,
      lastError: null,
      metadata: {},
    });
  }

  async updateState(id: string, state: RuntimeSessionState, patch: Partial<RuntimeSessionRecord> = {}): Promise<RuntimeSessionRecord> {
    const now = this.now();
    return this.store.updateSession(id, {
      ...patch,
      state,
      ...this.lifecycleTimestampPatch(state, now, patch),
    });
  }

  latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    return this.store.latestForAgent(workspaceId, agentId);
  }

  private lifecycleTimestampPatch(
    state: RuntimeSessionState,
    now: string,
    patch: Partial<RuntimeSessionRecord>,
  ): Partial<RuntimeSessionRecord> {
    if ((state === "ready" || state === "busy" || state === "gated") && patch.lastActiveAt === undefined) {
      return { lastActiveAt: now };
    }
    if (state === "idle" && patch.idleAt === undefined) return { idleAt: now };
    if ((state === "ended" || state === "failed") && patch.endedAt === undefined) return { endedAt: now };
    return {};
  }
}

export function mapRuntimeSessionRecordToInsert(record: RuntimeSessionRecord): RuntimeSessionInsertRow {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    agent_id: record.agentId,
    machine_id: record.machineId,
    runtime: record.runtime,
    runtime_model: record.runtimeModel,
    session_id: record.sessionId,
    process_id: record.processId,
    state: record.state,
    prompt_hash: record.promptHash,
    wrapper_hash: record.wrapperHash,
    launch_id: record.launchId,
    session_ref: record.sessionRef,
    session_ref_reachable: record.sessionRefReachable,
    workspace_path_ref: record.workspacePathRef,
    runtime_profile: record.runtimeProfile,
    started_at: record.startedAt,
    last_active_at: record.lastActiveAt,
    idle_at: record.idleAt,
    ended_at: record.endedAt,
    last_error: record.lastError,
    metadata: cloneRecord(record.metadata),
  };
}

export function mapRuntimeSessionRow(row: Record<string, unknown>): RuntimeSessionRecord {
  return {
    id: stringColumn(row, "id"),
    workspaceId: stringColumn(row, "workspace_id"),
    agentId: stringColumn(row, "agent_id"),
    machineId: stringColumn(row, "machine_id"),
    runtime: "claude-code",
    runtimeModel: nullableStringColumn(row, "runtime_model"),
    sessionId: nullableStringColumn(row, "session_id"),
    processId: nullableNumberColumn(row, "process_id"),
    state: stringColumn(row, "state") as RuntimeSessionState,
    promptHash: stringColumn(row, "prompt_hash"),
    wrapperHash: nullableStringColumn(row, "wrapper_hash"),
    launchId: nullableStringColumn(row, "launch_id"),
    sessionRef: nullableStringColumn(row, "session_ref"),
    sessionRefReachable: booleanColumn(row, "session_ref_reachable"),
    workspacePathRef: nullableStringColumn(row, "workspace_path_ref"),
    runtimeProfile: nullableStringColumn(row, "runtime_profile"),
    startedAt: stringColumn(row, "started_at"),
    lastActiveAt: nullableStringColumn(row, "last_active_at"),
    idleAt: nullableStringColumn(row, "idle_at"),
    endedAt: nullableStringColumn(row, "ended_at"),
    lastError: nullableStringColumn(row, "last_error"),
    metadata: cloneRecord(isRecord(row.metadata) ? row.metadata : {}),
  };
}

export class SupabaseRuntimeSessionStore implements RuntimeSessionStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    const { data, error } = await this.supabase
      .from("daemon_runtime_sessions")
      .insert(mapRuntimeSessionRecordToInsert(record))
      .select("*")
      .single();
    if (error) throw new Error(`Failed to insert runtime session: ${error.message}`);
    return mapRuntimeSessionRow(data as Record<string, unknown>);
  }

  async updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord> {
    const { data, error } = await this.supabase
      .from("daemon_runtime_sessions")
      .update(mapRuntimeSessionPatch(patch))
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update runtime session: ${error.message}`);
    return mapRuntimeSessionRow(data as Record<string, unknown>);
  }

  async latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    const { data, error } = await this.supabase
      .from("daemon_runtime_sessions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to query latest runtime session: ${error.message}`);
    return data ? mapRuntimeSessionRow(data as Record<string, unknown>) : null;
  }
}

function mapRuntimeSessionPatch(patch: Partial<RuntimeSessionRecord>): Partial<RuntimeSessionInsertRow> {
  const row: Partial<RuntimeSessionInsertRow> = {};
  if (patch.sessionId !== undefined) row.session_id = patch.sessionId;
  if (patch.processId !== undefined) row.process_id = patch.processId;
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.lastActiveAt !== undefined) row.last_active_at = patch.lastActiveAt;
  if (patch.idleAt !== undefined) row.idle_at = patch.idleAt;
  if (patch.endedAt !== undefined) row.ended_at = patch.endedAt;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.launchId !== undefined) row.launch_id = patch.launchId;
  if (patch.sessionRef !== undefined) row.session_ref = patch.sessionRef;
  if (patch.sessionRefReachable !== undefined) row.session_ref_reachable = patch.sessionRefReachable;
  if (patch.workspacePathRef !== undefined) row.workspace_path_ref = patch.workspacePathRef;
  if (patch.runtimeProfile !== undefined) row.runtime_profile = patch.runtimeProfile;
  if (patch.metadata !== undefined) row.metadata = cloneRecord(patch.metadata);
  return row;
}

function stringColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function nullableStringColumn(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : stringColumn(row, column);
}

function nullableNumberColumn(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return null;
}

function booleanColumn(row: Record<string, unknown>, column: string): boolean {
  return row[column] === true;
}

function cloneRuntimeSession(session: RuntimeSessionRecord): RuntimeSessionRecord {
  return { ...session, metadata: cloneRecord(session.metadata) };
}

function cloneRuntimeSessionPatch(patch: Partial<RuntimeSessionRecord>): Partial<RuntimeSessionRecord> {
  return patch.metadata === undefined ? { ...patch } : { ...patch, metadata: cloneRecord(patch.metadata) };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
