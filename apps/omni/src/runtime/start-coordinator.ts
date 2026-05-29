import { randomUUID } from "node:crypto";

import { redactTraceAttributes, type StartQueueEntry } from "./types.js";

export interface StartCoordinatorOptions {
  maxConcurrentStarts: number;
  startIntervalMs: number;
  now?: () => string;
}

export interface EnqueueStartInput {
  workspaceId: string;
  agentId: string;
  machineId: string;
  reason: string;
}

export type StartStarter = (entry: StartQueueEntry) => Promise<void> | void;

export class StartCoordinator {
  private readonly entries: StartQueueEntry[] = [];
  private activeStarts = 0;
  private lastStartAt: number | null = null;
  private readonly now: () => string;

  constructor(private readonly options: StartCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  enqueue(input: EnqueueStartInput): StartQueueEntry {
    const dedupeKey = buildStartDedupeKey(input);
    const existing = this.entries.find(
      (entry) => entry.dedupeKey === dedupeKey && (entry.state === "queued" || entry.state === "starting"),
    );

    if (existing) return cloneEntry(existing);

    const entry: StartQueueEntry = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      machineId: input.machineId,
      reason: input.reason,
      state: "queued",
      dedupeKey,
      requestedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      lastError: null,
      metadata: {},
    };

    this.entries.push(entry);
    return cloneEntry(entry);
  }

  async pump(starter: StartStarter): Promise<void> {
    if (this.activeStarts >= this.options.maxConcurrentStarts) return;

    const now = this.now();
    const nowMs = Date.parse(now);
    if (
      this.lastStartAt !== null &&
      this.options.startIntervalMs > 0 &&
      Number.isFinite(nowMs) &&
      nowMs - this.lastStartAt < this.options.startIntervalMs
    ) {
      return;
    }

    const entry = this.entries.find((candidate) => candidate.state === "queued");
    if (!entry) return;

    entry.state = "starting";
    entry.startedAt = now;
    entry.lastError = null;
    this.activeStarts += 1;
    this.lastStartAt = Number.isFinite(nowMs) ? nowMs : Date.now();

    try {
      await starter(cloneEntry(entry));
      entry.state = "started";
      entry.finishedAt = this.now();
    } catch (error) {
      entry.state = "failed";
      entry.finishedAt = this.now();
      entry.lastError = serializeStartError(error);
    } finally {
      this.activeStarts -= 1;
    }
  }

  snapshot(): StartQueueEntry[] {
    return this.entries.map(cloneEntry);
  }
}

function buildStartDedupeKey(input: EnqueueStartInput): string {
  return JSON.stringify([input.workspaceId, input.agentId, input.machineId, input.reason]);
}

function serializeStartError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error);

  const redacted = redactTraceAttributes(error);
  try {
    return JSON.stringify(redacted);
  } catch {
    return String(redacted);
  }
}

function cloneEntry(entry: StartQueueEntry): StartQueueEntry {
  return {
    ...entry,
    metadata: structuredClone(entry.metadata),
  };
}
