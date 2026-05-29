import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createTraceContext, formatTraceparent } from "./trace-context.js";
import {
  buildDeliveryIdempotencyKey,
  canTransitionDelivery,
  DELIVERY_RECOVERABLE_STATES,
  redactTraceAttributes,
  type DeliveryQueueReason,
  type DeliveryState,
  type RuntimeTraceSeverity,
  type RuntimeDeliveryInput,
  type RuntimeDeliveryRecord,
  type RuntimeTraceEvent,
} from "./types.js";

export interface AtomicCreateOrReuseDeliveryInput {
  workspaceId: string;
  agentId: string;
  idempotencyKey: string;
  createDelivery: (deliverySeq: number) => RuntimeDeliveryRecord;
}

export interface AtomicCreateOrReuseDeliveryResult {
  delivery: RuntimeDeliveryRecord;
  reused: boolean;
}

export interface DeliveryLedgerStore {
  findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null>;
  nextDeliverySeq(workspaceId: string, agentId: string): Promise<number>;
  insertDelivery(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord>;
  createOrReuseDeliveryAtomically(input: AtomicCreateOrReuseDeliveryInput): Promise<AtomicCreateOrReuseDeliveryResult>;
  getDelivery(id: string): Promise<RuntimeDeliveryRecord | null>;
  updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord>;
  insertTraceEvent(event: RuntimeTraceEvent): Promise<void>;
}

export type DeliveryInsertRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string;
  source_message_id: string;
  thread_parent_id: string | null;
  task_id: string | null;
  delivery_seq: number;
  idempotency_key: string;
  trace_id: string;
  span_id: string;
  traceparent: string;
  target: string;
  activation_strength: RuntimeDeliveryRecord["activationStrength"];
  activation_reasons: RuntimeDeliveryRecord["activationReasons"];
  state: DeliveryState;
  queue_reason: DeliveryQueueReason | null;
  attempts: number;
  last_error: string | null;
  received_at: string | null;
  delivered_at: string | null;
  accepted_at: string | null;
  ack_traceparent: string | null;
  last_runtime_event_at: string | null;
  runtime_outcome: string | null;
  completed_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
};

