import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

interface AutonomousPageProps {
  params: Promise<{ slug: string }>;
}

interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  state: string;
  risk_level: string;
  updated_at: string;
}

interface SkillCandidateSummary {
  id: string;
  candidate_type: string;
  target_slug: string | null;
  risk_level: string;
  state: string;
  rationale: string;
  created_at: string;
}

interface KnowledgeSummary {
  id: string;
  subject: string;
  content: string;
  kind: string;
  confidence: number;
  freshness: string;
  updated_at: string;
}

interface BlueprintSummary {
  id: string;
  slug: string;
  display_name_template: string;
  description: string;
  state: string;
  default_model: string;
}

interface SpawnEventSummary {
  id: string;
  event_type: string;
  reason: string;
  created_at: string;
}

interface EpisodeSummary {
  id: string;
  trigger_type: string;
  trigger_strength: string;
  summary: string;
  status: string;
  created_at: string;
}

interface AgentSummary {
  id: string;
  name: string;
  display_name: string;
  status: string;
}

interface RuntimeSessionSummary {
  id: string;
  agent_id: string;
  machine_id: string;
  runtime: string;
  runtime_model: string | null;
  state: string;
  session_ref_reachable: boolean;
  started_at: string;
  last_active_at: string | null;
}

interface DeliverySummary {
  id: string;
  agent_id: string;
  target: string;
  activation_strength: string;
  state: string;
  queue_reason: string | null;
  runtime_outcome: string | null;
  updated_at: string;
}

interface ReminderSummary {
  id: string;
  recipient_id: string;
  target: string;
  body: string;
  due_at: string;
  snoozed_until: string | null;
  state: string;
  updated_at: string;
}

