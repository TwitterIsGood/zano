import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { resolved } = body;

  const { data: parent, error: parentError } = await supabase
    .from("messages")
    .select("id, channel_id, thread_parent_id")
    .eq("id", messageId)
    .maybeSingle();

  if (parentError) return NextResponse.json({ error: parentError.message }, { status: 500 });
  if (!parent) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  if (parent.thread_parent_id !== null) {
    return NextResponse.json({ error: "Can only resolve top-level threads" }, { status: 400 });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("channel_id", parent.channel_id)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (membershipError) return NextResponse.json({ error: membershipError.message }, { status: 500 });
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const patch = resolved
    ? {
        thread_resolved_at: new Date().toISOString(),
        thread_resolved_by: user.id,
        thread_resolved_by_type: "human",
      }
    : {
        thread_resolved_at: null,
        thread_resolved_by: null,
        thread_resolved_by_type: null,
      };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .update(patch)
    .eq("id", messageId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread: data });
}
