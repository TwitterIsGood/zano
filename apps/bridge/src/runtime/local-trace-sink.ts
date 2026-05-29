import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactTraceAttributes, type RuntimeTraceEvent } from "./types.js";

export interface LocalTraceSinkOptions {
  traceDir: string;
  filePrefix?: string;
  now?: () => Date;
}

function sanitizeFilePrefix(value: string | undefined): string {
  const sanitized = (value ?? "daemon-trace")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "daemon-trace";
}

export class LocalTraceSink {
  private readonly traceDir: string;
  private readonly filePrefix: string;
  private readonly now: () => Date;

  constructor(options: LocalTraceSinkOptions) {
    this.traceDir = options.traceDir;
    this.filePrefix = sanitizeFilePrefix(options.filePrefix);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.traceDir, { recursive: true });
  }

  write(event: RuntimeTraceEvent): string {
    const path = this.currentPath();
    const redacted = { ...event, attributes: redactTraceAttributes(event.attributes) };
    appendFileSync(path, `${JSON.stringify(redacted)}\n`, "utf8");
    return path;
  }

  currentPath(): string {
    const stamp = this.now().toISOString().slice(0, 13).replace(/[-:T]/g, "");
    return join(this.traceDir, `${this.filePrefix}-${stamp}.jsonl`);
  }
}