interface TraceEventSummary {
  id: string;
  agent_id: string | null;
  event_type: string;
  event_name: string;
  severity: string;
  created_at: string;
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

function stateVariant(state: string): "success" | "warning" | "error" | "outline" | "secondary" {
  if (["active", "applied", "completed", "spawn_created", "ready", "idle", "delivered", "accepted", "fired"].includes(state)) return "success";
  if (["pending", "probation", "running", "spawn_requested", "starting", "busy", "gated", "planned", "received", "delivering", "snoozed", "firing"].includes(state)) return "warning";
  if (["quarantined", "rejected_by_policy", "failed", "spawn_failed", "stale"].includes(state)) return "error";
  if (["archived", "superseded", "ended", "cancelled"].includes(state)) return "secondary";
  return "outline";
}

function publicAgentHandle(displayName: string, fallback: string) {
  const handle = displayName
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
  return handle || fallback;
}

function formatTime(value: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <Badge variant="outline">{count}</Badge>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

export default async function AutonomousPage({ params }: AutonomousPageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: server } = await admin
    .from("servers")
    .select("id, name")
    .eq("slug", slug)
    .maybeSingle();

  if (!server) redirect("/");

  const { data: membership } = await admin
    .from("server_members")
    .select("server_id")
    .eq("server_id", server.id)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (!membership) redirect("/");

  const [
    skillsResult,
    candidatesResult,
    knowledgeResult,
    blueprintsResult,
    spawnResult,
    episodesResult,
    agentsResult,
    runtimeSessionsResult,
    deliveriesResult,
    remindersResult,
    traceEventsResult,
    deliveryCountResult,
    traceCountResult,
  ] = await Promise.all([
    admin
      .from("skills")
      .select("id, slug, name, description, state, risk_level, updated_at")
      .eq("server_id", server.id)
      .order("updated_at", { ascending: false })
      .limit(12),
    admin
      .from("skill_candidates")
      .select("id, candidate_type, target_slug, risk_level, state, rationale, created_at")
      .eq("server_id", server.id)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("knowledge_items")
      .select("id, subject, content, kind, confidence, freshness, updated_at")
      .eq("server_id", server.id)
      .order("updated_at", { ascending: false })
      .limit(12),
    admin
      .from("agent_blueprints")
      .select("id, slug, display_name_template, description, state, default_model")
      .eq("server_id", server.id)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("agent_spawn_events")
      .select("id, event_type, reason, created_at")
      .eq("server_id", server.id)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("skill_episodes")
      .select("id, trigger_type, trigger_strength, summary, status, created_at")
      .eq("server_id", server.id)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("agents")
      .select("id, name, display_name, status")
      .eq("server_id", server.id)
      .is("archived_at", null)
      .order("display_name"),
    admin
      .from("daemon_runtime_sessions")
      .select("id, agent_id, machine_id, runtime, runtime_model, state, session_ref_reachable, started_at, last_active_at")
      .eq("workspace_id", server.id)
      .order("started_at", { ascending: false })
      .limit(12),
    admin
      .from("daemon_deliveries")
      .select("id, agent_id, target, activation_strength, state, queue_reason, runtime_outcome, updated_at")
      .eq("workspace_id", server.id)
      .order("updated_at", { ascending: false })
      .limit(12),
    supabase
      .from("reminders")
      .select("id, recipient_id, target, body, due_at, snoozed_until, state, updated_at")
      .eq("server_id", server.id)
      .order("due_at", { ascending: true })
      .limit(12),
    admin
      .from("daemon_trace_events")
      .select("id, agent_id, event_type, event_name, severity, created_at")
      .eq("workspace_id", server.id)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("daemon_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", server.id),
    admin
      .from("daemon_trace_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", server.id),
  ]);

  const firstError =
    skillsResult.error ??
    candidatesResult.error ??
    knowledgeResult.error ??
    blueprintsResult.error ??
    spawnResult.error ??
    episodesResult.error ??
    agentsResult.error ??
    runtimeSessionsResult.error ??
    deliveriesResult.error ??
    remindersResult.error ??
    traceEventsResult.error ??
    deliveryCountResult.error ??
    traceCountResult.error;

  if (firstError) {
    return (
      <div className="flex flex-1 flex-col p-8">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold text-foreground">Autonomous System</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The autonomous ledger is not available yet. Apply the schema first, then reload this page.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl border bg-muted/40 p-4 text-xs text-muted-foreground">
            DATABASE_URL=&apos;postgresql://...&apos; pnpm --filter @zano/db apply:autonomous
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">{firstError.message}</p>
        </div>
      </div>
    );
  }

  const skills = (skillsResult.data ?? []) as SkillSummary[];
  const candidates = (candidatesResult.data ?? []) as SkillCandidateSummary[];
  const knowledgeItems = (knowledgeResult.data ?? []) as KnowledgeSummary[];
  const blueprints = (blueprintsResult.data ?? []) as BlueprintSummary[];
  const spawnEvents = (spawnResult.data ?? []) as SpawnEventSummary[];
  const episodes = (episodesResult.data ?? []) as EpisodeSummary[];
  const agents = (agentsResult.data ?? []) as AgentSummary[];
  const runtimeSessions = (runtimeSessionsResult.data ?? []) as RuntimeSessionSummary[];
  const deliveries = (deliveriesResult.data ?? []) as DeliverySummary[];
  const reminders = (remindersResult.data ?? []) as ReminderSummary[];
  const traceEvents = (traceEventsResult.data ?? []) as TraceEventSummary[];
  const deliveryCount = deliveryCountResult.count ?? deliveries.length;
  const traceCount = traceCountResult.count ?? traceEvents.length;
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.display_name]));

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {server.name}
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-foreground">Autonomous System</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Skills, knowledge, blueprints, and spawn decisions are actor-governed ledger facts.
          This page is observational: it shows what the system has learned or attempted.
        </p>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-5">
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="text-xs text-muted-foreground">Agent workspaces</div>
          <div className="mt-1 text-2xl font-semibold">{agents.length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="text-xs text-muted-foreground">Runtime sessions</div>
          <div className="mt-1 text-2xl font-semibold">{runtimeSessions.length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="text-xs text-muted-foreground">Daemon deliveries</div>
          <div className="mt-1 text-2xl font-semibold">{deliveryCount}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="text-xs text-muted-foreground">Reminders</div>
          <div className="mt-1 text-2xl font-semibold">{reminders.length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="text-xs text-muted-foreground">Trace events</div>
          <div className="mt-1 text-2xl font-semibold">{traceCount}</div>
        </div>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Section title="Agent Workspaces" count={agents.length}>
          {agents.length === 0 ? (
            <EmptyState label="No agents found in this workspace." />
          ) : (
            agents.map((agent) => (
              <a key={agent.id} href={`/s/${slug}/member/agent/${agent.id}`} className="block rounded-xl border p-3 transition-colors hover:bg-accent/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{agent.display_name}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      @{publicAgentHandle(agent.display_name, agent.name)}
                    </div>
                  </div>
                  <Badge variant={stateVariant(agent.status)}>{agent.status}</Badge>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Daemon workspace is read by agent id from the Omni.
                </div>
              </a>
            ))
          )}
        </Section>

        <Section title="Runtime Sessions" count={runtimeSessions.length}>
          {runtimeSessions.length === 0 ? (
            <EmptyState label="No daemon runtime sessions yet." />
          ) : (
            runtimeSessions.map((session) => (
              <div key={session.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{shortId(session.id)}</span>
                  <Badge variant={stateVariant(session.state)}>{session.state}</Badge>
                  <Badge variant="outline">{session.runtime}</Badge>
                  {session.runtime_model ? <Badge variant="outline">{session.runtime_model}</Badge> : null}
                </div>
                <div className="mt-2 text-sm font-medium">{agentNames.get(session.agent_id) ?? shortId(session.agent_id)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {session.machine_id} · active {formatTime(session.last_active_at ?? session.started_at)}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Daemon Deliveries" count={deliveryCount}>
          {deliveries.length === 0 ? (
            <EmptyState label="No daemon deliveries yet." />
          ) : (
            deliveries.map((delivery) => (
              <div key={delivery.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{shortId(delivery.id)}</span>
                  <Badge variant={stateVariant(delivery.state)}>{delivery.state}</Badge>
                  <Badge variant="outline">{delivery.activation_strength}</Badge>
                  {delivery.runtime_outcome ? <Badge variant="outline">{delivery.runtime_outcome}</Badge> : null}
                </div>
                <div className="mt-2 text-sm font-medium">{agentNames.get(delivery.agent_id) ?? shortId(delivery.agent_id)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {delivery.target} · updated {formatTime(delivery.updated_at)}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Reminders" count={reminders.length}>
          {reminders.length === 0 ? (
            <EmptyState label="No scheduled follow-up wake-ups yet." />
          ) : (
            reminders.map((reminder) => (
              <div key={reminder.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{shortId(reminder.id)}</span>
                  <Badge variant={stateVariant(reminder.state)}>{reminder.state}</Badge>
                  <Badge variant="outline">{reminder.target}</Badge>
                </div>
                <div className="mt-2 text-sm font-medium">{agentNames.get(reminder.recipient_id) ?? shortId(reminder.recipient_id)}</div>
                <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{reminder.body}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  due {formatTime(reminder.snoozed_until ?? reminder.due_at)}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Daemon Trace Events" count={traceCount}>
          {traceEvents.length === 0 ? (
            <EmptyState label="No visible daemon trace events yet." />
          ) : (
            traceEvents.map((event) => (
              <div key={event.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{shortId(event.id)}</span>
                  <Badge variant={stateVariant(event.severity)}>{event.severity}</Badge>
                  <Badge variant="outline">{event.event_type}</Badge>
                </div>
                <div className="mt-2 text-sm font-medium">{event.event_name}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {event.agent_id ? agentNames.get(event.agent_id) ?? shortId(event.agent_id) : "workspace"} · {formatTime(event.created_at)}
                </div>
              </div>
            ))
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Skills" count={skills.length}>
          {skills.length === 0 ? (
            <EmptyState label="No active skills yet." />
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{skill.slug}</span>
                  <Badge variant={stateVariant(skill.state)}>{skill.state}</Badge>
                  <Badge variant="outline">{skill.risk_level}</Badge>
                </div>
                <div className="mt-2 text-sm font-medium">{skill.name}</div>
                <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {skill.description}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Skill Candidates" count={candidates.length}>
          {candidates.length === 0 ? (
            <EmptyState label="No candidate changes yet." />
          ) : (
            candidates.map((candidate) => (
              <div key={candidate.id} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortId(candidate.id)}
                  </span>
                  <Badge variant={stateVariant(candidate.state)}>{candidate.state}</Badge>
                  <Badge variant="outline">{candidate.candidate_type}</Badge>
                </div>
                <div className="mt-2 text-sm font-medium">
                  {candidate.target_slug ?? "Untitled candidate"}
                </div>
                <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {candidate.rationale}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Knowledge" count={knowledgeItems.length}>
          {knowledgeItems.length === 0 ? (
            <EmptyState label="No shared knowledge yet." />
          ) : (
            knowledgeItems.map((item) => (
              <div key={item.id} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{item.kind}</Badge>
                  <Badge variant="outline">{item.freshness}</Badge>
                  <span className="text-xs text-muted-foreground">
                    confidence {item.confidence}
                  </span>
                </div>
                <div className="mt-2 text-sm font-medium">{item.subject}</div>
                <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {item.content}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Learning Episodes" count={episodes.length}>
          {episodes.length === 0 ? (
            <EmptyState label="No generated learning episodes yet." />
          ) : (
            episodes.map((episode) => (
              <div key={episode.id} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortId(episode.id)}
                  </span>
                  <Badge variant={stateVariant(episode.status)}>{episode.status}</Badge>
                  <Badge variant="outline">{episode.trigger_strength}</Badge>
                </div>
                <div className="mt-2 text-sm font-medium">{episode.trigger_type}</div>
                <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {episode.summary}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Agent Evolution" count={blueprints.length + spawnEvents.length}>
          {blueprints.length === 0 && spawnEvents.length === 0 ? (
            <EmptyState label="No blueprints or spawn events yet." />
          ) : (
            <>
              {blueprints.map((blueprint) => (
                <div key={blueprint.id} className="rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={stateVariant(blueprint.state)}>{blueprint.state}</Badge>
                    <Badge variant="outline">{blueprint.default_model}</Badge>
                  </div>
                  <div className="mt-2 text-sm font-medium">
                    {blueprint.display_name_template}
                  </div>
                  <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {blueprint.description}
                  </div>
                </div>
              ))}
              {spawnEvents.map((event) => (
                <div key={event.id} className="rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {shortId(event.id)}
                    </span>
                    <Badge variant={stateVariant(event.event_type)}>{event.event_type}</Badge>
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {event.reason}
                  </div>
                </div>
              ))}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}
