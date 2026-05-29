import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CliTransportMaterializer, type CliTransportInput } from "./cli-transport";

const requireFromBridgeTest = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(requireFromBridgeTest.resolve("tsx")).href;
const cliSourcePath = fileURLToPath(new URL("../../../../packages/cli/src/index.ts", import.meta.url));

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function validInput(overrides: Partial<CliTransportInput> = {}): CliTransportInput {
  return {
    agentId: "agent-1",
    launchId: "launch-1",
    serverUrl: "https://zano.example.test",
    cliEntrypoint: "/repo/packages/cli/src/index.ts",
    mode: "tsx",
    ...overrides,
  };
}

describe("CliTransportMaterializer", () => {
  it("rejects unsafe agent IDs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });

    expect(() => materializer.materialize(validInput({ agentId: "../agent" }))).toThrow(/Unsafe CLI transport path segment: agentId/);
  });

  it("rejects unsafe launch IDs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });

    expect(() => materializer.materialize(validInput({ launchId: "../launch" }))).toThrow(/Unsafe CLI transport path segment: launchId/);
  });

  it("materializes the wrapper and credential files under the agent .zano directory without inlining tokens", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });
    const fakeAgentToken = "fake-agent-token-for-task-8";
    const fakeSupabaseKey = "fake-supabase-key-for-task-8";
    const result = materializer.materialize(validInput({ agentToken: fakeAgentToken, supabaseKey: fakeSupabaseKey }));
    const zanoDir = join(rootDir, "agents", "agent-1", ".zano");

    expect(result.wrapperPath).toBe(join(zanoDir, "zano"));
    expect(result.pathDir).toBe(zanoDir);
    expect(result.tokenFilePath).toBe(join(zanoDir, "agent-token"));
    expect(result.proxyTokenFilePath).toBeNull();
    expect(result.supabaseKeyFilePath).toBe(join(zanoDir, "supabase-key"));
    expect(readFileSync(result.tokenFilePath!, "utf8")).toBe(fakeAgentToken);
    expect(readFileSync(result.supabaseKeyFilePath!, "utf8")).toBe(fakeSupabaseKey);
    expect(statSync(result.tokenFilePath!).mode & 0o777).toBe(0o600);
    expect(statSync(result.supabaseKeyFilePath!).mode & 0o777).toBe(0o600);
    expect(result.body).toContain(`export ZANO_HOME=${shellQuote(zanoDir)}`);
    expect(result.body).toContain(`export ZANO_AGENT_ID=${shellQuote("agent-1")}`);
    expect(result.body).toContain(`export ZANO_AGENT_LAUNCH_ID=${shellQuote("launch-1")}`);
    expect(result.body).toContain(`export ZANO_SERVER_URL=${shellQuote("https://zano.example.test")}`);
    expect(result.body).toContain(`export ZANO_AGENT_LOCAL_STATE=${shellQuote(join(zanoDir, "state.json"))}`);
    expect(result.body).toContain(`export ZANO_AGENT_TOKEN_FILE=${shellQuote(join(zanoDir, "agent-token"))}`);
    expect(result.body).toContain(`export ZANO_SUPABASE_KEY_FILE=${shellQuote(join(zanoDir, "supabase-key"))}`);
    expect(result.body).not.toContain(fakeAgentToken);
    expect(result.body).not.toContain(fakeSupabaseKey);
    expect(readFileSync(result.wrapperPath, "utf8")).toBe(result.body);
    expect(result.wrapperHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(zanoDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("executes the wrapper CLI bootstrap with Task 8 file-reference env only", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: process.execPath });
    const fakeAgentToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudC0xIiwiYWN0b3JfaWQiOiJhZ2VudC0xIiwiYWN0b3JfdHlwZSI6ImFnZW50Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.signature";
    const fakeSupabaseKey = "fake-supabase-key-for-wrapper-exec";
    const result = materializer.materialize(validInput({
      agentToken: fakeAgentToken,
      supabaseKey: fakeSupabaseKey,
      cliEntrypoint: cliSourcePath,
      serverUrl: "https://supabase.example.test",
    }));

    const completed = spawnSync(result.wrapperPath, ["agent", "local-state"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stderr).not.toContain(fakeAgentToken);
    expect(completed.stderr).not.toContain(fakeSupabaseKey);
    expect(completed.stdout).not.toContain(fakeAgentToken);
    expect(completed.stdout).not.toContain(fakeSupabaseKey);
    expect(JSON.parse(completed.stdout)).toEqual({
      ok: true,
      localState: join(rootDir, "agents", "agent-1", ".zano", "state.json"),
    });
  });

  it("materializes proxy credentials under root-scoped proxy-token storage without writing a direct agent token", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });
    const fakeProxyToken = "fake-proxy-token-for-task-8";
    const fakeSupabaseKey = "fake-supabase-key-for-proxy-mode";
    const result = materializer.materialize(validInput({
      supabaseKey: fakeSupabaseKey,
      credentialProxy: {
        proxyUrl: "https://proxy.example.test/credential",
        proxyToken: fakeProxyToken,
        activeCapabilities: ["runtime_profile_migration_done"],
      },
    }));
    const zanoDir = join(rootDir, "agents", "agent-1", ".zano");
    const proxyTokenPath = join(rootDir, "agent-proxy-tokens", "agent-1", "launch-1.token");

    expect(result.wrapperPath).toBe(join(zanoDir, "zano"));
    expect(result.pathDir).toBe(zanoDir);
    expect(result.tokenFilePath).toBeNull();
    expect(existsSync(join(zanoDir, "agent-token"))).toBe(false);
    expect(result.proxyTokenFilePath).toBe(proxyTokenPath);
    expect(result.supabaseKeyFilePath).toBe(join(zanoDir, "supabase-key"));
    expect(readFileSync(proxyTokenPath, "utf8")).toBe(fakeProxyToken);
    expect(readFileSync(result.supabaseKeyFilePath!, "utf8")).toBe(fakeSupabaseKey);
    expect(statSync(proxyTokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.supabaseKeyFilePath!).mode & 0o777).toBe(0o600);
    expect(result.body).toContain(`export ZANO_AGENT_PROXY_URL=${shellQuote("https://proxy.example.test/credential")}`);
    expect(result.body).toContain(`export ZANO_AGENT_PROXY_TOKEN_FILE=${shellQuote(proxyTokenPath)}`);
    expect(result.body).toContain(`export ZANO_SUPABASE_KEY_FILE=${shellQuote(join(zanoDir, "supabase-key"))}`);
    expect(result.body).toContain(`export ZANO_AGENT_ACTIVE_CAPABILITIES=${shellQuote(JSON.stringify(["runtime_profile_migration_done"]))}`);
    expect(result.body).toContain("ZANO_AGENT_LOCAL_STATE");
    expect(result.body).not.toContain(fakeProxyToken);
    expect(result.body).not.toContain(fakeSupabaseKey);
    expect(readdirSync(join(rootDir, "agent-proxy-tokens", "agent-1")).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("shell-quotes node, tsx loader, CLI, and state paths", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano wrapper 'root'-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/opt/node bins/node '20'/bin/node" });
    const result = materializer.materialize(validInput({ cliEntrypoint: "/repo/cli apps/zano 'cli'/src/index.ts" }));

    expect(result.body).toContain(`export ZANO_AGENT_LOCAL_STATE=${shellQuote(`${rootDir}/agents/agent-1/.zano/state.json`)}`);
    expect(result.body).toContain(`exec ${shellQuote("/opt/node bins/node '20'/bin/node")} --import `);
    expect(result.body).toContain(`--import ${shellQuote(tsxImportUrl)}`);
    expect(result.body).toContain(`${shellQuote("/repo/cli apps/zano 'cli'/src/index.ts")} "$@"`);
  });

  it("uses custom agentsDir for wrapper and local state paths", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-root-"));
    const agentsDir = mkdtempSync(join(tmpdir(), "zano-custom-agents-"));
    const materializer = new CliTransportMaterializer({ rootDir, agentsDir, nodePath: "/usr/local/bin/node" });
    const result = materializer.materialize(validInput());

    expect(result.wrapperPath).toBe(join(agentsDir, "agent-1", ".zano", "zano"));
    expect(result.pathDir).toBe(join(agentsDir, "agent-1", ".zano"));
    expect(result.body).toContain(`export ZANO_AGENT_LOCAL_STATE=${shellQuote(join(agentsDir, "agent-1", ".zano", "state.json"))}`);
  });

  it("writes a wrapper that does not inline raw auth environment variables", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });
    const fakeSupabaseKey = "fake-supabase-key-for-redaction";
    const result = materializer.materialize(validInput({ supabaseKey: fakeSupabaseKey }));
    const body = readFileSync(result.wrapperPath, "utf8");

    expect(body).toContain("exec");
    expect(body).toContain("ZANO_AGENT_LOCAL_STATE");
    expect(body).toContain("ZANO_SUPABASE_KEY_FILE=");
    expect(body).not.toContain(fakeSupabaseKey);
    expect(body).not.toContain("ZANO_API_KEY=");
    expect(body).not.toContain("ZANO_AUTH_TOKEN=");
    expect(body).not.toContain("ZANO_AGENT_AUTH_TOKEN=");
    expect(body).not.toContain("ZANO_SUPABASE_KEY=");
    expect(body).not.toContain("SUPABASE_SERVICE_ROLE_KEY=");
    expect(body).not.toContain("SUPABASE_JWT_SECRET=");
    expect(body).toContain(`--import ${shellQuote(tsxImportUrl)}`);
    expect(body).not.toContain("--import tsx");
    expect(body).not.toContain("--loader tsx");
    expect(result.tokenFilePath).toBeNull();
    expect(result.proxyTokenFilePath).toBeNull();
    expect(result.wrapperHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes an existing non-executable wrapper executable", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const wrapperDir = join(rootDir, "agents", "agent-1", ".zano");
    const wrapperPath = join(wrapperDir, "zano");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapperPath, "old wrapper", { mode: 0o644 });
    chmodSync(wrapperPath, 0o644);

    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });
    materializer.materialize(validInput());

    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
    expect(readdirSync(wrapperDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
