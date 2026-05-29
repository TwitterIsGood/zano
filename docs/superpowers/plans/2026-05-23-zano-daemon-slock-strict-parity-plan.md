# Zano Daemon Slock Strict-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the existing Zano daemon v2 so its delivery custody, gated runtime steering, local materialization, freshness checks, runtime-profile controls, and agent collaboration contract match the reviewed Slock v0.52.2 mechanisms without adding non-Slock workflow layers.

**Architecture:** Keep the server/router responsible for deciding which agents should be notified, and move daemon/runtime code toward Slock-style custody and safe-boundary semantics. Split small pure runtime helpers out of large bridge files so ACK semantics, gated steering, runtime profiles, materialization, freshness, and control messages are testable without launching Claude Code.

**Tech Stack:** TypeScript, Node 20, pnpm workspaces, Vitest for bridge and new CLI helper tests, Supabase SQL/RLS, Next.js UI labels, Claude Code runtime process management.

---

## Scope Boundaries

This plan implements the strict-parity design in `docs/superpowers/specs/2026-05-23-zano-daemon-slock-strict-parity-design.md`.

Required behaviors:

- ACK/accepted means daemon custody only.
- No ordinary `agent:deliver:completed` wire protocol.
- Unacked deliveries remain retryable; ACKed deliveries are daemon-owned diagnostics/queue/runtime state.
- Claude busy handling uses gated steering phases and safe-boundary delivery.
- Runtime-profile migration/release controls use reserved runtime-control action semantics.
- Side effects respect freshness hold for message send, task claim, and task update.
- Thread wake-up includes bounded join context.
- Local runtime layout mirrors Slock path roles under `.zano` / `~/.zano`.
- Prompt teaches teammate collaboration through CLI, threads, tasks, mentions, freshness, and quiet work.
- UI labels distinguish custody, delivery, diagnostic errors, and derived work evidence.

Forbidden behaviors:

- No `daemon_dead_letters` table.
- No user-facing dead-letter inbox or manual replay product workflow for ACKed deliveries.
- No ordinary chat/task MCP collaboration surface claimed as Slock parity.
- No personality/emotion layer.
- No raw bridge, Supabase, agent-token, proxy-token, MCP, or machine-lock token values in prompts, wrappers, logs, trace text, or UI.

---

## File Structure

### Create

- `apps/omni/src/runtime/runtime-profiles.ts` — runtime driver profile definitions and lookup helpers. Claude is the active strict-parity path; other observed profiles are represented so Claude-specific behavior is explicit.
- `apps/omni/src/runtime/runtime-profiles.test.ts` — profile coverage for Claude, direct-stdin runtimes, and non-stdin/per-turn runtimes.
- `apps/omni/src/runtime/gated-steering.ts` — pure Claude gated-steering state machine, event reducer, flush decision helper, and mutation-error detector.
- `apps/omni/src/runtime/gated-steering.test.ts` — safe-boundary and mutation-error tests.
- `apps/omni/src/runtime/claude-stream-events.ts` — maps Claude stream-json events into gated-steering events without depending on `AgentManager`.
- `apps/omni/src/runtime/claude-stream-events.test.ts` — stream event mapping tests.
- `apps/omni/src/runtime/runtime-profile-controls.ts` — reserved runtime-profile migration/release-notice control lifecycle helpers.
- `apps/omni/src/runtime/runtime-profile-controls.test.ts` — control ACK and migration-done tests.
- `apps/omni/src/runtime/runtime-session-ref.ts` — native Claude/Codex session reference resolver with `.zano/runtime-sessions` fallback handoff.
- `apps/omni/src/runtime/runtime-session-ref.test.ts` — native/fallback session reference tests.
- `packages/cli/src/local-state.ts` — CLI-local state reader/writer for `.zano/state.json`, freshness cursors, and drafts.
- `packages/cli/src/freshness.ts` — pure freshness preflight and draft behavior helpers for CLI side effects.
- `packages/cli/src/freshness.test.ts` — freshness hold, send-draft, and explicit `--anyway` tests.

### Modify

- `apps/omni/src/runtime/types.ts` — delivery custody fields, state transition table, runtime profile/control types, and no-ordinary-completion helpers.
- `apps/omni/src/runtime/types.test.ts` — transition and derived-completion tests.
- `apps/omni/src/runtime/delivery-ledger.ts` — preserve accepted/ACK custody semantics, add `ackTraceparent` and `lastRuntimeEventAt`, prevent ACK from setting completion.
- `apps/omni/src/runtime/delivery-ledger.test.ts` — accepted custody and no-completion tests.
- `apps/omni/src/runtime/delivery-runtime.ts` — accept custody before queue/delivery, distinguish rejection/no ACK from accepted daemon-owned state, and record safe queue reasons.
- `apps/omni/src/runtime/delivery-runtime.test.ts` — ACK/retry boundary tests.
- `apps/omni/src/runtime/agent-supervisor.ts` — store runtime profile, gated state, inbox, pending notification count, and process-adjacent runtime facts.
- `apps/omni/src/runtime/agent-supervisor.test.ts` — inbox/gated snapshot tests.
- `apps/omni/src/agent-manager.ts` — integrate gated event mapping, pending notification delivery, turn-end full flush, profile controls, materialized env, and session refs.
- `apps/omni/src/agent-manager-runtime-session.test.ts` — session/ref/control integration tests.
- `apps/omni/src/bridge.ts` — send ACK only when daemon accepted custody; do not emit ordinary completion.
- `apps/omni/src/bridge-runtime.test.ts` — wire ACK tests.
- `apps/omni/src/runtime/cli-transport.ts` — materialize `.zano/zano`, token/proxy-token file references, local state path, and secret-safe wrapper body.
- `apps/omni/src/runtime/cli-transport.test.ts` — layout, permissions, env reference, and secret absence tests.
- `apps/omni/src/runtime/prompt-materializer.ts` — write `.zano/claude-system-prompt.md`, MCP config, prompt hash, and teammate runtime contract inputs.
- `apps/omni/src/runtime/prompt-materializer.test.ts` — prompt path and contract coverage tests.
- `apps/omni/src/runtime/session-ledger.ts` — record launch ID, sessionRef, workspacePathRef, reachability, runtime profile facts.
- `apps/omni/src/runtime/session-ledger.test.ts` — session reporting tests.
- `apps/omni/src/system-prompt.ts` — Slock-like teammate contract sections and freshness/control wording.
- `apps/omni/src/a2a-protocol.ts` — include bounded thread join context in deliveries.
- `apps/omni/src/a2a-protocol.test.ts` — thread join context and default thread target tests.
- `packages/db/src/daemon.sql` — source-of-truth daemon schema fields/states without dead-letter product state.
- `packages/db/scripts/verify-daemon-schema.mjs` — verify ACK fields and forbidden dead-letter absence.
- `packages/db/src/schema.ts` and `packages/db/src/index.ts` — generated/exported type alignment if this repo keeps checked-in DB types.
- `packages/cli/package.json` — add a `test` script for the new CLI helper tests.
- `packages/cli/src/index.ts` — read token/proxy token files, use freshness helpers in `message send`, `message send-draft`, `task claim`, and `task update`.
- `apps/web/src/components/message-delivery-drawer.tsx` — label delivery states as custody/queue/diagnostic/derived evidence.
- `apps/web/src/hooks/use-agent-activity.ts` and `apps/web/src/hooks/use-member-activity.ts` — expose new runtime queue/profile labels if needed by the drawer.
- `packages/shared/src/index.ts` — share runtime state labels only if web and bridge both need the same literals.

---

## Task 1: Add runtime driver profiles

**Files:**
- Create: `apps/omni/src/runtime/runtime-profiles.ts`
- Create: `apps/omni/src/runtime/runtime-profiles.test.ts`
- Modify: `apps/omni/src/runtime/types.ts`
- Test: `apps/omni/src/runtime/runtime-profiles.test.ts`

- [ ] **Step 1: Write the failing profile tests**

Create `apps/omni/src/runtime/runtime-profiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CLAUDE_RUNTIME_PROFILE, getRuntimeDriverProfile, listRuntimeDriverProfiles } from "./runtime-profiles";

describe("runtime driver profiles", () => {
  it("models Claude as the strict-parity gated stdin runtime", () => {
    expect(CLAUDE_RUNTIME_PROFILE).toEqual({
      runtime: "claude",
      lifecycle: "persistent",
      supportsStdinNotification: true,
      busyDeliveryMode: "gated",
      supportsNativeStandingPrompt: true,
      terminateProcessOnTurnEnd: false,
    });
  });

  it("keeps direct-stdin runtimes separate from Claude gated behavior", () => {
    expect(getRuntimeDriverProfile("codex")).toMatchObject({
      runtime: "codex",
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
    });
    expect(getRuntimeDriverProfile("kimi")).toMatchObject({
      runtime: "kimi",
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
    });
  });

  it("keeps non-stdin and per-turn runtimes out of Claude gated delivery", () => {
    expect(getRuntimeDriverProfile("copilot")).toMatchObject({ busyDeliveryMode: "none", supportsStdinNotification: false });
    expect(getRuntimeDriverProfile("cursor")).toMatchObject({ busyDeliveryMode: "none", supportsStdinNotification: false });
    expect(getRuntimeDriverProfile("gemini")).toMatchObject({ busyDeliveryMode: "none", supportsStdinNotification: false });
    expect(getRuntimeDriverProfile("opencode")).toMatchObject({
      lifecycle: "per_turn",
      busyDeliveryMode: "none",
      terminateProcessOnTurnEnd: true,
    });
  });

  it("lists every supported profile exactly once", () => {
    expect(listRuntimeDriverProfiles().map((profile) => profile.runtime).sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
      "gemini",
      "kimi",
      "opencode",
    ]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-profiles.test.ts
```

Expected: FAIL with an import error because `runtime-profiles.ts` does not exist.

- [ ] **Step 3: Add runtime profile types to `types.ts`**

Append these exported types to `apps/omni/src/runtime/types.ts`:

```ts
export type RuntimeKind = "claude" | "codex" | "kimi" | "copilot" | "cursor" | "gemini" | "opencode";

export type RuntimeLifecycle = "persistent" | "per_turn";

export type RuntimeBusyDeliveryMode = "gated" | "direct" | "none";

export interface RuntimeDriverProfile {
  runtime: RuntimeKind;
  lifecycle: RuntimeLifecycle;
  supportsStdinNotification: boolean;
  busyDeliveryMode: RuntimeBusyDeliveryMode;
  supportsNativeStandingPrompt: boolean;
  terminateProcessOnTurnEnd: boolean;
}
```

- [ ] **Step 4: Implement the runtime profiles**

Create `apps/omni/src/runtime/runtime-profiles.ts`:

```ts
import type { RuntimeDriverProfile, RuntimeKind } from "./types";

export const CLAUDE_RUNTIME_PROFILE: RuntimeDriverProfile = {
  runtime: "claude",
  lifecycle: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "gated",
  supportsNativeStandingPrompt: true,
  terminateProcessOnTurnEnd: false,
};

const RUNTIME_DRIVER_PROFILES: Record<RuntimeKind, RuntimeDriverProfile> = {
  claude: CLAUDE_RUNTIME_PROFILE,
  codex: {
    runtime: "codex",
    lifecycle: "persistent",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: false,
  },
  kimi: {
    runtime: "kimi",
    lifecycle: "persistent",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: false,
  },
  copilot: {
    runtime: "copilot",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  },
  cursor: {
    runtime: "cursor",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  },
  gemini: {
    runtime: "gemini",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  },
  opencode: {
    runtime: "opencode",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  },
};

export function getRuntimeDriverProfile(runtime: RuntimeKind): RuntimeDriverProfile {
  return RUNTIME_DRIVER_PROFILES[runtime];
}

export function listRuntimeDriverProfiles(): RuntimeDriverProfile[] {
  return Object.values(RUNTIME_DRIVER_PROFILES);
}
```

