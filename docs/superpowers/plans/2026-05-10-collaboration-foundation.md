# Collaboration Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared foundation for Zano's comprehensive Thread + Task + Agent Autonomy system: database schema, shared types, workflow transition core, and focused tests.

**Architecture:** This plan only implements the foundational layer. It avoids web UI and CLI behavior except for shared types and pure workflow helpers. Later plans will build API routes, CLI commands, thread UI, task board UI, notifications, and agent prompt behavior on top of these stable interfaces.

**Tech Stack:** TypeScript, pnpm workspaces, Supabase SQL, Vitest for focused unit tests, existing `@zano/shared` package.

---

## File Structure

### Create

- `packages/shared/src/collaboration.ts`
  - Owns shared enums, interfaces, transition helpers, dependency validation, and small pure utilities for the collaboration system.
- `packages/shared/src/collaboration.test.ts`
  - Unit tests for task transition guards and dependency cycle detection.
- `packages/db/src/collaboration.sql`
  - Additive Supabase SQL for thread/task extensions, new workflow tables, notification table, indexes, triggers, and RLS.

### Modify

- `packages/shared/src/index.ts`
  - Re-export collaboration types/helpers and update existing `Message` and `Task` shape to include the expanded fields.
- `packages/shared/package.json`
  - Add `test` script.
- root `package.json`
  - Add `test` script for turbo.
- `turbo.json`
  - Add `test` task.
- root `package.json` devDependencies
  - Add `vitest` as a workspace dev dependency.

### Do not modify in this plan

- `apps/web/**`
- `packages/cli/**`
- `apps/bridge/**`

Those are handled by later plans.

---

## Task 1: Add Vitest test infrastructure for shared package

**Files:**
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Install Vitest**

Run:

```bash
pnpm add -D -w vitest
```

Expected: `package.json` and `pnpm-lock.yaml` update with `vitest` in root dev dependencies.

- [ ] **Step 2: Add root test script**

Modify root `package.json` scripts to include `test`:

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "test": "turbo test",
    "dev:web": "pnpm --filter @zano/web dev",
    "dev:bridge": "pnpm --filter @zano/bridge dev",
    "db:generate": "pnpm --filter @zano/db generate",
    "db:push": "pnpm --filter @zano/db push"
  }
}
```

- [ ] **Step 3: Add turbo test task**

Modify `turbo.json` to include a test task:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 4: Add shared package test script**

Modify `packages/shared/package.json` scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 5: Verify empty test command fails because no tests exist yet**

Run:

```bash
pnpm --filter @zano/shared test -- --passWithNoTests=false
```

Expected: Vitest exits non-zero because there are no test files yet.

Do not commit yet; Task 2 adds tests.

---

## Task 2: Write failing workflow tests

**Files:**
- Create: `packages/shared/src/collaboration.test.ts`

- [ ] **Step 1: Create failing tests for transitions and dependencies**

Create `packages/shared/src/collaboration.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  hasDependencyCycle,
  type TaskDependencyEdge,
  type TaskStatus,
  type TaskTransitionContext,
} from "./collaboration";

function ctx(overrides: Partial<TaskTransitionContext> = {}): TaskTransitionContext {
  return {
    hasBlockingDependencies: false,
    hasPassingVerification: true,
    requiresReview: false,
    hasPassingRequiredReview: false,
    ...overrides,
  };
}

describe("canTransitionTask", () => {
  it("allows todo tasks to start when they are not blocked", () => {
    expect(canTransitionTask("todo", "in_progress", ctx())).toEqual({ allowed: true });
  });

  it("blocks todo tasks from starting when blocking dependencies remain", () => {
    expect(
      canTransitionTask("todo", "in_progress", ctx({ hasBlockingDependencies: true })),
    ).toEqual({ allowed: false, reason: "Task has unresolved blocking dependencies" });
  });

  it("allows verified simple tasks to move directly from in_progress to done", () => {
    expect(canTransitionTask("in_progress", "done", ctx())).toEqual({ allowed: true });
  });

  it("blocks in_progress to done without passing verification", () => {
    expect(
      canTransitionTask("in_progress", "done", ctx({ hasPassingVerification: false })),
    ).toEqual({ allowed: false, reason: "Task needs passing verification evidence" });
  });

  it("requires review before done when review policy applies", () => {
    expect(
      canTransitionTask("in_progress", "done", ctx({ requiresReview: true })),
    ).toEqual({ allowed: false, reason: "Task requires review before completion" });
  });

  it("allows reviewed tasks to complete from in_review", () => {
    expect(
      canTransitionTask(
        "in_review",
        "done",
        ctx({ requiresReview: true, hasPassingRequiredReview: true }),
      ),
    ).toEqual({ allowed: true });
  });

  it("returns a reason for invalid transitions", () => {
    expect(canTransitionTask("done", "in_progress", ctx())).toEqual({
      allowed: false,
      reason: "Invalid transition from done to in_progress",
    });
  });
});

