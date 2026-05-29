import type { ActivationReason, ActivationStrength, SenderType } from "../a2a-protocol.js";

export type DeliveryState =
  | "planned"
  | "received"
  | "deduped"
  | "queued_starting"
  | "queued_busy"
  | "queued_gated"
  | "queued_compaction"
  | "restarting_idle"
  | "delivering"
  | "delivered"
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled";

export type DeliveryQueueReason =
  | "agent_starting"
  | "agent_busy"
  | "gated_safe_boundary"
  | "compaction_boundary"
  | "idle_restart"
  | "stale_recovery";

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "busy"
  | "gated"
  | "idle"
  | "stale"
  | "stopping"
  | "failed"
  | "ended";

export type StartQueueState = "queued" | "starting" | "started" | "failed" | "cancelled";
export type RuntimeTraceSeverity = "debug" | "info" | "warn" | "error";

export type RuntimeKind = "claude" | "codex" | "kimi" | "copilot" | "cursor" | "gemini" | "opencode";

export type RuntimeLifecycle = "persistent" | "per_turn";

export type RuntimeBusyDeliveryMode = "gated" | "direct" | "none";

export interface RuntimeDriverProfile {
  readonly runtime: RuntimeKind;
  readonly lifecycle: RuntimeLifecycle;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode: RuntimeBusyDeliveryMode;
  readonly supportsNativeStandingPrompt: boolean;
  readonly terminateProcessOnTurnEnd: boolean;
}

export interface DeliveryIdempotencyInput {
  sourceMessageId: string;
  agentId: string;
  target: string;
  activationReasons: readonly ActivationReason[];
}

export interface RuntimeDeliveryInput extends DeliveryIdempotencyInput {
  workspaceId: string;
  channelId: string;
  threadParentId: string | null;
  taskId: string | null;
  activationStrength: ActivationStrength;
  prompt: string;
  sourceCreatedAt: string;
  senderId: string;
  senderType: SenderType;
}

export interface RuntimeDeliveryRecord extends RuntimeDeliveryInput {
  id: string;
  idempotencyKey: string;
  deliverySeq: number;
  traceId: string;
  spanId: string;
  traceparent: string;
  state: DeliveryState;
  queueReason: DeliveryQueueReason | null;
  attempts: number;
  lastError: string | null;
  receivedAt: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  ackTraceparent: string | null;
  lastRuntimeEventAt: string | null;
  runtimeOutcome: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  machineId: string;
  runtime: "claude-code";
  runtimeModel: string | null;
  sessionId: string | null;
  processId: number | null;
  state: RuntimeSessionState;
  promptHash: string;
  wrapperHash: string | null;
  launchId: string | null;
  sessionRef: string | null;
  sessionRefReachable: boolean;
  workspacePathRef: string | null;
  runtimeProfile: string | null;
  startedAt: string;
  lastActiveAt: string | null;
  idleAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export interface StartQueueEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  machineId: string;
  reason: string;
  state: StartQueueState;
  dedupeKey: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export interface RuntimeTraceEvent {
  id: string;
  workspaceId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  deliveryId: string | null;
  agentId: string | null;
  eventType: "routing" | "delivery" | "process" | "stdin" | "cli" | "recovery";
  eventName: string;
  severity: RuntimeTraceSeverity;
  attributes: Record<string, unknown>;
  createdAt: string;
}

export const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  planned: ["received", "deduped", "cancelled"],
  received: ["accepted", "failed", "cancelled"],
  deduped: [],
  accepted: ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering", "failed", "cancelled"],
  queued_starting: ["restarting_idle", "delivering", "queued_busy", "queued_gated", "failed", "cancelled"],
  queued_busy: ["queued_gated", "queued_compaction", "delivering", "failed", "cancelled"],
  queued_gated: ["queued_busy", "queued_compaction", "delivering", "failed", "cancelled"],
  queued_compaction: ["queued_gated", "delivering", "failed", "cancelled"],
  restarting_idle: ["delivering", "queued_busy", "queued_gated", "failed", "cancelled"],
  delivering: ["delivered", "queued_busy", "queued_gated", "queued_compaction", "failed", "cancelled"],
  delivered: ["queued_busy", "queued_gated", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const DELIVERY_TERMINAL_STATES: DeliveryState[] = ["deduped", "completed", "failed", "cancelled"];
export const DELIVERY_RECOVERABLE_STATES: DeliveryState[] = ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering"];

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isRecoverableDeliveryState(state: DeliveryState): boolean {
  return DELIVERY_RECOVERABLE_STATES.includes(state);
}

export function isDeliveryAckState(state: DeliveryState): boolean {
  return state === "accepted" || state.startsWith("queued_") || state === "restarting_idle" || state === "delivering" || state === "delivered";
}

export function isOrdinaryDeliveryCompletionState(_state: DeliveryState): boolean {
  return false;
}

export function buildDeliveryIdempotencyKey(input: DeliveryIdempotencyInput): string {
  return JSON.stringify([
    input.sourceMessageId,
    input.agentId,
    input.target,
    [...new Set(input.activationReasons)].sort(),
  ]);
}

export type GatedSteeringPhase = "idle" | "assistant_continuation" | "tool_wait" | "tool_boundary" | "compacting" | "error";

export type GatedFlushReason = "idle" | "turn_end" | "tool_boundary" | "compaction_boundary";

export type GatedFlushAction = "deliver_full" | "notify" | "wait";

export interface GatedSteeringEventRecord {
  type: string;
  at: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface GatedSteeringState {
  phase: GatedSteeringPhase;
  outstandingToolUses: number;
  compacting: boolean;
  toolBoundaryFlushDisabled: boolean;
  lastFlushReason: GatedFlushReason | null;
  recentEvents: GatedSteeringEventRecord[];
  inFlightBatch: string[] | null;
}

export type ClaudeGatedSteeringEvent =
  | { type: "assistant_thinking" }
  | { type: "assistant_text" }
  | { type: "tool_call"; toolUseId: string }
  | { type: "tool_result"; toolUseId: string }
  | { type: "compaction_started" }
  | { type: "compaction_finished" }
  | { type: "turn_end" }
  | { type: "runtime_error"; message: string };

const SECRET_KEY_PATTERN = /(api[-_]?key|token|authorization|supabase[-_]?key|service[-_]?role|jwt|secret|password|private[-_]?key|credentials?)/i;

export function redactTraceAttributes(value: unknown): unknown {
  return redactTraceAttributesValue(value, new WeakSet<object>());
}

function redactTraceAttributesValue(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redactTraceAttributesValue(entry, seen));

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactTraceAttributesValue(entry, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}
