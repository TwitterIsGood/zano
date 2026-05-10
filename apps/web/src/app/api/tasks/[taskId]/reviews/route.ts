import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_reviews").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ reviews: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { review_type, findings, verdict, summary } = body;
  if (!review_type || !verdict || !summary) return NextResponse.json({ error: "review_type, verdict, and summary required" }, { status: 400 });
  const { data, error } = await supabase.from("task_reviews").insert({ task_id: taskId, reviewer_id: user.id, reviewer_type: "human", review_type, findings: findings ?? [], verdict, summary }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ review: data });
}
