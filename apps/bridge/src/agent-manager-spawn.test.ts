import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

import { AgentManager } from "./agent-manager";

const localCliSourcePath = fileURLToPath(new URL("../../../packages/cli/src/index.ts", import.meta.url));

function createProcessMock() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    killed: boolean;
    exitCode: number | null;
  };
  proc.pid = 456;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn() };
  proc.killed = false;
  proc.exitCode = null;
  return proc;
}

function createSupabaseStub() {
  return {
    channel: () => ({
      subscribe: () => undefined,
      send: () => undefined,
    }),
    removeChannel: () => undefined,
    from: (table: string) => {
      if (table !== "agents") throw new Error(`Unexpected table: ${table}`);
      const query = {
        select: () => query,
        update: () => query,
        eq: () => query,
        single: async () => ({ data: { session_id: null }, error: null }),
      };
      return query;
    },
  };
}

const staleRuntimeEnv = {
  ZANO_HOME: "/tmp/stale-home",
  ZANO_AGENT_ID: "stale-agent",
  ZANO_AGENT_LAUNCH_ID: "stale-launch",
  ZANO_SERVER_URL: "https://stale-server.example.test",
  ZANO_AGENT_LOCAL_STATE: "/tmp/stale-state.json",
  ZANO_AGENT_TOKEN_FILE: "/tmp/stale-agent-token",
  ZANO_AGENT_PROXY_URL: "https://stale-proxy.example.test",
  ZANO_AGENT_PROXY_TOKEN_FILE: "/tmp/stale-proxy-token",
  ZANO_AGENT_ACTIVE_CAPABILITIES: JSON.stringify(["stale"]),
  ZANO_AUTH_TOKEN: "stale-raw-auth-token",
  ZANO_AGENT_AUTH_TOKEN: "stale-raw-agent-token",
  ZANO_SUPABASE_KEY: "stale-supabase-key",
  ZANO_SUPABASE_KEY_FILE: "/tmp/stale-supabase-key-file",
} as const;

async function withRuntimeEnv<T>(patch: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previous: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const key of Object.keys(patch)) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function spawnForTest(manager: AgentManager, workDir: string) {
  await (manager as unknown as {
    spawnProcess(
      agentId: string,
      session: { id: string; name: string; displayName: string; workDir: string; serverId?: string },
      agent: { id: string; name: string; display_name: string; description: null; system_prompt: null; model: string; status: string; server_id: string },
      memoryContext: string,
      autonomousSkillContext: string,
      systemPrompt: string,
      model: string,
    ): Promise<unknown>;
  }).spawnProcess(
    "agent-1",
    { id: "agent-1", name: "agent-1", displayName: "Agent One", workDir, serverId: "workspace-1" },
    { id: "agent-1", name: "agent-1", display_name: "Agent One", description: null, system_prompt: null, model: "opus", status: "active", server_id: "workspace-1" },
    "# Memory\n",
    "",
    "fallback prompt",
    "opus",
  );
}

