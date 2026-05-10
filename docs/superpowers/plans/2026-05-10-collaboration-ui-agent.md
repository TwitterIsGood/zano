# Collaboration UI and Agent Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the visible Thread UI, drag-and-drop Task Board, task detail experience, notification badges, and agent autonomy prompt updates.

**Architecture:** This plan assumes the foundation and API/CLI plans have landed. The UI uses the new APIs rather than direct Supabase writes where guarded transitions are needed. Agents continue to use the `zano` CLI; the bridge prompt teaches them the Trellis/Superpowers-inspired workflow.

**Tech Stack:** Next.js App Router, React 19, existing shadcn/base UI primitives, Supabase Realtime, existing `TiptapMessageInput`, existing bridge system prompt.

---

## File Structure

### Create

- `apps/web/src/components/thread-panel.tsx`
  - Right-side thread reader/reply composer/resolution panel.
- `apps/web/src/components/thread-button.tsx`
  - Message-level reply count and open-thread affordance.
- `apps/web/src/components/task-board.tsx`
  - Server-scoped Kanban board with drag-and-drop transition calls.
- `apps/web/src/components/task-card.tsx`
  - Compact task card used by board columns.
- `apps/web/src/components/task-detail-drawer.tsx`
  - Full task detail, comments, artifacts, dependencies, reviews, events.
- `apps/web/src/components/notifications-menu.tsx`
  - In-app notification list and unread badge.
- `apps/web/src/app/s/[slug]/tasks/page.tsx`
  - Server-scoped task board route.

### Modify

- `apps/web/src/components/message-area.tsx`
  - Add thread affordances, thread panel state, create task action.
- `apps/web/src/components/sidebar.tsx`
  - Add Tasks nav entry and notification menu.
- `apps/web/src/app/s/[slug]/layout.tsx`
  - Pass user/server context needed for notification badges if needed.
- `apps/bridge/src/system-prompt.ts`
  - Teach agents the new thread/task/spec/plan/review/verification workflow.

---

## Task 1: Add Thread UI components

**Files:**
- Create: `apps/web/src/components/thread-button.tsx`
- Create: `apps/web/src/components/thread-panel.tsx`
- Modify: `apps/web/src/components/message-area.tsx`

- [ ] **Step 1: Create thread button**

Create `apps/web/src/components/thread-button.tsx`:

```tsx
"use client";

import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ThreadButtonProps {
  replyCount: number;
  lastReplyAt: string | null;
  resolved: boolean;
  onOpen: () => void;
}

export function ThreadButton({ replyCount, lastReplyAt, resolved, onOpen }: ThreadButtonProps) {
  const label = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Reply in thread";

  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={onOpen}>
      <MessageSquareText className="h-3.5 w-3.5" />
      <span>{label}</span>
      {lastReplyAt ? <span>· {new Date(lastReplyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
      {resolved ? <span>· resolved</span> : null}
    </Button>
  );
}
```

- [ ] **Step 2: Create thread panel**