- [ ] **Step 5: Run the profile tests**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/omni/src/runtime/types.ts apps/omni/src/runtime/runtime-profiles.ts apps/omni/src/runtime/runtime-profiles.test.ts
git commit -m "feat: model daemon runtime profiles

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add Claude gated-steering state machine

**Files:**
- Create: `apps/omni/src/runtime/gated-steering.ts`
- Create: `apps/omni/src/runtime/gated-steering.test.ts`
- Modify: `apps/omni/src/runtime/types.ts`
- Test: `apps/omni/src/runtime/gated-steering.test.ts`

- [ ] **Step 1: Write the failing gated-steering tests**

Create `apps/omni/src/runtime/gated-steering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createGatedSteeringState,
  decideGatedFlush,
  isThinkingBlockMutationError,
  recordGatedSteeringEvent,
} from "./gated-steering";

describe("Claude gated steering", () => {
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
```

- [ ] **Step 2: Run the gated-steering tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- gated-steering.test.ts
```

Expected: FAIL with an import error because `gated-steering.ts` does not exist.

- [ ] **Step 3: Add gated-steering types**

Append these exported types to `apps/omni/src/runtime/types.ts`:

```ts
export type GatedSteeringPhase = "idle" | "assistant_continuation" | "tool_wait" | "tool_boundary" | "compacting" | "error";

export type GatedFlushReason = "idle" | "turn_end" | "tool_boundary" | "compaction_boundary";

export type GatedFlushAction = "deliver_full" | "notify" | "wait";

