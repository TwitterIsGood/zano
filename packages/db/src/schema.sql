-- ============================================================
-- Zano Database Schema
-- Run this in Supabase SQL Editor to set up your database
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------
-- Profiles (extends Supabase auth.users)
-- -----------------------------------------------------------
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  display_name text not null,
  avatar_url text,
  created_at timestamptz default now() not null
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------
-- Agents
-- -----------------------------------------------------------
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
  parent_agent_id uuid references public.agents(id) on delete restrict,
  root_agent_id uuid references public.agents(id) on delete restrict,
  creation_source text not null default 'human' check (creation_source in ('human', 'agent', 'blueprint', 'system', 'migration')),
  creation_reason text,
  creation_context jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  generation integer not null default 0 check (generation >= 0),
  archived_at timestamptz,
  created_at timestamptz default now() not null,
  unique(server_id, name)
);

create index if not exists idx_agents_server_parent_created
  on public.agents(server_id, parent_agent_id, created_at);

create index if not exists idx_agents_server_root
  on public.agents(server_id, root_agent_id);

create index if not exists idx_agents_server_creator
  on public.agents(server_id, created_by_id, created_by_type);

create index if not exists idx_agents_server_archived
  on public.agents(server_id, archived_at);

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

create or replace function public.ensure_agent_lineage_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_record public.agents%rowtype;
  is_archive_transition boolean := false;
  is_archival_cleanup boolean := false;
