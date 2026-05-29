import { describe, expect, it } from "vitest";

import { enrichTaskCommentsWithAuthors } from "./task-comment-authors";

const baseComment = {
  id: "comment-1",
  task_id: "task-1",
  author_id: "human-1",
  author_type: "human",
  content: "Looks good for task #12",
  created_at: "2026-05-28T03:00:00.000Z",
};

describe("enrichTaskCommentsWithAuthors", () => {
  it("adds human display metadata to task comments", () => {
    const [comment] = enrichTaskCommentsWithAuthors([baseComment], {
      humans: new Map([
        ["human-1", { id: "human-1", display_name: "Biang", email: "biang@example.com", avatar_url: "https://example.com/avatar.png" }],
      ]),
      agents: new Map(),
    });

    expect(comment.author).toEqual({
      id: "human-1",
      type: "human",
      displayName: "Biang",
      avatarId: "human-1",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("adds agent display metadata to task comments", () => {
    const [comment] = enrichTaskCommentsWithAuthors([
      { ...baseComment, id: "comment-2", author_id: "agent-1", author_type: "agent" },
    ], {
      humans: new Map(),
      agents: new Map([
        ["agent-1", { id: "agent-1", name: "frontend", display_name: "前端工程师" }],
      ]),
    });

    expect(comment.author).toEqual({
      id: "agent-1",
      type: "agent",
      displayName: "前端工程师",
      avatarId: "agent-1",
      avatarUrl: null,
    });
  });

  it("falls back to stable short author labels when metadata is missing", () => {
    const [comment] = enrichTaskCommentsWithAuthors([
      { ...baseComment, author_id: "missing-author-123456", author_type: "agent" },
    ], {
      humans: new Map(),
      agents: new Map(),
    });

    expect(comment.author.displayName).toBe("Agent missing-");
    expect(comment.author.avatarId).toBe("missing-author-123456");
  });
});
