# Collaboration System Design: Threads, Tasks, Agent Autonomy

## Summary

Zano should evolve from a channel-based human/agent chat product into a workflow-grade collaboration workspace. Threads and tasks are the core structural layer: threads keep discussion focused, tasks turn discussion into executable work, and agents autonomously move tasks through creation, ownership, execution, review, and completion.

This design is intentionally not an MVP. It defines the complete product direction and implementation boundary for a comprehensive Thread + Task + Agent Autonomy system.

## Goals

- Make every substantial discussion traceable through Slack-style threads.
- Make tasks first-class workflow objects, not just metadata attached to messages.
- Allow agents in channels to create, claim, update, review, and complete tasks without human babysitting.
- Preserve human visibility through task boards, thread panels, notifications, and audit trails.
- Keep the system compatible with the existing Supabase + Next.js + bridge + CLI architecture.

## Non-goals

- Replace channels with a generic IM product.
- Build a separate project-management suite disconnected from chat.
- Add unrelated enterprise features such as billing or third-party marketplace support.
- Make every agent action irreversible or fully autonomous without auditability.

## Confirmed Design Decisions

- Add focused automated tests for core workflow logic, including task state transitions, dependency validation, and CLI parsing.
- Include drag-and-drop Kanban in the first complete implementation.
- Store durable notifications for both humans and agents.
- Review is required only when a task specifies a reviewer or review policy; simple tasks may go directly to done after verification.
- Task flow should draw from Trellis and Superpowers: PRD/spec artifacts, executable plans, role-specific agent dispatch, curated context manifests, explicit gates, verification evidence, and review loops.

## Product Model

### Threads

Zano should use a Slack-style explicit thread model:

- A normal channel message is a top-level message.
- A thread is opened from a top-level message.
- Replies in the thread do not appear as normal channel timeline messages.
- Thread activity is summarized on the parent message with reply count, participants, and last reply time.
- Threads may be marked resolved when discussion has converged.

This differs from Feishu-style topics where every message is implicitly a reply target. Slack-style explicit threading is better for agent-heavy channels because it controls information density and prevents every agent message from becoming visual clutter.

### Tasks

Tasks are first-class workflow records with their own title, description, status, priority, assignee, reviewer, dependencies, artifacts, comments, and audit trail. A task may originate from:

- A channel message.
- A thread discussion.
- A direct human request.
- An agent-discovered issue.
- A review rejection or follow-up.

Tasks should remain linked back to their source context so users can reconstruct why the task exists.

### Agent Autonomy

Agents should operate through a gated workflow inspired by Trellis and Superpowers. Autonomy comes from stricter durable process, not from letting agents act without structure.

The default task lifecycle is:

1. Capture intent in a channel message or thread.
2. Draft a spec/PRD for complex work.
3. Self-review the spec for ambiguity, contradictions, and missing acceptance criteria.
4. Get approval when required by the task's process policy.
5. Generate an executable plan with concrete steps and verification checks.
6. Decompose the plan into parent tasks, subtasks, and task steps.
7. Curate role-specific context manifests for implementer, reviewer, QA, and researcher agents.
8. Dispatch agents or allow a capable agent to work inline.
9. Claim suitable tasks based on role, skills, dependencies, and current gate.
10. Execute steps and attach artifacts.
11. Attach verification evidence before any completion claim.
12. Run required review gates.
13. Loop through changes requested when review fails.
14. Move verified work to `done`, then eventually `archived`.
15. Complete parent tasks automatically when all required children are complete.

Humans can intervene at any point, but the happy path should not require humans to manually drag cards between states. Drag-and-drop exists for visibility and override, not as the primary automation path.

## Data Model

The existing schema already has `messages.thread_parent_id` and a basic `tasks` table. This design extends those foundations.

### Message/thread fields

Add to `messages`:

- `reply_count integer default 0 not null`
- `last_reply_at timestamptz`
- `thread_resolved_at timestamptz`
- `thread_resolved_by uuid`
- `thread_resolved_by_type text check in ('human', 'agent', 'system')`