describe("hasDependencyCycle", () => {
  it("returns false when dependencies are acyclic", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-c" },
    ];

    expect(hasDependencyCycle(edges)).toBe(false);
  });

  it("returns true when dependencies contain a direct cycle", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-a" },
    ];

    expect(hasDependencyCycle(edges)).toBe(true);
  });

  it("returns true when dependencies contain an indirect cycle", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-c" },
      { predecessorTaskId: "task-c", successorTaskId: "task-a" },
    ];

    expect(hasDependencyCycle(edges)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @zano/shared test
```

Expected: FAIL with an import error like `Failed to resolve import "./collaboration"`.

Do not commit yet; Task 3 implements the code.

---

## Task 3: Implement shared collaboration types and workflow helpers

**Files:**
- Create: `packages/shared/src/collaboration.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create collaboration helper implementation**

Create `packages/shared/src/collaboration.ts`:

```ts
export type ActorType = "human" | "agent" | "system";
export type ParticipantType = "human" | "agent";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "changes_requested"
  | "done"
  | "archived";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskGate =
  | "needs_spec"
  | "spec_review"
  | "needs_plan"
  | "plan_review"
  | "ready_to_execute"
  | "executing"
  | "needs_verification"
  | "needs_review"
  | "review_passed"
  | "ready_for_completion";

export type ReviewStatus = "pending" | "approved" | "rejected" | "changes_requested";
export type DocumentStatus = "draft" | "self_reviewed" | "needs_user_review" | "approved" | "changes_requested";
export type StepStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
export type AgentRunStatus = "dispatched" | "running" | "done_with_concerns" | "done" | "blocked" | "failed";
export type ReviewVerdict = "pass" | "pass_with_concerns" | "fail" | "blocked";
export type DependencyType = "blocks" | "related";
export type ThreadSubscriptionType = "auto" | "manual" | "mention";

export interface TaskReviewPolicy {
  specRequired?: boolean;
  planRequired?: boolean;
  tddRequired?: boolean;
  reviewTypes?: string[];
  verificationRequired?: boolean;
  completionRequiresUser?: boolean;
}

export interface TaskTransitionContext {
  hasBlockingDependencies: boolean;
  hasPassingVerification: boolean;
  requiresReview: boolean;
  hasPassingRequiredReview: boolean;
}

export interface TaskTransitionResult {
  allowed: boolean;
  reason?: string;
}

export interface TaskDependencyEdge {
  predecessorTaskId: string;
  successorTaskId: string;
}

const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "blocked", "archived"],
  in_progress: ["blocked", "in_review", "done", "changes_requested", "archived"],
  blocked: ["todo", "in_progress", "archived"],
  in_review: ["changes_requested", "done", "archived"],
  changes_requested: ["in_progress", "blocked", "archived"],
  done: ["archived"],
  archived: [],
};

export function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  context: TaskTransitionContext,
): TaskTransitionResult {
  if (!allowedTransitions[from].includes(to)) {
    return { allowed: false, reason: `Invalid transition from ${from} to ${to}` };
  }

  if ((to === "in_progress" || to === "todo") && context.hasBlockingDependencies) {
    return { allowed: false, reason: "Task has unresolved blocking dependencies" };
  }

  if (to === "done") {
    if (!context.hasPassingVerification) {
      return { allowed: false, reason: "Task needs passing verification evidence" };
    }

    if (context.requiresReview && !context.hasPassingRequiredReview) {
      return { allowed: false, reason: "Task requires review before completion" };
    }
  }

  return { allowed: true };
}

export function hasDependencyCycle(edges: TaskDependencyEdge[]): boolean {
  const graph = new Map<string, string[]>();

  for (const edge of edges) {
    const existing = graph.get(edge.predecessorTaskId) ?? [];
    existing.push(edge.successorTaskId);
    graph.set(edge.predecessorTaskId, existing);

    if (!graph.has(edge.successorTaskId)) {
      graph.set(edge.successorTaskId, []);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;

    visiting.add(node);

    for (const next of graph.get(node) ?? []) {
      if (visit(next)) return true;
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (visit(node)) return true;
  }

  return false;
}
```

- [ ] **Step 2: Re-export collaboration module**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./collaboration";
```

- [ ] **Step 3: Run shared tests**

Run:

```bash
pnpm --filter @zano/shared test
```

Expected: PASS for all tests in `collaboration.test.ts`.

Do not commit yet; Task 4 updates exported data shapes.

---

## Task 4: Expand shared Message and Task interfaces

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Import collaboration types**

At the top of `packages/shared/src/index.ts`, after the header comments, add:

```ts
import type {
  ActorType,
  AgentRunStatus,
  DependencyType,
  DocumentStatus,
  ParticipantType,
  ReviewStatus,
  ReviewVerdict,
  StepStatus,
  TaskGate,
  TaskPriority,
  TaskReviewPolicy,
  TaskStatus,
  ThreadSubscriptionType,
} from "./collaboration";
```

- [ ] **Step 2: Update Message interface**

Replace the existing `Message` interface with:

```ts
export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  seq: number | null;
  thread_parent_id: string | null;
  reply_count: number;
  last_reply_at: string | null;
  thread_resolved_at: string | null;
  thread_resolved_by: string | null;
  thread_resolved_by_type: ActorType | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Replace TaskStatus alias and Task interface**

Remove the existing line:

```ts
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
```

Replace the existing `Task` interface with:

```ts
export interface Task {
  id: string;
  message_id: string | null;
  source_message_id: string | null;
  source_thread_parent_id: string | null;
  channel_id: string;
  task_number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  parent_task_id: string | null;
  current_gate: TaskGate | null;
  review_policy: TaskReviewPolicy;
  assignee_id: string | null;
  assignee_type: ParticipantType | null;
  reviewer_id: string | null;
  reviewer_type: ParticipantType | null;
  review_status: ReviewStatus | null;
  created_by_id: string | null;
  created_by_type: ActorType | null;
  resolution_summary: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 4: Add new collaboration interfaces below Task**

Add after the `Task` interface:

```ts
export interface ThreadParticipant {
  thread_parent_id: string;
  participant_id: string;
  participant_type: ParticipantType;
  first_participated_at: string;
  last_read_at: string | null;
}

export interface ThreadSubscription {
  thread_parent_id: string;
  subscriber_id: string;
  subscriber_type: ParticipantType;
  subscription_type: ThreadSubscriptionType;
  muted: boolean;
  created_at: string;
}

export interface TaskDependency {
  predecessor_task_id: string;
  successor_task_id: string;
  dependency_type: DependencyType;
  created_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author_id: string;
  author_type: ActorType;
  content: string;
  created_at: string;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  artifact_type: "pr" | "commit" | "file" | "url" | "report" | "log" | "note" | "spec" | "plan" | "evidence";
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  actor_id: string;
  actor_type: ActorType;
  event_type: string;
  from_state: Record<string, unknown> | null;
  to_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface TaskSpec {
  id: string;
  task_id: string;
  title: string;
  content: string;
  status: DocumentStatus;
  approved_by: string | null;
  approved_by_type: ParticipantType | null;
  approved_at: string | null;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskPlan {
  id: string;
  task_id: string;
  spec_id: string | null;
  title: string;
  content: string;
  status: DocumentStatus;
  approved_by: string | null;
  approved_by_type: ParticipantType | null;
  approved_at: string | null;
  created_by_id: string;
  created_by_type: ActorType;
  created_at: string;
}

export interface TaskStep {
  id: string;
  plan_id: string;
  task_id: string;
  order_index: number;
  description: string;
  target_files: string[] | null;
  required_skill: string | null;
  verification_command: string | null;
  expected_result: string | null;
  status: StepStatus;
  started_at: string | null;
  completed_at: string | null;
  assigned_to_id: string | null;
  assigned_to_type: ParticipantType | null;
  evidence_summary: string | null;
  created_at: string;
}

export interface TaskVerification {
  id: string;
  task_id: string;
  step_id: string | null;
  actor_id: string;
  actor_type: ActorType;
  verification_type: string;
  command_or_check: string;
  output_summary: string | null;
  passed: boolean;
  evidence_url: string | null;
  created_at: string;
}

export interface TaskAgentRun {
  id: string;
  task_id: string;
  step_id: string | null;
  agent_id: string;
  role: string;
  prompt_snapshot: string | null;
  context_manifest: Record<string, unknown>;
  status: AgentRunStatus;
  output_summary: string | null;
  concerns: string | null;
  files_touched: string[] | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TaskReview {
  id: string;
  task_id: string;
  agent_run_id: string | null;
  reviewer_id: string;
  reviewer_type: ParticipantType;
  review_type: string;
  findings: Array<{
    severity: "critical" | "important" | "minor";
    category: string;
    location?: string;
    recommendation: string;
    blocking: boolean;
  }>;
  verdict: ReviewVerdict;
  summary: string;
  created_at: string;
}

export interface Notification {
  id: string;
  recipient_id: string;
  recipient_type: ParticipantType;
  type: string;
  channel_id: string | null;
  message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}
```

- [ ] **Step 5: Run shared lint and tests**

Run:

```bash
pnpm --filter @zano/shared lint && pnpm --filter @zano/shared test
```

Expected: both commands PASS.

Do not commit yet; Task 5 adds schema.

---

## Task 5: Add additive collaboration database schema

**Files:**
- Create: `packages/db/src/collaboration.sql`

- [ ] **Step 1: Create SQL file**

Create `packages/db/src/collaboration.sql` with:

```sql
-- ============================================================
-- Zano Collaboration System Schema Extensions
-- Threads, Tasks, Agent Autonomy, Notifications
-- ============================================================

-- -----------------------------------------------------------
-- Thread metadata on messages
-- -----------------------------------------------------------
alter table public.messages
  add column if not exists reply_count integer default 0 not null,
  add column if not exists last_reply_at timestamptz,
  add column if not exists thread_resolved_at timestamptz,
  add column if not exists thread_resolved_by uuid,
  add column if not exists thread_resolved_by_type text check (thread_resolved_by_type in ('human', 'agent', 'system'));

create or replace function public.prevent_nested_threads()
returns trigger as $$
begin
  if new.thread_parent_id is not null and exists (
    select 1 from public.messages parent
    where parent.id = new.thread_parent_id
      and parent.thread_parent_id is not null
  ) then
    raise exception 'Nested threads are not supported';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_nested_threads on public.messages;
create trigger trg_prevent_nested_threads
before insert or update of thread_parent_id on public.messages
for each row execute function public.prevent_nested_threads();

create or replace function public.update_thread_parent_counts()
returns trigger as $$
begin
  if new.thread_parent_id is not null then
    update public.messages
    set reply_count = reply_count + 1,
        last_reply_at = new.created_at,
        updated_at = now()
    where id = new.thread_parent_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_update_thread_parent_counts on public.messages;
create trigger trg_update_thread_parent_counts
after insert on public.messages
for each row execute function public.update_thread_parent_counts();

create table if not exists public.thread_participants (
  thread_parent_id uuid references public.messages(id) on delete cascade not null,
  participant_id uuid not null,
  participant_type text not null check (participant_type in ('human', 'agent')),
  first_participated_at timestamptz default now() not null,
  last_read_at timestamptz,
  primary key (thread_parent_id, participant_id, participant_type)
);

create table if not exists public.thread_subscriptions (
  thread_parent_id uuid references public.messages(id) on delete cascade not null,
  subscriber_id uuid not null,
  subscriber_type text not null check (subscriber_type in ('human', 'agent')),
  subscription_type text default 'auto' not null check (subscription_type in ('auto', 'manual', 'mention')),
  muted boolean default false not null,
  created_at timestamptz default now() not null,
  primary key (thread_parent_id, subscriber_id, subscriber_type)
);

create index if not exists idx_thread_participants_participant on public.thread_participants(participant_id, participant_type);
create index if not exists idx_thread_subscriptions_subscriber on public.thread_subscriptions(subscriber_id, subscriber_type);

-- -----------------------------------------------------------
-- Expanded tasks
-- -----------------------------------------------------------
alter table public.tasks
  alter column message_id drop not null,
  add column if not exists source_message_id uuid references public.messages(id) on delete set null,
  add column if not exists source_thread_parent_id uuid references public.messages(id) on delete set null,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists priority text default 'medium' check (priority in ('critical', 'high', 'medium', 'low')),
  add column if not exists tags text[] default '{}' not null,
  add column if not exists due_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists parent_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists created_by_id uuid,
  add column if not exists created_by_type text check (created_by_type in ('human', 'agent', 'system')),
  add column if not exists current_gate text,
  add column if not exists review_policy jsonb default '{}' not null,
  add column if not exists reviewer_id uuid,
  add column if not exists reviewer_type text check (reviewer_type in ('human', 'agent')),
  add column if not exists review_status text check (review_status in ('pending', 'approved', 'rejected', 'changes_requested')),
  add column if not exists resolution_summary text,
  add column if not exists archived_at timestamptz;

update public.tasks
set title = coalesce(title, left(coalesce((select content from public.messages where messages.id = tasks.message_id), 'Untitled task'), 160)),
    source_message_id = coalesce(source_message_id, message_id)
where title is null;

alter table public.tasks
  alter column title set not null;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo', 'in_progress', 'blocked', 'in_review', 'changes_requested', 'done', 'archived'));

create index if not exists idx_tasks_status on public.tasks(status);
create index if not exists idx_tasks_assignee on public.tasks(assignee_id, assignee_type);
create index if not exists idx_tasks_parent on public.tasks(parent_task_id);
create index if not exists idx_tasks_source_thread on public.tasks(source_thread_parent_id);

create table if not exists public.task_dependencies (
  predecessor_task_id uuid references public.tasks(id) on delete cascade not null,
  successor_task_id uuid references public.tasks(id) on delete cascade not null,
  dependency_type text default 'blocks' not null check (dependency_type in ('blocks', 'related')),
  created_at timestamptz default now() not null,
  primary key (predecessor_task_id, successor_task_id),
  check (predecessor_task_id <> successor_task_id)
);

create index if not exists idx_task_dependencies_successor on public.task_dependencies(successor_task_id);

create table if not exists public.task_comments (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  author_id uuid not null,
  author_type text not null check (author_type in ('human', 'agent', 'system')),
  content text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.task_artifacts (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  artifact_type text not null check (artifact_type in ('pr', 'commit', 'file', 'url', 'report', 'log', 'note', 'spec', 'plan', 'evidence')),
  title text not null,
  url text,
  metadata jsonb default '{}' not null,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz default now() not null
);

create table if not exists public.task_events (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  event_type text not null,
  from_state jsonb,
  to_state jsonb,
  reason text,
  created_at timestamptz default now() not null
);

create table if not exists public.task_specs (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  title text not null,
  content text not null,
  status text default 'draft' not null check (status in ('draft', 'self_reviewed', 'needs_user_review', 'approved', 'changes_requested')),
  approved_by uuid,
  approved_by_type text check (approved_by_type in ('human', 'agent')),
  approved_at timestamptz,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz default now() not null
);

create table if not exists public.task_plans (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  spec_id uuid references public.task_specs(id) on delete set null,
  title text not null,
  content text not null,
  status text default 'draft' not null check (status in ('draft', 'self_reviewed', 'needs_user_review', 'approved', 'changes_requested')),
  approved_by uuid,
  approved_by_type text check (approved_by_type in ('human', 'agent')),
  approved_at timestamptz,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz default now() not null
);

create table if not exists public.task_steps (
  id uuid default uuid_generate_v4() primary key,
  plan_id uuid references public.task_plans(id) on delete cascade not null,
  task_id uuid references public.tasks(id) on delete cascade not null,
  order_index integer not null,
  description text not null,
  target_files text[],
  required_skill text,
  verification_command text,
  expected_result text,
  status text default 'pending' not null check (status in ('pending', 'in_progress', 'done', 'blocked', 'skipped')),
  started_at timestamptz,
  completed_at timestamptz,
  assigned_to_id uuid,
  assigned_to_type text check (assigned_to_type in ('human', 'agent')),
  evidence_summary text,
  created_at timestamptz default now() not null,
  unique (plan_id, order_index)
);

create table if not exists public.task_verifications (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  step_id uuid references public.task_steps(id) on delete set null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  verification_type text not null,
  command_or_check text not null,
  output_summary text,
  passed boolean not null,
  evidence_url text,
  created_at timestamptz default now() not null
);

create table if not exists public.task_agent_runs (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  step_id uuid references public.task_steps(id) on delete set null,
  agent_id uuid not null,
  role text not null,
  prompt_snapshot text,
  context_manifest jsonb default '{}' not null,
  status text default 'dispatched' not null check (status in ('dispatched', 'running', 'done_with_concerns', 'done', 'blocked', 'failed')),
  output_summary text,
  concerns text,
  files_touched text[],
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now() not null
);

create table if not exists public.task_reviews (
  id uuid default uuid_generate_v4() primary key,
  task_id uuid references public.tasks(id) on delete cascade not null,
  agent_run_id uuid references public.task_agent_runs(id) on delete set null,
  reviewer_id uuid not null,
  reviewer_type text not null check (reviewer_type in ('human', 'agent')),
  review_type text not null,
  findings jsonb default '[]' not null,
  verdict text not null check (verdict in ('pass', 'pass_with_concerns', 'fail', 'blocked')),
  summary text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.notifications (
  id uuid default uuid_generate_v4() primary key,
  recipient_id uuid not null,
  recipient_type text not null check (recipient_type in ('human', 'agent')),
  type text not null,
  channel_id uuid references public.channels(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  thread_parent_id uuid references public.messages(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz default now() not null
);

create index if not exists idx_task_comments_task on public.task_comments(task_id, created_at);
create index if not exists idx_task_artifacts_task on public.task_artifacts(task_id, created_at);
create index if not exists idx_task_events_task on public.task_events(task_id, created_at);
create index if not exists idx_task_specs_task on public.task_specs(task_id, created_at);
create index if not exists idx_task_plans_task on public.task_plans(task_id, created_at);
create index if not exists idx_task_steps_task on public.task_steps(task_id, order_index);
create index if not exists idx_task_verifications_task on public.task_verifications(task_id, created_at);
create index if not exists idx_task_agent_runs_task on public.task_agent_runs(task_id, created_at);
create index if not exists idx_task_reviews_task on public.task_reviews(task_id, created_at);
create index if not exists idx_notifications_recipient on public.notifications(recipient_id, recipient_type, read_at, created_at desc);

-- -----------------------------------------------------------
-- RLS
-- -----------------------------------------------------------
alter table public.thread_participants enable row level security;
alter table public.thread_subscriptions enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_comments enable row level security;
alter table public.task_artifacts enable row level security;
alter table public.task_events enable row level security;
alter table public.task_specs enable row level security;
alter table public.task_plans enable row level security;
alter table public.task_steps enable row level security;
alter table public.task_verifications enable row level security;
alter table public.task_agent_runs enable row level security;
alter table public.task_reviews enable row level security;
alter table public.notifications enable row level security;

create policy "Thread participants follow message access" on public.thread_participants for all using (
  exists (
    select 1 from public.messages m
    join public.channel_members cm on cm.channel_id = m.channel_id
    where m.id = thread_participants.thread_parent_id
      and cm.member_id = auth.uid()
  )
);

create policy "Thread subscriptions follow message access" on public.thread_subscriptions for all using (
  exists (
    select 1 from public.messages m
    join public.channel_members cm on cm.channel_id = m.channel_id
    where m.id = thread_subscriptions.thread_parent_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task dependencies follow successor access" on public.task_dependencies for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_dependencies.successor_task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task comments follow task access" on public.task_comments for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_comments.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task artifacts follow task access" on public.task_artifacts for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_artifacts.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task events follow task access" on public.task_events for select using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_events.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task specs follow task access" on public.task_specs for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_specs.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task plans follow task access" on public.task_plans for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_plans.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task steps follow task access" on public.task_steps for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_steps.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task verifications follow task access" on public.task_verifications for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_verifications.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task agent runs follow task access" on public.task_agent_runs for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_agent_runs.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Task reviews follow task access" on public.task_reviews for all using (
  exists (
    select 1 from public.tasks t
    join public.channel_members cm on cm.channel_id = t.channel_id
    where t.id = task_reviews.task_id
      and cm.member_id = auth.uid()
  )
);

create policy "Recipients can view own notifications" on public.notifications for select using (
  recipient_id = auth.uid()
);

create policy "Recipients can update own notifications" on public.notifications for update using (
  recipient_id = auth.uid()
);

-- -----------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.task_comments;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.task_artifacts;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.task_events;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.thread_participants;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.thread_subscriptions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;
```

- [ ] **Step 2: Verify SQL file exists and contains no placeholders**

Run:

```bash
grep -nE 'TBD|TODO|placeholder|\?\?\?' packages/db/src/collaboration.sql || true
```

Expected: no output.

Do not commit yet; Task 6 verifies all foundation work.

---

## Task 6: Verify foundation and commit

**Files:**
- All files from Tasks 1–5.

- [ ] **Step 1: Run shared tests**

Run:

```bash
pnpm --filter @zano/shared test
```

Expected: PASS.

- [ ] **Step 2: Run shared lint**

Run:

```bash
pnpm --filter @zano/shared lint
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run:

```bash
pnpm build
```

Expected: PASS. If this fails because downstream apps assume old `Message`/`Task` fields, update only type annotations/casts needed to compile without implementing UI/API features from later plans.

- [ ] **Step 4: Run full tests**

Run:

```bash
pnpm test
```

Expected: PASS for `@zano/shared` and no failing package test tasks.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git diff --stat
```

Expected: changed files are limited to:

```text
package.json
pnpm-lock.yaml
turbo.json
packages/shared/package.json
packages/shared/src/index.ts
packages/shared/src/collaboration.ts
packages/shared/src/collaboration.test.ts
packages/db/src/collaboration.sql
```

- [ ] **Step 6: Commit foundation work**

Run:

```bash
git add package.json pnpm-lock.yaml turbo.json packages/shared/package.json packages/shared/src/index.ts packages/shared/src/collaboration.ts packages/shared/src/collaboration.test.ts packages/db/src/collaboration.sql
git commit -m "$(cat <<'EOF'
feat: add collaboration system foundation

Add shared collaboration workflow types, task transition guards, dependency
cycle detection, focused Vitest coverage, and additive Supabase schema for
threads, expanded tasks, workflow artifacts, reviews, verification, and durable
notifications.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Self-Review

### Spec coverage

Covered by this plan:

- Message thread metadata fields and thread participant/subscription tables.
- Expanded task fields, statuses, priorities, gates, review policy.
- Task dependencies, comments, artifacts, events.
- Task specs, plans, steps, verifications, agent runs, reviews.
- Durable notifications for humans and agents.
- Shared transition helper enforcing review and verification policies.
- Shared dependency cycle detection.
- Focused automated test setup.

Not covered by this plan and intentionally deferred:

- API routes for threads/tasks.
- CLI commands.
- Web thread panel.
- Drag-and-drop task board.
- Notification UI and unread state.
- Bridge/system prompt updates.
- Browser or bridge manual verification.

### Placeholder scan

No `TBD`, `TODO`, placeholder instructions, or undefined helper names remain in this plan.

### Type consistency

The tests import `canTransitionTask`, `hasDependencyCycle`, `TaskDependencyEdge`, `TaskStatus`, and `TaskTransitionContext`, all defined in `packages/shared/src/collaboration.ts`. `TaskStatus` used in `packages/shared/src/index.ts` is imported from the same file and re-exported with `export *`.
