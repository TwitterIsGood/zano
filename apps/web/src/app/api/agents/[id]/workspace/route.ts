import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/agents/[id]/workspace — validate access; files are read by the Omni runtime.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      error: "remote_workspace",
      message: "Workspace files are owned by the Omni runtime. Start Omni to browse them here.",
    },
    { status: 422 }
  );
}
