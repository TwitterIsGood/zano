"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GeneratedAvatar } from "@/components/generated-avatar";
import { MessageBody } from "@/components/message-body";
import type { Task } from "@zano/shared";

interface TaskDetailDrawerProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TaskDetailPayload {
  task: Task;
  comments: TaskCommentDetail[];
  artifacts: TaskArtifactDetail[];
  dependencies: TaskDependencyDetail[];
  events: TaskEventDetail[];
  verifications: TaskVerificationDetail[];
  reviews: TaskReviewDetail[];
}

interface TaskCommentAuthorDetail {
  id: string;
  type: string;
  displayName: string;
  avatarId: string;
  avatarUrl: string | null;
}

interface TaskCommentDetail {
  id: string;
  author_id: string;
  author_type: string;
  content: string;
  created_at: string;
  author?: TaskCommentAuthorDetail;
}

interface TaskArtifactDetail {
  id: string;
  artifact_type: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
  created_by_id: string;
  created_by_type: string;
  created_at: string;
}

interface TaskDependencyDetail {
  predecessor_task_id: string;
  successor_task_id: string;
  dependency_type: string;
  created_at: string;
}

interface TaskEventDetail {
  id: string;
  actor_id: string;
  actor_type: string;
  event_type: string;
  from_state: Record<string, unknown> | null;
  to_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

interface TaskVerificationDetail {
  id: string;
  step_id: string | null;
  actor_id: string;
  actor_type: string;
  verification_type: string;
  command_or_check: string;
  output_summary: string | null;
  passed: boolean;
  evidence_url: string | null;
  created_at: string;
}

interface TaskReviewDetail {
  id: string;
  agent_run_id: string | null;
  reviewer_id: string;
  reviewer_type: string;
  review_type: string;
  findings: TaskReviewFinding[];
  verdict: string;
  summary: string;
  created_at: string;
}

interface TaskReviewFinding {
  severity: string;
  category: string;
  location?: string;
  recommendation: string;
  blocking: boolean;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortId(value: string | null) {
  return value ? value.slice(0, 8) : "none";
}

function fallbackCommentAuthor(comment: TaskCommentDetail): TaskCommentAuthorDetail {
  const prefix = comment.author_type === "agent" ? "Agent" : comment.author_type === "human" ? "Human" : "Author";
  return {
    id: comment.author_id,
    type: comment.author_type,
    displayName: `${prefix} ${shortId(comment.author_id)}`,
    avatarId: comment.author_id,
    avatarUrl: null,
  };
}

function commentSenderType(comment: TaskCommentDetail): "human" | "agent" | "system" {
  if (comment.author_type === "human" || comment.author_type === "agent") return comment.author_type;
  return "system";
}

function JsonFallback({ value }: { value: Record<string, unknown> | null }) {
  if (!value || Object.keys(value).length === 0) return null;
  return <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

function EmptyState({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function TaskDetailDrawer({ task, open, onOpenChange }: TaskDetailDrawerProps) {
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null);
  const tasksByNumber = new Map<number, Task>();
  if (detail?.task) tasksByNumber.set(detail.task.task_number, detail.task);
  else if (task) tasksByNumber.set(task.task_number, task);

  useEffect(() => {
    if (!task || !open) return;

    let cancelled = false;

    async function load(taskId: string) {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (res.ok && !cancelled) setDetail((await res.json()) as TaskDetailPayload);
    }

    load(task.id);
    return () => {
      cancelled = true;
    };
  }, [task, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[520px] overflow-y-auto sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle>{task ? `#${task.task_number} ${task.title}` : "Task"}</SheetTitle>
        </SheetHeader>
        {task ? (
          <div className="mt-4 space-y-5 px-6 pb-6">
            <div className="flex gap-2">
              <Badge>{task.status}</Badge>
              <Badge variant="outline">{task.priority}</Badge>
            </div>
            {task.description ? <p className="text-sm text-muted-foreground">{task.description}</p> : null}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Tags</h3>
              {task.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {task.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                </div>
              ) : <EmptyState>No tags</EmptyState>}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Workflow</h3>
              <p className="text-sm text-muted-foreground">Gate: {task.current_gate ?? "none"}</p>
              <p className="text-sm text-muted-foreground">Review: {task.review_status ?? "none"}</p>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Comments</h3>
              {detail?.comments.length ? (
                <div className="space-y-3">
                  {detail.comments.map((comment) => {
                    const author = comment.author ?? fallbackCommentAuthor(comment);
                    return (
                      <article key={comment.id} className="rounded-md border p-3">
                        <div className="mb-2 flex items-start gap-2">
                          <GeneratedAvatar id={author.avatarId} name={author.displayName} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">{author.displayName}</span>
                              <Badge variant="outline">{author.type}</Badge>
                              <span>{formatDate(comment.created_at)}</span>
                            </div>
                            <MessageBody
                              content={comment.content}
                              senderType={commentSenderType(comment)}
                              tasksByNumber={tasksByNumber}
                              renderMarkdown
                            />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : <EmptyState>No comments yet</EmptyState>}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Artifacts</h3>
              {detail?.artifacts.length ? (
                <div className="space-y-3">
                  {detail.artifacts.map((artifact) => (
                    <article key={artifact.id} className="rounded-md border p-3">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{artifact.artifact_type}</Badge>
                        {artifact.url ? <a className="text-sm font-medium underline" href={artifact.url} target="_blank" rel="noreferrer">{artifact.title}</a> : <span className="text-sm font-medium">{artifact.title}</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">Added by {artifact.created_by_type} {shortId(artifact.created_by_id)} on {formatDate(artifact.created_at)}</p>
                      <JsonFallback value={artifact.metadata} />
                    </article>
                  ))}
                </div>
              ) : <EmptyState>No artifacts yet</EmptyState>}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Dependencies</h3>
              {detail?.dependencies.length ? (
                <div className="space-y-2">
                  {detail.dependencies.map((dependency) => {
                    const isBlockedBy = dependency.successor_task_id === task.id;
                    return (
                      <div key={`${dependency.predecessor_task_id}-${dependency.successor_task_id}`} className="rounded-md border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{dependency.dependency_type}</Badge>
                          <span>{isBlockedBy ? "Blocked by" : "Blocks"}</span>
                          <span className="font-mono text-xs">{shortId(isBlockedBy ? dependency.predecessor_task_id : dependency.successor_task_id)}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">Added {formatDate(dependency.created_at)}</p>
                      </div>
                    );
                  })}
                </div>
              ) : <EmptyState>No dependencies</EmptyState>}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Reviews</h3>
              {detail?.reviews.length ? (
                <div className="space-y-3">
                  {detail.reviews.map((review) => (
                    <article key={review.id} className="rounded-md border p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge>{review.verdict}</Badge>
                        <Badge variant="outline">{review.review_type}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(review.created_at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm">{review.summary}</p>
                      {review.findings.length ? (
                        <ul className="mt-3 space-y-2">
                          {review.findings.map((finding, index) => (
                            <li key={`${review.id}-${index}`} className="rounded-md bg-muted p-2 text-xs">
                              <div className="mb-1 flex flex-wrap gap-2">
                                <Badge variant="secondary">{finding.severity}</Badge>
                                <span className="font-medium">{finding.category}</span>
                                {finding.blocking ? <Badge variant="destructive">blocking</Badge> : null}
                              </div>
                              {finding.location ? <p className="font-mono">{finding.location}</p> : null}
                              <p>{finding.recommendation}</p>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : <EmptyState>No reviews yet</EmptyState>}
            </section>
            {detail?.verifications.length ? (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Verifications</h3>
                <div className="space-y-3">
                  {detail.verifications.map((verification) => (
                    <article key={verification.id} className="rounded-md border p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant={verification.passed ? "secondary" : "destructive"}>{verification.passed ? "passed" : "failed"}</Badge>
                        <Badge variant="outline">{verification.verification_type}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(verification.created_at)}</span>
                      </div>
                      <p className="font-mono text-xs">{verification.command_or_check}</p>
                      {verification.output_summary ? <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{verification.output_summary}</p> : null}
                      {verification.evidence_url ? <a className="mt-2 block text-sm underline" href={verification.evidence_url} target="_blank" rel="noreferrer">Evidence</a> : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Events</h3>
              {detail?.events.length ? (
                <div className="space-y-3">
                  {detail.events.map((event) => (
                    <article key={event.id} className="rounded-md border p-3">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{event.event_type}</Badge>
                        <span className="text-xs text-muted-foreground">{event.actor_type} {shortId(event.actor_id)} · {formatDate(event.created_at)}</span>
                      </div>
                      {event.reason ? <p className="whitespace-pre-wrap text-sm">{event.reason}</p> : null}
                      <JsonFallback value={event.to_state} />
                    </article>
                  ))}
                </div>
              ) : <EmptyState>No events yet</EmptyState>}
            </section>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
