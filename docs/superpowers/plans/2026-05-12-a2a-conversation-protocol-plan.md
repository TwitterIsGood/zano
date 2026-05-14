# A2A Conversation Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the target-state A2A conversation obligation protocol so agent group chat supports natural responsibility, silent work, bounded activation, and loop prevention without hard-coding one project domain.

**Architecture:** Extract routing semantics out of `apps/bridge/src/bridge.ts` into focused protocol modules that classify message intent, addressability, activation strength, topic identity, fanout, cooldowns, and prompt envelopes. The bridge will use those modules to select awakened agents and pass structured activation context to the agent prompt; the agent system prompt will teach reply/work/observe/skip decisions while activity types expose quiet-but-not-idle states.

**Tech Stack:** TypeScript, Node.js bridge daemon, Supabase Realtime/PostgREST, Vitest, Next.js web UI, shared workspace types.

---

## File Structure

- Create: `apps/bridge/src/a2a-protocol.ts`
  - Pure protocol types and helpers: conversation space, intents, activation reasons, strengths, decision modes, topic keys, cooldown keys, reply-value classification, fanout caps.
- Create: `apps/bridge/src/a2a-protocol.test.ts`
  - Unit tests for classification, addressability, fanout, cooldown, suppression, and prompt envelope formatting.
- Modify: `apps/bridge/src/bridge.ts`
  - Replace binary A2A routing with protocol candidate selection, task/thread context loading, loop guard state, structured activation envelopes, and routing logs.
- Modify: `apps/bridge/src/system-prompt.ts`
  - Add the full A2A decision contract: `REPLY_AND_WORK`, `WORK_SILENTLY`, `REPLY_ONLY`, `OBSERVE`, `SKIP`; suppress idle narration and require response value.
- Modify: `apps/bridge/src/agent-manager.ts`
  - Add activity states for `working_silently`, `observing`, and `blocked` to activity broadcasts and persisted activity events.
- Modify: `packages/shared/src/index.ts`
  - Extend `AgentActivity` to include `working_silently`, `observing`, and `blocked` so the web UI can consume them.
- Modify: `apps/web/src/components/member-activity-tab.tsx`
  - Render new activity states with appropriate badges/labels without treating them as errors.
- Modify: `apps/web/src/hooks/use-agent-activity.ts` if present and needed
  - Ensure typed agent activity map accepts new states.
- No database migration required for the core protocol; `member_activity_events.event_type` is a string and can store new `agent.*` event names.

---

### Task 1: Protocol Types and Message Classification

**Files:**
- Create: `apps/bridge/src/a2a-protocol.ts`
- Create: `apps/bridge/src/a2a-protocol.test.ts`
- Modify: `apps/bridge/package.json:12-16`

- [ ] **Step 1: Add the bridge test script**

Modify `apps/bridge/package.json` scripts to include `test`:

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "vitest run",
  "prepublishOnly": "npm run build"
}
```

- [ ] **Step 2: Write failing classification tests**

Create `apps/bridge/src/a2a-protocol.test.ts` with:

```ts
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
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: FAIL with a module resolution error for `./a2a-protocol` or missing exported functions.

- [ ] **Step 4: Implement protocol types and classification**

Create `apps/bridge/src/a2a-protocol.ts` with:

```ts
export type SenderType = "human" | "agent" | "system";
export type ChannelKind = "dm" | "public" | "private";
export type ConversationSpace = "dm" | "thread" | "task_thread" | "project_channel" | "general_channel";
export type MessageIntent =
  | "request"
  | "question"
  | "handoff"
  | "blocker"
  | "decision_needed"
  | "review_needed"
  | "verification_needed"
  | "correction"
  | "assignment"
  | "escalation"
  | "status"
  | "result"
  | "decision"
  | "ack"
  | "thanks"
  | "chatter";

export type ActivationReason =
  | "direct_mention"
  | "dm_recipient"
  | "thread_participant"
  | "task_owner"
  | "task_creator"
  | "handoff_target"
  | "blocker_owner"
  | "decision_owner"
  | "review_owner"
  | "verification_owner"
  | "natural_reference"
  | "domain_fit"
  | "open_call_candidate"
  | "conversation_continuation"
  | "system_assignment"
  | "channel_broadcast";

export type ActivationStrength = "strong" | "medium" | "weak";
export type AgentDecisionMode = "REPLY_AND_WORK" | "WORK_SILENTLY" | "REPLY_ONLY" | "OBSERVE" | "SKIP";

export interface ProtocolMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderType: SenderType;
  content: string;
  threadParentId: string | null;
  createdAt: string;
}

export interface ProtocolTaskRef {
  id: string;
  taskNumber: number;
  messageId: string | null;
  sourceMessageId: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  createdById: string | null;
}

export interface ConversationSpaceInput {
  channelType: ChannelKind;
  threadParentId: string | null;
  task: ProtocolTaskRef | null;
}

const ACTION_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["request", /\b(can someone|could someone|please|need someone|needs to|should|must|do this|take this|handle this|look into|inspect|investigate|fix|implement|verify|review|check)\b/i],
  ["question", /\?|\b(which|what|why|how|when|where|who|should we|can you|could you)\b/i],
  ["handoff", /\b(handoff|hand off|pass to|over to|take over|continue|next step|follow up|should check|should review|should verify|please check|please review|please verify)\b/i],
  ["blocker", /\b(blocked|blocker|cannot|can't|unable|waiting on|until .* confirms?|depends on|need .* before)\b/i],
  ["decision_needed", /\b(confirm|decide|decision|approve|approval|choose|select|sign off|go\/no-go)\b/i],
  ["review_needed", /\b(review|critique|approve|approval|check .* risk|look over|take another look)\b/i],
  ["verification_needed", /\b(verify|verification|test|validate|evidence|smoke|regression|confirm .* works)\b/i],
  ["correction", /\b(no|not that|instead|change|wrong|incorrect|revise|adjust|stop|don't)\b/i],
  ["assignment", /\b(assign|owner|responsible|take|claim|belongs to|owned by)\b/i],
  ["escalation", /\b(stuck|need help|escalate|urgent|blocked hard|can't proceed)\b/i],
];

const INFORMATIONAL_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["ack", /\b(ok|okay|sounds good|sgtm|received|got it|ack|noted)\b/i],
  ["thanks", /\b(thanks|thank you|appreciate|辛苦|谢谢)\b/i],
  ["result", /\b(done|completed|finished|result|findings|found|confirmed|fixed|implemented|verified|passed|failed)\b/i],
  ["decision", /\b(decided|approved|rejected|selected|we will|we'll|final decision)\b/i],
  ["status", /\b(in progress|working on|currently|status|progress|waiting|pending|in review|ongoing|已|正在|等待)\b/i],
  ["chatter", /\b(hello|hi|hey|good morning|good night|lol|haha)\b/i],
];

export function classifyConversationSpace(input: ConversationSpaceInput): ConversationSpace {
  if (input.channelType === "dm") return "dm";
  if (input.threadParentId && input.task) return "task_thread";
  if (input.threadParentId) return "thread";
  if (input.channelType === "public" || input.channelType === "private") return "project_channel";
  return "general_channel";
}

export function classifyMessageIntent(content: string): MessageIntent[] {
  const intents = new Set<MessageIntent>();

  for (const [intent, pattern] of ACTION_PATTERNS) {
    if (pattern.test(content)) intents.add(intent);
  }

  for (const [intent, pattern] of INFORMATIONAL_PATTERNS) {
    if (pattern.test(content)) intents.add(intent);
  }

  if (intents.size === 0) intents.add("chatter");
  return Array.from(intents);
}

export function hasActionableIntent(intents: MessageIntent[]): boolean {
  return intents.some((intent) =>
    [
      "request",
      "question",
      "handoff",
      "blocker",
      "decision_needed",
      "review_needed",
      "verification_needed",
      "correction",
      "assignment",
      "escalation",
    ].includes(intent),
  );
}

export function hasOnlyLowValueIntent(intents: MessageIntent[]): boolean {
  return intents.every((intent) => ["ack", "thanks", "chatter", "status"].includes(intent));
}

export function deriveTopicKey(message: ProtocolMessage, task: ProtocolTaskRef | null): string {
  if (task) return `task:${task.id}`;
  if (message.threadParentId) return `thread:${message.threadParentId}`;
  return `message:${message.id}`;
}
```

- [ ] **Step 5: Run tests for the passing implementation**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS for all tests in `a2a-protocol.test.ts`.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/package.json apps/bridge/src/a2a-protocol.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: add A2A protocol classification"
```

Expected: commit succeeds.

---

### Task 2: Addressability, Activation, and Fanout Selection

**Files:**
- Modify: `apps/bridge/src/a2a-protocol.ts`
- Modify: `apps/bridge/src/a2a-protocol.test.ts`

- [ ] **Step 1: Add failing activation tests**

Append to `apps/bridge/src/a2a-protocol.test.ts`:

```ts
import {
  selectActivationCandidates,
  type ProtocolAgent,
  type ProtocolRecentMessage,
} from "./a2a-protocol";

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
```

- [ ] **Step 2: Run failing activation tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: FAIL because `selectActivationCandidates`, `ProtocolAgent`, and `ProtocolRecentMessage` are not exported.

- [ ] **Step 3: Implement activation selection**

Append to `apps/bridge/src/a2a-protocol.ts`:

```ts
export interface ProtocolAgent {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
}

export interface ProtocolRecentMessage {
  senderId: string;
  senderType: SenderType;
  content: string;
  createdAt: string;
}

export interface ActivationCandidate {
  agentId: string;
  reasons: ActivationReason[];
  strength: ActivationStrength;
}

export interface SuppressedCandidate {
  agentId: string;
  reason: "sender" | "low_value_intent" | "fanout_cap" | "no_obligation";
  reasons: ActivationReason[];
}

export interface ActivationSelectionInput {
  message: ProtocolMessage;
  agents: ProtocolAgent[];
  space: ConversationSpace;
  intents: MessageIntent[];
  topicKey: string;
  recentMessages: ProtocolRecentMessage[];
  task: ProtocolTaskRef | null;
}

export interface ActivationSelection {
  activated: ActivationCandidate[];
  suppressed: SuppressedCandidate[];
}

const REVIEW_TERMS = ["review", "reviewer", "approve", "approval", "risk", "critique", "检查", "评审"];
const VERIFY_TERMS = ["verify", "verifier", "validation", "test", "evidence", "smoke", "验证", "测试"];
const IMPLEMENT_TERMS = ["implement", "implementation", "build", "code", "fix", "change", "实现", "修复"];

function pushReason(map: Map<string, ActivationCandidate>, agentId: string, reason: ActivationReason, strength: ActivationStrength) {
  const current = map.get(agentId);
  if (!current) {
    map.set(agentId, { agentId, reasons: [reason], strength });
    return;
  }

  if (!current.reasons.includes(reason)) current.reasons.push(reason);
  if (current.strength === "weak" && (strength === "medium" || strength === "strong")) current.strength = strength;
  if (current.strength === "medium" && strength === "strong") current.strength = strength;
}