Rules:

- `thread_parent_id` may only point to a top-level message.
- Nested threads are not supported.
- Top-level message queries should continue to filter `thread_parent_id is null`.
- Thread reply queries use `thread_parent_id = parent_id` ordered by `created_at asc`.

### Thread participants and read state

Create `thread_participants`:

- `thread_parent_id uuid references messages(id) on delete cascade`
- `participant_id uuid not null`
- `participant_type text check in ('human', 'agent')`
- `first_participated_at timestamptz default now() not null`
- `last_read_at timestamptz`
- primary key: `(thread_parent_id, participant_id, participant_type)`

Create `thread_subscriptions`:

- `thread_parent_id uuid references messages(id) on delete cascade`
- `subscriber_id uuid not null`
- `subscriber_type text check in ('human', 'agent')`
- `subscription_type text check in ('auto', 'manual', 'mention')`
- `muted boolean default false not null`
- `created_at timestamptz default now() not null`
- primary key: `(thread_parent_id, subscriber_id, subscriber_type)`

### Task fields

Extend `tasks`:

- `title text not null`
- `description text`
- `priority text check in ('critical', 'high', 'medium', 'low') default 'medium'`
- `tags text[] default '{}' not null`
- `due_at timestamptz`
- `started_at timestamptz`
- `completed_at timestamptz`
- `parent_task_id uuid references tasks(id) on delete set null`
- `source_thread_parent_id uuid references messages(id) on delete set null`
- `source_message_id uuid references messages(id) on delete set null`
- `created_by_id uuid`
- `created_by_type text check in ('human', 'agent', 'system')`
- `current_gate text` — e.g. `needs_spec`, `spec_review`, `ready_to_execute`, `executing`, `needs_verification`, `needs_review`, `review_passed`, `ready_for_completion`
- `review_policy jsonb default '{}'` — process requirements: spec_required, plan_required, tdd_required, review_types required, verification_required, completion_requires_user
- `reviewer_id uuid`
- `reviewer_type text check in ('human', 'agent')`
- `review_status text check in ('pending', 'approved', 'rejected', 'changes_requested')`
- `resolution_summary text`
- `archived_at timestamptz`

Task statuses:

- `todo`
- `in_progress`
- `blocked`
- `in_review`
- `changes_requested`
- `done`
- `archived`

### Task dependencies

Create `task_dependencies`:

- `predecessor_task_id uuid references tasks(id) on delete cascade`
- `successor_task_id uuid references tasks(id) on delete cascade`
- `dependency_type text check in ('blocks', 'related') default 'blocks'`
- `created_at timestamptz default now() not null`
- primary key: `(predecessor_task_id, successor_task_id)`

Rules:

- A task cannot depend on itself.
- Cycles should be prevented by application logic before insert.
- A task with unresolved blocking dependencies should be `blocked` or remain unclaimable.

### Task artifacts, comments, and audit

Create `task_comments`:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `author_id uuid not null`
- `author_type text check in ('human', 'agent', 'system') not null`
- `content text not null`
- `created_at timestamptz default now() not null`

Create `task_artifacts`:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `artifact_type text check in ('pr', 'commit', 'file', 'url', 'report', 'log', 'note', 'spec', 'plan', 'evidence') not null`
- `title text not null`
- `url text`
- `metadata jsonb default '{}' not null`
- `created_by_id uuid not null`
- `created_by_type text check in ('human', 'agent', 'system') not null`
- `created_at timestamptz default now() not null`

Create `task_events`:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `actor_id uuid not null`
- `actor_type text check in ('human', 'agent', 'system') not null`
- `event_type text not null`
- `from_state jsonb`
- `to_state jsonb`
- `reason text`
- `created_at timestamptz default now() not null`

Events include: `created`, `claimed`, `unclaimed`, `status_changed`, `priority_changed`, `dependency_added`, `dependency_removed`, `artifact_added`, `spec_created`, `plan_created`, `step_completed`, `verification_attached`, `review_requested`, `review_approved`, `review_rejected`, `completed`, `archived`.

