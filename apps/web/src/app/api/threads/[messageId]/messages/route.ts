import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { channel_id, sender_id, sender_type, content } = body;

  if (!channel_id || !sender_id || !content) {
    return NextResponse.json({ error: "channel_id, sender_id, and content required" }, { status: 400 });
  }

  const { data: message, error } = await supabase
    .from("messages")
    .insert({ channel_id, sender_id, sender_type: sender_type || "human", content, thread_parent_id: messageId })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("thread_participants").upsert({
    thread_parent_id: messageId,
    participant_id: sender_id,
    participant_type: sender_type === "agent" ? "agent" : "human",
    last_read_at: new Date().toISOString(),
  });

  return NextResponse.json({ message });
}
