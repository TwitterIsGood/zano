import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFreshnessPreflight, saveHeldDraft, validateSafeDraftId } from "./freshness";

describe("freshness preflight", () => {
  it("holds message send when newer visible messages exist", () => {
    const result = evaluateFreshnessPreflight({
      action: "message_send",
      target: "#general",
      lastSeenMessageCreatedAt: "2026-05-23T10:00:00.000Z",
      newerMessages: [
        { id: "msg-2", sender: "@biang", createdAt: "2026-05-23T10:01:00.000Z", text: "new context" },
      ],
      anyway: false,
    });

    expect(result).toEqual({
      state: "held",
      outcome: "held",
      subtype: "freshness",
      target: "#general",
      heldMessages: [{ id: "msg-2", sender: "@biang", createdAt: "2026-05-23T10:01:00.000Z", text: "new context" }],
      availableActions: ["review", "send-draft", "send-anyway"],
    });
  });

  it("allows explicit anyway escape hatch", () => {
    const result = evaluateFreshnessPreflight({
      action: "task_update",
      target: "task-1",
      lastSeenMessageCreatedAt: "2026-05-23T10:00:00.000Z",
      newerMessages: [{ id: "msg-2", sender: "@human", createdAt: "2026-05-23T10:01:00.000Z", text: "please wait" }],
      anyway: true,
    });

    expect(result).toEqual({ state: "allowed", outcome: "explicit_anyway", target: "task-1" });
  });

  it("saves held message drafts without sending", () => {
    const dir = mkdtempSync(join(tmpdir(), "zano-drafts-"));
    const draft = saveHeldDraft({ stateDir: dir, target: "#general", text: "draft body", reason: "freshness" });

    expect(draft.path).toContain(".zano-drafts");
    expect(JSON.parse(readFileSync(draft.path, "utf8"))).toMatchObject({ target: "#general", text: "draft body", reason: "freshness" });
  });

  it("validates held draft ids before resolving draft paths", () => {
    expect(validateSafeDraftId("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(validateSafeDraftId("safe_Draft-123")).toBe("safe_Draft-123");

    for (const id of ["", "../escape", "nested/draft", "nested\\draft", ".", "..", "draft.json", "draft..id"]) {
      expect(() => validateSafeDraftId(id)).toThrow("DRAFT_INVALID");
    }
  });
});
