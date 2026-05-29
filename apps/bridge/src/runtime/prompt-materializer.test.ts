import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptMaterializer } from "./prompt-materializer";
import { buildRuntimeProfileControlsPromptBlock } from "./runtime-profile-controls";

function validPromptInput(overrides: Partial<Parameters<PromptMaterializer["materialize"]>[0]> = {}): Parameters<PromptMaterializer["materialize"]>[0] {
  return {
    agentId: "agent-1",
    displayName: "Alpha",
    name: "alpha",
    description: "Builder",
    systemPrompt: "Prefer evidence.",
    memoryContext: "# Alpha\n",
    autonomousSkillContext: "",
    workspaceId: "server-1",
    workspaceName: "HTTP Workspace",
    machineId: "machine-1",
    hostname: "host",
    platform: "darwin",
    workDir: join(mkdtempSync(join(tmpdir(), "zano-agent-workdir-")), "agent-1"),
    bridgeVersion: "0.1.5",
    model: "opus",
    runtimeControlMcpUrl: "http://127.0.0.1:8732/runtime-control/mcp",
    ...overrides,
  };
}

function materializeTestPrompt(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-"));
  const workDir = join(rootDir, "agents", "agent-1");
  const materializer = new PromptMaterializer({ rootDir });
  const result = materializer.materialize(validPromptInput({ workDir }));

  return readFileSync(result.promptPath, "utf8");
}

describe("PromptMaterializer", () => {
  it("includes the strict Slock-like teammate contract sections", () => {
    const prompt = materializeTestPrompt();

    expect(prompt).toContain("Who you are");
    expect(prompt).toContain("Current Runtime Context");
    expect(prompt).toContain("Communication — zano CLI ONLY");
    expect(prompt).toContain("Startup sequence");
    expect(prompt).toContain("Message Notifications");
    expect(prompt).toContain("Threads");
    expect(prompt).toContain("Tasks");
    expect(prompt).toContain("@Mentions");
    expect(prompt).toContain("Reading history / search / check");
    expect(prompt).toContain("Freshness holds");
    expect(prompt).toContain("Runtime Profile Controls");
    expect(prompt).toContain("todo -> in_progress -> blocked -> in_progress -> in_review -> changes_requested -> in_progress -> done");
    expect(prompt).toContain("A progress update is not completion");
    expect(prompt).toContain("If a blocker, failed review, or decision request would leave someone waiting");
    expect(prompt).toContain("Reminders and future follow-up");
    expect(prompt).toContain("Wake-up does not always require a visible reply");
    expect(prompt).toContain("Never write secrets into memory, notes, messages, or logs");
  });

  it("rejects unsafe agent IDs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-"));
    const materializer = new PromptMaterializer({ rootDir });

    expect(() => materializer.materialize(validPromptInput({ agentId: "../agent" }))).toThrow(/Unsafe prompt materializer path segment: agentId/);
  });

  it("writes daemon-aware prompt and runtime-control MCP config under the agent workspace .zano directory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-"));
    const workDir = join(rootDir, "agents", "agent-1");
    const materializer = new PromptMaterializer({ rootDir });
    const result = materializer.materialize(validPromptInput({ workDir }));

    expect(result.promptPath).toBe(join(workDir, ".zano", "claude-system-prompt.md"));
    expect(result.mcpConfigPath).toBe(join(workDir, ".zano", "claude-mcp-config.json"));
    expect(result.currentPromptPath).toBe(result.promptPath);
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);

    const content = readFileSync(result.promptPath, "utf8");
    expect(content).toContain("Communication — zano CLI ONLY");
    expect(content).toContain(buildRuntimeProfileControlsPromptBlock());
    expect(content).toContain("runtime_profile_migration_done");
    expect(content).toContain("delivery=<delivery-short-id>");
    expect(content).toContain("seq=<per-agent-seq>");
    expect(content).toContain("traceparent=<traceparent>");
    expect(content).toContain("`target=` is the canonical CLI address for replies");
    expect(content).toContain("zano message send --target");
    expect(content).toContain("Do not encode paragraph breaks as literal `\\n`");
    expect(content).toContain("Never combine task numbers with slash or range shorthand");
    expect(content).toContain("#66/#67");
    expect(content).toContain("task #60-#65");
    expect(content).toContain("If the target includes a thread suffix, reuse that exact target");
    expect(content).toContain("Child Agents");
    expect(content).toContain("zano agent create");
    expect(content).toContain("can run independently");
    expect(content).toContain("Always provide at least one source");
    expect(content).toContain("Use the `DM channel:` value returned by `zano agent create` as the `zano message send --target` value");
    expect(content).toContain("Do not put secrets in child display names, descriptions, system prompts, reasons, source refs, or delegated first-task messages");
    expect(content).toContain("You remain responsible for supervising child agents");

    const mcpConfig = JSON.parse(readFileSync(result.mcpConfigPath, "utf8"));
    expect(mcpConfig).toEqual({
      mcpServers: {
        "zano-runtime-control": {
          type: "http",
          url: "http://127.0.0.1:8732/runtime-control/mcp",
          capabilities: {
            actions: ["runtime_profile_migration_done"],
          },
        },
      },
    });
    expect(readFileSync(result.mcpConfigPath, "utf8")).toContain("runtime_profile_migration_done");
    expect(readdirSync(join(workDir, ".zano")).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("keeps fake secret strings out of prompt and MCP config output", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-"));
    const workDir = join(rootDir, "agents", "agent-1");
    const materializer = new PromptMaterializer({ rootDir });
    const fakeAgentToken = "agent_token=fake-agent-token-for-task-8";
    const fakeProxyToken = "proxy_token=fake-proxy-token-for-task-8";
    const result = materializer.materialize(validPromptInput({
      workDir,
      systemPrompt: `Prefer evidence. Do not reveal ${fakeAgentToken}.`,
      memoryContext: `# Alpha\nCached token: ${fakeProxyToken}\n`,
      autonomousSkillContext: `runtime note ${fakeAgentToken} ${fakeProxyToken}`,
    }));

    const prompt = readFileSync(result.promptPath, "utf8");
    const mcpConfig = readFileSync(result.mcpConfigPath, "utf8");
    expect(prompt).not.toContain(fakeAgentToken);
    expect(prompt).not.toContain(fakeProxyToken);
    expect(mcpConfig).not.toContain(fakeAgentToken);
    expect(mcpConfig).not.toContain(fakeProxyToken);
  });

  it("uses workDir rather than agentsDir for prompt paths", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-root-"));
    const agentsDir = mkdtempSync(join(tmpdir(), "zano-custom-agents-"));
    const workDir = join(mkdtempSync(join(tmpdir(), "zano-workdir-")), "agent-1");
    const materializer = new PromptMaterializer({ rootDir, agentsDir });
    const result = materializer.materialize(validPromptInput({ workDir }));

    expect(result.promptPath).toBe(join(workDir, ".zano", "claude-system-prompt.md"));
    expect(result.mcpConfigPath).toBe(join(workDir, ".zano", "claude-mcp-config.json"));
    expect(existsSync(join(agentsDir, "agent-1", ".zano", "prompts"))).toBe(false);
  });
});
