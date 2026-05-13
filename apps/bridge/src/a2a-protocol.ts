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

const LOW_VALUE_INTENTS: ReadonlySet<MessageIntent> = new Set(["ack", "thanks", "chatter", "status", "result"]);

const ACTION_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["request", /\b(can someone|could someone|please|need someone|needs to|should|must|do this|take this|handle this|look into|inspect|investigate|fix|implement|verify)\b|请(?:验证|检查|审核|审查|确认)/i],
  ["question", /\?|\b(which|what|why|how|when|where|who|should we|can you|could you)\b/i],
  ["handoff", /\b(handoff|hand off|pass to|over to|take over|continue|next step|follow up|should check|should review|should verify|please check|please review|please verify)\b/i],
  ["blocker", /\b(blocked|blocker|critical issue|serious issue|major issue|failure|failed|cannot|can't|unable|waiting on|until .* confirms?|depends on|need .* before)\b/i],
  ["decision_needed", /\b(confirms?|decide|decision|approve|approval|approval needed|choose|select|sign off|signoff|go\/no-go)\b/i],
  ["review_needed", /\b(?:please|should|needs?|must|can you|could you)\s+review\b|\breview\s+(?:this|the|these|that)\b|\b(?:approval needed|check .* risk|look over|take another look|critique)\b|请(?:检查|审核|审查)/i],
  ["verification_needed", /\b(verify|verification|validate|evidence|regression|confirm .* works|(?:run|perform|need|needs|please)\s+(?:a\s+)?(?:smoke|test))\b|请(?:验证|确认)/i],
  ["correction", /\b(not that|instead|change|wrong|incorrect|revise|adjust|stop|don't|no,)\b/i],
  ["assignment", /\b(assign|owner|responsible|take|claim|belongs to|owned by)\b/i],
  ["escalation", /\b(stuck|need help|escalate|urgent|blocked hard|can't proceed)\b/i],
];

const INFORMATIONAL_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["ack", /\b(ok|okay|sounds good|sgtm|received|got it|ack|noted)\b/i],
  ["thanks", /\b(thanks|thank you|appreciate)\b|辛苦|谢谢/i],
  ["result", /\b(done|completed?|finished|result|findings|found|confirmed|fixed|implemented|verified|passed|failed)\b/i],
  ["decision", /\b(decided|approved|rejected|selected|we will|we'll|final decision)\b/i],
  ["status", /\b(in progress|working on|currently|status|progress|waiting|pending|in review|ongoing|already)\b|已|正在|等待/i],
  ["chatter", /\b(hello|hi|hey|good morning|good night|lol|haha)\b/i],
];

const BENIGN_COMPLETION_PATTERN =
  /\b(?:verification|verifier|review|reviewer|check|smoke test|test(?:s)?)\b[\s\S]*\b(?:complete|completed|done|finished|passed|found no (?:issue|issues|problem|problems)|no (?:issue|issues|problem|problems))\b|\bno tests? failed\b/i;

const EXPLICIT_ACTION_PATTERN =
  /\b(?:please|can someone|could someone|can you|could you|need someone|look into|inspect|investigate|fix|implement|verify|review\s+(?:this|the|these|that)|run|critical issue|serious issue|major issue|failure|decide|decision|approve|approval needed|choose|select|sign off|signoff)\b|请(?:验证|检查|审核|审查|确认)/i;

function isPureBenignCompletionSummary(content: string): boolean {
  return BENIGN_COMPLETION_PATTERN.test(content) && !EXPLICIT_ACTION_PATTERN.test(content);
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

  if (isPureBenignCompletionSummary(content)) {
    intents.add("result");
    intents.delete("request");
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
