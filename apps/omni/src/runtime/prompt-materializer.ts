import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSystemPrompt } from "../system-prompt.js";
import { redactRuntimeText } from "./redaction.js";

export interface PromptMaterializerOptions {
  rootDir: string;
  agentsDir?: string;
}

export interface PromptMaterializeInput {
  agentId: string;
  displayName: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  memoryContext: string;
  autonomousSkillContext: string;
  workspaceId: string;
  workspaceName: string;
  machineId: string;
  hostname: string;
  platform: string;
  workDir: string;
  omniVersion: string;
  model: string;
  runtimeControlMcpUrl: string;
}

export interface PromptMaterializeResult {
  promptPath: string;
  currentPromptPath: string;
  mcpConfigPath: string;
  promptHash: string;
  content: string;
}

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafePathSegment(label: string, value: string): void {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Unsafe prompt materializer path segment: ${label}`);
  }
}

function atomicWriteUtf8(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export class PromptMaterializer {
  constructor(private readonly options: PromptMaterializerOptions) {
    void this.options;
  }

  materialize(input: PromptMaterializeInput): PromptMaterializeResult {
    assertSafePathSegment("agentId", input.agentId);

    const basePrompt = buildSystemPrompt(
      {
        display_name: input.displayName,
        name: input.name,
        description: input.description,
        system_prompt: input.systemPrompt,
      },
      input.memoryContext,
      input.autonomousSkillContext,
    );

    const daemonContext = [
      "",
      "# Current Runtime Context",
      `- Agent ID: ${input.agentId}`,
      `- Workspace ID: ${input.workspaceId}`,
      `- Workspace: ${input.workspaceName}`,
      `- Machine ID: ${input.machineId}`,
      `- Hostname: ${input.hostname}`,
      `- Platform: ${input.platform}`,
      `- Workdir: ${input.workDir}`,
      `- Omni version: ${input.omniVersion}`,
      `- Runtime model: ${input.model}`,
      "",
      "## Communication — zano CLI ONLY",
      "Use the local `zano` CLI wrapper from PATH for workspace communication. Runtime credentials are exposed only as local secret-file references, never as inline token values.",
      "",
      "## Daemon Delivery Header Grammar",
      "Incoming messages may begin with `[delivery=<delivery-short-id> seq=<per-agent-seq> traceparent=<traceparent> target=<target> msg=<message-short-id> time=<iso-time> sender=@<display-name> type=<human|agent|system>]`.",
      "`delivery=` identifies daemon custody for this delivery; it is not business completion.",
      "`seq=` is monotonic for this agent.",
      "`target=` is the canonical CLI address for replies; use `zano message send --target \"<target>\"` with content from stdin and the exact target value.",
      "When sending multi-line replies, write actual line breaks into stdin, for example with a heredoc. Do not encode paragraph breaks as literal `\\n` inside a quoted shell argument.",
      "`traceparent=` links routing, queueing, runtime delivery, CLI replies, and completion evidence.",
      "If the target includes a thread suffix, reuse that exact target in replies.",
      "If thread join context is included below the header, read it before acting.",
      "Busy wake-ups may be represented as pending-message notifications until a safe runtime boundary.",
    ].join("\n");

    const content = redactRuntimeText(`${basePrompt}\n${daemonContext}\n`);
    const promptHash = createHash("sha256").update(content).digest("hex");
    const zanoDir = join(input.workDir, ".zano");
    const promptPath = join(zanoDir, "claude-system-prompt.md");
    const mcpConfigPath = join(zanoDir, "claude-mcp-config.json");
    const mcpConfig = {
      mcpServers: {
        "zano-runtime-control": {
          type: "http",
          url: input.runtimeControlMcpUrl,
          capabilities: {
            actions: ["runtime_profile_migration_done"],
          },
        },
      },
    };

    atomicWriteUtf8(promptPath, content);
    atomicWriteUtf8(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
    return { promptPath, currentPromptPath: promptPath, mcpConfigPath, promptHash, content };
  }
}