begin
  if tg_op = 'UPDATE' then
    is_archive_transition :=
      old.archived_at is null
      and new.archived_at is not null;
    is_archival_cleanup :=
      is_archive_transition
      and old.parent_agent_id is not distinct from new.parent_agent_id
      and old.server_id is not distinct from new.server_id
      and old.root_agent_id is not distinct from new.root_agent_id
      and old.generation is not distinct from new.generation;

    if is_archive_transition and not is_archival_cleanup then
      raise exception 'Cannot change lineage while archiving agent';
    end if;

    if is_archive_transition and old.parent_agent_id is null then
      raise exception 'Cannot archive root agent';
    end if;

    if is_archive_transition and exists (
      select 1
      from public.agents child
      where child.parent_agent_id = old.id
        and child.archived_at is null
    ) then
      raise exception 'Archive child agents first';
    end if;
  end if;

  if new.parent_agent_id is null then
    new.generation := 0;
    new.root_agent_id := new.id;
    return new;
  end if;

  if new.parent_agent_id = new.id then
    raise exception 'agent cannot be its own parent';
  end if;

  select * into parent_record
  from public.agents
  where id = new.parent_agent_id
  for update;

  if parent_record.id is null then
    raise exception 'parent agent does not exist';
  end if;

  if exists (
    with recursive ancestors(id, parent_agent_id, path) as (
      select id, parent_agent_id, array[id]
      from public.agents
      where id = new.parent_agent_id

      union all

      select agents.id, agents.parent_agent_id, ancestors.path || agents.id
      from public.agents agents
      join ancestors on agents.id = ancestors.parent_agent_id
      where agents.id <> all(ancestors.path)
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'agent lineage cannot contain cycles';
  end if;

  if parent_record.server_id <> new.server_id then
    raise exception 'parent agent must be in the same server';
  end if;

  if parent_record.archived_at is not null and not is_archival_cleanup then
    raise exception 'parent agent is archived';
  end if;

  if is_archival_cleanup then
    return new;
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
before insert or update of parent_agent_id, server_id, archived_at, root_agent_id, generation on public.agents
for each row execute function public.ensure_agent_lineage_integrity();

create or replace function public.prevent_agent_lineage_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.parent_agent_id is not null then
    raise exception 'Cannot delete child agent. Archive child agents instead.';
  end if;

  if exists (
    select 1
    from public.agents child
    where child.parent_agent_id = old.id
       or (child.root_agent_id = old.id and child.id <> old.id)
  ) then
    raise exception 'Cannot delete agent with child agents';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_agents_prevent_lineage_delete on public.agents;
create trigger trg_agents_prevent_lineage_delete
before delete on public.agents
for each row execute function public.prevent_agent_lineage_delete();

-- -----------------------------------------------------------
-- Channels
-- -----------------------------------------------------------
create table public.channels (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  description text,
  type text default 'public' check (type in ('public', 'private', 'dm')),
  created_by uuid references public.profiles(id) on delete set null,
  server_id uuid references public.servers(id) on delete cascade not null,
  created_at timestamptz default now() not null,
  unique(server_id, name)
);

-- -----------------------------------------------------------
-- Channel Members
-- -----------------------------------------------------------
create table public.channel_members (
  channel_id uuid references public.channels(id) on delete cascade,
  member_id uuid not null,
  member_type text not null check (member_type in ('human', 'agent')),
  joined_at timestamptz default now() not null,
  primary key (channel_id, member_id)
);

-- -----------------------------------------------------------
-- Messages
-- -----------------------------------------------------------
create table public.messages (
  id uuid default uuid_generate_v4() primary key,
  channel_id uuid references public.channels(id) on delete cascade not null,
  sender_id uuid not null,
  sender_type text not null check (sender_type in ('human', 'agent', 'system')),
  content text not null,
  seq bigint,
  thread_parent_id uuid references public.messages(id) on delete cascade,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Auto-assign per-channel sequential number on insert
create or replace function assign_message_seq()
returns trigger as $$
begin
  select coalesce(max(seq), 0) + 1 into new.seq
  from public.messages where channel_id = new.channel_id;
  return new;
end;
$$ language plpgsql;

create trigger trg_message_seq
before insert on public.messages
for each row execute function assign_message_seq();

create index idx_messages_channel on public.messages(channel_id, created_at desc);
create index idx_messages_channel_seq on public.messages(channel_id, seq desc);
create index idx_messages_thread on public.messages(thread_parent_id, created_at asc);

create or replace function public.delete_root_agent(target_agent_id uuid, expected_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_parent_agent_id uuid;
  dm_channel_ids uuid[] := '{}'::uuid[];
begin
  if auth.jwt()->>'role' is distinct from 'service_role' and auth.uid() is distinct from expected_owner_id then
    raise exception 'Agent not found';
  end if;

  select parent_agent_id into target_parent_agent_id
  from public.agents
  where id = target_agent_id
    and owner_id = expected_owner_id
  for update;

  if not found then
    raise exception 'Agent not found';
  end if;

  if target_parent_agent_id is not null then
    raise exception 'Cannot delete child agent. Archive child agents instead.';
  end if;

  select coalesce(array_agg(ch.id), '{}'::uuid[]) into dm_channel_ids
  from public.channel_members cm
  join public.channels ch on ch.id = cm.channel_id
  where cm.member_id = target_agent_id
    and cm.member_type = 'agent'
    and ch.type = 'dm';

  delete from public.agents
  where id = target_agent_id
    and owner_id = expected_owner_id;

  delete from public.messages
  where channel_id = any(dm_channel_ids);

  delete from public.channel_members
  where channel_id = any(dm_channel_ids);

  delete from public.channels
  where id = any(dm_channel_ids);

  delete from public.channel_members
  where member_id = target_agent_id
    and member_type = 'agent';
end;
$$;

revoke all on function public.delete_root_agent(uuid, uuid) from public;
grant execute on function public.delete_root_agent(uuid, uuid) to service_role;

-- -----------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------
create table public.tasks (
  id uuid default uuid_generate_v4() primary key,
  message_id uuid references public.messages(id) on delete cascade not null unique,
  channel_id uuid references public.channels(id) on delete cascade not null,
  task_number serial,
  status text default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'in_review', 'changes_requested', 'done', 'archived')),
  assignee_id uuid,
  assignee_type text check (assignee_type in ('human', 'agent')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_tasks_channel on public.tasks(channel_id, task_number);

-- -----------------------------------------------------------
-- Reminders
-- -----------------------------------------------------------
create table public.reminders (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid references public.servers(id) on delete cascade not null,
  created_by_id uuid not null,
  created_by_type text not null check (created_by_type in ('human', 'agent', 'system')),
  recipient_id uuid not null,
  recipient_type text not null check (recipient_type in ('human', 'agent')),
  channel_id uuid references public.channels(id) on delete cascade not null,
  source_message_id uuid references public.messages(id) on delete set null,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  target text not null,
  body text not null,
  due_at timestamptz not null,
  snoozed_until timestamptz,
  state text default 'pending' not null check (state in ('pending', 'snoozed', 'firing', 'fired', 'completed', 'cancelled', 'failed')),
  fired_at timestamptz,
  fired_delivery_id uuid,
  cancelled_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb default '{}' not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_reminders_server_due on public.reminders(server_id, state, due_at);
create index idx_reminders_recipient_due on public.reminders(recipient_id, recipient_type, state, due_at);
create index idx_reminders_channel on public.reminders(channel_id, created_at desc);
create index idx_reminders_task on public.reminders(task_id, created_at desc);

-- -----------------------------------------------------------
-- Row Level Security (RLS)
-- -----------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.agents enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.tasks enable row level security;
alter table public.reminders enable row level security;

-- Profiles: users can read all, update own
create policy "Profiles are viewable by everyone" on public.profiles for select using (true);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Agents: owner can create/update, others can read
create policy "Agents are viewable by everyone" on public.agents for select using (true);
create policy "Owner can insert agents" on public.agents for insert with check (auth.uid() = owner_id);
create policy "Owner can update own agents" on public.agents for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create or replace function public.auth_actor_is_not_archived_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.agents
    where id = auth.uid()
      and archived_at is not null
  );
$$;

-- Channels: members can read, creator can manage
create policy "Channel members can view channels" on public.channels for select using (
  public.auth_actor_is_not_archived_agent()
  and (
    type = 'public' or
    exists (
      select 1 from public.channel_members
      where channel_id = id and member_id = auth.uid()
    )
  )
);
create policy "Authenticated users can create channels" on public.channels for insert with check (auth.uid() = created_by);

-- Channel members: members can view
create policy "Members can view channel membership" on public.channel_members for select using (
  public.auth_actor_is_not_archived_agent()
  and exists (
    select 1 from public.channel_members cm
    where cm.channel_id = channel_members.channel_id and cm.member_id = auth.uid()
  )
);

-- Messages: channel members can read and write
create policy "Channel members can view messages" on public.messages for select using (
  public.auth_actor_is_not_archived_agent()
  and exists (
    select 1 from public.channel_members
    where channel_id = messages.channel_id and member_id = auth.uid()
  )
);
create policy "Channel members can send messages" on public.messages for insert with check (
  auth.uid() = sender_id and
  public.auth_actor_is_not_archived_agent() and
  exists (
    select 1 from public.channel_members
    where channel_id = messages.channel_id and member_id = auth.uid()
  )
);

-- Tasks: same as messages
create policy "Channel members can view tasks" on public.tasks for select using (
  public.auth_actor_is_not_archived_agent()
  and exists (
    select 1 from public.channel_members
    where channel_id = tasks.channel_id and member_id = auth.uid()
  )
);
create policy "Channel members can manage tasks" on public.tasks for all using (
  public.auth_actor_is_not_archived_agent() and
  exists (
    select 1 from public.channel_members
    where channel_id = tasks.channel_id and member_id = auth.uid()
  )
);

create policy "Reminder participants can view" on public.reminders for select using (
  public.auth_actor_is_not_archived_agent()
  and (
    created_by_id = auth.uid()
    or recipient_id = auth.uid()
    or exists (
      select 1 from public.channel_members cm
      where cm.channel_id = reminders.channel_id
        and cm.member_id = auth.uid()
    )
    or (
      auth.jwt()->>'scope' = 'bridge'
      and auth.jwt()->>'server_id' = reminders.server_id::text
    )
  )
);

create policy "Reminder creators can insert" on public.reminders for insert with check (
  created_by_id = auth.uid()
  and public.auth_actor_is_not_archived_agent()
  and exists (
    select 1 from public.channel_members cm
    where cm.channel_id = reminders.channel_id
      and cm.member_id = auth.uid()
  )
);

create policy "Reminder participants can update" on public.reminders for update using (
  (
    public.auth_actor_is_not_archived_agent()
    and (created_by_id = auth.uid() or recipient_id = auth.uid())
  )
  or (
    auth.jwt()->>'scope' = 'bridge'
    and auth.jwt()->>'server_id' = reminders.server_id::text
  )
) with check (
  (
    public.auth_actor_is_not_archived_agent()
    and (created_by_id = auth.uid() or recipient_id = auth.uid())
  )
  or (
    auth.jwt()->>'scope' = 'bridge'
    and auth.jwt()->>'server_id' = reminders.server_id::text
  )
);

-- -----------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------
-- Enable realtime for messages, agents, and channel_members tables
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.channel_members;
do $$
begin
  alter publication supabase_realtime add table public.reminders;
exception when duplicate_object then null;
end $$;
