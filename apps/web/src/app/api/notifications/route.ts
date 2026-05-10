import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const recipientId = searchParams.get("recipientId");
  const recipientType = searchParams.get("recipientType") ?? "human";
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  if (!recipientId) {
    return NextResponse.json({ error: "recipientId required" }, { status: 400 });
  }

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", recipientId)
    .eq("recipient_type", recipientType)
    .order("created_at", { ascending: false })
    .limit(100);

  if (unreadOnly) query = query.is("read_at", null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notifications: data ?? [] });
}
