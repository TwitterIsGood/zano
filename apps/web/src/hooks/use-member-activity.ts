"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePageRecovery } from "@/hooks/use-page-recovery";
import type { MemberActivityEvent, MemberType } from "@zano/shared";

interface UseMemberActivityArgs {
  serverId: string;
  actorType: MemberType;
  actorId: string;
}

interface MemberActivityInsertPayload {
  new: unknown;
}

const RUNTIME_ACTIVITY_TEXT: Record<string, string> = {
  queued_gated: "Waiting for safe runtime boundary",
  queued_compaction: "Waiting for compaction-safe boundary",
  queued_busy_notification: "Pending message notification sent",
  stdin_idle_delivery: "Delivered at idle boundary",
};

function normalizeRuntimeActivityText(value: string | null) {
  if (!value) return value;
  return RUNTIME_ACTIVITY_TEXT[value] ?? value;
}

function normalizeMemberActivityEvent(event: MemberActivityEvent): MemberActivityEvent {
  return {
    ...event,
    label: normalizeRuntimeActivityText(event.label),
    summary: normalizeRuntimeActivityText(event.summary),
  };
}

export function useMemberActivity({ serverId, actorType, actorId }: UseMemberActivityArgs) {
  const [events, setEvents] = useState<MemberActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        server_id: serverId,
        actor_type: actorType,
        actor_id: actorId,
      });
      const res = await fetch(`/api/activity?${params.toString()}`);
      const payload = await res.json().catch(() => ({})) as {
        events?: MemberActivityEvent[];
        error?: string;
      };

      if (!res.ok) {
        throw new Error(payload.error || "Failed to load activity");
      }

      setEvents((payload.events ?? []).map(normalizeMemberActivityEvent));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [actorId, actorType, serverId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      reload();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [reload]);

  usePageRecovery(() => {
    void reload();
  }, { minIntervalMs: 1500 });

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`member-activity:${actorId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "member_activity_events",
          filter: `actor_id=eq.${actorId}`,
        },
        (payload: MemberActivityInsertPayload) => {
          const event = normalizeMemberActivityEvent(payload.new as MemberActivityEvent);
          if (event.server_id !== serverId || event.actor_type !== actorType) return;

          setEvents((prev) => {
            if (prev.some((existing) => existing.id === event.id)) return prev;
            return [event, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [actorId, actorType, serverId]);

  return { events, loading, error, reload };
}
