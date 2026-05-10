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
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_update_thread_parent_counts on public.messages;
create trigger trg_update_thread_parent_counts
after insert on public.messages
for each row execute function public.update_thread_parent_counts();

with reply_stats as (
  select thread_parent_id, count(*)::integer as reply_count, max(created_at) as last_reply_at
  from public.messages
  where thread_parent_id is not null
  group by thread_parent_id
)
update public.messages parent
set reply_count = reply_stats.reply_count,
    last_reply_at = reply_stats.last_reply_at,
    updated_at = now()
from reply_stats
where parent.id = reply_stats.thread_parent_id;

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
-- NOTE: task_events is append-only audit data.
-- Rows are inserted exclusively by trusted server-side helpers / service-role tokens,
-- never by arbitrary client requests. No INSERT/UPDATE/DELETE policies are intentional.

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
-- NOTE: notifications are created only by trusted server-side routes / service-role helpers.
-- Client access is limited to recipients reading and marking their own notifications.

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