export interface GatedSteeringEventRecord {
  type: string;
  at: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface GatedSteeringState {
  phase: GatedSteeringPhase;
  outstandingToolUses: number;
  compacting: boolean;
  toolBoundaryFlushDisabled: boolean;
  lastFlushReason: GatedFlushReason | null;
  recentEvents: GatedSteeringEventRecord[];
  inFlightBatch: string[] | null;
}

export type ClaudeGatedSteeringEvent =
  | { type: "assistant_thinking" }
  | { type: "assistant_text" }
  | { type: "tool_call"; toolUseId: string }
  | { type: "tool_result"; toolUseId: string }
  | { type: "compaction_started" }
  | { type: "compaction_finished" }
  | { type: "turn_end" }
  | { type: "runtime_error"; message: string };
```

- [ ] **Step 4: Implement gated steering**

Create `apps/omni/src/runtime/gated-steering.ts`:

```ts
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
```

- [ ] **Step 5: Run the gated-steering tests**

Run:

```bash
pnpm --filter @biang/omni test -- gated-steering.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/omni/src/runtime/types.ts apps/omni/src/runtime/gated-steering.ts apps/omni/src/runtime/gated-steering.test.ts
git commit -m "feat: add Claude gated steering state machine

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Align delivery states with ACK custody semantics

**Files:**
- Modify: `apps/omni/src/runtime/types.ts`
- Modify: `apps/omni/src/runtime/types.test.ts`
- Test: `apps/omni/src/runtime/types.test.ts`

- [ ] **Step 1: Add failing custody transition tests**

Add these tests to `apps/omni/src/runtime/types.test.ts`:

```ts
it("treats accepted as daemon custody rather than business completion", () => {
  expect(canTransitionDelivery("received", "accepted")).toBe(true);
  expect(canTransitionDelivery("accepted", "queued_starting")).toBe(true);
  expect(canTransitionDelivery("accepted", "queued_busy")).toBe(true);
  expect(canTransitionDelivery("accepted", "queued_gated")).toBe(true);
  expect(canTransitionDelivery("accepted", "queued_compaction")).toBe(true);
  expect(canTransitionDelivery("accepted", "delivering")).toBe(true);
  expect(canTransitionDelivery("accepted", "completed")).toBe(false);
});

it("keeps completed as legacy derived evidence only", () => {
  expect(isDeliveryAckState("accepted")).toBe(true);
  expect(isDeliveryAckState("delivered")).toBe(true);
  expect(isDeliveryAckState("completed")).toBe(false);
  expect(isOrdinaryDeliveryCompletionState("completed")).toBe(false);
});
```

If `types.test.ts` does not import the new helpers, update the import:

```ts
import { canTransitionDelivery, isDeliveryAckState, isOrdinaryDeliveryCompletionState } from "./types";
```

- [ ] **Step 2: Run the type tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- types.test.ts
```

Expected: FAIL because `accepted -> completed` is currently valid or the new helper functions do not exist.

- [ ] **Step 3: Update delivery state transitions**

In `apps/omni/src/runtime/types.ts`, update the transition table so `accepted` is custody and can move into queue/delivery/diagnostic states, but not ordinary completion:

```ts
const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  planned: ["received", "deduped", "cancelled"],
  received: ["accepted", "failed", "cancelled"],
  deduped: [],
  accepted: ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering", "failed", "cancelled"],
  queued_starting: ["restarting_idle", "delivering", "queued_busy", "queued_gated", "failed", "cancelled"],
  queued_busy: ["queued_gated", "queued_compaction", "delivering", "failed", "cancelled"],
  queued_gated: ["queued_busy", "queued_compaction", "delivering", "failed", "cancelled"],
  queued_compaction: ["queued_gated", "delivering", "failed", "cancelled"],
  restarting_idle: ["delivering", "queued_busy", "queued_gated", "failed", "cancelled"],
  delivering: ["delivered", "queued_busy", "queued_gated", "queued_compaction", "failed", "cancelled"],
  delivered: ["queued_busy", "queued_gated", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
```

- [ ] **Step 4: Add custody helper functions**

Add these exports in `apps/omni/src/runtime/types.ts`:

```ts
export function isDeliveryAckState(state: DeliveryState): boolean {
  return state === "accepted" || state.startsWith("queued_") || state === "restarting_idle" || state === "delivering" || state === "delivered";
}

export function isOrdinaryDeliveryCompletionState(_state: DeliveryState): boolean {
  return false;
}
```

- [ ] **Step 5: Run the type tests**

Run:

```bash
pnpm --filter @biang/omni test -- types.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/omni/src/runtime/types.ts apps/omni/src/runtime/types.test.ts
git commit -m "fix: align delivery transitions with ACK custody

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Update daemon schema and ledger custody fields

**Files:**
- Modify: `packages/db/src/daemon.sql`
- Modify: `packages/db/scripts/verify-daemon-schema.mjs`
- Modify: `apps/omni/src/runtime/types.ts`
- Modify: `apps/omni/src/runtime/delivery-ledger.ts`
- Modify: `apps/omni/src/runtime/delivery-ledger.test.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/index.ts`
- Test: `apps/omni/src/runtime/delivery-ledger.test.ts`, `pnpm --filter @zano/db verify:daemon`

- [ ] **Step 1: Add failing ledger tests for ACK fields and no completion from ACK**

Add these tests to `apps/omni/src/runtime/delivery-ledger.test.ts`:

```ts
it("records ACK custody metadata without setting completion", async () => {
  const ledger = createTestLedger();
  const delivery = await ledger.createOrReuseDelivery(createDeliveryInput({ idempotencyKey: "ack-custody" }));
  const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
  const accepted = await ledger.transition(received.id, "accepted", {
    eventName: "delivery.ack.accepted",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  });

  expect(accepted.acceptedAt).toEqual(expect.any(String));
  expect(accepted.ackTraceparent).toBe("00-11111111111111111111111111111111-2222222222222222-01");
  expect(accepted.completedAt).toBeNull();
});

it("rejects ACK-to-completed as an ordinary delivery transition", async () => {
  const ledger = createTestLedger();
  const delivery = await ledger.createOrReuseDelivery(createDeliveryInput({ idempotencyKey: "no-completed-transition" }));
  const received = await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
  const accepted = await ledger.transition(received.id, "accepted", { eventName: "delivery.ack.accepted" });

  await expect(
    ledger.transition(accepted.id, "completed", { eventName: "delivery.completed" }),
  ).rejects.toThrow("Invalid delivery transition: accepted -> completed");
});
```

Use the existing test helper names in `delivery-ledger.test.ts`. If the file names them differently, adapt the calls to the existing local helpers without changing the asserted behavior.

- [ ] **Step 2: Run ledger tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- delivery-ledger.test.ts
```

Expected: FAIL because `ackTraceparent` is missing or `accepted -> completed` is still allowed.

- [ ] **Step 3: Add delivery record fields**

In `apps/omni/src/runtime/types.ts`, update `RuntimeDeliveryRecord` with these fields:

```ts
ackTraceparent: string | null;
lastRuntimeEventAt: string | null;
runtimeOutcome: string | null;
```

Keep `completedAt: string | null` only as a compatibility/derived-observation field. Do not add a method that sets it from ACK or turn end.

- [ ] **Step 4: Update daemon SQL source**

In `packages/db/src/daemon.sql`, update `daemon_deliveries` to include these columns in the table definition:

```sql
  ack_traceparent text,
  last_runtime_event_at timestamptz,
  runtime_outcome text check (runtime_outcome in (
    'queued_busy',
    'queued_during_start',
    'deferred_wake_message',
    'auto_restart_from_idle',
    'rejected_no_process',
    'stdin_idle_delivery',
    'queued_stalled_recovery',
    'queued_busy_non_stdin',
    'queued_before_session',
    'queued_compaction_boundary',
    'queued_busy_gated',
    'queued_busy_notification'
  )),
```

Do not add any table, enum, or view containing `dead_letter`.

- [ ] **Step 5: Update daemon schema verification**

In `packages/db/scripts/verify-daemon-schema.mjs`, add checks equivalent to:

```js
const requiredDeliveryColumns = ["ack_traceparent", "last_runtime_event_at", "runtime_outcome"];
for (const column of requiredDeliveryColumns) {
  if (!deliveryColumns.has(column)) {
    throw new Error(`daemon_deliveries missing ${column}`);
  }
}

for (const table of tables) {
  if (table.table_name.includes("dead_letter")) {
    throw new Error(`Forbidden dead-letter product table found: ${table.table_name}`);
  }
}
```

Use the existing query/result variables in the script. Keep the check local to daemon schema verification.

- [ ] **Step 6: Update ledger mapping**

In `apps/omni/src/runtime/delivery-ledger.ts`, update the record creation defaults:

```ts
ackTraceparent: null,
lastRuntimeEventAt: null,
runtimeOutcome: null,
```

Update transition logic so `accepted` sets `acceptedAt` and optional `ackTraceparent`, and no state sets `completedAt`:

```ts
if (state === "accepted") {
  next.acceptedAt = now;
  next.ackTraceparent = event.traceparent ?? existing.ackTraceparent;
}

if (event.runtimeOutcome) {
  next.runtimeOutcome = event.runtimeOutcome;
  next.lastRuntimeEventAt = now;
}
```

Update Supabase row mapping both directions:

```ts
ack_traceparent: record.ackTraceparent,
last_runtime_event_at: record.lastRuntimeEventAt,
runtime_outcome: record.runtimeOutcome,
```

and:

```ts
ackTraceparent: row.ack_traceparent,
lastRuntimeEventAt: row.last_runtime_event_at,
runtimeOutcome: row.runtime_outcome,
```

- [ ] **Step 7: Update checked-in DB types if present**

If `packages/db/src/schema.ts` declares `daemon_deliveries`, add `ack_traceparent`, `last_runtime_event_at`, and `runtime_outcome` to the row/insert/update types. If the file is generated from Supabase, run the repository's existing generation command after applying the SQL to the development database:

```bash
pnpm db:generate
```

Expected: generated type file includes the new columns and does not include a `daemon_dead_letters` table.

- [ ] **Step 8: Run tests and schema verification**

Run:

```bash
pnpm --filter @biang/omni test -- delivery-ledger.test.ts
pnpm --filter @zano/db verify:daemon
```

Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/daemon.sql packages/db/scripts/verify-daemon-schema.mjs packages/db/src/schema.ts packages/db/src/index.ts apps/omni/src/runtime/types.ts apps/omni/src/runtime/delivery-ledger.ts apps/omni/src/runtime/delivery-ledger.test.ts
git commit -m "fix: record daemon ACK custody without completion

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Refactor delivery runtime around ACK and retry boundaries

**Files:**
- Modify: `apps/omni/src/runtime/delivery-runtime.ts`
- Modify: `apps/omni/src/runtime/delivery-runtime.test.ts`
- Modify: `apps/omni/src/bridge.ts`
- Modify: `apps/omni/src/bridge-runtime.test.ts`
- Test: `apps/omni/src/runtime/delivery-runtime.test.ts`, `apps/omni/src/bridge-runtime.test.ts`

- [ ] **Step 1: Add failing delivery runtime ACK tests**

Add these tests to `apps/omni/src/runtime/delivery-runtime.test.ts`:

```ts
it("ACKs custody before queueing a delivery for a starting runtime", async () => {
  const harness = createDeliveryRuntimeHarness({ supervisorState: { state: "starting", busy: false } });
  const record = await harness.runtime.accept(createRuntimeDeliveryInput({ idempotencyKey: "starting-custody" }));

  expect(record.state).toBe("queued_starting");
  expect(record.acceptedAt).toEqual(expect.any(String));
  expect(record.completedAt).toBeNull();
  expect(harness.startCoordinator.enqueued).toHaveLength(1);
});

it("ACKs custody and records gated notification state when Claude is busy", async () => {
  const harness = createDeliveryRuntimeHarness({ supervisorState: { state: "busy", busy: true } });
  const record = await harness.runtime.accept(createRuntimeDeliveryInput({ idempotencyKey: "busy-custody" }));

  expect(record.state).toBe("queued_gated");
  expect(record.acceptedAt).toEqual(expect.any(String));
  expect(record.runtimeOutcome).toBe("queued_busy_gated");
  expect(record.completedAt).toBeNull();
});

it("does not ACK when the daemon cannot accept custody", async () => {
  const harness = createDeliveryRuntimeHarness({ supervisorState: { state: "failed", busy: false } });
  const record = await harness.runtime.accept(createRuntimeDeliveryInput({ idempotencyKey: "reject-custody" }));

  expect(record.state).toBe("failed");
  expect(record.acceptedAt).toBeNull();
  expect(record.runtimeOutcome).toBe("rejected_no_process");
});
```

Use the existing harness/helper names in `delivery-runtime.test.ts`. The expected behavior must stay the same if helper names differ.

- [ ] **Step 2: Add failing bridge wire ACK tests**

Add this test to `apps/omni/src/bridge-runtime.test.ts`:

```ts
it("sends agent:deliver:ack only when daemon accepted custody", async () => {
  const harness = createBridgeRuntimeHarness();
  harness.deliveryRuntime.acceptResults.push(
    createRuntimeDeliveryRecord({
      id: "delivery-accepted",
      state: "queued_gated",
      acceptedAt: "2026-05-23T00:00:00.000Z",
      deliverySeq: 7,
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    }),
    createRuntimeDeliveryRecord({
      id: "delivery-rejected",
      state: "failed",
      acceptedAt: null,
      deliverySeq: 8,
      traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
    }),
  );

  await harness.bridge.handleAgentDeliver({ agentId: "agent-1", seq: 7, deliveryId: "delivery-accepted" });
  await harness.bridge.handleAgentDeliver({ agentId: "agent-1", seq: 8, deliveryId: "delivery-rejected" });

  expect(harness.connection.sent).toContainEqual({
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 7,
    deliveryId: "delivery-accepted",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  });
  expect(harness.connection.sent).not.toContainEqual(expect.objectContaining({ deliveryId: "delivery-rejected", type: "agent:deliver:ack" }));
  expect(harness.connection.sent).not.toContainEqual(expect.objectContaining({ type: "agent:deliver:completed" }));
});
```

Adapt to the existing `bridge-runtime.test.ts` harness names. If Omni handler is private, drive the same path through the existing test-facing subscription helper.

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- delivery-runtime.test.ts bridge-runtime.test.ts
```

Expected: FAIL because delivery runtime currently marks accepted after stdin delivery and bridge ACK behavior is not custody-driven.

- [ ] **Step 4: Refactor `DeliveryRuntime.accept`**

In `apps/omni/src/runtime/delivery-runtime.ts`, replace the post-delivery accepted transition with custody-first flow:

```ts
async accept(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
  const delivery = await this.ledger.createOrReuseDelivery(input);
  if (delivery.state === "deduped") return delivery;

  const received = await this.ledger.transition(delivery.id, "received", {
    eventName: "delivery.received",
    attributes: { agentId: delivery.agentId, target: delivery.target },
  });

  const supervisorState = this.supervisor.getState(received.agentId);
  if (supervisorState.state === "failed" || supervisorState.state === "stale") {
    return this.ledger.transition(received.id, "failed", {
      eventName: "delivery.rejected_no_process",
      runtimeOutcome: "rejected_no_process",
      attributes: { agentState: supervisorState.state },
    });
  }

  const accepted = await this.ledger.transition(received.id, "accepted", {
    eventName: "delivery.ack.accepted",
    traceparent: received.traceparent,
    attributes: { agentId: received.agentId, target: received.target },
  });

  if (shouldQueueForStart(supervisorState.state)) {
    this.startCoordinator.enqueue({
      workspaceId: accepted.workspaceId,
      agentId: accepted.agentId,
      machineId: this.machineId,
      reason: "delivery",
    });
    return this.ledger.transition(accepted.id, "queued_starting", {
      eventName: "delivery.queued_starting",
      runtimeOutcome: "queued_during_start",
      attributes: { agentState: supervisorState.state },
    });
  }

  if (supervisorState.busy || shouldQueueForGate(supervisorState.state)) {
    this.supervisor.markGated(accepted.agentId);
    this.supervisor.bufferGatedDelivery(accepted.agentId, accepted.id);
    return this.ledger.transition(accepted.id, "queued_gated", {
      eventName: "delivery.queued_gated",
      runtimeOutcome: "queued_busy_gated",
      attributes: { agentState: supervisorState.state, queueDepth: this.supervisor.getState(accepted.agentId).queueDepth },
    });
  }

  return this.deliverNow(accepted);
}
```

Then update `deliverNow` so it no longer transitions to `accepted` after `delivered`:

```ts
private async deliverNow(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
  const delivering = await this.ledger.transition(delivery.id, "delivering", {
    eventName: "delivery.delivering",
    attributes: { agentId: delivery.agentId, target: delivery.target },
  });

  await this.agentManager.deliverRuntimeDelivery(delivering);

  return this.ledger.transition(delivering.id, "delivered", {
    eventName: "delivery.delivered",
    runtimeOutcome: "stdin_idle_delivery",
    attributes: { agentId: delivering.agentId, target: delivering.target },
  });
}
```

Use the existing agent manager delivery method name if it differs; preserve trace events already present in the file.

- [ ] **Step 5: Update bridge ACK emission**

In `apps/omni/src/bridge.ts`, send ACK only if `acceptedAt` is present:

```ts
const acceptedRecord = await this.deliveryRuntime.accept(deliveryInput);
if (!acceptedRecord.acceptedAt) {
  span.end("ok", { attrs: { outcome: "not-accepted", deliveryId: acceptedRecord.id } });
  return;
}

this.connection.send({
  type: "agent:deliver:ack",
  agentId: acceptedRecord.agentId,
  seq: acceptedRecord.deliverySeq,
  traceparent: acceptedRecord.ackTraceparent ?? acceptedRecord.traceparent,
  deliveryId: acceptedRecord.id,
});
```

Remove any ordinary `agent:deliver:completed` send path if one exists.

- [ ] **Step 6: Run focused ACK tests**

Run:

```bash
pnpm --filter @biang/omni test -- delivery-runtime.test.ts bridge-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/omni/src/runtime/delivery-runtime.ts apps/omni/src/runtime/delivery-runtime.test.ts apps/omni/src/bridge.ts apps/omni/src/bridge-runtime.test.ts
git commit -m "fix: ACK daemon custody before runtime delivery

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Store gated runtime state in the supervisor

**Files:**
- Modify: `apps/omni/src/runtime/agent-supervisor.ts`
- Modify: `apps/omni/src/runtime/agent-supervisor.test.ts`
- Test: `apps/omni/src/runtime/agent-supervisor.test.ts`

- [ ] **Step 1: Add failing supervisor snapshot tests**

Add these tests to `apps/omni/src/runtime/agent-supervisor.test.ts`:

```ts
it("initializes Claude gated steering and inbox state for an agent", () => {
  const supervisor = new AgentSupervisor();
  supervisor.ensureAgent("agent-1", { runtime: "claude" });

  const snapshot = supervisor.getState("agent-1");

  expect(snapshot.runtimeProfile.runtime).toBe("claude");
  expect(snapshot.runtimeProfile.busyDeliveryMode).toBe("gated");
  expect(snapshot.gatedSteering.phase).toBe("idle");
  expect(snapshot.queueDepth).toBe(0);
  expect(snapshot.pendingNotificationCount).toBe(0);
});

it("buffers gated deliveries in daemon-owned inbox", () => {
  const supervisor = new AgentSupervisor();
  supervisor.ensureAgent("agent-1", { runtime: "claude" });
  supervisor.bufferGatedDelivery("agent-1", "delivery-1");
  supervisor.bufferGatedDelivery("agent-1", "delivery-2");

  const snapshot = supervisor.getState("agent-1");

  expect(snapshot.queueDepth).toBe(2);
  expect(snapshot.inboxDeliveryIds).toEqual(["delivery-1", "delivery-2"]);
});

it("records pending stdin notification count separately from full delivery queue", () => {
  const supervisor = new AgentSupervisor();
  supervisor.ensureAgent("agent-1", { runtime: "claude" });
  supervisor.markPendingNotification("agent-1", 3);

  expect(supervisor.getState("agent-1").pendingNotificationCount).toBe(3);
});
```

- [ ] **Step 2: Run supervisor tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- agent-supervisor.test.ts
```

Expected: FAIL because supervisor snapshots do not include runtime profiles, gated state, inbox delivery ids, or pending notification count.

- [ ] **Step 3: Update supervisor entry and snapshot types**

In `apps/omni/src/runtime/agent-supervisor.ts`, add imports:

```ts
import { createGatedSteeringState } from "./gated-steering";
import { getRuntimeDriverProfile } from "./runtime-profiles";
import type { GatedSteeringState, RuntimeDriverProfile, RuntimeKind } from "./types";
```

Update the internal entry shape:

```ts
interface SupervisorAgentEntry {
  state: SupervisorAgentState;
  sessionId: string | null;
  processId: number | null;
  runtimeProfile: RuntimeDriverProfile;
  gatedSteering: GatedSteeringState;
  inboxDeliveryIds: string[];
  pendingNotificationCount: number;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  runtimeProgressStaleSince: string | null;
  lastRuntimeEventAt: string | null;
  expectedTerminationReason: string | null;
}
```

Update the public snapshot shape:

```ts
export interface SupervisorStateSnapshot {
  state: SupervisorAgentState;
  busy: boolean;
  queueDepth: number;
  sessionId: string | null;
  processId: number | null;
  runtimeProfile: RuntimeDriverProfile;
  gatedSteering: GatedSteeringState;
  inboxDeliveryIds: string[];
  pendingNotificationCount: number;
  runtimeProgressStaleSince: string | null;
  lastRuntimeEventAt: string | null;
  expectedTerminationReason: string | null;
}
```

- [ ] **Step 4: Add supervisor methods**

Add these methods to `AgentSupervisor`:

```ts
ensureAgent(agentId: string, options: { runtime?: RuntimeKind } = {}): void {
  if (this.agents.has(agentId)) return;
  this.agents.set(agentId, {
    state: "stopped",
    sessionId: null,
    processId: null,
    runtimeProfile: getRuntimeDriverProfile(options.runtime ?? "claude"),
    gatedSteering: createGatedSteeringState(),
    inboxDeliveryIds: [],
    pendingNotificationCount: 0,
    notificationTimer: null,
    runtimeProgressStaleSince: null,
    lastRuntimeEventAt: null,
    expectedTerminationReason: null,
  });
}

bufferGatedDelivery(agentId: string, deliveryId: string): void {
  const entry = this.getOrCreate(agentId);
  if (!entry.inboxDeliveryIds.includes(deliveryId)) {
    entry.inboxDeliveryIds.push(deliveryId);
  }
}

drainInbox(agentId: string, limit = Number.POSITIVE_INFINITY): string[] {
  const entry = this.getOrCreate(agentId);
  const drained = entry.inboxDeliveryIds.splice(0, limit);
  entry.pendingNotificationCount = Math.max(0, entry.pendingNotificationCount - drained.length);
  return drained;
}

markPendingNotification(agentId: string, count: number): void {
  const entry = this.getOrCreate(agentId);
  entry.pendingNotificationCount = count;
}
```

Update existing methods that used `gatedDeliveryIds` to use `inboxDeliveryIds`.

- [ ] **Step 5: Return full snapshots safely**

Update `getState` to clone arrays and state objects:

```ts
return {
  state: entry.state,
  busy: entry.state === "busy" || entry.state === "gated",
  queueDepth: entry.inboxDeliveryIds.length,
  sessionId: entry.sessionId,
  processId: entry.processId,
  runtimeProfile: entry.runtimeProfile,
  gatedSteering: { ...entry.gatedSteering, recentEvents: [...entry.gatedSteering.recentEvents], inFlightBatch: entry.gatedSteering.inFlightBatch ? [...entry.gatedSteering.inFlightBatch] : null },
  inboxDeliveryIds: [...entry.inboxDeliveryIds],
  pendingNotificationCount: entry.pendingNotificationCount,
  runtimeProgressStaleSince: entry.runtimeProgressStaleSince,
  lastRuntimeEventAt: entry.lastRuntimeEventAt,
  expectedTerminationReason: entry.expectedTerminationReason,
};
```

- [ ] **Step 6: Run supervisor tests**

Run:

```bash
pnpm --filter @biang/omni test -- agent-supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/omni/src/runtime/agent-supervisor.ts apps/omni/src/runtime/agent-supervisor.test.ts
git commit -m "feat: track daemon inbox and gated supervisor state

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Map Claude stream events into gated boundaries

**Files:**
- Create: `apps/omni/src/runtime/claude-stream-events.ts`
- Create: `apps/omni/src/runtime/claude-stream-events.test.ts`
- Modify: `apps/omni/src/agent-manager.ts`
- Modify: `apps/omni/src/agent-manager-runtime-session.test.ts`
- Test: `apps/omni/src/runtime/claude-stream-events.test.ts`, `apps/omni/src/agent-manager-runtime-session.test.ts`

- [ ] **Step 1: Write failing stream event mapper tests**

Create `apps/omni/src/runtime/claude-stream-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapClaudeStreamJsonToGatedEvent } from "./claude-stream-events";

describe("Claude stream event mapping", () => {
  it("maps assistant text and thinking to continuation", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })).toEqual({ type: "assistant_text" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "work" }] } })).toEqual({ type: "assistant_thinking" });
  });

  it("maps tool use and tool result boundaries", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } })).toEqual({ type: "tool_call", toolUseId: "tool-1" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } })).toEqual({ type: "tool_result", toolUseId: "tool-1" });
  });

  it("maps compaction, turn end, and runtime error", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "system", subtype: "compacting" })).toEqual({ type: "compaction_started" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "result", subtype: "success" })).toEqual({ type: "turn_end" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message: "thinking cannot be modified after redacted_thinking" } })).toEqual({
      type: "runtime_error",
      message: "thinking cannot be modified after redacted_thinking",
    });
  });

  it("ignores unrelated stream events", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "system", subtype: "init" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run stream event tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- claude-stream-events.test.ts
```

Expected: FAIL with an import error because `claude-stream-events.ts` does not exist.

- [ ] **Step 3: Implement stream event mapping**

Create `apps/omni/src/runtime/claude-stream-events.ts`:

```ts
import type { ClaudeGatedSteeringEvent } from "./types";

function getContentArray(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : null;
}

export function mapClaudeStreamJsonToGatedEvent(value: unknown): ClaudeGatedSteeringEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = getStringProperty(record, "type");
  const subtype = getStringProperty(record, "subtype");

  if (type === "system" && subtype === "compacting") return { type: "compaction_started" };
  if (type === "system" && subtype === "compacted") return { type: "compaction_finished" };
  if (type === "result") return { type: "turn_end" };

  if (type === "error") {
    const error = record.error;
    const message = getStringProperty(error, "message") ?? getStringProperty(record, "message") ?? "runtime error";
    return { type: "runtime_error", message };
  }

  for (const item of getContentArray(record)) {
    const contentType = getStringProperty(item, "type");
    if (type === "assistant" && contentType === "thinking") return { type: "assistant_thinking" };
    if (type === "assistant" && contentType === "text") return { type: "assistant_text" };
    if (type === "assistant" && contentType === "tool_use") {
      return { type: "tool_call", toolUseId: getStringProperty(item, "id") ?? "unknown-tool" };
    }
    if (type === "user" && contentType === "tool_result") {
      return { type: "tool_result", toolUseId: getStringProperty(item, "tool_use_id") ?? "unknown-tool" };
    }
  }

  return null;
}
```

- [ ] **Step 4: Integrate mapper into `AgentManager`**

In `apps/omni/src/agent-manager.ts`, import the helpers:

```ts
import { decideGatedFlush, recordGatedSteeringEvent } from "./runtime/gated-steering";
import { mapClaudeStreamJsonToGatedEvent } from "./runtime/claude-stream-events";
```

In the stream-json handling path, after parsing each JSON event and before existing activity broadcast branching, add:

```ts
const gatedEvent = mapClaudeStreamJsonToGatedEvent(event);
if (gatedEvent) {
  this.agentSupervisor.recordGatedEvent(agentId, gatedEvent);
  const snapshot = this.agentSupervisor.getState(agentId);
  const flushReason = gatedEvent.type === "turn_end" ? "turn_end" : gatedEvent.type === "tool_result" ? "tool_boundary" : null;
  if (flushReason) {
    const decision = decideGatedFlush(snapshot.gatedSteering, flushReason);
    if (decision.action === "notify") {
      await this.sendStdinNotification(agentId, snapshot.pendingNotificationCount || snapshot.queueDepth);
    }
    if (decision.action === "deliver_full") {
      await this.flushDaemonInbox(agentId, flushReason);
    }
  }
}
```

Add `recordGatedEvent` to `AgentSupervisor` if Task 6 did not already add it:

```ts
recordGatedEvent(agentId: string, event: ClaudeGatedSteeringEvent): void {
  const entry = this.getOrCreate(agentId);
  entry.gatedSteering = recordGatedSteeringEvent(entry.gatedSteering, event);
  entry.lastRuntimeEventAt = new Date().toISOString();
}
```

- [ ] **Step 5: Add AgentManager integration test for notification vs full delivery**

Add this test to `apps/omni/src/agent-manager-runtime-session.test.ts`:

```ts
it("sends pending notification at tool boundary and full queued delivery at turn end", async () => {
  const harness = createAgentManagerRuntimeHarness();
  await harness.startAgent("agent-1");
  harness.manager.bufferGatedDelivery("agent-1", "delivery-1");
  harness.manager.bufferGatedDelivery("agent-1", "delivery-2");

  await harness.emitClaudeEvent("agent-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } });
  await harness.emitClaudeEvent("agent-1", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } });

  expect(harness.stdinWrites).toContainEqual(expect.stringContaining("2 pending messages"));
  expect(harness.fullDeliveryWrites).toHaveLength(0);

  await harness.emitClaudeEvent("agent-1", { type: "result", subtype: "success" });

  expect(harness.fullDeliveryWrites.map((write) => write.deliveryId)).toEqual(["delivery-1", "delivery-2"]);
});
```

Use the existing harness helpers if present; otherwise add minimal fake child-process/stdin helpers inside the test file.

- [ ] **Step 6: Run stream and integration tests**

Run:

```bash
pnpm --filter @biang/omni test -- claude-stream-events.test.ts agent-manager-runtime-session.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/omni/src/runtime/claude-stream-events.ts apps/omni/src/runtime/claude-stream-events.test.ts apps/omni/src/runtime/agent-supervisor.ts apps/omni/src/agent-manager.ts apps/omni/src/agent-manager-runtime-session.test.ts
git commit -m "feat: steer queued deliveries at Claude safe boundaries

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Materialize Slock-equivalent local runtime layout and secrets

