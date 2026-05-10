import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  const body = await request.json();
  const { channel_id, title, description, priority, tags, source_message_id, source_thread_parent_id, created_by_id, created_by_type } = body;

  if (!channel_id || !title || !created_by_id || !created_by_type) {
    return NextResponse.json({ error: "channel_id, title, created_by_id, and created_by_type required" }, { status: 400 });
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
      created_by_id,
      created_by_type,
      current_gate: "ready_to_execute",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