export function mapDeliveryRecordToInsert(record: RuntimeDeliveryRecord): DeliveryInsertRow {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    agent_id: record.agentId,
    channel_id: record.channelId,
    source_message_id: record.sourceMessageId,
    thread_parent_id: record.threadParentId,
    task_id: record.taskId,
    delivery_seq: record.deliverySeq,
    idempotency_key: record.idempotencyKey,
    trace_id: record.traceId,
    span_id: record.spanId,
    traceparent: record.traceparent,
    target: record.target,
    activation_strength: record.activationStrength,
    activation_reasons: [...record.activationReasons],
    state: record.state,
    queue_reason: record.queueReason,
    attempts: record.attempts,
    last_error: record.lastError,
    received_at: record.receivedAt,
    delivered_at: record.deliveredAt,
    accepted_at: record.acceptedAt,
    ack_traceparent: record.ackTraceparent,
    last_runtime_event_at: record.lastRuntimeEventAt,
    runtime_outcome: record.runtimeOutcome,
    completed_at: record.completedAt,
    failed_at: record.failedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function mapDeliveryRow(row: Record<string, unknown>): RuntimeDeliveryRecord {
  const activationReasons = Array.isArray(row.activation_reasons) ? [...row.activation_reasons] : [];
  return {
    id: stringColumn(row, "id"),
    workspaceId: stringColumn(row, "workspace_id"),
    agentId: stringColumn(row, "agent_id"),
    channelId: stringColumn(row, "channel_id"),
    sourceMessageId: stringColumn(row, "source_message_id"),
    threadParentId: nullableStringColumn(row, "thread_parent_id"),
    taskId: nullableStringColumn(row, "task_id"),
    target: stringColumn(row, "target"),
    activationReasons: activationReasons as RuntimeDeliveryRecord["activationReasons"],
    activationStrength: stringColumn(row, "activation_strength") as RuntimeDeliveryRecord["activationStrength"],
    // daemon_deliveries intentionally does not persist source payload fields.
    // Recovery callers must reconstruct payloads from messages/tasks before re-delivery.
    prompt: "",
    sourceCreatedAt: "",
    senderId: "",
    senderType: "system",
    idempotencyKey: stringColumn(row, "idempotency_key"),
    deliverySeq: numberColumn(row, "delivery_seq"),
    traceId: stringColumn(row, "trace_id"),
    spanId: stringColumn(row, "span_id"),
    traceparent: stringColumn(row, "traceparent"),
    state: stringColumn(row, "state") as DeliveryState,
    queueReason: nullableStringColumn(row, "queue_reason") as DeliveryQueueReason | null,
    attempts: numberColumn(row, "attempts"),
    lastError: nullableStringColumn(row, "last_error"),
    receivedAt: nullableStringColumn(row, "received_at"),
    deliveredAt: nullableStringColumn(row, "delivered_at"),
    acceptedAt: nullableStringColumn(row, "accepted_at"),
    ackTraceparent: nullableStringColumn(row, "ack_traceparent"),
    lastRuntimeEventAt: nullableStringColumn(row, "last_runtime_event_at"),
    runtimeOutcome: nullableStringColumn(row, "runtime_outcome"),
    completedAt: nullableStringColumn(row, "completed_at"),
    failedAt: nullableStringColumn(row, "failed_at"),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

export class InMemoryDeliveryLedgerStore implements DeliveryLedgerStore {
  private readonly deliveryRecords = new Map<string, RuntimeDeliveryRecord>();
  private readonly traceEventRecords: RuntimeTraceEvent[] = [];
  private readonly deliverySeqs = new Map<string, number>();

  get deliveries(): ReadonlyMap<string, RuntimeDeliveryRecord> {
    return new Map(Array.from(this.deliveryRecords.entries(), ([id, delivery]) => [id, cloneDelivery(delivery)]));
  }

  get traceEvents(): readonly RuntimeTraceEvent[] {
    return this.traceEventRecords.map(cloneTraceEvent);
  }

  async findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null> {
    for (const delivery of this.deliveryRecords.values()) {
      if (delivery.workspaceId === workspaceId && delivery.idempotencyKey === idempotencyKey) return cloneDelivery(delivery);
    }
    return null;
  }

  async nextDeliverySeq(workspaceId: string, agentId: string): Promise<number> {
    return this.allocateDeliverySeq(workspaceId, agentId);
  }

  async insertDelivery(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    const stored = cloneDelivery(delivery);
    this.deliveryRecords.set(stored.id, stored);
    return cloneDelivery(stored);
  }

  async createOrReuseDeliveryAtomically(input: AtomicCreateOrReuseDeliveryInput): Promise<AtomicCreateOrReuseDeliveryResult> {
    for (const delivery of this.deliveryRecords.values()) {
      if (delivery.workspaceId === input.workspaceId && delivery.idempotencyKey === input.idempotencyKey) {
        return { delivery: cloneDelivery(delivery), reused: true };
      }
    }

    const delivery = input.createDelivery(this.allocateDeliverySeq(input.workspaceId, input.agentId));
    const stored = cloneDelivery(delivery);
    this.deliveryRecords.set(stored.id, stored);
    return { delivery: cloneDelivery(stored), reused: false };
  }

  async getDelivery(id: string): Promise<RuntimeDeliveryRecord | null> {
    const delivery = this.deliveryRecords.get(id);
    return delivery ? cloneDelivery(delivery) : null;
  }

  async updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord> {
    const existing = this.deliveryRecords.get(id);
    if (!existing) throw new Error(`Delivery not found: ${id}`);

    const updated = cloneDelivery({ ...existing, ...patch });
    this.deliveryRecords.set(id, updated);
    return cloneDelivery(updated);
  }

  async insertTraceEvent(event: RuntimeTraceEvent): Promise<void> {
    this.traceEventRecords.push(cloneTraceEvent(event));
  }

  private allocateDeliverySeq(workspaceId: string, agentId: string): number {
    const key = `${workspaceId}:${agentId}`;
    const next = (this.deliverySeqs.get(key) ?? 0) + 1;
    this.deliverySeqs.set(key, next);
    return next;
  }
}

export interface RecoverableDeliveriesOptions {
  agentId?: string;
  limit?: number;
}

type LiveDeliveryTransientFields = Pick<RuntimeDeliveryRecord, "prompt" | "sourceCreatedAt" | "senderId" | "senderType" | "activationReasons">;

export class SupabaseDeliveryLedgerStore implements DeliveryLedgerStore {
  private static readonly DEFAULT_RECOVERY_LIMIT = 100;
  private static readonly DELIVERY_SEQ_UNIQUE_RETRIES = 3;
  private readonly liveDeliveryFields = new Map<string, LiveDeliveryTransientFields>();

  constructor(private readonly supabase: SupabaseClient) {}

  async findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`Failed to find delivery by idempotency key: ${error.message}`);
    return data ? this.mergeLiveFields(mapDeliveryRow(data as Record<string, unknown>)) : null;
  }

  async nextDeliverySeq(workspaceId: string, agentId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .select("delivery_seq")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("delivery_seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to allocate delivery sequence: ${error.message}`);
    return data ? numberColumn(data as Record<string, unknown>, "delivery_seq") + 1 : 1;
  }

  async insertDelivery(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .insert(mapDeliveryRecordToInsert(delivery))
      .select("*")
      .single();
    if (error) throw new Error(`Failed to insert delivery: ${error.message}`);
    this.cacheLiveFields(delivery);
    return this.mergeLiveFields(mapDeliveryRow(data as Record<string, unknown>));
  }

  async createOrReuseDeliveryAtomically(input: AtomicCreateOrReuseDeliveryInput): Promise<AtomicCreateOrReuseDeliveryResult> {
    const existing = await this.findByIdempotencyKey(input.workspaceId, input.idempotencyKey);
    if (existing) return { delivery: existing, reused: true };

    let lastError: { message?: string } | null = null;
    for (let attempt = 0; attempt <= SupabaseDeliveryLedgerStore.DELIVERY_SEQ_UNIQUE_RETRIES; attempt++) {
      const delivery = input.createDelivery(await this.nextDeliverySeq(input.workspaceId, input.agentId));
      const { data, error } = await this.supabase
        .from("daemon_deliveries")
        .insert(mapDeliveryRecordToInsert(delivery))
        .select("*")
        .single();

      if (!error) {
        this.cacheLiveFields(delivery);
        return { delivery: this.mergeLiveFields(mapDeliveryRow(data as Record<string, unknown>)), reused: false };
      }

      lastError = error;
      if (!isUniqueConstraintError(error)) break;

      const reused = await this.findByIdempotencyKey(input.workspaceId, input.idempotencyKey);
      if (reused) return { delivery: reused, reused: true };
    }

    throw new Error(`Failed to atomically create delivery: ${lastError?.message ?? "unknown error"}`);
  }

  async getDelivery(id: string): Promise<RuntimeDeliveryRecord | null> {
    const { data, error } = await this.supabase.from("daemon_deliveries").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Failed to get delivery: ${error.message}`);
    return data ? this.mergeLiveFields(mapDeliveryRow(data as Record<string, unknown>)) : null;
  }

  async updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .update(mapDeliveryPatch(patch))
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update delivery: ${error.message}`);
    if (hasLiveDeliveryTransientPatch(patch)) this.cacheLivePatch(id, patch);
    return this.mergeLiveFields(mapDeliveryRow(data as Record<string, unknown>));
  }

  async insertTraceEvent(event: RuntimeTraceEvent): Promise<void> {
    const { error } = await this.supabase.from("daemon_trace_events").insert(mapTraceEventToInsert(event));
    if (error) throw new Error(`Failed to insert trace event: ${error.message}`);
  }

  async recoverableDeliveries(workspaceId: string, options: RecoverableDeliveriesOptions = {}): Promise<RuntimeDeliveryRecord[]> {
    let query = this.supabase
      .from("daemon_deliveries")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("state", DELIVERY_RECOVERABLE_STATES)
      .order("updated_at", { ascending: true })
      .limit(options.limit ?? SupabaseDeliveryLedgerStore.DEFAULT_RECOVERY_LIMIT);
    if (options.agentId) query = query.eq("agent_id", options.agentId);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to query recoverable deliveries: ${error.message}`);
    return (data ?? []).map((row) => mapDeliveryRow(row as Record<string, unknown>));
  }

  private cacheLiveFields(delivery: RuntimeDeliveryRecord): void {
    this.liveDeliveryFields.set(delivery.id, {
      prompt: delivery.prompt,
      sourceCreatedAt: delivery.sourceCreatedAt,
      senderId: delivery.senderId,
      senderType: delivery.senderType,
      activationReasons: [...delivery.activationReasons],
    });
  }

  private cacheLivePatch(id: string, patch: Partial<RuntimeDeliveryRecord>): void {
    const previous = this.liveDeliveryFields.get(id);
    this.liveDeliveryFields.set(id, {
      prompt: patch.prompt ?? previous?.prompt ?? "",
      sourceCreatedAt: patch.sourceCreatedAt ?? previous?.sourceCreatedAt ?? "",
      senderId: patch.senderId ?? previous?.senderId ?? "",
      senderType: patch.senderType ?? previous?.senderType ?? "system",
      activationReasons: patch.activationReasons ? [...patch.activationReasons] : previous ? [...previous.activationReasons] : [],
    });
  }

  private mergeLiveFields(delivery: RuntimeDeliveryRecord): RuntimeDeliveryRecord {
    const liveFields = this.liveDeliveryFields.get(delivery.id);
    if (!liveFields) return delivery;
    return {
      ...delivery,
      ...liveFields,
      activationReasons: [...liveFields.activationReasons],
    };
  }
}

export interface DeliveryLedgerOptions {
  store: DeliveryLedgerStore;
  now?: () => string;
}

export interface DeliveryTransitionTrace {
  eventName: string;
  attributes?: Record<string, unknown>;
  lastError?: string;
  traceparent?: string;
  runtimeOutcome?: string;
}

export class DeliveryLedger {
  private readonly store: DeliveryLedgerStore;
  private readonly now: () => string;

  constructor(options: DeliveryLedgerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createOrReuseDelivery(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    const idempotencyKey = buildDeliveryIdempotencyKey(input);
    const result = await this.store.createOrReuseDeliveryAtomically({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      idempotencyKey,
      createDelivery: (deliverySeq) => {
        const now = this.now();
        const traceContext = createTraceContext();
        return {
          ...input,
          activationReasons: [...input.activationReasons],
          id: randomUUID(),
          idempotencyKey,
          deliverySeq,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          traceparent: formatTraceparent(traceContext),
          state: "planned",
          queueReason: null,
          attempts: 0,
          lastError: null,
          receivedAt: null,
          deliveredAt: null,
          acceptedAt: null,
          ackTraceparent: null,
          lastRuntimeEventAt: null,
          runtimeOutcome: null,
          completedAt: null,
          failedAt: null,
          createdAt: now,
          updatedAt: now,
        };
      },
    });

    if (!result.reused) return result.delivery;
    if (isUnacceptedRejectedNoProcess(result.delivery)) return this.reopenUnacceptedRejectedDelivery(result.delivery, input);
    return { ...result.delivery, activationReasons: [...result.delivery.activationReasons], state: "deduped" };
  }

  async reopenUnacceptedRejectedDelivery(existing: RuntimeDeliveryRecord, input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    const idempotencyKey = buildDeliveryIdempotencyKey(input);
    if (existing.workspaceId !== input.workspaceId || existing.idempotencyKey !== idempotencyKey) {
      throw new Error(`Cannot reopen delivery ${existing.id}: input does not match existing idempotency scope`);
    }
    if (!isUnacceptedRejectedNoProcess(existing)) {
      throw new Error(`Cannot reopen delivery ${existing.id}: only unaccepted rejected_no_process attempts are retryable`);
    }

    const now = this.now();
    const reopened = await this.store.updateDelivery(existing.id, {
      prompt: input.prompt,
      sourceCreatedAt: input.sourceCreatedAt,
      senderId: input.senderId,
      senderType: input.senderType,
      activationReasons: [...input.activationReasons],
      state: "planned",
      queueReason: null,
      attempts: 0,
      lastError: null,
      receivedAt: null,
      deliveredAt: null,
      acceptedAt: null,
      ackTraceparent: null,
      lastRuntimeEventAt: null,
      runtimeOutcome: null,
      completedAt: null,
      failedAt: null,
      updatedAt: now,
    });

    await this.store.insertTraceEvent({
      id: randomUUID(),
      workspaceId: existing.workspaceId,
      traceId: existing.traceId,
      spanId: existing.spanId,
      parentSpanId: null,
      deliveryId: existing.id,
      agentId: existing.agentId,
      eventType: "delivery",
      eventName: "delivery.reopened_rejected_no_process",
      severity: "info",
      attributes: redactTraceAttributes({
        agentId: existing.agentId,
        target: existing.target,
        previousState: existing.state,
        previousRuntimeOutcome: existing.runtimeOutcome,
      }) as Record<string, unknown>,
      createdAt: now,
    });

    return reopened;
  }

  async getDelivery(id: string): Promise<RuntimeDeliveryRecord | null> {
    return this.store.getDelivery(id);
  }

  async transition(id: string, state: DeliveryState, trace: DeliveryTransitionTrace): Promise<RuntimeDeliveryRecord> {
    const existing = await this.store.getDelivery(id);
    if (!existing) throw new Error(`Delivery not found: ${id}`);
    if (!canTransitionDelivery(existing.state, state)) {
      throw new Error(`Invalid delivery transition: ${existing.state} -> ${state}`);
    }

    const now = this.now();
    const updated = await this.store.updateDelivery(id, {
      state,
      updatedAt: now,
      ...this.timestampPatch(state, now),
      ...(state === "accepted" ? { ackTraceparent: trace.traceparent ?? existing.ackTraceparent } : {}),
      ...(trace.runtimeOutcome !== undefined ? { runtimeOutcome: trace.runtimeOutcome, lastRuntimeEventAt: now } : {}),
      ...(state === "failed" && trace.lastError ? { lastError: trace.lastError } : {}),
    });

    await this.store.insertTraceEvent({
      id: randomUUID(),
      workspaceId: existing.workspaceId,
      traceId: existing.traceId,
      spanId: existing.spanId,
      parentSpanId: null,
      deliveryId: existing.id,
      agentId: existing.agentId,
      eventType: "delivery",
      eventName: trace.eventName,
      severity: state === "failed" ? "error" : "info",
      attributes: redactTraceAttributes(trace.attributes ?? {}) as Record<string, unknown>,
      createdAt: now,
    });

    return updated;
  }

  private timestampPatch(state: DeliveryState, now: string): Partial<RuntimeDeliveryRecord> {
    if (state === "received") return { receivedAt: now };
    if (state === "delivered") return { deliveredAt: now };
    if (state === "accepted") return { acceptedAt: now };
    if (state === "completed") return { completedAt: now };
    if (state === "failed") return { failedAt: now };
    return {};
  }
}

function isUnacceptedRejectedNoProcess(delivery: RuntimeDeliveryRecord): boolean {
  return delivery.state === "failed" && delivery.acceptedAt === null && delivery.runtimeOutcome === "rejected_no_process";
}

function hasLiveDeliveryTransientPatch(patch: Partial<RuntimeDeliveryRecord>): boolean {
  return patch.prompt !== undefined || patch.sourceCreatedAt !== undefined || patch.senderId !== undefined || patch.senderType !== undefined || patch.activationReasons !== undefined;
}

function mapDeliveryPatch(patch: Partial<RuntimeDeliveryRecord>): Partial<DeliveryInsertRow> {
  const row: Partial<DeliveryInsertRow> = {};
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.queueReason !== undefined) row.queue_reason = patch.queueReason;
  if (patch.attempts !== undefined) row.attempts = patch.attempts;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.receivedAt !== undefined) row.received_at = patch.receivedAt;
  if (patch.deliveredAt !== undefined) row.delivered_at = patch.deliveredAt;
  if (patch.acceptedAt !== undefined) row.accepted_at = patch.acceptedAt;
  if (patch.ackTraceparent !== undefined) row.ack_traceparent = patch.ackTraceparent;
  if (patch.lastRuntimeEventAt !== undefined) row.last_runtime_event_at = patch.lastRuntimeEventAt;
  if (patch.runtimeOutcome !== undefined) row.runtime_outcome = patch.runtimeOutcome;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
  if (patch.failedAt !== undefined) row.failed_at = patch.failedAt;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  return row;
}

function mapTraceEventToInsert(event: RuntimeTraceEvent) {
  return {
    id: event.id,
    workspace_id: event.workspaceId,
    trace_id: event.traceId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId,
    delivery_id: event.deliveryId,
    agent_id: event.agentId,
    event_type: event.eventType,
    event_name: event.eventName,
    severity: event.severity as RuntimeTraceSeverity,
    attributes: cloneRecord(event.attributes),
    created_at: event.createdAt,
  };
}

function stringColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function nullableStringColumn(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : stringColumn(row, column);
}

function numberColumn(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function isUniqueConstraintError(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" || /duplicate key|unique constraint/i.test(error.message ?? "");
}

function cloneDelivery(delivery: RuntimeDeliveryRecord): RuntimeDeliveryRecord {
  return { ...delivery, activationReasons: [...delivery.activationReasons] };
}

function cloneTraceEvent(event: RuntimeTraceEvent): RuntimeTraceEvent {
  return { ...event, attributes: cloneRecord(event.attributes) };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record) as Record<string, unknown>;
}