**Files:**
- Modify: `apps/omni/src/runtime/cli-transport.ts`
- Modify: `apps/omni/src/runtime/cli-transport.test.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.test.ts`
- Modify: `apps/omni/src/agent-manager.ts`
- Test: `apps/omni/src/runtime/cli-transport.test.ts`, `apps/omni/src/runtime/prompt-materializer.test.ts`

- [ ] **Step 1: Add failing CLI transport materialization tests**

Add these tests to `apps/omni/src/runtime/cli-transport.test.ts`:

```ts
it("writes the wrapper at .zano/zano and references token files without inlining token contents", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "zano-cli-transport-"));
  const materializer = new CliTransportMaterializer({ rootDir, nodePath: process.execPath });

  const result = materializer.materialize({
    agentId: "agent-1",
    cliEntrypoint: "/repo/packages/cli/src/index.ts",
    mode: "tsx",
    launchId: "launch-1",
    serverUrl: "http://localhost:3000",
    agentToken: "secret-agent-token",
  });

  expect(result.wrapperPath).toBe(join(rootDir, "agents", "agent-1", ".zano", "zano"));
  expect(result.tokenFilePath).toBe(join(rootDir, "agents", "agent-1", ".zano", "agent-token"));
  expect(readFileSync(result.tokenFilePath, "utf8")).toBe("secret-agent-token");
  expect(result.body).toContain("ZANO_AGENT_TOKEN_FILE");
  expect(result.body).toContain("ZANO_AGENT_LOCAL_STATE");
  expect(result.body).not.toContain("secret-agent-token");
});

it("supports proxy token mode without writing direct agent-token", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "zano-cli-proxy-"));
  const materializer = new CliTransportMaterializer({ rootDir, nodePath: process.execPath });

  const result = materializer.materialize({
    agentId: "agent-1",
    cliEntrypoint: "/repo/packages/cli/src/index.ts",
    mode: "node",
    launchId: "launch-2",
    serverUrl: "http://localhost:3000",
    credentialProxy: {
      proxyUrl: "http://127.0.0.1:48123",
      proxyToken: "secret-proxy-token",
      activeCapabilities: ["message:send", "task:update"],
    },
  });

  expect(result.tokenFilePath).toBeNull();
  expect(result.proxyTokenFilePath).toContain(join("agent-proxy-tokens", "agent-1", "launch-2.token"));
  expect(readFileSync(result.proxyTokenFilePath!, "utf8")).toBe("secret-proxy-token");
  expect(result.body).toContain("ZANO_AGENT_PROXY_TOKEN_FILE");
  expect(result.body).not.toContain("secret-proxy-token");
});
```

