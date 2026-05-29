import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "src", "autonomous.sql");
const schema = readFileSync(schemaPath, "utf8");

const checks = [
  {
    name: "created_by provenance guard exists",
    pattern: /create or replace function zano_private\.actor_created_by_matches_current\(actor_id uuid, actor_type text\)/,
  },
  {
    name: "event actor provenance guard exists",
    pattern: /create or replace function zano_private\.actor_event_matches_current\(actor_id uuid, actor_type text\)/,
  },
  {
    name: "skills insert policy checks creator provenance",
    pattern: /create policy "Server actors can create skills"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "skill events insert policy checks actor provenance",
    pattern: /create policy "Server actors can create skill events"[\s\S]*?with check \([\s\S]*?public\.actor_event_matches_current\(actor_id, actor_type\)[\s\S]*?\);/,
  },
  {
    name: "attestations insert policy checks actor provenance",
    pattern: /create policy "Server actors can create skill attestations"[\s\S]*?with check \([\s\S]*?public\.actor_event_matches_current\(actor_id, actor_type\)[\s\S]*?\);/,
  },
  {
    name: "spawn events insert policy checks actor provenance",
    pattern: /create policy "Server actors can create spawn events"[\s\S]*?with check \([\s\S]*?public\.actor_event_matches_current\(actor_id, actor_type\)[\s\S]*?\);/,
  },
  {
    name: "skill versions insert policy checks creator provenance",
    pattern: /create policy "Server actors can create skill versions"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "skill files insert policy checks creator provenance",
    pattern: /create policy "Server actors can create skill files"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "skill candidates insert policy checks creator provenance",
    pattern: /create policy "Server actors can create skill candidates"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "knowledge insert policy checks creator provenance",
    pattern: /create policy "Server actors can create knowledge"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "agent blueprints insert policy checks creator provenance",
    pattern: /create policy "Server actors can create agent blueprints"[\s\S]*?with check \([\s\S]*?public\.actor_created_by_matches_current\(created_by_id, created_by_type\)[\s\S]*?\);/,
  },
  {
    name: "agent event provenance guard exists",
    pattern: /create or replace function zano_private\.agent_event_matches_current\(agent_uuid uuid\)/,
  },
  {
    name: "child-agent event convention documented",
    pattern: /Child-agent creation event_type values:[\s\S]*?agent_create_requested[\s\S]*?agent_created[\s\S]*?agent_create_failed/,
  },
  {
    name: "child-agent safe handle helper exists",
    pattern: /create or replace function public\.agent_safe_handle\(display_name text, fallback text default 'Agent'\)/,
  },
  {
    name: "child-agent creation RPC exists",
    pattern: /create or replace function public\.agent_create_child\([\s\S]*?returns jsonb[\s\S]*?security definer/,
  },
  {
    name: "child-agent RPC requires agent actor",
    pattern: /only agent actors can create child agents/,
  },
  {
    name: "child-agent RPC requires non-empty source refs",
    pattern: /jsonb_array_length\(v_source_refs\) = 0[\s\S]*?source_refs must include at least one source/,
  },
  {
    name: "child-agent RPC validates source ref shape",
    pattern: /jsonb_array_elements\(v_source_refs\)[\s\S]*?source_refs entries must include type and id/,
  },
  {
    name: "child-agent RPC rejects secret-like persisted fields",
    pattern: /agent_contains_secret_like_text[\s\S]*?child agent creation fields must not contain secrets/,
  },
  {
    name: "child-agent RPC checks idempotency key for secrets",
    pattern: /agent_contains_secret_like_text\(v_idempotency_key\)[\s\S]*?child agent creation fields must not contain secrets/,
  },
  {
    name: "child-agent RPC enforces guardrails",
    pattern: /generation_limit[\s\S]*?active_child_limit[\s\S]*?rate_limit/,
  },
  {
    name: "child-agent RPC serializes parent creation",
    pattern: /select \* into v_parent[\s\S]*?from public\.agents[\s\S]*?for update;/,
  },
  {
    name: "child-agent RPC adds parent to child DM",
    pattern: /insert into public\.channel_members\(channel_id, member_id, member_type\)[\s\S]*?\(v_channel\.id, v_owner_id, 'human'\),[\s\S]*?\(v_channel\.id, v_parent\.id, 'agent'\),[\s\S]*?\(v_channel\.id, v_agent\.id, 'agent'\)/,
  },
  {
    name: "child-agent idempotent reuse returns delegation channel",
    pattern: /if v_existing is not null then[\s\S]*?'channel_id'[\s\S]*?'parent_agent_id'[\s\S]*?'idempotent', true/,
  },
  {
    name: "child-agent idempotent reuse repairs parent DM membership",
    pattern: /if v_existing is not null then[\s\S]*?insert into public\.channel_members\(channel_id, member_id, member_type\)[\s\S]*?\(v_channel\.id, v_parent\.id, 'agent'\)[\s\S]*?on conflict do nothing;[\s\S]*?return jsonb_build_object/,
  },
  {
    name: "child-agent idempotent reuse validates child provenance",
    pattern: /if v_existing is not null then[\s\S]*?parent_agent_id = v_parent\.id[\s\S]*?created_by_id = v_actor_id[\s\S]*?created_by_type = 'agent'[\s\S]*?creation_source = 'agent'[\s\S]*?archived_at is null/,
  },
  {
    name: "child-agent RPC records provenance",
    pattern: /created_by_id[\s\S]*?created_by_type[\s\S]*?parent_agent_id[\s\S]*?creation_source[\s\S]*?creation_reason/,
  },
  {
    name: "child-agent RPC retries name collisions",
    pattern: /exception[\s\S]*?when unique_violation then[\s\S]*?could not allocate unique agent name/,
  },
  {
    name: "child-agent idempotency index exists",
    pattern: /create index if not exists idx_agent_spawn_events_idempotency[\s\S]*?policy_result->>'idempotency_key'/,
  },
  {
    name: "child-agent RPC grant exists",
    pattern: /grant execute on function public\.agent_create_child\(text, text, text, text, uuid, jsonb, jsonb, uuid, text\) to authenticated, anon, service_role;/,
  },
  {
    name: "agent turns insert policy checks agent provenance",
    pattern: /create policy "Server actors can create agent turns"[\s\S]*?with check \([\s\S]*?public\.agent_event_matches_current\(agent_id\)[\s\S]*?\);/,
  },
  {
    name: "agent tool events insert policy checks agent provenance",
    pattern: /create policy "Server actors can create agent tool events"[\s\S]*?with check \([\s\S]*?public\.agent_event_matches_current\(agent_id\)[\s\S]*?\);/,
  },
  {
    name: "policy evaluations insert policy checks actor provenance",
    pattern: /create policy "Server actors can create policy evaluations"[\s\S]*?with check \([\s\S]*?public\.actor_event_matches_current\(actor_id, actor_type\)[\s\S]*?\);/,
  },
  {
    name: "episode generation RPC exists",
    pattern: /create or replace function public\.skill_episode_generate_from_turn\(/,
  },
  {
    name: "episode no-op RPC exists",
    pattern: /create or replace function public\.skill_episode_mark_no_op\(/,
  },
  {
    name: "episode generation records source turn refs",
    pattern: /jsonb_build_array\(jsonb_build_object\('type', 'agent_turn', 'id', v_turn\.id\)\)/,
  },
  {
    name: "episode no-op emits ledger event",
    pattern: /'skill_episode\.no_op'/,
  },
];

const failures = checks.filter((check) => !check.pattern.test(schema));

if (failures.length > 0) {
  console.error("Autonomous schema verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Autonomous schema verification passed (${checks.length} checks).`);