### Task specs, plans, steps, and verification

Create `task_specs` — durable requirement documents attached to a task:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `title text not null`
- `content text not null` — structured markdown with goals, non-goals, constraints, acceptance criteria
- `status text check in ('draft', 'self_reviewed', 'needs_user_review', 'approved', 'changes_requested') default 'draft'`
- `approved_by uuid`
- `approved_by_type text check in ('human', 'agent')`
- `approved_at timestamptz`
- `created_by_id uuid not null`
- `created_by_type text check in ('human', 'agent', 'system') not null`
- `created_at timestamptz default now() not null`

Create `task_plans` — executable decompositions of a task into concrete steps:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `spec_id uuid references task_specs(id) on delete set null`
- `title text not null`
- `content text not null` — step-by-step plan with files, commands, expected outputs
- `status text check in ('draft', 'self_reviewed', 'needs_user_review', 'approved', 'changes_requested') default 'draft'`
- `approved_by uuid`
- `approved_by_type text check in ('human', 'agent')`
- `approved_at timestamptz`
- `created_by_id uuid not null`
- `created_by_type text check in ('human', 'agent', 'system') not null`
- `created_at timestamptz default now() not null`

Create `task_steps` — individual actionable units within a plan:

- `id uuid primary key default uuid_generate_v4()`
- `plan_id uuid references task_plans(id) on delete cascade not null`
- `task_id uuid references tasks(id) on delete cascade not null`
- `order_index integer not null`
- `description text not null`
- `target_files text[]` — files or resources this step touches
- `required_skill text` — optional skill/process tag for this step
- `verification_command text` — command/check that proves the step is done
- `expected_result text` — what success looks like
- `status text check in ('pending', 'in_progress', 'done', 'blocked', 'skipped') default 'pending'`
- `started_at timestamptz`
- `completed_at timestamptz`
- `assigned_to_id uuid`
- `assigned_to_type text check in ('human', 'agent')`
- `evidence_summary text`
- `created_at timestamptz default now() not null`

Create `task_verifications` — durable evidence that a task or step is actually complete:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `step_id uuid references task_steps(id) on delete set null`
- `actor_id uuid not null`
- `actor_type text check in ('human', 'agent', 'system') not null`
- `verification_type text not null` — e.g., test_pass, lint_pass, build_pass, manual_check, browser_verify, api_response
- `command_or_check text not null`
- `output_summary text`
- `passed boolean not null`
- `evidence_url text` — link to log, screenshot, or artifact
- `created_at timestamptz default now() not null`

### Task agent runs and context manifests

Create `task_agent_runs` — record of each agent execution attempt against a task:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `step_id uuid references task_steps(id) on delete set null`
- `agent_id uuid not null`
- `role text not null` — implementer, reviewer, researcher, qa, coordinator
- `prompt_snapshot text` — curated instructions given to this agent run
- `context_manifest jsonb` — list of files/artifacts included as context
- `status text check in ('dispatched', 'running', 'done_with_concerns', 'done', 'blocked', 'failed') default 'dispatched'`
- `output_summary text`
- `concerns text` — structured concerns if done_with_concerns
- `files_touched text[]`
- `started_at timestamptz`
- `completed_at timestamptz`
- `created_at timestamptz default now() not null`

Create `task_reviews` — typed review results from reviewer agents or humans:

- `id uuid primary key default uuid_generate_v4()`
- `task_id uuid references tasks(id) on delete cascade not null`
- `agent_run_id uuid references task_agent_runs(id) on delete set null`
- `reviewer_id uuid not null`
- `reviewer_type text check in ('human', 'agent') not null`
- `review_type text not null` — spec_compliance, quality, security, test, product, user_acceptance
- `findings jsonb` — array of {severity, category, location, recommendation, blocking}
- `verdict text check in ('pass', 'pass_with_concerns', 'fail', 'blocked') not null`
- `summary text not null`
- `created_at timestamptz default now() not null`

## API Design

### Thread APIs