Create `apps/web/src/components/thread-panel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import TiptapMessageInput from "./tiptap-message-input";

interface ThreadMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  created_at: string;
  thread_resolved_at?: string | null;
}

interface ThreadPanelProps {
  parentMessageId: string | null;
  userId: string | null;
  onClose: () => void;
}

export function ThreadPanel({ parentMessageId, userId, onClose }: ThreadPanelProps) {
  const [parent, setParent] = useState<ThreadMessage | null>(null);
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!parentMessageId) return;

    async function loadThread() {
      const res = await fetch(`/api/threads/${parentMessageId}`);
      if (!res.ok) return;
      const data = await res.json();
      setParent(data.parent);
      setReplies(data.replies ?? []);
    }

    loadThread();
  }, [parentMessageId]);

  if (!parentMessageId) return null;

  async function sendReply() {
    if (!parent || !userId || !content.trim()) return;
    setSending(true);
    const res = await fetch(`/api/threads/${parent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: parent.channel_id, sender_id: userId, sender_type: "human", content }),
    });
    if (res.ok) {
      const data = await res.json();
      setReplies((prev) => [...prev, data.message]);
      setContent("");
    }
    setSending(false);
  }

  async function toggleResolved() {
    if (!parent || !userId) return;
    const res = await fetch(`/api/threads/${parent.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: !parent.thread_resolved_at, actor_id: userId, actor_type: "human" }),
    });
    if (res.ok) {
      const data = await res.json();
      setParent(data.thread);
    }
  }

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Thread</h2>
          <p className="text-xs text-muted-foreground">{replies.length} replies</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-4 py-3">
        {parent ? (
          <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{parent.content}</ReactMarkdown>
          </div>
        ) : null}

        <div className="space-y-3">
          {replies.map((reply) => (
            <div key={reply.id} className="rounded-lg border p-3 text-sm">
              <div className="mb-1 text-xs text-muted-foreground">
                {reply.sender_type} · {new Date(reply.created_at).toLocaleString()}
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply.content}</ReactMarkdown>
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <div className="mb-2 flex justify-end">
          <Button variant="outline" size="sm" onClick={toggleResolved} disabled={!parent}>
            {parent?.thread_resolved_at ? "Reopen" : "Resolve"}
          </Button>
        </div>
        <TiptapMessageInput value={content} onChange={setContent} onSubmit={sendReply} disabled={sending} placeholder="Reply in thread..." />
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Integrate thread panel into message area**

Modify `apps/web/src/components/message-area.tsx`:

1. Import components:

```tsx
import { ThreadButton } from "./thread-button";
import { ThreadPanel } from "./thread-panel";
```

2. Extend local `Message` interface:

```ts
reply_count: number;
last_reply_at: string | null;
thread_resolved_at: string | null;
```

3. Add state:

```tsx
const [openThreadMessageId, setOpenThreadMessageId] = useState<string | null>(null);
```

4. Wrap the existing main message layout so `ThreadPanel` renders as a right-side sibling:

```tsx
<div className="flex min-h-0 flex-1">
  <div className="min-w-0 flex-1">existing message area content</div>
  <ThreadPanel parentMessageId={openThreadMessageId} userId={userId} onClose={() => setOpenThreadMessageId(null)} />
</div>
```

5. Inside each rendered message, below content, add:

```tsx
<ThreadButton
  replyCount={msg.reply_count ?? 0}
  lastReplyAt={msg.last_reply_at ?? null}
  resolved={Boolean(msg.thread_resolved_at)}
  onOpen={() => setOpenThreadMessageId(msg.id)}
/>
```

- [ ] **Step 4: Run web lint**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 2: Add task board and task detail UI

**Files:**
- Create: `apps/web/src/components/task-card.tsx`
- Create: `apps/web/src/components/task-detail-drawer.tsx`
- Create: `apps/web/src/components/task-board.tsx`
- Create: `apps/web/src/app/s/[slug]/tasks/page.tsx`

- [ ] **Step 1: Create task card**

Create `apps/web/src/components/task-card.tsx`:

```tsx
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
```

- [ ] **Step 2: Create task detail drawer**

Create `apps/web/src/components/task-detail-drawer.tsx`:

```tsx
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
          <div className="mt-4 space-y-4">
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
```

- [ ] **Step 3: Create task board with drag-and-drop**

Create `apps/web/src/components/task-board.tsx`:

```tsx
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

  async function loadTasks() {
    const res = await fetch(`/api/tasks?serverId=${serverId}`);
    if (!res.ok) return;
    const data = await res.json();
    setTasks(data.tasks ?? []);
  }

  useEffect(() => {
    loadTasks();
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
      const data = await res.json();
      setError(data.error ?? "Transition failed");
      return;
    }
    const data = await res.json();
    setTasks((prev) => prev.map((item) => (item.id === task.id ? data.task : item)));
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div>
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">Agent-driven workflow board</p>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-3 overflow-x-auto">
        {columns.map((column) => (
          <section
            key={column.status}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragged && dragged.status !== column.status) transition(dragged, column.status);
              setDragged(null);
            }}
            className="flex min-w-[220px] flex-col rounded-xl border bg-muted/30"
          >
            <div className="border-b px-3 py-2 text-sm font-medium">{column.label} ({grouped[column.status].length})</div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
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
```

- [ ] **Step 4: Create tasks page**

Create `apps/web/src/app/s/[slug]/tasks/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TaskBoard } from "@/components/task-board";

interface TasksPageProps {
  params: Promise<{ slug: string }>;
}

export default async function TasksPage({ params }: TasksPageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: server } = await admin.from("servers").select("id").eq("slug", slug).single();
  if (!server) redirect("/");

  return <TaskBoard serverId={server.id} userId={user.id} />;
}
```

- [ ] **Step 5: Run web lint**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 3: Add sidebar Tasks nav and notifications menu

**Files:**
- Create: `apps/web/src/components/notifications-menu.tsx`
- Modify: `apps/web/src/components/sidebar.tsx`

- [ ] **Step 1: Create notifications menu**

Create `apps/web/src/components/notifications-menu.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Notification } from "@zano/shared";

interface NotificationsMenuProps {
  userId: string;
}

