import { canTransitionTask, type TaskStatus, type TaskTransitionContext } from "@zano/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TransitionCheckResult {
  allowed: boolean;
  reason?: string;
  context?: TaskTransitionContext;
}

export async function checkTaskTransition(
  supabase: SupabaseClient,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
): Promise<TransitionCheckResult> {
  const [dependencies, verifications, reviews, taskResult] = await Promise.all([
    supabase
      .from("task_dependencies")
      .select("predecessor_task_id, tasks!task_dependencies_predecessor_task_id_fkey(status)")
      .eq("successor_task_id", taskId)
      .eq("dependency_type", "blocks"),
    supabase
      .from("task_verifications")
      .select("id")
      .eq("task_id", taskId)
      .eq("passed", true)
      .limit(1),
    supabase
      .from("task_reviews")
      .select("id, verdict")
      .eq("task_id", taskId)
      .in("verdict", ["pass", "pass_with_concerns"]),
    supabase
      .from("tasks")
      .select("reviewer_id, review_policy")
      .eq("id", taskId)
      .single(),
  ]);

  if (dependencies.error) return { allowed: false, reason: dependencies.error.message };
  if (verifications.error) return { allowed: false, reason: verifications.error.message };
  if (reviews.error) return { allowed: false, reason: reviews.error.message };
  if (taskResult.error) return { allowed: false, reason: taskResult.error.message };

  const blockedByOpenTask = (dependencies.data ?? []).some((row) => {
    const joined = row as unknown as { tasks?: { status?: string } | { status?: string }[] };
    const predecessor = Array.isArray(joined.tasks) ? joined.tasks[0] : joined.tasks;
    return predecessor?.status !== "done" && predecessor?.status !== "archived";
  });

  const reviewPolicy = (taskResult.data?.review_policy ?? {}) as {
    reviewTypes?: string[];
    completionRequiresUser?: boolean;
  };
  const requiresReview = Boolean(
    taskResult.data?.reviewer_id ||
      reviewPolicy.completionRequiresUser ||
      (reviewPolicy.reviewTypes && reviewPolicy.reviewTypes.length > 0),
  );

  const context: TaskTransitionContext = {
    hasBlockingDependencies: blockedByOpenTask,
    hasPassingVerification: (verifications.data ?? []).length > 0,
    requiresReview,
    hasPassingRequiredReview: (reviews.data ?? []).length > 0,
  };

  return { ...canTransitionTask(from, to, context), context };
}
