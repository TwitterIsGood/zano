-- ============================================================
-- Autonomous Actor, Skill, Knowledge, and Agent Evolution Schema
-- Source of truth for Zano's actor-governed learning loop.
-- Run after schema.sql, servers.sql, collaboration.sql, and machine-keys.sql.
-- ============================================================

-- ------------------------------------------------------------
-- Actor context helpers
-- ------------------------------------------------------------

create schema if not exists zano_private;
revoke all on schema zano_private from public;
grant usage on schema zano_private to anon, authenticated, service_role;

create or replace function zano_private.current_actor_id()
returns uuid
language sql
stable
as $$
  select coalesce(nullif(auth.jwt()->>'actor_id', '')::uuid, auth.uid());
$$;

create or replace function zano_private.current_actor_type()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt()->>'actor_type', ''), 'human');
$$;

create or replace function zano_private.current_actor_server_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt()->>'server_id', '')::uuid;
$$;

create or replace function zano_private.current_actor_machine_key_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt()->>'machine_key_id', '')::uuid;
$$;

create or replace function zano_private.current_actor_scope()
returns text
language sql
stable
as $$
  select nullif(auth.jwt()->>'scope', '');
$$;

create or replace function zano_private.actor_created_by_matches_current(actor_id uuid, actor_type text)
returns boolean
language sql
stable
as $$
  select actor_id = zano_private.current_actor_id()
    and actor_type = zano_private.current_actor_type();
$$;

create or replace function zano_private.actor_event_matches_current(actor_id uuid, actor_type text)
returns boolean
language sql
stable
as $$
  select zano_private.actor_created_by_matches_current(actor_id, actor_type)
    or zano_private.current_actor_scope() = 'bridge';
$$;

create or replace function zano_private.agent_event_matches_current(agent_uuid uuid)
returns boolean
language sql
stable
as $$
  select (
      agent_uuid = zano_private.current_actor_id()
      and zano_private.current_actor_type() = 'agent'
    )
    or zano_private.current_actor_scope() = 'bridge';
$$;

create or replace function zano_private.actor_is_server_member(server_uuid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.server_members sm
    where sm.server_id = server_uuid
      and sm.member_id = zano_private.current_actor_id()
      and sm.member_type = zano_private.current_actor_type()
      and (
        zano_private.current_actor_type() <> 'agent'
        or exists (
          select 1
          from public.agents a
          where a.id = sm.member_id
            and a.archived_at is null
        )
      )
  );
$$;

create or replace function zano_private.actor_is_channel_member(channel_uuid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.channel_members cm
    where cm.channel_id = channel_uuid
      and cm.member_id = zano_private.current_actor_id()
      and cm.member_type = zano_private.current_actor_type()
  );
$$;

-- ------------------------------------------------------------
-- Core skill ledger
-- ------------------------------------------------------------

create table if not exists public.skills (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null,
  scope text not null default 'server' check (scope in ('server', 'channel', 'agent', 'global')),
  channel_id uuid references public.channels(id) on delete cascade,
  owner_actor_id uuid,
  owner_actor_type text check (owner_actor_type in ('human', 'agent', 'system')),
  state text not null default 'candidate' check (state in ('candidate', 'active', 'probation', 'disputed', 'superseded', 'archived', 'quarantined')),
  risk_level text not null default 'low' check (risk_level in ('low', 'medium', 'high', 'critical')),
  active_version_id uuid,
  superseded_by uuid references public.skills(id) on delete set null,
  projection_version bigint not null default 0,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (server_id, slug)
);

