import type { ClaudeGatedSteeringEvent, GatedFlushReason, GatedSteeringState } from "./types";

const RECENT_EVENT_LIMIT = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(state: GatedSteeringState, type: string, detail: Record<string, string | number | boolean | null>): GatedSteeringState {
  return {
    ...state,
    recentEvents: [...state.recentEvents, { type, at: nowIso(), detail }].slice(-RECENT_EVENT_LIMIT),
  };
}

export function createGatedSteeringState(): GatedSteeringState {
  return {
    phase: "idle",
    outstandingToolUses: 0,
    compacting: false,
    toolBoundaryFlushDisabled: process.env.SLOCK_CLAUDE_GATED_STEERING_TOOL_BOUNDARY === "0",
    lastFlushReason: null,
    recentEvents: [],
    inFlightBatch: null,
  };
}

export function isThinkingBlockMutationError(message: string): boolean {
  return /thinking.*redacted_thinking|redacted_thinking.*thinking/i.test(message) && /cannot be modified/i.test(message);
}

export function recordGatedSteeringEvent(state: GatedSteeringState, event: ClaudeGatedSteeringEvent): GatedSteeringState {
  if (event.type === "assistant_thinking" || event.type === "assistant_text") {
    return appendEvent({ ...state, phase: "assistant_continuation" }, event.type, {});
  }

  if (event.type === "tool_call") {
    return appendEvent(
      { ...state, phase: "tool_wait", outstandingToolUses: state.outstandingToolUses + 1 },
      event.type,
      { toolUseId: event.toolUseId },
    );
  }

  if (event.type === "tool_result") {
    const outstandingToolUses = Math.max(0, state.outstandingToolUses - 1);
    return appendEvent(
      { ...state, phase: outstandingToolUses === 0 ? "tool_boundary" : "tool_wait", outstandingToolUses },
      event.type,
      { toolUseId: event.toolUseId, outstandingToolUses },
    );
  }

  if (event.type === "compaction_started") {
    return appendEvent({ ...state, phase: "compacting", compacting: true }, event.type, {});
  }

  if (event.type === "compaction_finished") {
    return appendEvent({ ...state, phase: "assistant_continuation", compacting: false }, event.type, {});
  }

  if (event.type === "turn_end") {
    return appendEvent(
      { ...state, phase: "idle", outstandingToolUses: 0, compacting: false, inFlightBatch: null },
      event.type,
      {},
    );
  }

  if (event.type === "runtime_error" && isThinkingBlockMutationError(event.message)) {
    return appendEvent(
      {
        ...state,
        phase: "error",
        outstandingToolUses: 0,
        compacting: false,
        toolBoundaryFlushDisabled: true,
      },
      event.type,
      { thinkingMutation: true },
    );
  }

  return appendEvent({ ...state, phase: "error" }, event.type, { thinkingMutation: false });
}

export function decideGatedFlush(
  state: GatedSteeringState,
  reason: GatedFlushReason,
): { action: "deliver_full" | "notify" | "wait"; reason: string } {
  if (state.compacting || state.phase === "compacting") {
    return { action: "wait", reason: "compacting" };
  }

  if (state.outstandingToolUses > 0 || state.phase === "tool_wait") {
    return { action: "wait", reason: "tool_wait" };
  }

  if (reason === "turn_end" || reason === "idle") {
    return { action: "deliver_full", reason };
  }

  if (state.toolBoundaryFlushDisabled) {
    return { action: "wait", reason: "tool_boundary_disabled" };
  }

  if (reason === "tool_boundary" && state.phase === "tool_boundary") {
    return { action: "notify", reason };
  }

  return { action: "wait", reason: "unsafe_boundary" };
}
