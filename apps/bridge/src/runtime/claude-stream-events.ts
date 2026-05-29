import { redactRuntimeText } from "./redaction.js";
import type { ClaudeGatedSteeringEvent } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function firstContentBlock(record: Record<string, unknown>): Record<string, unknown> | null {
  const message = getRecord(record, "message");
  const content = message?.content;
  if (!Array.isArray(content)) return null;

  const first = content[0];
  return isRecord(first) ? first : null;
}

const MAX_RUNTIME_ERROR_MESSAGE_LENGTH = 500;

function safeRuntimeErrorMessage(message: string): string {
  return redactRuntimeText(message, { maxLength: MAX_RUNTIME_ERROR_MESSAGE_LENGTH });
}

export function mapClaudeStreamJsonToGatedEvent(value: unknown): ClaudeGatedSteeringEvent | null {
  if (!isRecord(value)) return null;

  const type = getString(value, "type");

  if (type === "assistant") {
    const block = firstContentBlock(value);
    if (!block) return null;

    const blockType = getString(block, "type");
    if (blockType === "thinking") return { type: "assistant_thinking" };
    if (blockType === "text") return { type: "assistant_text" };
    if (blockType === "tool_use") {
      const toolUseId = getString(block, "id");
      return toolUseId ? { type: "tool_call", toolUseId } : null;
    }

    return null;
  }

  if (type === "user") {
    const block = firstContentBlock(value);
    if (!block) return null;

    if (getString(block, "type") !== "tool_result") return null;
    const toolUseId = getString(block, "tool_use_id");
    return toolUseId ? { type: "tool_result", toolUseId } : null;
  }

  if (type === "system") {
    const subtype = getString(value, "subtype");
    if (subtype === "compacting") return { type: "compaction_started" };
    if (subtype === "compacted") return { type: "compaction_finished" };
    return null;
  }

  if (type === "result") return { type: "turn_end" };

  if (type === "error") {
    const error = getRecord(value, "error");
    const message = (error ? getString(error, "message") : null) ?? getString(value, "message");
    return { type: "runtime_error", message: message ? safeRuntimeErrorMessage(message) : "Runtime error" };
  }

  return null;
}
