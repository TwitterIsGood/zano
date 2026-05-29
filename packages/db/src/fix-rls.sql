-- Fix RLS policies to avoid circular dependency issues

-- Helper function to check channel membership without circular RLS dependency
CREATE OR REPLACE FUNCTION public.user_is_channel_member(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.channel_members
    WHERE channel_id = channel_uuid AND member_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

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

-- Channel members: users can see ALL members of channels they belong to
DROP POLICY IF EXISTS "Members can view channel membership" ON public.channel_members;
DROP POLICY IF EXISTS "Users can view own channel memberships" ON public.channel_members;
CREATE POLICY "Users can view channel memberships"
  ON public.channel_members FOR SELECT
  USING (
    public.auth_actor_is_not_archived_agent()
    AND public.user_is_channel_member(channel_id)
  );

-- Also allow inserting members (for channel creation flow)
DROP POLICY IF EXISTS "Users can add channel members" ON public.channel_members;
CREATE POLICY "Users can add channel members"
  ON public.channel_members FOR INSERT
  WITH CHECK (public.auth_actor_is_not_archived_agent());

-- Channels: simplify - authenticated users can see public channels and channels they're in
DROP POLICY IF EXISTS "Channel members can view channels" ON public.channels;
CREATE POLICY "Users can view their channels"
  ON public.channels FOR SELECT
  USING (
    public.auth_actor_is_not_archived_agent()
    AND (
      type = 'public'
      OR created_by = auth.uid()
      OR id IN (
        SELECT channel_id FROM public.channel_members WHERE member_id = auth.uid()
      )
    )
  );

-- Messages: users can see messages in channels they're members of
DROP POLICY IF EXISTS "Channel members can view messages" ON public.messages;
CREATE POLICY "Users can view messages in their channels"
  ON public.messages FOR SELECT
  USING (
    public.auth_actor_is_not_archived_agent()
    AND channel_id IN (
      SELECT channel_id FROM public.channel_members WHERE member_id = auth.uid()
    )
  );

-- Messages: users can send messages in channels they're members of
DROP POLICY IF EXISTS "Channel members can send messages" ON public.messages;
CREATE POLICY "Users can send messages in their channels"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND public.auth_actor_is_not_archived_agent()
    AND channel_id IN (
      SELECT channel_id FROM public.channel_members WHERE member_id = auth.uid()
    )
  );

-- Agents: ensure owner can see their own agents
DROP POLICY IF EXISTS "Agents are viewable by everyone" ON public.agents;
CREATE POLICY "Agents are viewable by everyone"
  ON public.agents FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Owner can manage agents" ON public.agents;
DROP POLICY IF EXISTS "Owner can manage own agents" ON public.agents;
DROP POLICY IF EXISTS "Owner can insert agents" ON public.agents;
DROP POLICY IF EXISTS "Owner can update own agents" ON public.agents;
CREATE POLICY "Owner can insert agents"
  ON public.agents FOR INSERT
  WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owner can update own agents"
  ON public.agents FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);
