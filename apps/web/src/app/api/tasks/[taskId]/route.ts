import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { deriveTaskVisibility } from "@/lib/task-activity";
import {
  enrichTaskCommentsWithAuthors,
  type AgentCommentAuthor,
  type HumanCommentAuthor,
  type TaskCommentRow,
} from "./task-comment-authors";

async function recordTaskUpdatedActivity(userId: string, task: { id: string; channel_id: string; title: string }, changedFields: string[]) {
  try {
    const admin = createAdminClient();
    const { visibility, channel_id, server_id } = await deriveTaskVisibility(admin, task.channel_id);

    const { error } = await admin.from("member_activity_events").insert({
      server_id,
      actor_id: userId,
      actor_type: "human",
      event_type: "task.updated",
      subject_type: "task",
      subject_id: task.id,
      target_type: null,
      target_id: null,
      task_id: task.id,
      agent_id: null,
      label: "Updated task",
      summary: `Updated task "${task.title}"`,
      metadata: { title: task.title, changed_fields: changedFields },
      visibility,
      channel_id,
      dedupe_key: `task:${task.id}:updated:${Date.now()}`,
    });

    if (error) throw error;
  } catch (error) {
    console.error("Failed to record task.updated activity", error);
  }
}

interface Params {
  params: Promise<{ taskId: string }>;
}

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

async function attachCommentAuthors(supabase: ServerSupabase, comments: TaskCommentRow[]) {
  const humanIds = [...new Set(comments.filter((comment) => comment.author_type === "human").map((comment) => comment.author_id))];
  const agentIds = [...new Set(comments.filter((comment) => comment.author_type === "agent").map((comment) => comment.author_id))];

  const [profilesResult, agentsResult] = await Promise.all([
    humanIds.length
      ? supabase.from("profiles").select("id, display_name, email, avatar_url").in("id", humanIds)
      : Promise.resolve({ data: [] as HumanCommentAuthor[], error: null }),
    agentIds.length
      ? supabase.from("agents").select("id, name, display_name").in("id", agentIds)
      : Promise.resolve({ data: [] as AgentCommentAuthor[], error: null }),
  ]);

  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (agentsResult.error) throw new Error(agentsResult.error.message);

  return enrichTaskCommentsWithAuthors(comments, {
    humans: new Map(((profilesResult.data ?? []) as HumanCommentAuthor[]).map((profile) => [profile.id, profile])),
    agents: new Map(((agentsResult.data ?? []) as AgentCommentAuthor[]).map((agent) => [agent.id, agent])),
  });
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();

  const [task, comments, artifacts, dependencies, events, verifications, reviews] = await Promise.all([
    supabase.from("tasks").select("*").eq("id", taskId).single(),
    supabase.from("task_comments").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_artifacts").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_dependencies").select("*").or(`predecessor_task_id.eq.${taskId},successor_task_id.eq.${taskId}`),
    supabase.from("task_events").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_verifications").select("*").eq("task_id", taskId).order("created_at"),
    supabase.from("task_reviews").select("*").eq("task_id", taskId).order("created_at"),
  ]);

  if (task.error) return NextResponse.json({ error: task.error.message }, { status: 404 });
  for (const result of [comments, artifacts, dependencies, events, verifications, reviews]) {
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  let commentsWithAuthors;
  try {
    commentsWithAuthors = await attachCommentAuthors(supabase, (comments.data ?? []) as TaskCommentRow[]);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load comment authors" }, { status: 500 });
  }

  return NextResponse.json({
    task: task.data,
    comments: commentsWithAuthors,
    artifacts: artifacts.data ?? [],
    dependencies: dependencies.data ?? [],
    events: events.data ?? [],
    verifications: verifications.data ?? [],
    reviews: reviews.data ?? [],
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  const allowed = ["title", "description", "priority", "tags", "due_at"];
  const changedFields = Object.keys(body).filter((key) => allowed.includes(key));
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordTaskUpdatedActivity(user.id, data, changedFields);

  return NextResponse.json({ task: data });
}
