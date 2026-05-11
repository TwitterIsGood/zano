import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

async function recordTaskUnclaimedActivity(userId: string, task: { id: string; channel_id: string; title: string }) {
  try {
    const admin = createAdminClient();
    const { data: channel, error: channelError } = await admin
      .from("channels")
      .select("server_id")
      .eq("id", task.channel_id)
      .single();

    if (channelError) throw channelError;

    const { error } = await admin.from("member_activity_events").insert({
      server_id: channel.server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "task.unclaimed",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Unclaimed task",
      summary: `Unclaimed task "${task.title}"`,
      metadata: {},
      visibility: "server",
      dedupe_key: `task:${task.id}:unclaimed:${userId}:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.unclaimed activity", error);
  }
}

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: task, error: fetchError } = await supabase
    .from("tasks")
    .select("id, assignee_id, assignee_type")
    .eq("id", taskId)
    .single();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 404 });

  if (task.assignee_id !== user.id || task.assignee_type !== "human") {
    return NextResponse.json({ error: "Task is not assigned to the current user" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id: null, assignee_type: null, status: "todo", current_gate: "ready_to_execute" })
    .eq("id", taskId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordTaskUnclaimedActivity(user.id, data);

  return NextResponse.json({ task: data });
}
