"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePageRecovery } from "@/hooks/use-page-recovery";
import type { AgentActivity } from "@zano/shared";

export type { AgentActivity };

export interface ActivityState {
  activity: AgentActivity;
  label: string;
  detail: string;
  channelId: string | null;
  sourceMessageId: string | null;
  threadParentId: string | null;
  taskId: string | null;
}

type ActivitiesMap = Map<string, ActivityState>;
type ActivityBroadcastMessage = { payload: unknown };
type DurableAgentActivity = {
  agentId: string;
  activity: AgentActivity;
  label?: string | null;
  detail?: string | null;
  channelId?: string | null;
  sourceMessageId?: string | null;
  threadParentId?: string | null;
  taskId?: string | null;
  occurredAt?: string | null;
};
type ApplyActivityOptions = {
  timestampMs?: number;
  authoritative?: boolean;
};

const ACTIVE_TIMEOUT_MS = 90_000;

const AgentActivityContext = createContext<ActivitiesMap>(new Map());

const VALID_AGENT_ACTIVITIES = new Set<AgentActivity>([
  "idle",
  "thinking",
  "working",
  "working_silently",
  "observing",
  "blocked",
  "error",
]);

const RUNTIME_ACTIVITY_TEXT: Record<string, string> = {
  queued_gated: "Waiting for safe runtime boundary",
  queued_compaction: "Waiting for compaction-safe boundary",
  queued_busy_notification: "Pending message notification sent",
  stdin_idle_delivery: "Delivered at idle boundary",
};

function normalizeRuntimeActivityText(value: string | null | undefined) {
  if (!value) return "";
  return RUNTIME_ACTIVITY_TEXT[value] ?? value;
}

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

function isAgentActivity(value: unknown): value is AgentActivity {
  return typeof value === "string" && VALID_AGENT_ACTIVITIES.has(value as AgentActivity);
}

function parseActivityTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function durableActivityTimestamp(value: string | null | undefined) {
  return parseActivityTimestamp(value) ?? Date.now();
}

function shouldExpireActivity(activity: AgentActivity) {
  return activity === "thinking" || activity === "working";
}

export function AgentActivityProvider({ children, serverId }: { children: ReactNode; serverId?: string | null }) {
  const [activities, setActivities] = useState<ActivitiesMap>(new Map());
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activityTimestampsRef = useRef<Map<string, number>>(new Map());

  const clearAgentTimeout = useCallback((agentId: string) => {
    const existing = timeoutsRef.current.get(agentId);
    if (existing) clearTimeout(existing);
    timeoutsRef.current.delete(agentId);
  }, []);

  const applyActivity = useCallback((agentId: string, state: ActivityState, options: ApplyActivityOptions = {}) => {
    if (!agentId) return;

    const timestampMs = options.timestampMs ?? Date.now();
    const previousTimestamp = activityTimestampsRef.current.get(agentId) ?? 0;
    if (!options.authoritative && timestampMs < previousTimestamp) return;

    const normalized: ActivityState = {
      activity: state.activity,
      label: normalizeRuntimeActivityText(state.label) || defaultActivityLabel(state.activity),
      detail: normalizeRuntimeActivityText(state.detail),
      channelId: state.channelId ?? null,
      sourceMessageId: state.sourceMessageId ?? null,
      threadParentId: state.threadParentId ?? null,
      taskId: state.taskId ?? null,
    };

    activityTimestampsRef.current.set(agentId, timestampMs);
    setActivities((prev) => {
      const current = prev.get(agentId);
      if (
        current?.activity === normalized.activity &&
        current.label === normalized.label &&
        current.detail === normalized.detail &&
        current.channelId === normalized.channelId &&
        current.sourceMessageId === normalized.sourceMessageId &&
        current.threadParentId === normalized.threadParentId &&
        current.taskId === normalized.taskId
      ) {
        return prev;
      }

      const next = new Map(prev);
      next.set(agentId, normalized);
      return next;
    });

    clearAgentTimeout(agentId);

    if (shouldExpireActivity(normalized.activity)) {
      timeoutsRef.current.set(
        agentId,
        setTimeout(() => {
          if ((activityTimestampsRef.current.get(agentId) ?? 0) !== timestampMs) return;

          const idleAt = Date.now();
          activityTimestampsRef.current.set(agentId, idleAt);
          setActivities((prev) => {
            const current = prev.get(agentId);
            if (current?.activity === "idle" && current.label === "Idle" && current.detail === "") return prev;

            const next = new Map(prev);
            next.set(agentId, {
              activity: "idle",
              label: "Idle",
              detail: "",
              channelId: null,
              sourceMessageId: null,
              threadParentId: null,
              taskId: null,
            });
            return next;
          });
          timeoutsRef.current.delete(agentId);
        }, ACTIVE_TIMEOUT_MS)
      );
    }
  }, [clearAgentTimeout]);

  const loadDurableActivities = useCallback(async () => {
    if (!serverId) return;

    try {
      const params = new URLSearchParams({ server_id: serverId, latest: "agents" });
      const res = await fetch(`/api/activity?${params.toString()}`);
      const payload = await res.json().catch(() => ({})) as {
        activities?: DurableAgentActivity[];
      };

      if (!res.ok) return;

      for (const item of payload.activities ?? []) {
        if (!isAgentActivity(item.activity)) continue;
        applyActivity(
          item.agentId,
          {
            activity: item.activity,
            label: item.label ?? defaultActivityLabel(item.activity),
            detail: item.detail ?? "",
            channelId: item.channelId ?? null,
            sourceMessageId: item.sourceMessageId ?? null,
            threadParentId: item.threadParentId ?? null,
            taskId: item.taskId ?? null,
          },
          { timestampMs: durableActivityTimestamp(item.occurredAt), authoritative: true }
        );
      }
    } catch {
      return;
    }
  }, [applyActivity, serverId]);

  useEffect(() => {
    void loadDurableActivities();
  }, [loadDurableActivities]);

  usePageRecovery(() => {
    void loadDurableActivities();
  }, { minIntervalMs: 1500 });

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "activity" }, (msg: ActivityBroadcastMessage) => {
        const { serverId: payloadServerId, agentId, activity, label, detail, channelId, sourceMessageId, threadParentId, taskId, occurredAt } = msg.payload as {
          serverId?: string | null;
          agentId?: string;
          activity?: unknown;
          label?: string;
          detail?: string;
          channelId?: string | null;
          sourceMessageId?: string | null;
          threadParentId?: string | null;
          taskId?: string | null;
          occurredAt?: string;
        };

        if (payloadServerId && serverId && payloadServerId !== serverId) return;
        if (!agentId || !isAgentActivity(activity)) return;

        applyActivity(
          agentId,
          {
            activity,
            label: label ?? defaultActivityLabel(activity),
            detail: detail ?? "",
            channelId: channelId ?? null,
            sourceMessageId: sourceMessageId ?? null,
            threadParentId: threadParentId ?? null,
            taskId: taskId ?? null,
          },
          { timestampMs: parseActivityTimestamp(occurredAt) ?? 0 }
        );
      })
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          void loadDurableActivities();
        }
      });

    return () => {
      supabase.removeChannel(channel);
      for (const timeout of timeoutsRef.current.values()) clearTimeout(timeout);
      timeoutsRef.current.clear();
    };
  }, [applyActivity, loadDurableActivities, serverId]);

  return React.createElement(AgentActivityContext.Provider, { value: activities }, children);
}

export function useAgentActivity() {
  return useContext(AgentActivityContext);
}
