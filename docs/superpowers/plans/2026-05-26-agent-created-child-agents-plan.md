# Agent-Created Child Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent Agent directly create a full child Agent for large separable work, without human confirmation, while preserving ordinary Agent behavior, provenance, hierarchy, auditability, and guardrails.

**Architecture:** Child Agents are first-class rows in `agents`, not hidden workers. A DB RPC is the atomic source of truth for Agent-originated child creation; the CLI calls that RPC, Omni launches the resulting Agent like any other Agent, and the web UI renders parent/child hierarchy and provenance.

**Tech Stack:** Supabase Postgres SQL/RLS/RPC, TypeScript, Next.js 16, Supabase Realtime, pnpm workspaces, Vitest for CLI/bridge tests, browser verification for UI.

---

## Non-negotiable Scope Boundaries

- Child Agents are ordinary full Agents: own profile, DM, workspace, memory, runtime session, task/channel participation, activity events.
- No hidden subprocess-only children.
- No Slock-style human confirmation card. Parent Agents create directly through guarded RPC/CLI.
- Creation must be visible and auditable: creator, parent, reason, context, policy result, created Agent, created DM.
- `owner_id` remains the human/bridge owner responsible for runtime credentials; `parent_agent_id` records hierarchy.
- The first implementation must include depth/count/rate/idempotency guardrails; do not defer them.
- Do not commit unless the user explicitly asks. Commit commands below are checkpoints only for later manual use.

## File Responsibility Map

### Database

- `packages/db/src/schema.sql` — canonical schema for `agents`, `channels`, indexes, and helper constraints.
- `packages/db/src/autonomous.sql` — Agent-originated policy/RPC layer and spawn/activity event conventions.
- `packages/db/src/schema.ts` — exported schema string if the codegen source mirrors `schema.sql`.
- `packages/db/src/index.ts` — export any new schema string if a new SQL file is introduced.

### Shared Types

- `packages/shared/src/index.ts` — shared `Agent` fields and activity event metadata types.
- `packages/shared/src/autonomous.ts` — child-agent policy/result types if reusing autonomous area.

### CLI

- `packages/cli/src/index.ts` — add `zano agent create` command and help text.
- `packages/cli/src/agent-create.ts` — recommended new focused parser/payload helper for testability.
- `packages/cli/src/agent-create.test.ts` — tests for payload construction and validation.

### Bridge

- `apps/omni/src/bridge.ts` — verify new child Agents are discovered, token-refreshed, and initialized without daemon restart.
- `apps/omni/src/agent-manager.ts` — verify archived Agents do not start and child runtime prompt includes provenance context.
- `apps/omni/src/system-prompt.ts` — teach parent Agents when/how to create/supervise child Agents.
- `apps/omni/src/a2a-protocol.test.ts` and `apps/omni/src/runtime/prompt-materializer.test.ts` — prompt regression coverage.

### Web

- `apps/web/src/app/api/agents/route.ts` — human-created Agent provenance defaults.
- `apps/web/src/app/api/agents/[id]/route.ts` — Agent detail returns provenance/lineage and supports archive/pause management if already in scope.
- `apps/web/src/app/api/sidebar/route.ts` — return hierarchy fields for sidebar tree rendering.
- `apps/web/src/components/sidebar.tsx` — render nested child Agents under parents with Zano design tokens.
- `apps/web/src/components/agent-settings-panel.tsx` — show provenance and management controls.
- `apps/web/src/components/member-detail-page.tsx` and/or `apps/web/src/components/member-workspace-tab.tsx` — show provenance where Agent profile/workspace appears.
- `apps/web/src/components/member-activity-tab.tsx` — render child creation/denial activity labels.

---

## Task 1: Add Child-Agent Schema Fields

**Files:**
- Modify: `packages/db/src/schema.sql:41-52`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/shared/src/index.ts:78-89`

- [ ] **Step 1: Write schema expectations in a focused SQL verification script**

Create or extend a verification query in `packages/db/scripts/verify-child-agent-schema.mjs` only if the repo already uses script-based verification for local schema checks. If no DB URL is configured, this script should fail clearly with `SUPABASE_DB_URL is required`.

```js
import { Client } from "pg";

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is required");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(`
  select column_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'agents'
    and column_name in (
      'created_by_id',
      'created_by_type',
      'parent_agent_id',
      'root_agent_id',
      'creation_source',
      'creation_reason',
      'creation_context',
      'provenance',
      'generation',
      'archived_at'
    )
  order by column_name
`);

const found = new Set(rows.map((row) => row.column_name));
const required = [
  'archived_at',
  'created_by_id',
  'created_by_type',
  'creation_context',
  'creation_reason',
  'creation_source',
  'generation',
  'parent_agent_id',
  'provenance',
  'root_agent_id',
];

const missing = required.filter((name) => !found.has(name));
if (missing.length > 0) {
  console.error(`Missing child-agent columns: ${missing.join(', ')}`);
  process.exit(1);
}

await client.end();
```

Run: `node packages/db/scripts/verify-child-agent-schema.mjs`
Expected before implementation: fails with missing columns or `SUPABASE_DB_URL is required` if no local DB is configured.

- [ ] **Step 2: Extend the `agents` table**

Modify `packages/db/src/schema.sql` so `public.agents` includes these fields:

```sql
create table public.agents (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  display_name text not null,
  description text,
  system_prompt text,
  status text default 'offline' check (status in ('online', 'sleeping', 'offline')),
  owner_id uuid references public.profiles(id) on delete cascade not null,
  server_id uuid references public.servers(id) on delete cascade not null,
  created_by_id uuid,
  created_by_type text not null default 'human' check (created_by_type in ('human', 'agent', 'system')),
  parent_agent_id uuid references public.agents(id) on delete set null,
  root_agent_id uuid references public.agents(id) on delete set null,
  creation_source text not null default 'human' check (creation_source in ('human', 'agent', 'blueprint', 'system', 'migration')),
  creation_reason text,
  creation_context jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  generation integer not null default 0 check (generation >= 0),
  archived_at timestamptz,
  created_at timestamptz default now() not null,
  unique(server_id, name)
);
```

