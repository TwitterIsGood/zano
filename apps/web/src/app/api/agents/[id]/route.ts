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

async function recordAgentUpdatedActivity(userId: string, agent: { id: string; display_name: string; server_id: string }, changedFields: string[]) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("member_activity_events").insert({
      server_id: agent.server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "agent.updated",
      subject_type: "agent",
      subject_id: agent.id,
      target_type: null,
      target_id: null,
      task_id: null,
      agent_id: agent.id,
      label: "Updated agent",
      summary: `Updated agent “${agent.display_name}”`,
      metadata: { name: agent.display_name, changed_fields: changedFields },
      visibility: "server",
      dedupe_key: `agent:${agent.id}:updated:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record agent.updated activity", error);
  }
}

async function recordAgentDeletedActivity(userId: string, agent: { id: string; display_name: string; server_id: string }) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("member_activity_events").insert({
      server_id: agent.server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "agent.deleted",
      subject_type: "agent",
      subject_id: agent.id,
      target_type: null,
      target_id: null,
      task_id: null,
      agent_id: null,
      label: "Deleted agent",
      summary: `Deleted agent “${agent.display_name}”`,
      metadata: { agent_id: agent.id, name: agent.display_name },
      visibility: "server",
      dedupe_key: `agent:${agent.id}:deleted:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record agent.deleted activity", error);
  }
}

// GET /api/agents/[id] — get a single agent
export async function GET(
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

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id,name,display_name,description,system_prompt,status,owner_id,server_id,created_by_id,created_by_type,parent_agent_id,root_agent_id,creation_source,creation_reason,creation_context,provenance,generation,archived_at,created_at")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// PUT /api/agents/[id] — update agent info
export async function PUT(
  request: NextRequest,
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
  const { data: existing } = await supabase
    .from("agents")
    .select("id, server_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  const changedFields: string[] = [];

  if (body.display_name !== undefined) {
    if (!body.display_name?.trim()) {
      return NextResponse.json(
        { error: "display_name cannot be empty" },
        { status: 400 }
      );
    }
    const nextName = publicAgentHandle(body.display_name);
    const admin = createAdminClient();
    const { data: duplicateAgent } = await admin
      .from("agents")
      .select("id")
      .eq("server_id", existing.server_id)
      .eq("name", nextName)
      .neq("id", id)
      .maybeSingle();

    if (duplicateAgent) {
      return NextResponse.json(
        { error: `An agent with @${nextName} already exists in this workspace` },
        { status: 409 }
      );
    }

    updates.display_name = body.display_name.trim();
    updates.name = nextName;
    changedFields.push("display_name", "name");
  }
  if (body.description !== undefined) {
    updates.description = body.description?.trim() || null;
    changedFields.push("description");
  }
  if (body.system_prompt !== undefined) {
    updates.system_prompt = body.system_prompt?.trim() || null;
    changedFields.push("system_prompt");
  }
  if (body.model !== undefined) {
    const validModels = ["opus", "sonnet", "haiku"];
    if (!validModels.includes(body.model)) {
      return NextResponse.json(
        { error: "model must be one of: opus, sonnet, haiku" },
        { status: 400 }
      );
    }
    updates.model = body.model;
    changedFields.push("model");
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await recordAgentUpdatedActivity(user.id, agent, changedFields);

  return NextResponse.json({ agent });
}

// PATCH /api/agents/[id] — archive child agent without deleting history
export async function PATCH(
  request: NextRequest,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Unsupported PATCH body" },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Unsupported PATCH body" },
      { status: 400 }
    );
  }

  const patchBody = body as { archived?: unknown };
  const keys = Object.keys(patchBody);
  if (keys.length !== 1 || patchBody.archived !== true) {
    return NextResponse.json(
      { error: "Unsupported PATCH body" },
      { status: 400 }
    );
  }

  // Verify ownership using the same boundary as the detail/update API.
  const { data: existing } = await supabase
    .from("agents")
    .select("id, display_name, server_id, parent_agent_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (!existing.parent_agent_id) {
    return NextResponse.json({ error: "Cannot archive root agent" }, { status: 400 });
  }

  const { data: activeChildren, error: activeChildrenError } = await supabase
    .from("agents")
    .select("id")
    .eq("parent_agent_id", id)
    .eq("owner_id", user.id)
    .is("archived_at", null)
    .limit(1);

  if (activeChildrenError) {
    return NextResponse.json({ error: activeChildrenError.message }, { status: 500 });
  }

  if ((activeChildren ?? []).length > 0) {
    return NextResponse.json({ error: "Archive child agents first" }, { status: 409 });
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .update({ archived_at: new Date().toISOString(), status: "offline" })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await recordAgentUpdatedActivity(user.id, agent, ["archived_at", "status"]);

  return NextResponse.json({ agent });
}

// DELETE /api/agents/[id] — delete agent + associated DM channel
export async function DELETE(
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
  const { data: existing } = await supabase
    .from("agents")
    .select("id, display_name, server_id, parent_agent_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (existing.parent_agent_id) {
    return NextResponse.json(
      { error: "Cannot delete child agent. Archive child agents instead." },
      { status: 400 }
    );
  }

  const { data: children, error: childrenError } = await supabase
    .from("agents")
    .select("id")
    .eq("parent_agent_id", id)
    .eq("owner_id", user.id)
    .limit(1);

  if (childrenError) {
    return NextResponse.json({ error: childrenError.message }, { status: 500 });
  }

  if ((children ?? []).length > 0) {
    return NextResponse.json({ error: "Cannot delete agent with child agents" }, { status: 409 });
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("delete_root_agent", {
    target_agent_id: id,
    expected_owner_id: user.id,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await recordAgentDeletedActivity(user.id, existing);

  return NextResponse.json({ success: true });
}
