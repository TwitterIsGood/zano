import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveTaskVisibility } from "@/lib/task-activity";
import { createClient } from "@/lib/supabase/server";

async function recordTaskCreatedActivity(userId: string, task: { id: string; channel_id: string; title: string }) {
  try {
    const admin = createAdminClient();
    const { visibility, channel_id, server_id } = await deriveTaskVisibility(admin, task.channel_id);

    const { error } = await admin.from("member_activity_events").insert({
      server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "task.created",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Created task",
      summary: `Created task “${task.title}”`,
      metadata: { title: task.title },
      visibility,
      channel_id,
      dedupe_key: `task:${task.id}:created`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.created activity", error);
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const channelId = searchParams.get("channelId");
  const status = searchParams.get("status");
  const tag = searchParams.get("tag");

  let query = supabase.from("tasks").select("*, channels!inner(server_id, name)").order("task_number", { ascending: true });

  if (serverId) query = query.eq("channels.server_id", serverId);
  if (channelId) query = query.eq("channel_id", channelId);
  if (status) query = query.eq("status", status);
  if (tag) query = query.contains("tags", [tag]);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { channel_id, title, description, priority, tags, source_message_id, source_thread_parent_id } = body;

  if (!channel_id || !title) {
    return NextResponse.json({ error: "channel_id and title required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      channel_id,
      title,
      description: description ?? null,
      priority: priority ?? "medium",
      tags: tags ?? [],
      source_message_id: source_message_id ?? null,
      source_thread_parent_id: source_thread_parent_id ?? null,
      created_by_id: user.id,
      created_by_type: "human",
      current_gate: "ready_to_execute",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordTaskCreatedActivity(user.id, data);

  return NextResponse.json({ task: data });
}
