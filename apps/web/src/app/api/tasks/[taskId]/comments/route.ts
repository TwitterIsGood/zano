import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_comments").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ comments: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { author_id, author_type, content } = await request.json();
  if (!author_id || !author_type || !content) return NextResponse.json({ error: "author_id, author_type, and content required" }, { status: 400 });
  const { data, error } = await supabase.from("task_comments").insert({ task_id: taskId, author_id, author_type, content }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ comment: data });
}
