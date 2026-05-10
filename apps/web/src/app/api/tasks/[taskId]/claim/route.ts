import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { assignee_id, assignee_type } = await request.json();

  if (!assignee_id || !assignee_type) {
    return NextResponse.json({ error: "assignee_id and assignee_type required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id, assignee_type, status: "in_progress", started_at: new Date().toISOString(), current_gate: "executing" })
    .eq("id", taskId)
    .is("assignee_id", null)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ task: data });
}