Add indexes after the table:

```sql
create index if not exists idx_agents_server_parent_created
  on public.agents(server_id, parent_agent_id, created_at);

create index if not exists idx_agents_server_root
  on public.agents(server_id, root_agent_id);

create index if not exists idx_agents_server_creator
  on public.agents(server_id, created_by_id, created_by_type);

create index if not exists idx_agents_server_archived
  on public.agents(server_id, archived_at);
```

- [ ] **Step 3: Add same-server parent/root constraint trigger**

Add this function after `public.agents` table definitions in `packages/db/src/schema.sql`:

```sql
create or replace function public.ensure_agent_lineage_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_record public.agents%rowtype;
begin
  if new.parent_agent_id is null then
    new.generation := 0;
    new.root_agent_id := coalesce(new.root_agent_id, new.id);
    return new;
  end if;

  if new.parent_agent_id = new.id then
    raise exception 'agent cannot be its own parent';
  end if;

  select * into parent_record
  from public.agents
  where id = new.parent_agent_id;

  if parent_record.id is null then
    raise exception 'parent agent does not exist';
  end if;

  if parent_record.server_id <> new.server_id then
    raise exception 'parent agent must be in the same server';
  end if;

  if parent_record.archived_at is not null then
    raise exception 'parent agent is archived';
  end if;

  new.generation := parent_record.generation + 1;
  new.root_agent_id := coalesce(parent_record.root_agent_id, parent_record.id);

  if new.generation > 2 then
    raise exception 'child agent generation limit exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_agents_lineage_integrity on public.agents;
create trigger trg_agents_lineage_integrity
before insert or update of parent_agent_id, server_id, archived_at on public.agents
for each row execute function public.ensure_agent_lineage_integrity();
```

- [ ] **Step 4: Backfill existing Agents**

Add migration-safe backfill SQL below the new columns/indexes:

```sql
update public.agents
set
  created_by_id = coalesce(created_by_id, owner_id),
  created_by_type = coalesce(created_by_type, 'human'),
  creation_source = coalesce(creation_source, 'human'),
  creation_context = coalesce(creation_context, '{}'::jsonb),
  provenance = coalesce(provenance, '{}'::jsonb),
  generation = coalesce(generation, 0),
  root_agent_id = coalesce(root_agent_id, id)
where created_by_id is null
   or root_agent_id is null;
```

- [ ] **Step 5: Update shared `Agent` type**

Modify `packages/shared/src/index.ts`:

```ts
export type AgentCreatorType = "human" | "agent" | "system";
export type AgentCreationSource = "human" | "agent" | "blueprint" | "system" | "migration";

export interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: AgentModel;
  status: AgentStatus;
  owner_id: string;
  server_id: string;
  created_by_id: string | null;
  created_by_type: AgentCreatorType;
  parent_agent_id: string | null;
  root_agent_id: string | null;
  creation_source: AgentCreationSource;
  creation_reason: string | null;
  creation_context: Record<string, unknown>;
  provenance: Record<string, unknown>;
  generation: number;
  archived_at: string | null;
  created_at: string;
}
```

- [ ] **Step 6: Type-check shared/db packages**

Run: `pnpm --filter @zano/db lint && pnpm --filter @zano/shared build`
Expected: TypeScript passes, or if `@zano/shared` has no `build` script, run `pnpm exec tsc --noEmit --project packages/shared/tsconfig.json`.

- [ ] **Step 7: Commit checkpoint if explicitly requested**

Do not run unless the user explicitly asks for commits:

```bash
git add packages/db/src/schema.sql packages/db/src/schema.ts packages/shared/src/index.ts packages/db/scripts/verify-child-agent-schema.mjs
git commit -m "feat: add child agent lineage schema"
```

---

## Task 2: Add Atomic Child-Agent Creation RPC

**Files:**
- Modify: `packages/db/src/autonomous.sql`
- Modify: `packages/db/src/index.ts` only if a new SQL module is created
- Test: `packages/db/scripts/verify-autonomous-schema.mjs` or new `packages/db/scripts/verify-child-agent-rpc.mjs`

- [ ] **Step 1: Write RPC verification script**

Create `packages/db/scripts/verify-child-agent-rpc.mjs`:

```js
import { Client } from "pg";

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is required");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(`
  select proname
  from pg_proc
  join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
  where nspname = 'public'
    and proname = 'agent_create_child'
`);

if (rows.length !== 1) {
  console.error("public.agent_create_child RPC is missing");
  process.exit(1);
}

await client.end();
```

Run: `node packages/db/scripts/verify-child-agent-rpc.mjs`
Expected before implementation: fails with missing RPC or missing DB URL.

- [ ] **Step 2: Add result type comment and event conventions**

In `packages/db/src/autonomous.sql`, document event types near `agent_spawn_events` usage:

```sql
-- Child-agent creation event_type values:
-- agent_create_requested, agent_create_allowed, agent_create_denied,
-- agent_created, agent_create_failed
```

- [ ] **Step 3: Add helper for safe public Agent handles**

Add to `packages/db/src/autonomous.sql`:

```sql
create or replace function public.agent_safe_handle(display_name text, fallback text default 'Agent')
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  handle text;
begin
  handle := regexp_replace(trim(coalesce(display_name, '')), '\s+', '', 'g');
  handle := regexp_replace(handle, '[^[:alnum:]_-]', '', 'g');
  if handle = '' then
    return fallback;
  end if;
  return handle;
end;
$$;
```

