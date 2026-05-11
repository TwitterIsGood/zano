"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TaskDetailDrawer } from "@/components/task-detail-drawer";
import type { MemberType, Task } from "@zano/shared";

interface MemberTasksTabProps {
  serverId: string;
  memberType: MemberType;
  memberId: string;
}

interface RelatedTasksResponse {
  tasks?: Task[];
  error?: string;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function priorityVariant(priority: Task["priority"]) {
  return priority === "critical" || priority === "high" ? "destructive" : "secondary";
}

export function MemberTasksTab({ serverId, memberType, memberId }: MemberTasksTabProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        server_id: serverId,
        member_type: memberType,
        member_id: memberId,
      });
      const res = await fetch(`/api/tasks/related?${params.toString()}`);
      const payload = (await res.json().catch(() => ({}))) as RelatedTasksResponse;

      if (!res.ok) {
        throw new Error(payload.error || "Failed to load related tasks");
      }

      setTasks(payload.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load related tasks");
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [memberId, memberType, serverId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadTasks();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadTasks]);

  function openTask(task: Task) {
    setSelectedTask(task);
    setTaskDrawerOpen(true);
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-6">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={loadTasks}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : loading ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Loading related tasks...</CardContent>
        </Card>
      ) : tasks.length === 0 ? (
        <Empty className="rounded-2xl border bg-card">
          <EmptyHeader>
            <EmptyTitle>No related tasks</EmptyTitle>
            <EmptyDescription>Tasks involving this member will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Related tasks</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => openTask(task)}
                  className="flex w-full flex-col gap-3 px-4 py-4 text-left transition hover:bg-accent/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{task.task_number}</span>
                      <h3 className="min-w-0 truncate text-sm font-medium">{task.title}</h3>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{task.status}</Badge>
                      <Badge variant={priorityVariant(task.priority)}>{task.priority}</Badge>
                      {task.current_gate ? <Badge variant="secondary">{task.current_gate}</Badge> : null}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-xs text-muted-foreground">
                    Updated {formatDate(task.updated_at)}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <TaskDetailDrawer task={selectedTask} open={taskDrawerOpen} onOpenChange={setTaskDrawerOpen} />
    </div>
  );
}
