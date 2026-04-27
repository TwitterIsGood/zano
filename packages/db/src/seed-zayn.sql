-- Seed Onboarding Agent + DM for existing user Zayn
DO $$
DECLARE
  zayn_id uuid := '83cb0b96-efa7-4a3f-aa11-cbd612e946c7';
  agent_id uuid := uuid_generate_v4();
  dm_channel_id uuid := uuid_generate_v4();
BEGIN
  -- Skip if Zayn already has an onboarding agent
  IF EXISTS (SELECT 1 FROM public.agents WHERE owner_id = zayn_id AND is_default = true) THEN
    RAISE NOTICE 'Onboarding agent already exists for Zayn';
    RETURN;
  END IF;

  -- Create Onboarding Agent
  INSERT INTO public.agents (id, name, display_name, description, system_prompt, status, owner_id, is_default)
  VALUES (
    agent_id,
    'onboarding-' || substr(zayn_id::text, 1, 8),
    'Onboarding Assistant',
    'Your guide to setting up Zano. Ask me anything!',
    'You are the Onboarding Assistant for Zano. Your job is to welcome the user, ask them about their work and goals, understand what kind of AI agents would be most helpful to them, and guide them through creating their first custom agents. Be warm, curious, and helpful. Ask one question at a time. After gathering enough context (role, projects, needs), suggest creating specialized agents and help configure them.',
    'active',
    zayn_id,
    true
  );

  -- Create DM channel
  INSERT INTO public.channels (id, name, description, type, created_by)
  VALUES (
    dm_channel_id,
    'Onboarding Assistant',
    'Your onboarding guide',
    'dm',
    zayn_id
  );

  -- Add members
  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (dm_channel_id, zayn_id, 'human');

  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (dm_channel_id, agent_id, 'agent');

  -- Send welcome message
  INSERT INTO public.messages (channel_id, sender_id, sender_type, content)
  VALUES (
    dm_channel_id,
    agent_id,
    'agent',
    E'Hey Zayn! \U0001F44B Welcome to Zano!\n\nI''m your Onboarding Assistant. I''m here to help you set up your workspace and create AI agents tailored to your needs.\n\nTo get started, could you tell me a bit about yourself? What kind of work do you do, and what would you like AI agents to help you with?'
  );

  RAISE NOTICE 'Created onboarding agent and DM for Zayn';
END $$;