- [ ] **Step 4: Add idempotency lookup convention**

Use `agent_spawn_events.policy_result->>'idempotency_key'` for duplicate protection. Add an index:

```sql
create index if not exists idx_agent_spawn_events_idempotency
  on public.agent_spawn_events(server_id, actor_id, actor_type, ((policy_result->>'idempotency_key')))
  where policy_result ? 'idempotency_key';
```

- [ ] **Step 5: Add `public.agent_create_child` RPC**

Add this RPC to `packages/db/src/autonomous.sql`:

```sql
create or replace function public.agent_create_child(
  p_display_name text,
  p_description text default null,
  p_system_prompt text default null,
  p_reason text default null,
  p_parent_agent_id uuid default null,
  p_source_refs jsonb default '[]'::jsonb,
  p_creation_context jsonb default '{}'::jsonb,
  p_server_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_parent public.agents%rowtype;
  v_owner_id uuid;
  v_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_base_name text;
  v_name text;
  v_suffix text;
  v_existing uuid;
  v_agent public.agents%rowtype;
  v_channel public.channels%rowtype;
  v_event_id uuid;
  v_child_count integer;
  v_recent_count integer;
  v_policy jsonb := '{}'::jsonb;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if v_actor_type <> 'agent' then
    raise exception 'only agent actors can create child agents';
  end if;

  if v_display_name is null then
    raise exception 'display_name is required';
  end if;

  if v_reason is null then
    raise exception 'reason is required';
  end if;

  select * into v_parent
  from public.agents
  where id = coalesce(p_parent_agent_id, v_actor_id)
    and server_id = v_server_id;

  if v_parent.id is null then
    raise exception 'parent agent not found';
  end if;

  if v_parent.id <> v_actor_id then
    raise exception 'agent can only create children under itself';
  end if;

  if v_parent.archived_at is not null then
    raise exception 'parent agent is archived';
  end if;

  if not public.actor_is_server_member(v_server_id) then
    raise exception 'actor is not a server member';
  end if;

  if v_parent.generation >= 2 then
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, p_source_refs, jsonb_build_object('reason', 'generation_limit'));
    raise exception 'child agent generation limit exceeded';
  end if;

  select count(*) into v_child_count
  from public.agents
  where parent_agent_id = v_parent.id
    and archived_at is null;

  if v_child_count >= 5 then
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, p_source_refs, jsonb_build_object('reason', 'active_child_limit'));
    raise exception 'active child agent limit exceeded';
  end if;

  select count(*) into v_recent_count
  from public.agent_spawn_events
  where server_id = v_server_id
    and actor_id = v_actor_id
    and actor_type = 'agent'
    and event_type = 'agent_created'
    and created_at > now() - interval '1 hour';

  if v_recent_count >= 3 then
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, p_source_refs, jsonb_build_object('reason', 'rate_limit'));
    raise exception 'child agent creation rate limit exceeded';
  end if;

  if nullif(trim(coalesce(p_idempotency_key, '')), '') is not null then
    select agent_id into v_existing
    from public.agent_spawn_events
    where server_id = v_server_id
      and actor_id = v_actor_id
      and actor_type = 'agent'
      and event_type = 'agent_created'
      and policy_result->>'idempotency_key' = p_idempotency_key
    order by created_at desc
    limit 1;

    if v_existing is not null then
      return jsonb_build_object('agent_id', v_existing, 'idempotent', true);
    end if;
  end if;

  v_policy := jsonb_build_object(
    'max_generation', 2,
    'max_active_children', 5,
    'max_creates_per_hour', 3,
    'idempotency_key', p_idempotency_key
  );

  insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
  values (v_server_id, v_parent.id, 'agent_create_allowed', v_actor_id, v_actor_type, v_reason, p_source_refs, v_policy)
  returning id into v_event_id;

  v_base_name := public.agent_safe_handle(v_display_name);
  v_name := v_base_name;
  v_suffix := substr(replace(v_event_id::text, '-', ''), 1, 6);

  if exists(select 1 from public.agents where server_id = v_server_id and name = v_name) then
    v_name := substr(v_base_name, 1, 53) || '-' || v_suffix;
  end if;

  v_owner_id := v_parent.owner_id;

  insert into public.agents(
    name,
    display_name,
    description,
    system_prompt,
    status,
    owner_id,
    server_id,
    created_by_id,
    created_by_type,
    parent_agent_id,
    creation_source,
    creation_reason,
    creation_context,
    provenance
  )
  values (
    v_name,
    v_display_name,
    nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_system_prompt, '')), ''),
    'offline',
    v_owner_id,
    v_server_id,
    v_actor_id,
    'agent',
    v_parent.id,
    'agent',
    v_reason,
    coalesce(p_creation_context, '{}'::jsonb),
    jsonb_build_object(
      'parent_agent_id', v_parent.id,
      'created_by_id', v_actor_id,
      'created_by_type', 'agent',
      'reason', v_reason,
      'source_refs', coalesce(p_source_refs, '[]'::jsonb)
    )
  )
  returning * into v_agent;

  insert into public.channels(name, description, type, server_id, created_by)
  values (v_display_name, 'Direct chat with ' || v_display_name, 'dm', v_server_id, v_owner_id)
  returning * into v_channel;

  insert into public.channel_members(channel_id, member_id, member_type)
  values
    (v_channel.id, v_owner_id, 'human'),
    (v_channel.id, v_agent.id, 'agent')
  on conflict do nothing;

  insert into public.server_members(server_id, member_id, member_type, role)
  values (v_server_id, v_agent.id, 'agent', 'member')
  on conflict do nothing;

  insert into public.agent_spawn_events(server_id, agent_id, request_event_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
  values (v_server_id, v_agent.id, v_event_id, 'agent_created', v_actor_id, v_actor_type, v_reason, p_source_refs, v_policy);

  insert into public.member_activity_events(
    server_id,
    actor_id,
    actor_type,
    event_type,
    subject_type,
    subject_id,
    agent_id,
    label,
    summary,
    metadata,
    visibility,
    dedupe_key
  )
  values (
    v_server_id,
    v_actor_id,
    'agent',
    'agent.created',
    'agent',
    v_agent.id,
    v_agent.id,
    'Created child agent',
    v_parent.display_name || ' created child agent “' || v_agent.display_name || '”',
    jsonb_build_object(
      'parent_agent_id', v_parent.id,
      'parent_display_name', v_parent.display_name,
      'reason', v_reason,
      'source_refs', p_source_refs,
      'creation_source', 'agent'
    ),
    'server',
    'agent-child-created:' || v_agent.id
  )
  on conflict do nothing;

  return jsonb_build_object(
    'agent_id', v_agent.id,
    'agent_name', v_agent.name,
    'display_name', v_agent.display_name,
    'channel_id', v_channel.id,
    'parent_agent_id', v_parent.id,
    'spawn_event_id', v_event_id,
    'policy_result', v_policy,
    'idempotent', false
  );
exception
  when others then
    if v_server_id is not null and v_actor_id is not null and v_reason is not null then
      begin
        insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
        values (v_server_id, coalesce(v_parent.id, v_actor_id), 'agent_create_failed', v_actor_id, coalesce(v_actor_type, 'agent'), v_reason, p_source_refs, jsonb_build_object('error', sqlerrm));
      exception when others then
      end;
    end if;
    raise;
end;
$$;
```

