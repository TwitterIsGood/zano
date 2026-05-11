import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { server_id?: string; target_user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const { server_id, target_user_id } = body;

  if (!server_id || !target_user_id) {
    return NextResponse.json(
      { error: "server_id and target_user_id are required" },
      { status: 400 }
    );
  }

  if (user.id === target_user_id) {
    return NextResponse.json(
      { error: "You can't message yourself" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: memberships, error: membershipsError } = await admin
    .from("server_members")
    .select("member_id")
    .eq("server_id", server_id)
    .eq("member_type", "human")
    .in("member_id", [user.id, target_user_id]);

  if (membershipsError) {
    return NextResponse.json({ error: membershipsError.message }, { status: 500 });
  }

  const memberIds = new Set((memberships ?? []).map((m) => m.member_id));
  if (!memberIds.has(user.id) || !memberIds.has(target_user_id)) {
    return NextResponse.json(
      { error: "Both users must be members of the server" },
      { status: 403 }
    );
  }

  // Find existing DM channel where both users are members
  const { data: userChannels } = await admin
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", user.id)
    .eq("member_type", "human");

  if (userChannels && userChannels.length > 0) {
    const channelIds = userChannels.map((c) => c.channel_id);

    const { data: dmChannels } = await admin
      .from("channels")
      .select("id, name, type, description")
      .eq("type", "dm")
      .eq("server_id", server_id)
      .in("id", channelIds);

    if (dmChannels && dmChannels.length > 0) {
      const dmChannelIds = dmChannels.map((c) => c.id);

      const { data: targetMemberships } = await admin
        .from("channel_members")
        .select("channel_id")
        .eq("member_id", target_user_id)
        .eq("member_type", "human")
        .in("channel_id", dmChannelIds);

      if (targetMemberships && targetMemberships.length > 0) {
        const existingChannelIds = targetMemberships.map((m) => m.channel_id);
        const { data: existingChannels } = await admin
          .from("channels")
          .select("id, name, type, description")
          .eq("type", "dm")
          .eq("server_id", server_id)
          .in("id", existingChannelIds)
          .order("created_at", { ascending: true })
          .limit(1);

        const existing = existingChannels?.[0];
        if (existing) {
          return NextResponse.json({ channel: existing, created: false });
        }
      }
    }
  }

  const dmName = `dm:${[user.id, target_user_id].sort().join("-")}`;

  const { data: insertedChannels, error: channelError } = await admin
    .from("channels")
    .insert({
      name: dmName,
      type: "dm",
      server_id,
      created_by: user.id,
    })
    .select("id, name, type, description");

  if (channelError) {
    const { data: resolved } = await admin
      .from("channels")
      .select("id, name, type, description")
      .eq("server_id", server_id)
      .eq("type", "dm")
      .eq("name", dmName)
      .limit(1);

    if (resolved && resolved.length > 0) {
      return NextResponse.json({ channel: resolved[0], created: false });
    }

    return NextResponse.json({ error: channelError.message }, { status: 500 });
  }

  const newChannel = insertedChannels?.[0];
  if (!newChannel) {
    return NextResponse.json(
      { error: "Failed to create DM channel" },
      { status: 500 }
    );
  }

  // Add both users as channel members
  const { error: membersError } = await admin
    .from("channel_members")
    .insert([
      { channel_id: newChannel.id, member_id: user.id, member_type: "human" },
      {
        channel_id: newChannel.id,
        member_id: target_user_id,
        member_type: "human",
      },
    ]);

  if (membersError) {
    return NextResponse.json({ error: membersError.message }, { status: 500 });
  }

  return NextResponse.json({ channel: newChannel, created: true });
}
