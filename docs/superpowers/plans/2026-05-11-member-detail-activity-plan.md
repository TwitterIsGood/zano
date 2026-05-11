# Member Detail + Full Persisted Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking an Agent or Human opens a member detail page in the main area with Profile / Activity / Workspace / Tasks tabs; Message switches that same page into a DM view; all Agent/Human activity is persisted in a central timeline.

**Architecture:** Add a Postgres `member_activity_events` append-only table plus trigger functions for durable events and explicit inserts for semantic app/bridge events. Add a member detail route at `/s/[slug]/member/[memberType]/[memberId]`; the route owns a local `detail | message` mode and renders `MessageArea` in message mode without navigating away. Extend sidebar data with Humans and member-aware highlighting.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase Postgres + Realtime, pnpm workspaces, Tailwind v4, existing shadcn/Base UI primitives.

---

## Constraints and Decisions

- Use this project's current UI style; do not copy the reference app's visual style.
- Show only sections backed by real data.
- Keep existing `/s/[slug]/dm/[channelId]` working, but member details use `/s/[slug]/member/[memberType]/[memberId]`.
- The Message button switches the member detail route into message mode; it does not navigate to `/dm`.
- Do not add a new test framework; this repo says automated tests are a separate decision. Use targeted manual verification plus `pnpm lint` and `pnpm build`.
- Use trusted server-side routes for service-role operations. Do not use service-role Supabase clients in client components.
- Do not ship placeholder tabs. The first UI task creates real Profile and Activity tabs; Workspace and Tasks appear only when their real implementations are available.

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/db/src/activity.sql` | Activity table, helper function, triggers, RLS, realtime publication |
| `packages/shared/src/index.ts` | Shared member/activity types |
| `apps/web/src/app/api/activity/route.ts` | Fetch member activity timeline |
| `apps/web/src/app/api/channels/dm/route.ts` | Human-to-human DM lookup/create |
| `apps/web/src/app/api/tasks/related/route.ts` | Fetch member-related tasks |
| `apps/web/src/app/api/sidebar/route.ts` | Add Humans to sidebar payload |
| `apps/web/src/app/s/[slug]/layout.tsx` | Add Humans to initial sidebar payload |
| `apps/web/src/components/sidebar.tsx` | Humans section, Agent/Human member routing, member highlight |
| `apps/web/src/app/s/[slug]/member/[memberType]/[memberId]/page.tsx` | Server-loaded member detail route |
| `apps/web/src/components/member-detail-page.tsx` | Client detail/message shell |
| `apps/web/src/components/member-profile-tab.tsx` | Profile tab |
| `apps/web/src/components/member-activity-tab.tsx` | Activity tab |
| `apps/web/src/hooks/use-member-activity.ts` | Activity fetch/realtime hook |
| `apps/web/src/components/member-workspace-tab.tsx` | Agent workspace tab |
| `apps/web/src/components/member-tasks-tab.tsx` | Tasks tab |
| `apps/bridge/src/agent-manager.ts` | Persist Agent runtime events |

---

## Task 1: Add persisted activity schema

**Files:**
- Create: `packages/db/src/activity.sql`

- [ ] **Step 1: Create `packages/db/src/activity.sql` with the activity table**

Use this schema:

```sql
create table if not exists public.member_activity_events (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid references public.servers(id) on delete cascade,
  channel_id uuid references public.channels(id) on delete set null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system', 'bridge')),
  event_type text not null,
  subject_type text,
  subject_id uuid,
  target_id uuid,
  target_type text,
  message_id uuid references public.messages(id) on delete set null,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  label text,
  summary text,
  metadata jsonb not null default '{}',
  visibility text not null default 'server' check (visibility in ('public', 'server', 'channel', 'dm', 'private')),
  dedupe_key text unique,
  occurred_at timestamptz not null default now(),
  created_at timestamptz default now() not null
);
```

- [ ] **Step 2: Add indexes**

Add these indexes:

```sql
create index if not exists idx_member_activity_server_time on public.member_activity_events(server_id, occurred_at desc);
create index if not exists idx_member_activity_actor_time on public.member_activity_events(actor_type, actor_id, occurred_at desc);
create index if not exists idx_member_activity_channel_time on public.member_activity_events(channel_id, occurred_at desc);
create index if not exists idx_member_activity_task_time on public.member_activity_events(task_id, occurred_at desc);
create index if not exists idx_member_activity_agent_time on public.member_activity_events(agent_id, occurred_at desc);
create index if not exists idx_member_activity_event_time on public.member_activity_events(event_type, occurred_at desc);
```

- [ ] **Step 3: Add RLS select policies**

Enable RLS and add select policies with these rules:

```sql
alter table public.member_activity_events enable row level security;

