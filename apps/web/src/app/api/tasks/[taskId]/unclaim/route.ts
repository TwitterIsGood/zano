import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: task, error: fetchError } = await supabase
    .from("tasks")
    .select("id, assignee_id, assignee_type")
    .eq("id", taskId)
    .single();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 404 });

  if (task.assignee_id !== user.id || task.assignee_type !== "human") {
    return NextResponse.json({ error: "Task is not assigned to the current user" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id: null, assignee_type: null, status: "todo", current_gate: "ready_to_execute" })
    .eq("id", taskId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