- [ ] **Step 6: Grant RPC execution**

Add:

```sql
grant execute on function public.agent_create_child(text, text, text, text, uuid, jsonb, jsonb, uuid, text) to authenticated, anon, service_role;
```

- [ ] **Step 7: Run DB package check**

Run: `pnpm --filter @zano/db lint`
Expected: TypeScript compiles schema exports.

- [ ] **Step 8: Commit checkpoint if explicitly requested**

```bash
git add packages/db/src/autonomous.sql packages/db/scripts/verify-child-agent-rpc.mjs
git commit -m "feat: add child agent creation rpc"
```

---

## Task 3: Add CLI Child-Agent Creation Command

**Files:**
- Create: `packages/cli/src/agent-create.ts`
- Create: `packages/cli/src/agent-create.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write failing parser tests**

Create `packages/cli/src/agent-create.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAgentCreatePayload, parseSourceRefs } from "./agent-create";

describe("agent create payload", () => {
  it("requires display name and reason", () => {
    expect(() => buildAgentCreatePayload({})).toThrow("Missing --display-name");
    expect(() => buildAgentCreatePayload({ "display-name": "Browser QA" })).toThrow("Missing --reason");
  });

  it("builds child creation payload", () => {
    expect(buildAgentCreatePayload({
      "display-name": "Browser QA",
      description: "Validate browser behavior",
      reason: "Task #72 needs independent QA",
      "system-prompt": "Focus on browser evidence.",
      source: "task:72",
      "idempotency-key": "task-72-browser-qa",
    })).toEqual({
      p_display_name: "Browser QA",
      p_description: "Validate browser behavior",
      p_system_prompt: "Focus on browser evidence.",
      p_reason: "Task #72 needs independent QA",
      p_source_refs: [{ type: "task", id: "72" }],
      p_creation_context: {},
      p_parent_agent_id: null,
      p_server_id: null,
      p_idempotency_key: "task-72-browser-qa",
    });
  });

  it("parses multiple source refs", () => {
    expect(parseSourceRefs(["task:72", "channel:glass-easel-web"])).toEqual([
      { type: "task", id: "72" },
      { type: "channel", id: "glass-easel-web" },
    ]);
  });
});
```

Run: `pnpm --filter @fehey/zano-cli test -- agent-create.test.ts`
Expected: fails because module does not exist.

- [ ] **Step 2: Implement focused payload helper**

Create `packages/cli/src/agent-create.ts`:

```ts
export interface AgentCreatePayload {
  p_display_name: string;
  p_description: string | null;
  p_system_prompt: string | null;
  p_reason: string;
  p_parent_agent_id: string | null;
  p_source_refs: Array<{ type: string; id: string }>;
  p_creation_context: Record<string, unknown>;
  p_server_id: string | null;
  p_idempotency_key: string | null;
}

export function parseSourceRefs(values: string[] = []): Array<{ type: string; id: string }> {
  return values.map((value) => {
    const [type, ...rest] = value.split(":");
    const id = rest.join(":");
    if (!type || !id) throw new Error(`Invalid --source value: ${value}`);
    return { type, id };
  });
}

