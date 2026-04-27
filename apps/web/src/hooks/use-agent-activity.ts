"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

export type AgentActivity = "idle" | "thinking" | "working" | "error";

interface ActivityState {
  activity: AgentActivity;
  /** Human-readable label: "Thinking", "Reading file", "Sending message", etc. */
  label: string;
  /** Specific detail: file path, command, message target, or agent text output */
  detail: string;
}

/**
 * Subscribe to real-time agent activity broadcasts.
 * Returns a Map of agentId -> { activity, detail }.
 * Falls back to "idle" if no heartbeat received within timeout.
 */
export function useAgentActivity() {
  const [activities, setActivities] = useState<Map<string, ActivityState>>(
    new Map()
  );
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "activity" }, (msg) => {
        const { agentId, activity, label, detail } = msg.payload as {
          agentId: string;
          activity: AgentActivity;
          label?: string;
          detail?: string;
        };

        setActivities((prev) => {
          const next = new Map(prev);
          next.set(agentId, {
            activity,
            label: label || "",
            detail: detail || "",
          });
          return next;
        });

        // Set a timeout: if no update within 90s, fall back to idle
        const existing = timeoutsRef.current.get(agentId);
        if (existing) clearTimeout(existing);

        if (activity === "thinking" || activity === "working") {
          timeoutsRef.current.set(
            agentId,
            setTimeout(() => {
              setActivities((prev) => {
                const next = new Map(prev);
                next.set(agentId, { activity: "idle", label: "Idle", detail: "" });
                return next;
              });
              timeoutsRef.current.delete(agentId);
            }, 90_000) // 90s timeout (heartbeat is 60s)
          );
        } else {
          timeoutsRef.current.delete(agentId);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      for (const t of timeoutsRef.current.values()) clearTimeout(t);
      timeoutsRef.current.clear();
    };
  }, []);

  return activities;
}
