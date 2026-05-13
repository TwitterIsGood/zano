import { describe, expect, it } from "vitest";
import {
  classifyMessageIntent,
  classifyConversationSpace,
  deriveTopicKey,
  hasActionableIntent,
  hasOnlyLowValueIntent,
  type ChannelKind,
  type ProtocolMessage,
} from "./a2a-protocol";

function msg(overrides: Partial<ProtocolMessage> = {}): ProtocolMessage {
  return {
    id: "msg-1",
    channelId: "channel-1",
    senderId: "human-1",
    senderType: "human",
    content: "Can someone inspect the import timeout?",
    threadParentId: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyConversationSpace", () => {
  it("classifies DMs as dm", () => {
    expect(classifyConversationSpace({ channelType: "dm", threadParentId: null, task: null })).toBe("dm");
  });

  it("classifies task threads before regular threads", () => {
    expect(
      classifyConversationSpace({
        channelType: "public",
        threadParentId: "message-1",
        task: { id: "task-1", taskNumber: 42, messageId: "message-1", sourceMessageId: "message-1", assigneeId: null, reviewerId: null, createdById: null },
      }),
    ).toBe("task_thread");
  });

  it("classifies regular threads when there is no task", () => {
    expect(classifyConversationSpace({ channelType: "public", threadParentId: "message-1", task: null })).toBe("thread");
  });

  it("classifies public channels as project channels", () => {
    expect(classifyConversationSpace({ channelType: "public", threadParentId: null, task: null })).toBe("project_channel");
  });

  it("classifies unknown channel types as general channels", () => {
    expect(classifyConversationSpace({ channelType: "unknown" as ChannelKind, threadParentId: null, task: null })).toBe("general_channel");
  });
});

describe("classifyMessageIntent", () => {
  it("detects open requests", () => {
    expect(classifyMessageIntent("Can someone inspect why the import flow is timing out?")).toEqual(
      expect.arrayContaining(["request"]),
    );
  });

  it("detects direct questions", () => {
    expect(classifyMessageIntent("Which option should we choose?")).toEqual(expect.arrayContaining(["question"]));
  });

  it("detects handoffs", () => {
    expect(classifyMessageIntent("The implementation is complete; reviewer should check the risk section.")).toEqual(
      expect.arrayContaining(["handoff", "review_needed"]),
    );
  });

  it("detects blockers", () => {
    expect(classifyMessageIntent("I cannot finish this until the owner confirms the field requirement.")).toEqual(
      expect.arrayContaining(["blocker", "decision_needed"]),
    );
  });

  it("detects acknowledgements as informational only", () => {
    expect(classifyMessageIntent("Sounds good, thanks.")).toEqual(expect.arrayContaining(["ack", "thanks"]));
  });

  it("does not mark pure status as actionable", () => {
    const intents = classifyMessageIntent("The verifier already completed the smoke check and found no issue.");
    expect(intents).toContain("status");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("handoff");
    expect(intents).not.toContain("verification_needed");
    expect(intents).not.toContain("correction");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("does not mark completed no-issue review summaries as actionable", () => {
    const intents = classifyMessageIntent("The code review is complete and found no issue.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("review_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("marks imperative review requests as actionable", () => {
    const intents = classifyMessageIntent("Please review the login flow changes.");
    expect(intents).toEqual(expect.arrayContaining(["request", "review_needed"]));
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("keeps high-signal findings out of low-value result summaries", () => {
    const intents = classifyMessageIntent("I found a critical issue in the login flow.");
    expect(intents).toContain("result");
    expect(intents).toContain("blocker");
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("marks open requests as actionable and not low-value", () => {
    const intents = classifyMessageIntent("Can someone inspect why the import flow is timing out?");
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("marks acknowledgements and thanks as low-value and not actionable", () => {
    const intents = classifyMessageIntent("Sounds good, thanks.");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("marks progress status as low-value and not actionable", () => {
    const intents = classifyMessageIntent("Working on the import check now, status update only.");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("matches Chinese informational terms", () => {
    expect(classifyMessageIntent("谢谢，辛苦了")).toEqual(expect.arrayContaining(["thanks"]));
    expect(classifyMessageIntent("正在处理，等待结果")).toEqual(expect.arrayContaining(["status"]));
  });
});

describe("intent helper semantics", () => {
  it("marks raw actionable intent arrays as actionable", () => {
    expect(hasActionableIntent(["request"])).toBe(true);
  });

  it("marks benign raw status and result arrays as low-value", () => {
    expect(hasOnlyLowValueIntent(["status", "result"])).toBe(true);
  });

  it("does not mark raw high-signal result arrays as low-value", () => {
    expect(hasOnlyLowValueIntent(["result", "blocker"])).toBe(false);
  });

  it("does not mark empty raw intent arrays as low-value", () => {
    expect(hasOnlyLowValueIntent([])).toBe(false);
  });
});

describe("deriveTopicKey", () => {
  it("prefers task id", () => {
    expect(deriveTopicKey(msg(), { id: "task-1", taskNumber: 1, messageId: "message-1", sourceMessageId: "message-1", assigneeId: null, reviewerId: null, createdById: null })).toBe("task:task-1");
  });

  it("uses thread parent when no task exists", () => {
    expect(deriveTopicKey(msg({ threadParentId: "thread-1" }), null)).toBe("thread:thread-1");
  });

  it("falls back to message id", () => {
    expect(deriveTopicKey(msg({ id: "message-1", threadParentId: null }), null)).toBe("message:message-1");
  });
});