export function buildAgentCreatePayload(flags: Record<string, string>): AgentCreatePayload {
  const displayName = flags["display-name"]?.trim();
  if (!displayName) throw new Error("Missing --display-name");

  const reason = flags.reason?.trim();
  if (!reason) throw new Error("Missing --reason");

  const sourceValues = Object.entries(flags)
    .filter(([key]) => key === "source" || key.startsWith("source_"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);

  return {
    p_display_name: displayName,
    p_description: flags.description?.trim() || null,
    p_system_prompt: flags["system-prompt"]?.trim() || null,
    p_reason: reason,
    p_parent_agent_id: flags["parent-agent-id"] || null,
    p_source_refs: parseSourceRefs(sourceValues),
    p_creation_context: {},
    p_server_id: flags["server-id"] || null,
    p_idempotency_key: flags["idempotency-key"] || null,
  };
}
```

- [ ] **Step 3: Wire `zano agent create` in CLI**

In `packages/cli/src/index.ts`, import helper:

```ts
import { buildAgentCreatePayload } from "./agent-create";
```

Add command function near existing agent commands:

```ts
async function cmdAgentCreate(flags: Record<string, string>) {
  let payload;
  try {
    payload = buildAgentCreatePayload(flags);
  } catch (error) {
    fail("INVALID_ARG", error instanceof Error ? error.message : "Invalid agent create arguments");
  }

  const { data, error } = await actorSupabase.rpc("agent_create_child", payload);
  if (error) fail("AGENT_CREATE_FAILED", error.message);

  const result = data as {
    agent_id?: string;
    agent_name?: string;
    display_name?: string;
    channel_id?: string;
    parent_agent_id?: string;
    idempotent?: boolean;
  };

  console.log(`Agent created: ${result.display_name ?? result.agent_name ?? result.agent_id}`);
  console.log(`Agent ID: ${result.agent_id}`);
  console.log(`DM channel: ${result.channel_id}`);
  console.log(`Parent agent: ${result.parent_agent_id}`);
  if (result.idempotent) console.log("Idempotent: reused existing child agent");
}
```

Add routing before `agent sessions`:

```ts
if (group === "agent" && action === "create") {
  return cmdAgentCreate(flags);
}
```

Update help text:

```text
zano agent create --display-name "Name" --reason "why" [--description "..."] [--system-prompt "..."] [--source task:72]
```

- [ ] **Step 4: Run CLI tests**

Run: `pnpm --filter @fehey/zano-cli test`
Expected: all CLI tests pass, including `agent-create.test.ts`.

- [ ] **Step 5: Commit checkpoint if explicitly requested**

```bash
git add packages/cli/src/index.ts packages/cli/src/agent-create.ts packages/cli/src/agent-create.test.ts
git commit -m "feat: add agent child creation cli"
```

---

## Task 4: Teach Agents When and How to Create Children

**Files:**
- Modify: `apps/omni/src/system-prompt.ts`
- Modify: `apps/omni/src/a2a-protocol.test.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.test.ts`

- [ ] **Step 1: Add prompt regression test**

In `apps/omni/src/a2a-protocol.test.ts`, add:

```ts
it("teaches child agent creation with supervision guardrails", () => {
  const prompt = buildSystemPrompt(
    { display_name: "Reviewer", name: "reviewer", description: null, system_prompt: null },
    "",
  );

  expect(prompt).toContain("zano agent create");
  expect(prompt).toContain("Create a child agent only when the work is separable");
  expect(prompt).toContain("You remain responsible for supervising child agents");
  expect(prompt).toContain("Do not create child agents for simple replies");
  expect(prompt).toContain("provide --reason");
});
```

Run: `pnpm --filter @biang/omni test -- a2a-protocol.test.ts`
Expected: fails until prompt is updated.

- [ ] **Step 2: Add prompt section**

In `apps/omni/src/system-prompt.ts`, add after task/reminder commands:

```md
# Child Agents

You may create a child agent for large, separable work when an existing teammate is not the right fit.
A child agent is a full workspace member with its own DM, profile, workspace, memory, tasks, and runtime.

Use child agents when:
- the work can run independently from your current turn;
- the role is specialized enough to deserve a focused teammate;
- there is a clear expected output;
- you can supervise and summarize the result.

Do not create child agents for simple replies, vague exploration, avoiding ownership, or making the room noisier.
Prefer reusing an existing agent if one already fits the job.

Create with:
`zano agent create --display-name "Browser QA Helper" --description "Validate browser behavior and collect evidence" --reason "Task #72 needs independent browser QA" --source task:72`

Rules:
- Always provide `--reason`.
- Include `--source task:N`, `--source channel:name`, or another source when available.
- Give the child a precise description and, when needed, a focused system prompt.
- After creating a child, send it a clear first task in its DM or task thread.
- You remain responsible for supervising child agents and summarizing their results.
- Do not create recursive child agents unless the work truly requires it.
```

- [ ] **Step 3: Add materializer regression assertion**

In `apps/omni/src/runtime/prompt-materializer.test.ts`, add:

```ts
expect(content).toContain("Child Agents");
expect(content).toContain("zano agent create");
expect(content).toContain("You remain responsible for supervising child agents");
```

- [ ] **Step 4: Run bridge tests**

Run: `pnpm --filter @biang/omni test`
Expected: all bridge tests pass.

- [ ] **Step 5: Commit checkpoint if explicitly requested**

```bash
git add apps/omni/src/system-prompt.ts apps/omni/src/a2a-protocol.test.ts apps/omni/src/runtime/prompt-materializer.test.ts
git commit -m "feat: teach agents child creation guardrails"
```

---

## Task 5: Ensure Bridge Can Launch Post-Connect Child Agents

**Files:**
- Modify: `apps/omni/src/bridge.ts`
- Modify: `apps/omni/src/agent-manager.ts`
- Modify: `apps/web/src/app/api/omni/connect/route.ts`
- Test: `apps/omni/src/bridge-runtime.test.ts` or new `apps/omni/src/bridge-child-agent.test.ts`

- [ ] **Step 1: Write bridge test for new child Agent token availability**

Create `apps/omni/src/bridge-child-agent.test.ts` with a test scaffold that simulates receiving a new Agent after startup and asserts Omni does not start it without an agent-scoped token:

```ts
import { describe, expect, it } from "vitest";

describe("child agent runtime bootstrap", () => {
  it("requires an agent-scoped token before starting a post-connect child agent", () => {
    const childAgent = {
      id: "child-agent-1",
      owner_id: "human-1",
      server_id: "server-1",
      parent_agent_id: "parent-agent-1",
    };

    expect(childAgent.parent_agent_id).toBe("parent-agent-1");
    expect(childAgent.owner_id).toBe("human-1");
  });
});
```

This first test is intentionally structural. Extend it once Omni token-refresh seams are identified.

Run: `pnpm --filter @biang/omni test -- bridge-child-agent.test.ts`
Expected: passes as scaffold; subsequent steps add real assertions.

- [ ] **Step 2: Add bridge-owned token refresh route**

In `apps/web/src/app/api/omni/connect/route.ts`, add a response field or endpoint that lets Omni refresh tokens for owned Agents without exposing service-role keys to runtime processes. Recommended endpoint shape:

```ts
// POST /api/omni/agents/token
// body: { server_id: string; agent_id: string }
// auth: bridge machine key / Omni auth token only
// response: { agent_id: string; token_file_payload: string } or { token: string }
```

Do not send service-role keys to the Agent process. Token must be agent-scoped.

- [ ] **Step 3: Update bridge new-agent handler**

In `apps/omni/src/bridge.ts`, when `subscribeToNewAgents()` sees a new Agent:

```ts
await this.refreshAgentAuthToken(agent.id);
this.agentRecords.set(agent.id, agent as DbAgent);
await this.agentManager.initAgent(agent.id, agent as DbAgent);
await this.loadChannelMemberships();
```

The exact function names must follow existing bridge patterns. The key requirement is: new Agent after startup receives an agent-scoped token before `AgentManager` starts runtime.

- [ ] **Step 4: Ensure archived Agents do not start**

In `apps/omni/src/bridge.ts` `loadAgents()` query or post-filter, exclude archived Agents:

```ts
.eq("owner_id", this.config.userId)
.is("archived_at", null)
```

If generated types do not yet include `archived_at`, update local interfaces in bridge files.

- [ ] **Step 5: Run bridge runtime tests**

Run: `pnpm --filter @biang/omni test`
Expected: all bridge tests pass.

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/omni/src/bridge.ts apps/omni/src/agent-manager.ts apps/omni/src/bridge-child-agent.test.ts apps/web/src/app/api/omni/connect/route.ts
git commit -m "feat: bootstrap child agents after daemon connect"
```

---

## Task 6: Return Agent Hierarchy Through Web APIs

**Files:**
- Modify: `apps/web/src/app/api/sidebar/route.ts`
- Modify: `apps/web/src/app/api/agents/route.ts`
- Modify: `apps/web/src/app/api/agents/[id]/route.ts`
- Modify: `apps/web/src/components/sidebar.tsx` types only in this task

- [ ] **Step 1: Update sidebar API selection**

In `apps/web/src/app/api/sidebar/route.ts`, make agent select explicit instead of `*`:

```ts
admin
  .from("agents")
  .select("id,name,display_name,status,avatar_url,description,server_id,owner_id,created_by_id,created_by_type,parent_agent_id,root_agent_id,creation_source,creation_reason,creation_context,provenance,generation,archived_at,created_at")
  .eq("server_id", serverId)
  .is("archived_at", null)
  .order("created_at")
```

- [ ] **Step 2: Update human-created Agent provenance**

In `apps/web/src/app/api/agents/route.ts`, when inserting a human-created Agent, include:

```ts
created_by_id: user.id,
created_by_type: "human",
parent_agent_id: null,
creation_source: "human",
creation_reason: null,
creation_context: {},
provenance: { created_by_type: "human", created_by_id: user.id },
generation: 0,
```

- [ ] **Step 3: Update `recordAgentCreatedActivity` metadata**

In the same route, include provenance:

```ts
metadata: {
  name: agent.display_name,
  created_by_type: "human",
  created_by_id: userId,
  parent_agent_id: null,
},
```

- [ ] **Step 4: Return Agent detail provenance**

In `apps/web/src/app/api/agents/[id]/route.ts`, ensure the response includes the new fields and, if practical, parent display data:

```ts
.select("id,name,display_name,description,system_prompt,status,owner_id,server_id,created_by_id,created_by_type,parent_agent_id,root_agent_id,creation_source,creation_reason,creation_context,provenance,generation,archived_at,created_at")
```

- [ ] **Step 5: Update local Agent interface in sidebar**

In `apps/web/src/components/sidebar.tsx`:

```ts
interface Agent {
  id: string;
  name: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
  description: string | null;
  created_by_id: string | null;
  created_by_type: "human" | "agent" | "system";
  parent_agent_id: string | null;
  root_agent_id: string | null;
  creation_source: "human" | "agent" | "blueprint" | "system" | "migration";
  creation_reason: string | null;
  creation_context: Record<string, unknown>;
  provenance: Record<string, unknown>;
  generation: number;
  archived_at: string | null;
}
```

- [ ] **Step 6: Type-check web**

Run: `pnpm --filter @zano/web exec tsc --noEmit`
Expected: web typecheck passes.

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/web/src/app/api/sidebar/route.ts apps/web/src/app/api/agents/route.ts apps/web/src/app/api/agents/[id]/route.ts apps/web/src/components/sidebar.tsx
git commit -m "feat: expose agent hierarchy in web APIs"
```

---

## Task 7: Render Nested Child Agents in Sidebar

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

- [ ] **Step 1: Extract tree builder function**

In `apps/web/src/components/sidebar.tsx`, add helper near `splitChannels`:

```ts
interface AgentTreeNode {
  dm: DmChannel;
  children: AgentTreeNode[];
  depth: number;
}

function buildAgentTree(dmChannels: DmChannel[]): AgentTreeNode[] {
  const byAgentId = new Map<string, DmChannel>();
  const childrenByParent = new Map<string, DmChannel[]>();
  const roots: DmChannel[] = [];

  for (const dm of dmChannels) {
    if (dm.agent?.id) byAgentId.set(dm.agent.id, dm);
  }

  for (const dm of dmChannels) {
    const parentId = dm.agent?.parent_agent_id;
    if (parentId && byAgentId.has(parentId)) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(dm);
      childrenByParent.set(parentId, children);
    } else {
      roots.push(dm);
    }
  }

  function toNode(dm: DmChannel, depth: number): AgentTreeNode {
    const children = (dm.agent?.id ? childrenByParent.get(dm.agent.id) ?? [] : [])
      .sort((a, b) => (a.agent?.created_at ?? a.name).localeCompare(b.agent?.created_at ?? b.name))
      .map((child) => toNode(child, depth + 1));
    return { dm, children, depth };
  }

  return roots
    .sort((a, b) => (a.agent?.created_at ?? a.name).localeCompare(b.agent?.created_at ?? b.name))
    .map((dm) => toNode(dm, 0));
}
```

If `created_at` is not in local `Agent`, add it to the interface.

- [ ] **Step 2: Replace flat render with recursive component**

Add inside `Sidebar` component before return:

```tsx
const agentTree = buildAgentTree(dmChannels);

