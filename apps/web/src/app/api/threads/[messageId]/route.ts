import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [parentResult, repliesResult, participantsResult] = await Promise.all([
    supabase.from("messages").select("*").eq("id", messageId).single(),
    supabase
      .from("messages")
      .select("*")
      .eq("thread_parent_id", messageId)
      .order("created_at", { ascending: true }),
    supabase.from("thread_participants").select("*").eq("thread_parent_id", messageId),
  ]);

  if (parentResult.error) return NextResponse.json({ error: parentResult.error.message }, { status: 404 });
  if (repliesResult.error) return NextResponse.json({ error: repliesResult.error.message }, { status: 500 });
  if (participantsResult.error) return NextResponse.json({ error: participantsResult.error.message }, { status: 500 });

  return NextResponse.json({
    parent: parentResult.data,
    replies: repliesResult.data ?? [],
    participants: participantsResult.data ?? [],
  });
}
