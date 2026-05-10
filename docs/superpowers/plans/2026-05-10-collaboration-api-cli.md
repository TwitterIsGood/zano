# Collaboration API and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server APIs and `zano` CLI commands for threads, tasks, comments, artifacts, dependencies, reviews, and notifications.

**Architecture:** This plan assumes the foundation plan has landed. It keeps transition enforcement centralized in server-side helpers used by API routes and mirrored in CLI flows through API-compatible database operations. Web UI and bridge prompt changes are separate plans.

**Tech Stack:** Next.js Route Handlers, Supabase server/admin clients, TypeScript, existing single-file `packages/cli/src/index.ts`, Vitest-compatible pure helper tests where practical.

---

## File Structure

### Create

- `apps/web/src/lib/collaboration/task-transitions.ts`
  - Server-side helper that gathers dependency, verification, and review context, then calls `canTransitionTask`.
- `apps/web/src/app/api/threads/route.ts`
  - List threads for a channel.
- `apps/web/src/app/api/threads/[messageId]/route.ts`
  - Get thread parent, replies, participants, read state.
- `apps/web/src/app/api/threads/[messageId]/messages/route.ts`
  - Post thread replies.
- `apps/web/src/app/api/threads/[messageId]/read/route.ts`
  - Mark thread read.
- `apps/web/src/app/api/threads/[messageId]/resolve/route.ts`
  - Resolve/unresolve thread.
- `apps/web/src/app/api/tasks/route.ts`
  - List/create tasks.
- `apps/web/src/app/api/tasks/[taskId]/route.ts`
  - Get/update task detail.
- `apps/web/src/app/api/tasks/[taskId]/claim/route.ts`
  - Claim task.
- `apps/web/src/app/api/tasks/[taskId]/unclaim/route.ts`
  - Unclaim task.
- `apps/web/src/app/api/tasks/[taskId]/transition/route.ts`
  - Guarded status transition.
- `apps/web/src/app/api/tasks/[taskId]/comments/route.ts`
  - Add/list task comments.
- `apps/web/src/app/api/tasks/[taskId]/artifacts/route.ts`
  - Add/list task artifacts.
- `apps/web/src/app/api/tasks/[taskId]/dependencies/route.ts`
  - Add/list dependencies.
- `apps/web/src/app/api/tasks/[taskId]/reviews/route.ts`
  - Add/list reviews.
- `apps/web/src/app/api/notifications/route.ts`
  - List notifications.
- `apps/web/src/app/api/notifications/[notificationId]/read/route.ts`
  - Mark notification read.

### Modify

- `packages/cli/src/index.ts`
  - Add thread commands and expanded task commands.
- `packages/cli/package.json`
  - Add `test` script if CLI parsing helpers are extracted.

---

## Task 1: Add server-side transition helper

**Files:**
- Create: `apps/web/src/lib/collaboration/task-transitions.ts`

- [ ] **Step 1: Create helper directory and file**

Create `apps/web/src/lib/collaboration/task-transitions.ts`:

