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
  const memberType = searchParams.get("member_type");
  const memberId = searchParams.get("member_id");

  if (!serverId || !memberType || !memberId) {
    return NextResponse.json(
      { error: "server_id, member_type, and member_id are required" },
      { status: 400 }
    );
  }

  if (memberType !== "human" && memberType !== "agent") {
    return NextResponse.json(
      { error: "member_type must be 'human' or 'agent'" },
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

  const admin = createAdminClient();

  // Collect task IDs from all sources where the member participated
  const sources = await Promise.all([
    admin
      .from("tasks")
      .select("id")
      .eq("assignee_id", memberId)
      .eq("assignee_type", memberType),
    admin
      .from("tasks")
      .select("id")
      .eq("created_by_id", memberId)
      .eq("created_by_type", memberType),
    admin
      .from("task_events")
      .select("task_id")
      .eq("actor_id", memberId)
      .eq("actor_type", memberType),
    admin
      .from("task_comments")
      .select("task_id")
      .eq("author_id", memberId)
      .eq("author_type", memberType),
    admin
      .from("task_artifacts")
      .select("task_id")
      .eq("created_by_id", memberId)
      .eq("created_by_type", memberType),
    admin
      .from("task_reviews")
      .select("task_id")
      .eq("reviewer_id", memberId)
      .eq("reviewer_type", memberType),
    admin
      .from("task_verifications")
      .select("task_id")
      .eq("actor_id", memberId)
      .eq("actor_type", memberType),
  ]);

  const taskIds = new Set<string>();
  const [assignedTasks, createdTasks, ...activitySources] = sources;

  for (const result of [assignedTasks, createdTasks]) {
    if (result.error) {
      return NextResponse.json(
        { error: result.error.message },
        { status: 500 }
      );
    }
    for (const row of result.data ?? []) {
      taskIds.add(row.id);
    }
  }

  for (const result of activitySources) {
    if (result.error) {
      return NextResponse.json(
        { error: result.error.message },
        { status: 500 }
      );
    }
    for (const row of result.data ?? []) {
      taskIds.add(row.task_id);
    }
  }

  if (taskIds.size === 0) {
    return NextResponse.json({ tasks: [] });
  }

  const { data: memberships, error: channelMembershipError } = await admin
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", user.id)
    .eq("member_type", "human");

  if (channelMembershipError) {
    return NextResponse.json({ error: channelMembershipError.message }, { status: 500 });
  }

  const channelIds = (memberships ?? []).map((row) => row.channel_id);

  if (channelIds.length === 0) {
    return NextResponse.json({ tasks: [] });
  }

  const { data, error } = await admin
    .from("tasks")
    .select("*, channels!inner(server_id)")
    .in("id", Array.from(taskIds))
    .in("channel_id", channelIds)
    .eq("channels.server_id", serverId)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ tasks: data ?? [] });
}
