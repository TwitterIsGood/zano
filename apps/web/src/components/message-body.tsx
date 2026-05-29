"use client";

import type { Task } from "@zano/shared";
import { AlarmClock } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MentionTarget {
  id?: string;
  name: string;
  displayName: string;
  aliases?: string[];
}

interface MessageBodyProps {
  content: string;
  senderType: "human" | "agent" | "system";
  mentions?: MentionTarget[];
  tasksByNumber?: Map<number, Task>;
  onOpenTask?: (task: Task) => void;
  renderMarkdown?: boolean;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownMentionPatterns(mentions: MentionTarget[]) {
  return mentions
    .flatMap((mention) => [
      { raw: mention.name, displayName: mention.displayName },
      { raw: mention.displayName, displayName: mention.displayName },
      ...(mention.aliases ?? []).map((alias) => ({ raw: alias, displayName: mention.displayName })),
    ])
    .filter((mention) => mention.raw.trim().length > 0)
    .sort((a, b) => b.raw.length - a.raw.length);
}

function replaceKnownMentions(text: string, mentions: MentionTarget[]) {
  let result = text;
  for (const mention of knownMentionPatterns(mentions)) {
    const pattern = new RegExp(`@${escapeRegExp(mention.raw)}(?=[\\s,.:!?，。！？：]|$)`, "g");
    result = result.replace(pattern, `@${mention.displayName}`);
  }
  return result;
}

function displayMention(token: string, mentions: MentionTarget[]) {
  const handle = token.slice(1).toLowerCase();
  const mention = mentions.find(
    (target) =>
      target.name.toLowerCase() === handle ||
      target.displayName.toLowerCase() === handle ||
      (target.aliases ?? []).some((alias) => alias.toLowerCase() === handle),
  );
  return mention ? `@${mention.displayName}` : token;
}

function taskReferenceClassName() {
  return "inline-flex h-5 max-w-full items-center rounded border border-border bg-muted/50 px-1.5 text-[11px] font-semibold leading-none text-foreground";
}

function taskStatusClassName(status: Task["status"]) {
  if (status === "blocked" || status === "changes_requested") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "done") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "in_progress" || status === "in_review") {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  return "border-border bg-background text-muted-foreground";
}

function formatTaskStatus(status: Task["status"]) {
  return status.replaceAll("_", " ");
}

function taskAssigneeLabel(task: Task, mentions: MentionTarget[]) {
  if (!task.assignee_id) return null;
  const mention = mentions.find((target) => target.id === task.assignee_id);
  if (mention) return mention.displayName;
  if (task.assignee_type === "agent") return "Agent";
  if (task.assignee_type === "human") return "Human";
  return null;
}

function parseReminderMessage(content: string) {
  const match = content.match(/^\[Reminder for ([^\]]+)\]\s*([\s\S]*)$/);
  if (!match) return null;
  return { recipient: match[1].trim(), body: match[2].trim() };
}

function reminderRecipientLabel(recipient: string, mentions: MentionTarget[]) {
  const normalized = recipient.toLowerCase();
  const mention = mentions.find(
    (target) =>
      target.displayName.toLowerCase() === normalized ||
      target.name.toLowerCase() === normalized ||
      (target.aliases ?? []).some((alias) => alias.toLowerCase() === normalized),
  );
  return mention?.displayName ?? recipient;
}

