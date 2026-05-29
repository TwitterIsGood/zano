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
  const messageId = normalizeUuid(searchParams.get("messageId"));
  const agentId = normalizeUuid(searchParams.get("agentId"));

  if (messageId === undefined) return NextResponse.json({ error: "Invalid messageId" }, { status: 400 });
  if (agentId === undefined) return NextResponse.json({ error: "Invalid agentId" }, { status: 400 });
  if (!messageId && !agentId) return NextResponse.json({ error: "messageId or agentId is required" }, { status: 400 });

  let query = supabase
    .from("daemon_deliveries")
    .select("id,agent_id,source_message_id,state,delivery_seq,trace_id,traceparent,target,activation_strength,activation_reasons,runtime_outcome,last_error,updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (messageId) query = query.eq("source_message_id", messageId);
  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deliveries: data ?? [] });
}
