import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function publicAgentHandle(displayName: string, fallback = "Agent") {
  const handle = displayName
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
  return handle || fallback;
}

async function recordAgentCreatedActivity(userId: string, agent: { id: string; display_name: string; server_id: string }) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("member_activity_events").insert({
      server_id: agent.server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "agent.created",
      subject_type: "agent",
      subject_id: agent.id,
      target_type: null,
      target_id: null,
      task_id: null,
      agent_id: agent.id,
      label: "Created agent",
      summary: `Created agent “${agent.display_name}”`,
      metadata: {
        name: agent.display_name,
        created_by_type: "human",
        created_by_id: userId,
        parent_agent_id: null,
      },
      visibility: "server",
      dedupe_key: `agent:${agent.id}:created`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record agent.created activity", error);
  }
}

// GET /api/agents — list user's agents
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agents")
    .select("*")
    .eq("owner_id", user.id)
    .is("archived_at", null)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agents: data ?? [] });
}

// POST /api/agents — create a new agent + DM channel
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { display_name, description, system_prompt, server_id } = body;

  if (!display_name?.trim()) {
    return NextResponse.json(
      { error: "display_name is required" },
      { status: 400 }
    );
  }

  const name = publicAgentHandle(display_name);

  // 1. Create the agent
  if (!server_id) {
    return NextResponse.json(
      { error: "server_id is required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: currentMembership, error: membershipError } = await admin
    .from("server_members")
    .select("server_id")
    .eq("server_id", server_id)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }

  if (!currentMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: existingAgent } = await admin
    .from("agents")
    .select("id")
    .eq("server_id", server_id)
    .eq("name", name)
    .maybeSingle();

  if (existingAgent) {
    return NextResponse.json(
      { error: `An agent with @${name} already exists in this workspace` },
      { status: 409 }
    );
  }

  const { data: agent, error: agentError } = await admin
    .from("agents")
    .insert({
      name,
      display_name: display_name.trim(),
      description: description?.trim() || null,
      system_prompt: system_prompt?.trim() || null,
      status: "offline",
      owner_id: user.id,
      server_id,
      created_by_id: user.id,
      created_by_type: "human",
      parent_agent_id: null,
      creation_source: "human",
      creation_reason: null,
      creation_context: {},
      provenance: { created_by_type: "human", created_by_id: user.id },
      generation: 0,
    })
    .select()
    .single();

  if (agentError) {
    return NextResponse.json({ error: agentError.message }, { status: 500 });
  }

  // 2. Create a DM channel for this agent
  const { data: dmChannel, error: channelError } = await admin
    .from("channels")
    .insert({
      name: display_name.trim(),
      description: `Direct chat with ${display_name.trim()}`,
      type: "dm",
      server_id,
      created_by: user.id,
    })
    .select()
    .single();

  if (channelError) {
    // Rollback: delete the agent if channel creation fails
    await admin.from("agents").delete().eq("id", agent.id);
    return NextResponse.json({ error: channelError.message }, { status: 500 });
  }

  // 3. Add both user and agent to the DM channel
  await admin.from("channel_members").insert([
    { channel_id: dmChannel.id, member_id: user.id, member_type: "human" },
    { channel_id: dmChannel.id, member_id: agent.id, member_type: "agent" },
  ]);

  // 4. Add agent as server member
  await admin.from("server_members").insert({
    server_id,
    member_id: agent.id,
    member_type: "agent",
    role: "member",
  });

  await recordAgentCreatedActivity(user.id, agent);

  return NextResponse.json({ agent, channel: dmChannel });
}