- `GET /api/threads?channelId=...` — list active threads for a channel.
- `GET /api/threads/[messageId]` — get parent message, replies, participants, read state.
- `POST /api/threads/[messageId]/messages` — create a thread reply.
- `POST /api/threads/[messageId]/read` — mark thread read.
- `POST /api/threads/[messageId]/resolve` — resolve/unresolve thread.

### Task APIs

- `GET /api/tasks?serverId=...&channelId=...&status=...&assignee=...&tag=...`
- `POST /api/tasks` — create task from message/thread/manual input.
- `GET /api/tasks/[taskId]` — full task detail.
- `PATCH /api/tasks/[taskId]` — update title, description, priority, tags, assignee, reviewer, dates.
- `POST /api/tasks/[taskId]/claim`
- `POST /api/tasks/[taskId]/unclaim`
- `POST /api/tasks/[taskId]/transition` — guarded status transition.
- `POST /api/tasks/[taskId]/comments`
- `POST /api/tasks/[taskId]/artifacts`
- `POST /api/tasks/[taskId]/dependencies`
- `DELETE /api/tasks/[taskId]/dependencies/[dependencyId]`

Status transitions should go through a shared server-side transition helper so web UI and CLI follow the same rules. The helper must enforce the review policy: tasks without reviewer/review requirements can move from verified `in_progress` work to `done`; tasks with reviewer/review requirements must pass their configured review gates first.

## CLI Design

The `zano` CLI should expose comprehensive task and thread commands for agents.

### Thread commands

- `zano thread list --channel #general`
- `zano thread read --target #general:abcd1234`
- `zano thread reply --target #general:abcd1234`
- `zano thread resolve --target #general:abcd1234`
- `zano thread summarize --target #general:abcd1234`

Existing message target syntax `#channel:shortid` should remain valid.

### Task commands

Enhance existing task commands:

- `zano task list --channel #general --status todo --tag frontend`
- `zano task create --channel #general --title ... --priority high --tag frontend --parent 12`
- `zano task claim --number 12`
- `zano task unclaim --number 12`
- `zano task update --number 12 --status in_review --summary ...`
- `zano task comment --number 12`
- `zano task artifact add --number 12 --type pr --url ... --title ...`
- `zano task dependency add --number 12 --blocks 13`
- `zano task review --number 12 --approve`
- `zano task review --number 12 --changes-requested`

CLI output should remain machine-readable enough for agents to parse reliably.

## Web UI Design

### Message area thread affordances

Each top-level message should show:

- Reply count.
- Participant avatars or agent initials.
- Last reply timestamp.
- Resolved badge if applicable.
- Actions: Reply in thread, Create task, Copy link.

Thread replies should be available in a right-side panel. Inline expansion can be added, but the right panel is the primary design because it preserves the channel timeline.

### Thread panel

The thread panel includes:

- Parent message context.
- Ordered thread replies.
- Reply composer with @mention support.
- Participants/subscribers summary.
- Resolve/unresolve action.
- Create task from thread action.
- Link to associated task if one exists.

### Task board

Add a task workspace with multiple views:

- Board view: columns by status with drag-and-drop transitions.
- List view: sortable/filterable table.
- Detail drawer/page: full task state, comments, artifacts, dependencies, audit log, source context.

Dragging a card between columns calls the same guarded transition API as agent/CLI workflows. If a transition is blocked by dependencies, missing verification, or review policy, the UI should reject the drag and show the blocking reason.

Board columns:

- Todo
- Blocked
- In progress
- In review
- Changes requested
- Done
- Archived

Task cards show:

- Task number and title.
- Priority.
- Assignee/reviewer.
- Tags.
- Dependency/blocker indicators.
- Artifact count.
- Source channel/thread.
- Last activity.

### Navigation

Add a Tasks entry to the server sidebar. Channel pages should also expose channel-scoped task filtering, but the main task board is server-scoped.

### Notifications

Notifications should cover:

- @mentions in channel or thread.
- Thread replies to subscribed threads.
- Task assigned to user/agent.
- Task status changed.
- Review requested.
- Review changes requested.
- Blocking dependency resolved.

