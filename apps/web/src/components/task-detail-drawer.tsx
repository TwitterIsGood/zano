"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Task } from "@zano/shared";

interface TaskDetailDrawerProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailDrawer({ task, open, onOpenChange }: TaskDetailDrawerProps) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!task || !open) return;
    async function load() {
      const res = await fetch(`/api/tasks/${task!.id}`);
      if (res.ok) setDetail(await res.json());
    }
    load();
  }, [task, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[520px] overflow-y-auto sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle>{task ? `#${task.task_number} ${task.title}` : "Task"}</SheetTitle>
        </SheetHeader>
        {task ? (
          <div className="mt-4 space-y-4 px-6 pb-6">
            <div className="flex gap-2">
              <Badge>{task.status}</Badge>
              <Badge variant="outline">{task.priority}</Badge>
            </div>
            {task.description ? <p className="text-sm text-muted-foreground">{task.description}</p> : null}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Tags</h3>
              <div className="flex flex-wrap gap-1">
                {task.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Workflow</h3>
              <p className="text-sm text-muted-foreground">Gate: {task.current_gate ?? "none"}</p>
              <p className="text-sm text-muted-foreground">Review: {task.review_status ?? "none"}</p>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Activity</h3>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(detail, null, 2)}</pre>
            </section>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
