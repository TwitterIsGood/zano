import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  enrichTaskCommentsWithAuthors,
  type AgentCommentAuthor,
  type HumanCommentAuthor,
  type TaskCommentRow,
} from "../task-comment-authors";

interface Params { params: Promise<{ taskId: string }> }

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
  const { data, error } = await supabase.from("task_comments").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    const comments = await attachCommentAuthors(supabase, (data ?? []) as TaskCommentRow[]);
    return NextResponse.json({ comments });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load comment authors" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { content } = await request.json();
  if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });
  const { data, error } = await supabase.from("task_comments").insert({ task_id: taskId, author_id: user.id, author_type: "human", content }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    const [comment] = await attachCommentAuthors(supabase, [data as TaskCommentRow]);
    return NextResponse.json({ comment });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load comment author" }, { status: 500 });
  }
}