- [ ] **Step 2: Add failing prompt materialization tests**

Add this test to `apps/omni/src/runtime/prompt-materializer.test.ts`:

```ts
it("writes claude-system-prompt.md and reserved MCP config without secrets", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "zano-prompt-"));
  const materializer = new PromptMaterializer({ rootDir });
  const result = materializer.materialize({
    agentId: "agent-1",
    workspaceId: "workspace-1",
    workspaceName: "Test Workspace",
    machineId: "machine-1",
    hostname: "test-host",
    platform: "darwin",
    workDir: join(rootDir, "agents", "agent-1"),
    omniVersion: "0.1.5",
    model: "claude-opus-4-7",
    runtimeProfile: "claude",
    runtimeControlMcpServerUrl: "http://127.0.0.1:48124/mcp",
  });

  expect(result.promptPath).toBe(join(rootDir, "agents", "agent-1", ".zano", "claude-system-prompt.md"));
  expect(result.mcpConfigPath).toBe(join(rootDir, "agents", "agent-1", ".zano", "claude-mcp-config.json"));
  const prompt = readFileSync(result.promptPath, "utf8");
  const config = readFileSync(result.mcpConfigPath, "utf8");
  expect(prompt).toContain("Communication — zano CLI ONLY");
  expect(prompt).toContain("runtime_profile_migration_done");
  expect(config).toContain("runtime_profile_migration_done");
  expect(prompt).not.toContain("secret");
  expect(config).not.toContain("secret-agent-token");
});
```

- [ ] **Step 3: Run materialization tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- cli-transport.test.ts prompt-materializer.test.ts
```

Expected: FAIL because wrapper path, token-file fields, and prompt/MCP config output do not match strict parity yet.

- [ ] **Step 4: Update CLI transport input/output types**

In `apps/omni/src/runtime/cli-transport.ts`, update interfaces:

```ts
export interface CliTransportInput {
  agentId: string;
  cliEntrypoint: string;
  mode: "node" | "tsx";
  launchId: string;
  serverUrl: string;
  agentToken?: string;
  credentialProxy?: {
    proxyUrl: string;
    proxyToken: string;
    activeCapabilities: string[];
  };
}

export interface CliTransportResult {
  wrapperPath: string;
  wrapperHash: string;
  body: string;
  tokenFilePath: string | null;
  proxyTokenFilePath: string | null;
  pathDir: string;
}
```

- [ ] **Step 5: Implement token/proxy-token materialization**

In `apps/omni/src/runtime/cli-transport.ts`, use `.zano/zano` as wrapper path and write token files outside wrapper text:

```ts
const agentBaseDir = this.options.agentsDir ?? join(this.options.rootDir, "agents");
const agentDir = join(agentBaseDir, input.agentId);
const zanoDir = join(agentDir, ".zano");
mkdirSync(zanoDir, { recursive: true });
const wrapperPath = join(zanoDir, "zano");
const localStatePath = join(zanoDir, "state.json");
const tokenFilePath = input.agentToken ? join(zanoDir, "agent-token") : null;
const proxyTokenFilePath = input.credentialProxy
  ? join(this.options.rootDir, "agent-proxy-tokens", input.agentId, `${input.launchId}.token`)
  : null;

if (tokenFilePath) {
  atomicWriteSecret(tokenFilePath, input.agentToken!);
}
if (proxyTokenFilePath && input.credentialProxy) {
  mkdirSync(join(this.options.rootDir, "agent-proxy-tokens", input.agentId), { recursive: true, mode: 0o700 });
  atomicWriteSecret(proxyTokenFilePath, input.credentialProxy.proxyToken);
}
```

Add this helper near `atomicWriteExecutable`:

```ts
function atomicWriteSecret(path: string, body: string): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, body, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
```

Build wrapper env references only:

```ts
const envLines = [
  `export ZANO_HOME=${shellQuote(this.options.rootDir)}`,
  `export ZANO_AGENT_ID=${shellQuote(input.agentId)}`,
  `export ZANO_AGENT_LAUNCH_ID=${shellQuote(input.launchId)}`,
  `export ZANO_SERVER_URL=${shellQuote(input.serverUrl)}`,
  `export ZANO_AGENT_LOCAL_STATE=${shellQuote(localStatePath)}`,
];
if (tokenFilePath) envLines.push(`export ZANO_AGENT_TOKEN_FILE=${shellQuote(tokenFilePath)}`);
if (input.credentialProxy && proxyTokenFilePath) {
  envLines.push(`export ZANO_AGENT_PROXY_URL=${shellQuote(input.credentialProxy.proxyUrl)}`);
  envLines.push(`export ZANO_AGENT_PROXY_TOKEN_FILE=${shellQuote(proxyTokenFilePath)}`);
  envLines.push(`export ZANO_AGENT_ACTIVE_CAPABILITIES=${shellQuote(input.credentialProxy.activeCapabilities.join(","))}`);
}
const body = ["#!/usr/bin/env bash", ...envLines, command, ""].join("\n");
```

- [ ] **Step 6: Update prompt materializer outputs**

In `apps/omni/src/runtime/prompt-materializer.ts`, write the prompt and MCP config under `.zano`:

```ts
const zanoDir = join(input.workDir, ".zano");
mkdirSync(zanoDir, { recursive: true });
const promptPath = join(zanoDir, "claude-system-prompt.md");
const mcpConfigPath = join(zanoDir, "claude-mcp-config.json");
```

Write MCP config with only the reserved runtime-control action:

```ts
const mcpConfig = {
  mcpServers: {
    "zano-runtime-control": {
      url: input.runtimeControlMcpServerUrl,
      capabilities: ["runtime_profile_migration_done"],
    },
  },
};
writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });
```

Update `PromptMaterializerResult` to include:

```ts
promptPath: string;
mcpConfigPath: string;
promptHash: string;
```

- [ ] **Step 7: Update AgentManager spawn env**

In `apps/omni/src/agent-manager.ts`, pass `launchId`, `serverUrl`, and `agentToken` or `credentialProxy` to `CliTransportMaterializer.materialize(...)`. Update the child process `env` so raw token env vars are not forwarded:

```ts
const spawnEnv = { ...process.env };
delete spawnEnv.ZANO_API_KEY;
delete spawnEnv.ZANO_AUTH_TOKEN;
delete spawnEnv.ZANO_AGENT_AUTH_TOKEN;
delete spawnEnv.SUPABASE_SERVICE_ROLE_KEY;
delete spawnEnv.SUPABASE_JWT_SECRET;

const childEnv = {
  ...spawnEnv,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  ZANO_HOME: this.zanoHome,
  ZANO_AGENT_ID: agentId,
  ZANO_AGENT_LAUNCH_ID: launchId,
  ZANO_AGENT_TOKEN_FILE: cliTransport.tokenFilePath ?? undefined,
  ZANO_AGENT_PROXY_URL: credentialProxy?.proxyUrl,
  ZANO_AGENT_PROXY_TOKEN_FILE: cliTransport.proxyTokenFilePath ?? undefined,
  ZANO_AGENT_ACTIVE_CAPABILITIES: credentialProxy?.activeCapabilities.join(","),
  PATH: `${cliTransport.pathDir}:${process.env.PATH ?? ""}`,
};
```

Do not include raw token values in `childEnv`.

- [ ] **Step 8: Run materialization tests**

Run:

```bash
pnpm --filter @biang/omni test -- cli-transport.test.ts prompt-materializer.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/omni/src/runtime/cli-transport.ts apps/omni/src/runtime/cli-transport.test.ts apps/omni/src/runtime/prompt-materializer.ts apps/omni/src/runtime/prompt-materializer.test.ts apps/omni/src/agent-manager.ts
git commit -m "feat: materialize Slock-like runtime files safely

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Report runtime session references separately from local files

**Files:**
- Create: `apps/omni/src/runtime/runtime-session-ref.ts`
- Create: `apps/omni/src/runtime/runtime-session-ref.test.ts`
- Modify: `apps/omni/src/runtime/session-ledger.ts`
- Modify: `apps/omni/src/runtime/session-ledger.test.ts`
- Modify: `apps/omni/src/agent-manager.ts`
- Test: `apps/omni/src/runtime/runtime-session-ref.test.ts`, `apps/omni/src/runtime/session-ledger.test.ts`

- [ ] **Step 1: Write failing session reference resolver tests**

Create `apps/omni/src/runtime/runtime-session-ref.test.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRuntimeSessionRef } from "./runtime-session-ref";

describe("runtime session refs", () => {
  it("prefers native Claude session jsonl when reachable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "zano-claude-home-"));
    const projectDir = join(homeDir, ".claude", "projects", "repo");
    mkdirSync(projectDir, { recursive: true });
    const nativePath = join(projectDir, "session-123.jsonl");
    writeFileSync(nativePath, "{}\n", "utf8");

    const ref = resolveRuntimeSessionRef({ runtime: "claude", sessionId: "session-123", homeDir, fallbackDir: join(homeDir, "fallback"), launchId: "launch-1" });

    expect(ref).toEqual({ path: nativePath, reachable: true, source: "native" });
  });

  it("writes fallback handoff when native session is not reachable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "zano-no-native-"));
    const fallbackDir = join(homeDir, ".zano", "runtime-sessions");

    const ref = resolveRuntimeSessionRef({ runtime: "claude", sessionId: "session-404", homeDir, fallbackDir, launchId: "launch-2" });

    expect(ref.path).toBe(join(fallbackDir, "claude-launch-launch-2.jsonl"));
    expect(ref.reachable).toBe(false);
    expect(ref.source).toBe("fallback");
    expect(readFileSync(ref.path, "utf8")).toContain("session-404");
  });
});
```

- [ ] **Step 2: Run resolver tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-session-ref.test.ts
```

Expected: FAIL with an import error because `runtime-session-ref.ts` does not exist.

- [ ] **Step 3: Implement session reference resolver**

Create `apps/omni/src/runtime/runtime-session-ref.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeKind } from "./types";

export interface RuntimeSessionRefInput {
  runtime: RuntimeKind;
  sessionId: string;
  homeDir: string;
  fallbackDir: string;
  launchId: string;
}

export interface RuntimeSessionRef {
  path: string;
  reachable: boolean;
  source: "native" | "fallback";
}

function findSessionJsonl(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionJsonl(path, sessionId);
      if (found) return found;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
      return path;
    }
  }
  return null;
}

