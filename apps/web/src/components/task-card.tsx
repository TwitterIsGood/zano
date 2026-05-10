"use client";

import { Badge } from "@/components/ui/badge";
import type { Task } from "@zano/shared";

interface TaskCardProps {
  task: Task;
  onOpen: (task: Task) => void;
  onDragStart: (task: Task) => void;
}

export function TaskCard({ task, onOpen, onDragStart }: TaskCardProps) {
  return (
    <button
      draggable
      onDragStart={() => onDragStart(task)}
      onClick={() => onOpen(task)}
      className="w-full rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/50"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">#{task.task_number}</span>
        <Badge variant={task.priority === "critical" || task.priority === "high" ? "destructive" : "secondary"}>{task.priority}</Badge>
      </div>
      <div className="line-clamp-2 text-sm font-medium">{task.title}</div>
      {task.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-2 text-xs text-muted-foreground">
        {task.assignee_id ? "Assigned" : "Unassigned"} · {task.current_gate ?? "no gate"}
      </div>
    </button>
  );
}
