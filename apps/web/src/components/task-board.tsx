"use client";

import { useEffect, useMemo, useState } from "react";
import { TaskCard } from "./task-card";
import { TaskDetailDrawer } from "./task-detail-drawer";
import type { Task, TaskStatus } from "@zano/shared";

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "Todo" },
  { status: "blocked", label: "Blocked" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "changes_requested", label: "Changes requested" },
  { status: "done", label: "Done" },
  { status: "archived", label: "Archived" },
];

interface TaskBoardProps {
  serverId: string;
  userId: string;
}

export function TaskBoard({ serverId, userId }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dragged, setDragged] = useState<Task | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTasks() {
      const res = await fetch(`/api/tasks?serverId=${serverId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!cancelled) setTasks(data.tasks ?? []);
    }

    void loadTasks();

    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const grouped = useMemo(() => {
    return Object.fromEntries(columns.map((column) => [column.status, tasks.filter((task) => task.status === column.status)])) as Record<TaskStatus, Task[]>;
  }, [tasks]);

  async function transition(task: Task, status: TaskStatus) {
    setError(null);
    const res = await fetch(`/api/tasks/${task.id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actor_id: userId, actor_type: "human", reason: "board drag" }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Transition failed");
      return;
    }
    const data = await res.json();
    setTasks((prev) => prev.map((item) => (item.id === task.id ? data.task : item)));
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-3 p-4">
      <div>
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">Agent-driven workflow board</p>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
        {columns.map((column) => (
          <section
            key={column.status}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragged && dragged.status !== column.status) transition(dragged, column.status);
              setDragged(null);
            }}
            className="flex w-[260px] shrink-0 flex-col rounded-xl border bg-muted/30"
          >
            <div className="border-b px-3 py-2 text-sm font-medium">{column.label} ({grouped[column.status].length})</div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2 min-h-0">
              {grouped[column.status].map((task) => (
                <TaskCard key={task.id} task={task} onOpen={setSelectedTask} onDragStart={setDragged} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <TaskDetailDrawer task={selectedTask} open={Boolean(selectedTask)} onOpenChange={(open) => !open && setSelectedTask(null)} />
    </div>
  );
}
