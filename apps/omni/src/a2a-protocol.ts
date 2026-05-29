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
  ["request", /\b(can someone|could someone|can you|could you|please|need someone|needs to|must|do this|take this|handle this|look into|inspect|investigate|fix|implement|verify|document|introduce yourselves?|introduce yourself|everyone introduce)\b|(?:大家|各位).*(?:自我介绍|介绍一下自己|介绍自己|说下自己|说一下自己|讲下自己|讲一下自己|自己负责什么)|(?:大家|各位).*(?:看一下|看下|看看|检查|审核|审查|评审|验证|确认|排查|处理|修复|实现)|(?:请|麻烦)(?:大家|各位).*(?:介绍自己|介绍一下自己|自我介绍)|请(?:验证|检查|审核|审查|确认|评审|补充|介绍|同步|提供|更新|汇报)|帮我.{0,24}(?:收一下|收尾|收口|确认|看看)|(?:推进|推动|跟进|同步|更新|汇报).{0,12}(?:进度|状态|计划|方案|结论)|(?:进度|状态).{0,12}(?:推进|推动|跟进|同步|更新|汇报)/i],
  ["question", /\?|？|\b(which|what|why|how|when|where|who|should we|can you|could you)\b/i],
  ["handoff", /\b(handoff|hand off|pass to|over to|take over|continue|next step|follow up|should (?:check|review|verify)|please (?:check|review|verify))\b/i],
  ["blocker", /\b(blocked|blocker|critical issue|serious issue|major issue|bug|error|crash(?:es|ed|ing)?|failure|failed|regression|cannot|can't|unable|waiting on|until .* confirms?|depends on|need .* before)\b/i],
  ["decision_needed", /\b((?:please|can you|could you)\s+confirm|until .* confirms?|decide(?: whether)?|decision\s+(?:needed|required)|approve\b|approval\s+(?:needed|required|is required)|choose|select|sign[- ]?off(?:\s+is\s+(?:needed|required))?|sign off(?:\s+is\s+(?:needed|required))?|go\/no-go)\b|请确认/i],
  ["review_needed", /\b(?:please|should|needs?|must|can you|could you)\s+review\b|\bneeds?\s+(?:[^.!?;]*\s+)?review\b|\breview\s+(?:this|the|these|that)\b|\b(?:approval needed|check .* risk|look over|take another look|critique)\b|(?:请|需要)(?:检查|审核|审查|评审)/i],
  ["verification_needed", /\b(verify|validate|evidence|regression|(?:please|can you|could you)\s+confirm .* works|(?:run|perform|need|needs|please|could someone)\s+(?:a\s+)?(?:smoke|test))\b|请(?:验证|确认)/i],
  ["correction", /\b(not that|instead|change|wrong|incorrect|revise|adjust|stop|don't|no,)\b/i],
  ["assignment", /\b(assign|owner|responsible|take|claim|belongs to|owned by)\b/i],
  ["escalation", /\b(stuck|need help|escalate|urgent|blocked hard|can't proceed)\b/i],
];

const INFORMATIONAL_PATTERNS: Array<[MessageIntent, RegExp]> = [
  ["ack", /\b(ok|okay|sounds good|sgtm|received|got it|ack|noted)\b/i],
  ["thanks", /\b(thanks|thank you|appreciate)\b|辛苦|谢谢/i],
  ["result", /\b(done|completed?|finished|result|findings|found|confirmed|fixed|implemented|verified|passed|failed|approved|received|granted|own|owns)\b|负责|我的默认工作方式/i],
  ["decision", /\b(decided|approved|rejected|selected|we will|we'll|final decision)\b/i],
  ["status", /\b(in progress|working on|currently|status|progress|waiting|pending|in review|ongoing|already|i am|i'm)\b|已|正在|等待|我是|负责|我的默认工作方式/i],
  ["chatter", /\b(hello|hi|hey|good morning|good night|lol|haha)\b/i],
];

const BENIGN_COMPLETION_PATTERN =
  /\b(?:verification|verifier|review|reviewer|handoff|check|fix|next step|smoke test|test(?:s)?)\b[\s\S]*\b(?:is\s+)?(?:complete|completed|done|finished|passed|found no (?:issue|issues|problem|problems)|no (?:issue|issues|problem|problems)|no regression was found|confirms? .* works?)\b|\bit confirms?\b[\s\S]*\bworks?\b|\bno tests? failed\b/i;

const EXPLICIT_ACTION_PATTERN =
  /\b(?:please|can someone|could someone|can you|could you|need someone|needs to|must|look into|inspect|run|should (?:check|review|verify)|needs? review|decide(?: whether)?|decision\s+(?:needed|required)|approve\b|approval\s+(?:needed|required|is required)|choose|select|sign[- ]?off(?:\s+is\s+(?:needed|required))?|sign off(?:\s+is\s+(?:needed|required))?)\b|(?:^|[.!?;]\s*|,\s*|\bto\s+|\bthen\s+)(?:hand off|fix|implement|investigate|verify|review|check)\b|\breview\s+(?:this|the|these|that)\b|请(?:验证|检查|审核|审查|确认|评审|补充)/i;

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

export interface ActivationCooldownEntry {
  lastActivatedAt: number;
  sourceMessageId: string;
}

export interface CooldownKeyInput {
  topicKey: string;
  channelId: string;
  sourceAgentId: string;
  targetAgentId: string;
  reason: ActivationReason | MessageIntent;
}

export function buildCooldownKey(input: CooldownKeyInput): string {
  return JSON.stringify([input.topicKey, input.channelId, input.sourceAgentId, input.targetAgentId, input.reason]);
}

export interface CooldownCheckInput {
  key: string;
  entries: Map<string, ActivationCooldownEntry>;
  now: number;
  cooldownMs: number;
  bypass: boolean;
}

/**
 * Suppresses only exact directed cooldown keys. Broader hop/topic loop guards are enforced by Omni integration.
 */
export function shouldSuppressForCooldown(input: CooldownCheckInput): { suppress: boolean; reason?: "cooldown" } {
  if (input.bypass) return { suppress: false };
  const entry = input.entries.get(input.key);
  if (!entry) return { suppress: false };
  return input.now - entry.lastActivatedAt < input.cooldownMs ? { suppress: true, reason: "cooldown" } : { suppress: false };
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
  return `[A2A_ACTIVATION ${JSON.stringify({
    agent: input.targetAgentName,
    space: input.space,
    intents: input.intents,
    activation_reasons: input.reasons,
    activation_strength: input.strength,
    source_message: input.sourceMessageId,
    topic_key: input.topicKey,
    hop_count: input.hopCount,
    loop_constraints: input.loopConstraints,
    expected_decision:
      "Choose one internal mode before doing anything visible: REPLY_AND_WORK, WORK_SILENTLY, REPLY_ONLY, OBSERVE, or SKIP. You are not required to reply. Send a message only if it adds new result, evidence, blocker, decision, question, ownership, handoff, correction, or completion value.",
  })}]`;
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

export interface A2AMessageSummary {
  id: string;
  text: string;
  createdAt: string;
}

export interface DeliveryThreadContext {
  parentMessage: A2AMessageSummary;
  recentMessages: A2AMessageSummary[];
  suggestedReadTarget: string;
  threadTarget: string;
}

export interface A2ADeliveryPlanRecord<TAgent = ProtocolAgent> {
  agent: TAgent;
  threadContext?: DeliveryThreadContext;
}

export interface A2ADeliveryPlanInput<TDelivery extends { agent: unknown } = A2ADeliveryPlanRecord> {
  message: ProtocolMessage & { text?: string; threadId?: string };
  deliveries: TDelivery[];
  thread?: {
    id: string;
    parentMessage: A2AMessageSummary;
    recentMessages: A2AMessageSummary[];
  };
  suggestedReadTarget?: string;
  threadTarget?: string;
}

export interface A2ADeliveryPlan<TDelivery extends { agent: unknown } = A2ADeliveryPlanRecord> {
  deliveries: Array<TDelivery & { threadContext?: DeliveryThreadContext }>;
}

function buildThreadJoinContext(input: { parentMessage: A2AMessageSummary; recentMessages: A2AMessageSummary[]; suggestedReadTarget: string; threadTarget: string }): DeliveryThreadContext {
  return {
    parentMessage: input.parentMessage,
    recentMessages: input.recentMessages.slice(-10),
    suggestedReadTarget: input.suggestedReadTarget,
    threadTarget: input.threadTarget,
  };
}

export function planA2ADeliveries<TDelivery extends { agent: unknown }>(input: A2ADeliveryPlanInput<TDelivery>): A2ADeliveryPlan<TDelivery> {
  const messageThreadId = input.message.threadId ?? input.message.threadParentId ?? null;
  const hasMatchingThread = Boolean(messageThreadId && input.thread?.id === messageThreadId);
  const threadContext = hasMatchingThread && input.thread?.parentMessage && Array.isArray(input.thread.recentMessages) && input.suggestedReadTarget && input.threadTarget
    ? buildThreadJoinContext({
        parentMessage: input.thread.parentMessage,
        recentMessages: input.thread.recentMessages,
        suggestedReadTarget: input.suggestedReadTarget,
        threadTarget: input.threadTarget,
      })
    : undefined;

  const deliveries = threadContext
    ? input.deliveries.map((delivery) => ({ ...delivery, threadContext }))
    : input.deliveries;

  return { deliveries: deliveries as Array<TDelivery & { threadContext?: DeliveryThreadContext }> };
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
  threadParticipantAgentIds?: string[];
}

export interface ActivationSelection {
  activated: ActivationCandidate[];
  suppressed: SuppressedCandidate[];
}

const REVIEW_TERMS = ["review", "reviewer", "approve", "approval", "risk", "critique", "inspect", "qa", "quality", "检查", "评审", "审查", "审核", "确认", "风险", "质量"];
const VERIFY_TERMS = ["verify", "verifier", "validate", "validation", "inspect", "inspection", "test", "evidence", "smoke", "qa", "quality", "检查", "验证", "测试", "确认", "质量"];
const IMPLEMENT_TERMS = ["implement", "implementation", "build", "code", "fix", "change", "develop", "实现", "修复"];
const DOCUMENTATION_TERMS = ["document", "documentation", "docs", "writeup", "guide", "readme", "checklist", "runbook", "writer", "technical writer", "说明", "文档"];
const PRODUCT_TERMS = ["product", "product owner", "prd", "roadmap", "requirements", "产品", "路线图", "用户故事"];
const FRONTEND_TERMS = ["frontend", "front end", "ui", "ux", "browser", "react", "前端", "前后端", "页面", "组件", "交互"];
const BACKEND_TERMS = ["backend", "back end", "server", "api", "database", "db", "service", "后端", "前后端", "服务端", "接口", "数据库", "构建号"];

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

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCjk(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function publicAgentHandle(displayName: string, fallback = "Agent") {
  const handle = displayName
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
  return handle || fallback;
}

function agentNameVariants(agent: ProtocolAgent) {
  return Array.from(new Set([agent.name, agent.displayName, publicAgentHandle(agent.displayName, agent.name)].filter(Boolean)));
}

function tokenAwarePattern(value: string, prefix = "") {
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegex(prefix + value)}(?=$|[^\\p{L}\\p{N}_-])`, "iu");
}

function hasTokenAwareTerm(content: string, value: string, prefix = "") {
  if (!prefix && containsCjk(value)) return content.toLocaleLowerCase().includes(value.toLocaleLowerCase());
  return tokenAwarePattern(value, prefix).test(content);
}

const REVIEW_ROLE_TERMS = ["reviewer", "review owner", "approval owner", "评审者"];
const VERIFY_ROLE_TERMS = ["verifier", "verification owner", "validation owner", "tester", "验证者"];
const IMPLEMENT_ROLE_TERMS = ["implementer", "implementation owner", "builder", "developer", "修复者", "实现者"];
const DOCUMENTATION_ROLE_TERMS = ["documenter", "documentation owner", "docs owner", "writer", "technical writer", "文档负责人"];
const PRODUCT_ROLE_TERMS = ["product", "product owner", "pm", "产品", "产品经理", "产品工程师", "需求负责人"];
const FRONTEND_ROLE_TERMS = ["frontend", "front end", "ui", "前端", "前端工程师", "前后端"];
const BACKEND_ROLE_TERMS = ["backend", "back end", "server", "api", "后端", "后端工程师", "服务端", "前后端"];

const SHORT_DOMAIN_TOKENS = new Set(["api", "ui", "ux", "db", "auth", "sso", "i18n"]);

const GENERIC_DOMAIN_STOPWORDS = new Set([
  "work",
  "works",
  "own",
  "owns",
  "owner",
  "team",
  "task",
  "this",
  "that",
  "these",
  "those",
  "someone",
  "please",
  "check",
  "handle",
  "help",
  "need",
  "needs",
  "can",
  "could",
  "should",
]);

function matchesDirectMention(content: string, agent: ProtocolAgent) {
  return agentNameVariants(agent).some((name) => hasTokenAwareTerm(content, name, "@"));
}

function matchesNaturalName(content: string, agent: ProtocolAgent) {
  return agentNameVariants(agent).some((name) => hasTokenAwareTerm(content, name));
}

function matchesAgent(content: string, agent: ProtocolAgent) {
  if (matchesDirectMention(content, agent) || matchesNaturalName(content, agent)) return true;
  const agentProfile = `${agent.displayName}\n${agent.name}\n${publicAgentHandle(agent.displayName, agent.name)}\n${agent.description || ""}`;
  if (hasAnyTerm(content, REVIEW_ROLE_TERMS) && hasAnyTerm(agentProfile, REVIEW_TERMS)) return true;
  if (hasAnyTerm(content, VERIFY_ROLE_TERMS) && hasAnyTerm(agentProfile, VERIFY_TERMS)) return true;
  if (hasAnyTerm(content, IMPLEMENT_ROLE_TERMS) && hasAnyTerm(agentProfile, IMPLEMENT_TERMS)) return true;
  if (hasAnyTerm(content, DOCUMENTATION_ROLE_TERMS) && hasAnyTerm(agentProfile, DOCUMENTATION_TERMS)) return true;
  if (hasAnyTerm(content, FRONTEND_ROLE_TERMS) && hasAnyTerm(agentProfile, FRONTEND_TERMS)) return true;
  if (hasAnyTerm(content, BACKEND_ROLE_TERMS) && hasAnyTerm(agentProfile, BACKEND_TERMS)) return true;
  if (hasTargetedProductRoleReference(content) && hasAnyTerm(agentProfile, PRODUCT_TERMS)) return true;
  return false;
}

function hasTargetedProductRoleReference(content: string) {
  if (!hasAnyTerm(content, PRODUCT_ROLE_TERMS)) return false;
  return /(?:产品(?:工程师|经理)?|需求负责人|product(?: owner)?|pm).{0,16}(?:推进|推动|跟进|同步|更新|汇报|补充|处理|收一下|收尾|收口|收|出|给)|(?:请|麻烦|帮我).{0,12}(?:产品(?:工程师|经理)?|需求负责人|product(?: owner)?|pm)/i.test(content);
}

function hasAnyTerm(content: string, terms: string[]) {
  return terms.some((term) => hasTokenAwareTerm(content, term));
}

function meaningfulDomainTokens(content: string) {
  return (content.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
    (token) => (token.length >= 5 || SHORT_DOMAIN_TOKENS.has(token)) && !GENERIC_DOMAIN_STOPWORDS.has(token),
  );
}

function contentForDomainMatching(content: string) {
  return content
    .replace(/\bimplementation(?:\s+work)?\s+(?:(?:is|was|has been)\s+)?(?:complete|completed|done|finished)\b/gi, "")
    .replace(/\b(?:complete|completed|done|finished)\s+implementation(?:\s+work)?\b/gi, "")
    .replace(/(?:实现|开发)(?:工作)?(?:已经|已|目前)?(?:完成|结束)/g, "")
    .replace(/产品(?:侧)?确认(?:边界|口径|范围)/g, "");
}

function tokenOverlapCount(content: string, agent: ProtocolAgent) {
  const contentTokens = new Set(meaningfulDomainTokens(content));
  if (contentTokens.size === 0) return 0;

  const agentProfile = `${agent.displayName}\n${agent.name}\n${publicAgentHandle(agent.displayName, agent.name)}\n${agent.description || ""}`;
  return meaningfulDomainTokens(agentProfile).filter((token) => contentTokens.has(token)).length;
}

const DOMAIN_TERM_GROUPS = [
  ["review", REVIEW_TERMS],
  ["verification", VERIFY_TERMS],
  ["implementation", IMPLEMENT_TERMS],
  ["documentation", DOCUMENTATION_TERMS],
  ["product", PRODUCT_TERMS],
  ["frontend", FRONTEND_TERMS],
  ["backend", BACKEND_TERMS],
] as const;

function matchedDomainKeys(content: string, agent: ProtocolAgent) {
  const agentProfile = `${agent.displayName}\n${agent.name}\n${publicAgentHandle(agent.displayName, agent.name)}\n${agent.description || ""}`;
  const normalizedContent = contentForDomainMatching(content);
  const domainKeys = DOMAIN_TERM_GROUPS.filter(([, terms]) => hasAnyTerm(normalizedContent, terms) && hasAnyTerm(agentProfile, terms)).map(
    ([domain]) => domain,
  );
  const contentTokens = new Set(meaningfulDomainTokens(normalizedContent));
  const agentTokens = new Set(meaningfulDomainTokens(agentProfile));
  const shortDomainKeys = [...contentTokens].filter((token) => SHORT_DOMAIN_TOKENS.has(token) && agentTokens.has(token));
  return [...domainKeys, ...shortDomainKeys];
}

function domainScore(content: string, agent: ProtocolAgent) {
  return matchedDomainKeys(content, agent).length * 3 + Math.min(tokenOverlapCount(contentForDomainMatching(content), agent), 2);
}

function domainCoverageScore(content: string, agent: ProtocolAgent, selected: ActivationCandidate[], agentsById: Map<string, ProtocolAgent>) {
  const selectedDomains = new Set(
    selected.flatMap((candidate) => {
      const selectedAgent = agentsById.get(candidate.agentId);
      return selectedAgent ? matchedDomainKeys(content, selectedAgent) : [];
    }),
  );
  const domainMatches = matchedDomainKeys(content, agent);
  const newDomainMatches = domainMatches.filter((domain) => !selectedDomains.has(domain)).length;
  return newDomainMatches * 10 + domainMatches.length * 3 + Math.min(tokenOverlapCount(contentForDomainMatching(content), agent), 2);
}

function matchesDomain(content: string, agent: ProtocolAgent) {
  return domainScore(content, agent) > 0;
}

function strengthRank(strength: ActivationStrength) {
  if (strength === "strong") return 3;
  if (strength === "medium") return 2;
  return 1;
}

function isOpenCall(content: string) {
  return /\b(can someone|could someone|who can|need help|needs? someone)\b/i.test(content);
}

function hasNegatedSelfIntroduction(content: string) {
  return (
    /\b(?:no need(?:\s+for\s+everyone)?\s+to|do not|don't|dont|stop|not asking (?:everyone|all of you) to)\s+introduc(?:e|ing)\s+(?:yourself|yourselves)\b/i.test(content) ||
    /(?:不要|不用|无需|没必要|不需要|避免|别|先别|停止|不是让).{0,16}(?:自我介绍|介绍一下自己|介绍自己|说下自己|说一下自己|讲下自己|讲一下自己|自己负责什么)/.test(content)
  );
}

function hasSelfIntroductionRequest(content: string) {
  return /\b(?:everyone|every\s+one|everybody|all of you)[\s,，]*(?:please\s+)?introduce (?:yourself|yourselves)\b|^(?:\s|[\s\S]*\b(?:everyone|every\s+one|everybody|all of you)\b[\s,，]*)introduce yourselves\b|(?:大家|各位).*(?:自我介绍|介绍一下自己|介绍自己|说下自己|说一下自己|讲下自己|讲一下自己|自己负责什么)/i.test(content);
}

function hasGroupAddressedGreeting(content: string) {
  return (
    /^\s*(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))[\s,，]*(?:everyone|every\s+one|everybody|all|team|folks)[!.。！\s]*$/i.test(content) ||
    /^\s*(?:hello|hi|hey)[\s,，]*(?:大家|各位)[!.。！\s]*$/i.test(content) ||
    /^\s*(?:大家|各位)好[!.。！\s]*$/.test(content)
  );
}

function hasConcreteRoomActionRequest(content: string) {
  return (
    /\b(?:please|can someone|could someone|can you|could you|everyone|every\s+one|everybody|team|all|folks)[\s\S]{0,40}\b(?:inspect|review|validate|verify|fix|implement|check|look into|run|document|handle|investigate)\b/i.test(content) ||
    /(?:大家|各位).{0,16}(?:看一下|看下|看看|检查|审核|审查|评审|验证|确认|排查|处理|修复|实现)/.test(content)
  );
}

function hasRoomAddressedCheckIn(content: string) {
  if (hasConcreteRoomActionRequest(content)) return false;
  return (
    /(?:大家|各位).{0,32}(?:怎么看|怎么想|觉得.{0,12}(?:吗|呢|\?|？)|有什么(?:更新|进展|想法|意见|阻塞|问题)|有(?:更新|进展|想法|意见|阻塞|问题).{0,8}(?:吗|没|没有|\?|？)|有没有(?:更新|进展|想法|意见|阻塞|问题)|(?:任务|进度|状态|进展|完成).{0,12}(?:怎么样|怎样|咋样|如何|吗|呢|啦|\?|？))/.test(content) ||
    /\bwhat\s+does\s+(?:everyone|every\s+one|everybody)\s+think\b/i.test(content) ||
    /\bwhat\s+do\s+you\s+all\s+think\b/i.test(content) ||
    /\bhow\s+is\s+(?:everyone|every\s+one|everybody)\s+doing\b/i.test(content) ||
    /^\s*(?:team|all|folks)[\s,，]+(?:any\s+(?:updates?|status|blockers?)|status\s+updates?|thoughts|blockers?\s+or\s+updates|how\s+are\s+we\s+looking)[?.!？。！\s]*$/i.test(content) ||
    /^\s*(?:everyone|every\s+one|everybody)[\s,，]+(?:how\s+are\s+we\s+looking|any\s+(?:updates?|status|blockers?)|thoughts|status\s+updates?)\s*[?.!？。！\s]*$/i.test(content)
  );
}

function isAgentSelfIntroduction(content: string) {
  return /(?:^|[\s\n])(?:大家好|各位好|(?:hello|hi|hey)[\s,，]*(?:everyone|every\s+one|everybody|all|team|folks))[\s\S]{0,120}(?:我是|I'm|I am|负责|my role|my default|own|owns)/i.test(content);
}

function isHumanChannelBroadcast(input: ActivationSelectionInput) {
  return input.message.senderType === "human" && (input.space === "project_channel" || input.space === "general_channel");
}

function fanoutLimit(space: ConversationSpace, senderType: SenderType) {
  if (space === "general_channel") return senderType === "agent" ? 1 : 2;
  if (space === "project_channel") return senderType === "agent" ? 2 : 2;
  if (space === "thread" || space === "task_thread") return 3;
  return Number.POSITIVE_INFINITY;
}

function isThreadParticipant(input: ActivationSelectionInput, agentId: string) {
  return (input.space === "thread" || input.space === "task_thread") && (input.threadParticipantAgentIds || []).includes(agentId);
}

function isHandoffIntent(intents: MessageIntent[]) {
  return intents.includes("handoff") || intents.includes("assignment") || intents.includes("review_needed") || intents.includes("verification_needed");
}

function hasLowValueBypassReason(reasons: ActivationReason[]) {
  return reasons.some((reason) =>
    [
      "direct_mention",
      "dm_recipient",
      "thread_participant",
      "task_owner",
      "task_creator",
      "handoff_target",
      "blocker_owner",
      "decision_owner",
      "review_owner",
      "verification_owner",
      "system_assignment",
      "channel_broadcast",
      "conversation_continuation",
    ].includes(reason),
  );
}

export function selectActivationCandidates(input: ActivationSelectionInput): ActivationSelection {
  const candidates = new Map<string, ActivationCandidate>();
  const suppressed: SuppressedCandidate[] = [];
  const actionable = hasActionableIntent(input.intents);
  const lowValue = hasOnlyLowValueIntent(input.intents);
  const broadcast = isHumanChannelBroadcast(input);
  const suppressAgentSelfIntroCascade = input.message.senderType === "agent" && isAgentSelfIntroduction(input.message.content);
  const lastOtherSpeaker = [...input.recentMessages].reverse().find((m) => m.senderType === "agent" && m.senderId !== input.message.senderId);

  for (const agent of input.agents) {
    const isSender = agent.id === input.message.senderId;
    const explicitMention = matchesDirectMention(input.message.content, agent);
    const naturalReference = matchesAgent(input.message.content, agent) && !explicitMention;

    if (isSender) {
      const senderReasons: ActivationReason[] = [];
      if (explicitMention) senderReasons.push("direct_mention");
      if (input.space === "dm") senderReasons.push("dm_recipient");
      if (input.task?.assigneeId === agent.id) senderReasons.push("task_owner");
      if (input.task?.reviewerId === agent.id) senderReasons.push("review_owner");
      if (input.task?.createdById === agent.id) senderReasons.push("task_creator");
      if (isThreadParticipant(input, agent.id)) senderReasons.push("thread_participant");
      if (naturalReference && !suppressAgentSelfIntroCascade) {
        if (isHandoffIntent(input.intents)) senderReasons.push("handoff_target");
        senderReasons.push("natural_reference");
      }
      if (!suppressAgentSelfIntroCascade && isOpenCall(input.message.content) && actionable && input.space === "project_channel" && matchesDomain(input.message.content, agent)) senderReasons.push("open_call_candidate");
      if (lastOtherSpeaker?.senderId === agent.id && actionable && (input.space === "thread" || input.space === "task_thread" || input.space === "dm") && /\b(you|your|take another look|continue|please check|can you|could you)\b/i.test(input.message.content)) senderReasons.push("conversation_continuation");
      if (!suppressAgentSelfIntroCascade && !naturalReference && !explicitMention && actionable && matchesDomain(input.message.content, agent)) senderReasons.push(isOpenCall(input.message.content) ? "open_call_candidate" : "domain_fit");
      if (senderReasons.length > 0) suppressed.push({ agentId: agent.id, reason: "sender", reasons: senderReasons });
      continue;
    }

    if (explicitMention) pushReason(candidates, agent.id, "direct_mention", "strong");

    if (input.space === "dm") pushReason(candidates, agent.id, "dm_recipient", "strong");

    if (input.task?.assigneeId === agent.id) pushReason(candidates, agent.id, "task_owner", "strong");
    if (input.task?.reviewerId === agent.id) pushReason(candidates, agent.id, "review_owner", "strong");
    if (input.task?.createdById === agent.id) pushReason(candidates, agent.id, "task_creator", "medium");
    if (isThreadParticipant(input, agent.id)) pushReason(candidates, agent.id, "thread_participant", "strong");

    if (broadcast) pushReason(candidates, agent.id, "channel_broadcast", "medium");

    if (naturalReference && !suppressAgentSelfIntroCascade) {
      if (actionable) {
        if (isHandoffIntent(input.intents)) pushReason(candidates, agent.id, "handoff_target", "strong");
        pushReason(candidates, agent.id, "natural_reference", "medium");
      } else suppressed.push({ agentId: agent.id, reason: "low_value_intent", reasons: ["natural_reference"] });
    }

    if (!suppressAgentSelfIntroCascade && isOpenCall(input.message.content) && actionable && input.space === "project_channel" && matchesDomain(input.message.content, agent)) {
      pushReason(candidates, agent.id, "open_call_candidate", "weak");
    }

    if (lastOtherSpeaker?.senderId === agent.id && actionable && (input.space === "thread" || input.space === "task_thread" || input.space === "dm") && /\b(you|your|take another look|continue|please check|can you|could you)\b/i.test(input.message.content)) {
      pushReason(candidates, agent.id, "conversation_continuation", input.space === "thread" || input.space === "task_thread" ? "strong" : "medium");
    }

    if (!suppressAgentSelfIntroCascade && !naturalReference && !explicitMention && actionable && matchesDomain(input.message.content, agent)) {
      pushReason(candidates, agent.id, isOpenCall(input.message.content) ? "open_call_candidate" : "domain_fit", "weak");
    }
  }

  const activated = Array.from(candidates.values()).filter((candidate) => {
    if (lowValue && !hasLowValueBypassReason(candidate.reasons)) {
      suppressed.push({ agentId: candidate.agentId, reason: "low_value_intent", reasons: candidate.reasons });
      return false;
    }
    return true;
  });

  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const strong = activated.filter((candidate) => candidate.strength === "strong");
  const channelBroadcast = activated.filter((candidate) => candidate.strength !== "strong" && candidate.reasons.includes("channel_broadcast"));
  const natural = activated
    .filter((candidate) => candidate.strength !== "strong" && !candidate.reasons.includes("channel_broadcast"))
    .sort((a, b) => {
      const strengthDifference = strengthRank(b.strength) - strengthRank(a.strength);
      if (strengthDifference !== 0) return strengthDifference;
      return domainScore(input.message.content, agentsById.get(b.agentId)!) - domainScore(input.message.content, agentsById.get(a.agentId)!);
    });
  const hasExplicitNaturalTarget = natural.some((candidate) => candidate.strength === "medium" && candidate.reasons.includes("natural_reference"));
  const limit = fanoutLimit(input.space, input.message.senderType);
  const allowedNatural: ActivationCandidate[] = [];
  const remainingNatural = hasExplicitNaturalTarget
    ? natural.filter((candidate) => candidate.strength !== "weak" || !candidate.reasons.every((reason) => reason === "domain_fit" || reason === "open_call_candidate"))
    : [...natural];
  const filteredWeakDomainCandidates = hasExplicitNaturalTarget
    ? natural.filter((candidate) => candidate.strength === "weak" && candidate.reasons.every((reason) => reason === "domain_fit" || reason === "open_call_candidate"))
    : [];
  const selectedForCoverage = [...strong];

  while (allowedNatural.length < limit && remainingNatural.length > 0) {
    remainingNatural.sort((a, b) => {
      const strengthDifference = strengthRank(b.strength) - strengthRank(a.strength);
      if (strengthDifference !== 0) return strengthDifference;
      const coverageDifference =
        domainCoverageScore(input.message.content, agentsById.get(b.agentId)!, selectedForCoverage, agentsById) -
        domainCoverageScore(input.message.content, agentsById.get(a.agentId)!, selectedForCoverage, agentsById);
      if (coverageDifference !== 0) return coverageDifference;
      return domainScore(input.message.content, agentsById.get(b.agentId)!) - domainScore(input.message.content, agentsById.get(a.agentId)!);
    });
    const selected = remainingNatural.shift()!;
    allowedNatural.push(selected);
    selectedForCoverage.push(selected);
  }

  const capped = [...remainingNatural, ...filteredWeakDomainCandidates];

  for (const candidate of capped) suppressed.push({ agentId: candidate.agentId, reason: "fanout_cap", reasons: candidate.reasons });

  return { activated: [...strong, ...channelBroadcast, ...allowedNatural], suppressed };
}