describe("AgentManager Claude spawn", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.spawn.mockReturnValue(createProcessMock());
  });

  it("prefers the monorepo CLI source when spawning from local source", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const workDir = join(rootDir, "work", "agent-1");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "fake-agent-token" },
    );
    manager.configureDaemonRuntime({
      workspaceId: "workspace-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      bridgeVersion: "0.1.5",
      runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
    }, null);

    await spawnForTest(manager, workDir);

    const wrapperBody = readFileSync(join(agentsDir, "agent-1", ".zano", "zano"), "utf8");
    expect(wrapperBody).toContain(localCliSourcePath);
    expect(wrapperBody).not.toContain("@fehey/zano-cli");
  });

  it("passes the materialized MCP config path to Claude without inherited credential refs", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const workDir = join(rootDir, "work", "agent-1");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "fake-agent-token" },
    );
    manager.configureDaemonRuntime({
      workspaceId: "workspace-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      bridgeVersion: "0.1.5",
      runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
    }, null);

    await withRuntimeEnv(staleRuntimeEnv, () => spawnForTest(manager, workDir));

    const [, args, options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const mcpConfigIndex = args.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBeGreaterThan(-1);
    expect(args[mcpConfigIndex + 1]).toBe(join(workDir, ".zano", "claude-mcp-config.json"));
    expect(JSON.stringify(args)).not.toContain("fake-agent-token");
    expect(JSON.stringify(args)).not.toContain("fake-bridge-token");
    expect(options.env.ZANO_HOME).toBe(join(agentsDir, "agent-1", ".zano"));
    expect(options.env.ZANO_AGENT_TOKEN_FILE).toBe(join(agentsDir, "agent-1", ".zano", "agent-token"));
    expect(options.env.ZANO_SUPABASE_KEY_FILE).toBe(join(agentsDir, "agent-1", ".zano", "supabase-key"));
    expect(readFileSync(options.env.ZANO_SUPABASE_KEY_FILE, "utf8")).toBe("fake-anon-key");
    expect(options.env.ZANO_AGENT_PROXY_URL).toBeUndefined();
    expect(options.env.ZANO_AGENT_PROXY_TOKEN_FILE).toBeUndefined();
    expect(options.env.ZANO_AGENT_ACTIVE_CAPABILITIES).toBeUndefined();
    expect(options.env.ZANO_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ZANO_AGENT_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ZANO_SUPABASE_KEY).toBeUndefined();
    expect(JSON.stringify(options.env)).not.toContain("fake-anon-key");
    expect(JSON.stringify(options.env)).not.toContain("stale");
  });

  it("does not fall back to the bridge token when an agent token is missing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const workDir = join(rootDir, "work", "agent-1");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      {},
    );
    manager.configureDaemonRuntime({
      workspaceId: "workspace-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      bridgeVersion: "0.1.5",
      runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
    }, null);

    await withRuntimeEnv(staleRuntimeEnv, () => spawnForTest(manager, workDir));

    const [, , options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ZANO_AGENT_TOKEN_FILE).toBeUndefined();
    expect(JSON.stringify(options.env)).not.toContain("fake-bridge-token");
  });

  it("rewrites active agent token files when agent tokens refresh", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "initial-agent-token" },
    );

    await manager.initAgent("agent-1", { id: "agent-1", name: "agent-1", display_name: "Agent One", description: null, system_prompt: null, model: "opus", status: "active", server_id: "workspace-1" });
    manager.updateAgentAuthTokens({ "agent-1": "fresh-agent-token" });

    expect(readFileSync(join(agentsDir, "agent-1", ".zano", "agent-token"), "utf8")).toBe("fresh-agent-token");
  });

  it("restores refreshed agent token files with owner-only permissions", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "initial-agent-token" },
    );

    await manager.initAgent("agent-1", { id: "agent-1", name: "agent-1", display_name: "Agent One", description: null, system_prompt: null, model: "opus", status: "active", server_id: "workspace-1" });
    const tokenPath = join(agentsDir, "agent-1", ".zano", "agent-token");
    manager.updateAgentAuthTokens({});
    manager.updateAgentAuthTokens({ "agent-1": "restored-agent-token" });

    expect(readFileSync(tokenPath, "utf8")).toBe("restored-agent-token");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("removes materialized direct agent token files when stopping an agent", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "initial-agent-token" },
    );

    await manager.initAgent("agent-1", { id: "agent-1", name: "agent-1", display_name: "Agent One", description: null, system_prompt: null, model: "opus", status: "active", server_id: "workspace-1" });
    const tokenPath = join(agentsDir, "agent-1", ".zano", "agent-token");
    manager.updateAgentAuthTokens({ "agent-1": "fresh-agent-token" });

    expect(existsSync(tokenPath)).toBe(true);

    manager.stopAgent("agent-1", "Agent archived");

    expect(existsSync(tokenPath)).toBe(false);
  });

  it("removes materialized proxy token files when stopping an agent", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const workDir = join(agentsDir, "agent-1");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "fake-agent-token" },
    );
    manager.configureDaemonRuntime({
      workspaceId: "workspace-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      bridgeVersion: "0.1.5",
      runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
      credentialProxy: {
        proxyUrl: "https://proxy.example.test/credential",
        proxyTokens: { "agent-1": "fake-proxy-token" },
        activeCapabilities: ["runtime_profile_migration_done"],
      },
    }, null);

    await spawnForTest(manager, workDir);
    const [, , options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const proxyTokenPath = options.env.ZANO_AGENT_PROXY_TOKEN_FILE!;

    expect(existsSync(proxyTokenPath)).toBe(true);

    manager.stopAgent("agent-1", "Agent archived");

    expect(existsSync(proxyTokenPath)).toBe(false);
  });

  it("purges credential files for inactive agents without live sessions", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-active": "active-agent-token" },
    );
    const activeTokenPath = join(agentsDir, "agent-active", ".zano", "agent-token");
    const staleTokenPath = join(agentsDir, "agent-stale", ".zano", "agent-token");
    const activeProxyTokenPath = join(rootDir, "agent-proxy-tokens", "agent-active", "launch.token");
    const staleProxyTokenPath = join(rootDir, "agent-proxy-tokens", "agent-stale", "launch.token");

    for (const tokenPath of [activeTokenPath, staleTokenPath]) {
      mkdirSync(join(tokenPath, ".."), { recursive: true });
      writeFileSync(tokenPath, "token", { encoding: "utf8", mode: 0o600 });
    }
    for (const tokenPath of [activeProxyTokenPath, staleProxyTokenPath]) {
      mkdirSync(join(tokenPath, ".."), { recursive: true });
      writeFileSync(tokenPath, "proxy-token", { encoding: "utf8", mode: 0o600 });
    }

    manager.purgeCredentialsForInactiveAgents(["agent-active"]);

    expect(existsSync(activeTokenPath)).toBe(true);
    expect(existsSync(activeProxyTokenPath)).toBe(true);
    expect(existsSync(staleTokenPath)).toBe(false);
    expect(existsSync(staleProxyTokenPath)).toBe(false);
  });

  it("replaces stale inherited direct-token refs in proxy mode", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-agent-manager-spawn-"));
    const agentsDir = join(rootDir, "agents");
    const workDir = join(rootDir, "work", "agent-1");
    const manager = new AgentManager(
      agentsDir,
      createSupabaseStub() as never,
      "https://supabase.example.test",
      "fake-anon-key",
      "fake-bridge-token",
      { "agent-1": "fake-agent-token" },
    );
    manager.configureDaemonRuntime({
      workspaceId: "workspace-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      bridgeVersion: "0.1.5",
      runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
      credentialProxy: {
        proxyUrl: "https://proxy.example.test/credential",
        proxyTokens: { "agent-1": "fake-proxy-token" },
        activeCapabilities: ["runtime_profile_migration_done"],
      },
    }, null);

    await withRuntimeEnv(staleRuntimeEnv, () => spawnForTest(manager, workDir));

    const [, , options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ZANO_AGENT_TOKEN_FILE).toBeUndefined();
    expect(options.env.ZANO_SUPABASE_KEY_FILE).toBe(join(agentsDir, "agent-1", ".zano", "supabase-key"));
    expect(readFileSync(options.env.ZANO_SUPABASE_KEY_FILE, "utf8")).toBe("fake-anon-key");
    expect(options.env.ZANO_AGENT_PROXY_URL).toBe("https://proxy.example.test/credential");
    expect(options.env.ZANO_AGENT_PROXY_TOKEN_FILE).toBe(join(rootDir, "agent-proxy-tokens", "agent-1", `${options.env.ZANO_AGENT_LAUNCH_ID}.token`));
    expect(options.env.ZANO_AGENT_ACTIVE_CAPABILITIES).toBe(JSON.stringify(["runtime_profile_migration_done"]));
    expect(options.env.ZANO_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ZANO_AGENT_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ZANO_SUPABASE_KEY).toBeUndefined();
    expect(JSON.stringify(options.env)).not.toContain("fake-anon-key");
    expect(JSON.stringify(options.env)).not.toContain("stale");
  });
});