Initial UI can use in-app unread badges and notification records; browser push is not required for this spec.

## Agent Behavior

Update the bridge system prompt so agents treat tasks and threads as operating primitives. The Trellis pattern to adopt is role-specific execution with curated context: implementer agents receive the spec, plan, relevant source pointers, and step scope; reviewer agents receive the spec, plan, diff/output summaries, and review rubric; researcher agents receive the question and allowed sources. Agents should not rely on chat memory as the source of truth for task state.

### Thread behavior

Agents should create or use threads when:

- A message needs deep technical discussion.
- A review has specific feedback.
- A task execution needs iterative discussion.
- A decision needs multiple rounds.

Agents should avoid threads for:

- Simple acknowledgements.
- Short status updates.
- Final delivery summaries intended for the whole channel.

### Task behavior

Agents should create tasks when a message or thread contains actionable work. For complex work they should create a parent task and subtasks.

Agents should claim tasks when:

- The task matches their role or skill.
- The task is not blocked.
- The task is unassigned.

Agents should move tasks through transitions using CLI commands, not by directly modifying database state.

Reviewer agents should monitor `in_review` tasks and either approve or request changes with concrete feedback.

Coordinator-like agents may split work, assign reviewers, and summarize completion to channels.

## Realtime and Notifications

Enable Supabase Realtime for task-related tables:

- `tasks`
- `task_comments`
- `task_artifacts`
- `task_events`
- `thread_participants`
- `thread_subscriptions`

The web app should subscribe to relevant channel/server task changes and update board/thread UI without full page reloads.

A `notifications` table should store durable notification state:

- `id uuid primary key`
- `recipient_id uuid not null`
- `recipient_type text check in ('human', 'agent')`
- `type text not null`
- `channel_id uuid`
- `message_id uuid`
- `thread_parent_id uuid`
- `task_id uuid`
- `read_at timestamptz`
- `created_at timestamptz default now() not null`

Notification creation should happen in server-side helpers or database triggers for predictable behavior. Notifications are durable for both humans and agents so agents can poll/query assignment, review, blocker, and thread events through the CLI without relying only on realtime delivery.

## Permissions and RLS

Baseline access follows existing channel membership:

- Members can read threads and tasks in channels they can access.
- Members can create tasks in channels they can post to.
- Assignees, reviewers, channel admins, and task creators can update task metadata.
- Agents can act through the scoped auth context provided by the bridge.

The design should avoid service-role writes from client-side code. Trusted server routes and bridge/CLI flows may use scoped credentials as they do today.

## Testing and Verification

Add a focused automated test layer covering:

- Task status transition logic — which transitions are valid, which gates apply.
- Task dependency validation — cycle detection, blocking enforcement.
- API route request/response — core endpoints for threads, tasks, comments, transitions.
- CLI command parsing and output — task/thread commands produce correct output.

The test setup should use a lightweight framework compatible with the existing TypeScript/Vitest or Jest stack. Tests run via `pnpm test` as part of the CI-ready verification alongside `pnpm lint` and `pnpm build`.

At minimum, verification must include:

- `pnpm lint`
- `pnpm build`
- Manual browser verification of thread panel, task board, task detail, and realtime updates.
- Manual bridge/agent verification that an agent can create, claim, transition, comment, and complete a task via CLI.

## Rollout Order

Although the target is comprehensive, implementation should be sequenced to reduce merge risk:

1. Database schema and shared types.
2. Server-side APIs and transition helpers.
3. CLI support for full task/thread operations.
4. Web thread panel and message affordances.
5. Web task board and task detail UI.
6. Notifications and unread state.
7. Agent system prompt updates and autonomous workflows.
8. End-to-end verification with browser and bridge.

Each step should leave the repo buildable.

## Open Decisions

All initial open decisions have been confirmed:

1. Focused test setup: yes, for transitions/dependencies/APIs/CLI.
2. Drag-and-drop Kanban: yes, required from first implementation.
3. Notifications: durable for both humans and agents.
4. Review gate: only when task specifies reviewer/policy; simple tasks can go directly to done after verification.
