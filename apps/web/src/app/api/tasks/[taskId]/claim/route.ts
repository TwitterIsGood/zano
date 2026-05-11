import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { deriveTaskVisibility } from "@/lib/task-activity";

async function recordTaskClaimedActivity(userId: string, task: { id: string; channel_id: string; title: string }) {
  try {
    const admin = createAdminClient();
    const { visibility, channel_id, server_id } = await deriveTaskVisibility(admin, task.channel_id);

    const { error } = await admin.from("member_activity_events").insert({
      server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "task.claimed",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Claimed task",
      summary: `Claimed task "${task.title}"`,
      metadata: {},
      visibility,
      channel_id,
      dedupe_key: `task:${task.id}:claimed:${userId}:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.claimed activity", error);
  }
}

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id: user.id, assignee_type: "human", status: "in_progress", started_at: new Date().toISOString(), current_gate: "executing" })
    .eq("id", taskId)
    .is("assignee_id", null)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 409 });

  await recordTaskClaimedActivity(user.id, data);

  return NextResponse.json({ task: data });
}
