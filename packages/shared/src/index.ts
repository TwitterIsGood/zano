// ============================================================
// Zano — Shared Types
// ============================================================

export * from "./collaboration";
export * from "./autonomous";

import type {
  ActorType,
  AgentRunStatus,
  DependencyType,
  DocumentStatus,
  ParticipantType,
  ReminderStatus,
  ReviewStatus,
  ReviewVerdict,
  StepStatus,
  TaskGate,
  TaskPriority,
  TaskReviewPolicy,
  TaskStatus,
  ThreadSubscriptionType,
} from "./collaboration";

// --- Users & Agents ---

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export type AgentModel = "opus" | "sonnet" | "haiku";
export type AgentStatus = "online" | "sleeping" | "offline";
export type AgentCreatorType = "human" | "agent" | "system";
export type AgentCreationSource = "human" | "agent" | "blueprint" | "system" | "migration";
export type AgentActivity = "idle" | "thinking" | "working" | "working_silently" | "observing" | "blocked" | "error";

export const DAEMON_DELIVERY_STATE_LABELS = {
  accepted: "ACKed: daemon accepted custody",
  queued_starting: "Queued: runtime is starting",
  queued_busy: "Queued: runtime is busy",
  queued_gated: "Queued: waiting for safe runtime boundary",
  queued_compaction: "Queued: waiting for compaction-safe boundary",
  restarting_idle: "Restarting from idle",
  delivering: "Delivering to runtime",
  delivered: "Delivered to runtime input",
  completed: "Derived work evidence observed",
  failed: "Daemon/runtime diagnostic error",
  cancelled: "Cancelled",
} as const;

export const DAEMON_RUNTIME_OUTCOME_LABELS = {
  queued_busy: "Runtime busy",
  queued_during_start: "Queued during runtime start",
  deferred_wake_message: "Wake message deferred",
  auto_restart_from_idle: "Auto restart from idle",
  rejected_no_process: "Daemon did not accept custody",
  stdin_idle_delivery: "Full delivery at idle/turn-end",
  queued_stalled_recovery: "Queued during stalled recovery",
  queued_busy_non_stdin: "Queued for non-stdin runtime",
  queued_before_session: "Queued before session id",
  queued_compaction_boundary: "Queued at compaction boundary",
  queued_busy_gated: "Queued behind Claude gated steering",
  queued_busy_notification: "Pending-message notification sent",
} as const;

export interface AgentActivityEvent {
  agentId: string;
  activity: AgentActivity;
  /** Human-readable label: "Thinking", "Reading file", "Sending message", etc. */
  label?: string;
  /** Specific detail: file path, command, message target, or agent text output */
  detail?: string;
  occurredAt?: string;
}

export interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: AgentModel;
  status: AgentStatus;
  owner_id: string;
  server_id: string;
  created_by_id: string | null;
  created_by_type: AgentCreatorType;
  parent_agent_id: string | null;
  root_agent_id: string | null;
  creation_source: AgentCreationSource;
  creation_reason: string | null;
  creation_context: Record<string, unknown>;
  provenance: Record<string, unknown>;
  generation: number;
  archived_at: string | null;
  created_at: string;
}

// --- Servers ---

export interface Server {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

export interface ServerMember {
  server_id: string;
  member_id: string;
  member_type: "human" | "agent";
  role: "owner" | "admin" | "member";
  joined_at: string;
}

// --- Channels ---

export type ChannelType = "public" | "private" | "dm";

export interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: ChannelType;
  server_id: string;
  created_by: string;
  created_at: string;
}

export interface ChannelMember {
  channel_id: string;
  member_id: string;
  member_type: "human" | "agent";
  joined_at: string;
}

// --- Messages ---

export type SenderType = "human" | "agent" | "system";

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  seq: number | null;
  thread_parent_id: string | null;
  reply_count: number;
  last_reply_at: string | null;
  thread_resolved_at: string | null;
  thread_resolved_by: string | null;
  thread_resolved_by_type: ActorType | null;
  created_at: string;
  updated_at: string;
}

// --- Tasks ---

