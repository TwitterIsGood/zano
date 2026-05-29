/** ActorType identifies who performed an action, including system automation. */
export type ActorType = "human" | "agent" | "system";
/** ParticipantType identifies channel/thread participants that can actively join conversations. */
export type ParticipantType = "human" | "agent";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "changes_requested"
  | "done"
  | "archived";

export type ReminderStatus = "pending" | "snoozed" | "firing" | "fired" | "completed" | "cancelled" | "failed";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskGate =
  | "needs_spec"
  | "spec_review"
  | "needs_plan"
  | "plan_review"
  | "ready_to_execute"
  | "executing"
  | "needs_verification"
  | "needs_review"
  | "review_passed"
  | "ready_for_completion";

export type ReviewStatus = "pending" | "approved" | "rejected" | "changes_requested";
export type DocumentStatus = "draft" | "self_reviewed" | "needs_user_review" | "approved" | "changes_requested";
export type StepStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
export type AgentRunStatus = "dispatched" | "running" | "done_with_concerns" | "done" | "blocked" | "failed";
export type ReviewVerdict = "pass" | "pass_with_concerns" | "fail" | "blocked";
export type DependencyType = "blocks" | "related";
export type ThreadSubscriptionType = "auto" | "manual" | "mention";

export interface TaskReviewPolicy {
  specRequired?: boolean;
  planRequired?: boolean;
  tddRequired?: boolean;
  reviewTypes?: string[];
  verificationRequired?: boolean;
  completionRequiresUser?: boolean;
}

export interface TaskTransitionContext {
  hasBlockingDependencies: boolean;
  hasPassingVerification: boolean;
  requiresReview: boolean;
  hasPassingRequiredReview: boolean;
}

export interface TaskTransitionResult {
  allowed: boolean;
  reason?: string;
}

export interface TaskDependencyEdge {
  predecessorTaskId: string;
  successorTaskId: string;
}

export const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "blocked", "archived"],
  in_progress: ["blocked", "in_review", "done", "changes_requested", "archived"],
  blocked: ["todo", "in_progress", "archived"],
  in_review: ["changes_requested", "done", "archived"],
  changes_requested: ["in_progress", "blocked", "archived"],
  done: ["archived"],
  archived: [],
};

export function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  context: TaskTransitionContext,
): TaskTransitionResult {
  if (!allowedTransitions[from].includes(to)) {
    return { allowed: false, reason: `Invalid transition from ${from} to ${to}` };
  }

  if ((to === "in_progress" || to === "todo") && context.hasBlockingDependencies) {
    return { allowed: false, reason: "Task has unresolved blocking dependencies" };
  }

  if (to === "done") {
    if (!context.hasPassingVerification) {
      return { allowed: false, reason: "Task needs passing verification evidence" };
    }

    if (context.requiresReview && !context.hasPassingRequiredReview) {
      return { allowed: false, reason: "Task requires review before completion" };
    }
  }

  return { allowed: true };
}

export function hasDependencyCycle(edges: TaskDependencyEdge[]): boolean {
  const graph = new Map<string, string[]>();

  for (const edge of edges) {
    const existing = graph.get(edge.predecessorTaskId) ?? [];
    existing.push(edge.successorTaskId);
    graph.set(edge.predecessorTaskId, existing);

    if (!graph.has(edge.successorTaskId)) {
      graph.set(edge.successorTaskId, []);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;

    visiting.add(node);

    for (const next of graph.get(node) ?? []) {
      if (visit(next)) return true;
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (visit(node)) return true;
  }

  return false;
}
