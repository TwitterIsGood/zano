import type { ActorType } from "./collaboration";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SkillScope = "server" | "channel" | "agent" | "global";
export type SkillState =
  | "candidate"
  | "active"
  | "probation"
  | "disputed"
  | "superseded"
  | "archived"
  | "quarantined";
export type SkillRiskLevel = "low" | "medium" | "high" | "critical";
export type SkillFileKind = "reference" | "template" | "script" | "asset";
export type SkillCandidateType =
  | "create"
  | "patch"
  | "write_file"
  | "merge"
  | "archive"
  | "restore"
  | "rollback"
  | "no_op";
export type SkillCandidateState = "pending" | "applied" | "rejected_by_policy" | "quarantined" | "superseded";
export type SkillAttestationType =
  | "useful"
  | "correct"
  | "safe"
  | "too_narrow"
  | "too_broad"
  | "duplicate"
  | "wrong"
  | "unsafe"
  | "stale";
export type SkillEpisodeStatus = "open" | "reviewed" | "converted" | "no_op" | "expired";
export type SkillTriggerStrength = "weak" | "medium" | "strong" | "mandatory";

export type KnowledgeScope = "server" | "channel" | "task" | "agent" | "global";
export type KnowledgeKind =
  | "fact"
  | "preference"
  | "decision"
  | "constraint"
  | "domain_note"
  | "project_context"
  | "relationship"
  | "status";
export type KnowledgeFreshness = "stable" | "time_sensitive" | "ephemeral";
export type KnowledgeState = "active" | "disputed" | "superseded" | "archived";

export type AgentBlueprintScope = "server" | "channel" | "task";
export type AgentBlueprintState = "active" | "probation" | "disputed" | "archived" | "quarantined";
export type AgentTurnStatus = "running" | "completed" | "interrupted" | "failed";
export type ProjectionRunStatus = "running" | "completed" | "failed";
export type SkillLintStatus = "pass" | "warn" | "fail";

export interface Skill {
  id: string;
  server_id: string;
  slug: string;
  name: string;
  description: string;
  scope: SkillScope;
  channel_id: string | null;
  owner_actor_id: string | null;
  owner_actor_type: ActorType | null;
  state: SkillState;
  risk_level: SkillRiskLevel;
  active_version_id: string | null;
  superseded_by: string | null;
  projection_version: number;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
  updated_at: string;
}

export interface SkillVersion {
  id: string;
  skill_id: string;
  server_id: string;
  version_number: number;
  content: string;
  frontmatter: JsonValue;
  content_hash: string;
  change_summary: string;
  change_reason: string;
  evidence_refs: JsonValue[];
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface SkillFile {
  id: string;
  skill_id: string;
  version_id: string | null;
  server_id: string;
  path: string;
  kind: SkillFileKind;
  content: string | null;
  binary_url: string | null;
  content_hash: string | null;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface SkillCandidate {
  id: string;
  episode_id: string | null;
  server_id: string;
  candidate_type: SkillCandidateType;
  target_skill_id: string | null;
  target_slug: string | null;
  proposed_content: string | null;
  proposed_files: JsonValue[];
  rationale: string;
  classification: JsonValue;
  evidence_refs: JsonValue[];
  risk_level: SkillRiskLevel;
  policy_result: JsonValue;
  state: SkillCandidateState;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface SkillAttestation {
  id: string;
  skill_id: string;
  version_id: string | null;
  server_id: string;
  actor_id: string;
  actor_type: ActorType;
  attestation_type: SkillAttestationType;
  confidence: number;
  summary: string;
  evidence_refs: JsonValue[];
  created_at: string;
}

export interface SkillEpisode {
  id: string;
  server_id: string;
  channel_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  trigger_type: string;
  trigger_strength: SkillTriggerStrength;
  source_refs: JsonValue[];
  summary: string;
  signals: JsonValue;
  status: SkillEpisodeStatus;
  created_at: string;
  reviewed_at: string | null;
}

export interface KnowledgeItem {
  id: string;
  server_id: string;
  scope: KnowledgeScope;
  channel_id: string | null;
  task_id: string | null;
  subject: string;
  content: string;
  kind: KnowledgeKind;
  confidence: number;
  freshness: KnowledgeFreshness;
  expires_at: string | null;
  state: KnowledgeState;
  source_refs: JsonValue[];
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
  updated_at: string;
}

export interface AgentBlueprint {
  id: string;
  server_id: string;
  slug: string;
  display_name_template: string;
  description: string;
  system_prompt_template: string;
  default_model: string;
  scope: AgentBlueprintScope;
  required_skills: string[];
  allowed_tools: JsonValue;
  spawn_policy: JsonValue;
  lifecycle_policy: JsonValue;
  state: AgentBlueprintState;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface AgentSpawnEvent {
  id: string;
  server_id: string;
  blueprint_id: string | null;
  agent_id: string | null;
  request_event_id: string | null;
  event_type: string;
  actor_id: string;
  actor_type: ActorType;
  reason: string;
  source_refs: JsonValue[];
  policy_result: JsonValue;
  created_at: string;
}

export interface AgentTurn {
  id: string;
  server_id: string;
  agent_id: string | null;
  channel_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  session_id: string | null;
  input_message_ids: string[];
  activation_reason: JsonValue;
  started_at: string;
  completed_at: string | null;
  status: AgentTurnStatus;
  output_summary: string | null;
  error_summary: string | null;
  created_at: string;
}

export interface AgentToolEvent {
  id: string;
  turn_id: string | null;
  server_id: string;
  agent_id: string | null;
  tool_name: string;
  tool_kind: string;
  input_summary: string | null;
  output_summary: string | null;
  success: boolean | null;
  started_at: string;
  completed_at: string | null;
  metadata: JsonValue;
}
