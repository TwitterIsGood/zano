import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FreshnessAction = "message_send" | "task_claim" | "task_update";

export interface FreshnessMessage {
  id: string;
  sender: string;
  createdAt: string;
  text: string;
}

export type FreshnessPreflightResult =
  | { state: "allowed"; outcome: "fresh" | "explicit_anyway"; target: string }
  | {
      state: "held";
      outcome: "held";
      subtype: "freshness";
      target: string;
      heldMessages: FreshnessMessage[];
      availableActions: string[];
    };

const SAFE_DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateSafeDraftId(id: string): string {
  if (!SAFE_DRAFT_ID_PATTERN.test(id)) {
    throw new Error("DRAFT_INVALID");
  }
  return id;
}

export function evaluateFreshnessPreflight(input: {
  action: FreshnessAction;
  target: string;
  lastSeenMessageCreatedAt: string | null;
  newerMessages: FreshnessMessage[];
  anyway: boolean;
}): FreshnessPreflightResult {
  void input.lastSeenMessageCreatedAt;
  if (input.anyway) return { state: "allowed", outcome: "explicit_anyway", target: input.target };
  if (input.newerMessages.length === 0) return { state: "allowed", outcome: "fresh", target: input.target };
  return {
    state: "held",
    outcome: "held",
    subtype: "freshness",
    target: input.target,
    heldMessages: input.newerMessages.slice(0, 10),
    availableActions: input.action === "message_send" ? ["review", "send-draft", "send-anyway"] : ["review", "send-anyway"],
  };
}

export function saveHeldDraft(input: { stateDir: string; target: string; text: string; reason: "freshness" }): { id: string; path: string } {
  const id = randomUUID();
  const draftsDir = join(input.stateDir, ".zano-drafts");
  mkdirSync(draftsDir, { recursive: true });
  const path = join(draftsDir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ id, target: input.target, text: input.text, reason: input.reason, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return { id, path };
}
