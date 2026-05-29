import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "src", "schema.sql"), "utf8");
const fixRls = readFileSync(join(__dirname, "..", "src", "fix-rls.sql"), "utf8");
const machineKeys = readFileSync(join(__dirname, "..", "src", "machine-keys.sql"), "utf8");
const collaboration = readFileSync(join(__dirname, "..", "src", "collaboration.sql"), "utf8");
const autonomous = readFileSync(join(__dirname, "..", "src", "autonomous.sql"), "utf8");
const daemon = readFileSync(join(__dirname, "..", "src", "daemon.sql"), "utf8");

const lineageFunction = schema.match(/create or replace function public\.ensure_agent_lineage_integrity\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
const deleteGuardFunction = schema.match(/create or replace function public\.prevent_agent_lineage_delete\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
const deleteRootAgentFunction = schema.match(/create or replace function public\.delete_root_agent\([\s\S]*?\$\$;/)?.[0] ?? "";
const viewChannelsPolicy = schema.match(/create policy "Channel members can view channels" on public\.channels for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const viewChannelMembersPolicy = schema.match(/create policy "Members can view channel membership" on public\.channel_members for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const viewMessagesPolicy = schema.match(/create policy "Channel members can view messages" on public\.messages for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const viewTasksPolicy = schema.match(/create policy "Channel members can view tasks" on public\.tasks for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const viewRemindersPolicy = schema.match(/create policy "Reminder participants can view" on public\.reminders for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const sendMessagesPolicy = schema.match(/create policy "Channel members can send messages" on public\.messages for insert with check \([\s\S]*?\n\);/)?.[0] ?? "";
const manageTasksPolicy = schema.match(/create policy "Channel members can manage tasks" on public\.tasks for all using \([\s\S]*?\n\);/)?.[0] ?? "";
const insertRemindersPolicy = schema.match(/create policy "Reminder creators can insert" on public\.reminders for insert with check \([\s\S]*?\n\);/)?.[0] ?? "";
const updateRemindersPolicy = schema.match(/create policy "Reminder participants can update" on public\.reminders for update using \([\s\S]*?\n\);/)?.[0] ?? "";
const fixRlsViewChannelMembersPolicy = fixRls.match(/CREATE POLICY "Users can view channel memberships"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const fixRlsViewChannelsPolicy = fixRls.match(/CREATE POLICY "Users can view their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const fixRlsViewMessagesPolicy = fixRls.match(/CREATE POLICY "Users can view messages in their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const fixRlsAddChannelMembersPolicy = fixRls.match(/CREATE POLICY "Users can add channel members"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const fixRlsSendMessagesPolicy = fixRls.match(/CREATE POLICY "Users can send messages in their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysUserOwnsAgentFunction = machineKeys.match(/CREATE OR REPLACE FUNCTION public\.user_owns_agent\(agent_uuid uuid\)[\s\S]*?\$\$ LANGUAGE sql SECURITY DEFINER STABLE;/)?.[0] ?? "";
const machineKeysUserHasAgentInChannelFunction = machineKeys.match(/CREATE OR REPLACE FUNCTION public\.user_has_agent_in_channel\(chan_uuid uuid\)[\s\S]*?\$\$ LANGUAGE sql SECURITY DEFINER STABLE;/)?.[0] ?? "";
const machineKeysViewMessagesPolicy = machineKeys.match(/CREATE POLICY "Users can view messages in their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysViewChannelMembersPolicy = machineKeys.match(/CREATE POLICY "Users can view channel memberships"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysViewChannelsPolicy = machineKeys.match(/CREATE POLICY "Users can view their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysViewTasksPolicy = machineKeys.match(/CREATE POLICY "Channel members can view tasks"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysSendMessagesPolicy = machineKeys.match(/CREATE POLICY "Users can send messages in their channels"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const machineKeysManageTasksPolicy = machineKeys.match(/CREATE POLICY "Channel members can manage tasks"[\s\S]*?\n\s*\);/)?.[0] ?? "";
const autonomousActorIsServerMemberFunction = autonomous.match(/create or replace function zano_private\.actor_is_server_member\(server_uuid uuid\)[\s\S]*?\$\$;/)?.[0] ?? "";
const collaborationTaskEventsPolicy = collaboration.match(/create policy "Task events follow task access" on public\.task_events for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const collaborationViewNotificationsPolicy = collaboration.match(/create policy "Recipients can view own notifications" on public\.notifications for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const collaborationViewRemindersPolicy = collaboration.match(/create policy "Reminder participants can view" on public\.reminders for select using \([\s\S]*?\n\);/)?.[0] ?? "";
const collaborationInsertRemindersPolicy = collaboration.match(/create policy "Reminder creators can insert" on public\.reminders for insert with check \([\s\S]*?\n\);/)?.[0] ?? "";
const collaborationUpdateRemindersPolicy = collaboration.match(/create policy "Reminder participants can update" on public\.reminders for update using \([\s\S]*?\n\);/)?.[0] ?? "";
const collaborationMutablePolicyNames = [
  "Thread participants follow message access",
  "Thread subscriptions follow message access",
  "Task dependencies follow successor access",
  "Task comments follow task access",
  "Task artifacts follow task access",
  "Task specs follow task access",
  "Task plans follow task access",
  "Task steps follow task access",
  "Task verifications follow task access",
  "Task agent runs follow task access",
  "Task reviews follow task access",
  "Recipients can update own notifications",
];
const collaborationMutablePolicies = collaborationMutablePolicyNames.map((name) => collaboration.match(new RegExp(`create policy "${name}"[\\s\\S]*?\\n\\);`))?.[0] ?? "");
const daemonRuntimeOutcomeConstraint = daemon.match(/runtime_outcome text check \(runtime_outcome in \([\s\S]*?\n\s*\)\)/)?.[0] ?? "";

const checks = [
  {
    name: "lineage trigger distinguishes archive cleanup from insert, reparent, and unarchive",
    pass:
      lineageFunction.includes("is_archive_transition boolean") &&
      lineageFunction.includes("is_archival_cleanup boolean") &&
      lineageFunction.includes("tg_op = 'UPDATE'") &&
      lineageFunction.includes("old.archived_at is null") &&
      lineageFunction.includes("new.archived_at is not null") &&
      lineageFunction.includes("old.parent_agent_id is not distinct from new.parent_agent_id") &&
      lineageFunction.includes("old.server_id is not distinct from new.server_id") &&
      lineageFunction.includes("old.root_agent_id is not distinct from new.root_agent_id") &&
      lineageFunction.includes("old.generation is not distinct from new.generation"),
  },
  {
    name: "lineage trigger covers derived lineage columns and canonicalizes roots",
    pass:
      /before insert or update of parent_agent_id, server_id, archived_at, root_agent_id, generation on public\.agents/.test(schema) &&
      lineageFunction.includes("new.generation := 0") &&
      lineageFunction.includes("new.root_agent_id := new.id"),
  },
  {
    name: "lineage trigger blocks lineage changes during archive transitions",
    pass:
      /if is_archive_transition and not is_archival_cleanup then[\s\S]*?raise exception 'Cannot change lineage while archiving agent';/.test(lineageFunction),
  },
  {
    name: "lineage trigger serializes parent reads and blocks archiving active parents",
    pass:
      /where id = new\.parent_agent_id[\s\S]*?for update;/.test(lineageFunction) &&
      /if is_archive_transition and exists \([\s\S]*?where child\.parent_agent_id = old\.id[\s\S]*?child\.archived_at is null[\s\S]*?Archive child agents first/.test(lineageFunction),
  },
  {
    name: "lineage trigger blocks root archival bypasses",
    pass:
      /if is_archive_transition and old\.parent_agent_id is null then[\s\S]*?raise exception 'Cannot archive root agent';/.test(lineageFunction),
  },
  {
    name: "archived parents are still rejected outside archival cleanup",
    pass:
      /if parent_record\.archived_at is not null and not is_archival_cleanup then[\s\S]*?raise exception 'parent agent is archived';/.test(lineageFunction),
  },
  {
    name: "archival cleanup returns before lineage recomputation and generation limit",
    pass:
      /if is_archival_cleanup then[\s\S]*?return new;[\s\S]*?new\.generation := parent_record\.generation \+ 1;[\s\S]*?child agent generation limit exceeded/.test(lineageFunction),
  },
  {
    name: "agent delete trigger preserves child lineage and blocks delete races",
    pass:
      schema.includes("parent_agent_id uuid references public.agents(id) on delete restrict") &&
      schema.includes("root_agent_id uuid references public.agents(id) on delete restrict") &&
      /if old\.parent_agent_id is not null then[\s\S]*?Cannot delete child agent\. Archive child agents instead\./.test(deleteGuardFunction) &&
      /where child\.parent_agent_id = old\.id/.test(deleteGuardFunction) &&
      /raise exception 'Cannot delete agent with child agents';/.test(deleteGuardFunction) &&
      /before delete on public\.agents[\s\S]*?execute function public\.prevent_agent_lineage_delete\(\)/.test(schema),
  },
  {
    name: "owner RLS cannot directly delete agents",
    pass:
      schema.includes('create policy "Owner can insert agents" on public.agents for insert with check (auth.uid() = owner_id);') &&
      schema.includes('create policy "Owner can update own agents" on public.agents for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);') &&
      !/create policy "Owner can manage agents" on public\.agents for all/.test(schema) &&
      !/CREATE POLICY "Owner can manage own agents"[\s\S]*?FOR ALL/.test(fixRls) &&
      !/on public\.agents for delete/i.test(schema) &&
      !/ON public\.agents FOR DELETE/i.test(fixRls),
  },
  {
    name: "root agent delete cleanup is atomic after lineage guard approval",
    pass:
      /create or replace function public\.delete_root_agent/.test(deleteRootAgentFunction) &&
      /auth\.jwt\(\)->>'role' is distinct from 'service_role'/.test(deleteRootAgentFunction) &&
      /auth\.uid\(\)[\s\S]*?expected_owner_id/.test(deleteRootAgentFunction) &&
      /from public\.agents[\s\S]*?delete from public\.messages/.test(deleteRootAgentFunction) &&
      /delete from public\.channel_members[\s\S]*?delete from public\.channels/.test(deleteRootAgentFunction) &&
      /revoke all on function public\.delete_root_agent\(uuid, uuid\) from public;/.test(schema) &&
      /grant execute on function public\.delete_root_agent\(uuid, uuid\) to service_role;/.test(schema),
  },
  {
    name: "archived agent credentials cannot send messages through preserved memberships",
    pass:
      schema.includes("create or replace function public.auth_actor_is_not_archived_agent()") &&
      /where id = auth\.uid\(\)[\s\S]*?archived_at is not null/.test(schema) &&
      sendMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()"),
  },
  {
    name: "archived agent credentials cannot read through preserved memberships",
    pass:
      viewChannelsPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      viewChannelMembersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      viewMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      viewTasksPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      viewRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()"),
  },
  {
    name: "archived agent credentials cannot mutate preserved tasks or reminders",
    pass:
      manageTasksPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      insertRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      updateRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()"),
  },
  {
    name: "secondary RLS scripts preserve archived-agent write guards",
    pass:
      fixRls.includes("create or replace function public.auth_actor_is_not_archived_agent()") &&
      fixRlsViewChannelMembersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      fixRlsViewChannelsPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      fixRlsViewMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      fixRlsAddChannelMembersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      fixRlsSendMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeys.includes("create or replace function public.auth_actor_is_not_archived_agent()") &&
      machineKeysUserOwnsAgentFunction.includes("archived_at is null") &&
      machineKeysUserHasAgentInChannelFunction.includes("a.archived_at is null") &&
      machineKeysViewMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeysViewChannelMembersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeysViewChannelsPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeysViewTasksPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeysSendMessagesPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      machineKeysManageTasksPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      collaboration.includes("create or replace function public.auth_actor_is_not_archived_agent()") &&
      collaborationTaskEventsPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      collaborationViewNotificationsPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      collaborationViewRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      collaborationInsertRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()") &&
      collaborationUpdateRemindersPolicy.includes("public.auth_actor_is_not_archived_agent()"),
  },
  {
    name: "archived agent credentials cannot mutate collaboration subresources",
    pass: collaborationMutablePolicies.every((policy) => policy.includes("public.auth_actor_is_not_archived_agent()")),
  },
  {
    name: "autonomous server membership excludes archived agent actors",
    pass:
      autonomousActorIsServerMemberFunction.includes("zano_private.current_actor_type() <> 'agent'") &&
      autonomousActorIsServerMemberFunction.includes("a.archived_at is null"),
  },
  {
    name: "daemon delivery outcomes allow archived and token-removed cancellations",
    pass:
      daemonRuntimeOutcomeConstraint.includes("'agent_archived'") &&
      daemonRuntimeOutcomeConstraint.includes("'agent_token_removed'"),
  },
];

const failures = checks.filter((check) => !check.pass);

if (failures.length > 0) {
  console.error("Agent lineage archive verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Agent lineage archive verification passed (${checks.length} checks).`);
