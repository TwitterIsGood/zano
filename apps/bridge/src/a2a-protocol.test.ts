import { describe, expect, it } from "vitest";
import {
  classifyMessageIntent,
  classifyConversationSpace,
  deriveTopicKey,
  hasActionableIntent,
  hasOnlyLowValueIntent,
  selectActivationCandidates,
  type ProtocolAgent,
  type ProtocolMessage,
  type ProtocolRecentMessage,
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
    const cases = ["Please confirm final approval.", "Could you confirm the field requirement?"];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toEqual(expect.arrayContaining(["request", "decision_needed"]));
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
  });

  it("keeps conditional confirm messages with follow-up work actionable", () => {
    const cases = [
      "If the report confirms the timeout, implement the fallback.",
      "If the smoke test confirms the issue, fix checkout.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toEqual(expect.arrayContaining(["request"]));
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
  });

  it("does not mark completed decision or approval summaries as actionable", () => {
    const cases = [
      "The final decision was approved.",
      "Approval was received.",
      "The deployment approval was granted.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toEqual(expect.arrayContaining(["result"]));
      expect(intents).not.toContain("decision_needed");
      expect(hasActionableIntent(intents)).toBe(false);
      expect(hasOnlyLowValueIntent(intents)).toBe(true);
    }
  });

  it("does not mark repeated negated problem summaries as actionable", () => {
    const cases = [
      "No bug was found.",
      "No critical issue was found.",
      "No build failed.",
      "No tests failed and no regression was found.",
      "No error was found and no regression was detected.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toContain("result");
      expect(intents).not.toContain("blocker");
      expect(hasActionableIntent(intents)).toBe(false);
      expect(hasOnlyLowValueIntent(intents)).toBe(true);
    }
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
      "No tests failed, but deployment failed.",
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

  it("keeps pure no-issue summaries non-actionable", () => {
    const cases = ["No tests failed.", "The review is complete and no regression was found."];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toContain("result");
      expect(hasActionableIntent(intents)).toBe(false);
      expect(hasOnlyLowValueIntent(intents)).toBe(true);
    }
  });

  it("keeps mixed completion and approval follow-up messages actionable", () => {
    const cases = [
      "The verification is complete; approval is required before deploy.",
      "The code review is complete; approval is required before close.",
      "The smoke test passed; sign-off is required before release.",
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
    const cases = [
      "I found a bug in checkout.",
      "I found an error in checkout.",
      "The checkout crashes during payment.",
      "I found a critical issue in the login flow.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(intents).toContain("result");
      expect(intents).toContain("blocker");
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
  });

  it("keeps broad false-positive action patterns non-actionable", () => {
    const cases = [
      "This should work now.",
      "Verification is in progress.",
      "It confirms the fix works.",
      "The verification is complete and confirms it works.",
      "The reviewer should be done now.",
      "The code review should be complete now.",
      "The checkout fix is done.",
      "The review handoff is complete.",
      "The next step is complete.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(hasActionableIntent(intents)).toBe(false);
      expect(hasOnlyLowValueIntent(intents)).toBe(true);
    }
  });

  it("keeps explicit action phrases actionable", () => {
    const cases = [
      "Please confirm final approval.",
      "Could you confirm the field requirement?",
      "The reviewer should check the risk section.",
      "This needs review before close.",
      "Please verify the checkout flow.",
      "Could someone run the smoke test?",
      "The test failed, can someone investigate?",
      "Can someone inspect why the import flow is timing out?",
      "Fix checkout now.",
      "Please hand off to the reviewer.",
      "The next step is to verify the checkout flow.",
    ];

    for (const content of cases) {
      const intents = classifyMessageIntent(content);
      expect(hasActionableIntent(intents)).toBe(true);
      expect(hasOnlyLowValueIntent(intents)).toBe(false);
    }
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

const agents: ProtocolAgent[] = [
  { id: "agent-a", name: "alpha", displayName: "Alpha", description: "Owns implementation and build work" },
  { id: "agent-b", name: "beta", displayName: "Beta", description: "Owns review and validation work" },
  { id: "agent-c", name: "gamma", displayName: "Gamma", description: "Owns documentation work" },
];

function recent(overrides: Partial<ProtocolRecentMessage> = {}): ProtocolRecentMessage {
  return {
    senderId: "agent-a",
    senderType: "agent",
    content: "I finished the change.",
    createdAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectActivationCandidates", () => {
  it("strongly activates explicit @mentions", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-a", content: "@beta please review this." }),
      agents,
      space: "project_channel",
      intents: ["request", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", strength: "strong", reasons: expect.arrayContaining(["direct_mention"]) }),
    ]);
  });

  it("activates a naturally referenced role only when the message is actionable", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-a", content: "The reviewer should check the risk section." }),
      agents,
      space: "project_channel",
      intents: ["handoff", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", strength: "medium", reasons: expect.arrayContaining(["natural_reference"]) }),
    ]);
  });

  it("does not activate a naturally referenced role for pure status", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-a", content: "The reviewer already completed the check." }),
      agents,
      space: "project_channel",
      intents: ["status"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([]);
    expect(result.suppressed).toEqual([
      expect.objectContaining({ agentId: "agent-b", reason: "low_value_intent" }),
    ]);
  });

  it("activates task assignee as task owner", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "task #42 needs follow-up before close." }),
      agents,
      space: "task_thread",
      intents: ["request"],
      topicKey: "task:task-1",
      recentMessages: [],
      task: { id: "task-1", taskNumber: 42, messageId: "message-1", sourceMessageId: "message-1", assigneeId: "agent-a", reviewerId: null, createdById: null },
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-a", strength: "strong", reasons: expect.arrayContaining(["task_owner"]) }),
    ]);
  });

  it("caps project channel natural fanout to two candidates", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone inspect and validate this?" }),
      agents,
      space: "project_channel",
      intents: ["request", "verification_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toHaveLength(2);
    expect(result.suppressed).toEqual([
      expect.objectContaining({ reason: "fanout_cap" }),
    ]);
  });

  it("activates recent participant for conversation continuation", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-c", content: "Can you take another look?" }),
      agents,
      space: "thread",
      intents: ["question", "request"],
      topicKey: "thread:thread-1",
      recentMessages: [recent({ senderId: "agent-b", content: "I found a possible issue." })],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", reasons: expect.arrayContaining(["conversation_continuation"]) }),
    ]);
  });
});
