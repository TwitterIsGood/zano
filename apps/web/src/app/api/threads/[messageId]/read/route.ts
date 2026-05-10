import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { participant_id, participant_type } = body;

  if (!participant_id || !participant_type) {
    return NextResponse.json({ error: "participant_id and participant_type required" }, { status: 400 });
  }

  const { error } = await supabase.from("thread_participants").upsert({
    thread_parent_id: messageId,
    participant_id,
    participant_type,
    last_read_at: new Date().toISOString(),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