export interface Task {
  id: string;
  message_id: string | null;
  source_message_id: string | null;
  source_thread_parent_id: string | null;
  channel_id: string;
  task_number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  parent_task_id: string | null;
  current_gate: TaskGate | null;
  review_policy: TaskReviewPolicy;
  assignee_id: string | null;
  assignee_type: ParticipantType | null;
  reviewer_id: string | null;
  reviewer_type: ParticipantType | null;
  review_status: ReviewStatus | null;
  created_by_id: string | null;
  created_by_type: ActorType | null;
  resolution_summary: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadParticipant {
  thread_parent_id: string;
  participant_id: string;
  participant_type: ParticipantType;
  first_participated_at: string;
  last_read_at: string | null;
}

export interface ThreadSubscription {
  thread_parent_id: string;
  subscriber_id: string;
  subscriber_type: ParticipantType;
  subscription_type: ThreadSubscriptionType;
  muted: boolean;
  created_at: string;
}

export interface TaskDependency {
  predecessor_task_id: string;
  successor_task_id: string;
  dependency_type: DependencyType;
  created_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author_id: string;
  author_type: ActorType;
  content: string;
  created_at: string;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  artifact_type: "pr" | "commit" | "file" | "url" | "report" | "log" | "note" | "spec" | "plan" | "evidence";
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  actor_id: string;
  actor_type: ActorType;
  event_type: string;
  from_state: Record<string, unknown> | null;
  to_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface TaskSpec {
  id: string;
  task_id: string;
  title: string;
  content: string;
  status: DocumentStatus;
  approved_by: string | null;
  approved_by_type: ParticipantType | null;
  approved_at: string | null;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskPlan {
  id: string;
  task_id: string;
  spec_id: string | null;
  title: string;
  content: string;
  status: DocumentStatus;
  approved_by: string | null;
  approved_by_type: ParticipantType | null;
  approved_at: string | null;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskStep {
  id: string;
  plan_id: string;
  task_id: string;
  order_index: number;
  description: string;
  target_files: string[] | null;
  required_skill: string | null;
  verification_command: string | null;
  expected_result: string | null;
  status: StepStatus;
  started_at: string | null;
  completed_at: string | null;
  assigned_to_id: string | null;
  assigned_to_type: ParticipantType | null;
  evidence_summary: string | null;
  created_at: string;
}

export interface TaskVerification {
  id: string;
  task_id: string;
  step_id: string | null;
  actor_id: string;
  actor_type: ActorType;
  verification_type: string;
  command_or_check: string;
  output_summary: string | null;
  passed: boolean;
  evidence_url: string | null;
  created_at: string;
}

export interface TaskAgentRun {
  id: string;
  task_id: string;
  step_id: string | null;
  agent_id: string;
  role: string;
  prompt_snapshot: string | null;
  context_manifest: Record<string, unknown>;
  status: AgentRunStatus;
  output_summary: string | null;
  concerns: string | null;
  files_touched: string[] | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TaskReview {
  id: string;
  task_id: string;
  agent_run_id: string | null;
  reviewer_id: string;
  reviewer_type: ParticipantType;
  review_type: string;
  findings: Array<{
    severity: "critical" | "important" | "minor";
    category: string;
    location?: string;
    recommendation: string;
    blocking: boolean;
  }>;
  verdict: ReviewVerdict;
  summary: string;
  created_at: string;
}

export interface Notification {
  id: string;
  recipient_id: string;
  recipient_type: ParticipantType;
  type: string;
  channel_id: string | null;
  message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface Reminder {
  id: string;
  server_id: string;
  created_by_id: string;
  created_by_type: ActorType;
  recipient_id: string;
  recipient_type: ParticipantType;
  channel_id: string;
  source_message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  target: string;
  body: string;
  due_at: string;
  snoozed_until: string | null;
  state: ReminderStatus;
  fired_at: string | null;
  fired_delivery_id: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// --- Omni Protocol (WebSocket messages between Server <-> Omni) ---

export type ServerToOmniMessage =
  | { type: "new_message"; agentId: string; message: Message; channel: Channel }
  | { type: "start_agent"; agentConfig: AgentConfig }
  | { type: "stop_agent"; agentId: string }
  | { type: "ping" };

export type OmniToServerMessage =
  | { type: "agent_response"; agentId: string; channelId: string; content: string; threadParentId?: string }
  | { type: "agent_status"; agentId: string; status: Agent["status"] }
  | { type: "cli_command"; agentId: string; command: CliCommand }
  | { type: "pong" };

export interface AgentConfig {
  id: string;
  name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  work_dir: string;
}

// --- CLI Commands (what agents can invoke) ---

export type CliCommand =
  | { action: "message_send"; target: string; content: string }
  | { action: "message_check" }
  | { action: "message_read"; channel: string; limit?: number; before?: string; after?: string }
  | { action: "task_list"; channel: string }
  | { action: "task_claim"; taskNumber?: number; messageId?: string }
  | { action: "task_update"; taskNumber: number; status: TaskStatus }
  | { action: "server_info" };

export type MemberType = "human" | "agent";
export type MemberActivityActorType = "human" | "agent" | "system" | "bridge";

export type MemberActivityEventType =
  | "message.sent"
  | "thread.replied"
  | "thread.resolved"
  | "thread.reopened"
  | "channel.joined"
  | "server.joined"
  | "task.created"
  | "task.claimed"
  | "task.unclaimed"
  | "task.status_changed"
  | "task.updated"
  | "task.commented"
  | "task.artifact_added"
  | "task.reviewed"
  | "task.verified"
  | "agent.started"
  | "agent.received_message"
  | "agent.thinking"
  | "agent.working"
  | "agent.working_silently"
  | "agent.observing"
  | "agent.blocked"
  | "agent.tool_use"
  | "agent.output"
  | "agent.idle"
  | "agent.error"
  | "agent.disconnected"
  | "agent.status_changed"
  | "agent.created"
  | "agent.updated"
  | "agent.reset"
  | "agent.deleted"
  | "human.profile_updated";

export interface MemberActivityEvent {
  id: string;
  server_id: string | null;
  channel_id: string | null;
  actor_id: string;
  actor_type: MemberActivityActorType;
  event_type: MemberActivityEventType;
  subject_type: string | null;
  subject_id: string | null;
  target_id: string | null;
  target_type: string | null;
  message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  label: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  visibility: "public" | "server" | "channel" | "dm" | "private";
  dedupe_key: string | null;
  occurred_at: string;
  created_at: string;
}

export interface HumanMember {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role?: string | null;
  joined_at?: string | null;
  created_at: string | null;
}
