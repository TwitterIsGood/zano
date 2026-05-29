import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGatedSteeringState,
  decideGatedFlush,
  isThinkingBlockMutationError,
  recordGatedSteeringEvent,
} from "./gated-steering";

describe("Claude gated steering", () => {
  const originalToolBoundaryEnv = process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY;

  beforeEach(() => {
    delete process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY;
  });

  afterEach(() => {
    if (originalToolBoundaryEnv === undefined) {
      delete process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY;
    } else {
      process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY = originalToolBoundaryEnv;
    }
  });

  it("does not flush full messages while a tool is outstanding", () => {
    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "tool_call", toolUseId: "tool-1" });

    expect(state.phase).toBe("tool_wait");
    expect(state.outstandingToolUses).toBe(1);
    expect(decideGatedFlush(state, "tool_boundary")).toEqual({ action: "wait", reason: "tool_wait" });
  });

  it("sends notification at tool boundary when notification is safe and enabled", () => {
    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "tool_call", toolUseId: "tool-1" });
    state = recordGatedSteeringEvent(state, { type: "tool_result", toolUseId: "tool-1" });

    expect(state.phase).toBe("tool_boundary");
    expect(state.outstandingToolUses).toBe(0);
    expect(decideGatedFlush(state, "tool_boundary")).toEqual({ action: "notify", reason: "tool_boundary" });
  });

  it("disables tool-boundary notification when strict parity env is 0", () => {
    process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY = "0";

    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "tool_call", toolUseId: "tool-1" });
    state = recordGatedSteeringEvent(state, { type: "tool_result", toolUseId: "tool-1" });

    expect(state.phase).toBe("tool_boundary");
    expect(state.outstandingToolUses).toBe(0);
    expect(decideGatedFlush(state, "tool_boundary")).toEqual({ action: "wait", reason: "tool_boundary_disabled" });
  });

  it("never flushes during compaction", () => {
    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "compaction_started" });

    expect(state.phase).toBe("compacting");
    expect(decideGatedFlush(state, "compaction_boundary")).toEqual({ action: "wait", reason: "compacting" });
  });

  it("flushes full delivery only at turn end or idle", () => {
    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "assistant_text" });
    state = recordGatedSteeringEvent(state, { type: "turn_end" });

    expect(state.phase).toBe("idle");
    expect(decideGatedFlush(state, "turn_end")).toEqual({ action: "deliver_full", reason: "turn_end" });
  });

  it("turns thinking mutation errors into safe-boundary protection", () => {
    let state = createGatedSteeringState();
    state = recordGatedSteeringEvent(state, { type: "tool_call", toolUseId: "tool-1" });
    state = recordGatedSteeringEvent(state, {
      type: "runtime_error",
      message: "thinking cannot be modified after redacted_thinking is present",
    });

    expect(isThinkingBlockMutationError("redacted_thinking block cannot be modified while thinking continues")).toBe(true);
    expect(state.phase).toBe("error");
    expect(state.toolBoundaryFlushDisabled).toBe(true);
    expect(state.outstandingToolUses).toBe(0);
    expect(decideGatedFlush(state, "tool_boundary")).toEqual({ action: "wait", reason: "tool_boundary_disabled" });
  });
});
