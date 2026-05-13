-- ============================================================
-- Member Activity Events — Unified activity feed
-- Records events across messages, threads, tasks, agents,
-- memberships, and more for a server-wide activity timeline.
-- ============================================================

-- -----------------------------------------------------------
-- Step 1: Activity table
-- -----------------------------------------------------------

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

-- -----------------------------------------------------------
-- Step 2: Indexes
-- -----------------------------------------------------------

create index if not exists idx_member_activity_server_time on public.member_activity_events(server_id, occurred_at desc);
create index if not exists idx_member_activity_actor_time on public.member_activity_events(actor_type, actor_id, occurred_at desc);
create index if not exists idx_member_activity_channel_time on public.member_activity_events(channel_id, occurred_at desc);
create index if not exists idx_member_activity_task_time on public.member_activity_events(task_id, occurred_at desc);
create index if not exists idx_member_activity_agent_time on public.member_activity_events(agent_id, occurred_at desc);
create index if not exists idx_member_activity_event_time on public.member_activity_events(event_type, occurred_at desc);

-- -----------------------------------------------------------
-- Step 3: RLS select policies
-- -----------------------------------------------------------

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

-- NOTE: No client INSERT / UPDATE / DELETE policies.
-- All writes go through security definer helpers or triggers below.

-- -----------------------------------------------------------
-- Step 4: record_member_activity() helper (security definer)
-- -----------------------------------------------------------

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
    case when jsonb_typeof(payload->'metadata') = 'object' then payload->'metadata' else '{}'::jsonb end,
    coalesce(payload->>'visibility', 'server'),
    payload->>'dedupe_key',
    coalesce(nullif(payload->>'occurred_at', '')::timestamptz, now())
  )
  on conflict (dedupe_key) do nothing;
end;
$$;

