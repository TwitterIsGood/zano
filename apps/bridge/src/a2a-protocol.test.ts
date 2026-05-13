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

  it("marks Chinese verification, review, and documentation requests as actionable", () => {
    const verificationIntents = classifyMessageIntent("请验证结账流程。");
    expect(verificationIntents).toEqual(expect.arrayContaining(["request", "verification_needed"]));
    expect(hasActionableIntent(verificationIntents)).toBe(true);
    expect(hasOnlyLowValueIntent(verificationIntents)).toBe(false);

    const reviewIntents = classifyMessageIntent("请评审登录风险。");
    expect(reviewIntents).toEqual(expect.arrayContaining(["request", "review_needed"]));
    expect(hasActionableIntent(reviewIntents)).toBe(true);
    expect(hasOnlyLowValueIntent(reviewIntents)).toBe(false);

    const documentationIntents = classifyMessageIntent("请补充结账文档。");
    expect(documentationIntents).toEqual(expect.arrayContaining(["request"]));
    expect(hasActionableIntent(documentationIntents)).toBe(true);
    expect(hasOnlyLowValueIntent(documentationIntents)).toBe(false);
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

  it("suppresses the sender even when the sender owns task obligations", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-a", content: "task #42 needs follow-up before close." }),
      agents,
      space: "task_thread",
      intents: ["request"],
      topicKey: "task:task-1",
      recentMessages: [],
      task: { id: "task-1", taskNumber: 42, messageId: "message-1", sourceMessageId: "message-1", assigneeId: "agent-a", reviewerId: "agent-a", createdById: "agent-a" },
    });

    expect(result.activated).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent-a" })]));
    expect(result.suppressed).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        reason: "sender",
        reasons: expect.arrayContaining(["task_owner", "review_owner", "task_creator"]),
      }),
    ]);
  });

  it("activates a non-open-call domain fit as a weak candidate", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Please validate the import timeout before release." }),
      agents,
      space: "project_channel",
      intents: ["request", "verification_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", strength: "weak", reasons: ["domain_fit"] }),
    ]);
  });

  it("activates open-call domain matches as weak open-call candidates", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone validate the import timeout?" }),
      agents,
      space: "project_channel",
      intents: ["request", "question", "verification_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "agent-b", strength: "weak", reasons: expect.arrayContaining(["open_call_candidate"]) }),
      ]),
    );
  });

  it("does not activate agents from generic work overlap in open calls", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone check this work?" }),
      agents,
      space: "project_channel",
      intents: ["request", "question"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([]);
  });

  it("activates agents for allowlisted short domain tokens", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone review the API and UI risks?" }),
      agents: [
        { id: "api-agent", name: "endpoint", displayName: "Endpoint Team", description: "Owns API auth and SSO work" },
        { id: "ui-agent", name: "frontend", displayName: "Frontend Team", description: "Owns UI and UX work" },
        { id: "ops-agent", name: "ops", displayName: "Ops", description: "Owns operations work" },
      ],
      space: "project_channel",
      intents: ["request", "question", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "api-agent", reasons: expect.arrayContaining(["open_call_candidate"]) }),
        expect.objectContaining({ agentId: "ui-agent", reasons: expect.arrayContaining(["open_call_candidate"]) }),
      ]),
    );
    expect(result.activated).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "ops-agent" })]));
  });

  it("still activates implementation agents for specific implementation requests", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone implement the checkout fallback?" }),
      agents,
      space: "project_channel",
      intents: ["request", "question"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-a", strength: "weak", reasons: expect.arrayContaining(["open_call_candidate"]) }),
    ]);
  });

  it("activates agents for classifier-driven Chinese domain requests", () => {
    const chineseAgents: ProtocolAgent[] = [
      { id: "verify-agent", name: "verifier", displayName: "Verifier", description: "负责验证和测试结账流程" },
      { id: "review-agent", name: "reviewer", displayName: "Reviewer", description: "负责评审风险和代码审查" },
      { id: "docs-agent", name: "documenter", displayName: "Documenter", description: "负责文档和说明" },
    ];

    const verificationMessage = msg({ content: "请验证结账流程。" });
    const verification = selectActivationCandidates({
      message: verificationMessage,
      agents: chineseAgents,
      space: "project_channel",
      intents: classifyMessageIntent(verificationMessage.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });
    expect(verification.activated).toEqual([
      expect.objectContaining({ agentId: "verify-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);

    const reviewMessage = msg({ content: "请评审登录风险。" });
    const review = selectActivationCandidates({
      message: reviewMessage,
      agents: chineseAgents,
      space: "project_channel",
      intents: classifyMessageIntent(reviewMessage.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });
    expect(review.activated).toEqual([
      expect.objectContaining({ agentId: "review-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);

    const documentationMessage = msg({ content: "请补充结账文档。" });
    const documentation = selectActivationCandidates({
      message: documentationMessage,
      agents: chineseAgents,
      space: "project_channel",
      intents: classifyMessageIntent(documentationMessage.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });
    expect(documentation.activated).toEqual([
      expect.objectContaining({ agentId: "docs-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);
  });

  it("prioritizes relevant open-call agents over irrelevant earlier roster entries", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone validate the import timeout?" }),
      agents: [
        { id: "agent-a", name: "alpha", displayName: "Alpha", description: "Owns implementation work" },
        { id: "agent-d", name: "delta", displayName: "Delta", description: "Coordinates planning and logistics" },
        { id: "agent-e", name: "epsilon", displayName: "Epsilon", description: "Handles operations support" },
        { id: "agent-b", name: "beta", displayName: "Beta", description: "Owns validation and test evidence" },
      ],
      space: "project_channel",
      intents: ["request", "question", "verification_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", reasons: expect.arrayContaining(["open_call_candidate"]) }),
    ]);
    expect(result.suppressed).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent-b", reason: "fanout_cap" })]));
  });

  it("does not treat longer hyphenated mentions as direct mentions of shorter agent names", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "@beta-team please review the rollout plan." }),
      agents,
      space: "project_channel",
      intents: ["request", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent-b", reasons: expect.arrayContaining(["direct_mention"]) })]));
  });

  it("does not treat agent names inside unrelated words as natural references", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Please review the alphabetized checklist." }),
      agents,
      space: "project_channel",
      intents: ["request", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent-a", reasons: expect.arrayContaining(["natural_reference"]) })]));
  });

  it("does not use project-channel conversation continuation for broad you language", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-c", content: "Can you check the plan?" }),
      agents,
      space: "project_channel",
      intents: ["question", "request"],
      topicKey: "message:msg-1",
      recentMessages: [recent({ senderId: "agent-b", content: "I mentioned a separate deploy concern." })],
      task: null,
    });

    expect(result.activated).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent-b", reasons: expect.arrayContaining(["conversation_continuation"]) })]));
  });

  it("selects documentation agents for documentation open calls", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone document the deployment checklist?" }),
      agents,
      space: "project_channel",
      intents: ["request", "question"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-c", strength: "weak", reasons: expect.arrayContaining(["open_call_candidate"]) }),
    ]);
  });

  it("uses classifier-driven selection for Chinese review risk requests", () => {
    const message = msg({ content: "请审核登录风险。" });
    const result = selectActivationCandidates({
      message,
      agents: [
        { id: "impl-agent", name: "implementer", displayName: "Implementer", description: "负责实现登录功能" },
        { id: "risk-agent", name: "reviewer", displayName: "Reviewer", description: "负责审核登录风险和代码审查" },
      ],
      space: "project_channel",
      intents: classifyMessageIntent(message.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "risk-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);
  });

  it("uses classifier-driven selection for Chinese confirmation risk requests", () => {
    const message = msg({ content: "请确认发布风险。" });
    const result = selectActivationCandidates({
      message,
      agents: [
        { id: "release-agent", name: "release", displayName: "Release", description: "负责发布实施" },
        { id: "decision-agent", name: "decision", displayName: "Decision", description: "负责确认发布风险和审批审查" },
      ],
      space: "project_channel",
      intents: classifyMessageIntent(message.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "decision-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);
  });

  it("uses classifier-driven selection for imperative documentation requests", () => {
    const message = msg({ content: "Document the deployment checklist." });
    const result = selectActivationCandidates({
      message,
      agents,
      space: "project_channel",
      intents: classifyMessageIntent(message.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual([
      expect.objectContaining({ agentId: "agent-c", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);
  });

  it("selects technical writers for classifier-driven documentation requests", () => {
    const message = msg({ content: "Document the deployment checklist." });
    const result = selectActivationCandidates({
      message,
      agents: [
        { id: "ops-agent", name: "ops", displayName: "Ops", description: "Owns deployment operations" },
        { id: "writer-agent", name: "writer", displayName: "Writer", description: "Technical writer for deployment guides and release checklists" },
      ],
      space: "project_channel",
      intents: classifyMessageIntent(message.content),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "writer-agent", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
      ]),
    );
  });

  it("prioritizes uncovered weak domains over duplicate domains already covered by strong candidates", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "@alpha please implement, verify validation testing, and review checkout." }),
      agents: [
        { id: "agent-a", name: "alpha", displayName: "Alpha", description: "Owns implementation work" },
        { id: "agent-b", name: "beta", displayName: "Beta", description: "Owns implementation work" },
        { id: "agent-c", name: "gamma", displayName: "Gamma", description: "Owns verification validation testing work" },
        { id: "agent-d", name: "delta", displayName: "Delta", description: "Owns review work" },
      ],
      space: "project_channel",
      intents: ["request", "verification_needed", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "agent-a", strength: "strong", reasons: expect.arrayContaining(["direct_mention"]) }),
        expect.objectContaining({ agentId: "agent-c", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
        expect.objectContaining({ agentId: "agent-d", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
      ]),
    );
    expect(result.activated).toHaveLength(3);
    expect(result.suppressed).toEqual([
      expect.objectContaining({ agentId: "agent-b", reason: "fanout_cap" }),
    ]);
  });

  it("covers allowlisted short-token domains under open-call fanout caps", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone review API and UI risk?" }),
      agents: [
        { id: "api-agent-1", name: "api-one", displayName: "API agent 1", description: "Owns API review" },
        { id: "api-agent-2", name: "api-two", displayName: "API agent 2", description: "Owns API review" },
        { id: "ui-agent", name: "ui", displayName: "UI agent", description: "Owns UI review" },
      ],
      space: "project_channel",
      intents: classifyMessageIntent("Can someone review API and UI risk?"),
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toHaveLength(2);
    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "api-agent-1", reasons: expect.arrayContaining(["open_call_candidate"]) }),
        expect.objectContaining({ agentId: "ui-agent", reasons: expect.arrayContaining(["open_call_candidate"]) }),
      ]),
    );
    expect(result.suppressed).toEqual([
      expect.objectContaining({ agentId: "api-agent-2", reason: "fanout_cap" }),
    ]);
  });

  it("preserves all strong candidates and caps only non-strong fanout", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "@alpha please validate, implement, and review the import timeout." }),
      agents: [
        { id: "agent-a", name: "alpha", displayName: "Alpha", description: "Owns implementation work" },
        { id: "agent-b", name: "beta", displayName: "Beta", description: "Owns validation work" },
        { id: "agent-c", name: "gamma", displayName: "Gamma", description: "Owns review work" },
        { id: "agent-d", name: "delta", displayName: "Delta", description: "Owns build work" },
      ],
      space: "project_channel",
      intents: ["request", "verification_needed", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "agent-a", strength: "strong", reasons: expect.arrayContaining(["direct_mention"]) }),
        expect.objectContaining({ agentId: "agent-b", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
        expect.objectContaining({ agentId: "agent-c", strength: "weak", reasons: expect.arrayContaining(["domain_fit"]) }),
      ]),
    );
    expect(result.activated).toHaveLength(3);
    expect(result.suppressed).toEqual([
      expect.objectContaining({ agentId: "agent-d", reason: "fanout_cap", reasons: expect.arrayContaining(["domain_fit"]) }),
    ]);
  });

  it("caps project channel natural fanout while covering requested domains", () => {
    const result = selectActivationCandidates({
      message: msg({ content: "Can someone cover validation and review?" }),
      agents: [
        { id: "agent-a", name: "alpha", displayName: "Alpha", description: "Owns validation work" },
        { id: "agent-b", name: "beta", displayName: "Beta", description: "Owns validation work" },
        { id: "agent-c", name: "gamma", displayName: "Gamma", description: "Owns review work" },
      ],
      space: "project_channel",
      intents: ["request", "verification_needed", "review_needed"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated).toHaveLength(2);
    expect(result.activated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "agent-a", reasons: expect.arrayContaining(["open_call_candidate"]) }),
        expect.objectContaining({ agentId: "agent-c", reasons: expect.arrayContaining(["open_call_candidate"]) }),
      ]),
    );
    expect(result.suppressed).toEqual([
      expect.objectContaining({ agentId: "agent-b", reason: "fanout_cap" }),
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
