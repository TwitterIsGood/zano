"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
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

  async function openTask(taskId: string) {
    const res = await fetch(`/api/tasks/${taskId}`);
    if (!res.ok) return;
    const detail = await res.json() as { task: Task };
    setSelectedTask(detail.task);
    setTaskDrawerOpen(true);
  }

  return (
    <div className="space-y-4">
      {memberType === "agent" && agentActivity && agentActivity.activity !== "idle" ? (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={agentActivity.activity === "error" ? "error" : "success"}>{agentActivity.activity}</Badge>
              <span className="font-medium">{agentActivity.label || "Active"}</span>
              {agentActivity.detail ? <span className="truncate text-muted-foreground">{agentActivity.detail}</span> : null}
            </div>
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
                  <div className="mt-1 size-2 rounded-full bg-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">{event.label || toTitle(event.event_type)}</h3>
                      <span className="text-xs text-muted-foreground">{formatTime(event.occurred_at)}</span>
                    </div>
                    {event.summary ? <p className="mt-1 text-sm text-muted-foreground">{event.summary}</p> : null}
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
