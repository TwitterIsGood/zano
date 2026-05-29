import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactTraceAttributes } from "./types.js";

export interface AgentLocalStateStoreOptions {
  rootDir: string;
  machineId: string;
}

export interface MachineStateInput {
  omniVersion: string;
  workspaceId: string;
  hostname: string;
  platform: string;
  arch: string;
}

export interface AgentStateInput {
  agentId: string;
  displayName: string;
  description: string | null;
}

export interface MachinePaths {
  rootDir: string;
  traceDir: string;
  lockOwnerPath: string;
  runtimeSessionsPath: string;
  startQueuePath: string;
}

export interface AgentPaths {
  rootDir: string;
  memoryPath: string;
  notesDir: string;
  zanoDir: string;
  promptDir: string;
  wrapperDir: string;
  runtimeSessionsDir: string;
  inboxDir: string;
  traceDir: string;
  skillsDir: string;
  secretDir: string;
  statePath: string;
}

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafePathSegment(label: string, value: string): void {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Unsafe local state path segment: ${label}`);
  }
}

export class AgentLocalStateStore {
  readonly rootDir: string;
  readonly machineId: string;

  constructor(options: AgentLocalStateStoreOptions) {
    this.rootDir = options.rootDir;
    this.machineId = options.machineId;
  }

  ensureMachine(input: MachineStateInput): MachinePaths {
    assertSafePathSegment("machineId", this.machineId);

    const rootDir = join(this.rootDir, "machines", this.machineId);
    const traceDir = join(rootDir, "traces");
    const lockDir = join(rootDir, "daemon.lock");
    const lockOwnerPath = join(lockDir, "owner.json");
    const runtimeSessionsPath = join(rootDir, "runtime-sessions.json");
    const startQueuePath = join(rootDir, "start-queue.jsonl");

    mkdirSync(traceDir, { recursive: true });
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(join(rootDir, "locks"), { recursive: true });
    this.writeJson(join(rootDir, "machine.json"), { machineId: this.machineId, ...input });
    this.writeJson(join(rootDir, "omni.json"), { workspaceId: input.workspaceId, omniVersion: input.omniVersion });
    this.writeJson(lockOwnerPath, { machineId: this.machineId, pid: process.pid, startedAt: new Date().toISOString() });
    if (!existsSync(runtimeSessionsPath)) this.writeJson(runtimeSessionsPath, { sessions: [] });
    if (!existsSync(startQueuePath)) writeFileSync(startQueuePath, "", "utf8");

    return { rootDir, traceDir, lockOwnerPath, runtimeSessionsPath, startQueuePath };
  }

  ensureAgent(input: AgentStateInput): AgentPaths {
    assertSafePathSegment("agentId", input.agentId);

    const rootDir = join(this.rootDir, "agents", input.agentId);
    const zanoDir = join(rootDir, ".zano");
    const paths: AgentPaths = {
      rootDir,
      memoryPath: join(rootDir, "MEMORY.md"),
      notesDir: join(rootDir, "notes"),
      zanoDir,
      promptDir: join(zanoDir, "prompts"),
      wrapperDir: join(zanoDir, "wrappers"),
      runtimeSessionsDir: join(zanoDir, "runtime-sessions"),
      inboxDir: join(zanoDir, "inbox"),
      traceDir: join(zanoDir, "traces"),
      skillsDir: join(zanoDir, "skills"),
      secretDir: join(zanoDir, "secrets"),
      statePath: join(zanoDir, "state.json"),
    };

    for (const dir of [rootDir, paths.notesDir, zanoDir, paths.promptDir, paths.wrapperDir, paths.runtimeSessionsDir, paths.inboxDir, paths.traceDir, paths.skillsDir, paths.secretDir]) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(paths.memoryPath)) {
      writeFileSync(paths.memoryPath, `# ${input.displayName}\n\n## Role\n${input.description ?? input.displayName}\n\n## Key Knowledge\n- No notes saved yet.\n`, "utf8");
    }

    this.writeJson(join(zanoDir, "agent.json"), { agentId: input.agentId, displayName: input.displayName, description: input.description });
    if (!existsSync(paths.statePath)) this.writeJson(paths.statePath, { status: "initialized" });

    return paths;
  }

  writeAgentState(agentId: string, state: Record<string, unknown>): string {
    assertSafePathSegment("agentId", agentId);

    const path = join(this.rootDir, "agents", agentId, ".zano", "state.json");
    mkdirSync(join(this.rootDir, "agents", agentId, ".zano"), { recursive: true });
    this.writeJson(path, redactTraceAttributes(state) as Record<string, unknown>);
    return path;
  }

  writeJson(path: string, value: Record<string, unknown>): void {
    const parentDir = dirname(path);
    mkdirSync(parentDir, { recursive: true });
    const tempPath = join(parentDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);

    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  }
}
