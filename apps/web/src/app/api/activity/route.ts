import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("server_id");
  const actorType = searchParams.get("actor_type");
  const actorId = searchParams.get("actor_id");
  const rawLimit = searchParams.get("limit");

  if (!serverId) {
    return NextResponse.json(
      { error: "server_id is required" },
      { status: 400 }
    );
  }

  if (!actorType) {
    return NextResponse.json(
      { error: "actor_type is required" },
      { status: 400 }
    );
  }

  if (actorType !== "human" && actorType !== "agent") {
    return NextResponse.json(
      { error: "actor_type must be 'human' or 'agent'" },
      { status: 400 }
    );
  }

  if (!actorId) {
    return NextResponse.json(
      { error: "actor_id is required" },
      { status: 400 }
    );
  }

  const { data: membership, error: membershipError } = await supabase
    .from("server_members")
    .select("member_id")
    .eq("server_id", serverId)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }

  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsedLimit = rawLimit ? Number(rawLimit) : 50;
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 100);

  const admin = createAdminClient();
  const { data: channelMemberships, error: channelMembershipError } = await admin
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", user.id)
    .eq("member_type", "human");

  if (channelMembershipError) {
    return NextResponse.json({ error: channelMembershipError.message }, { status: 500 });
  }

  const channelIds = (channelMemberships ?? []).map((row) => row.channel_id);

  const [serverEventsResult, channelEventsResult] = await Promise.all([
    admin
      .from("member_activity_events")
      .select("*")
      .eq("server_id", serverId)
      .eq("actor_type", actorType)
      .eq("actor_id", actorId)
      .in("visibility", ["server", "public"])
      .order("occurred_at", { ascending: false })
      .limit(limit),
    channelIds.length
      ? admin
          .from("member_activity_events")
          .select("*")
          .eq("server_id", serverId)
          .eq("actor_type", actorType)
          .eq("actor_id", actorId)
          .in("visibility", ["channel", "dm"])
          .in("channel_id", channelIds)
          .order("occurred_at", { ascending: false })
          .limit(limit)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (serverEventsResult.error) {
    return NextResponse.json({ error: serverEventsResult.error.message }, { status: 500 });
  }

  if (channelEventsResult.error) {
    return NextResponse.json({ error: channelEventsResult.error.message }, { status: 500 });
  }


  const events = [...(serverEventsResult.data ?? []), ...(channelEventsResult.data ?? [])]
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
    .slice(0, limit);

  return NextResponse.json({ events });
}
