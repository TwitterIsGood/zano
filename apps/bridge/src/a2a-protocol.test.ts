import { describe, expect, it } from "vitest";
import {
  classifyMessageIntent,
  classifyConversationSpace,
  deriveTopicKey,
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
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("handoff");
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
