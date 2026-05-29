import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeKind } from "./types.js";

export interface RuntimeSessionRefInput {
  runtime: RuntimeKind;
  sessionId: string;
  homeDir: string;
  fallbackDir: string;
  launchId: string;
}

export interface RuntimeSessionRef {
  path: string;
  reachable: boolean;
  source: "native" | "fallback";
}

function isSessionJsonlFile(fileName: string, sessionId: string): boolean {
  if (!fileName.endsWith(".jsonl")) return false;
  const baseName = fileName.slice(0, -".jsonl".length);
  return baseName === sessionId || baseName.endsWith(`-${sessionId}`);
}

function findSessionJsonl(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;

  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionJsonl(path, sessionId);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && isSessionJsonlFile(entry.name, sessionId)) {
      return path;
    }
  }

  return null;
}

export function resolveRuntimeSessionRef(input: RuntimeSessionRefInput): RuntimeSessionRef {
  const nativeRoot = input.runtime === "claude"
    ? join(input.homeDir, ".claude", "projects")
    : input.runtime === "codex"
      ? join(input.homeDir, ".codex", "sessions")
      : null;

  if (nativeRoot) {
    const nativePath = findSessionJsonl(nativeRoot, input.sessionId);
    if (nativePath) return { path: nativePath, reachable: true, source: "native" };
  }

  mkdirSync(input.fallbackDir, { recursive: true });
  const fallbackPath = join(input.fallbackDir, `${input.runtime}-launch-${input.launchId}.jsonl`);
  writeFileSync(
    fallbackPath,
    `${JSON.stringify({ runtime: input.runtime, sessionId: input.sessionId, launchId: input.launchId })}\n`,
    { flag: "a", mode: 0o600 },
  );
  return { path: fallbackPath, reachable: false, source: "fallback" };
}