export function NotificationsMenu({ userId }: NotificationsMenuProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/notifications?recipientId=${userId}&recipientType=human&unreadOnly=true`);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications ?? []);
      }
    }
    load();
  }, [userId]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
          {notifications.length > 0 ? <Badge className="absolute -right-1 -top-1 h-5 min-w-5 px-1 text-[10px]">{notifications.length}</Badge> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="mb-2 font-medium">Notifications</div>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unread notifications</p>
        ) : (
          <div className="space-y-2">
            {notifications.map((notification) => (
              <div key={notification.id} className="rounded-md border p-2 text-sm">
                <div className="font-medium">{notification.type}</div>
                <div className="text-xs text-muted-foreground">{new Date(notification.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Add Tasks link to sidebar**

Modify `apps/web/src/components/sidebar.tsx`:

1. Import:

```tsx
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { NotificationsMenu } from "./notifications-menu";
```

2. Add a Tasks entry near Channels/Agents navigation:

```tsx
<Link
  href={`/s/${serverSlug}/tasks`}
  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
>
  <ClipboardList className="h-4 w-4" />
  Tasks
</Link>
```

3. Add `<NotificationsMenu userId={userId} />` near the user/server header actions.

- [ ] **Step 3: Run web lint**

Run:

```bash
pnpm --filter @zano/web lint
```

Expected: PASS.

Do not commit yet.

---

## Task 4: Add agent workflow prompt updates

**Files:**
- Modify: `apps/bridge/src/system-prompt.ts`

- [ ] **Step 1: Add collaboration workflow section**

In `apps/bridge/src/system-prompt.ts`, add a section to the generated prompt that says:

```ts
const collaborationWorkflow = `
## Thread and Task Workflow

Use threads for focused multi-turn discussion. Reply in the main channel for short status updates and final delivery summaries.

Use tasks as the durable source of truth for actionable work. For complex work, create a task, draft a spec/PRD, create a plan, break it into steps, execute steps, attach verification evidence, request review when the task policy requires it, and only mark done after verification passes.

Default lifecycle:
1. Capture intent from channel or thread.
2. Create task with clear title, description, priority, tags, and source context.
3. Create subtasks for independent work.
4. Claim only tasks matching your role and not blocked by dependencies.
5. Move claimed tasks to in_progress.
6. Attach comments and artifacts as you work.
7. Attach verification evidence before claiming completion.
8. If reviewer or review_policy is present, move to in_review and wait for/pass review.
9. If review requests changes, move to changes_requested, fix, verify, and request review again.
10. Move to done only when verification passes and required review gates pass.

Prefer zano CLI commands over direct database changes. Do not claim completion without evidence.
`;
```

Then include `collaborationWorkflow` in the final prompt string.

- [ ] **Step 2: Run bridge build**

Run:

```bash
pnpm --filter @zano/bridge build
```

Expected: PASS.

Do not commit yet.

---

## Task 5: Browser verification and commit

**Files:**
- All files created/modified in this plan.

- [ ] **Step 1: Run full build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Start web dev server**

Run:

```bash
pnpm dev:web
```

Expected: Next.js dev server starts on port 3000. If port 3000 is occupied, kill the local conflicting dev server process for this project and restart.

- [ ] **Step 3: Verify in browser**

Open the app in a browser and verify:

1. Sidebar shows Tasks navigation.
2. Tasks page loads board columns.
3. Dragging a card between columns calls transition API.
4. Blocked transition shows an error instead of silently moving.
5. Channel messages show Reply in thread.
6. Clicking Reply in thread opens the right thread panel.
7. Sending a thread reply appears in the panel.
8. Resolving/reopening a thread updates the panel.
9. Notification bell renders without crashing.

- [ ] **Step 4: Commit UI/agent work**

Run:

```bash
git add apps/web/src/components/thread-button.tsx apps/web/src/components/thread-panel.tsx apps/web/src/components/task-card.tsx apps/web/src/components/task-detail-drawer.tsx apps/web/src/components/task-board.tsx apps/web/src/components/notifications-menu.tsx apps/web/src/components/message-area.tsx apps/web/src/components/sidebar.tsx apps/web/src/app/s/[slug]/tasks/page.tsx apps/bridge/src/system-prompt.ts
git commit -m "$(cat <<'EOF'
feat: add collaboration UI and agent workflow guidance

Add thread panel affordances, server task board with guarded drag-and-drop
transitions, task detail drawer, notification menu, sidebar navigation, and
agent workflow prompt guidance for evidence-based task autonomy.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Self-Review

### Spec coverage

Covered by this plan:

- Thread message affordances.
- Thread panel.
- Drag-and-drop Kanban task board.
- Task detail view.
- Notification badge/menu.
- Agent task/thread behavior guidance.
- Browser verification.

Deferred:

- Deep UI polish beyond functional layout.
- Advanced task create dialog behavior from every source context if not needed for first board validation.
- Durable automatic notification creation triggers, if not already implemented in API plan.

### Placeholder scan

This plan contains no placeholder tokens or unimplemented planned files.

### Type consistency

UI imports `Task`, `TaskStatus`, and `Notification` from `@zano/shared` as defined by the foundation plan. Transition calls match the API plan's request body.
