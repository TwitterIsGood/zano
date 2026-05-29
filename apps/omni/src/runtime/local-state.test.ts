import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLocalStateStore } from "./local-state";

describe("AgentLocalStateStore", () => {
  it("creates machine and agent planes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });

    const machine = store.ensureMachine({ omniVersion: "0.1.5", workspaceId: "server-1", hostname: "host", platform: "darwin", arch: "arm64" });
    const agent = store.ensureAgent({ agentId: "agent-1", displayName: "Alpha", description: "Builder" });

    expect(existsSync(machine.traceDir)).toBe(true);
    expect(existsSync(join(rootDir, "machines", "machine-test", "daemon.lock", "owner.json"))).toBe(true);
    expect(existsSync(agent.memoryPath)).toBe(true);
    expect(existsSync(agent.notesDir)).toBe(true);
    expect(agent.secretDir).toContain(join(".zano", "secrets"));
  });

  it("rejects unsafe machine path segments", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "../machine" });

    expect(() =>
      store.ensureMachine({ omniVersion: "0.1.5", workspaceId: "server-1", hostname: "host", platform: "darwin", arch: "arm64" }),
    ).toThrow(new Error("Unsafe local state path segment: machineId"));
  });

  it("rejects unsafe agent path segments", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });

    expect(() => store.ensureAgent({ agentId: "nested/agent", displayName: "Alpha", description: "Builder" })).toThrow(
      new Error("Unsafe local state path segment: agentId"),
    );
  });

  it("writes JSON atomically without leaving permanent temp files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });
    const targetPath = join(rootDir, "state.json");

    store.writeJson(targetPath, { status: "ready" });

    expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ status: "ready" });
    expect(readdirSync(rootDir).sort()).toEqual(["state.json"]);
  });

  it("writes JSON without leaking secret file contents into state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });
    const path = store.writeAgentState("agent-1", {
      status: "ready",
      token: "secret",
      oauth: { refreshToken: "r", clientSecret: "c" },
      privateKey: "k",
      credentials: { value: "v" },
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      status: "ready",
      token: "[REDACTED]",
      oauth: { refreshToken: "[REDACTED]", clientSecret: "[REDACTED]" },
      privateKey: "[REDACTED]",
      credentials: "[REDACTED]",
    });
  });
});
