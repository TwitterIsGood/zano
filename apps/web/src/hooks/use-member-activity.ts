"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { MemberActivityEvent, MemberType } from "@zano/shared";

interface UseMemberActivityArgs {
  serverId: string;
  actorType: MemberType;
  actorId: string;
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

      setEvents(payload.events ?? []);
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
        (payload) => {
          const event = payload.new as MemberActivityEvent;
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
