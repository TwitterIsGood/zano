import { describe, expect, it } from "vitest";
import {
  classifyMessageIntent,
  classifyConversationSpace,
  deriveTopicKey,
  hasActionableIntent,
  hasOnlyLowValueIntent,
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
    expect(classifyConversationSpace({ channelType: "unknown", threadParentId: null, task: null })).toBe("general_channel");
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

  it("does not mark should-complete review summaries as actionable", () => {
    const intents = classifyMessageIntent("The code review should be complete now.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("review_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("keeps noun review requirements actionable", () => {
    const intents = classifyMessageIntent("This needs review before close.");
    expect(intents).toEqual(expect.arrayContaining(["review_needed"]));
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("keeps explicit confirm requests actionable", () => {
    const intents = classifyMessageIntent("Please confirm final approval.");
    expect(intents).toEqual(expect.arrayContaining(["request", "decision_needed"]));
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("does not mark completed confirmation summaries as actionable", () => {
    const intents = classifyMessageIntent("The verification is complete and confirms it works.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("decision_needed");
    expect(intents).not.toContain("verification_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("does not mark actor completion summaries as actionable", () => {
    const intents = classifyMessageIntent("The reviewer should be done now.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("review_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("does not mark completed verification summaries as actionable", () => {
    const intents = classifyMessageIntent("The verification is complete and found no issue.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("verification_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("does not mark completed smoke test status as actionable", () => {
    const intents = classifyMessageIntent("The smoke test should be complete now.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("request");
    expect(intents).not.toContain("verification_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("does not mark passing or negative test-result summaries as actionable", () => {
    const intents = classifyMessageIntent("No tests failed.");
    expect(intents).toContain("result");
    expect(intents).not.toContain("blocker");
    expect(intents).not.toContain("verification_needed");
    expect(hasActionableIntent(intents)).toBe(false);
    expect(hasOnlyLowValueIntent(intents)).toBe(true);
  });

  it("keeps mixed completion and investigation messages actionable", () => {
    const intents = classifyMessageIntent("The smoke test should be complete now, please investigate the checkout failure.");
    expect(intents).toEqual(expect.arrayContaining(["request", "blocker", "result"]));
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
  });

  it("keeps mixed completion and failure findings actionable", () => {
    const cases = [
      "The verification is complete but checkout failed.",
      "The tests passed except checkout failed.",
      "The review is complete and found a regression.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toEqual(expect.arrayContaining(["blocker", "result"]));
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
  });

  it("keeps mixed completion and approval follow-up messages actionable", () => {
    const cases = [
      "The verification is complete; approval needed before deploy.",
      "The code review is complete; approval needed before close.",
      "The smoke test passed; sign off is needed before release.",
      "The verification is complete; decide whether to ship.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toEqual(expect.arrayContaining(["decision_needed", "result"]));
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
  });

  it("marks Chinese verification and review requests as actionable", () => {
    const verificationIntents = classifyMessageIntent("请验证结账流程。");
    expect(verificationIntents).toEqual(expect.arrayContaining(["request", "verification_needed"]));
    expect(hasActionableIntent(verificationIntents)).toBe(true);
    expect(hasOnlyLowValueIntent(verificationIntents)).toBe(false);

    const reviewIntents = classifyMessageIntent("请检查风险部分。");
    expect(reviewIntents).toEqual(expect.arrayContaining(["request", "review_needed"]));
    expect(hasActionableIntent(reviewIntents)).toBe(true);
    expect(hasOnlyLowValueIntent(reviewIntents)).toBe(false);
  });

  it("marks failed tests with an investigation request as actionable", () => {
    const intents = classifyMessageIntent("The test failed, can someone investigate?");
    expect(intents).toEqual(expect.arrayContaining(["request", "question", "blocker"]));
    expect(hasActionableIntent(intents)).toBe(true);
    expect(hasOnlyLowValueIntent(intents)).toBe(false);
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

  it("does not mark empty raw intent arrays as actionable", () => {
    expect(hasActionableIntent([])).toBe(false);
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
