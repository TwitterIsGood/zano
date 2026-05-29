-- ============================================================
-- Zano Daemon Runtime Schema
-- Durable delivery, runtime session, start queue, and trace ledger.
-- Run after schema.sql, servers.sql, collaboration.sql, machine-keys.sql, and autonomous.sql.
-- ============================================================

create table if not exists public.daemon_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  source_message_id uuid not null references public.messages(id) on delete cascade,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  delivery_seq bigint not null,
  idempotency_key text not null,
  trace_id text not null,
  span_id text not null,
  traceparent text not null,
  target text not null,
  activation_strength text not null check (activation_strength in ('strong', 'medium', 'weak')),
  activation_reasons jsonb not null default '[]'::jsonb,
  state text not null check (state in (
    'planned', 'received', 'deduped', 'queued_starting', 'queued_busy', 'queued_gated',
    'queued_compaction', 'restarting_idle', 'delivering', 'delivered', 'accepted',
    'completed', 'failed', 'cancelled'
  )),
  queue_reason text check (queue_reason is null or queue_reason in (
    'agent_starting', 'agent_busy', 'gated_safe_boundary', 'compaction_boundary', 'idle_restart', 'stale_recovery'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  planned_at timestamptz not null default now(),
  received_at timestamptz,
  delivered_at timestamptz,
  accepted_at timestamptz,
  ack_traceparent text,
  last_runtime_event_at timestamptz,
  runtime_outcome text check (runtime_outcome in (
    'queued_busy',
    'queued_during_start',
    'deferred_wake_message',
    'auto_restart_from_idle',
    'rejected_no_process',
    'stdin_idle_delivery',
    'queued_stalled_recovery',
    'queued_busy_non_stdin',
    'queued_before_session',
    'queued_compaction_boundary',
    'queued_busy_gated',
    'queued_busy_notification',
    'agent_archived',
    'agent_token_removed'
  )),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists daemon_deliveries_workspace_idempotency_key_idx
  on public.daemon_deliveries(workspace_id, idempotency_key);

create unique index if not exists daemon_deliveries_workspace_agent_seq_idx
  on public.daemon_deliveries(workspace_id, agent_id, delivery_seq);

create index if not exists daemon_deliveries_workspace_source_message_idx
  on public.daemon_deliveries(workspace_id, source_message_id);

create index if not exists daemon_deliveries_workspace_agent_state_idx
  on public.daemon_deliveries(workspace_id, agent_id, state, created_at);

create index if not exists daemon_deliveries_workspace_trace_idx
  on public.daemon_deliveries(workspace_id, trace_id);

create table if not exists public.daemon_runtime_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  machine_id text not null,
  runtime text not null check (runtime in ('claude-code')),
  runtime_model text,
  session_id text,
  process_id integer,
  state text not null check (state in ('starting', 'ready', 'busy', 'gated', 'idle', 'stale', 'stopping', 'failed', 'ended')),
  prompt_hash text not null,
  wrapper_hash text,
  launch_id text,
  session_ref text,
  session_ref_reachable boolean not null default false,
  workspace_path_ref text,
  runtime_profile text,
  started_at timestamptz not null default now(),
  last_active_at timestamptz,
  idle_at timestamptz,
  ended_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.daemon_runtime_sessions
  add column if not exists launch_id text,
  add column if not exists session_ref text,
  add column if not exists session_ref_reachable boolean not null default false,
  add column if not exists workspace_path_ref text,
  add column if not exists runtime_profile text;

create index if not exists daemon_runtime_sessions_workspace_agent_state_idx
  on public.daemon_runtime_sessions(workspace_id, agent_id, state);

create index if not exists daemon_runtime_sessions_workspace_machine_idx
  on public.daemon_runtime_sessions(workspace_id, machine_id, started_at desc);

create index if not exists daemon_runtime_sessions_workspace_session_idx
  on public.daemon_runtime_sessions(workspace_id, session_id);

create table if not exists public.daemon_start_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  machine_id text not null,
  reason text not null,
  state text not null check (state in ('queued', 'starting', 'started', 'failed', 'cancelled')),
  dedupe_key text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists daemon_start_queue_workspace_dedupe_idx
  on public.daemon_start_queue(workspace_id, dedupe_key)
  where state in ('queued', 'starting');

create index if not exists daemon_start_queue_workspace_agent_state_idx
  on public.daemon_start_queue(workspace_id, agent_id, state, requested_at);

create table if not exists public.daemon_trace_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  delivery_id uuid references public.daemon_deliveries(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  event_type text not null check (event_type in ('routing', 'delivery', 'process', 'stdin', 'cli', 'recovery')),
  event_name text not null,
  severity text not null default 'info' check (severity in ('debug', 'info', 'warn', 'error')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists daemon_trace_events_workspace_trace_idx
  on public.daemon_trace_events(workspace_id, trace_id, created_at);

create index if not exists daemon_trace_events_workspace_delivery_idx
  on public.daemon_trace_events(workspace_id, delivery_id, created_at);

create index if not exists daemon_trace_events_workspace_agent_idx
  on public.daemon_trace_events(workspace_id, agent_id, created_at desc);

alter table public.daemon_deliveries enable row level security;
alter table public.daemon_runtime_sessions enable row level security;
alter table public.daemon_start_queue enable row level security;
alter table public.daemon_trace_events enable row level security;

drop policy if exists "Bridge can manage daemon deliveries" on public.daemon_deliveries;
drop policy if exists "Omni can manage daemon deliveries" on public.daemon_deliveries;
create policy "Omni can manage daemon deliveries"
  on public.daemon_deliveries
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

drop policy if exists "Server members can read daemon deliveries" on public.daemon_deliveries;
create policy "Server members can read daemon deliveries"
  on public.daemon_deliveries
  for select
  using (zano_private.actor_is_server_member(workspace_id));

drop policy if exists "Bridge can manage daemon runtime sessions" on public.daemon_runtime_sessions;
drop policy if exists "Omni can manage daemon runtime sessions" on public.daemon_runtime_sessions;
create policy "Omni can manage daemon runtime sessions"
  on public.daemon_runtime_sessions
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

drop policy if exists "Server members can read daemon runtime sessions" on public.daemon_runtime_sessions;
create policy "Server members can read daemon runtime sessions"
  on public.daemon_runtime_sessions
  for select
  using (zano_private.actor_is_server_member(workspace_id));

drop policy if exists "Bridge can manage daemon start queue" on public.daemon_start_queue;
drop policy if exists "Omni can manage daemon start queue" on public.daemon_start_queue;
create policy "Omni can manage daemon start queue"
  on public.daemon_start_queue
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

drop policy if exists "Server members can read daemon start queue" on public.daemon_start_queue;
create policy "Server members can read daemon start queue"
  on public.daemon_start_queue
  for select
  using (zano_private.actor_is_server_member(workspace_id));

drop policy if exists "Bridge can manage daemon trace events" on public.daemon_trace_events;
drop policy if exists "Omni can manage daemon trace events" on public.daemon_trace_events;
create policy "Omni can manage daemon trace events"
  on public.daemon_trace_events
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

drop policy if exists "Server members can read daemon trace events" on public.daemon_trace_events;
create policy "Server members can read daemon trace events"
  on public.daemon_trace_events
  for select
  using (event_type in ('routing', 'delivery', 'process', 'recovery') and zano_private.actor_is_server_member(workspace_id));
