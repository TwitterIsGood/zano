import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { resolved } = body;

  const patch = resolved
    ? {
        thread_resolved_at: new Date().toISOString(),
        thread_resolved_by: user.id,
        thread_resolved_by_type: "human",
      }
    : {
        thread_resolved_at: null,
        thread_resolved_by: null,
        thread_resolved_by_type: null,
      };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .update(patch)
    .eq("id", messageId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread: data });
}
