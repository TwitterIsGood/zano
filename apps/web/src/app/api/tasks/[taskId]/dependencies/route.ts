import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasDependencyCycle, type TaskDependencyEdge } from "@zano/shared";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_dependencies").select("*").or(`predecessor_task_id.eq.${taskId},successor_task_id.eq.${taskId}`);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dependencies: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { predecessor_task_id, dependency_type } = await request.json();
  if (!predecessor_task_id) return NextResponse.json({ error: "predecessor_task_id required" }, { status: 400 });

  const { data: successor, error: successorError } = await supabase
    .from("tasks")
    .select("id, channel_id")
    .eq("id", taskId)
    .single();
  if (successorError || !successor) return NextResponse.json({ error: "Successor task not found" }, { status: 404 });

  const { data: predecessor, error: predecessorError } = await supabase
    .from("tasks")
    .select("id, channel_id")
    .eq("id", predecessor_task_id)
    .single();
  if (predecessorError || !predecessor) return NextResponse.json({ error: "Predecessor task not found" }, { status: 400 });
  if (predecessor.channel_id !== successor.channel_id) {
    return NextResponse.json({ error: "Dependency tasks must be in the same channel" }, { status: 400 });
  }

  const { data: existing, error: existingError } = await supabase.from("task_dependencies").select("predecessor_task_id, successor_task_id");
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

  const edges: TaskDependencyEdge[] = [
    ...(existing ?? []).map((edge) => ({ predecessorTaskId: edge.predecessor_task_id, successorTaskId: edge.successor_task_id })),
    { predecessorTaskId: predecessor_task_id, successorTaskId: taskId },
  ];

  if (hasDependencyCycle(edges)) {
    return NextResponse.json({ error: "Dependency would create a cycle" }, { status: 409 });
  }

  const { data, error } = await supabase.from("task_dependencies").insert({ predecessor_task_id, successor_task_id: taskId, dependency_type: dependency_type ?? "blocks" }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dependency: data });
}
