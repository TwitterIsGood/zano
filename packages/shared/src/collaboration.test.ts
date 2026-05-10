import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  hasDependencyCycle,
  type TaskDependencyEdge,
  type TaskStatus,
  type TaskTransitionContext,
} from "./collaboration";

function ctx(overrides: Partial<TaskTransitionContext> = {}): TaskTransitionContext {
  return {
    hasBlockingDependencies: false,
    hasPassingVerification: true,
    requiresReview: false,
    hasPassingRequiredReview: false,
    ...overrides,
  };
}

describe("canTransitionTask", () => {
  it("allows todo tasks to start when they are not blocked", () => {
    expect(canTransitionTask("todo", "in_progress", ctx())).toEqual({ allowed: true });
  });

  it("blocks todo tasks from starting when blocking dependencies remain", () => {
    expect(
      canTransitionTask("todo", "in_progress", ctx({ hasBlockingDependencies: true })),
    ).toEqual({ allowed: false, reason: "Task has unresolved blocking dependencies" });
  });

  it("allows todo tasks to become blocked", () => {
    expect(canTransitionTask("todo", "blocked", ctx())).toEqual({ allowed: true });
  });

  it("allows blocked tasks to resume when they are not blocked", () => {
    expect(canTransitionTask("blocked", "in_progress", ctx())).toEqual({ allowed: true });
  });

  it("allows in_progress tasks to move to changes_requested", () => {
    expect(canTransitionTask("in_progress", "changes_requested", ctx())).toEqual({ allowed: true });
  });

  it("allows verified simple tasks to move directly from in_progress to done", () => {
    expect(canTransitionTask("in_progress", "done", ctx())).toEqual({ allowed: true });
  });

  it("blocks in_progress to done without passing verification", () => {
    expect(
      canTransitionTask("in_progress", "done", ctx({ hasPassingVerification: false })),
    ).toEqual({ allowed: false, reason: "Task needs passing verification evidence" });
  });

  it("requires review before done when review policy applies", () => {
    expect(
      canTransitionTask("in_progress", "done", ctx({ requiresReview: true })),
    ).toEqual({ allowed: false, reason: "Task requires review before completion" });
  });

  it("returns the verification reason first when verification and review are missing", () => {
    expect(
      canTransitionTask(
        "in_progress",
        "done",
        ctx({ hasPassingVerification: false, requiresReview: true }),
      ),
    ).toEqual({ allowed: false, reason: "Task needs passing verification evidence" });
  });

  it("allows reviewed tasks to complete from in_review", () => {
    expect(
      canTransitionTask(
        "in_review",
        "done",
        ctx({ requiresReview: true, hasPassingRequiredReview: true }),
      ),
    ).toEqual({ allowed: true });
  });

  it("returns a reason for invalid transitions", () => {
    expect(canTransitionTask("done", "in_progress", ctx())).toEqual({
      allowed: false,
      reason: "Invalid transition from done to in_progress",
    });
  });

  it("allows done tasks to be archived", () => {
    expect(canTransitionTask("done", "archived", ctx())).toEqual({ allowed: true });
  });

  it("blocks archived tasks from transitioning back to todo", () => {
    expect(canTransitionTask("archived", "todo", ctx())).toEqual({
      allowed: false,
      reason: "Invalid transition from archived to todo",
    });
  });
});

describe("hasDependencyCycle", () => {
  it("returns false when dependencies are acyclic", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-c" },
    ];

    expect(hasDependencyCycle(edges)).toBe(false);
  });

  it("returns true when dependencies contain a direct cycle", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-a" },
    ];

    expect(hasDependencyCycle(edges)).toBe(true);
  });

  it("returns true when dependencies contain an indirect cycle", () => {
    const edges: TaskDependencyEdge[] = [
      { predecessorTaskId: "task-a", successorTaskId: "task-b" },
      { predecessorTaskId: "task-b", successorTaskId: "task-c" },
      { predecessorTaskId: "task-c", successorTaskId: "task-a" },
    ];

    expect(hasDependencyCycle(edges)).toBe(true);
  });
});