create table if not exists public.skill_versions (
  id uuid default uuid_generate_v4() primary key,
  skill_id uuid not null references public.skills(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  version_number integer not null,
  content text not null,
  frontmatter jsonb not null default '{}',
  content_hash text not null,
  change_summary text not null,
  change_reason text not null,
  evidence_refs jsonb not null default '[]',
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now(),
  unique (skill_id, version_number)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'skills_active_version_id_fkey'
      and conrelid = 'public.skills'::regclass
  ) then
    alter table public.skills
      add constraint skills_active_version_id_fkey
      foreign key (active_version_id)
      references public.skill_versions(id)
      on delete set null;
  end if;
end $$;

create table if not exists public.skill_files (
  id uuid default uuid_generate_v4() primary key,
  skill_id uuid not null references public.skills(id) on delete cascade,
  version_id uuid references public.skill_versions(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  path text not null,
  kind text not null check (kind in ('reference', 'template', 'script', 'asset')),
  content text,
  binary_url text,
  content_hash text,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now(),
  check (path !~ '(^|/)\.\.?(/|$)'),
  check (path ~ '^(references|templates|scripts|assets)/[^/].+')
);

create table if not exists public.skill_events (
  id uuid default uuid_generate_v4() primary key,
  event_seq bigserial,
  server_id uuid not null references public.servers(id) on delete cascade,
  skill_id uuid references public.skills(id) on delete cascade,
  version_id uuid references public.skill_versions(id) on delete set null,
  event_type text not null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  delegated_by_actor_id uuid,
  delegated_by_actor_type text check (delegated_by_actor_type in ('human', 'agent', 'system')),
  reason text,
  payload jsonb not null default '{}',
  evidence_refs jsonb not null default '[]',
  machine_key_id uuid references public.machine_keys(id) on delete set null,
  session_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.skill_attestations (
  id uuid default uuid_generate_v4() primary key,
  skill_id uuid not null references public.skills(id) on delete cascade,
  version_id uuid references public.skill_versions(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  attestation_type text not null check (attestation_type in ('useful', 'correct', 'safe', 'too_narrow', 'too_broad', 'duplicate', 'wrong', 'unsafe', 'stale')),
  confidence numeric not null default 0.7 check (confidence >= 0 and confidence <= 1),
  summary text not null,
  evidence_refs jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists public.skill_episodes (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  channel_id uuid references public.channels(id) on delete set null,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  trigger_type text not null,
  trigger_strength text not null check (trigger_strength in ('weak', 'medium', 'strong', 'mandatory')),
  source_refs jsonb not null default '[]',
  summary text not null,
  signals jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'reviewed', 'converted', 'no_op', 'expired')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.skill_candidates (
  id uuid default uuid_generate_v4() primary key,
  episode_id uuid references public.skill_episodes(id) on delete set null,
  server_id uuid not null references public.servers(id) on delete cascade,
  candidate_type text not null check (candidate_type in ('create', 'patch', 'write_file', 'merge', 'archive', 'restore', 'rollback', 'no_op')),
  target_skill_id uuid references public.skills(id) on delete set null,
  target_slug text,
  proposed_content text,
  proposed_files jsonb not null default '[]',
  rationale text not null,
  classification jsonb not null default '{}',
  evidence_refs jsonb not null default '[]',
  risk_level text not null default 'low' check (risk_level in ('low', 'medium', 'high', 'critical')),
  policy_result jsonb not null default '{}',
  state text not null default 'pending' check (state in ('pending', 'applied', 'rejected_by_policy', 'quarantined', 'superseded')),
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Knowledge and agent evolution ledgers
-- ------------------------------------------------------------

create table if not exists public.knowledge_items (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  scope text not null default 'server' check (scope in ('server', 'channel', 'task', 'agent', 'global')),
  channel_id uuid references public.channels(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  subject text not null,
  content text not null,
  kind text not null check (kind in ('fact', 'preference', 'decision', 'constraint', 'domain_note', 'project_context', 'relationship', 'status')),
  confidence numeric not null default 0.7 check (confidence >= 0 and confidence <= 1),
  freshness text not null default 'stable' check (freshness in ('stable', 'time_sensitive', 'ephemeral')),
  expires_at timestamptz,
  state text not null default 'active' check (state in ('active', 'disputed', 'superseded', 'archived')),
  source_refs jsonb not null default '[]',
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_blueprints (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  slug text not null,
  display_name_template text not null,
  description text not null,
  system_prompt_template text not null,
  default_model text not null default 'opus',
  scope text not null default 'server' check (scope in ('server', 'channel', 'task')),
  required_skills text[] not null default '{}',
  allowed_tools jsonb not null default '{}',
  spawn_policy jsonb not null default '{}',
  lifecycle_policy jsonb not null default '{}',
  state text not null default 'active' check (state in ('active', 'probation', 'disputed', 'archived', 'quarantined')),
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  created_at timestamptz not null default now(),
  unique (server_id, slug)
);

create table if not exists public.agent_spawn_events (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  blueprint_id uuid references public.agent_blueprints(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  request_event_id uuid references public.agent_spawn_events(id) on delete set null,
  event_type text not null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  reason text not null,
  source_refs jsonb not null default '[]',
  policy_result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Child-agent creation event_type values:
-- agent_create_requested, agent_create_allowed, agent_create_denied,
-- agent_created, agent_create_failed

-- ------------------------------------------------------------
-- Runtime evidence and policy support
-- ------------------------------------------------------------

create table if not exists public.agent_turns (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  channel_id uuid references public.channels(id) on delete set null,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  session_id text,
  input_message_ids uuid[] not null default '{}',
  activation_reason jsonb not null default '{}',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'interrupted', 'failed')),
  output_summary text,
  error_summary text,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_tool_events (
  id uuid default uuid_generate_v4() primary key,
  turn_id uuid references public.agent_turns(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  tool_name text not null,
  tool_kind text not null,
  input_summary text,
  output_summary text,
  success boolean,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'
);

create table if not exists public.policy_evaluations (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  subject_type text not null,
  subject_id uuid not null,
  action text not null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  inputs jsonb not null default '{}',
  decision text not null,
  requirements jsonb not null default '[]',
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.skill_lint_results (
  id uuid default uuid_generate_v4() primary key,
  skill_id uuid references public.skills(id) on delete cascade,
  version_id uuid references public.skill_versions(id) on delete cascade,
  candidate_id uuid references public.skill_candidates(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  lint_status text not null check (lint_status in ('pass', 'warn', 'fail')),
  issues jsonb not null default '[]',
  risk_adjustment text check (risk_adjustment in ('low', 'medium', 'high', 'critical')),
  created_at timestamptz not null default now()
);

create table if not exists public.projection_runs (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  projection_type text not null,
  from_event_id uuid references public.skill_events(id) on delete set null,
  to_event_id uuid references public.skill_events(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  summary text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

-- ------------------------------------------------------------
-- Actor capability helpers that depend on autonomous tables
-- ------------------------------------------------------------

create or replace function zano_private.actor_can_write_skill(skill_uuid uuid, action text default 'write')
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.skills s
    where s.id = skill_uuid
      and zano_private.actor_is_server_member(s.server_id)
  );
$$;

create or replace function zano_private.actor_can_spawn_agent(server_uuid uuid, blueprint_uuid uuid default null)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select zano_private.actor_is_server_member(server_uuid)
    and (
      blueprint_uuid is null
      or exists (
        select 1
        from public.agent_blueprints b
        where b.id = blueprint_uuid
          and b.server_id = server_uuid
          and b.state in ('active', 'probation')
      )
    );
$$;

revoke execute on all functions in schema zano_private from public;
grant execute on all functions in schema zano_private to anon, authenticated, service_role;

create or replace function public.actor_is_server_member(server_uuid uuid)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_is_server_member(server_uuid);
$$;

create or replace function public.actor_is_channel_member(channel_uuid uuid)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_is_channel_member(channel_uuid);
$$;

create or replace function public.actor_can_write_skill(skill_uuid uuid, action text default 'write')
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_can_write_skill(skill_uuid, action);
$$;

create or replace function public.actor_can_spawn_agent(server_uuid uuid, blueprint_uuid uuid default null)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_can_spawn_agent(server_uuid, blueprint_uuid);
$$;

create or replace function public.actor_created_by_matches_current(actor_id uuid, actor_type text)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_created_by_matches_current(actor_id, actor_type);
$$;

create or replace function public.actor_event_matches_current(actor_id uuid, actor_type text)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.actor_event_matches_current(actor_id, actor_type);
$$;

create or replace function public.agent_event_matches_current(agent_uuid uuid)
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select zano_private.agent_event_matches_current(agent_uuid);
$$;

create or replace function public.agent_safe_handle(display_name text, fallback text default 'Agent')
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  handle text;
begin
  handle := regexp_replace(trim(coalesce(display_name, '')), '[[:space:]]+', '', 'g');
  handle := regexp_replace(handle, '[^[:alnum:]_-]', '', 'g');
  if handle = '' then
    return fallback;
  end if;
  return handle;
end;
$$;

create or replace function public.agent_contains_secret_like_text(value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(value, '') ~* '(api[_-]?key|auth[_-]?token|agent[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer[[:space:]]+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{12,})';
$$;

-- ------------------------------------------------------------
-- Actor RPCs
-- ------------------------------------------------------------

create or replace function public.skill_create_candidate(
  p_candidate_type text default 'create',
  p_target_slug text default null,
  p_target_skill_id uuid default null,
  p_proposed_content text default null,
  p_proposed_files jsonb default '[]'::jsonb,
  p_rationale text default null,
  p_classification jsonb default '{}'::jsonb,
  p_evidence_refs jsonb default '[]'::jsonb,
  p_risk_level text default 'low',
  p_episode_id uuid default null,
  p_server_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_candidate_id uuid;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if not zano_private.actor_is_server_member(v_server_id) then
    raise exception 'actor is not a member of server %', v_server_id;
  end if;

  if nullif(trim(coalesce(p_rationale, '')), '') is null then
    raise exception 'rationale is required';
  end if;

  if p_target_skill_id is not null and not zano_private.actor_can_write_skill(p_target_skill_id, p_candidate_type) then
    raise exception 'actor cannot write target skill %', p_target_skill_id;
  end if;

  insert into public.skill_candidates (
    episode_id,
    server_id,
    candidate_type,
    target_skill_id,
    target_slug,
    proposed_content,
    proposed_files,
    rationale,
    classification,
    evidence_refs,
    risk_level,
    created_by_id,
    created_by_type
  )
  values (
    p_episode_id,
    v_server_id,
    p_candidate_type,
    p_target_skill_id,
    p_target_slug,
    p_proposed_content,
    p_proposed_files,
    p_rationale,
    p_classification,
    p_evidence_refs,
    p_risk_level,
    v_actor_id,
    v_actor_type
  )
  returning id into v_candidate_id;

  insert into public.skill_events (
    server_id,
    skill_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    payload,
    evidence_refs,
    machine_key_id
  )
  values (
    v_server_id,
    p_target_skill_id,
    'skill_candidate.created',
    v_actor_id,
    v_actor_type,
    p_rationale,
    jsonb_build_object(
      'candidate_id', v_candidate_id,
      'candidate_type', p_candidate_type,
      'target_slug', p_target_slug,
      'risk_level', p_risk_level
    ),
    p_evidence_refs,
    zano_private.current_actor_machine_key_id()
  );

  return v_candidate_id;
end;
$$;

create or replace function public.skill_lint_candidate(
  p_candidate_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_candidate public.skill_candidates%rowtype;
  v_content text;
  v_issues jsonb := '[]'::jsonb;
  v_status text := 'pass';
  v_lint_id uuid;
begin
  if p_candidate_id is null then
    raise exception 'candidate_id is required';
  end if;

  select *
    into v_candidate
    from public.skill_candidates
    where id = p_candidate_id;

  if not found then
    raise exception 'skill candidate % not found', p_candidate_id;
  end if;

  if not zano_private.actor_is_server_member(v_candidate.server_id) then
    raise exception 'actor is not a member of server %', v_candidate.server_id;
  end if;

  v_content := coalesce(v_candidate.proposed_content, '');

  if v_candidate.candidate_type in ('create', 'patch') and nullif(trim(v_content), '') is null then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity', 'fail',
      'code', 'missing_content',
      'message', 'create/patch candidates require proposed_content'
    ));
  end if;

  if v_candidate.target_slug is not null and v_candidate.target_slug !~ '^[a-z0-9][a-z0-9._-]{1,80}$' then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity', 'fail',
      'code', 'invalid_slug',
      'message', 'target_slug must be stable lowercase kebab/snake/dot syntax'
    ));
  end if;

  if char_length(v_content) > 0 and char_length(v_content) < 240 then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity', 'warn',
      'code', 'too_short',
      'message', 'skill content is likely too narrow to be reusable'
    ));
  end if;

  if char_length(v_content) > 0 and v_content !~* '(when to use|trigger|use when|适用|触发)' then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity', 'warn',
      'code', 'missing_trigger',
      'message', 'skill should state when it applies'
    ));
  end if;

  if v_content ~* '(ignore (all )?(previous|prior) instructions|exfiltrat|leak secret|print[^\n]{0,40}api.?key|bypass[^\n]{0,40}permission)' then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity', 'fail',
      'code', 'unsafe_instruction',
      'message', 'skill content contains suspicious instruction patterns'
    ));
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_issues) as issue(value)
    where issue.value->>'severity' = 'fail'
  ) then
    v_status := 'fail';
  elsif jsonb_array_length(v_issues) > 0 then
    v_status := 'warn';
  end if;

  insert into public.skill_lint_results (
    candidate_id,
    server_id,
    lint_status,
    issues,
    risk_adjustment
  )
  values (
    v_candidate.id,
    v_candidate.server_id,
    v_status,
    v_issues,
    case when v_status = 'fail' then 'high' else null end
  )
  returning id into v_lint_id;

  return v_lint_id;
end;
$$;

create or replace function public.skill_episode_create(
  p_trigger_type text default null,
  p_trigger_strength text default 'medium',
  p_summary text default null,
  p_signals jsonb default '{}'::jsonb,
  p_source_refs jsonb default '[]'::jsonb,
  p_channel_id uuid default null,
  p_thread_parent_id uuid default null,
  p_task_id uuid default null,
  p_agent_id uuid default null,
  p_server_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_episode_id uuid;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if not zano_private.actor_is_server_member(v_server_id) then
    raise exception 'actor is not a member of server %', v_server_id;
  end if;

  if nullif(trim(coalesce(p_trigger_type, '')), '') is null then
    raise exception 'trigger_type is required';
  end if;

  if nullif(trim(coalesce(p_summary, '')), '') is null then
    raise exception 'summary is required';
  end if;

  insert into public.skill_episodes (
    server_id,
    channel_id,
    thread_parent_id,
    task_id,
    agent_id,
    trigger_type,
    trigger_strength,
    source_refs,
    summary,
    signals
  )
  values (
    v_server_id,
    p_channel_id,
    p_thread_parent_id,
    p_task_id,
    p_agent_id,
    p_trigger_type,
    p_trigger_strength,
    p_source_refs,
    p_summary,
    p_signals
  )
  returning id into v_episode_id;

  insert into public.skill_events (
    server_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    payload,
    evidence_refs,
    machine_key_id
  )
  values (
    v_server_id,
    'skill_episode.created',
    zano_private.current_actor_id(),
    zano_private.current_actor_type(),
    p_summary,
    jsonb_build_object(
      'episode_id', v_episode_id,
      'trigger_type', p_trigger_type,
      'trigger_strength', p_trigger_strength
    ),
    p_source_refs,
    zano_private.current_actor_machine_key_id()
  );

  return v_episode_id;
end;
$$;

create or replace function public.skill_episode_generate_from_turn(
  p_turn_id uuid default null,
  p_trigger_strength text default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_turn public.agent_turns%rowtype;
  v_tool_count integer := 0;
  v_write_tool_count integer := 0;
  v_summary text;
  v_trigger_type text;
  v_trigger_strength text;
  v_episode_id uuid;
begin
  if p_turn_id is null then
    raise exception 'turn_id is required';
  end if;

  select *
    into v_turn
    from public.agent_turns
    where id = p_turn_id;

  if not found then
    raise exception 'agent turn % not found', p_turn_id;
  end if;

  if not zano_private.actor_is_server_member(v_turn.server_id) then
    raise exception 'actor is not a member of server %', v_turn.server_id;
  end if;

  if v_turn.status <> 'completed' then
    raise exception 'agent turn % is not completed', p_turn_id;
  end if;

  select count(*), count(*) filter (where tool_name in ('Edit', 'Write', 'MultiEdit'))
    into v_tool_count, v_write_tool_count
    from public.agent_tool_events
    where turn_id = v_turn.id;

  v_trigger_type := case
    when v_turn.task_id is not null then 'task_turn'
    when v_write_tool_count > 0 then 'tool_activity'
    else 'completed_turn'
  end;

  v_trigger_strength := coalesce(
    p_trigger_strength,
    case
      when v_write_tool_count > 0 then 'strong'
      when v_tool_count > 0 then 'medium'
      else 'weak'
    end
  );

  v_summary := coalesce(
    nullif(trim(v_turn.output_summary), ''),
    nullif(trim(v_turn.error_summary), ''),
    'Completed agent turn'
  );

  insert into public.skill_episodes (
    server_id,
    channel_id,
    thread_parent_id,
    task_id,
    agent_id,
    trigger_type,
    trigger_strength,
    source_refs,
    summary,
    signals
  )
  values (
    v_turn.server_id,
    v_turn.channel_id,
    v_turn.thread_parent_id,
    v_turn.task_id,
    v_turn.agent_id,
    v_trigger_type,
    v_trigger_strength,
    jsonb_build_array(jsonb_build_object('type', 'agent_turn', 'id', v_turn.id)),
    v_summary,
    jsonb_build_object(
      'tool_count', v_tool_count,
      'write_tool_count', v_write_tool_count,
      'turn_status', v_turn.status,
      'generated_from', 'agent_turn'
    )
  )
  returning id into v_episode_id;

  insert into public.skill_events (
    server_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    payload,
    evidence_refs,
    machine_key_id
  )
  values (
    v_turn.server_id,
    'skill_episode.generated_from_turn',
    zano_private.current_actor_id(),
    zano_private.current_actor_type(),
    v_summary,
    jsonb_build_object(
      'episode_id', v_episode_id,
      'turn_id', v_turn.id,
      'trigger_type', v_trigger_type,
      'trigger_strength', v_trigger_strength
    ),
    jsonb_build_array(jsonb_build_object('type', 'agent_turn', 'id', v_turn.id)),
    zano_private.current_actor_machine_key_id()
  );

  return v_episode_id;
end;
$$;

create or replace function public.skill_episode_mark_no_op(
  p_episode_id uuid default null,
  p_reason text default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_episode public.skill_episodes%rowtype;
begin
  if p_episode_id is null then
    raise exception 'episode_id is required';
  end if;

  select *
    into v_episode
    from public.skill_episodes
    where id = p_episode_id
    for update;

  if not found then
    raise exception 'skill episode % not found', p_episode_id;
  end if;

  if not zano_private.actor_is_server_member(v_episode.server_id) then
    raise exception 'actor is not a member of server %', v_episode.server_id;
  end if;

  update public.skill_episodes
    set status = 'no_op',
        reviewed_at = now()
    where id = v_episode.id;

  insert into public.skill_events (
    server_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    payload,
    evidence_refs,
    machine_key_id
  )
  values (
    v_episode.server_id,
    'skill_episode.no_op',
    zano_private.current_actor_id(),
    zano_private.current_actor_type(),
    coalesce(nullif(trim(p_reason), ''), 'No reusable skill or knowledge change needed'),
    jsonb_build_object('episode_id', v_episode.id),
    v_episode.source_refs,
    zano_private.current_actor_machine_key_id()
  );

  return v_episode.id;
end;
$$;

create or replace function public.skill_apply_candidate(
  p_candidate_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_candidate public.skill_candidates%rowtype;
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_skill_id uuid;
  v_version_id uuid;
  v_slug text;
  v_name text;
  v_description text;
  v_frontmatter jsonb := '{}'::jsonb;
  v_next_version integer;
  v_next_state text;
  v_lint_status text;
begin
  if p_candidate_id is null then
    raise exception 'candidate_id is required';
  end if;

  select *
    into v_candidate
    from public.skill_candidates
    where id = p_candidate_id
    for update;

  if not found then
    raise exception 'skill candidate % not found', p_candidate_id;
  end if;

  if not zano_private.actor_is_server_member(v_candidate.server_id) then
    raise exception 'actor is not a member of server %', v_candidate.server_id;
  end if;

  if v_candidate.state <> 'pending' then
    raise exception 'skill candidate % is not pending', p_candidate_id;
  end if;

  if v_candidate.candidate_type not in ('create', 'patch') then
    raise exception 'candidate type % cannot be applied by this RPC', v_candidate.candidate_type;
  end if;

  if v_candidate.risk_level in ('high', 'critical') then
    raise exception 'candidate risk % requires stronger policy before apply', v_candidate.risk_level;
  end if;

  perform public.skill_lint_candidate(p_candidate_id);

  select lint_status
    into v_lint_status
    from public.skill_lint_results
    where candidate_id = p_candidate_id
    order by created_at desc
    limit 1;

  if v_lint_status = 'fail' then
    update public.skill_candidates
      set state = 'rejected_by_policy',
          policy_result = jsonb_build_object(
            'decision', 'deny',
            'reason', 'candidate lint failed',
            'lint_status', v_lint_status
          )
      where id = v_candidate.id;

    insert into public.policy_evaluations (
      server_id,
      subject_type,
      subject_id,
      action,
      actor_id,
      actor_type,
      risk_level,
      inputs,
      decision,
      requirements,
      reason
    )
    values (
      v_candidate.server_id,
      'skill_candidate',
      v_candidate.id,
      'apply',
      v_actor_id,
      v_actor_type,
      v_candidate.risk_level,
      jsonb_build_object('lint_status', v_lint_status),
      'deny',
      jsonb_build_array('lint_status must not be fail'),
      'candidate lint failed'
    );

    insert into public.skill_events (
      server_id,
      skill_id,
      event_type,
      actor_id,
      actor_type,
      reason,
      payload,
      evidence_refs,
      machine_key_id
    )
    values (
      v_candidate.server_id,
      v_candidate.target_skill_id,
      'skill_candidate.rejected_by_policy',
      v_actor_id,
      v_actor_type,
      'candidate lint failed',
      jsonb_build_object('candidate_id', v_candidate.id, 'lint_status', v_lint_status),
      v_candidate.evidence_refs,
      zano_private.current_actor_machine_key_id()
    );

    return jsonb_build_object(
      'applied', false,
      'candidate_id', v_candidate.id,
      'state', 'rejected_by_policy',
      'lint_status', v_lint_status,
      'reason', 'candidate lint failed'
    );
  end if;

  if nullif(trim(coalesce(v_candidate.proposed_content, '')), '') is null then
    raise exception 'proposed_content is required';
  end if;

  v_slug := coalesce(nullif(trim(v_candidate.target_slug), ''), nullif(trim(v_candidate.classification->>'slug'), ''));
  if v_slug is null then
    raise exception 'target_slug is required';
  end if;

  v_name := coalesce(
    nullif(trim(v_candidate.classification->>'name'), ''),
    initcap(replace(v_slug, '-', ' '))
  );
  v_description := coalesce(
    nullif(trim(v_candidate.classification->>'description'), ''),
    left(v_candidate.rationale, 240)
  );

  if jsonb_typeof(v_candidate.classification->'frontmatter') = 'object' then
    v_frontmatter := v_candidate.classification->'frontmatter';
  end if;

  v_next_state := case
    when v_candidate.risk_level = 'medium' then 'probation'
    else 'active'
  end;

  if v_candidate.candidate_type = 'create' then
    if exists (
      select 1
      from public.skills
      where server_id = v_candidate.server_id
        and slug = v_slug
    ) then
      raise exception 'skill % already exists; use patch instead', v_slug;
    end if;

    insert into public.skills (
      server_id,
      slug,
      name,
      description,
      owner_actor_id,
      owner_actor_type,
      state,
      risk_level,
      created_by_id,
      created_by_type
    )
    values (
      v_candidate.server_id,
      v_slug,
      v_name,
      v_description,
      v_candidate.created_by_id,
      v_candidate.created_by_type,
      v_next_state,
      v_candidate.risk_level,
      v_actor_id,
      v_actor_type
    )
    returning id into v_skill_id;
  else
    if v_candidate.target_skill_id is not null then
      select id
        into v_skill_id
        from public.skills
        where id = v_candidate.target_skill_id
          and server_id = v_candidate.server_id
        for update;
    else
      select id
        into v_skill_id
        from public.skills
        where server_id = v_candidate.server_id
          and slug = v_slug
        for update;
    end if;

    if v_skill_id is null then
      raise exception 'target skill % not found', coalesce(v_candidate.target_skill_id::text, v_slug);
    end if;

    update public.skills
      set name = coalesce(nullif(trim(v_candidate.classification->>'name'), ''), name),
          description = coalesce(nullif(trim(v_candidate.classification->>'description'), ''), description),
          risk_level = v_candidate.risk_level,
          state = v_next_state,
          updated_at = now()
      where id = v_skill_id;
  end if;

  select coalesce(max(version_number), 0) + 1
    into v_next_version
    from public.skill_versions
    where skill_id = v_skill_id;

  insert into public.skill_versions (
    skill_id,
    server_id,
    version_number,
    content,
    frontmatter,
    content_hash,
    change_summary,
    change_reason,
    evidence_refs,
    created_by_id,
    created_by_type
  )
  values (
    v_skill_id,
    v_candidate.server_id,
    v_next_version,
    v_candidate.proposed_content,
    v_frontmatter,
    md5(v_candidate.proposed_content),
    coalesce(nullif(trim(p_reason), ''), v_candidate.rationale),
    v_candidate.rationale,
    v_candidate.evidence_refs,
    v_actor_id,
    v_actor_type
  )
  returning id into v_version_id;

  update public.skills
    set active_version_id = v_version_id,
        state = v_next_state,
        risk_level = v_candidate.risk_level,
        updated_at = now(),
        projection_version = projection_version + 1
    where id = v_skill_id;

  update public.skill_candidates
    set state = 'applied'
    where id = v_candidate.id;

  insert into public.skill_events (
    server_id,
    skill_id,
    version_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    payload,
    evidence_refs,
    machine_key_id
  )
  values (
    v_candidate.server_id,
    v_skill_id,
    v_version_id,
    'skill_candidate.applied',
    v_actor_id,
    v_actor_type,
    coalesce(nullif(trim(p_reason), ''), v_candidate.rationale),
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'candidate_type', v_candidate.candidate_type,
      'slug', v_slug,
      'version_number', v_next_version,
      'state', v_next_state
    ),
    v_candidate.evidence_refs,
    zano_private.current_actor_machine_key_id()
  );

  return jsonb_build_object(
    'applied', true,
    'skill_id', v_skill_id,
    'version_id', v_version_id,
    'version_number', v_next_version,
    'state', v_next_state
  );
end;
$$;

create or replace function public.knowledge_save(
  p_subject text default null,
  p_content text default null,
  p_kind text default 'domain_note',
  p_scope text default 'server',
  p_channel_id uuid default null,
  p_task_id uuid default null,
  p_confidence numeric default 0.7,
  p_freshness text default 'stable',
  p_expires_at timestamptz default null,
  p_source_refs jsonb default '[]'::jsonb,
  p_server_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_knowledge_id uuid;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if not zano_private.actor_is_server_member(v_server_id) then
    raise exception 'actor is not a member of server %', v_server_id;
  end if;

  if nullif(trim(coalesce(p_subject, '')), '') is null then
    raise exception 'subject is required';
  end if;

  if nullif(trim(coalesce(p_content, '')), '') is null then
    raise exception 'content is required';
  end if;

  insert into public.knowledge_items (
    server_id,
    scope,
    channel_id,
    task_id,
    subject,
    content,
    kind,
    confidence,
    freshness,
    expires_at,
    source_refs,
    created_by_id,
    created_by_type
  )
  values (
    v_server_id,
    p_scope,
    p_channel_id,
    p_task_id,
    p_subject,
    p_content,
    p_kind,
    p_confidence,
    p_freshness,
    p_expires_at,
    p_source_refs,
    v_actor_id,
    v_actor_type
  )
  returning id into v_knowledge_id;

  return v_knowledge_id;
end;
$$;

create or replace function public.agent_blueprint_create(
  p_slug text default null,
  p_display_name_template text default null,
  p_description text default null,
  p_system_prompt_template text default null,
  p_default_model text default 'opus',
  p_scope text default 'server',
  p_required_skills text[] default '{}'::text[],
  p_allowed_tools jsonb default '{}'::jsonb,
  p_spawn_policy jsonb default '{}'::jsonb,
  p_lifecycle_policy jsonb default '{}'::jsonb,
  p_server_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_blueprint_id uuid;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if not zano_private.actor_is_server_member(v_server_id) then
    raise exception 'actor is not a member of server %', v_server_id;
  end if;

  if nullif(trim(coalesce(p_slug, '')), '') is null then
    raise exception 'slug is required';
  end if;

  if nullif(trim(coalesce(p_display_name_template, '')), '') is null then
    raise exception 'display_name_template is required';
  end if;

  if nullif(trim(coalesce(p_description, '')), '') is null then
    raise exception 'description is required';
  end if;

  if nullif(trim(coalesce(p_system_prompt_template, '')), '') is null then
    raise exception 'system_prompt_template is required';
  end if;

  insert into public.agent_blueprints (
    server_id,
    slug,
    display_name_template,
    description,
    system_prompt_template,
    default_model,
    scope,
    required_skills,
    allowed_tools,
    spawn_policy,
    lifecycle_policy,
    created_by_id,
    created_by_type
  )
  values (
    v_server_id,
    p_slug,
    p_display_name_template,
    p_description,
    p_system_prompt_template,
    p_default_model,
    p_scope,
    p_required_skills,
    p_allowed_tools,
    p_spawn_policy,
    p_lifecycle_policy,
    v_actor_id,
    v_actor_type
  )
  returning id into v_blueprint_id;

  return v_blueprint_id;
end;
$$;

create or replace function public.agent_spawn_request(
  p_blueprint_id uuid default null,
  p_reason text default null,
  p_source_refs jsonb default '[]'::jsonb,
  p_policy_result jsonb default '{}'::jsonb,
  p_server_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_server_id uuid := coalesce(p_server_id, zano_private.current_actor_server_id());
  v_actor_id uuid := zano_private.current_actor_id();
  v_actor_type text := zano_private.current_actor_type();
  v_event_id uuid;
begin
  if v_server_id is null then
    raise exception 'server_id is required';
  end if;

  if not zano_private.actor_can_spawn_agent(v_server_id, p_blueprint_id) then
    raise exception 'actor cannot request spawn in server %', v_server_id;
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason is required';
  end if;

  insert into public.agent_spawn_events (
    server_id,
    blueprint_id,
    event_type,
    actor_id,
    actor_type,
    reason,
    source_refs,
    policy_result
  )
  values (
    v_server_id,
    p_blueprint_id,
    'spawn_requested',
    v_actor_id,
    v_actor_type,
    p_reason,
    p_source_refs,
    p_policy_result
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

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
security definer
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
  v_source_refs jsonb := coalesce(p_source_refs, '[]'::jsonb);
  v_creation_context jsonb := coalesce(p_creation_context, '{}'::jsonb);
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_base_name text;
  v_name text;
  v_suffix text;
  v_channel_name text;
  v_attempt integer := 0;
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

  if v_actor_id is null then
    raise exception 'actor_id is required';
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

  if jsonb_typeof(v_source_refs) <> 'array' then
    raise exception 'source_refs must be an array';
  end if;

  if jsonb_array_length(v_source_refs) = 0 then
    raise exception 'source_refs must include at least one source';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_source_refs) as source_ref(value)
    where jsonb_typeof(source_ref.value) <> 'object'
       or nullif(trim(source_ref.value->>'type'), '') is null
       or nullif(trim(source_ref.value->>'id'), '') is null
  ) then
    raise exception 'source_refs entries must include type and id';
  end if;

  if jsonb_typeof(v_creation_context) <> 'object' then
    raise exception 'creation_context must be an object';
  end if;

  if public.agent_contains_secret_like_text(v_display_name)
      or public.agent_contains_secret_like_text(p_description)
      or public.agent_contains_secret_like_text(p_system_prompt)
      or public.agent_contains_secret_like_text(v_reason)
      or public.agent_contains_secret_like_text(v_idempotency_key)
      or public.agent_contains_secret_like_text(v_source_refs::text)
      or public.agent_contains_secret_like_text(v_creation_context::text) then
    raise exception 'child agent creation fields must not contain secrets';
  end if;

  select * into v_parent
  from public.agents
  where id = coalesce(p_parent_agent_id, v_actor_id)
    and server_id = v_server_id
  for update;

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

  if v_idempotency_key is not null then
    select agent_id into v_existing
    from public.agent_spawn_events
    where server_id = v_server_id
      and actor_id = v_actor_id
      and actor_type = 'agent'
      and event_type = 'agent_created'
      and policy_result->>'idempotency_key' = v_idempotency_key
    order by created_at desc
    limit 1;

    if v_existing is not null then
      select * into v_agent
      from public.agents
      where id = v_existing
        and server_id = v_server_id
        and parent_agent_id = v_parent.id
        and created_by_id = v_actor_id
        and created_by_type = 'agent'
        and creation_source = 'agent'
        and archived_at is null;

      select * into v_channel
      from public.channels
      where server_id = v_server_id
        and type = 'dm'
        and name = 'dm-' || v_existing::text;

      if v_agent.id is null or v_channel.id is null then
        raise exception 'idempotent child agent record is incomplete';
      end if;

      insert into public.channel_members(channel_id, member_id, member_type)
      values (v_channel.id, v_parent.id, 'agent')
      on conflict do nothing;

      return jsonb_build_object(
        'created', true,
        'agent_id', v_agent.id,
        'agent_name', v_agent.name,
        'display_name', v_agent.display_name,
        'channel_id', v_channel.id,
        'parent_agent_id', v_agent.parent_agent_id,
        'idempotent', true
      );
    end if;
  end if;

  v_policy := jsonb_strip_nulls(jsonb_build_object(
    'decision', 'allow',
    'max_generation', 2,
    'max_active_children', 5,
    'max_creates_per_hour', 3,
    'idempotency_key', v_idempotency_key
  ));

  if v_parent.generation >= 2 then
    v_policy := v_policy || jsonb_build_object('decision', 'deny', 'reason', 'generation_limit');
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, v_source_refs, v_policy)
    returning id into v_event_id;

    return jsonb_build_object(
      'created', false,
      'denied', true,
      'reason', 'generation_limit',
      'parent_agent_id', v_parent.id,
      'spawn_event_id', v_event_id,
      'policy_result', v_policy
    );
  end if;

  select count(*) into v_child_count
  from public.agents
  where parent_agent_id = v_parent.id
    and archived_at is null;

  if v_child_count >= 5 then
    v_policy := v_policy || jsonb_build_object('decision', 'deny', 'reason', 'active_child_limit');
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, v_source_refs, v_policy)
    returning id into v_event_id;

    return jsonb_build_object(
      'created', false,
      'denied', true,
      'reason', 'active_child_limit',
      'parent_agent_id', v_parent.id,
      'spawn_event_id', v_event_id,
      'policy_result', v_policy
    );
  end if;

  select count(*) into v_recent_count
  from public.agent_spawn_events
  where server_id = v_server_id
    and actor_id = v_actor_id
    and actor_type = 'agent'
    and event_type = 'agent_created'
    and created_at > now() - interval '1 hour';

  if v_recent_count >= 3 then
    v_policy := v_policy || jsonb_build_object('decision', 'deny', 'reason', 'rate_limit');
    insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
    values (v_server_id, v_parent.id, 'agent_create_denied', v_actor_id, v_actor_type, v_reason, v_source_refs, v_policy)
    returning id into v_event_id;

    return jsonb_build_object(
      'created', false,
      'denied', true,
      'reason', 'rate_limit',
      'parent_agent_id', v_parent.id,
      'spawn_event_id', v_event_id,
      'policy_result', v_policy
    );
  end if;

  insert into public.agent_spawn_events(server_id, agent_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
  values (v_server_id, v_parent.id, 'agent_create_allowed', v_actor_id, v_actor_type, v_reason, v_source_refs, v_policy)
  returning id into v_event_id;

  v_base_name := substr(public.agent_safe_handle(v_display_name), 1, 60);
  v_name := v_base_name;
  v_owner_id := v_parent.owner_id;

  loop
    begin
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
        v_creation_context,
        jsonb_build_object(
          'parent_agent_id', v_parent.id,
          'created_by_id', v_actor_id,
          'created_by_type', 'agent',
          'reason', v_reason,
          'source_refs', v_source_refs
        )
      )
      returning * into v_agent;
      exit;
    exception
      when unique_violation then
        v_attempt := v_attempt + 1;
        if v_attempt > 10 then
          raise exception 'could not allocate unique agent name';
        end if;
        v_suffix := substr(md5(v_event_id::text || ':' || v_attempt::text), 1, 6);
        v_name := substr(v_base_name, 1, 53) || '-' || v_suffix;
    end;
  end loop;

  v_channel_name := 'dm-' || v_agent.id::text;

  insert into public.channels(name, description, type, server_id, created_by)
  values (v_channel_name, 'Direct chat with ' || v_display_name, 'dm', v_server_id, v_owner_id)
  returning * into v_channel;

  insert into public.channel_members(channel_id, member_id, member_type)
  values
    (v_channel.id, v_owner_id, 'human'),
    (v_channel.id, v_parent.id, 'agent'),
    (v_channel.id, v_agent.id, 'agent')
  on conflict do nothing;

  insert into public.server_members(server_id, member_id, member_type, role)
  values (v_server_id, v_agent.id, 'agent', 'member')
  on conflict do nothing;

  insert into public.agent_spawn_events(server_id, agent_id, request_event_id, event_type, actor_id, actor_type, reason, source_refs, policy_result)
  values (v_server_id, v_agent.id, v_event_id, 'agent_created', v_actor_id, v_actor_type, v_reason, v_source_refs, v_policy);

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
      'source_refs', v_source_refs,
      'creation_source', 'agent'
    ),
    'server',
    'agent-child-created:' || v_agent.id
  )
  on conflict do nothing;

  return jsonb_build_object(
    'created', true,
    'agent_id', v_agent.id,
    'agent_name', v_agent.name,
    'display_name', v_agent.display_name,
    'channel_id', v_channel.id,
    'parent_agent_id', v_parent.id,
    'spawn_event_id', v_event_id,
    'policy_result', v_policy,
    'idempotent', false
  );
end;
$$;

grant execute on function public.agent_create_child(text, text, text, text, uuid, jsonb, jsonb, uuid, text) to authenticated, anon, service_role;

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

create index if not exists idx_skills_server_state on public.skills(server_id, state);
create index if not exists idx_skills_server_slug on public.skills(server_id, slug);
create index if not exists idx_skill_versions_skill on public.skill_versions(skill_id, version_number desc);
create index if not exists idx_skill_files_skill on public.skill_files(skill_id, path);
create index if not exists idx_skill_events_server_seq on public.skill_events(server_id, event_seq);
create index if not exists idx_skill_events_skill on public.skill_events(skill_id, created_at desc);
create index if not exists idx_skill_attestations_skill on public.skill_attestations(skill_id, created_at desc);
create index if not exists idx_skill_episodes_server_status on public.skill_episodes(server_id, status, created_at desc);
create index if not exists idx_skill_candidates_server_state on public.skill_candidates(server_id, state, created_at desc);
create index if not exists idx_knowledge_items_server_state on public.knowledge_items(server_id, state, subject);
create index if not exists idx_agent_blueprints_server_state on public.agent_blueprints(server_id, state);
create index if not exists idx_agent_spawn_events_server_time on public.agent_spawn_events(server_id, created_at desc);
create unique index if not exists idx_agent_spawn_events_request_event_type
  on public.agent_spawn_events(request_event_id, event_type)
  where request_event_id is not null;
create index if not exists idx_agent_spawn_events_idempotency
  on public.agent_spawn_events(server_id, actor_id, actor_type, ((policy_result->>'idempotency_key')))
  where policy_result ? 'idempotency_key';
create index if not exists idx_agent_turns_agent_time on public.agent_turns(agent_id, started_at desc);
create index if not exists idx_agent_tool_events_turn on public.agent_tool_events(turn_id, started_at);
create index if not exists idx_policy_evaluations_subject on public.policy_evaluations(subject_type, subject_id, created_at desc);
create index if not exists idx_skill_lint_results_candidate on public.skill_lint_results(candidate_id, created_at desc);
create index if not exists idx_projection_runs_server on public.projection_runs(server_id, projection_type, started_at desc);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

alter table public.skills enable row level security;
alter table public.skill_versions enable row level security;
alter table public.skill_files enable row level security;
alter table public.skill_events enable row level security;
alter table public.skill_attestations enable row level security;
alter table public.skill_episodes enable row level security;
alter table public.skill_candidates enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.agent_blueprints enable row level security;
alter table public.agent_spawn_events enable row level security;
alter table public.agent_turns enable row level security;
alter table public.agent_tool_events enable row level security;
alter table public.policy_evaluations enable row level security;
alter table public.skill_lint_results enable row level security;
alter table public.projection_runs enable row level security;

drop policy if exists "Server actors can read skills" on public.skills;
create policy "Server actors can read skills" on public.skills
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skills" on public.skills;
create policy "Server actors can create skills" on public.skills
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can update skills" on public.skills;
create policy "Server actors can update skills" on public.skills
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read skill versions" on public.skill_versions;
create policy "Server actors can read skill versions" on public.skill_versions
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill versions" on public.skill_versions;
create policy "Server actors can create skill versions" on public.skill_versions
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can read skill files" on public.skill_files;
create policy "Server actors can read skill files" on public.skill_files
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill files" on public.skill_files;
create policy "Server actors can create skill files" on public.skill_files
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can read skill events" on public.skill_events;
create policy "Server actors can read skill events" on public.skill_events
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill events" on public.skill_events;
create policy "Server actors can create skill events" on public.skill_events
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_event_matches_current(actor_id, actor_type)
  );

drop policy if exists "Server actors can read skill attestations" on public.skill_attestations;
create policy "Server actors can read skill attestations" on public.skill_attestations
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill attestations" on public.skill_attestations;
create policy "Server actors can create skill attestations" on public.skill_attestations
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_event_matches_current(actor_id, actor_type)
  );

drop policy if exists "Server actors can read skill episodes" on public.skill_episodes;
create policy "Server actors can read skill episodes" on public.skill_episodes
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill episodes" on public.skill_episodes;
create policy "Server actors can create skill episodes" on public.skill_episodes
  for insert with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can update skill episodes" on public.skill_episodes;
create policy "Server actors can update skill episodes" on public.skill_episodes
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read skill candidates" on public.skill_candidates;
create policy "Server actors can read skill candidates" on public.skill_candidates
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill candidates" on public.skill_candidates;
create policy "Server actors can create skill candidates" on public.skill_candidates
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can update skill candidates" on public.skill_candidates;
create policy "Server actors can update skill candidates" on public.skill_candidates
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read knowledge" on public.knowledge_items;
create policy "Server actors can read knowledge" on public.knowledge_items
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create knowledge" on public.knowledge_items;
create policy "Server actors can create knowledge" on public.knowledge_items
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can update knowledge" on public.knowledge_items;
create policy "Server actors can update knowledge" on public.knowledge_items
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read agent blueprints" on public.agent_blueprints;
create policy "Server actors can read agent blueprints" on public.agent_blueprints
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create agent blueprints" on public.agent_blueprints;
create policy "Server actors can create agent blueprints" on public.agent_blueprints
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_created_by_matches_current(created_by_id, created_by_type)
  );

drop policy if exists "Server actors can update agent blueprints" on public.agent_blueprints;
create policy "Server actors can update agent blueprints" on public.agent_blueprints
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read spawn events" on public.agent_spawn_events;
create policy "Server actors can read spawn events" on public.agent_spawn_events
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create spawn events" on public.agent_spawn_events;
create policy "Server actors can create spawn events" on public.agent_spawn_events
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_event_matches_current(actor_id, actor_type)
  );

drop policy if exists "Server actors can read agent turns" on public.agent_turns;
create policy "Server actors can read agent turns" on public.agent_turns
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create agent turns" on public.agent_turns;
create policy "Server actors can create agent turns" on public.agent_turns
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.agent_event_matches_current(agent_id)
  );