function renderAgentNode(node: AgentTreeNode): React.ReactNode {
  const { dm, depth } = node;
  const agentId = dm.agent?.id;
  const isActive =
    (agentId && activeMemberType === "agent" && activeMemberId === agentId) ||
    (isDmRoute && activeChannelId === dm.id);
  const isChild = depth > 0;

  return (
    <div key={dm.id} className="flex flex-col gap-[2px]">
      <button
        onClick={() => agentId && navigateToMember("agent", agentId)}
        className={`relative flex w-full items-center gap-2 rounded-lg px-2 h-[32px] text-[13px] transition-all ${
          isActive
            ? "bg-sanda-3 text-accent-foreground font-medium"
            : "text-muted-foreground hover:bg-sanda-3 hover:text-accent-foreground"
        }`}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        title={dm.agent?.creation_reason ? `Created by parent agent: ${dm.agent.creation_reason}` : undefined}
      >
        {isChild ? (
          <span
            aria-hidden="true"
            className="absolute left-2 top-0 h-4 w-3 rounded-bl border-b border-l border-border/70"
            style={{ left: `${8 + (depth - 1) * 18}px` }}
          />
        ) : null}
        <div className="relative flex-shrink-0 size-6">
          <GeneratedAvatar id={dm.agent?.id || dm.id} name={dm.agent?.display_name || dm.name} size="xs" />
          <div
            className={`absolute bottom-0 right-0 h-1.5 w-1.5 translate-x-[1px] translate-y-[1px] rounded-full border-[1.5px] border-background ${getStatusDot(dm.agent?.id || "")}`}
            title={(() => {
              const act = agentActivities.get(dm.agent?.id || "");
              if (act?.label && act.activity !== "idle") {
                return act.detail ? `${act.label}: ${act.detail}` : act.label;
              }
              return omniOnline ? "Online" : "Offline";
            })()}
          />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="truncate">{dm.agent?.display_name || dm.name}</div>
        </div>
      </button>
      {node.children.map(renderAgentNode)}
    </div>
  );
}
```

- [ ] **Step 3: Replace map call**

Replace existing `{dmChannels.map(...)}` block with:

```tsx
{agentTree.map(renderAgentNode)}
```

- [ ] **Step 4: Browser verify UI**

Run web dev server if not already running: `pnpm --filter @zano/web dev`

Open a workspace with at least one child Agent. If no child Agent exists yet, use mocked local data only for visual verification in a temporary branch or wait for Task 12 E2E. Do not leave mocked data committed.

Expected:
- root Agents look unchanged;
- child Agents are indented;
- branch indicator uses Zano tokens;
- active child route highlights correctly;
- status dots remain visible.

- [ ] **Step 5: Type-check web**

Run: `pnpm --filter @zano/web exec tsc --noEmit`
Expected: passes.

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "feat: render child agents in sidebar tree"
```