```ts
import { canTransitionTask, type TaskStatus, type TaskTransitionContext } from "@zano/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TransitionCheckResult {
  allowed: boolean;
  reason?: string;
  context?: TaskTransitionContext;
}

export async function checkTaskTransition(
  supabase: SupabaseClient,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
): Promise<TransitionCheckResult> {
  const [dependencies, verifications, reviews, taskResult] = await Promise.all([
    supabase
      .from("task_dependencies")
      .select("predecessor_task_id, tasks!task_dependencies_predecessor_task_id_fkey(status)")
      .eq("successor_task_id", taskId)
      .eq("dependency_type", "blocks"),
    supabase
      .from("task_verifications")
      .select("id")
      .eq("task_id", taskId)
      .eq("passed", true)
      .limit(1),
    supabase
      .from("task_reviews")
      .select("id, verdict")
      .eq("task_id", taskId)
      .in("verdict", ["pass", "pass_with_concerns"]),
    supabase
      .from("tasks")
      .select("reviewer_id, review_policy")
      .eq("id", taskId)
      .single(),
  ]);

  if (dependencies.error) return { allowed: false, reason: dependencies.error.message };
  if (verifications.error) return { allowed: false, reason: verifications.error.message };
  if (reviews.error) return { allowed: false, reason: reviews.error.message };
  if (taskResult.error) return { allowed: false, reason: taskResult.error.message };

  const blockedByOpenTask = (dependencies.data ?? []).some((row) => {
    const joined = row as { tasks?: { status?: string } | { status?: string }[] };
    const predecessor = Array.isArray(joined.tasks) ? joined.tasks[0] : joined.tasks;
    return predecessor?.status !== "done" && predecessor?.status !== "archived";
  });

  const reviewPolicy = (taskResult.data?.review_policy ?? {}) as {
    reviewTypes?: string[];
    completionRequiresUser?: boolean;
  };
  const requiresReview = Boolean(
    taskResult.data?.reviewer_id ||
      reviewPolicy.completionRequiresUser ||
      (reviewPolicy.reviewTypes && reviewPolicy.reviewTypes.length > 0),
  );

  const context: TaskTransitionContext = {
    hasBlockingDependencies: blockedByOpenTask,
    hasPassingVerification: (verifications.data ?? []).length > 0,
    requiresReview,
    hasPassingRequiredReview: (reviews.data ?? []).length > 0,
  };

  return { ...canTransitionTask(from, to, context), context };
}
```

- [ ] **Step 2: Type-check web app**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS or only unrelated existing lint errors. If the Supabase relationship alias fails type checking, replace the dependency query with two queries: first get predecessor IDs, then get statuses from `tasks` by `.in("id", predecessorIds)`.

Do not commit yet.

---

## Task 2: Add thread API routes

**Files:**
- Create all `apps/web/src/app/api/threads/**/route.ts` files listed above.

- [ ] **Step 1: Create list route**

Create `apps/web/src/app/api/threads/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get("channelId");

  if (!channelId) {
    return NextResponse.json({ error: "channelId required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .is("thread_parent_id", null)
    .gt("reply_count", 0)
    .order("last_reply_at", { ascending: false, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ threads: data ?? [] });
}
```

- [ ] **Step 2: Create detail route**

Create `apps/web/src/app/api/threads/[messageId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();

  const [parentResult, repliesResult, participantsResult] = await Promise.all([
    supabase.from("messages").select("*").eq("id", messageId).single(),
    supabase
      .from("messages")
      .select("*")
      .eq("thread_parent_id", messageId)
      .order("created_at", { ascending: true }),
    supabase.from("thread_participants").select("*").eq("thread_parent_id", messageId),
  ]);

  if (parentResult.error) return NextResponse.json({ error: parentResult.error.message }, { status: 404 });
  if (repliesResult.error) return NextResponse.json({ error: repliesResult.error.message }, { status: 500 });
  if (participantsResult.error) return NextResponse.json({ error: participantsResult.error.message }, { status: 500 });

  return NextResponse.json({
    parent: parentResult.data,
    replies: repliesResult.data ?? [],
    participants: participantsResult.data ?? [],
  });
}
```

- [ ] **Step 3: Create reply route**

Create `apps/web/src/app/api/threads/[messageId]/messages/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { channel_id, sender_id, sender_type, content } = body;

  if (!channel_id || !sender_id || !content) {
    return NextResponse.json({ error: "channel_id, sender_id, and content required" }, { status: 400 });
  }

  const { data: message, error } = await supabase
    .from("messages")
    .insert({ channel_id, sender_id, sender_type: sender_type || "human", content, thread_parent_id: messageId })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("thread_participants").upsert({
    thread_parent_id: messageId,
    participant_id: sender_id,
    participant_type: sender_type === "agent" ? "agent" : "human",
    last_read_at: new Date().toISOString(),
  });

  return NextResponse.json({ message });
}
```

- [ ] **Step 4: Create read route**

