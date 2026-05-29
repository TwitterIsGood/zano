"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DAEMON_DELIVERY_STATE_LABELS, DAEMON_RUNTIME_OUTCOME_LABELS } from "@zano/shared";

interface DeliveryRow {
  id: string;
  agent_id: string;
  source_message_id: string;
  state: string;
  delivery_seq: number;
  trace_id: string;
  traceparent: string;
  target: string;
  activation_strength: string;
  activation_reasons: string[];
  runtimeOutcome?: string | null;
  runtime_outcome?: string | null;
  last_error: string | null;
  updated_at: string;
}

export function MessageDeliveryDrawer({
  messageId,
  open,
  onClose,
}: {
  messageId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loadedMessageId, setLoadedMessageId] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !messageId) return;
    let cancelled = false;
    const currentMessageId = messageId;

    async function loadDeliveries() {
      setDeliveries([]);
      setLoadedMessageId(null);
      setDeliveryError(null);

      try {
        const res = await fetch(`/api/daemon/deliveries?messageId=${encodeURIComponent(currentMessageId)}`);
        const body = await res.json().catch(() => ({})) as { deliveries?: DeliveryRow[]; error?: string };
        if (cancelled) return;

        if (!res.ok) {
          setDeliveries([]);
          setDeliveryError(body.error || "Unable to load daemon deliveries.");
          setLoadedMessageId(currentMessageId);
          return;
        }

        setDeliveries(body.deliveries ?? []);
        setDeliveryError(null);
        setLoadedMessageId(currentMessageId);
      } catch {
        if (cancelled) return;
        setDeliveries([]);
        setDeliveryError("Unable to load daemon deliveries.");
        setLoadedMessageId(currentMessageId);
      }
    }

    loadDeliveries();

    return () => {
      cancelled = true;
    };
  }, [messageId, open]);

  if (!open || !messageId) return null;

  const loading = loadedMessageId !== messageId;
  const visibleDeliveries = loading ? [] : deliveries;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[420px] border-l border-border bg-background p-4 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Daemon deliveries</h2>
          <p className="text-xs text-muted-foreground">Message {messageId.slice(0, 8)}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!loading && deliveryError ? <p className="text-sm text-destructive">{deliveryError}</p> : null}
      <div className="space-y-3">
        {!deliveryError && visibleDeliveries.map((delivery) => {
          const stateLabel = DAEMON_DELIVERY_STATE_LABELS[delivery.state as keyof typeof DAEMON_DELIVERY_STATE_LABELS] ?? delivery.state;
          const runtimeOutcome = delivery.runtimeOutcome ?? delivery.runtime_outcome;
          const outcomeLabel = runtimeOutcome
            ? DAEMON_RUNTIME_OUTCOME_LABELS[runtimeOutcome as keyof typeof DAEMON_RUNTIME_OUTCOME_LABELS] ?? runtimeOutcome
            : null;

          return (
            <div key={delivery.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">Agent {delivery.agent_id.slice(0, 8)}</span>
                <Badge variant={delivery.state === "failed" ? "destructive" : "secondary"}>{stateLabel}</Badge>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>seq={delivery.delivery_seq}</div>
                <div>target={delivery.target}</div>
                {outcomeLabel ? <div>runtime={outcomeLabel}</div> : null}
                <div>trace={delivery.trace_id}</div>
                <div>reasons={delivery.activation_reasons.join("+")}</div>
                {delivery.last_error ? <div className="text-destructive">{delivery.last_error}</div> : null}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                ACK means the local daemon accepted custody. It does not mean the agent replied or completed the work.
              </p>
              {delivery.state === "completed" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Completed is derived from task, reply, or session evidence; it is not an ordinary delivery completion ACK.
                </p>
              ) : null}
            </div>
          );
        })}
        {!loading && !deliveryError && visibleDeliveries.length === 0 ? <p className="text-sm text-muted-foreground">No daemon deliveries recorded.</p> : null}
      </div>
    </div>
  );
}
