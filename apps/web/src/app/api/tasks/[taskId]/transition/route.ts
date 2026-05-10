import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkTaskTransition } from "@/lib/collaboration/task-transitions";
import type { TaskStatus } from "@zano/shared";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { status, actor_id, actor_type, reason } = await request.json();

  if (!status || !actor_id || !actor_type) {
    return NextResponse.json({ error: "status, actor_id, and actor_type required" }, { status: 400 });
  }

  const { data: current, error: currentError } = await supabase.from("tasks").select("status").eq("id", taskId).single();
  if (currentError) return NextResponse.json({ error: currentError.message }, { status: 404 });

  const from = current.status as TaskStatus;
  const to = status as TaskStatus;
  const check = await checkTaskTransition(supabase, taskId, from, to);
  if (!check.allowed) {
    return NextResponse.json({ error: check.reason }, { status: 409 });
  }

  const patch: Record<string, unknown> = { status: to };
  if (to === "in_progress") patch.started_at = new Date().toISOString();
  if (to === "done") patch.completed_at = new Date().toISOString();
  if (to === "archived") patch.archived_at = new Date().toISOString();

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("task_events").insert({
    task_id: taskId,
    actor_id,
    actor_type,
    event_type: "status_changed",
    from_state: { status: from },
    to_state: { status: to },
    reason: reason ?? null,
  });

  return NextResponse.json({ task: data });
}
