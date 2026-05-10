import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_artifacts").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ artifacts: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { artifact_type, title, url, metadata, created_by_id, created_by_type } = body;
  if (!artifact_type || !title || !created_by_id || !created_by_type) return NextResponse.json({ error: "artifact_type, title, created_by_id, and created_by_type required" }, { status: 400 });
  const { data, error } = await supabase.from("task_artifacts").insert({ task_id: taskId, artifact_type, title, url: url ?? null, metadata: metadata ?? {}, created_by_id, created_by_type }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ artifact: data });
}