export function resolveRuntimeSessionRef(input: RuntimeSessionRefInput): RuntimeSessionRef {
  const nativeRoot = input.runtime === "claude"
    ? join(input.homeDir, ".claude", "projects")
    : input.runtime === "codex"
      ? join(input.homeDir, ".codex", "sessions")
      : null;

  if (nativeRoot) {
    const nativePath = findSessionJsonl(nativeRoot, input.sessionId);
    if (nativePath) return { path: nativePath, reachable: true, source: "native" };
  }

  mkdirSync(input.fallbackDir, { recursive: true });
  const fallbackPath = join(input.fallbackDir, `${input.runtime}-launch-${input.launchId}.jsonl`);
  writeFileSync(fallbackPath, `${JSON.stringify({ runtime: input.runtime, sessionId: input.sessionId, launchId: input.launchId })}\n`, { flag: "a", mode: 0o600 });
  return { path: fallbackPath, reachable: false, source: "fallback" };
}
```

- [ ] **Step 4: Add session ledger fields**

In `apps/omni/src/runtime/session-ledger.ts`, add fields to `RuntimeSessionRecord` and insertion input:

```ts
launchId: string;
sessionRef: string | null;
sessionRefReachable: boolean;
workspacePathRef: string | null;
runtimeProfile: string | null;
```

Update insert defaults and Supabase/in-memory mapping to preserve these fields.

- [ ] **Step 5: Add session ledger tests**

Add this test to `apps/omni/src/runtime/session-ledger.test.ts`:

```ts
it("records runtime session refs separately from fallback files", async () => {
  const ledger = createSessionLedgerHarness().ledger;
  const record = await ledger.startSession({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    machineId: "machine-1",
    runtimeModel: "claude-opus-4-7",
    sessionId: "session-1",
    processId: 123,
    promptHash: "prompt-hash",
    wrapperHash: "wrapper-hash",
    launchId: "launch-1",
    sessionRef: "/Users/test/.claude/projects/repo/session-1.jsonl",
    sessionRefReachable: true,
    workspacePathRef: "/Users/test/.zano/agents/agent-1",
    runtimeProfile: "claude",
  });

  expect(record.launchId).toBe("launch-1");
  expect(record.sessionRef).toBe("/Users/test/.claude/projects/repo/session-1.jsonl");
  expect(record.sessionRefReachable).toBe(true);
  expect(record.workspacePathRef).toBe("/Users/test/.zano/agents/agent-1");
  expect(record.runtimeProfile).toBe("claude");
});
```

- [ ] **Step 6: Update AgentManager session reporting**

In `apps/omni/src/agent-manager.ts`, after Claude reports `session_id`, resolve and record the session ref:

```ts
const sessionRef = resolveRuntimeSessionRef({
  runtime: "claude",
  sessionId,
  homeDir: homedir(),
  fallbackDir: join(agentProc.workDir, ".zano", "runtime-sessions"),
  launchId: agentProc.launchId,
});

await this.sessionLedger.startSession({
  workspaceId,
  agentId,
  machineId: this.machineId,
  runtimeModel: this.model,
  sessionId,
  processId: agentProc.proc.pid ?? null,
  promptHash: agentProc.promptHash,
  wrapperHash: agentProc.wrapperHash,
  launchId: agentProc.launchId,
  sessionRef: sessionRef.path,
  sessionRefReachable: sessionRef.reachable,
  workspacePathRef: agentProc.workDir,
  runtimeProfile: "claude",
});
```

Use existing variable names from the current file.

- [ ] **Step 7: Run session tests**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-session-ref.test.ts session-ledger.test.ts agent-manager-runtime-session.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/omni/src/runtime/runtime-session-ref.ts apps/omni/src/runtime/runtime-session-ref.test.ts apps/omni/src/runtime/session-ledger.ts apps/omni/src/runtime/session-ledger.test.ts apps/omni/src/agent-manager.ts apps/omni/src/agent-manager-runtime-session.test.ts
git commit -m "feat: report runtime session references

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Add reserved runtime-profile controls

**Files:**
- Create: `apps/omni/src/runtime/runtime-profile-controls.ts`
- Create: `apps/omni/src/runtime/runtime-profile-controls.test.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.ts`
- Modify: `apps/omni/src/agent-manager.ts`
- Modify: `apps/omni/src/bridge.ts`
- Test: `apps/omni/src/runtime/runtime-profile-controls.test.ts`, `apps/omni/src/agent-manager-runtime-session.test.ts`, `apps/omni/src/bridge-runtime.test.ts`

- [ ] **Step 1: Write failing runtime-profile control tests**

Create `apps/omni/src/runtime/runtime-profile-controls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createRuntimeProfileControl,
  isRuntimeProfileControlAck,
  observeRuntimeProfileMigrationDone,
} from "./runtime-profile-controls";

