import type { AgentActivity } from "@zano/shared";

export const LIVE_AGENT_EVENT_TYPES = [
  "agent.started",
  "agent.received_message",
  "agent.thinking",
  "agent.working",
  "agent.working_silently",
  "agent.observing",
  "agent.blocked",
  "agent.tool_use",
  "agent.output",
  "agent.idle",
  "agent.error",
  "agent.disconnected",
] as const;

const VALID_AGENT_ACTIVITIES = new Set<AgentActivity>([
  "idle",
  "thinking",
  "working",
  "working_silently",
  "observing",
  "blocked",
  "error",
]);

const EXPIRABLE_AGENT_ACTIVITIES = new Set<AgentActivity>([
  "thinking",
  "working",
  "working_silently",
]);

const ACTIVE_AGENT_ACTIVITY_TIMEOUT_MS = 90_000;
const ACTIVE_RUNTIME_SESSION_TIMEOUT_MS = 5 * 60_000;

export type LiveAgentActivity = {
  agentId: string;
  activity: AgentActivity;
  label: string;
  detail: string;
  occurredAt: string;
  channelId: string | null;
  sourceMessageId: string | null;
  threadParentId: string | null;
  taskId: string | null;
  source: "activity" | "runtime_session";
};

export type LiveAgentEventRow = {
  actor_id: string;
  event_type: string;
  label: string | null;
  summary: string | null;
  occurred_at: string;
  created_at: string;
  channel_id: string | null;
  message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
};

export type RuntimeSessionRow = {
  agent_id: string;
  state: string;
  started_at: string;
  last_active_at: string | null;
  idle_at: string | null;
  ended_at: string | null;
  last_error: string | null;
};

function defaultActivityLabel(activity: AgentActivity) {
  switch (activity) {
    case "thinking":
      return "Thinking";
    case "working":
      return "Working";
    case "working_silently":
      return "Working silently";
    case "observing":
      return "Observing";
    case "blocked":
      return "Blocked";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
  }
}

function mapAgentEventType(eventType: string): AgentActivity | null {
  if (eventType === "agent.started") return "working";
  if (eventType === "agent.received_message") return "working";
  if (eventType === "agent.tool_use") return "working";
  if (eventType === "agent.output") return "working_silently";
  if (eventType === "agent.disconnected") return "idle";

  const activity = eventType.startsWith("agent.") ? eventType.slice("agent.".length) : "";
  return VALID_AGENT_ACTIVITIES.has(activity as AgentActivity) ? (activity as AgentActivity) : null;
}

function runtimeSessionTimestamp(session: RuntimeSessionRow) {
  return session.ended_at ?? session.idle_at ?? session.last_active_at ?? session.started_at;
}

function timestampMs(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isOlderThan(value: string, nowMs: number, maxAgeMs: number) {
  const timestamp = timestampMs(value);
  return timestamp !== null && nowMs - timestamp > maxAgeMs;
}

function idleActivity(agentId: string, occurredAt: string, source: LiveAgentActivity["source"]): LiveAgentActivity {
  return {
    agentId,
    activity: "idle",
    label: "Idle",
    detail: "",
    occurredAt,
    channelId: null,
    sourceMessageId: null,
    threadParentId: null,
    taskId: null,
    source,
  };
}

function mapRuntimeSession(session: RuntimeSessionRow, nowMs: number): LiveAgentActivity | null {
  const occurredAt = runtimeSessionTimestamp(session);

  switch (session.state) {
    case "starting":
      if (isOlderThan(occurredAt, nowMs, ACTIVE_RUNTIME_SESSION_TIMEOUT_MS)) {
        return idleActivity(session.agent_id, occurredAt, "runtime_session");
      }
      return {
        agentId: session.agent_id,
        activity: "working",
        label: "Starting runtime",
        detail: "",
        occurredAt,
        channelId: null,
        sourceMessageId: null,
        threadParentId: null,
        taskId: null,
        source: "runtime_session",
      };
    case "busy":
      if (isOlderThan(occurredAt, nowMs, ACTIVE_RUNTIME_SESSION_TIMEOUT_MS)) {
        return idleActivity(session.agent_id, occurredAt, "runtime_session");
      }
      return {
        agentId: session.agent_id,
        activity: "working",
        label: "Working",
        detail: "",
        occurredAt,
        channelId: null,
        sourceMessageId: null,
        threadParentId: null,
        taskId: null,
        source: "runtime_session",
      };
    case "gated":
      if (isOlderThan(occurredAt, nowMs, ACTIVE_RUNTIME_SESSION_TIMEOUT_MS)) {
        return idleActivity(session.agent_id, occurredAt, "runtime_session");
      }
      return {
        agentId: session.agent_id,
        activity: "working",
        label: "Waiting for safe runtime boundary",
        detail: "",
        occurredAt,
        channelId: null,
        sourceMessageId: null,
        threadParentId: null,
        taskId: null,
        source: "runtime_session",
      };
    case "failed":
      return {
        agentId: session.agent_id,
        activity: "error",
        label: "Error",
        detail: session.last_error ?? "",
        occurredAt,
        channelId: null,
        sourceMessageId: null,
        threadParentId: null,
        taskId: null,
        source: "runtime_session",
      };
    case "ready":
    case "idle":
    case "stale":
    case "stopping":
    case "ended":
      return idleActivity(session.agent_id, occurredAt, "runtime_session");
    default:
      return null;
  }
}

function isAfter(a: string, b: string | undefined) {
  if (!b) return true;
  return new Date(a).getTime() >= new Date(b).getTime();
}

function mapActivityEvent(event: LiveAgentEventRow, nowMs: number): LiveAgentActivity | null {
  const activity = mapAgentEventType(event.event_type);
  if (!activity) return null;

  if (EXPIRABLE_AGENT_ACTIVITIES.has(activity) && isOlderThan(event.occurred_at, nowMs, ACTIVE_AGENT_ACTIVITY_TIMEOUT_MS)) {
    return idleActivity(event.actor_id, event.occurred_at, "activity");
  }

  return {
    agentId: event.actor_id,
    activity,
    label: event.label ?? defaultActivityLabel(activity),
    detail: event.summary ?? "",
    occurredAt: event.occurred_at,
    channelId: event.channel_id,
    sourceMessageId: event.message_id,
    threadParentId: event.thread_parent_id,
    taskId: event.task_id,
    source: "activity",
  };
}

export function resolveLatestAgentActivities(
  activityRows: LiveAgentEventRow[],
  sessionRows: RuntimeSessionRow[],
  nowMs = Date.now()
) {
  const activitiesByAgent = new Map<string, LiveAgentActivity>();

  for (const event of activityRows) {
    if (activitiesByAgent.has(event.actor_id)) continue;

    const activity = mapActivityEvent(event, nowMs);
    if (!activity) continue;

    activitiesByAgent.set(event.actor_id, activity);
  }

  const seenSessionAgents = new Set<string>();
  for (const session of sessionRows) {
    if (seenSessionAgents.has(session.agent_id)) continue;
    seenSessionAgents.add(session.agent_id);

    const activity = mapRuntimeSession(session, nowMs);
    if (!activity) continue;

    const existing = activitiesByAgent.get(session.agent_id);
    if (!existing || isAfter(activity.occurredAt, existing.occurredAt)) {
      activitiesByAgent.set(session.agent_id, activity);
    }
  }

  return [...activitiesByAgent.values()];
}
