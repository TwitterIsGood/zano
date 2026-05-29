"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TaskDetailDrawer } from "@/components/task-detail-drawer";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { useMemberActivity } from "@/hooks/use-member-activity";
import type { MemberActivityEvent, MemberType, Task } from "@zano/shared";

interface MemberActivityTabProps {
  serverId: string;
  serverSlug: string;
  memberType: MemberType;
  memberId: string;
}

interface RuntimeSession {
  id: string;
  state: string;
  machine_id: string;
  session_id: string | null;
  prompt_hash: string;
  last_active_at: string | null;
}

const EVENT_LABELS: Record<string, string> = {
  "message.sent": "Sent a message",
  "thread.replied": "Replied in a thread",
  "thread.resolved": "Resolved a thread",
  "thread.reopened": "Reopened a thread",
  "channel.joined": "Joined a channel",
  "server.joined": "Joined the server",
  "task.created": "Created a task",
  "task.claimed": "Claimed a task",
  "task.unclaimed": "Unclaimed a task",
  "task.status_changed": "Changed task status",
  "task.updated": "Updated a task",
  "task.commented": "Commented on a task",
  "task.artifact_added": "Added a task artifact",
  "task.reviewed": "Reviewed a task",
  "task.verified": "Verified a task",
  "agent.started": "Started",
  "agent.received_message": "Received a message",
  "agent.thinking": "Thinking",
  "agent.working": "Working",
  "agent.tool_use": "Used a tool",
  "agent.output": "Produced output",
  "agent.idle": "Went idle",
  "agent.error": "Hit an error",
  "agent.disconnected": "Disconnected",
  "agent.status_changed": "Changed status",
  "agent.created": "Created",
  "agent.updated": "Updated",
  "agent.reset": "Reset",
  "agent.deleted": "Deleted",
  "human.profile_updated": "Updated profile",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function toTitle(eventType: string) {
  return EVENT_LABELS[eventType] || eventType.split(".").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function eventTitle(event: MemberActivityEvent) {
  if (event.event_type === "agent.created" && event.metadata?.creation_source === "agent") {
    return "Created child agent";
  }
  return event.label || toTitle(event.event_type);
}

function getChannelPath(serverSlug: string, event: MemberActivityEvent) {
  if (!event.channel_id) return null;
  const channelType = typeof event.metadata?.channel_type === "string" ? event.metadata.channel_type : null;
  const route = channelType === "dm" ? "dm" : "channel";
  return `/s/${serverSlug}/${route}/${event.channel_id}`;
}

function getSourceLinkLabel(event: MemberActivityEvent) {
  if (event.thread_parent_id) return "Open thread source";
  if (event.message_id) return "Open message source";
  if (event.channel_id) return "Open channel source";
  return null;
}

function SourceLinks({ serverSlug, event, onOpenTask }: {
  serverSlug: string;
  event: MemberActivityEvent;
  onOpenTask: (taskId: string) => void;
}) {
  const channelPath = getChannelPath(serverSlug, event);
  const sourceLinkLabel = channelPath ? getSourceLinkLabel(event) : null;
  const sourceLink = channelPath && sourceLinkLabel ? { href: channelPath, label: sourceLinkLabel } : null;
  const taskId = event.task_id;

  if (!taskId && !sourceLink) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {taskId ? (
        <Button size="xs" variant="outline" onClick={() => onOpenTask(taskId)}>
          Open task
        </Button>
      ) : null}
      {sourceLink ? (
        <Button size="xs" variant="outline" render={<Link href={sourceLink.href} />}>
          {sourceLink.label} <ExternalLink className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

export function MemberActivityTab({ serverId, serverSlug, memberType, memberId }: MemberActivityTabProps) {
  const { events, loading, error, reload } = useMemberActivity({ serverId, actorType: memberType, actorId: memberId });
  const agentActivities = useAgentActivity();
  const agentActivity = memberType === "agent" ? agentActivities.get(memberId) : null;
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
  const [runtimeSessionsAgentId, setRuntimeSessionsAgentId] = useState<string | null>(null);
  const [runtimeSessionsError, setRuntimeSessionsError] = useState<string | null>(null);

  useEffect(() => {
    if (memberType !== "agent") return;

    let cancelled = false;

    async function loadRuntimeSessions() {
      setRuntimeSessions([]);
      setRuntimeSessionsAgentId(null);
      setRuntimeSessionsError(null);

      try {
        const res = await fetch(`/api/daemon/sessions?agentId=${encodeURIComponent(memberId)}`);
        const body = await res.json().catch(() => ({})) as { sessions?: RuntimeSession[]; error?: string };
        if (cancelled) return;

        if (!res.ok) {
          setRuntimeSessions([]);
          setRuntimeSessionsError(body.error || "Unable to load daemon runtime sessions.");
          setRuntimeSessionsAgentId(memberId);
          return;
        }

        setRuntimeSessions(body.sessions ?? []);
        setRuntimeSessionsError(null);
        setRuntimeSessionsAgentId(memberId);
      } catch {
        if (cancelled) return;
        setRuntimeSessions([]);
        setRuntimeSessionsError("Unable to load daemon runtime sessions.");
        setRuntimeSessionsAgentId(memberId);
      }
    }

    loadRuntimeSessions();

    return () => {
      cancelled = true;
    };
  }, [memberId, memberType]);

  const runtimeSessionsLoading = memberType === "agent" && runtimeSessionsAgentId !== memberId;
  const visibleRuntimeSessions = runtimeSessionsLoading ? [] : runtimeSessions;

  async function openTask(taskId: string) {
    const res = await fetch(`/api/tasks/${taskId}`);
    if (!res.ok) return;
    const detail = await res.json() as { task: Task };
    setSelectedTask(detail.task);
    setTaskDrawerOpen(true);
  }

  const activityBadgeVariant = agentActivity?.activity === "error" || agentActivity?.activity === "blocked"
    ? "error"
    : agentActivity?.activity === "observing"
      ? "secondary"
      : "success";

  return (
    <div className="space-y-4">
      {memberType === "agent" && agentActivity && agentActivity.activity !== "idle" ? (
        <Card className="min-w-0 max-w-full overflow-hidden border-primary/20 bg-primary/5">
          <CardContent className="min-w-0 max-w-full py-4">
            <div className="flex min-w-0 max-w-full items-start gap-2 text-sm">
              <Badge className="shrink-0" variant={activityBadgeVariant}>{agentActivity.activity}</Badge>
              <span className="shrink-0 font-medium">{agentActivity.label || "Active"}</span>
              {agentActivity.detail ? <span className="min-w-0 max-w-full flex-1 break-words whitespace-pre-wrap text-muted-foreground">{agentActivity.detail}</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {memberType === "agent" ? (
        <Card>
          <CardContent className="py-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Daemon runtime</h3>
              {visibleRuntimeSessions[0] ? <Badge variant={visibleRuntimeSessions[0].state === "error" ? "error" : "secondary"}>{visibleRuntimeSessions[0].state}</Badge> : null}
            </div>
            {runtimeSessionsLoading ? (
              <p className="text-sm text-muted-foreground">Loading daemon runtime...</p>
            ) : runtimeSessionsError ? (
              <p className="text-sm text-destructive">{runtimeSessionsError}</p>
            ) : visibleRuntimeSessions[0] ? (
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>machine={visibleRuntimeSessions[0].machine_id}</div>
                <div>session={visibleRuntimeSessions[0].session_id?.slice(0, 8) ?? "none"}</div>
                <div>prompt={visibleRuntimeSessions[0].prompt_hash.slice(0, 8)}</div>
                <div>last active={visibleRuntimeSessions[0].last_active_at ? formatTime(visibleRuntimeSessions[0].last_active_at) : "never"}</div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No daemon runtime sessions recorded.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={reload}>Retry</Button>
            </div>
          </CardContent>
        </Card>
      ) : loading ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Loading activity...</CardContent>
        </Card>
      ) : events.length === 0 ? (
        <Empty className="rounded-2xl border bg-card">
          <EmptyHeader>
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>Activity from this member will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <Card key={event.id}>
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 shrink-0 size-2 rounded-full bg-primary" />
                  <div className="min-w-0 max-w-full flex-1">
                    <div className="min-w-0 flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium">{eventTitle(event)}</h3>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(event.occurred_at)}</span>
                    </div>
                    {event.summary ? (
                      <p className="mt-1 break-words whitespace-pre-wrap text-sm text-muted-foreground">{event.summary}</p>
                    ) : null}
                    <SourceLinks serverSlug={serverSlug} event={event} onOpenTask={openTask} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TaskDetailDrawer task={selectedTask} open={taskDrawerOpen} onOpenChange={setTaskDrawerOpen} />
    </div>
  );
}
