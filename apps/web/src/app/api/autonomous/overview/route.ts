import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

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

  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const admin = createAdminClient();

  const { data: membership, error: membershipError } = await admin
    .from("server_members")
    .select("server_id")
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

  const [
    skillsResult,
    skillCandidatesResult,
    knowledgeResult,
    blueprintsResult,
    spawnEventsResult,
    episodesResult,
    turnsResult,
    toolEventsResult,
    policyEvaluationsResult,
    lintResultsResult,
  ] = await Promise.all([
    admin
      .from("skills")
      .select("id, slug, name, description, state, risk_level, active_version_id, projection_version, updated_at")
      .eq("server_id", serverId)
      .order("updated_at", { ascending: false })
      .limit(limit),
    admin
      .from("skill_candidates")
      .select("id, candidate_type, target_skill_id, target_slug, risk_level, state, rationale, created_by_id, created_by_type, created_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("knowledge_items")
      .select("id, scope, channel_id, task_id, subject, content, kind, confidence, freshness, state, updated_at")
      .eq("server_id", serverId)
      .order("updated_at", { ascending: false })
      .limit(limit),
    admin
      .from("agent_blueprints")
      .select("id, slug, display_name_template, description, default_model, scope, required_skills, state, created_by_id, created_by_type, created_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("agent_spawn_events")
      .select("id, blueprint_id, agent_id, request_event_id, event_type, actor_id, actor_type, reason, created_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("skill_episodes")
      .select("id, channel_id, task_id, agent_id, trigger_type, trigger_strength, source_refs, summary, signals, status, created_at, reviewed_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("agent_turns")
      .select("id, agent_id, channel_id, task_id, status, output_summary, error_summary, started_at, completed_at")
      .eq("server_id", serverId)
      .order("started_at", { ascending: false })
      .limit(limit),
    admin
      .from("agent_tool_events")
      .select("id, turn_id, agent_id, tool_name, tool_kind, input_summary, success, started_at")
      .eq("server_id", serverId)
      .order("started_at", { ascending: false })
      .limit(limit),
    admin
      .from("policy_evaluations")
      .select("id, subject_type, subject_id, action, actor_id, actor_type, risk_level, decision, reason, created_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("skill_lint_results")
      .select("id, skill_id, version_id, candidate_id, lint_status, issues, risk_adjustment, created_at")
      .eq("server_id", serverId)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const firstError =
    skillsResult.error ??
    skillCandidatesResult.error ??
    knowledgeResult.error ??
    blueprintsResult.error ??
    spawnEventsResult.error ??
    episodesResult.error ??
    turnsResult.error ??
    toolEventsResult.error ??
    policyEvaluationsResult.error ??
    lintResultsResult.error;

  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  return NextResponse.json({
    serverId,
    skills: skillsResult.data ?? [],
    skillCandidates: skillCandidatesResult.data ?? [],
    knowledgeItems: knowledgeResult.data ?? [],
    agentBlueprints: blueprintsResult.data ?? [],
    agentSpawnEvents: spawnEventsResult.data ?? [],
    skillEpisodes: episodesResult.data ?? [],
    agentTurns: turnsResult.data ?? [],
    agentToolEvents: toolEventsResult.data ?? [],
    policyEvaluations: policyEvaluationsResult.data ?? [],
    skillLintResults: lintResultsResult.data ?? [],
  });
}