Create `apps/web/src/app/api/threads/[messageId]/read/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { participant_id, participant_type } = body;

  if (!participant_id || !participant_type) {
    return NextResponse.json({ error: "participant_id and participant_type required" }, { status: 400 });
  }

  const { error } = await supabase.from("thread_participants").upsert({
    thread_parent_id: messageId,
    participant_id,
    participant_type,
    last_read_at: new Date().toISOString(),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Create resolve route**

Create `apps/web/src/app/api/threads/[messageId]/resolve/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ messageId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { messageId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { resolved, actor_id, actor_type } = body;

  if (!actor_id || !actor_type) {
    return NextResponse.json({ error: "actor_id and actor_type required" }, { status: 400 });
  }

  const patch = resolved
    ? {
        thread_resolved_at: new Date().toISOString(),
        thread_resolved_by: actor_id,
        thread_resolved_by_type: actor_type,
      }
    : {
        thread_resolved_at: null,
        thread_resolved_by: null,
        thread_resolved_by_type: null,
      };

  const { data, error } = await supabase
    .from("messages")
    .update(patch)
    .eq("id", messageId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread: data });
}
```

- [ ] **Step 6: Type-check web app**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 3: Add task API routes

**Files:**
- Create all `apps/web/src/app/api/tasks/**/route.ts` files listed in File Structure.

- [ ] **Step 1: Create list/create route**

Create `apps/web/src/app/api/tasks/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const channelId = searchParams.get("channelId");
  const status = searchParams.get("status");
  const tag = searchParams.get("tag");

  let query = supabase.from("tasks").select("*, channels!inner(server_id, name)").order("task_number", { ascending: true });

  if (serverId) query = query.eq("channels.server_id", serverId);
  if (channelId) query = query.eq("channel_id", channelId);
  if (status) query = query.eq("status", status);
  if (tag) query = query.contains("tags", [tag]);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const body = await request.json();
  const { channel_id, title, description, priority, tags, source_message_id, source_thread_parent_id, created_by_id, created_by_type } = body;

  if (!channel_id || !title || !created_by_id || !created_by_type) {
    return NextResponse.json({ error: "channel_id, title, created_by_id, and created_by_type required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      channel_id,
      title,
      description: description ?? null,
      priority: priority ?? "medium",
      tags: tags ?? [],
      source_message_id: source_message_id ?? null,
      source_thread_parent_id: source_thread_parent_id ?? null,
      created_by_id,
      created_by_type,
      current_gate: "ready_to_execute",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
```

- [ ] **Step 2: Create detail/update route**

Create `apps/web/src/app/api/tasks/[taskId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
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

  return NextResponse.json({
    task: task.data,
    comments: comments.data ?? [],
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
  const body = await request.json();

  const allowed = ["title", "description", "priority", "tags", "due_at", "assignee_id", "assignee_type", "reviewer_id", "reviewer_type", "review_policy", "current_gate", "resolution_summary"];
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
```

- [ ] **Step 3: Create claim route**

Create `apps/web/src/app/api/tasks/[taskId]/claim/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { assignee_id, assignee_type } = await request.json();

  if (!assignee_id || !assignee_type) {
    return NextResponse.json({ error: "assignee_id and assignee_type required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id, assignee_type, status: "in_progress", started_at: new Date().toISOString(), current_gate: "executing" })
    .eq("id", taskId)
    .is("assignee_id", null)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ task: data });
}
```

- [ ] **Step 4: Create unclaim route**

Create `apps/web/src/app/api/tasks/[taskId]/unclaim/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .update({ assignee_id: null, assignee_type: null, status: "todo", current_gate: "ready_to_execute" })
    .eq("id", taskId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
```

- [ ] **Step 5: Create transition route**

Create `apps/web/src/app/api/tasks/[taskId]/transition/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkTaskTransition } from "@/lib/collaboration/task-transitions";
import type { TaskStatus } from "@zano/shared";

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { status, actor_id, actor_type, reason } = await request.json();

  if (!status || !actor_id || !actor_type) {
    return NextResponse.json({ error: "status, actor_id, and actor_type required" }, { status: 400 });
  }

  const { data: current, error: currentError } = await supabase.from("tasks").select("status").eq("id", taskId).single();
  if (currentError) return NextResponse.json({ error: currentError.message }, { status: 404 });

  const from = current.status as TaskStatus;
  const to = status as TaskStatus;
  const check = await checkTaskTransition(supabase, taskId, from, to);
  if (!check.allowed) {
    return NextResponse.json({ error: check.reason }, { status: 409 });
  }

  const patch: Record<string, unknown> = { status: to };
  if (to === "in_progress") patch.started_at = new Date().toISOString();
  if (to === "done") patch.completed_at = new Date().toISOString();
  if (to === "archived") patch.archived_at = new Date().toISOString();

  const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("task_events").insert({
    task_id: taskId,
    actor_id,
    actor_type,
    event_type: "status_changed",
    from_state: { status: from },
    to_state: { status: to },
    reason: reason ?? null,
  });

  return NextResponse.json({ task: data });
}
```

- [ ] **Step 6: Add comment/artifact/dependency/review routes**

Create `apps/web/src/app/api/tasks/[taskId]/comments/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_comments").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ comments: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { author_id, author_type, content } = await request.json();
  if (!author_id || !author_type || !content) return NextResponse.json({ error: "author_id, author_type, and content required" }, { status: 400 });
  const { data, error } = await supabase.from("task_comments").insert({ task_id: taskId, author_id, author_type, content }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ comment: data });
}
```

Create `apps/web/src/app/api/tasks/[taskId]/artifacts/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_artifacts").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ artifacts: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { artifact_type, title, url, metadata, created_by_id, created_by_type } = body;
  if (!artifact_type || !title || !created_by_id || !created_by_type) return NextResponse.json({ error: "artifact_type, title, created_by_id, and created_by_type required" }, { status: 400 });
  const { data, error } = await supabase.from("task_artifacts").insert({ task_id: taskId, artifact_type, title, url: url ?? null, metadata: metadata ?? {}, created_by_id, created_by_type }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ artifact: data });
}
```

Create `apps/web/src/app/api/tasks/[taskId]/dependencies/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasDependencyCycle, type TaskDependencyEdge } from "@zano/shared";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_dependencies").select("*").or(`predecessor_task_id.eq.${taskId},successor_task_id.eq.${taskId}`);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dependencies: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { predecessor_task_id, dependency_type } = await request.json();
  if (!predecessor_task_id) return NextResponse.json({ error: "predecessor_task_id required" }, { status: 400 });

  const { data: existing, error: existingError } = await supabase.from("task_dependencies").select("predecessor_task_id, successor_task_id");
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

  const edges: TaskDependencyEdge[] = [
    ...(existing ?? []).map((edge) => ({ predecessorTaskId: edge.predecessor_task_id, successorTaskId: edge.successor_task_id })),
    { predecessorTaskId: predecessor_task_id, successorTaskId: taskId },
  ];

  if (hasDependencyCycle(edges)) {
    return NextResponse.json({ error: "Dependency would create a cycle" }, { status: 409 });
  }

  const { data, error } = await supabase.from("task_dependencies").insert({ predecessor_task_id, successor_task_id: taskId, dependency_type: dependency_type ?? "blocks" }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dependency: data });
}
```

Create `apps/web/src/app/api/tasks/[taskId]/reviews/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params { params: Promise<{ taskId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("task_reviews").select("*").eq("task_id", taskId).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ reviews: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { taskId } = await params;
  const supabase = await createClient();
  const body = await request.json();
  const { reviewer_id, reviewer_type, review_type, findings, verdict, summary } = body;
  if (!reviewer_id || !reviewer_type || !review_type || !verdict || !summary) return NextResponse.json({ error: "reviewer_id, reviewer_type, review_type, verdict, and summary required" }, { status: 400 });
  const { data, error } = await supabase.from("task_reviews").insert({ task_id: taskId, reviewer_id, reviewer_type, review_type, findings: findings ?? [], verdict, summary }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ review: data });
}
```

- [ ] **Step 7: Type-check web app**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 4: Add notification API routes

**Files:**
- Create: `apps/web/src/app/api/notifications/route.ts`
- Create: `apps/web/src/app/api/notifications/[notificationId]/read/route.ts`

- [ ] **Step 1: Create list route**

Create `apps/web/src/app/api/notifications/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const recipientId = searchParams.get("recipientId");
  const recipientType = searchParams.get("recipientType") ?? "human";
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  if (!recipientId) {
    return NextResponse.json({ error: "recipientId required" }, { status: 400 });
  }

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", recipientId)
    .eq("recipient_type", recipientType)
    .order("created_at", { ascending: false })
    .limit(100);

  if (unreadOnly) query = query.is("read_at", null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notifications: data ?? [] });
}
```

- [ ] **Step 2: Create read route**

Create `apps/web/src/app/api/notifications/[notificationId]/read/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface Params {
  params: Promise<{ notificationId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { notificationId } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notification: data });
}
```

- [ ] **Step 3: Type-check web app**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 5: Extend CLI thread and task commands

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Locate existing command dispatcher**

Open `packages/cli/src/index.ts` and find the existing main command branching for `message`, `task`, and `server`. Keep existing command behavior working.

- [ ] **Step 2: Add thread commands**

Add command branches equivalent to:

```ts
// zano thread list --channel #general
// zano thread read --target #general:abcd1234
// zano thread reply --target #general:abcd1234
// zano thread resolve --target #general:abcd1234
```

Implementation requirements:

- `thread list` resolves channel by name and queries top-level messages with `reply_count > 0`.
- `thread read` resolves target to `threadParentId` and prints parent + replies.
- `thread reply` resolves target to `channelId` + `threadParentId`, reads stdin, inserts a message with `sender_type = agent` and `thread_parent_id`.
- `thread resolve` resolves target and updates thread resolution fields with `actor_type = agent`.

Use existing helpers `resolveTarget`, `readStdin`, `fmtTime`, and `shortId` where possible.

- [ ] **Step 3: Extend task commands**

Add or update branches for:

```text
zano task list --channel #general --status todo --tag frontend
zano task create --channel #general --title "..." --priority high --tag frontend --parent 12
zano task claim --number 12
zano task unclaim --number 12
zano task update --number 12 --status in_review --summary "..."
zano task comment --number 12
zano task artifact add --number 12 --type pr --url ... --title ...
zano task dependency add --number 12 --blocks 13
zano task review --number 12 --approve
zano task review --number 12 --changes-requested
```

Implementation requirements:

- Resolve task numbers within the current channel when `--channel` is provided; otherwise find by `task_number` globally for the agent's accessible tasks.
- Task create inserts `title`, `description`, `priority`, `tags`, `parent_task_id`, `created_by_id = AGENT_ID`, `created_by_type = agent`.
- Claim only succeeds if `assignee_id` is null.
- Update status writes to `tasks.status` and inserts a `task_events` row.
- Comment reads stdin and inserts into `task_comments`.
- Artifact add inserts into `task_artifacts`.
- Dependency add inserts into `task_dependencies` and rejects if it would create a cycle by using local graph logic or relying on API in a later refactor.
- Review creates `task_reviews` with verdict `pass` for approve and `fail` for changes-requested.

- [ ] **Step 4: Build CLI**

Run:

```bash
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

