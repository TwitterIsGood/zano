import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkTaskTransition } from "@/lib/collaboration/task-transitions";
import type { TaskStatus } from "@zano/shared";
import { deriveTaskVisibility } from "@/lib/task-activity";

async function recordTaskStatusChangedActivity(
  userId: string,
  task: { id: string; channel_id: string; title: string },
  from: TaskStatus,
  to: TaskStatus,
  reason: string | null | undefined
) {
  try {
    const admin = createAdminClient();
    const { visibility, channel_id, server_id } = await deriveTaskVisibility(admin, task.channel_id);

    const { error } = await admin.from("member_activity_events").insert({
      server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "task.status_changed",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Changed task status",
      summary: `Changed task "${task.title}" from ${from} to ${to}`,
      metadata: { title: task.title, from_status: from, to_status: to, reason: reason ?? null },
      visibility,
      channel_id,
      dedupe_key: `task:${task.id}:status:${to}:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.status_changed activity", error);
  }
}

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { status, reason } = await request.json();

  if (!status) {
    return NextResponse.json({ error: "status required" }, { status: 400 });
  }

  const { data: current, error: currentError } = await supabase.from("tasks").select("status, task_number").eq("id", taskId).single();
  if (currentError) return NextResponse.json({ error: currentError.message }, { status: 404 });

  const from = current.status as TaskStatus;
  const to = status as TaskStatus;
  const check = await checkTaskTransition(supabase, taskId, from, to);
  if (!check.allowed) {
    if (to === "done" && check.context?.hasPassingVerification === false) {
      return NextResponse.json({
        error: check.reason,
        code: "TASK_NEEDS_PASSING_VERIFICATION",
        missing: ["passing_verification"],
        nextAction: "Record a passing verification evidence item, then retry moving this task to done.",
        agentCommand: `zano task verify --number ${current.task_number} --type test --check "what you ran or inspected" --passed --summary "result"`,
        context: check.context,
      }, { status: 409 });
    }

    return NextResponse.json({ error: check.reason, code: "INVALID_TASK_TRANSITION", context: check.context }, { status: 409 });
  }

  const patch: Record<string, unknown> = { status: to };
  if (to === "in_progress") patch.started_at = new Date().toISOString();
  if (to === "done") patch.completed_at = new Date().toISOString();
  if (to === "archived") patch.archived_at = new Date().toISOString();

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const admin = createAdminClient();
  const { error: eventError } = await admin.from("task_events").insert({
    task_id: taskId,
    actor_id: user.id,
    actor_type: "human",
    event_type: "status_changed",
    from_state: { status: from },
    to_state: { status: to },
    reason: reason ?? null,
  });

  if (eventError) return NextResponse.json({ error: eventError.message }, { status: 500 });

  await recordTaskStatusChangedActivity(user.id, data, from, to, reason);

  return NextResponse.json({ task: data });
}