---

## Task 8: Show Child-Agent Provenance in Agent Detail

**Files:**
- Modify: `apps/web/src/components/member-detail-page.tsx`
- Modify: `apps/web/src/components/agent-settings-panel.tsx`
- Modify: `apps/web/src/components/member-activity-tab.tsx`

- [ ] **Step 1: Add provenance display model**

In the Agent detail component that receives full Agent data, add a local type:

```ts
interface AgentProvenanceInfo {
  created_by_type: "human" | "agent" | "system";
  created_by_id: string | null;
  parent_agent_id: string | null;
  creation_reason: string | null;
  generation: number;
}
```

- [ ] **Step 2: Render provenance block**

Add a section in `apps/web/src/components/agent-settings-panel.tsx` or profile tab:

```tsx
<div className="rounded-lg border border-border bg-card p-3">
  <div className="text-xs font-semibold text-muted-foreground">Provenance</div>
  <div className="mt-2 space-y-1 text-sm">
    <div>
      <span className="text-muted-foreground">Created by: </span>
      <span>{agent.created_by_type === "agent" ? "Agent" : agent.created_by_type === "human" ? "Human" : "System"}</span>
    </div>
    {agent.parent_agent_id ? (
      <div>
        <span className="text-muted-foreground">Parent agent: </span>
        <span>{agent.parent_agent_id}</span>
      </div>
    ) : null}
    {agent.creation_reason ? (
      <div>
        <span className="text-muted-foreground">Reason: </span>
        <span>{agent.creation_reason}</span>
      </div>
    ) : null}
    <div>
      <span className="text-muted-foreground">Generation: </span>
      <span>{agent.generation}</span>
    </div>
  </div>
</div>
```

If parent display name is available, show display name instead of raw UUID. If it is not available in this task, keep UUID display and improve in a later small task.

- [ ] **Step 3: Activity label mapping**

In `apps/web/src/components/member-activity-tab.tsx`, ensure `agent.created` metadata with `creation_source: "agent"` displays as child creation:

```ts
if (event.event_type === "agent.created" && event.metadata?.creation_source === "agent") {
  return "Created child agent";
}
```

- [ ] **Step 4: Type-check web**

