import type { AgentSupervisor, SupervisorAgentState } from "./agent-supervisor.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type { StartCoordinator, StartStarter } from "./start-coordinator.js";
import { redactRuntimeText } from "./redaction.js";
import { redactTraceAttributes, type RuntimeDeliveryInput, type RuntimeDeliveryRecord, type StartQueueEntry } from "./types.js";

export interface RuntimeAgentDriver {
  deliver(agentId: string, prompt: string): Promise<void>;
  setCurrentDelivery?(agentId: string, context: {
    deliveryId: string;
    deliverySeq: number;
    traceparent: string;
    target: string;
    channelId: string;
    sourceMessageId: string;
    threadParentId: string | null;
    taskId: string | null;
    messageCreatedAt: string;
  }): Promise<void>;
}

export interface QueuedGatedVisibilityEvent {
  agentId: string;
  deliveryId: string;
  agentState: SupervisorAgentState;
  queueDepth: number;
  runtimeProgressStaleSince: string | null;
}

export interface DeliveryRuntimeOptions {
  ledger: DeliveryLedger;
  supervisor: AgentSupervisor;
  startCoordinator: StartCoordinator;
  driver: RuntimeAgentDriver;
  machineId: string;
  onQueuedGated?: (event: QueuedGatedVisibilityEvent) => Promise<void> | void;
}

export class DeliveryRuntime {
  readonly ledger: DeliveryLedger;
  readonly supervisor: AgentSupervisor;
  readonly startCoordinator: StartCoordinator;
  readonly driver: RuntimeAgentDriver;
  readonly machineId: string;
  private readonly onQueuedGated: ((event: QueuedGatedVisibilityEvent) => Promise<void> | void) | null;
  private readonly agentOperations = new Map<string, Promise<void>>();

  constructor(options: DeliveryRuntimeOptions) {
    this.ledger = options.ledger;
    this.supervisor = options.supervisor;
    this.startCoordinator = options.startCoordinator;
    this.driver = options.driver;
    this.machineId = options.machineId;
    this.onQueuedGated = options.onQueuedGated ?? null;
  }

  async accept(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    return this.runAgentOperation(input.agentId, () => this.acceptUnlocked(input));
  }

  private async acceptUnlocked(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    const initialSupervisorState = this.supervisor.getState(input.agentId);
    const deferAcceptedDelivery = shouldFlushQueuedBeforeAccept(initialSupervisorState);
    if (deferAcceptedDelivery) {
      await this.flushQueuedDeliveriesUnlocked(input.agentId, "idle");
    }

    const delivery = await this.ledger.createOrReuseDelivery(input);
    if (delivery.state === "deduped") return delivery;

    const received = await this.ledger.transition(delivery.id, "received", {
      eventName: "delivery.received",
      attributes: { agentId: delivery.agentId, target: delivery.target },
    });

    const supervisorState = this.supervisor.getState(received.agentId);
    if (!canAcceptCustody(supervisorState)) {
      return this.ledger.transition(received.id, "failed", {
        eventName: "delivery.rejected_no_process",
        attributes: { agentState: supervisorState.state, hasProcess: hasRuntimeIdentity(supervisorState) },
        runtimeOutcome: "rejected_no_process",
      });
    }

    const accepted = await this.ledger.transition(received.id, "accepted", {
      eventName: "delivery.ack.accepted",
      traceparent: received.traceparent,
      attributes: {
        agentId: received.agentId,
        target: received.target,
        agentState: supervisorState.state,
        sessionId: supervisorState.sessionId,
        processId: supervisorState.processId,
        machineId: this.machineId,
      },
    });

    if (shouldQueueForStart(supervisorState.state)) {
      this.startCoordinator.enqueue({
        workspaceId: accepted.workspaceId,
        agentId: accepted.agentId,
        machineId: this.machineId,
        reason: "delivery",
      });
      this.supervisor.bufferDelivery(accepted.agentId, accepted.id);
      return this.ledger.transition(accepted.id, "queued_starting", {
        eventName: "delivery.queued_starting",
        attributes: { agentState: supervisorState.state },
        runtimeOutcome: "queued_during_start",
      });
    }

    if (deferAcceptedDelivery || supervisorState.busy || supervisorState.queueDepth > 0 || shouldQueueForGate(supervisorState.state)) {
      this.supervisor.markGated(accepted.agentId);
      this.supervisor.bufferDelivery(accepted.agentId, accepted.id);
      const queued = await this.ledger.transition(accepted.id, "queued_gated", {
        eventName: "delivery.queued_gated",
        attributes: { agentState: supervisorState.state, queueDepth: this.supervisor.getState(accepted.agentId).queueDepth },
        runtimeOutcome: "queued_busy_gated",
      });
      this.supervisor.markRuntimeProgressStale(queued.agentId, queued.updatedAt);
      const queuedState = this.supervisor.getState(queued.agentId);
      await this.notifyQueuedGated({
        agentId: queued.agentId,
        deliveryId: queued.id,
        agentState: supervisorState.state,
        queueDepth: queuedState.queueDepth,
        runtimeProgressStaleSince: queuedState.runtimeProgressStaleSince,
      });
      return queued;
    }

    return this.deliverNow(accepted);
  }