function TaskReferenceChip({
  taskNumber,
  task,
  mentions,
  onOpenTask,
}: {
  taskNumber: number;
  task?: Task;
  mentions: MentionTarget[];
  onOpenTask?: (task: Task) => void;
}) {
  const assigneeLabel = task ? taskAssigneeLabel(task, mentions) : null;
  const title = task ? `#${task.task_number} ${task.title}` : undefined;
  const content = task ? (
    <>
      <span>#{taskNumber}</span>
      <span className={`rounded-sm border px-1 py-px text-[10px] font-medium leading-none ${taskStatusClassName(task.status)}`}>
        {formatTaskStatus(task.status)}
      </span>
      {assigneeLabel ? <span className="truncate text-[10px] font-medium text-muted-foreground">· {assigneeLabel}</span> : null}
    </>
  ) : (
    <>#{taskNumber}</>
  );

  if (task && onOpenTask) {
    return (
      <button
        type="button"
        className={`${taskReferenceClassName()} gap-1 align-baseline transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenTask(task);
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={`${taskReferenceClassName()} ${task ? "gap-1" : ""}`} title={title}>
      {content}
    </span>
  );
}

function replaceTaskReferencesWithMarkdown(text: string) {
  return text.replace(/(^|[^\w/#])#(\d+)\b/g, (_match, prefix: string, taskNumber: string) => {
    return `${prefix}[#${taskNumber}](#zano-task-${taskNumber})`;
  });
}

function ReminderCallout({
  recipient,
  body,
  mentions,
  tasksByNumber,
  onOpenTask,
}: {
  recipient: string;
  body: string;
  mentions: MentionTarget[];
  tasksByNumber: Map<number, Task>;
  onOpenTask?: (task: Task) => void;
}) {
  const recipientLabel = reminderRecipientLabel(recipient, mentions);

  return (
    <div className="not-prose my-1 max-w-2xl rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-foreground shadow-xs">
      <div className="flex gap-2.5">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <AlarmClock className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Reminder</span>
            <span className="inline-flex max-w-[45%] shrink-0 items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary">
              <span className="truncate">@{recipientLabel}</span>
            </span>
          </div>
          {body ? (
            <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
              {renderInlineText(body, mentions, tasksByNumber, onOpenTask)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function renderInlineText(
  text: string,
  mentions: MentionTarget[],
  tasksByNumber: Map<number, Task>,
  onOpenTask?: (task: Task) => void,
) {
  return text.split(/(@[^\s,.:!?，。！？]+|#\d+\b)/g).map((part, j) => {
    if (part.startsWith("@")) {
      return (
        <span key={j} className="rounded bg-primary/10 px-0.5 text-primary font-medium">
          {displayMention(part, mentions)}
        </span>
      );
    }

    if (/^#\d+\b/.test(part)) {
      const taskNumber = Number(part.slice(1));
      return (
        <TaskReferenceChip
          key={j}
          taskNumber={taskNumber}
          task={tasksByNumber.get(taskNumber)}
          mentions={mentions}
          onOpenTask={onOpenTask}
        />
      );
    }

    return part;
  });
}

const emptyTasksByNumber = new Map<number, Task>();

export function MessageBody({ content, senderType, mentions = [], tasksByNumber, onOpenTask, renderMarkdown = false }: MessageBodyProps) {
  const taskLookup = tasksByNumber ?? emptyTasksByNumber;
  const reminder = senderType === "system" ? parseReminderMessage(content) : null;
  const displayContent = replaceTaskReferencesWithMarkdown(replaceKnownMentions(content, mentions));

  if (reminder) {
    return (
      <ReminderCallout
        recipient={reminder.recipient}
        body={replaceKnownMentions(reminder.body, mentions)}
        mentions={mentions}
        tasksByNumber={taskLookup}
        onOpenTask={onOpenTask}
      />
    );
  }

  return (
    <div
      className="prose-message text-[15px] wrap-break-word subpixel-antialiased prose-headings:antialiased"
      style={{ lineHeight: "1.54" }}
    >
      {senderType === "agent" || renderMarkdown ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const taskMatch = href?.match(/^#zano-task-(\d+)$/);
              if (taskMatch) {
                const taskNumber = Number(taskMatch[1]);
                return (
                  <TaskReferenceChip
                    taskNumber={taskNumber}
                    task={taskLookup.get(taskNumber)}
                    mentions={mentions}
                    onOpenTask={onOpenTask}
                  />
                );
              }

              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {displayContent}
        </ReactMarkdown>
      ) : (
        <span className="whitespace-pre-wrap">{renderInlineText(content, mentions, taskLookup, onOpenTask)}</span>
      )}
    </div>
  );
}