drop policy if exists "Server members can read server activity" on public.member_activity_events;
create policy "Server members can read server activity"
  on public.member_activity_events for select
  using (
    visibility in ('server', 'public')
    and exists (
      select 1
      from public.server_members sm
      where sm.server_id = member_activity_events.server_id
        and sm.member_type = 'human'
        and sm.member_id = auth.uid()
    )
  );

drop policy if exists "Channel members can read channel activity" on public.member_activity_events;
create policy "Channel members can read channel activity"
  on public.member_activity_events for select
  using (
    visibility in ('channel', 'dm')
    and exists (
      select 1
      from public.channel_members cm
      where cm.channel_id = member_activity_events.channel_id
        and cm.member_type = 'human'
        and cm.member_id = auth.uid()
    )
  );

drop policy if exists "Humans can read their own activity" on public.member_activity_events;
create policy "Humans can read their own activity"
  on public.member_activity_events for select
  using (actor_type = 'human' and actor_id = auth.uid());
```

Do not add client insert/update/delete policies.

- [ ] **Step 4: Add `record_member_activity(...)` helper**

Create a `security definer` function that accepts one `jsonb` payload to avoid fragile long positional argument lists:

```sql
create or replace function public.record_member_activity(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.member_activity_events (
    server_id,
    channel_id,
    actor_id,
    actor_type,
    event_type,
    subject_type,
    subject_id,
    target_id,
    target_type,
    message_id,
    thread_parent_id,
    task_id,
    agent_id,
    label,
    summary,
    metadata,
    visibility,
    dedupe_key,
    occurred_at
  ) values (
    nullif(payload->>'server_id', '')::uuid,
    nullif(payload->>'channel_id', '')::uuid,
    (payload->>'actor_id')::uuid,
    payload->>'actor_type',
    payload->>'event_type',
    payload->>'subject_type',
    nullif(payload->>'subject_id', '')::uuid,
    nullif(payload->>'target_id', '')::uuid,
    payload->>'target_type',
    nullif(payload->>'message_id', '')::uuid,
    nullif(payload->>'thread_parent_id', '')::uuid,
    nullif(payload->>'task_id', '')::uuid,
    nullif(payload->>'agent_id', '')::uuid,
    payload->>'label',
    payload->>'summary',
    coalesce(payload->'metadata', '{}'::jsonb),
    coalesce(payload->>'visibility', 'server'),
    payload->>'dedupe_key',
    coalesce(nullif(payload->>'occurred_at', '')::timestamptz, now())
  )
  on conflict (dedupe_key) do nothing;
end;
$$;
```

- [ ] **Step 5: Add message triggers**

Create `public.record_message_activity()` and attach it to `messages insert` and `messages update of thread_resolved_at`.

Required behavior:

- On insert with no thread parent: `event_type='message.sent'`, `subject_type='message'`, `subject_id=NEW.id`, `message_id=NEW.id`.
- On insert with a thread parent: `event_type='thread.replied'`, `subject_type='thread'`, `subject_id=NEW.thread_parent_id`, `message_id=NEW.id`, `thread_parent_id=NEW.thread_parent_id`.
- On thread resolution update from null to non-null: `event_type='thread.resolved'`, `thread_parent_id=NEW.id`.
- On thread resolution update from non-null to null: `event_type='thread.reopened'`, `thread_parent_id=NEW.id`.
- Actor fields come from the message sender columns in the current schema.
- Server/channel context comes from the message channel.
- Metadata includes channel type and thread fields.
- Visibility is `dm` for DM channels and `channel` for channel messages.
- Dedupe keys use stable source IDs, e.g. `message:<message-id>:sent`, `thread:<message-id>:resolved:<timestamp>`.

- [ ] **Step 6: Add membership triggers**

Create trigger functions and attach them to:

- `channel_members insert` → `event_type='channel.joined'`, actor is the joining member, subject is the channel, visibility is `channel` or `dm` from the joined channel.
- `server_members insert` → `event_type='server.joined'`, actor is the joining member, subject is the server, visibility is `server`.

- [ ] **Step 7: Add task history triggers**

Create trigger functions and attach them to:

- `task_comments insert` → `task.commented`.
- `task_artifacts insert` → `task.artifact_added`.
- `task_reviews insert` → `task.reviewed`.
- `task_verifications insert` → `task.verified`.

Each trigger must fetch the related task's `server_id` and `channel_id`, set `task_id`, set the actor from the source row's author/reviewer/verifier column, and derive visibility from the task channel: `dm` for DM channels and `channel` otherwise.

- [ ] **Step 8: Add Agent status trigger**

Create an `agents update of status` trigger that records `agent.status_changed` when `OLD.status is distinct from NEW.status`.

Use:

- actor: the Agent itself (`actor_type='agent'`, `actor_id=NEW.id`).
- `agent_id=NEW.id`.
- summary: `OLD.status || ' → ' || NEW.status`.
- visibility: `server`.

- [ ] **Step 9: Add realtime publication**

Add `member_activity_events` to `supabase_realtime`, with duplicate-object protection:

```sql
do $$
begin
  alter publication supabase_realtime add table public.member_activity_events;
exception
  when duplicate_object then null;
end $$;
```

- [ ] **Step 10: Apply SQL in Supabase**

Use the logged-in Edge/CDP Supabase SQL editor or approved Supabase tooling.

Verify:

```sql
select count(*) from public.member_activity_events;
select tgname, tgrelid::regclass from pg_trigger where tgname like 'trg_activity_%' order by tgname;
```

Expected: table exists; triggers exist for all trigger sources above.

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/activity.sql
git commit -m "feat(db): add persisted member activity feed"
```

---

## Task 2: Add shared activity types

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add shared types**

Add:

```ts
export type MemberType = "human" | "agent";
export type MemberActivityActorType = "human" | "agent" | "system" | "bridge";

export type MemberActivityEventType =
  | "message.sent"
  | "thread.replied"
  | "thread.resolved"
  | "thread.reopened"
  | "channel.joined"
  | "server.joined"
  | "task.created"
  | "task.claimed"
  | "task.unclaimed"
  | "task.status_changed"
  | "task.updated"
  | "task.commented"
  | "task.artifact_added"
  | "task.reviewed"
  | "task.verified"
  | "agent.started"
  | "agent.received_message"
  | "agent.thinking"
  | "agent.working"
  | "agent.tool_use"
  | "agent.output"
  | "agent.idle"
  | "agent.error"
  | "agent.disconnected"
  | "agent.status_changed"
  | "agent.created"
  | "agent.updated"
  | "agent.reset"
  | "agent.deleted"
  | "human.profile_updated";

export interface MemberActivityEvent {
  id: string;
  server_id: string | null;
  channel_id: string | null;
  actor_id: string;
  actor_type: MemberActivityActorType;
  event_type: MemberActivityEventType;
  subject_type: string | null;
  subject_id: string | null;
  target_id: string | null;
  target_type: string | null;
  message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  label: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  visibility: "public" | "server" | "channel" | "dm" | "private";
  dedupe_key: string | null;
  occurred_at: string;
  created_at: string;
}

export interface HumanMember {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role?: string | null;
  joined_at?: string | null;
  created_at: string | null;
}
```

- [ ] **Step 2: Verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add member activity types"
```

---

## Task 3: Add server APIs for activity, related tasks, and human DM

**Files:**
- Create: `apps/web/src/app/api/activity/route.ts`
- Create: `apps/web/src/app/api/tasks/related/route.ts`
- Create: `apps/web/src/app/api/channels/dm/route.ts`

- [ ] **Step 1: Create activity endpoint**

Implement `GET /api/activity?server_id=&actor_type=&actor_id=&limit=`.

Behavior:

- Authenticate current user with the same pattern used by existing app API routes.
- Validate `actor_type` is `human` or `agent`.
- Verify current user is a human member of `server_id`.
- Use the server-side admin client to read `member_activity_events`.
- Return latest events matching `server_id`, `actor_type`, `actor_id`, ordered by `occurred_at desc`.
- Clamp `limit` to `1..100`, default `50`.
- Response shape: `{ events }`.

- [ ] **Step 2: Create related tasks endpoint**

Implement `GET /api/tasks/related?server_id=&member_type=&member_id=`.

Behavior:

- Authenticate current user.
- Validate `member_type` is `human` or `agent`.
- Verify current user is a human member of `server_id`.
- Collect task IDs from all real sources that exist in this schema:
  - `tasks` where assignee matches the member.
  - `tasks` where creator matches the member.
  - `task_events` where actor matches the member.
  - `task_comments` where author matches the member.
  - `task_artifacts` where creator/uploader matches the member.
  - `task_reviews` where reviewer matches the member.
  - `task_verifications` where verifier/actor matches the member.
- Fetch unique tasks by ID, ordered by `updated_at desc`.
- Response shape: `{ tasks }`.

- [ ] **Step 3: Create human DM endpoint**

Implement `POST /api/channels/dm` with body:

```ts
{
  server_id: string;
  target_user_id: string;
}
```

Behavior:

- Authenticate current user.
- Reject self-DM with status `400` and `{ error: "You can't message yourself" }`.
- Verify both current user and target are human members of the server.
- Find an existing `type='dm'` channel in the same server where both humans are members.
- If found, return `{ channel, created: false }` where `channel` has the fields accepted by `MessageArea`.
- If not found, create a DM channel, insert both `channel_members`, and return `{ channel, created: true }`.
- Do not create a DM when either user is not a server member.

- [ ] **Step 4: Verify APIs compile**

```bash
pnpm --filter @zano/web lint
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/activity/route.ts apps/web/src/app/api/tasks/related/route.ts apps/web/src/app/api/channels/dm/route.ts
git commit -m "feat(api): add member activity, related tasks, and human DM endpoints"
```

---

## Task 4: Record semantic activity in existing API routes

**Files:**
- Modify: `apps/web/src/app/api/tasks/route.ts`
- Modify: `apps/web/src/app/api/tasks/[taskId]/route.ts`
- Modify: `apps/web/src/app/api/tasks/[taskId]/claim/route.ts`
- Modify: `apps/web/src/app/api/tasks/[taskId]/unclaim/route.ts`
- Modify: `apps/web/src/app/api/tasks/[taskId]/transition/route.ts`
- Modify: `apps/web/src/app/api/agents/route.ts`
- Modify: `apps/web/src/app/api/agents/[id]/route.ts`
- Modify: `apps/web/src/app/api/agents/[id]/reset/route.ts`

- [ ] **Step 1: Add explicit inserts after successful writes**

Record only after the primary operation succeeds. Use the route's existing authenticated user and admin client.

Mapping:

| Route | Event |
|-------|-------|
| `POST /api/tasks` | `task.created` |
| `PATCH /api/tasks/[taskId]` | `task.updated` with `metadata.changed_fields` |
| `POST /api/tasks/[taskId]/claim` | `task.claimed` |
| `POST /api/tasks/[taskId]/unclaim` | `task.unclaimed` |
| `POST /api/tasks/[taskId]/transition` | `task.status_changed` |
| `POST /api/agents` | `agent.created` |
| `PUT /api/agents/[id]` | `agent.updated` |
| `DELETE /api/agents/[id]` | `agent.deleted` |
| `POST /api/agents/[id]/reset` | `agent.reset` |

- [ ] **Step 2: Use consistent insert shape**

Use the available source IDs in each route. Fetch task or agent context after the primary write when the route needs `server_id`, title/name, or the previous status.

```ts
await admin.from("member_activity_events").insert({
  server_id,
  actor_id: user.id,
  actor_type: "human",
  event_type,
  subject_type,
  subject_id,
  target_type,
  target_id,
  task_id,
  agent_id,
  label,
  summary,
  metadata,
  visibility: "server",
  dedupe_key,
});
```

Required dedupe key examples:

- `task:<taskId>:created`
- `task:<taskId>:claimed:<userId>:<timestamp-or-event-id>`
- `task:<taskId>:status:<newStatus>:<timestamp-or-event-id>`
- `agent:<agentId>:created`
- `agent:<agentId>:reset:<timestamp-or-event-id>`

- [ ] **Step 3: Keep activity failures non-blocking**

If an activity insert fails, log it server-side and still return success for the primary operation. Do not hide primary operation errors.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @zano/web lint
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/tasks/route.ts apps/web/src/app/api/tasks/[taskId]/route.ts apps/web/src/app/api/tasks/[taskId]/claim/route.ts apps/web/src/app/api/tasks/[taskId]/unclaim/route.ts apps/web/src/app/api/tasks/[taskId]/transition/route.ts apps/web/src/app/api/agents/route.ts apps/web/src/app/api/agents/[id]/route.ts apps/web/src/app/api/agents/[id]/reset/route.ts
git commit -m "feat(api): record activity for task and agent lifecycle actions"
```

---

## Task 5: Persist Agent runtime activity from bridge

**Files:**
- Modify: `apps/bridge/src/agent-manager.ts`

- [ ] **Step 1: Add a helper that accepts explicit event type**

Add a helper method to `AgentManager`:

```ts
private lastPersistedActivity = new Map<string, string>();

private async persistActivityEvent(
  agentId: string,
  eventType: string,
  label: string,
  summary: string
) {
  const key = `${agentId}:${eventType}:${label}:${summary}`;
  if (this.lastPersistedActivity.get(agentId) === key) return;

  const agentProc = this.processes.get(agentId);
  if (!agentProc?.config.serverId) return;

  try {
    await this.supabase.from("member_activity_events").insert({
      server_id: agentProc.config.serverId,
      actor_id: agentId,
      actor_type: "agent",
      event_type: eventType,
      label,
      summary: summary ? summary.slice(0, 500) : null,
      metadata: { runtime: "claude-code" },
      visibility: "server",
      agent_id: agentId,
    });
    this.lastPersistedActivity.set(agentId, key);
  } catch (error) {
    console.warn("[AgentManager] Failed to persist activity", error);
  }
}
```

- [ ] **Step 2: Persist broadcast activity with correct event mapping**

At the end of `broadcastActivity(agentId, activity, label, detail)` call:

```ts
const eventType = activity === "working" && label && label !== "Working"
  ? "agent.tool_use"
  : `agent.${activity}`;
void this.persistActivityEvent(agentId, eventType, label || activity, detail || "");
```

Do not persist heartbeat rebroadcasts as separate rows. The helper dedupes consecutive identical events; keep the existing live broadcast behavior unchanged.

- [ ] **Step 3: Persist explicit lifecycle events**

At the existing places where these occur, call `persistActivityEvent` with explicit event types:

- Agent spawned/started → `agent.started`.
- Human message delivered to agent → `agent.received_message`.
- Pending assistant text flushed → `agent.output`.
- Process error → `agent.error`.
- Process close/disconnect → `agent.disconnected`.

Do not map `Started` to `agent.tool_use` or `Disconnected` to `agent.idle`.

- [ ] **Step 4: Verify bridge build**

```bash
pnpm --filter @zano/bridge build
```

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/agent-manager.ts
git commit -m "feat(bridge): persist agent runtime activity"
```

---

## Task 6: Add Humans to sidebar and member navigation

**Files:**
- Modify: `apps/web/src/app/api/sidebar/route.ts`
- Modify: `apps/web/src/app/s/[slug]/layout.tsx`
- Modify: `apps/web/src/components/sidebar.tsx`

- [ ] **Step 1: Extend `SidebarInitialData`**

Add `HumanMember` and `humans: HumanMember[]` to the sidebar data type. Keep existing `dmMembers` for Agent DMs.

- [ ] **Step 2: Query humans in layout and sidebar API**

Query `server_members` for `member_type='human'`, join `profiles`, and map to:

```ts
{
  id: member_id,
  display_name,
  email,
  avatar_url,
  role,
  joined_at,
  created_at,
}
```

Use the exact profile/server membership column names from the current schema.

- [ ] **Step 3: Add Humans section**

In `sidebar.tsx`, add a Humans section after Agents and before Channels. Clicking a human navigates to:

```ts
/s/${serverSlug}/member/human/${human.id}
```

- [ ] **Step 4: Change Agent click target**

Agent rows navigate to:

```ts
/s/${serverSlug}/member/agent/${agent.id}
```

Do not remove DM channels from the data model; Agent Message still resolves the existing Agent DM later.

- [ ] **Step 5: Highlight selected member**

Use `useParams()` values:

- Agent row active when `params.memberType === 'agent' && params.memberId === agent.id`, or when current route is `/dm/[channelId]` for that Agent's DM.
- Human row active when `params.memberType === 'human' && params.memberId === human.id`.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @zano/web lint
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/api/sidebar/route.ts apps/web/src/app/s/[slug]/layout.tsx apps/web/src/components/sidebar.tsx
git commit -m "feat(sidebar): add Humans section and member detail navigation"
```

---

## Task 7: Create member detail route with real Profile and Activity tabs

**Files:**
- Create: `apps/web/src/app/s/[slug]/member/[memberType]/[memberId]/page.tsx`
- Create: `apps/web/src/components/member-detail-page.tsx`
- Create: `apps/web/src/components/member-profile-tab.tsx`
- Create: `apps/web/src/components/member-activity-tab.tsx`
- Create: `apps/web/src/hooks/use-member-activity.ts`

- [ ] **Step 1: Create server route**

The route must:

- Authenticate current user.
- Load server by slug.
- Verify current user is a human server member.
- Validate `memberType` as `agent` or `human`.
- For Agent: load the Agent by `id + server_id`.
- For Human: load the profile by ID and verify the Human is in the same server.
- Load any available creator/profile and membership fields needed by Profile.
- Pass `serverId`, `serverSlug`, `memberType`, `memberId`, `member`, `currentUserId`, and optional membership/profile context into `MemberDetailPage`.
- Return a compact not-found state if member is missing.

- [ ] **Step 2: Create `useMemberActivity`**

The hook must:

- Fetch `/api/activity?server_id=&actor_type=&actor_id=`, with actor type equal to selected member type.
- Return `{ events, loading, error, reload }`.
- Subscribe to `member_activity_events` realtime inserts filtered by `actor_id`, then client-filter by `server_id` and `actor_type` before prepending to local state.
- Clean up the Supabase channel on unmount.

- [ ] **Step 3: Implement `MemberProfileTab`**

Show only existing fields.

Agent fields:

- Display name.
- Handle/name.
- Description.
- Status.
- Live activity via `useAgentActivity()`.
- Model, if present.
- Created date.
- Creator/owner, using loaded profile when available; otherwise omit instead of showing a raw orphan ID unless the schema has no profile relation.
- Runtime as `Claude Code` only if the current Agent data is backed by the bridge/Claude Code runtime.
- Workspace/computer/daemon/environment variables only if real fields exist in the loaded data.

Human fields:

- Display name.
- Email.
- Created date.
- Current-user marker.
- Server membership role and joined date if loaded.

- [ ] **Step 4: Implement `MemberActivityTab`**

Render:

- Agent live activity banner at top using `useAgentActivity()`.
- Empty state `No activity yet`.
- Error state with Retry.
- Timeline rows/cards with time, event label/title, and summary.
- Source affordances when IDs exist:
  - `task_id` → open the existing `TaskDetailDrawer` by fetching the task summary for that ID.
  - `message_id` / `thread_parent_id` / `channel_id` → link to `/s/${serverSlug}/channel/${channelId}` or `/s/${serverSlug}/dm/${channelId}` based on event metadata channel type.

Use event-type labels instead of raw event strings for the visible title.

- [ ] **Step 5: Create client shell**

`MemberDetailPage` must:

- Keep `activeTab` state.
- Keep `mode: 'detail' | 'message'` state.
- Keep `messageChannel` state.
- Render header with avatar, display name, handle, member type/status badges, and Message button.
- Render tabs: Profile and Activity initially. Do not show Workspace or Tasks until Tasks 8 and 9 add real implementations.
- Render `MessageArea` and a `Back to profile` button in message mode.
- For Human self, disable Message and show `You can't message yourself`.
- For Human other, call `POST /api/channels/dm` and set `messageChannel` from the returned channel.
- For Agent, call `/api/sidebar?server_id=...`, find the existing Agent DM channel from `channels + dmMembers`, and set `messageChannel`.
- Show a user-visible error if DM lookup/creation fails and stay in detail mode.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @zano/web lint
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/s/[slug]/member/[memberType]/[memberId]/page.tsx apps/web/src/components/member-detail-page.tsx apps/web/src/components/member-profile-tab.tsx apps/web/src/components/member-activity-tab.tsx apps/web/src/hooks/use-member-activity.ts
git commit -m "feat(ui): add member detail Profile and Activity views"
```

---

## Task 8: Implement Agent Workspace tab

**Files:**
- Create: `apps/web/src/components/member-workspace-tab.tsx`
- Modify: `apps/web/src/components/member-detail-page.tsx`

- [ ] **Step 1: Reuse existing workspace API**

Fetch `/api/agents/${agentId}/workspace` only for Agents.

- [ ] **Step 2: Render workspace browser**

Render:

- Loading state.
- Error state with Retry.
- Workspace path when available.
- File list when available.
- File preview when a file has content.
- Empty state if there are no files.

Use the existing workspace browser behavior in `apps/web/src/components/agent-settings-panel.tsx` as the behavioral reference, but adapt it to full-width page layout.

- [ ] **Step 3: Add tab conditionally**

Add Workspace to `MemberDetailPage` tabs only for Agents. Do not render Workspace for Humans.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @zano/web lint
git add apps/web/src/components/member-workspace-tab.tsx apps/web/src/components/member-detail-page.tsx
git commit -m "feat(ui): render Agent Workspace tab"
```

---

## Task 9: Implement member Tasks tab

**Files:**
- Create: `apps/web/src/components/member-tasks-tab.tsx`
- Modify: `apps/web/src/components/member-detail-page.tsx`

- [ ] **Step 1: Fetch related tasks**

Call `/api/tasks/related?server_id=&member_type=&member_id=`.

- [ ] **Step 2: Render task list**

Render:

- Loading state.
- Error state with Retry.
- Empty state `No related tasks`.
- List rows with title, status, priority, current gate if present, updated date.
- Clicking a row opens the existing task detail drawer.

- [ ] **Step 3: Add tab conditionally**

Add Tasks tab when the related tasks endpoint can be queried. It may show `No related tasks` because that is real data, not a fake section.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @zano/web lint
git add apps/web/src/components/member-tasks-tab.tsx apps/web/src/components/member-detail-page.tsx
git commit -m "feat(ui): render member Tasks tab"
```

---

## Task 10: Apply database schema and verify activity recording

**Files:**
- No source file changes unless SQL needs correction after applying.

- [ ] **Step 1: Apply SQL**

Apply `packages/db/src/activity.sql` through the logged-in Supabase SQL editor or approved Supabase tooling.

- [ ] **Step 2: Verify trigger-created events**

In the app, perform:

- Send a channel message.
- Send a DM message.
- Reply in a thread.
- Resolve/reopen a thread.
- Add a task comment/artifact/review/verification where existing UI supports it.

Then query:

```sql
select event_type, actor_type, label, summary, occurred_at
from public.member_activity_events
order by occurred_at desc
limit 20;
```

Expected: corresponding rows exist with correct actor, server, channel/task/message IDs.

- [ ] **Step 3: Verify explicit app events**

Perform:

- Create a task.
- Claim/unclaim a task.
- Change task status.
- Create/update/reset/delete an Agent where existing UI supports it.

Expected: corresponding `task.*` and `agent.*` rows exist.

- [ ] **Step 4: Verify bridge runtime events**

Run the bridge, message an Agent, and cause it to think/work/use a tool/output text.

Expected: `agent.started`, `agent.received_message`, `agent.thinking`, `agent.tool_use` or `agent.working`, `agent.output`, and idle/disconnect/error rows appear as appropriate without heartbeat spam.

---

## Task 11: Final UI verification

- [ ] **Step 1: Static verification**

```bash
pnpm lint
pnpm build
```

- [ ] **Step 2: Start local app**

```bash
pnpm dev:web
pnpm dev:bridge
```

- [ ] **Step 3: Browser checklist**

- Sidebar shows Agents and Humans.
- Clicking Agent opens `/s/[slug]/member/agent/[agentId]`.
- Clicking Human opens `/s/[slug]/member/human/[humanId]`.
- Agent/Human detail uses project UI style.
- Profile tab shows only real fields.
- Activity tab shows live Agent activity plus persisted timeline.
- Message on Agent switches same detail route into `MessageArea`.
- Message on another Human creates/finds DM and switches same detail route into `MessageArea`.
- Message on self is disabled and explains why.
- Back to profile returns to detail tabs.
- Agent row remains highlighted in detail and message modes.
- Human row remains highlighted in detail mode.
- Activity shows persisted message events.
- Activity shows persisted task events.
- Activity shows persisted Agent runtime events after bridge activity.
- Workspace appears for Agents only and loads via existing workspace API.
- Workspace is not shown for Humans.
- Tasks tab shows related tasks or `No related tasks`.
- No empty fake sections are shown.

- [ ] **Step 4: Commit polish if needed**

```bash
git add <changed-files>
git commit -m "fix: polish member detail activity integration"
```