function normalizedIncludes(content: string, value: string) {
  return content.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

function matchesAgent(content: string, agent: ProtocolAgent) {
  return normalizedIncludes(content, `@${agent.name}`) || normalizedIncludes(content, agent.displayName) || normalizedIncludes(content, agent.name);
}

function matchesDomain(content: string, agent: ProtocolAgent) {
  const haystack = `${content}\n${agent.displayName}\n${agent.name}\n${agent.description || ""}`.toLocaleLowerCase();
  if (REVIEW_TERMS.some((term) => haystack.includes(term.toLocaleLowerCase()))) return true;
  if (VERIFY_TERMS.some((term) => haystack.includes(term.toLocaleLowerCase()))) return true;
  if (IMPLEMENT_TERMS.some((term) => haystack.includes(term.toLocaleLowerCase()))) return true;
  return false;
}

function fanoutLimit(space: ConversationSpace, senderType: SenderType) {
  if (space === "general_channel") return senderType === "agent" ? 1 : 2;
  if (space === "project_channel") return senderType === "agent" ? 2 : 3;
  if (space === "thread" || space === "task_thread") return 3;
  return Number.POSITIVE_INFINITY;
}

export function selectActivationCandidates(input: ActivationSelectionInput): ActivationSelection {
  const candidates = new Map<string, ActivationCandidate>();
  const suppressed: SuppressedCandidate[] = [];
  const actionable = hasActionableIntent(input.intents);
  const lowValue = hasOnlyLowValueIntent(input.intents);

  for (const agent of input.agents) {
    if (agent.id === input.message.senderId) {
      suppressed.push({ agentId: agent.id, reason: "sender", reasons: [] });
      continue;
    }

    const explicitMention = normalizedIncludes(input.message.content, `@${agent.name}`) || normalizedIncludes(input.message.content, `@${agent.displayName}`);
    if (explicitMention) pushReason(candidates, agent.id, "direct_mention", "strong");

    if (input.space === "dm") pushReason(candidates, agent.id, "dm_recipient", "strong");

    if (input.task?.assigneeId === agent.id) pushReason(candidates, agent.id, "task_owner", "strong");
    if (input.task?.reviewerId === agent.id) pushReason(candidates, agent.id, "review_owner", "strong");
    if (input.task?.createdById === agent.id) pushReason(candidates, agent.id, "task_creator", "medium");

    const naturalReference = matchesAgent(input.message.content, agent) && !explicitMention;
    if (naturalReference) {
      if (actionable) pushReason(candidates, agent.id, "natural_reference", "medium");
      else suppressed.push({ agentId: agent.id, reason: "low_value_intent", reasons: ["natural_reference"] });
    }

    const lastOtherSpeaker = [...input.recentMessages].reverse().find((m) => m.senderType === "agent" && m.senderId !== input.message.senderId);
    if (lastOtherSpeaker?.senderId === agent.id && actionable && /\b(you|your|take another look|continue|please check|can you|could you)\b/i.test(input.message.content)) {
      pushReason(candidates, agent.id, "conversation_continuation", input.space === "thread" || input.space === "task_thread" ? "strong" : "medium");
    }

    if (!naturalReference && !explicitMention && actionable && matchesDomain(input.message.content, agent)) {
      pushReason(candidates, agent.id, input.message.content.match(/\b(can someone|who can|need help)\b/i) ? "open_call_candidate" : "domain_fit", "weak");
    }
  }

  const activated = Array.from(candidates.values()).filter((candidate) => {
    if (lowValue && !candidate.reasons.includes("direct_mention") && !candidate.reasons.includes("dm_recipient")) {
      suppressed.push({ agentId: candidate.agentId, reason: "low_value_intent", reasons: candidate.reasons });
      return false;
    }
    return true;
  });

  const strong = activated.filter((candidate) => candidate.strength === "strong");
  const natural = activated.filter((candidate) => candidate.strength !== "strong");
  const limit = fanoutLimit(input.space, input.message.senderType);
  const allowedNatural = natural.slice(0, Math.max(0, limit - strong.length));
  const capped = natural.slice(allowedNatural.length);

  for (const candidate of capped) suppressed.push({ agentId: candidate.agentId, reason: "fanout_cap", reasons: candidate.reasons });

  return { activated: [...strong, ...allowedNatural], suppressed };
}
```

- [ ] **Step 4: Run activation tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS for all activation tests.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/src/a2a-protocol.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: select A2A activation candidates"
```

Expected: commit succeeds.

---

### Task 3: Loop Guards, Cooldowns, and Activation Envelopes

**Files:**
- Modify: `apps/bridge/src/a2a-protocol.ts`
- Modify: `apps/bridge/src/a2a-protocol.test.ts`

- [ ] **Step 1: Add failing loop guard and envelope tests**

Append to `apps/bridge/src/a2a-protocol.test.ts`:

```ts
import {
  buildActivationEnvelope,
  buildCooldownKey,
  shouldSuppressForCooldown,
  type ActivationCooldownEntry,
} from "./a2a-protocol";

describe("loop guard helpers", () => {
  it("builds stable cooldown keys", () => {
    expect(buildCooldownKey({ topicKey: "task:1", channelId: "channel-1", sourceAgentId: "agent-a", targetAgentId: "agent-b", reason: "review_needed" })).toBe(
      "task:1|channel-1|agent-a|agent-b|review_needed",
    );
  });

  it("suppresses repeated cooldown entries", () => {
    const now = Date.parse("2026-05-12T00:05:00.000Z");
    const entries = new Map<string, ActivationCooldownEntry>([
      [
        "task:1|channel-1|agent-a|agent-b|review_needed",
        { lastActivatedAt: Date.parse("2026-05-12T00:00:00.000Z"), sourceMessageId: "msg-old" },
      ],
    ]);

    expect(
      shouldSuppressForCooldown({
        key: "task:1|channel-1|agent-a|agent-b|review_needed",
        entries,
        now,
        cooldownMs: 10 * 60 * 1000,
        bypass: false,
      }),
    ).toEqual({ suppress: true, reason: "cooldown" });
  });

  it("does not suppress explicit bypass events", () => {
    const now = Date.parse("2026-05-12T00:05:00.000Z");
    const entries = new Map<string, ActivationCooldownEntry>([
      [
        "task:1|channel-1|agent-a|agent-b|direct_mention",
        { lastActivatedAt: Date.parse("2026-05-12T00:00:00.000Z"), sourceMessageId: "msg-old" },
      ],
    ]);

    expect(
      shouldSuppressForCooldown({
        key: "task:1|channel-1|agent-a|agent-b|direct_mention",
        entries,
        now,
        cooldownMs: 10 * 60 * 1000,
        bypass: true,
      }),
    ).toEqual({ suppress: false });
  });
});

describe("buildActivationEnvelope", () => {
  it("formats a structured activation envelope", () => {
    expect(
      buildActivationEnvelope({
        targetAgentName: "Beta",
        space: "project_channel",
        intents: ["handoff", "review_needed"],
        reasons: ["natural_reference", "review_owner"],
        strength: "medium",
        sourceMessageId: "msg-1",
        topicKey: "task:1",
        hopCount: 1,
        loopConstraints: ["cooldown: clear", "fanout: within cap"],
      }),
    ).toContain("[A2A_ACTIVATION");
  });

  it("tells agents they are not required to reply", () => {
    expect(
      buildActivationEnvelope({
        targetAgentName: "Beta",
        space: "project_channel",
        intents: ["handoff"],
        reasons: ["handoff_target"],
        strength: "strong",
        sourceMessageId: "msg-1",
        topicKey: "task:1",
        hopCount: 0,
        loopConstraints: [],
      }),
    ).toContain("You are not required to reply");
  });
});
```

- [ ] **Step 2: Run failing loop guard tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: FAIL because loop guard and envelope helpers are not exported.

- [ ] **Step 3: Implement cooldown and envelope helpers**

Append to `apps/bridge/src/a2a-protocol.ts`:

```ts
export interface ActivationCooldownEntry {
  lastActivatedAt: number;
  sourceMessageId: string;
}

export interface CooldownKeyInput {
  topicKey: string;
  channelId: string;
  sourceAgentId: string;
  targetAgentId: string;
  reason: string;
}

export function buildCooldownKey(input: CooldownKeyInput): string {
  return [input.topicKey, input.channelId, input.sourceAgentId, input.targetAgentId, input.reason].join("|");
}

export interface CooldownCheckInput {
  key: string;
  entries: Map<string, ActivationCooldownEntry>;
  now: number;
  cooldownMs: number;
  bypass: boolean;
}

export function shouldSuppressForCooldown(input: CooldownCheckInput): { suppress: boolean; reason?: "cooldown" } {
  if (input.bypass) return { suppress: false };
  const entry = input.entries.get(input.key);
  if (!entry) return { suppress: false };
  return input.now - entry.lastActivatedAt < input.cooldownMs
    ? { suppress: true, reason: "cooldown" }
    : { suppress: false };
}

export interface ActivationEnvelopeInput {
  targetAgentName: string;
  space: ConversationSpace;
  intents: MessageIntent[];
  reasons: ActivationReason[];
  strength: ActivationStrength;
  sourceMessageId: string;
  topicKey: string;
  hopCount: number;
  loopConstraints: string[];
}

export function buildActivationEnvelope(input: ActivationEnvelopeInput): string {
  return `[A2A_ACTIVATION
agent=${input.targetAgentName}
space=${input.space}
intents=${input.intents.join(",")}
activation_reasons=${input.reasons.join(",")}
activation_strength=${input.strength}
source_message=${input.sourceMessageId}
topic_key=${input.topicKey}
hop_count=${input.hopCount}
loop_constraints=${input.loopConstraints.join("; ") || "none"}
expected_decision=Choose one internal mode before doing anything visible: REPLY_AND_WORK, WORK_SILENTLY, REPLY_ONLY, OBSERVE, or SKIP. You are not required to reply. Send a message only if it adds new result, evidence, blocker, decision, question, ownership, handoff, correction, or completion value.
]`;
}
```

- [ ] **Step 4: Run loop guard tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS for all protocol tests.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/src/a2a-protocol.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: add A2A loop guard helpers"
```

Expected: commit succeeds.

---

### Task 4: Bridge Integration with Task and Thread Context

**Files:**
- Modify: `apps/bridge/src/bridge.ts:19-423`
- Modify: `apps/bridge/src/a2a-protocol.ts`
- Modify: `apps/bridge/src/a2a-protocol.test.ts`

- [ ] **Step 1: Add test for bridge-ready context conversion**

Append to `apps/bridge/src/a2a-protocol.test.ts`:

```ts
describe("bridge integration helpers", () => {
  it("uses direct mentions as cooldown bypass", () => {
    const result = selectActivationCandidates({
      message: msg({ senderType: "agent", senderId: "agent-a", content: "@beta please check this." }),
      agents,
      space: "project_channel",
      intents: ["request"],
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(result.activated[0]).toEqual(
      expect.objectContaining({ reasons: expect.arrayContaining(["direct_mention"]), strength: "strong" }),
    );
  });
});
```

- [ ] **Step 2: Run tests before bridge integration**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS. This establishes protocol helpers are ready before bridge wiring.

- [ ] **Step 3: Import protocol helpers in bridge**

Modify the top of `apps/bridge/src/bridge.ts` to include:

```ts
import {
  buildActivationEnvelope,
  buildCooldownKey,
  classifyConversationSpace,
  classifyMessageIntent,
  deriveTopicKey,
  selectActivationCandidates,
  shouldSuppressForCooldown,
  type ActivationCooldownEntry,
  type ActivationReason,
  type ProtocolAgent,
  type ProtocolMessage,
  type ProtocolRecentMessage,
  type ProtocolTaskRef,
} from "./a2a-protocol.js";
```

Keep existing imports.

- [ ] **Step 4: Add bridge context interfaces and state**

In `apps/bridge/src/bridge.ts`, after `interface DbChannelMember`, add:

```ts
interface DbTaskRoutingRef {
  id: string;
  task_number: number;
  message_id: string | null;
  source_message_id: string | null;
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by_id: string | null;
}
```

Inside `Bridge` class near `processedMessageIds`, add:

```ts
private activationCooldowns = new Map<string, ActivationCooldownEntry>();
private topicHopCounts = new Map<string, number>();
```

- [ ] **Step 5: Add task and recent message loaders**

Add these private methods before `handleNewMessage` in `apps/bridge/src/bridge.ts`:

```ts
private toProtocolAgents(agentIds: Set<string>): ProtocolAgent[] {
  return Array.from(agentIds)
    .map((agentId) => {
      const agent = this.agentRecords.get(agentId);
      if (!agent) return null;
      return {
        id: agentId,
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
      } satisfies ProtocolAgent;
    })
    .filter((agent): agent is ProtocolAgent => agent !== null);
}

private async findRoutingTaskForMessage(msg: DbMessage): Promise<ProtocolTaskRef | null> {
  const messageIds = [msg.id, msg.thread_parent_id].filter(Boolean) as string[];
  if (messageIds.length === 0) return null;

  const { data } = await this.supabase
    .from("tasks")
    .select("id, task_number, message_id, source_message_id, assignee_id, reviewer_id, created_by_id")
    .or(messageIds.map((id) => `message_id.eq.${id},source_message_id.eq.${id}`).join(","))
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const task = data as DbTaskRoutingRef;
  return {
    id: task.id,
    taskNumber: task.task_number,
    messageId: task.message_id,
    sourceMessageId: task.source_message_id,
    assigneeId: task.assignee_id,
    reviewerId: task.reviewer_id,
    createdById: task.created_by_id,
  };
}

private async getRecentProtocolMessages(channelId: string, threadParentId: string | null): Promise<ProtocolRecentMessage[]> {
  let query = this.supabase
    .from("messages")
    .select("sender_id, sender_type, content, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(8);

  if (threadParentId) query = query.eq("thread_parent_id", threadParentId);
  else query = query.is("thread_parent_id", null);

  const { data } = await query;
  return (data || []).reverse().map((message) => ({
    senderId: message.sender_id,
    senderType: message.sender_type,
    content: message.content,
    createdAt: message.created_at,
  }));
}

private formatRoutingLog(input: {
  messageId: string;
  topicKey: string;
  activated: Array<{ agentId: string; reasons: ActivationReason[]; strength: string }>;
  suppressed: Array<{ agentId: string; reason: string; reasons: ActivationReason[] }>;
}) {
  const activated = input.activated.map((candidate) => {
    const agent = this.agentRecords.get(candidate.agentId);
    return `${agent?.display_name || candidate.agentId}:${candidate.strength}:${candidate.reasons.join("+")}`;
  });
  const suppressed = input.suppressed.map((candidate) => {
    const agent = this.agentRecords.get(candidate.agentId);
    return `${agent?.display_name || candidate.agentId}:${candidate.reason}:${candidate.reasons.join("+")}`;
  });
  console.log(`  [A2A] route msg=${input.messageId.slice(0, 8)} topic=${input.topicKey} activated=[${activated.join(", ")}] suppressed=[${suppressed.join(", ")}]`);
}
```

- [ ] **Step 6: Replace `handleNewMessage` routing body**

In `apps/bridge/src/bridge.ts`, replace the section from `const channelType = this.channelTypes.get(msg.channel_id);` through the prompt construction `if (!isDm ...` block with protocol routing:

```ts
const channelType = this.channelTypes.get(msg.channel_id) as "dm" | "public" | "private" | undefined;
const isDm = channelType === "dm";
const task = await this.findRoutingTaskForMessage(msg);
const space = classifyConversationSpace({ channelType: channelType || "private", threadParentId: msg.thread_parent_id, task });
const protocolMessage: ProtocolMessage = {
  id: msg.id,
  channelId: msg.channel_id,
  senderId: msg.sender_id,
  senderType: msg.sender_type,
  content: msg.content,
  threadParentId: msg.thread_parent_id,
  createdAt: msg.created_at,
};
const intents = classifyMessageIntent(msg.content);
const topicKey = deriveTopicKey(protocolMessage, task);
const recentMessages = await this.getRecentProtocolMessages(msg.channel_id, msg.thread_parent_id);
const selection = selectActivationCandidates({
  message: protocolMessage,
  agents: this.toProtocolAgents(agentIdsInChannel),
  space,
  intents,
  topicKey,
  recentMessages,
  task,
});

const now = Date.now();
const activated = [];
const cooldownSuppressed = [];
for (const candidate of selection.activated) {
  const bypass = candidate.reasons.includes("direct_mention") || candidate.reasons.includes("dm_recipient") || msg.sender_type === "human";
  const key = buildCooldownKey({
    topicKey,
    channelId: msg.channel_id,
    sourceAgentId: msg.sender_id,
    targetAgentId: candidate.agentId,
    reason: candidate.reasons[0] || "conversation_continuation",
  });
  const cooldown = shouldSuppressForCooldown({
    key,
    entries: this.activationCooldowns,
    now,
    cooldownMs: 10 * 60 * 1000,
    bypass,
  });
  if (cooldown.suppress) {
    cooldownSuppressed.push({ agentId: candidate.agentId, reason: cooldown.reason || "cooldown", reasons: candidate.reasons });
    continue;
  }
  this.activationCooldowns.set(key, { lastActivatedAt: now, sourceMessageId: msg.id });
  activated.push(candidate);
}

this.formatRoutingLog({
  messageId: msg.id,
  topicKey,
  activated,
  suppressed: [...selection.suppressed, ...cooldownSuppressed],
});

if (activated.length === 0) return;

const senderName = await this.resolveSenderName(msg.sender_id, msg.sender_type);
const channelTarget = this.buildChannelTarget(msg.channel_id, senderName);
let contextPrefix = "";
if (!isDm) contextPrefix = await this.getChannelContext(msg.channel_id);
const previousHop = this.topicHopCounts.get(topicKey) || 0;
const hopCount = msg.sender_type === "agent" ? previousHop + 1 : 0;
this.topicHopCounts.set(topicKey, hopCount);

for (const candidate of activated) {
  const agent = this.agentRecords.get(candidate.agentId);
  if (!agent) continue;

  console.log(
    `  [${agent.display_name}] A2A activated (${candidate.strength}:${candidate.reasons.join("+")}): "${msg.content.substring(0, 60)}${msg.content.length > 60 ? "..." : ""}"`
  );

  try {
    const envelope = buildActivationEnvelope({
      targetAgentName: agent.display_name,
      space,
      intents,
      reasons: candidate.reasons,
      strength: candidate.strength,
      sourceMessageId: msg.id,
      topicKey,
      hopCount,
      loopConstraints: ["response-value-required", "no-idle-narration", "respect-ownership"],
    });
    const msgHeader = `[target=${channelTarget} sender=@${senderName} type=${msg.sender_type}]`;
    const prompt = contextPrefix
      ? `${envelope}\n\n${contextPrefix}\n\n${msgHeader} ${msg.content}`
      : `${envelope}\n\n${msgHeader} ${msg.content}`;

    await this.agentManager.sendToAgent(candidate.agentId, prompt);
  } catch (err) {
    console.error(
      `  [${agent.display_name}] Error:`,
      err instanceof Error ? err.message : err
    );
  }
}
```

Ensure the old `mentioned`, `respondingAgentIds`, and old prompt blocks are removed from `handleNewMessage`.

- [ ] **Step 7: Build bridge after integration**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build
```

Expected: `tsc` exits 0. If TypeScript complains about Supabase `.or()` syntax or `maybeSingle`, adjust only the query shape while preserving behavior.

- [ ] **Step 8: Run protocol tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/src/bridge.ts apps/bridge/src/a2a-protocol.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: route bridge messages through A2A protocol"
```

Expected: commit succeeds.

---

### Task 5: Agent Prompt Contract

**Files:**
- Modify: `apps/bridge/src/system-prompt.ts:49-190`
- Test: `apps/bridge/src/a2a-protocol.test.ts`

- [ ] **Step 1: Add prompt contract test**

Append to `apps/bridge/src/a2a-protocol.test.ts`:

```ts
import { buildSystemPrompt } from "./system-prompt";

describe("system prompt A2A contract", () => {
  it("teaches agents all A2A decision modes", () => {
    const prompt = buildSystemPrompt(
      { display_name: "Beta", name: "beta", description: null, system_prompt: null },
      "",
    );

    expect(prompt).toContain("REPLY_AND_WORK");
    expect(prompt).toContain("WORK_SILENTLY");
    expect(prompt).toContain("REPLY_ONLY");
    expect(prompt).toContain("OBSERVE");
    expect(prompt).toContain("SKIP");
  });

  it("forbids sending literal SKIP into chat", () => {
    const prompt = buildSystemPrompt(
      { display_name: "Beta", name: "beta", description: null, system_prompt: null },
      "",
    );

    expect(prompt).toContain("Never send the literal word `SKIP` into chat");
  });
});
```

- [ ] **Step 2: Run failing prompt tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: FAIL because the system prompt does not yet include all decision modes or the literal-SKIP rule.

- [ ] **Step 3: Replace startup and conversation etiquette guidance**

In `apps/bridge/src/system-prompt.ts`, replace lines 49-56 with:

```ts
## Startup sequence

1. If this turn includes an `A2A_ACTIVATION` envelope, read it first. It explains why you were awakened; it does not require you to reply.
2. Before doing anything visible, choose one internal decision mode: `REPLY_AND_WORK`, `WORK_SILENTLY`, `REPLY_ONLY`, `OBSERVE`, or `SKIP`.
3. Read MEMORY.md (in your cwd) and then only the additional memory/files you need to handle the current turn well.
4. If there is no concrete incoming message or activation to handle, stop and wait. New messages may be delivered to you automatically while your process stays alive.
5. Complete owned work before stopping. If you are blocked, report the blocker only when someone else can act on it.
```

- [ ] **Step 4: Add the A2A decision protocol section**

In `apps/bridge/src/system-prompt.ts`, after the “Channel awareness” section and before “Reading history”, insert:

```ts
## A2A Conversation Protocol

When you are awakened in a group conversation, that means the message may involve you. It does not mean you must speak. First choose one internal decision mode:

- `REPLY_AND_WORK` — you are taking ownership or continuing owned work, and others need to know. Send one concise ownership/result/blocker/handoff message, then work.
- `WORK_SILENTLY` — you own the next action and a visible acknowledgement would add noise. Do the work, then report only a result, blocker, evidence, decision, or handoff.
- `REPLY_ONLY` — answer a question, clarify, or make a decision without taking additional work.
- `OBSERVE` — the topic is relevant, but another owner is handling it. Do not reply or claim work.
- `SKIP` — the message is irrelevant, already handled, pure acknowledgement, thanks, repeated status, or would not benefit from your response.

Never send the literal word `SKIP` into chat. `SKIP` and `OBSERVE` are internal decisions.

Visible messages must add at least one of: new result, new evidence, new blocker, new decision, new question needed to proceed, new ownership claim, new handoff, correction of a misunderstanding, or completion signal for a previously open item.

Do not send messages that only say: received, waiting, sounds good, I will keep watching, I agree, or a repeated summary of someone else’s work.

If you hand work to another agent, use an explicit @mention and include the concrete next action. If you are handed work and can proceed, prefer `WORK_SILENTLY` unless public ownership or a blocker must be visible.
```

- [ ] **Step 5: Update task and mention guidance**

In `apps/bridge/src/system-prompt.ts`, adjust the task/mention guidance so it says:

```ts
When someone sends a message that asks you to do work and you choose `REPLY_AND_WORK` or `WORK_SILENTLY`, claim or reuse the relevant task before starting. If another agent already owns the work, choose `OBSERVE` unless you were explicitly asked to help, own a dependency, or found a blocker.
```

Do not remove existing task commands or CLI instructions.

- [ ] **Step 6: Run prompt contract tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 7: Build bridge**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build
```

Expected: `tsc` exits 0.

- [ ] **Step 8: Commit Task 5**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/src/system-prompt.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: teach agents A2A decision modes"
```

Expected: commit succeeds.

---

### Task 6: Activity State Semantics

**Files:**
- Modify: `packages/shared/src/index.ts:33-44`
- Modify: `apps/bridge/src/agent-manager.ts:9-188`
- Modify: `apps/web/src/components/member-activity-tab.tsx:122-129`
- Test: `packages/shared/src/collaboration.test.ts`

- [ ] **Step 1: Add shared type test for new activity states**

Append to `packages/shared/src/collaboration.test.ts`:

```ts
import type { AgentActivity } from "./index";

describe("AgentActivity", () => {
  it("accepts A2A quiet collaboration states", () => {
    const states: AgentActivity[] = ["idle", "thinking", "working", "working_silently", "observing", "blocked", "error"];
    expect(states).toContain("working_silently");
    expect(states).toContain("observing");
    expect(states).toContain("blocked");
  });
});
```

- [ ] **Step 2: Run failing shared test**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/shared test -- src/collaboration.test.ts
```

Expected: FAIL because `working_silently`, `observing`, and `blocked` are not valid `AgentActivity` values.

- [ ] **Step 3: Extend shared `AgentActivity`**

Modify `packages/shared/src/index.ts:35`:

```ts
export type AgentActivity = "idle" | "thinking" | "working" | "working_silently" | "observing" | "blocked" | "error";
```

- [ ] **Step 4: Extend bridge activity type and event mapping**

Modify `apps/bridge/src/agent-manager.ts:9`:

```ts
type AgentActivity = "idle" | "thinking" | "working" | "working_silently" | "observing" | "blocked" | "error";
```

Modify the event type mapping around `apps/bridge/src/agent-manager.ts:184-188` to:

```ts
const eventType = activity === "working" && label && label !== "Working"
  ? "agent.tool_use"
  : `agent.${activity}`;
```

This mapping already works for the new states because it stores string event names like `agent.observing`.

- [ ] **Step 5: Update member activity tab badge handling**

Modify `apps/web/src/components/member-activity-tab.tsx` active activity badge logic around line 126 to treat `blocked` and `error` as error badges, `observing` as secondary, and working states as success:

```tsx
const activityBadgeVariant = agentActivity.activity === "error" || agentActivity.activity === "blocked"
  ? "error"
  : agentActivity.activity === "observing"
    ? "secondary"
    : "success";
```

Then update:

```tsx
<Badge className="shrink-0" variant={activityBadgeVariant}>{agentActivity.activity}</Badge>
```

Place `activityBadgeVariant` in `MemberActivityTab` before the `return`.

- [ ] **Step 6: Run shared tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/shared test -- src/collaboration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Type-check bridge and web-relevant packages**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/web lint
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit Task 6**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add packages/shared/src/index.ts packages/shared/src/collaboration.test.ts apps/bridge/src/agent-manager.ts apps/web/src/components/member-activity-tab.tsx && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "feat: add A2A quiet activity states"
```

Expected: commit succeeds.

---

### Task 7: End-to-End Routing Verification Harness

**Files:**
- Modify: `apps/bridge/src/a2a-protocol.test.ts`
- Modify: `apps/bridge/src/a2a-protocol.ts`

- [ ] **Step 1: Add end-to-end protocol scenario tests**

Append to `apps/bridge/src/a2a-protocol.test.ts`:

```ts
describe("A2A target-state scenarios", () => {
  it("wakes a responsible reviewer for natural handoff without explicit mention", () => {
    const message = msg({ senderType: "agent", senderId: "agent-a", content: "The change is ready; reviewer should check the risk section before close." });
    const intents = classifyMessageIntent(message.content);
    const selection = selectActivationCandidates({
      message,
      agents,
      space: "project_channel",
      intents,
      topicKey: "task:42",
      recentMessages: [],
      task: { id: "task-42", taskNumber: 42, messageId: "message-42", sourceMessageId: "message-42", assigneeId: "agent-a", reviewerId: "agent-b", createdById: null },
    });

    expect(selection.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", strength: "strong", reasons: expect.arrayContaining(["review_owner"]) }),
    ]);
  });

  it("does not wake agents for pure status summaries", () => {
    const message = msg({ senderType: "agent", senderId: "agent-a", content: "The verifier already completed the smoke check and found no issue." });
    const intents = classifyMessageIntent(message.content);
    const selection = selectActivationCandidates({
      message,
      agents,
      space: "project_channel",
      intents,
      topicKey: "task:42",
      recentMessages: [],
      task: null,
    });

    expect(selection.activated).toEqual([]);
  });

  it("keeps explicit mentions reliable even for low-value-looking text", () => {
    const message = msg({ senderType: "agent", senderId: "agent-a", content: "@beta sounds good, please confirm final approval." });
    const intents = classifyMessageIntent(message.content);
    const selection = selectActivationCandidates({
      message,
      agents,
      space: "general_channel",
      intents,
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(selection.activated).toEqual([
      expect.objectContaining({ agentId: "agent-b", strength: "strong", reasons: expect.arrayContaining(["direct_mention"]) }),
    ]);
  });

  it("keeps open calls bounded", () => {
    const message = msg({ senderType: "human", senderId: "human-1", content: "Can someone inspect, validate, and document the failure?" });
    const intents = classifyMessageIntent(message.content);
    const selection = selectActivationCandidates({
      message,
      agents,
      space: "project_channel",
      intents,
      topicKey: "message:msg-1",
      recentMessages: [],
      task: null,
    });

    expect(selection.activated.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run scenario tests**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts
```

Expected: PASS. If a scenario fails, adjust protocol helpers only enough to match the approved spec; do not add domain-specific hard-coded names from the user's current conversation.

- [ ] **Step 3: Build all affected packages**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/shared build && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/web lint
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit Task 7**

Run:

```bash
git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail add apps/bridge/src/a2a-protocol.ts apps/bridge/src/a2a-protocol.test.ts && git -C /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail commit -m "test: cover A2A routing scenarios"
```

Expected: commit succeeds.

---

### Task 8: Runtime Verification with Local Bridge

**Files:**
- No code changes expected.
- Uses local runtime processes from `/Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail`.

- [ ] **Step 1: Stop old member-detail bridge process**

Run:

```bash
ps aux | grep -E "AgentTeam/.worktrees/member-detail.*(zano-bridge|dist/index.js|--filter @fehey/zano-bridge|apps/bridge)|node dist/index.js" | grep -v grep
```

Expected: shows current bridge process if one is running.

Then stop only the member-detail bridge processes listed by that command:

```bash
kill <pid1> <pid2> <pid3>
```

Expected: rerunning the `ps aux | grep ...` command shows no member-detail bridge process.

- [ ] **Step 2: Build bridge for runtime**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build
```

Expected: `tsc` exits 0.

- [ ] **Step 3: Start bridge with local API key without exposing key in process args**

Create a temporary env file manually using the current workspace API key supplied by the user, then run:

```bash
(set -a; source /private/tmp/zano-bridge-member-detail.env; set +a; rm -f /private/tmp/zano-bridge-member-detail.env; exec pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge start)
```

Expected log includes:

```text
Authenticated as user ...
Workspace: ...
Loaded ... agent(s) from database.
Subscribed to Supabase Realtime.
Bridge ready. Listening for messages across ... channel(s).
Bridge presence tracked.
```

- [ ] **Step 4: Verify routing logs manually**

In the web UI, send these general, domain-neutral messages in a project channel containing multiple agents:

```text
Can someone inspect why the import flow is timing out?
```

Expected bridge log shape:

```text
[A2A] route msg=... topic=message:... activated=[...] suppressed=[...fanout_cap...]
```

The activated list should be bounded, not all agents.

Then send:

```text
The implementation is complete; reviewer should check the risk section before we close this.
```

Expected: a naturally referenced reviewer-like agent or review owner is activated if one exists in the channel context; no broad broadcast occurs.

Then send:

```text
The verifier already completed the smoke check and found no issue.
```

Expected: no new natural A2A activation unless there is an explicit mention or relevant task ownership requiring action.

- [ ] **Step 5: Verify agent behavior**

Observe the chat and member activity UI:

- Agents should not post literal `SKIP`.
- Agents should not all reply to a status message.
- Explicit `@mentions` should still wake the intended agent.
- Natural handoffs should produce either silent work, a useful result, a blocker, or no visible message if the agent chooses observe/skip.
- Member activity should render `working_silently`, `observing`, and `blocked` if those states are emitted.

- [ ] **Step 6: Capture final verification commands**

Run:

```bash
pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge test -- src/a2a-protocol.test.ts && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @fehey/zano-bridge build && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/shared test -- src/collaboration.test.ts && pnpm --dir /Users/biangwua/Documents/biang/thinkAndTry/AgentTeam/.worktrees/member-detail --filter @zano/web lint
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit runtime verification notes only if code changed during verification**

If runtime verification required code changes, commit them with a specific message. If no files changed, do not create an empty commit.

---

## Self-Review

### Spec Coverage

- Conversation spaces: Task 1 implements space classification; Task 4 uses it in bridge.
- Message intents: Task 1 implements intent classification; Task 7 verifies target scenarios.
- Addressability and obligation: Task 2 implements explicit mentions, natural references, task ownership, recent participant continuation, open calls, and domain fit.
- Activation envelope: Task 3 formats structured envelopes; Task 4 sends them to agents.
- Candidate selection and fanout: Task 2 implements bounded fanout and suppression.
- Agent decision modes: Task 5 updates system prompt contract.
- Response value rule: Task 3 envelope and Task 5 system prompt enforce it.
- Loop control: Task 3 adds cooldown helpers; Task 4 applies cooldown and hop counts; Task 2 applies fanout.
- Topic identity: Task 1 derives topic keys; Task 4 uses them.
- Bridge responsibilities: Task 4 integrates routing, context, and logs.
- Agent responsibilities: Task 5 updates system prompt.
- Visible state semantics: Task 6 extends shared/bridge/web activity states.
- Debugging and observability: Task 4 routing logs and Task 8 runtime checks cover it.
- Success criteria: Task 7 and Task 8 cover explicit mentions, natural handoff, pure status suppression, bounded open calls, no literal SKIP, and runtime observation.

### Placeholder Scan

This plan contains no TBD/TODO placeholders. Each code step includes concrete code or exact replacement instructions.

### Type Consistency

The plan consistently uses:

- `ProtocolMessage`
- `ProtocolTaskRef`
- `ProtocolAgent`
- `ProtocolRecentMessage`
- `ActivationCandidate`
- `ActivationCooldownEntry`
- `buildActivationEnvelope`
- `selectActivationCandidates`
- `classifyConversationSpace`
- `classifyMessageIntent`
- `deriveTopicKey`

These names are introduced before later tasks reference them.
