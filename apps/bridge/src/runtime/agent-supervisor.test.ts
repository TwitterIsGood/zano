import { describe, expect, it } from "vitest";
import { AgentSupervisor } from "./agent-supervisor";

describe("AgentSupervisor", () => {
  it("reports missing agents as stopped with no process", () => {
    const supervisor = new AgentSupervisor();
    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "stopped",
      busy: false,
      queueDepth: 0,
      sessionId: null,
      processId: null,
    });
  });

  it("initializes Claude gated steering and inbox state for an agent", () => {
    const supervisor = new AgentSupervisor();
    supervisor.ensureAgent("agent-1", { runtime: "claude" });

    const snapshot = supervisor.getState("agent-1");

    expect(snapshot.runtimeProfile.runtime).toBe("claude");
    expect(snapshot.runtimeProfile.busyDeliveryMode).toBe("gated");
    expect(snapshot.gatedSteering.phase).toBe("idle");
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.pendingNotificationCount).toBe(0);
  });

  it("buffers gated deliveries in daemon-owned inbox", () => {
    const supervisor = new AgentSupervisor();
    supervisor.ensureAgent("agent-1", { runtime: "claude" });
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-2");

    const snapshot = supervisor.getState("agent-1");

    expect(snapshot.queueDepth).toBe(2);
    expect(snapshot.inboxDeliveryIds).toEqual(["delivery-1", "delivery-2"]);
  });

  it("records pending stdin notification count separately from full delivery queue", () => {
    const supervisor = new AgentSupervisor();
    supervisor.ensureAgent("agent-1", { runtime: "claude" });
    supervisor.markPendingNotification("agent-1", 3);

    expect(supervisor.getState("agent-1").pendingNotificationCount).toBe(3);
  });

  it("tracks runtime progress stale time until the gated inbox drains", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");

    supervisor.markRuntimeProgressStale("agent-1", "2026-05-22T00:00:01.000Z");
    supervisor.markRuntimeProgressStale("agent-1", "2026-05-22T00:00:02.000Z");

    expect(supervisor.getState("agent-1").runtimeProgressStaleSince).toBe("2026-05-22T00:00:01.000Z");

    supervisor.drainInbox("agent-1", 1);

    expect(supervisor.getState("agent-1")).toMatchObject({
      queueDepth: 0,
      runtimeProgressStaleSince: null,
    });
  });

  it("reports starting, busy, and gated states as busy", () => {
    const supervisor = new AgentSupervisor();
    supervisor.markStarting("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "starting", busy: true });

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markBusy("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "busy", busy: true, sessionId: "session-1" });

    supervisor.markGated("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "gated", busy: true, sessionId: "session-1" });
  });

  it("reports ready and idle states as not busy", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "ready", busy: false, sessionId: "session-1" });

    supervisor.markBusy("agent-1");
    supervisor.markIdle("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "idle", busy: false, sessionId: "session-1" });
  });

  it("reports null process ids when a ready agent has no process", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1" });

    expect(supervisor.getState("agent-1")).toMatchObject({ processId: null });
  });

  it("deduplicates gated deliveries and clears them after draining", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-2");

    expect(supervisor.getState("agent-1")).toMatchObject({ queueDepth: 2 });
    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual(["delivery-1", "delivery-2"]);
    expect(supervisor.getState("agent-1")).toMatchObject({ queueDepth: 0 });
    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual([]);
  });

  it("drains the first inbox delivery ids in order and reduces pending notifications", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-2");
    supervisor.bufferGatedDelivery("agent-1", "delivery-3");
    supervisor.markPendingNotification("agent-1", 3);

    expect(supervisor.drainInbox("agent-1", 2)).toEqual(["delivery-1", "delivery-2"]);
    expect(supervisor.getState("agent-1")).toMatchObject({
      inboxDeliveryIds: ["delivery-3"],
      pendingNotificationCount: 1,
      queueDepth: 1,
    });
  });

  it("does not reduce pending notifications below zero when draining more deliveries", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-2");
    supervisor.bufferGatedDelivery("agent-1", "delivery-3");
    supervisor.markPendingNotification("agent-1", 1);

    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual(["delivery-1", "delivery-2", "delivery-3"]);
    expect(supervisor.getState("agent-1").pendingNotificationCount).toBe(0);
  });

  it("preserves gated delivery ids when the same runtime registers ready again", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });

    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "ready",
      busy: false,
      queueDepth: 1,
      sessionId: "session-1",
      processId: 123,
    });
    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual(["delivery-1"]);
  });

  it("preserves gated delivery ids when the ready runtime session changes", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-2", processId: 123 });

    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "ready",
      busy: false,
      queueDepth: 1,
      sessionId: "session-2",
      processId: 123,
    });
    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual(["delivery-1"]);
  });

  it("can reset pending notifications while preserving queued deliveries when a ready runtime boundary changes", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");
    supervisor.markPendingNotification("agent-1", 1);

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-2", processId: 456 });

    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "ready",
      queueDepth: 1,
      pendingNotificationCount: 0,
      sessionId: "session-2",
      processId: 456,
    });
  });

  it("preserves gated delivery ids when the ready runtime process changes", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 456 });

    expect(supervisor.getState("agent-1")).toMatchObject({
      state: "ready",
      busy: false,
      queueDepth: 1,
      sessionId: "session-1",
      processId: 456,
    });
    expect(supervisor.drainGatedDeliveries("agent-1")).toEqual(["delivery-1"]);
  });

  it("clears runtime identity when marking an agent starting, failed, or stale", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });

    supervisor.markStarting("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "starting", sessionId: null, processId: null });

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-2", processId: 456 });
    supervisor.markFailed("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "failed", sessionId: null, processId: null });

    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-3", processId: 789 });
    supervisor.markStale("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "stale", sessionId: null, processId: null });
  });

  it("preserves runtime identity when marking an agent busy, gated, or idle", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });

    supervisor.markBusy("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "busy", sessionId: "session-1", processId: 123 });

    supervisor.markGated("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "gated", sessionId: "session-1", processId: 123 });

    supervisor.markIdle("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "idle", sessionId: "session-1", processId: 123 });
  });

  it("prevents snapshot gated steering event detail mutations from affecting supervisor state", () => {
    const supervisor = new AgentSupervisor();
    supervisor.recordGatedEvent("agent-1", { type: "tool_call", toolUseId: "tool-1" });

    const snapshot = supervisor.getState("agent-1");
    snapshot.gatedSteering.recentEvents[0]!.detail.toolUseId = "mutated-tool";

    expect(supervisor.getState("agent-1").gatedSteering.recentEvents[0]!.detail.toolUseId).toBe("tool-1");
  });
});
