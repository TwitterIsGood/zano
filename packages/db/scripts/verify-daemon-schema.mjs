import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "src", "daemon.sql");
const schema = readFileSync(schemaPath, "utf8");

const checks = [
  { name: "daemon deliveries table", pattern: /create table if not exists public\.daemon_deliveries/ },
  { name: "daemon runtime sessions table", pattern: /create table if not exists public\.daemon_runtime_sessions/ },
  { name: "daemon start queue table", pattern: /create table if not exists public\.daemon_start_queue/ },
  { name: "daemon trace events table", pattern: /create table if not exists public\.daemon_trace_events/ },
  { name: "delivery idempotency unique index", pattern: /create unique index if not exists daemon_deliveries_workspace_idempotency_key_idx/ },
  { name: "per agent delivery sequence unique index", pattern: /create unique index if not exists daemon_deliveries_workspace_agent_seq_idx/ },
  { name: "delivery trace lookup index", pattern: /create index if not exists daemon_deliveries_workspace_trace_idx/ },
  { name: "delivery ack traceparent column", pattern: /ack_traceparent text/ },
  { name: "delivery last runtime event column", pattern: /last_runtime_event_at timestamptz/ },
  { name: "delivery runtime outcome column", pattern: /runtime_outcome text check \(runtime_outcome in \(/ },
  { name: "session machine lookup index", pattern: /create index if not exists daemon_runtime_sessions_workspace_machine_idx/ },
  { name: "start queue dedupe index", pattern: /create unique index if not exists daemon_start_queue_workspace_dedupe_idx/ },
  { name: "trace event delivery lookup index", pattern: /create index if not exists daemon_trace_events_workspace_delivery_idx/ },
  { name: "deliveries RLS enabled", pattern: /alter table public\.daemon_deliveries enable row level security/ },
  { name: "omni can manage deliveries policy", pattern: /create policy "Omni can manage daemon deliveries"/ },
  {
    name: "drop omni manage deliveries policy before create",
    pattern: /drop policy if exists "Omni can manage daemon deliveries" on public\.daemon_deliveries;\s*create policy "Omni can manage daemon deliveries"/,
  },
  {
    name: "drop member trace read policy before create",
    pattern: /drop policy if exists "Server members can read daemon trace events" on public\.daemon_trace_events;\s*create policy "Server members can read daemon trace events"/,
  },
  {
    name: "member trace read policy excludes raw trace event types",
    pattern: /create policy "Server members can read daemon trace events"[\s\S]*?using \(event_type in \('routing', 'delivery', 'process', 'recovery'\) and zano_private\.actor_is_server_member\(workspace_id\)\);/,
  },
];

const failures = checks.filter((check) => !check.pattern.test(schema));
const forbiddenTables = [...schema.matchAll(/create table(?: if not exists)? (?:public|daemon)\.([^\s(]*dead_letter[^\s(]*)/gi)];
if (forbiddenTables.length > 0) failures.push({ name: "no daemon/public dead_letter tables", pattern: /$a/ });

if (failures.length > 0) {
  console.error("Daemon schema verification failed:");
  for (const failure of failures) console.error(`- ${failure.name}`);
  process.exit(1);
}

console.log(`Daemon schema verification passed (${checks.length} checks).`);