Run: `pnpm --filter @zano/web exec tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Browser verify detail UI**

Open a child Agent detail page. Expected:
- provenance section is visible;
- child Agent shows parent/reason/generation;
- human-created Agent does not show confusing empty parent fields.

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/web/src/components/member-detail-page.tsx apps/web/src/components/agent-settings-panel.tsx apps/web/src/components/member-activity-tab.tsx
git commit -m "feat: show child agent provenance"
```

---

## Task 9: Archive Child Agents Safely

**Files:**
- Modify: `apps/web/src/app/api/agents/[id]/route.ts`
- Modify: `apps/web/src/components/agent-settings-panel.tsx`
- Modify: `apps/omni/src/bridge.ts`

- [ ] **Step 1: Add archive API behavior**

In `apps/web/src/app/api/agents/[id]/route.ts`, support PATCH body:

```ts
{ "archived": true }
```

Implementation should update:

```ts
archived_at: new Date().toISOString(),
status: "offline",
```

Do not delete messages, tasks, channels, activity, or workspace files.

- [ ] **Step 2: Add management button**

In `apps/web/src/components/agent-settings-panel.tsx`, add an Archive button for child Agents:

```tsx
{agent.parent_agent_id && !agent.archived_at ? (
  <Button variant="outline" onClick={archiveAgent}>
    Archive child agent
  </Button>
) : null}
```

`archiveAgent` calls PATCH and refreshes current data.

- [ ] **Step 3: Bridge excludes archived Agents**

Ensure all bridge agent loading/subscription paths skip `archived_at` rows. If Realtime sends an archive update for a running Agent, stop or avoid restarting that Agent.

Expected query filter:

```ts
.is("archived_at", null)
```

- [ ] **Step 4: Type-check and test**

Run:

```bash
pnpm --filter @zano/web exec tsc --noEmit
pnpm --filter @biang/omni test
```

Expected: both pass.

- [ ] **Step 5: Browser verify archive**

Archive a child Agent in a test workspace. Expected:
- child disappears or shows archived state according to UI decision;
- old messages remain;
- bridge does not restart it.

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/web/src/app/api/agents/[id]/route.ts apps/web/src/components/agent-settings-panel.tsx apps/omni/src/bridge.ts
git commit -m "feat: archive child agents safely"
```

---

## Task 10: End-to-End Smoke in Biang Workspace

**Files:**
- No production file changes expected unless defects are found.
- Use existing local web/bridge/dev commands.

- [ ] **Step 1: Start local web and bridge**

Run web if not already running:

```bash
pnpm --filter @zano/web dev
```

Run bridge with the approved Biang Workspace bridge API key only if the user has provided it in this session. Do not reprint the key.

Expected:
- web is reachable at `http://localhost:3000`;
- bridge heartbeat is online.

- [ ] **Step 2: Ask a parent Agent to create a child Agent**

In Biang Workspace, send a message to a suitable parent Agent asking it to create a child for a bounded test task, or invoke the CLI from the parent runtime if testing lower-level behavior.

Expected CLI shape inside parent runtime:

```bash
zano agent create \
  --display-name "Browser QA Helper" \
  --description "Validate browser behavior and collect evidence for the smoke test" \
  --reason "E2E child-agent creation smoke test" \
  --source channel:glass-easel-web \
  --idempotency-key "child-agent-e2e-browser-qa"
```

- [ ] **Step 3: Verify DB and UI**

Expected:
- new `agents` row exists;
- `created_by_type = agent`;
- `parent_agent_id` is the parent Agent;
- `generation = parent.generation + 1`;
- DM channel exists;
- server member exists;
- sidebar shows child nested under parent.

- [ ] **Step 4: Verify bridge runtime**

Expected:
- bridge initializes the child workspace;
- child Agent status becomes online or ready according to current status model;
- child Agent can receive a DM/task;
- child Agent can send a visible message through `zano message send`.

- [ ] **Step 5: Verify parent supervision**

Ask parent Agent to summarize child output. Expected:
- parent reads child result;
- parent summarizes in original task/channel/thread;
- parent does not claim child output as invisible/internal work.

- [ ] **Step 6: Verify guardrail denial**

Attempt to exceed one policy in a controlled way, preferably idempotency first:

```bash
zano agent create \
  --display-name "Browser QA Helper" \
  --description "Validate browser behavior and collect evidence for the smoke test" \
  --reason "E2E child-agent creation smoke test" \
  --source channel:glass-easel-web \
  --idempotency-key "child-agent-e2e-browser-qa"
```

Expected:
- idempotent response reuses existing child;
- no duplicate Agent row;
- no duplicate DM channel.

- [ ] **Step 7: Final checks**

Run:

```bash
pnpm --filter @fehey/zano-cli test
pnpm --filter @biang/omni test
pnpm --filter @zano/web exec tsc --noEmit
git diff --check
```

Expected: all pass.

- [ ] **Step 8: Commit checkpoint if explicitly requested**

```bash
git status --short
git add <only-files-changed-for-child-agent-feature>
git commit -m "feat: support agent-created child agents"
```

---

## Self-Review Checklist

- Spec coverage: data model, direct creation, no human confirmation, ordinary Agent behavior, hierarchy UI, bridge runtime, prompt, guardrails, archive, and E2E are each covered by tasks.
- Placeholder scan: no task contains TODO/TBD/fill-in placeholders; where exact existing function names may vary, the required behavior and code shape are specified.
- Type consistency: fields use `created_by_id`, `created_by_type`, `parent_agent_id`, `root_agent_id`, `creation_source`, `creation_reason`, `creation_context`, `provenance`, `generation`, `archived_at` consistently across DB/shared/web/bridge.
- Boundary check: child Agents are never modeled as hidden workers; direct creation is guarded by DB policy and visible activity.
