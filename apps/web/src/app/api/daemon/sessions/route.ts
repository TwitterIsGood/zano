import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function normalizeUuid(value: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : undefined;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const agentId = normalizeUuid(searchParams.get("agentId"));

  if (agentId === undefined) return NextResponse.json({ error: "Invalid agentId" }, { status: 400 });
  if (!agentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 });

  const query = supabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,machine_id,runtime,runtime_model,session_id,process_id,state,prompt_hash,wrapper_hash,started_at,last_active_at,idle_at,ended_at,last_error")
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(20);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}