  async deliverNow(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    const delivering = await this.ledger.transition(delivery.id, "delivering", {
      eventName: "delivery.delivering",
      attributes: { agentId: delivery.agentId, target: delivery.target },
    });

    try {
      await this.driver.setCurrentDelivery?.(delivering.agentId, {
        deliveryId: delivering.id,
        deliverySeq: delivering.deliverySeq,
        traceparent: delivering.traceparent,
        target: delivering.target,
        channelId: delivering.channelId,
        sourceMessageId: delivering.sourceMessageId,
        threadParentId: delivering.threadParentId,
        taskId: delivering.taskId,
        messageCreatedAt: delivering.sourceCreatedAt,
      });
      await this.driver.deliver(delivering.agentId, withDeliveryHeader(delivering));
    } catch (error) {
      const lastError = serializeDeliveryError(error);
      await this.ledger.transition(delivering.id, "failed", {
        eventName: "delivery.failed",
        attributes: { error: lastError },
        lastError,
      });
      throw error;
    }

    return this.ledger.transition(delivering.id, "delivered", {
      eventName: "delivery.delivered",
      attributes: { agentId: delivering.agentId, target: delivering.target },
      runtimeOutcome: "stdin_idle_delivery",
    });
  }

  async flushQueuedDeliveries(agentId: string, reason: "idle" | "turn_end"): Promise<RuntimeDeliveryRecord[]> {
    return this.runAgentOperation(agentId, () => this.flushQueuedDeliveriesUnlocked(agentId, reason));
  }

  async pumpStarts(starter: StartStarter): Promise<void> {
    await this.startCoordinator.pump(starter);
  }

  private async notifyQueuedGated(event: QueuedGatedVisibilityEvent): Promise<void> {
    if (!this.onQueuedGated) return;

    try {
      await this.onQueuedGated(event);
    } catch (error) {
      console.warn("[DeliveryRuntime] Failed to report gated backlog visibility", serializeDeliveryError(error));
    }
  }

  private async flushQueuedDeliveriesUnlocked(agentId: string, _reason: "idle" | "turn_end"): Promise<RuntimeDeliveryRecord[]> {
    const supervisorState = this.supervisor.getState(agentId);
    if (!canFlushQueuedDeliveries(supervisorState)) return [];

    const deliveryIds = this.supervisor.drainInbox(agentId, 1);
    const delivered: RuntimeDeliveryRecord[] = [];

    for (const deliveryId of deliveryIds) {
      const delivery = await this.ledger.getDelivery(deliveryId);
      if (!delivery) continue;
      delivered.push(await this.deliverNow(delivery));
    }

    return delivered;
  }

