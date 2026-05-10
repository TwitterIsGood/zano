import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { channel_id: requestedChannelId, content } = body;

  if (!requestedChannelId || !content) {
    return NextResponse.json({ error: "channel_id and content required" }, { status: 400 });
  }

  // F1: validate parent message exists, is top-level, and get canonical channel_id
  const { data: parent, error: parentError } = await supabase
    .from("messages")
    .select("id, channel_id, thread_parent_id")
    .eq("id", messageId)
    .single();

  if (parentError || !parent) {
    return NextResponse.json({ error: "Parent message not found" }, { status: 400 });
  }
  if (parent.thread_parent_id !== null) {
    return NextResponse.json({ error: "Replies can only be made to top-level messages" }, { status: 400 });
  }
  if (parent.channel_id !== requestedChannelId) {
    return NextResponse.json({ error: "Parent message does not belong to channel" }, { status: 400 });
  }

  const channel_id = parent.channel_id;

  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      channel_id,
      sender_id: user.id,
      sender_type: "human",
      content,
      thread_parent_id: messageId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("thread_participants").upsert({
    thread_parent_id: messageId,
    participant_id: user.id,
    participant_type: "human",
    last_read_at: new Date().toISOString(),
  });

  return NextResponse.json({ message });
}
