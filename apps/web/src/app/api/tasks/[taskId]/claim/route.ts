import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id: user.id, assignee_type: "human", status: "in_progress", started_at: new Date().toISOString(), current_gate: "executing" })
    .eq("id", taskId)
    .is("assignee_id", null)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ task: data });
}
