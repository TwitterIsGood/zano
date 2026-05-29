import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTraceSink } from "./local-trace-sink";

describe("LocalTraceSink", () => {
  it("writes redacted JSONL trace events", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-traces-"));
    const sink = new LocalTraceSink({ traceDir: rootDir, filePrefix: "daemon-trace", now: () => new Date("2026-05-22T01:02:03.000Z") });

    const path = sink.write({
      id: "event-1",
      workspaceId: "server-1",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: null,
      deliveryId: "delivery-1",
      agentId: "agent-1",
      eventType: "delivery",
      eventName: "delivery.received",
      severity: "info",
      attributes: { token: "secret", safe: "visible" },
      createdAt: "2026-05-22T01:02:03.000Z",
    });

    const line = readFileSync(path, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      eventName: "delivery.received",
      attributes: { token: "[REDACTED]", safe: "visible" },
    });
  });

  it("keeps unsafe file prefixes inside the trace directory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-traces-"));
    const sink = new LocalTraceSink({ traceDir: rootDir, filePrefix: "../../escape", now: () => new Date("2026-05-22T01:02:03.000Z") });

    const path = sink.currentPath();

    expect(dirname(path)).toBe(rootDir);
    expect(basename(path)).toMatch(/^[A-Za-z0-9_-]+-2026052201\.jsonl$/);
  });
});
