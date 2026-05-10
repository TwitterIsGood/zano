import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { resolved, actor_id, actor_type } = body;

  if (!actor_id || !actor_type) {
    return NextResponse.json({ error: "actor_id and actor_type required" }, { status: 400 });
  }

  const patch = resolved
    ? {
        thread_resolved_at: new Date().toISOString(),
        thread_resolved_by: actor_id,
        thread_resolved_by_type: actor_type,
      }
    : {
        thread_resolved_at: null,
        thread_resolved_by: null,
        thread_resolved_by_type: null,
      };

  const { data, error } = await supabase
    .from("messages")
    .update(patch)
    .eq("id", messageId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread: data });
}
