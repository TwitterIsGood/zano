import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverId = request.nextUrl.searchParams.get("server_id");
  if (!serverId) {
    return NextResponse.json({ error: "server_id is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: currentMembership } = await admin
    .from("server_members")
    .select("server_id")
    .eq("server_id", serverId)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (!currentMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [
    profileResult,
    membershipsResult,
    keysResult,
    channelMembershipsResult,
    agentsResult,
    humanMembershipsResult,
  ] = await Promise.all([
    admin.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    admin
      .from("server_members")
      .select("server_id")
      .eq("member_id", user.id)
      .eq("member_type", "human"),
    admin
      .from("machine_keys")
      .select("id, name, key_prefix, key_value, last_used_at")
      .eq("server_id", serverId)
      .eq("user_id", user.id)
      .order("created_at"),
    admin.from("channel_members").select("channel_id").eq("member_id", user.id),
    admin
      .from("agents")
      .select("id,name,display_name,status,description,server_id,owner_id,created_by_id,created_by_type,parent_agent_id,root_agent_id,creation_source,creation_reason,creation_context,provenance,generation,archived_at,created_at")
      .eq("server_id", serverId)
      .is("archived_at", null)
      .order("created_at"),
    admin
      .from("server_members")
      .select("member_id, role, joined_at")
      .eq("server_id", serverId)
      .eq("member_type", "human")
      .order("joined_at"),
  ]);

  const serverIds = membershipsResult.data?.map((m) => m.server_id) ?? [];
  const { data: servers } = serverIds.length
    ? await admin.from("servers").select("id, name, slug").in("id", serverIds).order("created_at")
    : { data: [] };

  const channelIds = channelMembershipsResult.data?.map((m) => m.channel_id) ?? [];
  const { data: channels } = channelIds.length
    ? await admin
        .from("channels")
        .select("*")
        .eq("server_id", serverId)
        .in("id", channelIds)
        .order("created_at")
    : { data: [] };

  const dmChannelIds = (channels ?? [])
    .filter((ch) => ch.type === "dm")
    .map((ch) => ch.id);
  const humanMemberIds = humanMembershipsResult.data?.map((member) => member.member_id) ?? [];

  const [dmMembersResult, humanProfilesResult] = await Promise.all([
    dmChannelIds.length
      ? admin
          .from("channel_members")
          .select("channel_id, member_id, member_type")
          .in("channel_id", dmChannelIds)
          .eq("member_type", "agent")
      : Promise.resolve({ data: [] }),
    humanMemberIds.length
      ? admin
          .from("profiles")
          .select("id, email, display_name, avatar_url, created_at")
          .in("id", humanMemberIds)
      : Promise.resolve({ data: [] }),
  ]);

  const humanProfilesById = new Map(
    (humanProfilesResult.data ?? []).map((profile) => [profile.id, profile])
  );
  const humans = (humanMembershipsResult.data ?? []).map((membership) => {
    const profile = humanProfilesById.get(membership.member_id);
    return {
      id: membership.member_id,
      display_name: profile?.display_name ?? null,
      email: profile?.email ?? null,
      avatar_url: profile?.avatar_url ?? null,
      role: membership.role,
      joined_at: membership.joined_at,
      created_at: profile?.created_at ?? null,
    };
  });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email ?? "",
      display_name: profileResult.data?.display_name ?? "",
    },
    servers: servers ?? [],
    machineKeys: keysResult.data ?? [],
    channels: channels ?? [],
    agents: agentsResult.data ?? [],
    dmMembers: dmMembersResult.data ?? [],
    humans,
  });
}
