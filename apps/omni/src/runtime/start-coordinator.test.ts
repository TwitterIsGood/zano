import { describe, expect, it } from "vitest";
import { StartCoordinator } from "./start-coordinator";
import type { StartQueueEntry } from "./types.js";

describe("StartCoordinator", () => {
  it("dedupes starts for the same agent", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    const first = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    const second = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });

    expect(second.id).toBe(first.id);
    expect(coordinator.snapshot()).toHaveLength(1);
  });

  it("keeps delimiter-containing ids and machine boundaries distinct when deduping", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });

    const first = coordinator.enqueue({ workspaceId: "workspace:one", agentId: "agent", machineId: "machine-1", reason: "delivery" });
    const second = coordinator.enqueue({ workspaceId: "workspace", agentId: "one:agent", machineId: "machine-1", reason: "delivery" });
    const third = coordinator.enqueue({ workspaceId: "workspace:one", agentId: "agent", machineId: "machine-2", reason: "delivery" });

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(coordinator.snapshot()).toHaveLength(3);
  });

  it("records useful redacted failure errors and allows a later retry enqueue", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    const failed = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });

    await coordinator.pump(() => {
      throw { message: "boom", token: "secret-token", nested: { password: "secret-password", detail: "retryable" } };
    });

    const failedEntry = coordinator.snapshot()[0];
    expect(failedEntry.state).toBe("failed");
    expect(failedEntry.lastError).toContain("boom");
    expect(failedEntry.lastError).toContain("retryable");
    expect(failedEntry.lastError).toContain("[REDACTED]");
    expect(failedEntry.lastError).not.toContain("secret-token");
    expect(failedEntry.lastError).not.toContain("secret-password");
    expect(failedEntry.lastError).not.toBe("[object Object]");

    const retry = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    expect(retry.id).not.toBe(failed.id);
    expect(retry.state).toBe("queued");
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["failed", "queued"]);
  });

  it("gates immediate starts until the start interval has elapsed", async () => {
    let now = "2026-05-22T00:00:00.000Z";
    const started: string[] = [];
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 1_000, now: () => now });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-2", machineId: "machine-1", reason: "delivery" });

    await coordinator.pump((entry) => {
      started.push(entry.agentId);
    });
    now = "2026-05-22T00:00:00.100Z";
    await coordinator.pump((entry) => {
      started.push(entry.agentId);
    });
    now = "2026-05-22T00:00:01.000Z";
    await coordinator.pump((entry) => {
      started.push(entry.agentId);
    });

    expect(started).toEqual(["agent-1", "agent-2"]);
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["started", "started"]);
  });

  it("deep-clones metadata returned from enqueue, snapshot, and starter entries", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    const internalEntries = (coordinator as unknown as { entries: StartQueueEntry[] }).entries;
    internalEntries[0].metadata = { nested: { value: "internal" } };

    const enqueued = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    (enqueued.metadata.nested as { value: string }).value = "changed-by-enqueue";
    expect((coordinator.snapshot()[0].metadata.nested as { value: string }).value).toBe("internal");

    const snapshot = coordinator.snapshot()[0];
    (snapshot.metadata.nested as { value: string }).value = "changed-by-snapshot";
    expect((coordinator.snapshot()[0].metadata.nested as { value: string }).value).toBe("internal");

    await coordinator.pump((entry) => {
      (entry.metadata.nested as { value: string }).value = "changed-by-starter";
    });

    expect((coordinator.snapshot()[0].metadata.nested as { value: string }).value).toBe("internal");
  });

  it("respects max concurrent starts", async () => {
    const started: string[] = [];
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-2", machineId: "machine-1", reason: "delivery" });

    await coordinator.pump(async (entry) => {
      started.push(entry.agentId);
    });

    expect(started).toEqual(["agent-1"]);
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["started", "queued"]);
  });

  it("multiple simultaneous pumps do not exceed maxConcurrentStarts", async () => {
    const started: string[] = [];
    const releaseStarters: Array<() => void> = [];
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 2, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-2", machineId: "machine-1", reason: "delivery" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-3", machineId: "machine-1", reason: "delivery" });

    const pumps = Promise.all([
      coordinator.pump((entry) => new Promise<void>((resolve) => {
        started.push(entry.agentId);
        releaseStarters.push(resolve);
      })),
      coordinator.pump((entry) => new Promise<void>((resolve) => {
        started.push(entry.agentId);
        releaseStarters.push(resolve);
      })),
      coordinator.pump((entry) => new Promise<void>((resolve) => {
        started.push(entry.agentId);
        releaseStarters.push(resolve);
      })),
      coordinator.pump((entry) => new Promise<void>((resolve) => {
        started.push(entry.agentId);
        releaseStarters.push(resolve);
      })),
    ]);

    expect(started).toHaveLength(2);
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["starting", "starting", "queued"]);

    releaseStarters.forEach((release) => release());
    await pumps;

    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["started", "started", "queued"]);
  });

  it("enqueues a new queued entry after the previous matching entry has started", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    const first = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });

    await coordinator.pump(() => undefined);

    const restart = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    expect(restart.id).not.toBe(first.id);
    expect(restart.state).toBe("queued");
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["started", "queued"]);
  });
});
