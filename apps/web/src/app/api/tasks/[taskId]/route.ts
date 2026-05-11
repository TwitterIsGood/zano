import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

async function recordTaskUpdatedActivity(userId: string, task: { id: string; channel_id: string; title: string }, changedFields: string[]) {
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
      event_type: "task.updated",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Updated task",
      summary: `Updated task "${task.title}"`,
      metadata: { title: task.title, changed_fields: changedFields },
      visibility: "server",
      dedupe_key: `task:${task.id}:updated:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.updated activity", error);
  }
}

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();

  const [task, comments, artifacts, dependencies, events, verifications, reviews] = await Promise.all([
    supabase.from("tasks").select("*").eq("id", taskId).single(),
    supabase.from("task_comments").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_artifacts").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_dependencies").select("*").or(`predecessor_task_id.eq.${taskId},successor_task_id.eq.${taskId}`),
    supabase.from("task_events").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_verifications").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_reviews").select("*").eq("task_id", taskId).order("created_at"),
  ]);

  if (task.error) return NextResponse.json({ error: task.error.message }, { status: 404 });
  for (const result of [comments, artifacts, dependencies, events, verifications, reviews]) {
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  return NextResponse.json({
    task: task.data,
    comments: comments.data ?? [],
    artifacts: artifacts.data ?? [],
    dependencies: dependencies.data ?? [],
    events: events.data ?? [],
    verifications: verifications.data ?? [],
    reviews: reviews.data ?? [],
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  const allowed = ["title", "description", "priority", "tags", "due_at"];
  const changedFields = Object.keys(body).filter((key) => allowed.includes(key));
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordTaskUpdatedActivity(user.id, data, changedFields);

  return NextResponse.json({ task: data });
}
