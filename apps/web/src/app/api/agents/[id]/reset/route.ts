import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

async function recordAgentResetActivity(
  userId: string,
  agent: { id: string; display_name: string; server_id: string },
  messagesDeleted: number
) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("member_activity_events").insert({
      server_id: agent.server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "agent.reset",
      subject_type: "agent",
      subject_id: agent.id,
      target_type: null,
      target_id: null,
      task_id: null,
      agent_id: agent.id,
      label: "Reset agent",
      summary: `Reset agent “${agent.display_name}”`,
      metadata: { name: agent.display_name, messages_deleted: messagesDeleted },
      visibility: "server",
      dedupe_key: `agent:${agent.id}:reset:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record agent.reset activity", error);
  }
}

// POST /api/agents/[id]/reset — reset agent conversation (clear messages + session)
export async function POST(
  _request: NextRequest,
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

  // Verify ownership
  const { data: agent } = await supabase
    .from("agents")
    .select("id, display_name, server_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Find the DM channel for this agent
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", id)
    .eq("member_type", "agent");

  let messagesDeleted = 0;

  if (memberships) {
    for (const m of memberships) {
      const { data: ch } = await supabase
        .from("channels")
        .select("id, type")
        .eq("id", m.channel_id)
        .eq("type", "dm")
        .single();

      if (ch) {
        // Delete all messages in the DM channel
        const { count } = await supabase
          .from("messages")
          .delete({ count: "exact" })
          .eq("channel_id", ch.id);

        messagesDeleted += count ?? 0;
      }
    }
  }

  await recordAgentResetActivity(user.id, agent, messagesDeleted);

  return NextResponse.json({ success: true, messagesDeleted });
}
