import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentLocalState {
  currentDelivery?: {
    deliveryId: string;
    deliverySeq: number;
    traceparent: string;
    target?: string;
    messageCreatedAt?: string;
  };
  freshness?: Record<string, { lastSeenMessageCreatedAt: string }>;
}

export function readAgentLocalState(path: string | undefined): AgentLocalState {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentLocalState;
  } catch {
    return {};
  }
}

export function writeAgentLocalState(path: string, state: AgentLocalState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
