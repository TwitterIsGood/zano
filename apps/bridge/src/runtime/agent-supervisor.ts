import { recordGatedSteeringEvent, createGatedSteeringState } from "./gated-steering";
import { getRuntimeDriverProfile } from "./runtime-profiles";
import type { ClaudeGatedSteeringEvent, GatedSteeringState, RuntimeDriverProfile, RuntimeKind } from "./types";

export type SupervisorAgentState =
  | "stopped"
  | "starting"
  | "ready"
  | "busy"
  | "gated"
  | "idle"
  | "stale"
  | "failed";

export interface SupervisorStateSnapshot {
  state: SupervisorAgentState;
  busy: boolean;
  queueDepth: number;
  sessionId: string | null;
  processId: number | null;
  runtimeProfile: RuntimeDriverProfile;
  gatedSteering: GatedSteeringState;
  inboxDeliveryIds: string[];
  pendingNotificationCount: number;
  runtimeProgressStaleSince: string | null;
  lastRuntimeEventAt: string | null;
  expectedTerminationReason: string | null;
}

interface SupervisorAgentEntry {
  state: SupervisorAgentState;
  sessionId: string | null;
  processId: number | null;
  runtimeProfile: RuntimeDriverProfile;
  gatedSteering: GatedSteeringState;
  inboxDeliveryIds: string[];
  pendingNotificationCount: number;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  runtimeProgressStaleSince: string | null;
  lastRuntimeEventAt: string | null;
  expectedTerminationReason: string | null;
}

export interface RegisterReadyInput {
  agentId: string;
  sessionId: string | null;
  processId?: number | null;
}

export class AgentSupervisor {
  private agents = new Map<string, SupervisorAgentEntry>();

  getState(agentId: string): SupervisorStateSnapshot {
    const entry = this.agents.get(agentId) ?? this.createEntry();

    return {
      state: entry.state,
      busy: entry.state === "starting" || entry.state === "busy" || entry.state === "gated",
      queueDepth: entry.inboxDeliveryIds.length,
      sessionId: entry.sessionId,
      processId: entry.processId,
      runtimeProfile: entry.runtimeProfile,
      gatedSteering: {
        ...entry.gatedSteering,
        recentEvents: entry.gatedSteering.recentEvents.map((event) => ({ ...event, detail: { ...event.detail } })),
        inFlightBatch: entry.gatedSteering.inFlightBatch ? [...entry.gatedSteering.inFlightBatch] : null,
      },
      inboxDeliveryIds: [...entry.inboxDeliveryIds],
      pendingNotificationCount: entry.pendingNotificationCount,
      runtimeProgressStaleSince: entry.runtimeProgressStaleSince,
      lastRuntimeEventAt: entry.lastRuntimeEventAt,
      expectedTerminationReason: entry.expectedTerminationReason,
    };
  }

  ensureAgent(agentId: string, options: { runtime?: RuntimeKind } = {}): void {
    this.ensure(agentId, options);
  }

  markStarting(agentId: string): void {
    this.set(agentId, { state: "starting", sessionId: null, processId: null });
  }

  registerReady(input: RegisterReadyInput): void {
    const entry = this.ensure(input.agentId);
    const nextProcessId = input.processId ?? null;
    const hasExistingRuntime = entry.sessionId !== null || entry.processId !== null;
    const runtimeBoundaryChanged = entry.sessionId !== input.sessionId || entry.processId !== nextProcessId;

    Object.assign(entry, {
      state: "ready" as const,
      sessionId: input.sessionId,
      processId: nextProcessId,
    });

    if (!hasExistingRuntime || runtimeBoundaryChanged) {
      entry.pendingNotificationCount = 0;
    }

    if (entry.inboxDeliveryIds.length === 0) {
      entry.runtimeProgressStaleSince = null;
    }
  }

  markBusy(agentId: string): void {
    this.set(agentId, { state: "busy" });
  }

  markGated(agentId: string): void {
    this.set(agentId, { state: "gated" });
  }

  markIdle(agentId: string): void {
    const entry = this.set(agentId, { state: "idle" });
    if (entry.inboxDeliveryIds.length === 0) {
      entry.runtimeProgressStaleSince = null;
    }
  }

  markStale(agentId: string): void {
    this.set(agentId, { state: "stale", sessionId: null, processId: null });
  }

  markFailed(agentId: string): void {
    this.set(agentId, { state: "failed", sessionId: null, processId: null });
  }

  bufferDelivery(agentId: string, deliveryId: string): void {
    const entry = this.ensure(agentId);
    if (!entry.inboxDeliveryIds.includes(deliveryId)) {
      entry.inboxDeliveryIds.push(deliveryId);
    }
  }

  bufferGatedDelivery(agentId: string, deliveryId: string): void {
    this.bufferDelivery(agentId, deliveryId);
  }

  drainInbox(agentId: string, limit = Number.POSITIVE_INFINITY): string[] {
    const entry = this.agents.get(agentId);
    if (!entry) return [];

    const deliveryIds = entry.inboxDeliveryIds.splice(0, limit);
    entry.pendingNotificationCount = Math.max(0, entry.pendingNotificationCount - deliveryIds.length);
    if (entry.inboxDeliveryIds.length === 0) {
      entry.runtimeProgressStaleSince = null;
    }
    return deliveryIds;
  }

  drainGatedDeliveries(agentId: string): string[] {
    return this.drainInbox(agentId);
  }

  markPendingNotification(agentId: string, count: number): void {
    this.ensure(agentId).pendingNotificationCount = count;
  }

  markRuntimeProgressStale(agentId: string, staleSince: string): void {
    const entry = this.ensure(agentId);
    entry.runtimeProgressStaleSince ??= staleSince;
  }

  recordGatedEvent(agentId: string, event: ClaudeGatedSteeringEvent): void {
    const entry = this.ensure(agentId);
    entry.gatedSteering = recordGatedSteeringEvent(entry.gatedSteering, event);
    entry.lastRuntimeEventAt = new Date().toISOString();
  }

  private createEntry(runtime: RuntimeKind = "claude"): SupervisorAgentEntry {
    return {
      state: "stopped",
      sessionId: null,
      processId: null,
      runtimeProfile: getRuntimeDriverProfile(runtime),
      gatedSteering: createGatedSteeringState(),
      inboxDeliveryIds: [],
      pendingNotificationCount: 0,
      notificationTimer: null,
      runtimeProgressStaleSince: null,
      lastRuntimeEventAt: null,
      expectedTerminationReason: null,
    };
  }

  private ensure(agentId: string, options: { runtime?: RuntimeKind } = {}): SupervisorAgentEntry {
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = this.createEntry(options.runtime ?? "claude");
      this.agents.set(agentId, entry);
    }
    return entry;
  }

  private set(
    agentId: string,
    update: Partial<Omit<SupervisorAgentEntry, "gatedSteering" | "inboxDeliveryIds" | "runtimeProfile">>,
  ): SupervisorAgentEntry {
    const entry = this.ensure(agentId);
    Object.assign(entry, update);
    return entry;
  }
}