describe("runtime profile controls", () => {
  it("creates migration controls with exact migration key", () => {
    expect(createRuntimeProfileControl({ agentId: "agent-1", kind: "migration", key: "migration-2026-05-23" })).toEqual({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      key: "migration-2026-05-23",
      requiresAck: true,
    });
  });

  it("requires the reserved MCP action for migration ACK", () => {
    const pending = createRuntimeProfileControl({ agentId: "agent-1", kind: "migration", key: "migration-2026-05-23" });

    expect(observeRuntimeProfileMigrationDone(pending, { toolName: "runtime_profile_migration_done", arguments: { key: "migration-2026-05-23" } })).toEqual({
      type: "agent:runtime_profile:migration:ack",
      agentId: "agent-1",
      key: "migration-2026-05-23",
    });
    expect(observeRuntimeProfileMigrationDone(pending, { toolName: "zano message send", arguments: { key: "migration-2026-05-23" } })).toBeNull();
  });

  it("recognizes release-notice ACK separately", () => {
    expect(isRuntimeProfileControlAck({ type: "agent:runtime_profile:daemon_release_notice:ack", agentId: "agent-1", key: "release-1" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run control tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-profile-controls.test.ts
```

Expected: FAIL with an import error because `runtime-profile-controls.ts` does not exist.

- [ ] **Step 3: Implement runtime-profile controls**

Create `apps/omni/src/runtime/runtime-profile-controls.ts`:

```ts
export type RuntimeProfileControlKind = "migration" | "daemon_release_notice";

export interface RuntimeProfileControl {
  type: "agent:runtime_profile:migration" | "agent:runtime_profile:daemon_release_notice";
  agentId: string;
  key: string;
  requiresAck: boolean;
}

export interface RuntimeProfileControlAck {
  type: "agent:runtime_profile:migration:ack" | "agent:runtime_profile:daemon_release_notice:ack";
  agentId: string;
  key: string;
}

export function createRuntimeProfileControl(input: { agentId: string; kind: RuntimeProfileControlKind; key: string }): RuntimeProfileControl {
  return {
    type: input.kind === "migration" ? "agent:runtime_profile:migration" : "agent:runtime_profile:daemon_release_notice",
    agentId: input.agentId,
    key: input.key,
    requiresAck: input.kind === "migration",
  };
}

export function observeRuntimeProfileMigrationDone(
  control: RuntimeProfileControl,
  toolCall: { toolName: string; arguments: Record<string, unknown> },
): RuntimeProfileControlAck | null {
  if (control.type !== "agent:runtime_profile:migration") return null;
  if (toolCall.toolName !== "runtime_profile_migration_done") return null;
  if (toolCall.arguments.key !== control.key) return null;
  return { type: "agent:runtime_profile:migration:ack", agentId: control.agentId, key: control.key };
}

export function isRuntimeProfileControlAck(value: unknown): value is RuntimeProfileControlAck {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "agent:runtime_profile:migration:ack" || type === "agent:runtime_profile:daemon_release_notice:ack";
}
```

- [ ] **Step 4: Add prompt and MCP config instructions**

In `apps/omni/src/runtime/prompt-materializer.ts` and `apps/omni/src/system-prompt.ts`, include this exact runtime-control rule block in the materialized prompt:

```text
## Runtime Profile Controls

If the daemon delivers a runtime-profile migration notice, stop ordinary inbox handling long enough to re-ground in the new runtime context.
Call the reserved MCP action `runtime_profile_migration_done` with the exact migration key from the notice.
Do not acknowledge migration completion with `zano message send`, task updates, or a normal chat reply.
Daemon release notices are runtime notices; follow the notice text and only ACK through the reserved control path when the notice requires it.
```

Keep ordinary collaboration CLI-only; do not add chat/task MCP tools.

- [ ] **Step 5: Observe reserved MCP action in AgentManager**

In `apps/omni/src/agent-manager.ts`, when processing assistant `tool_use` stream events, detect the reserved runtime action and emit an ACK through Omni/control connection:

```ts
const ack = observeRuntimeProfileMigrationDone(agentProc.pendingRuntimeProfileControl, {
  toolName: toolUseName,
  arguments: toolUseArguments,
});
if (ack) {
  this.runtimeProfileControlAcks.push(ack);
  this.broadcastRuntimeProfileControlAck(ack);
  agentProc.pendingRuntimeProfileControl = null;
}
```

Add `pendingRuntimeProfileControl` to `AgentProcess` and set it when a migration control is delivered.

- [ ] **Step 6: Add integration tests for migration ACK**

Add this test to `apps/omni/src/agent-manager-runtime-session.test.ts`:

```ts
it("ACKs runtime-profile migration only after reserved MCP action", async () => {
  const harness = createAgentManagerRuntimeHarness();
  await harness.startAgent("agent-1");
  harness.manager.deliverRuntimeProfileControl({ type: "agent:runtime_profile:migration", agentId: "agent-1", key: "migration-1", requiresAck: true });

  await harness.emitClaudeEvent("agent-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "zano message send", input: { text: "done" } }] } });
  expect(harness.runtimeProfileAcks).toEqual([]);

  await harness.emitClaudeEvent("agent-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2", name: "runtime_profile_migration_done", input: { key: "migration-1" } }] } });
  expect(harness.runtimeProfileAcks).toEqual([{ type: "agent:runtime_profile:migration:ack", agentId: "agent-1", key: "migration-1" }]);
});
```

- [ ] **Step 7: Run control tests**

Run:

```bash
pnpm --filter @biang/omni test -- runtime-profile-controls.test.ts prompt-materializer.test.ts agent-manager-runtime-session.test.ts bridge-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/omni/src/runtime/runtime-profile-controls.ts apps/omni/src/runtime/runtime-profile-controls.test.ts apps/omni/src/runtime/prompt-materializer.ts apps/omni/src/runtime/prompt-materializer.test.ts apps/omni/src/system-prompt.ts apps/omni/src/agent-manager.ts apps/omni/src/agent-manager-runtime-session.test.ts apps/omni/src/bridge.ts apps/omni/src/bridge-runtime.test.ts
git commit -m "feat: add reserved runtime profile controls

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Add CLI freshness hold for visible side effects

**Files:**
- Modify: `packages/cli/package.json`
- Create: `packages/cli/src/local-state.ts`
- Create: `packages/cli/src/freshness.ts`
- Create: `packages/cli/src/freshness.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `apps/omni/src/system-prompt.ts`
- Test: `packages/cli/src/freshness.test.ts`, CLI build

- [ ] **Step 1: Add CLI test script**

In `packages/cli/package.json`, add:

```json
"test": "vitest run"
```

The `scripts` block should contain:

```json
"scripts": {
  "build": "tsc",
  "dev": "tsx src/index.ts",
  "test": "vitest run",
  "prepublishOnly": "npm run build"
}
```

- [ ] **Step 2: Write failing freshness tests**

Create `packages/cli/src/freshness.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFreshnessPreflight, saveHeldDraft } from "./freshness";

describe("freshness preflight", () => {
  it("holds message send when newer visible messages exist", () => {
    const result = evaluateFreshnessPreflight({
      action: "message_send",
      target: "#general",
      lastSeenMessageCreatedAt: "2026-05-23T10:00:00.000Z",
      newerMessages: [
        { id: "msg-2", sender: "@biang", createdAt: "2026-05-23T10:01:00.000Z", text: "new context" },
      ],
      anyway: false,
    });

    expect(result).toEqual({
      state: "held",
      outcome: "held",
      subtype: "freshness",
      target: "#general",
      heldMessages: [{ id: "msg-2", sender: "@biang", createdAt: "2026-05-23T10:01:00.000Z", text: "new context" }],
      availableActions: ["review", "send-draft", "send-anyway"],
    });
  });

  it("allows explicit anyway escape hatch", () => {
    const result = evaluateFreshnessPreflight({
      action: "task_update",
      target: "task-1",
      lastSeenMessageCreatedAt: "2026-05-23T10:00:00.000Z",
      newerMessages: [{ id: "msg-2", sender: "@human", createdAt: "2026-05-23T10:01:00.000Z", text: "please wait" }],
      anyway: true,
    });

    expect(result).toEqual({ state: "allowed", outcome: "explicit_anyway", target: "task-1" });
  });

  it("saves held message drafts without sending", () => {
    const dir = mkdtempSync(join(tmpdir(), "zano-drafts-"));
    const draft = saveHeldDraft({ stateDir: dir, target: "#general", text: "draft body", reason: "freshness" });

    expect(draft.path).toContain(".zano-drafts");
    expect(JSON.parse(readFileSync(draft.path, "utf8"))).toMatchObject({ target: "#general", text: "draft body", reason: "freshness" });
  });
});
```

- [ ] **Step 3: Run freshness tests to verify they fail**

Run:

```bash
pnpm --filter @fehey/zano-cli test -- freshness.test.ts
```

Expected: FAIL because `freshness.ts` and `local-state.ts` do not exist.

- [ ] **Step 4: Implement local state helpers**

Create `packages/cli/src/local-state.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AgentLocalState {
  currentDelivery?: {
    deliveryId: string;
    deliverySeq: number;
    traceparent: string;
    target?: string;
    messageCreatedAt?: string;
  };
  freshness?: Record<string, { lastSeenMessageCreatedAt: string }>;
}

export function readAgentLocalState(path: string | undefined): AgentLocalState {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentLocalState;
  } catch {
    return {};
  }
}

export function writeAgentLocalState(path: string, state: AgentLocalState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
```

- [ ] **Step 5: Implement freshness helpers**

Create `packages/cli/src/freshness.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type FreshnessAction = "message_send" | "task_claim" | "task_update";

export interface FreshnessMessage {
  id: string;
  sender: string;
  createdAt: string;
  text: string;
}

export type FreshnessPreflightResult =
  | { state: "allowed"; outcome: "fresh" | "explicit_anyway"; target: string }
  | {
      state: "held";
      outcome: "held";
      subtype: "freshness";
      target: string;
      heldMessages: FreshnessMessage[];
      availableActions: string[];
    };

export function evaluateFreshnessPreflight(input: {
  action: FreshnessAction;
  target: string;
  lastSeenMessageCreatedAt: string | null;
  newerMessages: FreshnessMessage[];
  anyway: boolean;
}): FreshnessPreflightResult {
  if (input.anyway) return { state: "allowed", outcome: "explicit_anyway", target: input.target };
  if (input.newerMessages.length === 0) return { state: "allowed", outcome: "fresh", target: input.target };
  return {
    state: "held",
    outcome: "held",
    subtype: "freshness",
    target: input.target,
    heldMessages: input.newerMessages.slice(0, 10),
    availableActions: input.action === "message_send" ? ["review", "send-draft", "send-anyway"] : ["review", "send-anyway"],
  };
}

export function saveHeldDraft(input: { stateDir: string; target: string; text: string; reason: "freshness" }): { id: string; path: string } {
  const id = randomUUID();
  const draftsDir = join(input.stateDir, ".zano-drafts");
  mkdirSync(draftsDir, { recursive: true });
  const path = join(draftsDir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ id, target: input.target, text: input.text, reason: input.reason, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return { id, path };
}
```

- [ ] **Step 6: Integrate freshness into CLI commands**

In `packages/cli/src/index.ts`, add imports:

```ts
import { evaluateFreshnessPreflight, saveHeldDraft } from "./freshness";
import { readAgentLocalState, writeAgentLocalState } from "./local-state";
```

Read token file references near env setup:

```ts
const AGENT_TOKEN_FILE = process.env.ZANO_AGENT_TOKEN_FILE;
const AGENT_PROXY_TOKEN_FILE = process.env.ZANO_AGENT_PROXY_TOKEN_FILE;
const AGENT_LOCAL_STATE = process.env.ZANO_AGENT_LOCAL_STATE;
```

Before `message send`, `task claim`, and `task update` perform the side effect, call a helper that queries bounded newer visible messages for the target and evaluates preflight:

```ts
const localState = readAgentLocalState(AGENT_LOCAL_STATE);
const lastSeenMessageCreatedAt = localState.freshness?.[target]?.lastSeenMessageCreatedAt ?? localState.currentDelivery?.messageCreatedAt ?? null;
const newerMessages = await fetchNewerVisibleMessages({ target, after: lastSeenMessageCreatedAt, limit: 10 });
const freshness = evaluateFreshnessPreflight({ action: "message_send", target, lastSeenMessageCreatedAt, newerMessages, anyway: flags.anyway });
if (freshness.state === "held") {
  const draft = saveHeldDraft({ stateDir: dirname(AGENT_LOCAL_STATE ?? process.cwd()), target, text, reason: "freshness" });
  console.log(JSON.stringify({ ...freshness, draftId: draft.id, draftPath: draft.path }, null, 2));
  process.exitCode = 2;
  return;
}
```

For `task claim` and `task update`, use `action: "task_claim"` and `action: "task_update"`; do not save a message draft for task side effects.

Add `message send-draft <draft-id>` command that reads the draft JSON from `.zano-drafts`, re-runs freshness review, and sends only when fresh or `--anyway` is present.

- [ ] **Step 7: Teach prompt freshness behavior**

In `apps/omni/src/system-prompt.ts`, include this wording in the CLI/freshness section:

```text
If `zano message send`, `zano task claim`, or `zano task update` returns a freshness hold, stop and review the newer bounded context before acting.
For held message sends, use `zano message send-draft <draft-id>` after review, or use `--anyway` only when you intentionally choose to override the newer context.
Do not silently land task claims or updates over newer human/team messages.
```

- [ ] **Step 8: Run CLI tests and build**

Run:

```bash
pnpm --filter @fehey/zano-cli test -- freshness.test.ts
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/package.json packages/cli/src/local-state.ts packages/cli/src/freshness.ts packages/cli/src/freshness.test.ts packages/cli/src/index.ts apps/omni/src/system-prompt.ts
git commit -m "feat: hold stale CLI side effects for freshness review

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Add bounded thread join context to deliveries

**Files:**
- Modify: `apps/omni/src/a2a-protocol.ts`
- Modify: `apps/omni/src/a2a-protocol.test.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.ts`
- Modify: `apps/omni/src/system-prompt.ts`
- Test: `apps/omni/src/a2a-protocol.test.ts`, `apps/omni/src/runtime/prompt-materializer.test.ts`

- [ ] **Step 1: Add failing thread join context tests**

Add this test to `apps/omni/src/a2a-protocol.test.ts`:

```ts
it("includes bounded thread join context when an agent is pulled into a thread", () => {
  const plan = planA2ADeliveries({
    message: createMessage({
      id: "msg-thread-latest",
      channelId: "channel-1",
      threadId: "thread-1",
      senderType: "human",
      senderDisplayName: "Biang",
      text: "@agent-1 can you review this?",
      createdAt: "2026-05-23T12:00:00.000Z",
    }),
    thread: {
      id: "thread-1",
      parentMessage: createMessage({ id: "msg-parent", text: "Initial design question", createdAt: "2026-05-23T11:00:00.000Z" }),
      recentMessages: [
        createMessage({ id: "msg-previous", text: "Relevant previous reply", createdAt: "2026-05-23T11:59:00.000Z" }),
      ],
    },
    agents: [createAgent({ id: "agent-1", displayName: "agent-1" })],
  });

  expect(plan.deliveries[0].threadContext).toEqual({
    parentMessage: expect.objectContaining({ id: "msg-parent", text: "Initial design question" }),
    recentMessages: [expect.objectContaining({ id: "msg-previous", text: "Relevant previous reply" })],
    suggestedReadTarget: "#channel-1:thread-1",
    threadTarget: "#channel-1:thread-1",
  });
});
```

Use the existing planner/helper names in `a2a-protocol.test.ts`; preserve the expected `threadContext` shape.

- [ ] **Step 2: Run A2A tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- a2a-protocol.test.ts
```

Expected: FAIL because deliveries do not include bounded thread context yet.

- [ ] **Step 3: Add thread context types and formatting**

In `apps/omni/src/a2a-protocol.ts`, add:

```ts
export interface DeliveryThreadContext {
  parentMessage: A2AMessageSummary;
  recentMessages: A2AMessageSummary[];
  suggestedReadTarget: string;
  threadTarget: string;
}

function buildThreadJoinContext(input: { channelId: string; threadId: string; parentMessage: A2AMessageSummary; recentMessages: A2AMessageSummary[] }): DeliveryThreadContext {
  const threadTarget = `#${input.channelId}:${input.threadId}`;
  return {
    parentMessage: input.parentMessage,
    recentMessages: input.recentMessages.slice(-10),
    suggestedReadTarget: threadTarget,
    threadTarget,
  };
}
```

Add `threadContext?: DeliveryThreadContext` to delivery plan output records.

- [ ] **Step 4: Attach thread context during planning**

When a message has a `threadId` and the planner has parent/recent thread facts, attach:

```ts
threadContext: buildThreadJoinContext({
  channelId: message.channelId,
  threadId: message.threadId,
  parentMessage: input.thread.parentMessage,
  recentMessages: input.thread.recentMessages,
}),
```

Keep thread/task boundaries scoped; do not expand this context into top-level all-agent broadcast.

- [ ] **Step 5: Update prompt wording**

In `apps/omni/src/system-prompt.ts`, include:

```text
When a delivery includes thread join context, read the parent message and recent thread messages before replying.
Default replies for thread deliveries stay in the exact thread target shown in the delivery header or suggested read target.
Only move thread/task context back to the top-level channel when doing so is useful and explicit.
```

- [ ] **Step 6: Run thread tests**

Run:

```bash
pnpm --filter @biang/omni test -- a2a-protocol.test.ts prompt-materializer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/omni/src/a2a-protocol.ts apps/omni/src/a2a-protocol.test.ts apps/omni/src/runtime/prompt-materializer.ts apps/omni/src/runtime/prompt-materializer.test.ts apps/omni/src/system-prompt.ts
git commit -m "feat: include bounded thread join context

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Harden the agent prompt teammate contract

**Files:**
- Modify: `apps/omni/src/system-prompt.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.ts`
- Modify: `apps/omni/src/runtime/prompt-materializer.test.ts`
- Test: `apps/omni/src/runtime/prompt-materializer.test.ts`

- [ ] **Step 1: Add failing prompt contract coverage**

Add this test to `apps/omni/src/runtime/prompt-materializer.test.ts`:

```ts
it("includes the strict Slock-like teammate contract sections", () => {
  const prompt = materializeTestPrompt();

  expect(prompt).toContain("Who you are");
  expect(prompt).toContain("Current Runtime Context");
  expect(prompt).toContain("Communication — zano CLI ONLY");
  expect(prompt).toContain("Startup sequence");
  expect(prompt).toContain("Message Notifications");
  expect(prompt).toContain("Threads");
  expect(prompt).toContain("Tasks");
  expect(prompt).toContain("@Mentions");
  expect(prompt).toContain("Reading history / search / check");
  expect(prompt).toContain("Freshness holds");
  expect(prompt).toContain("Runtime Profile Controls");
  expect(prompt).toContain("todo -> in_progress -> in_review -> done");
  expect(prompt).toContain("Move work to in_review before marking it done");
  expect(prompt).toContain("Wake-up does not always require a visible reply");
  expect(prompt).toContain("Never write secrets into memory, notes, messages, or logs");
});
```

Use an existing prompt test helper if present. If none exists, add a local helper that calls `PromptMaterializer` and reads the written prompt.

- [ ] **Step 2: Run prompt tests to verify they fail**

Run:

```bash
pnpm --filter @biang/omni test -- prompt-materializer.test.ts
```

Expected: FAIL if any required section is missing or has weaker wording.

- [ ] **Step 3: Update `system-prompt.ts` sections**

In `apps/omni/src/system-prompt.ts`, ensure the prompt includes these sections with these core rules:

```text
# Who you are
You are a Zano workspace member running inside a local daemon-managed runtime. Act like a concise teammate, not a webhook bot or generic assistant.

# Communication — zano CLI ONLY
Use the `zano` CLI for ordinary visible workspace collaboration: messages, threads, task updates, reads, checks, and searches.
Do not write directly to the database or call Supabase from the runtime.
The only reserved MCP runtime-control action in this parity layer is `runtime_profile_migration_done`.

# Startup sequence
On wake-up, inspect the delivery context and decide whether to reply, continue work silently, update a task thread, read/search context, hand off, or skip.
Wake-up does not always require a visible reply.

# Threads
If a delivery target includes a thread suffix, keep replies in that exact target by default.
When thread join context is present, read parent and recent thread context before acting.

# Tasks
Task status flow: todo -> in_progress -> in_review -> done.
Claim a task before doing task work unless you already own it.
Put task progress and blockers in the task thread.
Move work to in_review before marking it done.
Set done only after human approval or explicit instruction.

# Freshness holds
If `zano message send`, `zano task claim`, or `zano task update` returns a freshness hold, review the newer bounded context before acting.
Use send-draft after review or --anyway only as an explicit override.

# @Mentions and handoffs
Explicit @mention is the strong handoff protocol.
Casual name mentions are weak context unless the delivery says otherwise.
A handoff should say what is being handed off and the next action.

# Communication style
Be concise and useful.
Avoid noisy acknowledgements.
Continue work silently when speech would not help.
Never write secrets into memory, notes, messages, or logs.
```

Preserve existing project-specific Zano instructions that do not conflict with strict parity. Remove or demote wording that implies autonomous personality systems, ordinary MCP chat/task tools, or agent-authored all-agent broadcast loops are part of Slock parity.

- [ ] **Step 4: Update materializer daemon context**

In `apps/omni/src/runtime/prompt-materializer.ts`, update the daemon delivery header grammar to include ACK/freshness/thread context without implying completion:

```text
Incoming messages may begin with `[delivery=<delivery-short-id> seq=<per-agent-seq> traceparent=<traceparent> target=<target> msg=<message-short-id> time=<iso-time> sender=@<display-name> type=<human|agent|system>]`.
`delivery=` identifies daemon custody for this delivery; it is not business completion.
If the target includes a thread suffix, reuse that exact target in replies.
If thread join context is included below the header, read it before acting.
Busy wake-ups may be represented as pending-message notifications until a safe runtime boundary.
```

- [ ] **Step 5: Run prompt tests**

Run:

```bash
pnpm --filter @biang/omni test -- prompt-materializer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/omni/src/system-prompt.ts apps/omni/src/runtime/prompt-materializer.ts apps/omni/src/runtime/prompt-materializer.test.ts
git commit -m "feat: harden Slock-like agent prompt contract

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Update UI and shared labels for custody observability

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/src/components/message-delivery-drawer.tsx`
- Modify: `apps/web/src/hooks/use-agent-activity.ts`
- Modify: `apps/web/src/hooks/use-member-activity.ts`
- Test: web build/lint

- [ ] **Step 1: Add shared label helpers**

In `packages/shared/src/index.ts`, add:

```ts
export const DAEMON_DELIVERY_STATE_LABELS = {
  accepted: "ACKed: daemon accepted custody",
  queued_starting: "Queued: runtime is starting",
  queued_busy: "Queued: runtime is busy",
  queued_gated: "Queued: waiting for safe runtime boundary",
  queued_compaction: "Queued: waiting for compaction-safe boundary",
  restarting_idle: "Restarting from idle",
  delivering: "Delivering to runtime",
  delivered: "Delivered to runtime input",
  completed: "Derived work evidence observed",
  failed: "Daemon/runtime diagnostic error",
  cancelled: "Cancelled",
} as const;

export const DAEMON_RUNTIME_OUTCOME_LABELS = {
  queued_busy: "Runtime busy",
  queued_during_start: "Queued during runtime start",
  deferred_wake_message: "Wake message deferred",
  auto_restart_from_idle: "Auto restart from idle",
  rejected_no_process: "Daemon did not accept custody",
  stdin_idle_delivery: "Full delivery at idle/turn-end",
  queued_stalled_recovery: "Queued during stalled recovery",
  queued_busy_non_stdin: "Queued for non-stdin runtime",
  queued_before_session: "Queued before session id",
  queued_compaction_boundary: "Queued at compaction boundary",
  queued_busy_gated: "Queued behind Claude gated steering",
  queued_busy_notification: "Pending-message notification sent",
} as const;
```

- [ ] **Step 2: Update drawer copy**

In `apps/web/src/components/message-delivery-drawer.tsx`, display:

```tsx
const stateLabel = DAEMON_DELIVERY_STATE_LABELS[delivery.state as keyof typeof DAEMON_DELIVERY_STATE_LABELS] ?? delivery.state;
const outcomeLabel = delivery.runtimeOutcome
  ? DAEMON_RUNTIME_OUTCOME_LABELS[delivery.runtimeOutcome as keyof typeof DAEMON_RUNTIME_OUTCOME_LABELS] ?? delivery.runtimeOutcome
  : null;
```

Show helper text:

```tsx
<p className="text-xs text-muted-foreground">
  ACK means the local daemon accepted custody. It does not mean the agent replied or completed the work.
</p>
```

For `completed`, show:

```tsx
<p className="text-xs text-muted-foreground">
  Completed is derived from task, reply, or session evidence; it is not an ordinary delivery completion ACK.
</p>
```

- [ ] **Step 3: Update activity hooks**

In `apps/web/src/hooks/use-agent-activity.ts` and `apps/web/src/hooks/use-member-activity.ts`, map new runtime queue/profile states to neutral activity text:

```ts
queued_gated: "Waiting for safe runtime boundary",
queued_compaction: "Waiting for compaction-safe boundary",
queued_busy_notification: "Pending message notification sent",
stdin_idle_delivery: "Delivered at idle boundary",
```

Do not show "lost", "dead-letter", or "agent completed" for ACKed/queued states.

- [ ] **Step 4: Run web validation**

Run:

```bash
pnpm --filter @zano/web lint
pnpm --filter @zano/web build
```

Expected: PASS.

- [ ] **Step 5: Browser smoke for UI labels**

Start the web server:

```bash
pnpm dev:web
```

Open the app in the browser and inspect the message delivery drawer for a message with daemon delivery rows. Confirm these visible labels:

```text
ACKed: daemon accepted custody
Queued: waiting for safe runtime boundary
ACK means the local daemon accepted custody. It does not mean the agent replied or completed the work.
```

Expected: labels are visible and no UI path says ACK means the agent completed or replied.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts apps/web/src/components/message-delivery-drawer.tsx apps/web/src/hooks/use-agent-activity.ts apps/web/src/hooks/use-member-activity.ts
git commit -m "fix: label daemon delivery states by custody semantics

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: Enforce non-goals and run full parity verification

**Files:**
- Modify: tests only if a discovered failure needs a precise regression test
- Test: bridge tests, CLI tests, DB verify, web lint/build, repository searches

- [ ] **Step 1: Run forbidden-mechanism searches**

Run:

```bash
grep -R "daemon_dead_letters\|dead-letter inbox\|agent:deliver:completed\|thread follow\|personality marketplace\|emotion/persona" apps packages docs/superpowers/specs/2026-05-23-zano-daemon-slock-strict-parity-design.md
```

Expected: matches only appear in explicit forbidden/non-goal text or spec wording that says not to implement them. No code path, SQL table, CLI command, UI label, or prompt instruction should implement these as active features.

- [ ] **Step 2: Run all bridge runtime tests**

Run:

```bash
pnpm --filter @biang/omni test
```

Expected: PASS.

- [ ] **Step 3: Run CLI tests and build**

Run:

```bash
pnpm --filter @fehey/zano-cli test
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 4: Run DB verification and package build**

Run:

```bash
pnpm --filter @zano/db verify:daemon
pnpm --filter @zano/db build
```

Expected: PASS.

- [ ] **Step 5: Run web validation**

Run:

```bash
pnpm --filter @zano/web lint
pnpm --filter @zano/web build
```

Expected: PASS.

- [ ] **Step 6: Run workspace build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 7: Local bridge smoke without sending real workspace messages**

Run Omni against local/dev configuration only. Do not send real messages to production-like workspaces unless the human explicitly approves.

Expected local observations:

```text
.zano/zano exists under the agent workdir
.zano/claude-system-prompt.md exists
.zano/agent-token or ~/.zano/agent-proxy-tokens/<agentId>/<launch>.token exists with secret file role
wrapper text references token file paths but does not include raw token values
runtime session record has launchId and sessionRef/workspacePathRef
ACKed delivery row has accepted_at and no completed_at caused by ACK alone
queued busy Claude delivery sends pending notification before turn-end full flush
```

- [ ] **Step 8: Commit verification-only fixes if needed**

If verification revealed a real bug and a small regression test/fix was added, commit it:

```bash
git add <specific-files>
git commit -m "test: verify strict daemon parity contracts

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

If verification passes without changes, do not create an empty commit.

---

## Implementation Order and Review Gates

Use this order:

1. Runtime profiles.
2. Gated steering pure state.
3. Delivery transition semantics.
4. Schema/ledger custody fields.
5. Delivery runtime and bridge ACK behavior.
6. Supervisor inbox/gated state.
7. AgentManager safe-boundary integration.
8. Local runtime materialization and secrets.
9. Runtime session references.
10. Runtime-profile controls.
11. CLI freshness hold.
12. Thread join context.
13. Prompt contract.
14. UI labels.
15. Full verification.

Review after each task:

```text
- Tests added before implementation.
- Focused tests pass.
- No raw secrets in prompt/wrapper/log/UI-visible text.
- No ordinary delivery completion protocol added.
- No dead-letter product state added.
- No broad refactor outside the task files.
```

---

## Plan Self-Review

### Spec coverage

- ACK semantics: Tasks 3, 4, 5, 14, 15.
- Replay/retry/dead-letter boundary: Tasks 4, 5, 15.
- Runtime profiles: Task 1.
- Busy/gated/safe boundary: Tasks 2, 6, 7.
- Runtime profile controls: Tasks 8, 10, 13.
- Freshness hold: Task 11 and Task 13.
- Thread join context: Task 12 and Task 13.
- Local runtime materialization: Task 8 and Task 9.
- CLI transport/environment/secrets: Task 8 and Task 11.
- Runtime session reporting: Task 9.
- Prompt surface: Task 13.
- Collaboration protocol: Tasks 11, 12, 13.
- UI/observability semantics: Task 14.
- Non-goal enforcement: Task 15.

### Placeholder scan

No task contains placeholder directives or unspecified edge-case buckets. Steps that depend on existing test harness names explicitly preserve the required behavior and constrain the adaptation to local helper names.

### Type consistency

The plan uses these stable names across tasks:

```text
RuntimeKind
RuntimeDriverProfile
GatedSteeringState
ClaudeGatedSteeringEvent
RuntimeDeliveryRecord.ackTraceparent
RuntimeDeliveryRecord.lastRuntimeEventAt
RuntimeDeliveryRecord.runtimeOutcome
runtime_profile_migration_done
.zano/zano
.zano/claude-system-prompt.md
.zano/runtime-sessions
```

### Scope check

The plan is broad but scoped to strict Slock parity refinement of the existing daemon v2. It does not introduce a new workflow engine, dead-letter product, personality system, ordinary collaboration MCP tools, or agent-authored all-agent broadcast path.