  private async runAgentOperation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentOperations.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.agentOperations.set(agentId, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.agentOperations.get(agentId) === queued) {
        this.agentOperations.delete(agentId);
      }
    }
  }

  startQueueSnapshot(): StartQueueEntry[] {
    return this.startCoordinator.snapshot();
  }
}

function shouldFlushQueuedBeforeAccept(state: ReturnType<AgentSupervisor["getState"]>): boolean {
  return canAcceptCustody(state) && !state.busy && state.queueDepth > 0 && !shouldQueueForStart(state.state) && !shouldQueueForGate(state.state);
}

function canFlushQueuedDeliveries(state: ReturnType<AgentSupervisor["getState"]>): boolean {
  return canAcceptCustody(state) && !shouldQueueForStart(state.state);
}

function canAcceptCustody(state: ReturnType<AgentSupervisor["getState"]>): boolean {
  if (state.state === "starting") return true;
  if (state.state === "stopped" || state.state === "stale" || state.state === "failed") return false;
  return hasRuntimeIdentity(state);
}

function hasRuntimeIdentity(state: ReturnType<AgentSupervisor["getState"]>): boolean {
  return state.sessionId !== null || state.processId !== null;
}

function shouldQueueForStart(state: SupervisorAgentState): boolean {
  return state === "starting";
}

function shouldQueueForGate(state: SupervisorAgentState): boolean {
  return state === "busy" || state === "gated";
}

const DAEMON_HEADER_KEYS = new Set(["target", "delivery", "seq", "traceparent", "msg", "time", "sourceCreatedAt", "sender", "type"]);
const SAFE_EXISTING_FIELD_PATTERN = /^[A-Za-z0-9_.-]+=[^\s\[\]\r\n]+$/;
const UNSAFE_HEADER_VALUE_PATTERN = /[\s\[\]\x00-\x1f\x7f]+/g;
function withDeliveryHeader(delivery: RuntimeDeliveryRecord): string {
  const fields = buildDeliveryHeaderFields(delivery);
  const existingHeader = delivery.prompt.match(/^\[([^\]\r\n]*)\](\n?)([\s\S]*)$/);
  if (existingHeader) {
    const [, headerBody, newline, body] = existingHeader;
    const preservedFields = canonicalizeExistingHeaderFields(headerBody);
    return `[${[...fields, ...preservedFields].join(" ")}]${newline}${body}`;
  }

  return `[${fields.join(" ")}]\n${delivery.prompt}`;
}

function buildDeliveryHeaderFields(delivery: RuntimeDeliveryRecord): string[] {
  return [
    ["target", delivery.target],
    ["delivery", shortId(delivery.id)],
    ["seq", String(delivery.deliverySeq)],
    ["traceparent", delivery.traceparent],
    ["msg", shortId(delivery.sourceMessageId)],
    ["time", delivery.sourceCreatedAt],
    ["sender", delivery.senderId],
    ["type", delivery.senderType],
  ].map(([key, value]) => `${key}=${sanitizeHeaderValue(value)}`);
}

function canonicalizeExistingHeaderFields(headerBody: string): string[] {
  return headerBody
    .split(/\s+/)
    .filter((field) => {
      if (!SAFE_EXISTING_FIELD_PATTERN.test(field)) return false;
      const key = field.slice(0, field.indexOf("="));
      return !DAEMON_HEADER_KEYS.has(key);
    });
}

function sanitizeHeaderValue(value: string): string {
  const sanitized = value.replace(UNSAFE_HEADER_VALUE_PATTERN, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function serializeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(`${error.name}: ${error.message}`);
  }

  if (error && typeof error === "object") {
    try {
      return redactSensitiveText(JSON.stringify(redactTraceAttributes(error)));
    } catch {
      return redactSensitiveText(String(error));
    }
  }

  return redactSensitiveText(String(error));
}

function redactSensitiveText(value: string): string {
  return redactRuntimeText(value);
}
