import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveRuntimeSessionRef } from "./runtime-session-ref.js";

describe("runtime session refs", () => {
  it("prefers native Claude session jsonl when reachable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "zano-claude-home-"));
    const projectDir = join(homeDir, ".claude", "projects", "repo");
    mkdirSync(projectDir, { recursive: true });
    const nativePath = join(projectDir, "session-123.jsonl");
    writeFileSync(nativePath, "{}\n", "utf8");

    const ref = resolveRuntimeSessionRef({
      runtime: "claude",
      sessionId: "session-123",
      homeDir,
      fallbackDir: join(homeDir, "fallback"),
      launchId: "launch-1",
    });

    expect(ref).toEqual({ path: nativePath, reachable: true, source: "native" });
  });

  it("writes fallback handoff when native session is not reachable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "zano-no-native-"));
    const fallbackDir = join(homeDir, ".zano", "runtime-sessions");

    const ref = resolveRuntimeSessionRef({
      runtime: "claude",
      sessionId: "session-404",
      homeDir,
      fallbackDir,
      launchId: "launch-2",
    });

    expect(ref.path).toBe(join(fallbackDir, "claude-launch-launch-2.jsonl"));
    expect(ref.reachable).toBe(false);
    expect(ref.source).toBe("fallback");
    const handoff = JSON.parse(readFileSync(ref.path, "utf8").trim()) as Record<string, unknown>;
    expect(handoff).toMatchObject({ runtime: "claude", sessionId: "session-404", launchId: "launch-2" });
  });

  it("prefers native Codex session jsonl when reachable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "zano-codex-home-"));
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "05");
    mkdirSync(sessionDir, { recursive: true });
    const nativePath = join(sessionDir, "codex-session-789.jsonl");
    writeFileSync(nativePath, "{}\n", "utf8");

    const ref = resolveRuntimeSessionRef({
      runtime: "codex",
      sessionId: "session-789",
      homeDir,
      fallbackDir: join(homeDir, "fallback"),
      launchId: "launch-3",
    });

    expect(ref).toEqual({ path: nativePath, reachable: true, source: "native" });
  });
});
