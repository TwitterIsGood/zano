import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const MAX_LIMIT = 200;

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get("channel_id")?.trim();
  const sinceSeq = parsePositiveInt(searchParams.get("since_seq"), 0);
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), MAX_LIMIT), MAX_LIMIT);

  if (!channelId) {
    return NextResponse.json({ error: "channel_id required" }, { status: 400 });
  }

  if (sinceSeq <= 0) {
    return NextResponse.json({ error: "since_seq must be positive" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .is("thread_parent_id", null)
    .gt("seq", sinceSeq)
    .order("seq", { ascending: true })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = data ?? [];
  const currentSeq = messages.reduce((max, message) => Math.max(max, Number(message.seq ?? 0)), sinceSeq);

  return NextResponse.json({
    messages,
    currentSeq,
    hasMore: messages.length === limit,
  });
}
