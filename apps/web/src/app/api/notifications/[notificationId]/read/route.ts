import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ notificationId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { notificationId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: notification, error: notificationError } = await supabase
    .from("notifications")
    .select("recipient_id")
    .eq("id", notificationId)
    .single();

  if (notificationError || !notification) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }
  if (notification.recipient_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("recipient_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notification: data });
}