-- Revoke client-side execution; only triggers/service roles may call this
revoke execute on function public.record_member_activity(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------
-- Step 5: Message activity triggers
-- -----------------------------------------------------------

create or replace function public.record_message_activity()
returns trigger as $$
declare
  v_channel_type text;
  v_server_id uuid;
  v_visibility text;
  v_dedupe_key text;
  v_event_type text;
  v_subject_type text;
  v_subject_id uuid;
  v_metadata jsonb;
  v_actor_id uuid;
  v_actor_type text;
begin
  -- Resolve channel context once
  select c.type, c.server_id into v_channel_type, v_server_id
  from public.channels c where c.id = new.channel_id;

  -- Visibility based on channel type
  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  if tg_op = 'INSERT' then
    if new.thread_parent_id is null then
      -- Regular message sent
      v_event_type := 'message.sent';
      v_subject_type := 'message';
      v_subject_id := new.id;
      v_dedupe_key := 'message:' || new.id::text || ':sent';
      v_metadata := jsonb_build_object(
        'channel_type', coalesce(v_channel_type, 'unknown'),
        'sender_type', new.sender_type
      );
      perform public.record_member_activity(jsonb_build_object(
        'server_id', v_server_id,
        'channel_id', new.channel_id,
        'actor_id', new.sender_id,
        'actor_type', new.sender_type,
        'event_type', v_event_type,
        'subject_type', v_subject_type,
        'subject_id', v_subject_id,
        'message_id', new.id,
        'visibility', v_visibility,
        'dedupe_key', v_dedupe_key,
        'metadata', v_metadata,
        'occurred_at', coalesce(new.created_at, now())
      ));
    else
      -- Thread reply
      v_event_type := 'thread.replied';
      v_subject_type := 'thread';
      v_subject_id := new.thread_parent_id;
      v_dedupe_key := 'thread:' || new.id::text || ':replied';
      v_metadata := jsonb_build_object(
        'channel_type', coalesce(v_channel_type, 'unknown'),
        'sender_type', new.sender_type,
        'thread_parent_id', new.thread_parent_id
      );
      perform public.record_member_activity(jsonb_build_object(
        'server_id', v_server_id,
        'channel_id', new.channel_id,
        'actor_id', new.sender_id,
        'actor_type', new.sender_type,
        'event_type', v_event_type,
        'subject_type', v_subject_type,
        'subject_id', v_subject_id,
        'message_id', new.id,
        'thread_parent_id', new.thread_parent_id,
        'visibility', v_visibility,
        'dedupe_key', v_dedupe_key,
        'metadata', v_metadata,
        'occurred_at', coalesce(new.created_at, now())
      ));
    end if;

  elsif tg_op = 'UPDATE' then
    -- Thread resolution state change
    if old.thread_resolved_at is distinct from new.thread_resolved_at then
      if old.thread_resolved_at is null and new.thread_resolved_at is not null then
        -- Thread resolved
        v_event_type := 'thread.resolved';
        v_dedupe_key := 'thread:' || new.id::text || ':resolved:' ||
                        extract(epoch from new.thread_resolved_at)::text;
      elsif old.thread_resolved_at is not null and new.thread_resolved_at is null then
        -- Thread reopened
        v_event_type := 'thread.reopened';
        v_dedupe_key := 'thread:' || new.id::text || ':reopened:' ||
                        extract(epoch from now())::text;
      else
        -- Timestamp changed but still resolved; skip to avoid noise
        return new;
      end if;

      if new.thread_resolved_by is not null and new.thread_resolved_by_type is not null then
        v_actor_id := new.thread_resolved_by;
        v_actor_type := new.thread_resolved_by_type;
      else
        v_actor_id := new.sender_id;
        v_actor_type := new.sender_type;
      end if;

      v_metadata := jsonb_build_object(
        'channel_type', coalesce(v_channel_type, 'unknown'),
        'resolved_by', case when new.thread_resolved_by is not null and new.thread_resolved_by_type is not null then new.thread_resolved_by else null end,
        'resolved_by_type', case when new.thread_resolved_by is not null and new.thread_resolved_by_type is not null then new.thread_resolved_by_type else null end
      );

      perform public.record_member_activity(jsonb_build_object(
        'server_id', v_server_id,
        'channel_id', new.channel_id,
        'actor_id', v_actor_id,
        'actor_type', v_actor_type,
        'event_type', v_event_type,
        'subject_type', 'thread',
        'subject_id', new.id,
        'thread_parent_id', new.id,
        'visibility', v_visibility,
        'dedupe_key', v_dedupe_key,
        'metadata', v_metadata,
        'summary', case when v_event_type = 'thread.resolved' then 'Thread resolved'
                       else 'Thread reopened' end,
        'occurred_at', now()
      ));
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_message_activity on public.messages;
create trigger trg_activity_message_activity
after insert or update of thread_resolved_at on public.messages
for each row execute function public.record_message_activity();

-- -----------------------------------------------------------
-- Step 6: Membership triggers
-- -----------------------------------------------------------

-- Channel joined
create or replace function public.record_channel_joined()
returns trigger as $$
declare
  v_channel_type text;
  v_server_id uuid;
  v_visibility text;
begin
  select c.type, c.server_id into v_channel_type, v_server_id
  from public.channels c where c.id = new.channel_id;

  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  perform public.record_member_activity(jsonb_build_object(
    'server_id', v_server_id,
    'channel_id', new.channel_id,
    'actor_id', new.member_id,
    'actor_type', new.member_type,
    'event_type', 'channel.joined',
    'subject_type', 'channel',
    'subject_id', new.channel_id,
    'visibility', v_visibility,
    'dedupe_key', 'channel_joined:' || new.channel_id::text || ':' || new.member_id::text,
    'metadata', jsonb_build_object('channel_type', coalesce(v_channel_type, 'unknown')),
    'occurred_at', coalesce(new.joined_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_channel_joined on public.channel_members;
create trigger trg_activity_channel_joined
after insert on public.channel_members
for each row execute function public.record_channel_joined();

-- Server joined
create or replace function public.record_server_joined()
returns trigger as $$
begin
  perform public.record_member_activity(jsonb_build_object(
    'server_id', new.server_id,
    'actor_id', new.member_id,
    'actor_type', new.member_type,
    'event_type', 'server.joined',
    'subject_type', 'server',
    'subject_id', new.server_id,
    'visibility', 'server',
    'dedupe_key', 'server_joined:' || new.server_id::text || ':' || new.member_id::text,
    'metadata', jsonb_build_object('role', new.role),
    'occurred_at', coalesce(new.joined_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_server_joined on public.server_members;
create trigger trg_activity_server_joined
after insert on public.server_members
for each row execute function public.record_server_joined();

-- -----------------------------------------------------------
-- Step 7: Task history triggers
-- -----------------------------------------------------------

-- Task commented
create or replace function public.record_task_commented()
returns trigger as $$
declare
  v_server_id uuid;
  v_ch uuid;
  v_channel_type text;
  v_visibility text;
begin
  select t.channel_id into v_ch
  from public.tasks t where t.id = new.task_id;

  -- Derive server_id and visibility from the task's channel
  select c.server_id, c.type into v_server_id, v_channel_type
  from public.channels c where c.id = v_ch;

  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  perform public.record_member_activity(jsonb_build_object(
    'server_id', v_server_id,
    'channel_id', v_ch,
    'task_id', new.task_id,
    'actor_id', new.author_id,
    'actor_type', new.author_type,
    'event_type', 'task.commented',
    'subject_type', 'task',
    'subject_id', new.task_id,
    'visibility', v_visibility,
    'dedupe_key', 'task_comment:' || new.id::text,
    'summary', left(coalesce(new.content, ''), 120),
    'occurred_at', coalesce(new.created_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_task_commented on public.task_comments;
create trigger trg_activity_task_commented
after insert on public.task_comments
for each row execute function public.record_task_commented();

-- Task artifact added
create or replace function public.record_task_artifact_added()
returns trigger as $$
declare
  v_server_id uuid;
  v_ch uuid;
  v_channel_type text;
  v_visibility text;
begin
  select t.channel_id into v_ch
  from public.tasks t where t.id = new.task_id;

  select c.server_id, c.type into v_server_id, v_channel_type
  from public.channels c where c.id = v_ch;

  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  perform public.record_member_activity(jsonb_build_object(
    'server_id', v_server_id,
    'channel_id', v_ch,
    'task_id', new.task_id,
    'actor_id', new.created_by_id,
    'actor_type', new.created_by_type,
    'event_type', 'task.artifact_added',
    'subject_type', 'task',
    'subject_id', new.task_id,
    'visibility', v_visibility,
    'dedupe_key', 'task_artifact:' || new.id::text,
    'summary', new.title || ' (' || new.artifact_type || ')',
    'metadata', jsonb_build_object('artifact_type', new.artifact_type, 'title', new.title, 'url', new.url),
    'occurred_at', coalesce(new.created_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_task_artifact_added on public.task_artifacts;
create trigger trg_activity_task_artifact_added
after insert on public.task_artifacts
for each row execute function public.record_task_artifact_added();

-- Task reviewed
create or replace function public.record_task_reviewed()
returns trigger as $$
declare
  v_server_id uuid;
  v_ch uuid;
  v_channel_type text;
  v_visibility text;
begin
  select t.channel_id into v_ch
  from public.tasks t where t.id = new.task_id;

  select c.server_id, c.type into v_server_id, v_channel_type
  from public.channels c where c.id = v_ch;

  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  perform public.record_member_activity(jsonb_build_object(
    'server_id', v_server_id,
    'channel_id', v_ch,
    'task_id', new.task_id,
    'actor_id', new.reviewer_id,
    'actor_type', new.reviewer_type,
    'event_type', 'task.reviewed',
    'subject_type', 'task',
    'subject_id', new.task_id,
    'visibility', v_visibility,
    'dedupe_key', 'task_review:' || new.id::text,
    'summary', new.verdict || ': ' || left(coalesce(new.summary, ''), 100),
    'metadata', jsonb_build_object('review_type', new.review_type, 'verdict', new.verdict),
    'occurred_at', coalesce(new.created_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_task_reviewed on public.task_reviews;
create trigger trg_activity_task_reviewed
after insert on public.task_reviews
for each row execute function public.record_task_reviewed();

-- Task verified
create or replace function public.record_task_verified()
returns trigger as $$
declare
  v_server_id uuid;
  v_ch uuid;
  v_channel_type text;
  v_visibility text;
begin
  select t.channel_id into v_ch
  from public.tasks t where t.id = new.task_id;

  select c.server_id, c.type into v_server_id, v_channel_type
  from public.channels c where c.id = v_ch;

  case v_channel_type
    when 'dm' then v_visibility := 'dm';
    else v_visibility := 'channel';
  end case;

  perform public.record_member_activity(jsonb_build_object(
    'server_id', v_server_id,
    'channel_id', v_ch,
    'task_id', new.task_id,
    'actor_id', new.actor_id,
    'actor_type', new.actor_type,
    'event_type', 'task.verified',
    'subject_type', 'task',
    'subject_id', new.task_id,
    'visibility', v_visibility,
    'dedupe_key', 'task_verification:' || new.id::text,
    'summary', case when new.passed then 'Verification passed' else 'Verification failed' end
               || ': ' || left(coalesce(new.output_summary, ''), 100),
    'metadata', jsonb_build_object(
      'verification_type', new.verification_type,
      'passed', new.passed,
      'step_id', new.step_id
    ),
    'occurred_at', coalesce(new.created_at, now())
  ));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_task_verified on public.task_verifications;
create trigger trg_activity_task_verified
after insert on public.task_verifications
for each row execute function public.record_task_verified();

-- -----------------------------------------------------------
-- Step 8: Agent status change trigger
-- -----------------------------------------------------------

create or replace function public.record_agent_status_changed()
returns trigger as $$
begin
  if old.status is distinct from new.status then
    perform public.record_member_activity(jsonb_build_object(
      'server_id', new.server_id,
      'agent_id', new.id,
      'actor_id', new.id,
      'actor_type', 'agent',
      'event_type', 'agent.status_changed',
      'subject_type', 'agent',
      'subject_id', new.id,
      'visibility', 'server',
      'dedupe_key', 'agent_status:' || new.id::text || ':' || coalesce(new.status, 'unknown') || ':' ||
                    extract(epoch from now())::text,
      'summary', coalesce(old.status, 'unknown') || ' → ' || coalesce(new.status, 'unknown'),
      'metadata', jsonb_build_object('old_status', coalesce(old.status, 'unknown'), 'new_status', coalesce(new.status, 'unknown')),
      'occurred_at', now()
    ));
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_activity_agent_status_changed on public.agents;
create trigger trg_activity_agent_status_changed
after update of status on public.agents
for each row execute function public.record_agent_status_changed();

-- -----------------------------------------------------------
-- Step 9: Bridge activity insert policy
-- -----------------------------------------------------------

drop policy if exists "Bridge can insert agent runtime activity" on public.member_activity_events;
create policy "Bridge can insert agent runtime activity"
  on public.member_activity_events for insert
  to authenticated
  with check (
    actor_type = 'agent'
    and agent_id = actor_id
    and channel_id is null
    and message_id is null
    and thread_parent_id is null
    and task_id is null
    and subject_type is null
    and subject_id is null
    and target_type is null
    and target_id is null
    and visibility = 'server'
    and event_type in (
      'agent.started',
      'agent.received_message',
      'agent.thinking',
      'agent.working',
      'agent.working_silently',
      'agent.observing',
      'agent.blocked',
      'agent.tool_use',
      'agent.output',
      'agent.idle',
      'agent.error',
      'agent.disconnected'
    )
    and exists (
      select 1
      from public.agents a
      where a.id = actor_id
        and a.owner_id = auth.uid()
        and a.server_id = member_activity_events.server_id
    )
  );

-- -----------------------------------------------------------
-- Step 10: Realtime publication
-- -----------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.member_activity_events;
exception
  when duplicate_object then null;
end $$;
