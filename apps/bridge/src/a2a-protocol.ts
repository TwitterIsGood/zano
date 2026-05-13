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
  channelType: ChannelKind | (string & {});
  threadParentId: string | null;
  task: ProtocolTaskRef | null;
}

const ACTIONABLE_INTENTS: ReadonlySet<MessageIntent> = new Set([
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
]);

const LOW_VALUE_INTENTS: ReadonlySet<MessageIntent> = new Set(["ack", "thanks", "chatter", "status", "result", "decision"]);

const ACTION_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["request", /\b(can someone|could someone|can you|could you|please|need someone|needs to|must|do this|take this|handle this|look into|inspect|investigate|fix|implement|verify)\b|请(?:验证|检查|审核|审查|确认)/i],
  ["question", /\?|\b(which|what|why|how|when|where|who|should we|can you|could you)\b/i],
  ["handoff", /\b(handoff|hand off|pass to|over to|take over|continue|next step|follow up|should (?:check|review|verify)|please (?:check|review|verify))\b/i],
  ["blocker", /\b(blocked|blocker|critical issue|serious issue|major issue|bug|error|crash(?:es|ed|ing)?|failure|failed|regression|cannot|can't|unable|waiting on|until .* confirms?|depends on|need .* before)\b/i],
  ["decision_needed", /\b((?:please|can you|could you)\s+confirm|until .* confirms?|decide(?: whether)?|decision\s+(?:needed|required)|approve\b|approval\s+(?:needed|required|is required)|choose|select|sign[- ]?off(?:\s+is\s+(?:needed|required))?|sign off(?:\s+is\s+(?:needed|required))?|go\/no-go)\b/i],
  ["review_needed", /\b(?:please|should|needs?|must|can you|could you)\s+review\b|\breview\s+(?:this|the|these|that)\b|\b(?:approval needed|check .* risk|look over|take another look|critique)\b|请(?:检查|审核|审查)/i],
  ["verification_needed", /\b(verify|validate|evidence|regression|(?:please|can you|could you)\s+confirm .* works|(?:run|perform|need|needs|please|could someone)\s+(?:a\s+)?(?:smoke|test))\b|请(?:验证|确认)/i],
  ["correction", /\b(not that|instead|change|wrong|incorrect|revise|adjust|stop|don't|no,)\b/i],
  ["assignment", /\b(assign|owner|responsible|take|claim|belongs to|owned by)\b/i],
  ["escalation", /\b(stuck|need help|escalate|urgent|blocked hard|can't proceed)\b/i],
];

const INFORMATIONAL_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["ack", /\b(ok|okay|sounds good|sgtm|received|got it|ack|noted)\b/i],
  ["thanks", /\b(thanks|thank you|appreciate)\b|辛苦|谢谢/i],
  ["result", /\b(done|completed?|finished|result|findings|found|confirmed|fixed|implemented|verified|passed|failed|approved|received|granted)\b/i],
  ["decision", /\b(decided|approved|rejected|selected|we will|we'll|final decision)\b/i],
  ["status", /\b(in progress|working on|currently|status|progress|waiting|pending|in review|ongoing|already)\b|已|正在|等待/i],
  ["chatter", /\b(hello|hi|hey|good morning|good night|lol|haha)\b/i],
];

const BENIGN_COMPLETION_PATTERN =
  /\b(?:verification|verifier|review|reviewer|handoff|check|fix|next step|smoke test|test(?:s)?)\b[\s\S]*\b(?:is\s+)?(?:complete|completed|done|finished|passed|found no (?:issue|issues|problem|problems)|no (?:issue|issues|problem|problems)|no regression was found|confirms? .* works?)\b|\bit confirms?\b[\s\S]*\bworks?\b|\bno tests? failed\b/i;

const EXPLICIT_ACTION_PATTERN =
  /\b(?:please|can someone|could someone|can you|could you|need someone|needs to|must|look into|inspect|run|should (?:check|review|verify)|needs? review|decide(?: whether)?|decision\s+(?:needed|required)|approve\b|approval\s+(?:needed|required|is required)|choose|select|sign[- ]?off(?:\s+is\s+(?:needed|required))?|sign off(?:\s+is\s+(?:needed|required))?)\b|(?:^|[.!?;]\s*|,\s*|\bto\s+|\bthen\s+)(?:hand off|fix|implement|investigate|verify|review|check)\b|\breview\s+(?:this|the|these|that)\b|请(?:验证|检查|审核|审查|确认)/i;

const PROBLEM_FINDING_PATTERN =
  /\b(?:critical issue|serious issue|major issue|bug|error|crash(?:es|ed|ing)?|failure|failed|regression|cannot|can't|unable|blocked|blocker)\b/i;

const PURE_NO_PROBLEM_SUMMARY_PATTERN =
  /\b(?:no (?:build|tests?) failed|no (?:critical issue|serious issue|major issue|issue|issues|problem|problems|bug|bugs|error|errors?|failure|failures|regression|regressions)(?: was | were )?(?:found|detected)?)\b/i;

const NEGATED_PROBLEM_PATTERN =
  /\b(?:no (?:build|tests?) failed|no (?:critical issue|serious issue|major issue|issue|issues|problem|problems|bug|bugs|error|errors?|failure|failures|regression|regressions)(?: was | were )?(?:found|detected)?)\b/gi;
const HIGH_SIGNAL_RESULT_PATTERN = /\b(?:found|crash(?:es|ed|ing)?)\b/i;

function normalizeNegatedProblemFindings(content: string): string {
  return content.replace(NEGATED_PROBLEM_PATTERN, "");
}

function hasProblemFinding(content: string): boolean {
  return PROBLEM_FINDING_PATTERN.test(normalizeNegatedProblemFindings(content));
}

function isPureBenignCompletionSummary(content: string): boolean {
  const normalizedProblemContent = normalizeNegatedProblemFindings(content);
  const hasBenignCompletion = BENIGN_COMPLETION_PATTERN.test(normalizedProblemContent) || PURE_NO_PROBLEM_SUMMARY_PATTERN.test(content);
  return hasBenignCompletion && !EXPLICIT_ACTION_PATTERN.test(normalizedProblemContent) && !hasProblemFinding(content);
}

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

  const normalizedProblemContent = normalizeNegatedProblemFindings(content);

  if (hasProblemFinding(content) && HIGH_SIGNAL_RESULT_PATTERN.test(normalizedProblemContent)) intents.add("result");

  if (isPureBenignCompletionSummary(content)) {
    intents.add("result");
    intents.delete("request");
    intents.delete("handoff");
    intents.delete("blocker");
    intents.delete("decision_needed");
    intents.delete("verification_needed");
    intents.delete("review_needed");
  }

  if (intents.size === 0) intents.add("chatter");
  return Array.from(intents);
}

export function hasActionableIntent(intents: MessageIntent[]): boolean {
  return intents.some((intent) => ACTIONABLE_INTENTS.has(intent));
}

export function hasOnlyLowValueIntent(intents: MessageIntent[]): boolean {
  return intents.length > 0 && intents.every((intent) => LOW_VALUE_INTENTS.has(intent));
}

export function deriveTopicKey(message: ProtocolMessage, task: ProtocolTaskRef | null): string {
  if (task) return `task:${task.id}`;
  if (message.threadParentId) return `thread:${message.threadParentId}`;
  return `message:${message.id}`;
}

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
  if (normalizedIncludes(content, `@${agent.name}`) || normalizedIncludes(content, agent.displayName) || normalizedIncludes(content, agent.name)) return true;
  const agentProfile = `${agent.displayName}\n${agent.name}\n${agent.description || ""}`;
  if (hasAnyTerm(content, REVIEW_TERMS) && hasAnyTerm(agentProfile, REVIEW_TERMS)) return true;
  if (hasAnyTerm(content, VERIFY_TERMS) && hasAnyTerm(agentProfile, VERIFY_TERMS)) return true;
  if (hasAnyTerm(content, IMPLEMENT_TERMS) && hasAnyTerm(agentProfile, IMPLEMENT_TERMS)) return true;
  return false;
}

function hasAnyTerm(content: string, terms: string[]) {
  return terms.some((term) => normalizedIncludes(content, term));
}

function matchesDomain(content: string, agent: ProtocolAgent) {
  const agentProfile = `${agent.displayName}\n${agent.name}\n${agent.description || ""}`;
  return (
    (hasAnyTerm(content, REVIEW_TERMS) && hasAnyTerm(agentProfile, REVIEW_TERMS)) ||
    (hasAnyTerm(content, VERIFY_TERMS) && hasAnyTerm(agentProfile, VERIFY_TERMS)) ||
    (hasAnyTerm(content, IMPLEMENT_TERMS) && hasAnyTerm(agentProfile, IMPLEMENT_TERMS))
  );
}

function isOpenCall(content: string) {
  return /\b(can someone|could someone|who can|need help|needs? someone)\b/i.test(content);
}

function fanoutLimit(space: ConversationSpace, senderType: SenderType) {
  if (space === "general_channel") return senderType === "agent" ? 1 : 2;
  if (space === "project_channel") return senderType === "agent" ? 2 : 2;
  if (space === "thread" || space === "task_thread") return 3;
  return Number.POSITIVE_INFINITY;
}

export function selectActivationCandidates(input: ActivationSelectionInput): ActivationSelection {
  const candidates = new Map<string, ActivationCandidate>();
  const suppressed: SuppressedCandidate[] = [];
  const actionable = hasActionableIntent(input.intents);
  const lowValue = hasOnlyLowValueIntent(input.intents);
  const lastOtherSpeaker = [...input.recentMessages].reverse().find((m) => m.senderType === "agent" && m.senderId !== input.message.senderId);

  for (const agent of input.agents) {
    const isSender = agent.id === input.message.senderId;
    const explicitMention = normalizedIncludes(input.message.content, `@${agent.name}`) || normalizedIncludes(input.message.content, `@${agent.displayName}`);
    const naturalReference = matchesAgent(input.message.content, agent) && !explicitMention;

    if (isSender) {
      const hasTaskObligation = input.task?.assigneeId === agent.id || input.task?.reviewerId === agent.id || input.task?.createdById === agent.id;
      if (!hasTaskObligation) continue;
    }

    if (explicitMention) pushReason(candidates, agent.id, "direct_mention", "strong");

    if (input.space === "dm") pushReason(candidates, agent.id, "dm_recipient", "strong");

    if (input.task?.assigneeId === agent.id) pushReason(candidates, agent.id, "task_owner", "strong");
    if (input.task?.reviewerId === agent.id) pushReason(candidates, agent.id, "review_owner", "strong");
    if (input.task?.createdById === agent.id) pushReason(candidates, agent.id, "task_creator", "medium");

    if (naturalReference) {
      if (actionable) pushReason(candidates, agent.id, "natural_reference", "medium");
      else suppressed.push({ agentId: agent.id, reason: "low_value_intent", reasons: ["natural_reference"] });
    }

    if (isOpenCall(input.message.content) && actionable && input.space === "project_channel") {
      pushReason(candidates, agent.id, "open_call_candidate", "weak");
    }

    if (lastOtherSpeaker?.senderId === agent.id && actionable && /\b(you|your|take another look|continue|please check|can you|could you)\b/i.test(input.message.content)) {
      pushReason(candidates, agent.id, "conversation_continuation", input.space === "thread" || input.space === "task_thread" ? "strong" : "medium");
    }

    if (!naturalReference && !explicitMention && actionable && matchesDomain(input.message.content, agent)) {
      pushReason(candidates, agent.id, isOpenCall(input.message.content) ? "open_call_candidate" : "domain_fit", "weak");
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