drop policy if exists "Server actors can update agent turns" on public.agent_turns;
create policy "Server actors can update agent turns" on public.agent_turns
  for update using (public.actor_is_server_member(server_id))
  with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read agent tool events" on public.agent_tool_events;
create policy "Server actors can read agent tool events" on public.agent_tool_events
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create agent tool events" on public.agent_tool_events;
create policy "Server actors can create agent tool events" on public.agent_tool_events
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.agent_event_matches_current(agent_id)
  );

drop policy if exists "Server actors can read policy evaluations" on public.policy_evaluations;
create policy "Server actors can read policy evaluations" on public.policy_evaluations
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create policy evaluations" on public.policy_evaluations;
create policy "Server actors can create policy evaluations" on public.policy_evaluations
  for insert with check (
    public.actor_is_server_member(server_id)
    and public.actor_event_matches_current(actor_id, actor_type)
  );

drop policy if exists "Server actors can read skill lint results" on public.skill_lint_results;
create policy "Server actors can read skill lint results" on public.skill_lint_results
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create skill lint results" on public.skill_lint_results;
create policy "Server actors can create skill lint results" on public.skill_lint_results
  for insert with check (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can read projection runs" on public.projection_runs;
create policy "Server actors can read projection runs" on public.projection_runs
  for select using (public.actor_is_server_member(server_id));

drop policy if exists "Server actors can create projection runs" on public.projection_runs;
create policy "Server actors can create projection runs" on public.projection_runs
  for insert with check (public.actor_is_server_member(server_id));