Do not commit yet.

---

## Task 6: Verify API/CLI and commit

**Files:**
- All files created/modified in this plan.

- [ ] **Step 1: Run web lint**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

- [ ] **Step 2: Run CLI build**

Run:

```bash
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Commit API/CLI work**

Run:

```bash
git add apps/web/src/lib/collaboration apps/web/src/app/api/threads apps/web/src/app/api/tasks apps/web/src/app/api/notifications packages/cli/src/index.ts packages/cli/package.json
git commit -m "$(cat <<'EOF'
feat: add collaboration API and CLI commands

Add thread, task, notification, review, dependency, comment, artifact, and
transition APIs plus expanded zano CLI commands so agents can operate the
collaboration workflow through structured commands.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Self-Review

### Spec coverage

Covered by this plan:

- Thread APIs.
- Task APIs.
- Guarded transition helper.
- Comments, artifacts, dependencies, reviews.
- Notification APIs.
- CLI thread commands.
- CLI expanded task commands.

Deferred:

- Web UI for threads/tasks/notifications.
- Agent prompt and bridge behavior.
- Browser verification.

### Placeholder scan

This plan contains no `TBD`, `TODO`, or undefined helper references in required code blocks. The CLI task is intentionally directive because `packages/cli/src/index.ts` is a large existing single-file command implementation; the worker must preserve its current structure.

### Type consistency

All API route payload names match the schema names from the foundation plan. Transition helper uses `TaskStatus` and `canTransitionTask` from `@zano/shared`.
