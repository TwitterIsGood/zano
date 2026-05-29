# Zano Daemon Platform v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Zano's Slock-parity daemon runtime with durable deliveries, per-agent sequence numbers, trace context, start scheduling, idle restart, busy/gated delivery, local `~/.zano` state, materialized prompts/wrappers, CLI inspection, and web observability.

**Architecture:** Keep the existing A2A routing planner in the bridge, then route every planned activation through a new runtime layer under `apps/bridge/src/runtime`. The runtime owns delivery ledger writes, local trace files, process lifecycle state, queueing/gating decisions, and prompt/wrapper/session materialization while `AgentManager` remains the compatibility façade during migration.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, Supabase PostgREST/Realtime, Next.js 16, pnpm workspaces, existing `@fehey/zano-bridge`, `@fehey/zano-cli`, `@zano/db`, and `@zano/web` packages.

---

## File Structure

- Create: `apps/bridge/src/runtime/types.ts`
  - Shared runtime enums, delivery/session/start/trace interfaces, redaction types, and transition validation helpers.
- Create: `apps/bridge/src/runtime/trace-context.ts`
  - W3C-style trace id/span id/traceparent generation and parsing.
- Create: `apps/bridge/src/runtime/local-trace-sink.ts`
  - Secret-redacting JSONL trace sink with deterministic file rotation boundary.
- Create: `apps/bridge/src/runtime/local-state.ts`
  - `~/.zano/machines/<machine-id>` and `~/.zano/agents/<agent-id>` directory/materialized-state manager.
- Create: `apps/bridge/src/runtime/prompt-materializer.ts`
  - Builds and writes daemon-aware system prompt snapshots with delivery header grammar.
- Create: `apps/bridge/src/runtime/cli-transport.ts`
  - Builds per-agent `zano` wrapper scripts without embedding secrets.
- Create: `apps/bridge/src/runtime/delivery-ledger.ts`
  - Supabase-backed delivery/trace persistence with idempotency and per-agent sequence allocation.
- Create: `apps/bridge/src/runtime/session-ledger.ts`
  - Supabase-backed runtime session persistence and row mapping for `daemon_runtime_sessions`.
- Create: `apps/bridge/src/runtime/start-coordinator.ts`
  - Dedupe, concurrency, start interval, and starting inbox policy.
- Create: `apps/bridge/src/runtime/agent-supervisor.ts`
  - Process lifecycle state machine boundary extracted from `AgentManager`.
- Create: `apps/bridge/src/runtime/delivery-runtime.ts`
  - High-level delivery state machine that ties ledger, supervisor, start coordinator, local state, and trace sink together.
- Create: `apps/bridge/src/runtime/index.ts`
  - Runtime public exports for bridge and tests.
- Create tests beside the runtime files:
  - `apps/bridge/src/runtime/types.test.ts`
  - `apps/bridge/src/runtime/trace-context.test.ts`
  - `apps/bridge/src/runtime/local-trace-sink.test.ts`
  - `apps/bridge/src/runtime/local-state.test.ts`
  - `apps/bridge/src/runtime/prompt-materializer.test.ts`
  - `apps/bridge/src/runtime/cli-transport.test.ts`
  - `apps/bridge/src/runtime/delivery-ledger.test.ts`
  - `apps/bridge/src/runtime/session-ledger.test.ts`
  - `apps/bridge/src/runtime/start-coordinator.test.ts`
  - `apps/bridge/src/runtime/agent-supervisor.test.ts`
  - `apps/bridge/src/runtime/delivery-runtime.test.ts`
- Modify: `apps/bridge/src/bridge.ts`
  - Export routing delivery inputs, instantiate runtime when `ZANO_DAEMON_V2=1`, and submit planned deliveries to the runtime.
- Modify: `apps/bridge/src/agent-manager.ts`
  - Add a runtime driver boundary so v2 can reuse existing spawn/stdin/result parsing while moving queue decisions out of `AgentManager`.
- Modify: `apps/bridge/src/system-prompt.ts`
  - Add daemon delivery header grammar and runtime note to generated prompts.
- Modify: `apps/bridge/src/index.ts`
  - Pass machine/workspace metadata and bridge version into runtime config.
- Create: `packages/db/src/daemon.sql`
  - Daemon delivery/session/start/trace schema.
- Create: `packages/db/scripts/verify-daemon-schema.mjs`
  - Regex checks for required daemon tables, constraints, indexes, and policies.
- Create: `packages/db/scripts/apply-daemon-schema.mjs`
  - Applies `daemon.sql` with `psql`, matching the existing autonomous schema script style.
- Modify: `packages/db/package.json`
  - Add `apply:daemon` and `verify:daemon` scripts.
- Modify: `packages/db/src/schema.ts` and `packages/db/src/index.ts`
  - Export `daemonSchema` reference string.
- Modify: `packages/cli/src/index.ts`
  - Add `zano daemon ...` and `zano agent ...` inspection commands and delivery-context propagation for agent-authored messages.
- Modify: `apps/web/src/components/message-area.tsx`
  - Show per-message delivery summary and open a delivery drawer.
- Create: `apps/web/src/components/message-delivery-drawer.tsx`
  - Client-side drawer for delivery state, seq, trace id, and last error.
- Modify: `apps/web/src/components/member-activity-tab.tsx`
  - Show runtime session/delivery status for agent member detail.
- Create: `apps/web/src/app/api/daemon/deliveries/route.ts`
  - Server API for message/agent delivery inspection.
- Create: `apps/web/src/app/api/daemon/sessions/route.ts`
  - Server API for agent runtime sessions.

---

### Task 1: Runtime Types and State Transitions

**Files:**
- Create: `apps/bridge/src/runtime/types.ts`
- Create: `apps/bridge/src/runtime/types.test.ts`
- Create: `apps/bridge/src/runtime/index.ts`

- [ ] **Step 1: Write failing runtime type tests**

Create `apps/bridge/src/runtime/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DELIVERY_TERMINAL_STATES,
  DELIVERY_TRANSITIONS,
  buildDeliveryIdempotencyKey,
  canTransitionDelivery,
  isRecoverableDeliveryState,
  redactTraceAttributes,
  type DeliveryState,
} from "./types";

describe("delivery state transitions", () => {
  it("allows planned deliveries to enter the runtime", () => {
    expect(canTransitionDelivery("planned", "received")).toBe(true);
  });

  it("allows received deliveries to move into queue or delivery states", () => {
    expect(DELIVERY_TRANSITIONS.received).toEqual(
      expect.arrayContaining(["queued_starting", "queued_busy", "queued_gated", "restarting_idle", "delivering", "failed"]),
    );
  });

  it("rejects transitions out of terminal states", () => {
    for (const state of DELIVERY_TERMINAL_STATES) {
      expect(canTransitionDelivery(state, "received")).toBe(false);
    }
  });

  it("marks only queued and restart states as recoverable", () => {
    const recoverable: DeliveryState[] = ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering"];
    const nonRecoverable: DeliveryState[] = ["planned", "deduped", "completed", "failed", "cancelled"];

    for (const state of recoverable) expect(isRecoverableDeliveryState(state)).toBe(true);
    for (const state of nonRecoverable) expect(isRecoverableDeliveryState(state)).toBe(false);
  });
});

describe("delivery idempotency", () => {
  it("uses source message, agent, target, and sorted reasons", () => {
    expect(
      buildDeliveryIdempotencyKey({
        sourceMessageId: "msg-1",
        agentId: "agent-1",
        target: "#general",
        activationReasons: ["domain_fit", "direct_mention"],
      }),
    ).toBe("msg-1:agent-1:#general:direct_mention+domain_fit");
  });
});

describe("trace redaction", () => {
  it("redacts known secret-bearing attributes recursively", () => {
    expect(
      redactTraceAttributes({
        apiKey: "zk_secret",
        token: "jwt_secret",
        nested: { authorization: "Bearer secret", safe: "visible" },
        list: [{ supabaseKey: "anon_secret" }, "ok"],
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
      list: [{ supabaseKey: "[REDACTED]" }, "ok"],
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/types.test.ts
```

Expected: FAIL because `apps/bridge/src/runtime/types.ts` does not exist.

- [ ] **Step 3: Implement runtime types**

Create `apps/bridge/src/runtime/types.ts`:

```ts
export type DeliveryState =
  | "planned"
  | "received"
  | "deduped"
  | "queued_starting"
  | "queued_busy"
  | "queued_gated"
  | "queued_compaction"
  | "restarting_idle"
  | "delivering"
  | "delivered"
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled";

export type DeliveryQueueReason =
  | "agent_starting"
  | "agent_busy"
  | "gated_safe_boundary"
  | "compaction_boundary"
  | "idle_restart"
  | "stale_recovery";

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "busy"
  | "gated"
  | "idle"
  | "stale"
  | "stopping"
  | "failed"
  | "ended";

export type StartQueueState = "queued" | "starting" | "started" | "failed" | "cancelled";
export type RuntimeTraceSeverity = "debug" | "info" | "warn" | "error";

export interface DeliveryIdempotencyInput {
  sourceMessageId: string;
  agentId: string;
  target: string;
  activationReasons: string[];
}

export interface RuntimeDeliveryInput extends DeliveryIdempotencyInput {
  workspaceId: string;
  channelId: string;
  threadParentId: string | null;
  taskId: string | null;
  activationStrength: "strong" | "medium" | "weak";
  prompt: string;
  sourceCreatedAt: string;
  senderId: string;
  senderType: "human" | "agent" | "system";
}

export interface RuntimeDeliveryRecord extends RuntimeDeliveryInput {
  id: string;
  idempotencyKey: string;
  deliverySeq: number;
  traceId: string;
  spanId: string;
  traceparent: string;
  state: DeliveryState;
  queueReason: DeliveryQueueReason | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  machineId: string;
  runtime: "claude-code";
  runtimeModel: string | null;
  sessionId: string | null;
  processId: number | null;
  state: RuntimeSessionState;
  promptHash: string;
  wrapperHash: string | null;
  startedAt: string;
  lastActiveAt: string | null;
  idleAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export interface StartQueueEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  machineId: string;
  reason: string;
  state: StartQueueState;
  dedupeKey: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export interface RuntimeTraceEvent {
  id: string;
  workspaceId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  deliveryId: string | null;
  agentId: string | null;
  eventType: "routing" | "delivery" | "process" | "stdin" | "cli" | "recovery";
  eventName: string;
  severity: RuntimeTraceSeverity;
  attributes: Record<string, unknown>;
  createdAt: string;
}

export const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  planned: ["received", "deduped", "cancelled"],
  received: ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering", "failed", "cancelled"],
  deduped: [],
  queued_starting: ["delivering", "queued_busy", "failed", "cancelled"],
  queued_busy: ["delivering", "queued_gated", "failed", "cancelled"],
  queued_gated: ["delivering", "queued_compaction", "failed", "cancelled"],
  queued_compaction: ["delivering", "queued_busy", "failed", "cancelled"],
  restarting_idle: ["queued_starting", "delivering", "failed", "cancelled"],
  delivering: ["delivered", "failed", "cancelled"],
  delivered: ["accepted", "failed"],
  accepted: ["completed", "queued_busy", "queued_gated", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const DELIVERY_TERMINAL_STATES: DeliveryState[] = ["deduped", "completed", "failed", "cancelled"];
export const DELIVERY_RECOVERABLE_STATES: DeliveryState[] = ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering"];

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isRecoverableDeliveryState(state: DeliveryState): boolean {
  return DELIVERY_RECOVERABLE_STATES.includes(state);
}

export function buildDeliveryIdempotencyKey(input: DeliveryIdempotencyInput): string {
  return `${input.sourceMessageId}:${input.agentId}:${input.target}:${[...input.activationReasons].sort().join("+")}`;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|token|authorization|supabase[-_]?key|service[-_]?role|jwt|secret|password)/i;

export function redactTraceAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactTraceAttributes(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactTraceAttributes(entry),
    ]),
  );
}
```

Create `apps/bridge/src/runtime/index.ts`:

```ts
export * from "./types";
export * from "./trace-context";
export * from "./local-trace-sink";
export * from "./local-state";
export * from "./prompt-materializer";
export * from "./cli-transport";
export * from "./delivery-ledger";
export * from "./session-ledger";
export * from "./start-coordinator";
export * from "./agent-supervisor";
export * from "./delivery-runtime";
```

- [ ] **Step 4: Run the test again**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/runtime/types.ts apps/bridge/src/runtime/types.test.ts apps/bridge/src/runtime/index.ts
git commit -m "feat: add daemon runtime type contract"
```

---

### Task 2: Trace Context and Local Trace Sink

**Files:**
- Create: `apps/bridge/src/runtime/trace-context.ts`
- Create: `apps/bridge/src/runtime/trace-context.test.ts`
- Create: `apps/bridge/src/runtime/local-trace-sink.ts`
- Create: `apps/bridge/src/runtime/local-trace-sink.test.ts`

- [ ] **Step 1: Write failing trace context tests**

Create `apps/bridge/src/runtime/trace-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTraceContext, formatTraceparent, parseTraceparent } from "./trace-context";

describe("trace context", () => {
  it("creates W3C-style traceparent values", () => {
    const context = createTraceContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(formatTraceparent(context)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("parses traceparent values", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceparent("bad")).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing local trace sink tests**

Create `apps/bridge/src/runtime/local-trace-sink.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTraceSink } from "./local-trace-sink";

describe("LocalTraceSink", () => {
  it("writes redacted JSONL trace events", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-traces-"));
    const sink = new LocalTraceSink({ traceDir: rootDir, filePrefix: "daemon-trace", now: () => new Date("2026-05-22T01:02:03.000Z") });

    const path = sink.write({
      workspaceId: "server-1",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: null,
      deliveryId: "delivery-1",
      agentId: "agent-1",
      eventType: "delivery",
      eventName: "delivery.received",
      severity: "info",
      attributes: { token: "secret", safe: "visible" },
      createdAt: "2026-05-22T01:02:03.000Z",
    });

    const line = readFileSync(path, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      eventName: "delivery.received",
      attributes: { token: "[REDACTED]", safe: "visible" },
    });
  });
});
```

- [ ] **Step 3: Run failing trace tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/trace-context.test.ts src/runtime/local-trace-sink.test.ts
```

Expected: FAIL because trace modules do not exist.

- [ ] **Step 4: Implement trace context**

Create `apps/bridge/src/runtime/trace-context.ts`:

```ts
import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function createTraceContext(parent?: Pick<TraceContext, "traceId">): TraceContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    sampled: true,
  };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export function parseTraceparent(value: string): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/.exec(value);
  if (!match) return null;
  return { traceId: match[1], spanId: match[2], sampled: match[3] === "01" };
}
```

- [ ] **Step 5: Implement local trace sink**

Create `apps/bridge/src/runtime/local-trace-sink.ts`:

```ts
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { redactTraceAttributes, type RuntimeTraceEvent } from "./types";

export interface LocalTraceSinkOptions {
  traceDir: string;
  filePrefix?: string;
  now?: () => Date;
}

export class LocalTraceSink {
  private readonly traceDir: string;
  private readonly filePrefix: string;
  private readonly now: () => Date;

  constructor(options: LocalTraceSinkOptions) {
    this.traceDir = options.traceDir;
    this.filePrefix = options.filePrefix ?? "daemon-trace";
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.traceDir, { recursive: true });
  }

  write(event: RuntimeTraceEvent): string {
    const path = this.currentPath();
    const redacted = { ...event, attributes: redactTraceAttributes(event.attributes) };
    appendFileSync(path, `${JSON.stringify(redacted)}\n`, "utf8");
    return path;
  }

  currentPath(): string {
    const stamp = this.now().toISOString().slice(0, 13).replace(/[-:T]/g, "");
    return join(this.traceDir, `${this.filePrefix}-${stamp}.jsonl`);
  }
}
```

- [ ] **Step 6: Run trace tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/trace-context.test.ts src/runtime/local-trace-sink.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bridge/src/runtime/trace-context.ts apps/bridge/src/runtime/trace-context.test.ts apps/bridge/src/runtime/local-trace-sink.ts apps/bridge/src/runtime/local-trace-sink.test.ts
git commit -m "feat: add daemon trace context and sink"
```

---

### Task 3: Daemon Database Schema and Verifier

**Files:**
- Create: `packages/db/src/daemon.sql`
- Create: `packages/db/scripts/verify-daemon-schema.mjs`
- Create: `packages/db/scripts/apply-daemon-schema.mjs`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write daemon schema verifier first**

Create `packages/db/scripts/verify-daemon-schema.mjs`:

```js
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "src", "daemon.sql");
const schema = readFileSync(schemaPath, "utf8");

const checks = [
  { name: "daemon deliveries table", pattern: /create table if not exists public\.daemon_deliveries/ },
  { name: "daemon runtime sessions table", pattern: /create table if not exists public\.daemon_runtime_sessions/ },
  { name: "daemon start queue table", pattern: /create table if not exists public\.daemon_start_queue/ },
  { name: "daemon trace events table", pattern: /create table if not exists public\.daemon_trace_events/ },
  { name: "delivery idempotency unique index", pattern: /create unique index if not exists daemon_deliveries_workspace_idempotency_key_idx/ },
  { name: "per agent delivery sequence unique index", pattern: /create unique index if not exists daemon_deliveries_workspace_agent_seq_idx/ },
  { name: "delivery trace lookup index", pattern: /create index if not exists daemon_deliveries_workspace_trace_idx/ },
  { name: "session machine lookup index", pattern: /create index if not exists daemon_runtime_sessions_workspace_machine_idx/ },
  { name: "start queue dedupe index", pattern: /create unique index if not exists daemon_start_queue_workspace_dedupe_idx/ },
  { name: "trace event delivery lookup index", pattern: /create index if not exists daemon_trace_events_workspace_delivery_idx/ },
  { name: "deliveries RLS enabled", pattern: /alter table public\.daemon_deliveries enable row level security/ },
  { name: "bridge can manage deliveries policy", pattern: /create policy "Bridge can manage daemon deliveries"/ },
];

const failures = checks.filter((check) => !check.pattern.test(schema));

if (failures.length > 0) {
  console.error("Daemon schema verification failed:");
  for (const failure of failures) console.error(`- ${failure.name}`);
  process.exit(1);
}

console.log(`Daemon schema verification passed (${checks.length} checks).`);
```

- [ ] **Step 2: Run verifier to confirm it fails**

Run:

```bash
pnpm --filter @zano/db exec node scripts/verify-daemon-schema.mjs
```

Expected: FAIL because `packages/db/src/daemon.sql` does not exist.

- [ ] **Step 3: Add daemon SQL schema**

Create `packages/db/src/daemon.sql`:

```sql
-- ============================================================
-- Zano Daemon Runtime Schema
-- Durable delivery, runtime session, start queue, and trace ledger.
-- Run after schema.sql, servers.sql, collaboration.sql, machine-keys.sql, and autonomous.sql.
-- ============================================================

create table if not exists public.daemon_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  source_message_id uuid not null references public.messages(id) on delete cascade,
  thread_parent_id uuid references public.messages(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  delivery_seq bigint not null,
  idempotency_key text not null,
  trace_id text not null,
  span_id text not null,
  traceparent text not null,
  target text not null,
  activation_strength text not null check (activation_strength in ('strong', 'medium', 'weak')),
  activation_reasons jsonb not null default '[]'::jsonb,
  state text not null check (state in (
    'planned', 'received', 'deduped', 'queued_starting', 'queued_busy', 'queued_gated',
    'queued_compaction', 'restarting_idle', 'delivering', 'delivered', 'accepted',
    'completed', 'failed', 'cancelled'
  )),
  queue_reason text check (queue_reason is null or queue_reason in (
    'agent_starting', 'agent_busy', 'gated_safe_boundary', 'compaction_boundary', 'idle_restart', 'stale_recovery'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  planned_at timestamptz not null default now(),
  received_at timestamptz,
  delivered_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists daemon_deliveries_workspace_idempotency_key_idx
  on public.daemon_deliveries(workspace_id, idempotency_key);

create unique index if not exists daemon_deliveries_workspace_agent_seq_idx
  on public.daemon_deliveries(workspace_id, agent_id, delivery_seq);

create index if not exists daemon_deliveries_workspace_source_message_idx
  on public.daemon_deliveries(workspace_id, source_message_id);

create index if not exists daemon_deliveries_workspace_agent_state_idx
  on public.daemon_deliveries(workspace_id, agent_id, state, created_at);

create index if not exists daemon_deliveries_workspace_trace_idx
  on public.daemon_deliveries(workspace_id, trace_id);

create table if not exists public.daemon_runtime_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  machine_id text not null,
  runtime text not null check (runtime in ('claude-code')),
  runtime_model text,
  session_id text,
  process_id integer,
  state text not null check (state in ('starting', 'ready', 'busy', 'gated', 'idle', 'stale', 'stopping', 'failed', 'ended')),
  prompt_hash text not null,
  wrapper_hash text,
  started_at timestamptz not null default now(),
  last_active_at timestamptz,
  idle_at timestamptz,
  ended_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists daemon_runtime_sessions_workspace_agent_state_idx
  on public.daemon_runtime_sessions(workspace_id, agent_id, state);

create index if not exists daemon_runtime_sessions_workspace_machine_idx
  on public.daemon_runtime_sessions(workspace_id, machine_id, started_at desc);

create index if not exists daemon_runtime_sessions_workspace_session_idx
  on public.daemon_runtime_sessions(workspace_id, session_id);

create table if not exists public.daemon_start_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  machine_id text not null,
  reason text not null,
  state text not null check (state in ('queued', 'starting', 'started', 'failed', 'cancelled')),
  dedupe_key text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists daemon_start_queue_workspace_dedupe_idx
  on public.daemon_start_queue(workspace_id, dedupe_key)
  where state in ('queued', 'starting');

create index if not exists daemon_start_queue_workspace_agent_state_idx
  on public.daemon_start_queue(workspace_id, agent_id, state, requested_at);

create table if not exists public.daemon_trace_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.servers(id) on delete cascade,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  delivery_id uuid references public.daemon_deliveries(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  event_type text not null check (event_type in ('routing', 'delivery', 'process', 'stdin', 'cli', 'recovery')),
  event_name text not null,
  severity text not null default 'info' check (severity in ('debug', 'info', 'warn', 'error')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists daemon_trace_events_workspace_trace_idx
  on public.daemon_trace_events(workspace_id, trace_id, created_at);

create index if not exists daemon_trace_events_workspace_delivery_idx
  on public.daemon_trace_events(workspace_id, delivery_id, created_at);

create index if not exists daemon_trace_events_workspace_agent_idx
  on public.daemon_trace_events(workspace_id, agent_id, created_at desc);

alter table public.daemon_deliveries enable row level security;
alter table public.daemon_runtime_sessions enable row level security;
alter table public.daemon_start_queue enable row level security;
alter table public.daemon_trace_events enable row level security;

create policy "Bridge can manage daemon deliveries"
  on public.daemon_deliveries
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

create policy "Server members can read daemon deliveries"
  on public.daemon_deliveries
  for select
  using (zano_private.actor_is_server_member(workspace_id));

create policy "Bridge can manage daemon runtime sessions"
  on public.daemon_runtime_sessions
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

create policy "Server members can read daemon runtime sessions"
  on public.daemon_runtime_sessions
  for select
  using (zano_private.actor_is_server_member(workspace_id));

create policy "Bridge can manage daemon start queue"
  on public.daemon_start_queue
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

create policy "Server members can read daemon start queue"
  on public.daemon_start_queue
  for select
  using (zano_private.actor_is_server_member(workspace_id));

create policy "Bridge can manage daemon trace events"
  on public.daemon_trace_events
  for all
  using (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge')
  with check (workspace_id = zano_private.current_actor_server_id() and zano_private.current_actor_scope() = 'bridge');

create policy "Server members can read daemon trace events"
  on public.daemon_trace_events
  for select
  using (zano_private.actor_is_server_member(workspace_id));
```

- [ ] **Step 4: Add apply script**

Create `packages/db/scripts/apply-daemon-schema.mjs`:

```js
#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(scriptDir, "../src/daemon.sql");
const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL;

if (!existsSync(schemaPath)) {
  console.error("daemon.sql not found");
  process.exit(1);
}

if (!databaseUrl) {
  console.error([
    "Missing database connection string.",
    "Set DATABASE_URL, SUPABASE_DB_URL, POSTGRES_URL, or POSTGRES_PRISMA_URL.",
    "Example:",
    "  DATABASE_URL='postgresql://postgres:...@db.<project>.supabase.co:5432/postgres' pnpm --filter @zano/db apply:daemon",
  ].join("\n"));
  process.exit(1);
}

const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", schemaPath], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
```

- [ ] **Step 5: Add DB package scripts and exports**

Modify `packages/db/package.json` scripts:

```json
"scripts": {
  "apply:autonomous": "node scripts/apply-autonomous-schema.mjs",
  "verify:autonomous": "node scripts/verify-autonomous-schema.mjs",
  "apply:daemon": "node scripts/apply-daemon-schema.mjs",
  "verify:daemon": "node scripts/verify-daemon-schema.mjs",
  "build": "tsc",
  "lint": "tsc --noEmit"
}
```

Modify `packages/db/src/schema.ts`:

```ts
export const supabaseSchema = "See packages/db/src/schema.sql for the full SQL schema.";
export const autonomousSchema = "See packages/db/src/autonomous.sql for the autonomous actor, skill, knowledge, and agent evolution schema.";
export const daemonSchema = "See packages/db/src/daemon.sql for the daemon delivery, runtime session, start queue, and trace schema.";
```

Modify `packages/db/src/index.ts`:

```ts
export { createClient, createServerClient } from "./client";
export { autonomousSchema, daemonSchema, supabaseSchema } from "./schema";
```

- [ ] **Step 6: Run verifier and build**

Run:

```bash
pnpm --filter @zano/db verify:daemon
pnpm --filter @zano/db build
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/daemon.sql packages/db/scripts/verify-daemon-schema.mjs packages/db/scripts/apply-daemon-schema.mjs packages/db/package.json packages/db/src/schema.ts packages/db/src/index.ts
git commit -m "feat: add daemon runtime database schema"
```

---

### Task 4: Local Zano State Store

**Files:**
- Create: `apps/bridge/src/runtime/local-state.ts`
- Create: `apps/bridge/src/runtime/local-state.test.ts`

- [ ] **Step 1: Write failing local state tests**

Create `apps/bridge/src/runtime/local-state.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLocalStateStore } from "./local-state";

describe("AgentLocalStateStore", () => {
  it("creates machine and agent planes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });

    const machine = store.ensureMachine({ bridgeVersion: "0.1.5", workspaceId: "server-1", hostname: "host", platform: "darwin", arch: "arm64" });
    const agent = store.ensureAgent({ agentId: "agent-1", displayName: "Alpha", description: "Builder" });

    expect(existsSync(machine.traceDir)).toBe(true);
    expect(existsSync(join(rootDir, "machines", "machine-test", "daemon.lock", "owner.json"))).toBe(true);
    expect(existsSync(agent.memoryPath)).toBe(true);
    expect(existsSync(agent.notesDir)).toBe(true);
    expect(agent.secretDir).toContain(join(".zano", "secrets"));
  });

  it("writes JSON without leaking secret file contents into state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-local-state-"));
    const store = new AgentLocalStateStore({ rootDir, machineId: "machine-test" });
    const path = store.writeAgentState("agent-1", { status: "ready", token: "secret" });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ status: "ready", token: "[REDACTED]" });
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/local-state.test.ts
```

Expected: FAIL because `local-state.ts` does not exist.

- [ ] **Step 3: Implement local state store**

Create `apps/bridge/src/runtime/local-state.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactTraceAttributes } from "./types";

export interface AgentLocalStateStoreOptions {
  rootDir: string;
  machineId: string;
}

export interface MachineStateInput {
  bridgeVersion: string;
  workspaceId: string;
  hostname: string;
  platform: string;
  arch: string;
}

export interface AgentStateInput {
  agentId: string;
  displayName: string;
  description: string | null;
}

export interface MachinePaths {
  rootDir: string;
  traceDir: string;
  lockOwnerPath: string;
  runtimeSessionsPath: string;
  startQueuePath: string;
}

export interface AgentPaths {
  rootDir: string;
  memoryPath: string;
  notesDir: string;
  zanoDir: string;
  promptDir: string;
  wrapperDir: string;
  runtimeSessionsDir: string;
  inboxDir: string;
  traceDir: string;
  skillsDir: string;
  secretDir: string;
  statePath: string;
}

export class AgentLocalStateStore {
  readonly rootDir: string;
  readonly machineId: string;

  constructor(options: AgentLocalStateStoreOptions) {
    this.rootDir = options.rootDir;
    this.machineId = options.machineId;
  }

  ensureMachine(input: MachineStateInput): MachinePaths {
    const rootDir = join(this.rootDir, "machines", this.machineId);
    const traceDir = join(rootDir, "traces");
    const lockDir = join(rootDir, "daemon.lock");
    const lockOwnerPath = join(lockDir, "owner.json");
    const runtimeSessionsPath = join(rootDir, "runtime-sessions.json");
    const startQueuePath = join(rootDir, "start-queue.jsonl");

    mkdirSync(traceDir, { recursive: true });
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(join(rootDir, "locks"), { recursive: true });
    this.writeJson(join(rootDir, "machine.json"), { machineId: this.machineId, ...input });
    this.writeJson(join(rootDir, "bridge.json"), { workspaceId: input.workspaceId, bridgeVersion: input.bridgeVersion });
    this.writeJson(lockOwnerPath, { machineId: this.machineId, pid: process.pid, startedAt: new Date().toISOString() });
    if (!existsSync(runtimeSessionsPath)) this.writeJson(runtimeSessionsPath, { sessions: [] });
    if (!existsSync(startQueuePath)) writeFileSync(startQueuePath, "", "utf8");

    return { rootDir, traceDir, lockOwnerPath, runtimeSessionsPath, startQueuePath };
  }

  ensureAgent(input: AgentStateInput): AgentPaths {
    const rootDir = join(this.rootDir, "agents", input.agentId);
    const zanoDir = join(rootDir, ".zano");
    const paths: AgentPaths = {
      rootDir,
      memoryPath: join(rootDir, "MEMORY.md"),
      notesDir: join(rootDir, "notes"),
      zanoDir,
      promptDir: join(zanoDir, "prompts"),
      wrapperDir: join(zanoDir, "wrappers"),
      runtimeSessionsDir: join(zanoDir, "runtime-sessions"),
      inboxDir: join(zanoDir, "inbox"),
      traceDir: join(zanoDir, "traces"),
      skillsDir: join(zanoDir, "skills"),
      secretDir: join(zanoDir, "secrets"),
      statePath: join(zanoDir, "state.json"),
    };

    for (const dir of [rootDir, paths.notesDir, zanoDir, paths.promptDir, paths.wrapperDir, paths.runtimeSessionsDir, paths.inboxDir, paths.traceDir, paths.skillsDir, paths.secretDir]) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(paths.memoryPath)) {
      writeFileSync(paths.memoryPath, `# ${input.displayName}\n\n## Role\n${input.description ?? input.displayName}\n\n## Key Knowledge\n- No notes saved yet.\n`, "utf8");
    }

    this.writeJson(join(zanoDir, "agent.json"), { agentId: input.agentId, displayName: input.displayName, description: input.description });
    if (!existsSync(paths.statePath)) this.writeJson(paths.statePath, { status: "initialized" });

    return paths;
  }

  writeAgentState(agentId: string, state: Record<string, unknown>): string {
    const path = join(this.rootDir, "agents", agentId, ".zano", "state.json");
    mkdirSync(join(this.rootDir, "agents", agentId, ".zano"), { recursive: true });
    this.writeJson(path, redactTraceAttributes(state) as Record<string, unknown>);
    return path;
  }

  writeJson(path: string, value: Record<string, unknown>): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
```

- [ ] **Step 4: Run local state test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/local-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/runtime/local-state.ts apps/bridge/src/runtime/local-state.test.ts
git commit -m "feat: add daemon local state store"
```

---

### Task 5: Prompt and CLI Wrapper Materialization

**Files:**
- Create: `apps/bridge/src/runtime/prompt-materializer.ts`
- Create: `apps/bridge/src/runtime/prompt-materializer.test.ts`
- Create: `apps/bridge/src/runtime/cli-transport.ts`
- Create: `apps/bridge/src/runtime/cli-transport.test.ts`
- Modify: `apps/bridge/src/system-prompt.ts`

- [ ] **Step 1: Write failing prompt materializer tests**

Create `apps/bridge/src/runtime/prompt-materializer.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptMaterializer } from "./prompt-materializer";

describe("PromptMaterializer", () => {
  it("writes daemon-aware prompt snapshots", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-prompts-"));
    const materializer = new PromptMaterializer({ rootDir });
    const result = materializer.materialize({
      agentId: "agent-1",
      displayName: "Alpha",
      name: "alpha",
      description: "Builder",
      systemPrompt: "Prefer evidence.",
      memoryContext: "# Alpha\n",
      autonomousSkillContext: "",
      workspaceId: "server-1",
      workspaceName: "HTTP Workspace",
      machineId: "machine-1",
      hostname: "host",
      platform: "darwin",
      workDir: "/tmp/agent",
      bridgeVersion: "0.1.5",
      model: "opus",
    });

    const content = readFileSync(result.promptPath, "utf8");
    expect(content).toContain("delivery=<delivery-short-id>");
    expect(content).toContain("seq=<per-agent-seq>");
    expect(content).toContain("traceparent=<traceparent>");
    expect(content).toContain("If the target includes a thread suffix, reuse that exact target");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Write failing CLI wrapper tests**

Create `apps/bridge/src/runtime/cli-transport.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliTransportMaterializer } from "./cli-transport";

describe("CliTransportMaterializer", () => {
  it("writes a wrapper that does not inline secrets", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zano-wrapper-"));
    const materializer = new CliTransportMaterializer({ rootDir, nodePath: "/usr/local/bin/node" });
    const result = materializer.materialize({ agentId: "agent-1", cliEntrypoint: "/repo/packages/cli/src/index.ts", mode: "tsx" });
    const body = readFileSync(result.wrapperPath, "utf8");

    expect(body).toContain("exec");
    expect(body).toContain("ZANO_AGENT_LOCAL_STATE");
    expect(body).not.toContain("ZANO_AUTH_TOKEN=");
    expect(body).not.toContain("ZANO_SUPABASE_KEY=");
    expect(result.wrapperHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run failing materialization tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/prompt-materializer.test.ts src/runtime/cli-transport.test.ts
```

Expected: FAIL because materializer modules do not exist.

- [ ] **Step 4: Implement prompt materializer**

Create `apps/bridge/src/runtime/prompt-materializer.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../system-prompt";

export interface PromptMaterializerOptions {
  rootDir: string;
}

export interface PromptMaterializeInput {
  agentId: string;
  displayName: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  memoryContext: string;
  autonomousSkillContext: string;
  workspaceId: string;
  workspaceName: string;
  machineId: string;
  hostname: string;
  platform: string;
  workDir: string;
  bridgeVersion: string;
  model: string;
}

export interface PromptMaterializeResult {
  promptPath: string;
  currentPromptPath: string;
  promptHash: string;
  content: string;
}

export class PromptMaterializer {
  constructor(private readonly options: PromptMaterializerOptions) {}

  materialize(input: PromptMaterializeInput): PromptMaterializeResult {
    const basePrompt = buildSystemPrompt(
      {
        display_name: input.displayName,
        name: input.name,
        description: input.description,
        system_prompt: input.systemPrompt,
      },
      input.memoryContext,
      input.autonomousSkillContext,
    );

    const daemonContext = [
      "",
      "# Zano Daemon Runtime Context",
      `- Agent ID: ${input.agentId}`,
      `- Workspace ID: ${input.workspaceId}`,
      `- Workspace: ${input.workspaceName}`,
      `- Machine ID: ${input.machineId}`,
      `- Hostname: ${input.hostname}`,
      `- Platform: ${input.platform}`,
      `- Workdir: ${input.workDir}`,
      `- Bridge version: ${input.bridgeVersion}`,
      `- Runtime model: ${input.model}`,
      "",
      "## Daemon Delivery Header Grammar",
      "Incoming messages may begin with `[delivery=<delivery-short-id> seq=<per-agent-seq> traceparent=<traceparent> target=<target> msg=<message-short-id> time=<iso-time> sender=@<display-name> type=<human|agent|system>]`.",
      "- `delivery=` identifies this runtime delivery, not just the source chat message.",
      "- `seq=` is monotonic for this agent and should be used only for ordering.",
      "- `traceparent=` links daemon routing, queueing, stdin delivery, CLI replies, and completion evidence.",
      "- If the target includes a thread suffix, reuse that exact target in replies.",
      "- A wake-up means inspect the message; it does not require visible speech.",
      "- Busy messages can be buffered and delivered at daemon-observed safe boundaries.",
    ].join("\n");

    const content = `${basePrompt}\n${daemonContext}\n`;
    const promptHash = createHash("sha256").update(content).digest("hex");
    const promptDir = join(this.options.rootDir, "agents", input.agentId, ".zano", "prompts");
    mkdirSync(promptDir, { recursive: true });

    const promptPath = join(promptDir, `system-prompt-${promptHash}.md`);
    const currentPromptPath = join(this.options.rootDir, "agents", input.agentId, ".zano", "current-system-prompt.md");
    writeFileSync(promptPath, content, "utf8");
    writeFileSync(currentPromptPath, content, "utf8");
    return { promptPath, currentPromptPath, promptHash, content };
  }
}
```

- [ ] **Step 5: Implement CLI wrapper materializer**

Create `apps/bridge/src/runtime/cli-transport.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CliTransportMaterializerOptions {
  rootDir: string;
  nodePath: string;
}

export interface CliTransportInput {
  agentId: string;
  cliEntrypoint: string;
  mode: "node" | "tsx";
}

export interface CliTransportResult {
  wrapperPath: string;
  wrapperHash: string;
  body: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class CliTransportMaterializer {
  constructor(private readonly options: CliTransportMaterializerOptions) {}

  materialize(input: CliTransportInput): CliTransportResult {
    const wrapperDir = join(this.options.rootDir, "agents", input.agentId, ".zano", "wrappers");
    mkdirSync(wrapperDir, { recursive: true });
    const wrapperPath = join(wrapperDir, "zano");
    const localStatePath = join(this.options.rootDir, "agents", input.agentId, ".zano", "state.json");
    const body = input.mode === "node"
      ? `#!/usr/bin/env bash\nexport ZANO_AGENT_LOCAL_STATE=${shellQuote(localStatePath)}\nexec ${shellQuote(this.options.nodePath)} ${shellQuote(input.cliEntrypoint)} "$@"\n`
      : `#!/usr/bin/env bash\nexport ZANO_AGENT_LOCAL_STATE=${shellQuote(localStatePath)}\nexec ${shellQuote(this.options.nodePath)} --loader tsx ${shellQuote(input.cliEntrypoint)} "$@"\n`;

    writeFileSync(wrapperPath, body, { mode: 0o755 });
    return { wrapperPath, wrapperHash: createHash("sha256").update(body).digest("hex"), body };
  }
}
```

- [ ] **Step 6: Update core prompt contract test**

Modify `apps/bridge/src/a2a-protocol.test.ts` prompt contract test to also assert daemon grammar after `buildSystemPrompt(...)` is updated in the next step:

```ts
expect(prompt).toContain("delivery=");
expect(prompt).toContain("traceparent=");
```

- [ ] **Step 7: Update `buildSystemPrompt` daemon section**

Modify `apps/bridge/src/system-prompt.ts` in the message header section so the examples include daemon fields:

```md
`[delivery=d1e2f3a4 seq=43 traceparent=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 sender=@richard type=human] hello everyone`
```

Add this explanation beside the existing target/message/sender bullets:

```md
- `delivery=` — daemon delivery id for this wake-up. It is for tracing and ordering; do not quote it back unless debugging.
- `seq=` — your monotonic per-agent delivery sequence.
- `traceparent=` — distributed trace context linking routing, queueing, runtime delivery, CLI replies, and completion.
```

- [ ] **Step 8: Run materializer and prompt tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/prompt-materializer.test.ts src/runtime/cli-transport.test.ts src/a2a-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/bridge/src/runtime/prompt-materializer.ts apps/bridge/src/runtime/prompt-materializer.test.ts apps/bridge/src/runtime/cli-transport.ts apps/bridge/src/runtime/cli-transport.test.ts apps/bridge/src/system-prompt.ts apps/bridge/src/a2a-protocol.test.ts
git commit -m "feat: materialize daemon prompts and cli wrappers"
```

---

### Task 6: Delivery Ledger

**Files:**
- Create: `apps/bridge/src/runtime/delivery-ledger.ts`
- Create: `apps/bridge/src/runtime/delivery-ledger.test.ts`

- [ ] **Step 1: Write failing delivery ledger tests with an in-memory Supabase adapter**

Create `apps/bridge/src/runtime/delivery-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DeliveryLedger, InMemoryDeliveryLedgerStore } from "./delivery-ledger";

describe("DeliveryLedger", () => {
  it("creates delivery records with monotonic per-agent seq", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const first = await ledger.createOrReuseDelivery({
      workspaceId: "server-1",
      agentId: "agent-1",
      channelId: "channel-1",
      sourceMessageId: "msg-1",
      threadParentId: null,
      taskId: null,
      target: "#general",
      activationReasons: ["channel_broadcast"],
      activationStrength: "medium",
      prompt: "hello",
      sourceCreatedAt: "2026-05-22T00:00:00.000Z",
      senderId: "human-1",
      senderType: "human",
    });

    const second = await ledger.createOrReuseDelivery({ ...first, id: undefined as never, sourceMessageId: "msg-2", prompt: "again" });

    expect(first.deliverySeq).toBe(1);
    expect(second.deliverySeq).toBe(2);
  });

  it("dedupes by idempotency key", async () => {
    const ledger = new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore(), now: () => "2026-05-22T00:00:00.000Z" });
    const input = {
      workspaceId: "server-1",
      agentId: "agent-1",
      channelId: "channel-1",
      sourceMessageId: "msg-1",
      threadParentId: null,
      taskId: null,
      target: "#general",
      activationReasons: ["channel_broadcast"],
      activationStrength: "medium" as const,
      prompt: "hello",
      sourceCreatedAt: "2026-05-22T00:00:00.000Z",
      senderId: "human-1",
      senderType: "human" as const,
    };

    const first = await ledger.createOrReuseDelivery(input);
    const second = await ledger.createOrReuseDelivery(input);

    expect(second.id).toBe(first.id);
    expect(second.state).toBe("deduped");
  });

  it("updates delivery state and writes trace events", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const ledger = new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const delivery = await ledger.createOrReuseDelivery({
      workspaceId: "server-1",
      agentId: "agent-1",
      channelId: "channel-1",
      sourceMessageId: "msg-1",
      threadParentId: null,
      taskId: null,
      target: "#general",
      activationReasons: ["channel_broadcast"],
      activationStrength: "medium",
      prompt: "hello",
      sourceCreatedAt: "2026-05-22T00:00:00.000Z",
      senderId: "human-1",
      senderType: "human",
    });

    await ledger.transition(delivery.id, "received", { eventName: "delivery.received" });

    expect(store.deliveries.get(delivery.id)?.state).toBe("received");
    expect(store.traceEvents[0]).toMatchObject({ deliveryId: delivery.id, eventName: "delivery.received" });
  });
});
```

- [ ] **Step 2: Run failing ledger test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/delivery-ledger.test.ts
```

Expected: FAIL because `delivery-ledger.ts` does not exist.

- [ ] **Step 3: Implement delivery ledger and in-memory store**

Create `apps/bridge/src/runtime/delivery-ledger.ts`:

```ts
import { randomUUID } from "node:crypto";
import { buildDeliveryIdempotencyKey, canTransitionDelivery, type DeliveryState, type RuntimeDeliveryInput, type RuntimeDeliveryRecord, type RuntimeTraceEvent } from "./types";
import { createTraceContext, formatTraceparent } from "./trace-context";

export interface DeliveryLedgerStore {
  findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null>;
  nextDeliverySeq(workspaceId: string, agentId: string): Promise<number>;
  insertDelivery(record: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord>;
  getDelivery(id: string): Promise<RuntimeDeliveryRecord | null>;
  updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord>;
  insertTraceEvent(event: RuntimeTraceEvent): Promise<void>;
}

export class InMemoryDeliveryLedgerStore implements DeliveryLedgerStore {
  readonly deliveries = new Map<string, RuntimeDeliveryRecord>();
  readonly traceEvents: RuntimeTraceEvent[] = [];

  async findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null> {
    return [...this.deliveries.values()].find((delivery) => delivery.workspaceId === workspaceId && delivery.idempotencyKey === idempotencyKey) ?? null;
  }

  async nextDeliverySeq(workspaceId: string, agentId: string): Promise<number> {
    const seqs = [...this.deliveries.values()]
      .filter((delivery) => delivery.workspaceId === workspaceId && delivery.agentId === agentId)
      .map((delivery) => delivery.deliverySeq);
    return Math.max(0, ...seqs) + 1;
  }

  async insertDelivery(record: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    this.deliveries.set(record.id, record);
    return record;
  }

  async getDelivery(id: string): Promise<RuntimeDeliveryRecord | null> {
    return this.deliveries.get(id) ?? null;
  }

  async updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord> {
    const existing = this.deliveries.get(id);
    if (!existing) throw new Error(`Delivery not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.deliveries.set(id, updated);
    return updated;
  }

  async insertTraceEvent(event: RuntimeTraceEvent): Promise<void> {
    this.traceEvents.push(event);
  }
}

export interface DeliveryLedgerOptions {
  store: DeliveryLedgerStore;
  now?: () => string;
}

export class DeliveryLedger {
  private readonly store: DeliveryLedgerStore;
  private readonly now: () => string;

  constructor(options: DeliveryLedgerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createOrReuseDelivery(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    const idempotencyKey = buildDeliveryIdempotencyKey(input);
    const existing = await this.store.findByIdempotencyKey(input.workspaceId, idempotencyKey);
    if (existing) return { ...existing, state: "deduped" };

    const trace = createTraceContext();
    const now = this.now();
    const record: RuntimeDeliveryRecord = {
      ...input,
      id: randomUUID(),
      idempotencyKey,
      deliverySeq: await this.store.nextDeliverySeq(input.workspaceId, input.agentId),
      traceId: trace.traceId,
      spanId: trace.spanId,
      traceparent: formatTraceparent(trace),
      state: "planned",
      queueReason: null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    return this.store.insertDelivery(record);
  }

  async transition(id: string, state: DeliveryState, trace: { eventName: string; attributes?: Record<string, unknown> }): Promise<RuntimeDeliveryRecord> {
    const existing = await this.store.getDelivery(id);
    if (!existing) throw new Error(`Delivery not found: ${id}`);
    if (!canTransitionDelivery(existing.state, state)) throw new Error(`Invalid delivery transition: ${existing.state} -> ${state}`);

    const now = this.now();
    const timestampPatch = this.timestampPatch(state, now);
    const updated = await this.store.updateDelivery(id, { state, updatedAt: now, ...timestampPatch });
    await this.store.insertTraceEvent({
      id: randomUUID(),
      workspaceId: existing.workspaceId,
      traceId: existing.traceId,
      spanId: existing.spanId,
      parentSpanId: null,
      deliveryId: existing.id,
      agentId: existing.agentId,
      eventType: "delivery",
      eventName: trace.eventName,
      severity: state === "failed" ? "error" : "info",
      attributes: trace.attributes ?? {},
      createdAt: now,
    });
    return updated;
  }

  private timestampPatch(state: DeliveryState, now: string): Partial<RuntimeDeliveryRecord> {
    if (state === "received") return { updatedAt: now };
    if (state === "delivered") return { updatedAt: now };
    if (state === "accepted") return { updatedAt: now };
    if (state === "completed") return { updatedAt: now };
    if (state === "failed") return { updatedAt: now };
    return {};
  }
}
```

- [ ] **Step 4: Replace timestamp patch with DB field patches**

Update `RuntimeDeliveryRecord` in `types.ts` to include ack timestamps:

```ts
receivedAt: string | null;
deliveredAt: string | null;
acceptedAt: string | null;
completedAt: string | null;
failedAt: string | null;
```

Update record creation in `delivery-ledger.ts`:

```ts
receivedAt: null,
deliveredAt: null,
acceptedAt: null,
completedAt: null,
failedAt: null,
```

Update `timestampPatch(...)`:

```ts
private timestampPatch(state: DeliveryState, now: string): Partial<RuntimeDeliveryRecord> {
  if (state === "received") return { receivedAt: now };
  if (state === "delivered") return { deliveredAt: now };
  if (state === "accepted") return { acceptedAt: now };
  if (state === "completed") return { completedAt: now };
  if (state === "failed") return { failedAt: now };
  return {};
}
```

- [ ] **Step 5: Run ledger tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/types.test.ts src/runtime/delivery-ledger.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bridge/src/runtime/types.ts apps/bridge/src/runtime/delivery-ledger.ts apps/bridge/src/runtime/delivery-ledger.test.ts
git commit -m "feat: add daemon delivery ledger"
```

---

### Task 7: Start Coordinator

**Files:**
- Create: `apps/bridge/src/runtime/start-coordinator.ts`
- Create: `apps/bridge/src/runtime/start-coordinator.test.ts`

- [ ] **Step 1: Write failing start coordinator tests**

Create `apps/bridge/src/runtime/start-coordinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StartCoordinator } from "./start-coordinator";

describe("StartCoordinator", () => {
  it("dedupes starts for the same agent", async () => {
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    const first = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    const second = coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });

    expect(second.id).toBe(first.id);
    expect(coordinator.snapshot()).toHaveLength(1);
  });

  it("respects max concurrent starts", async () => {
    const started: string[] = [];
    const coordinator = new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-1", machineId: "machine-1", reason: "delivery" });
    coordinator.enqueue({ workspaceId: "server-1", agentId: "agent-2", machineId: "machine-1", reason: "delivery" });

    await coordinator.pump(async (entry) => {
      started.push(entry.agentId);
    });

    expect(started).toEqual(["agent-1"]);
    expect(coordinator.snapshot().map((entry) => entry.state)).toEqual(["started", "queued"]);
  });
});
```

- [ ] **Step 2: Run failing start coordinator test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/start-coordinator.test.ts
```

Expected: FAIL because `start-coordinator.ts` does not exist.

- [ ] **Step 3: Implement start coordinator**

Create `apps/bridge/src/runtime/start-coordinator.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { StartQueueEntry } from "./types";

export interface StartCoordinatorOptions {
  maxConcurrentStarts: number;
  startIntervalMs: number;
  now?: () => string;
}

export interface EnqueueStartInput {
  workspaceId: string;
  agentId: string;
  machineId: string;
  reason: string;
}

export class StartCoordinator {
  private readonly entries: StartQueueEntry[] = [];
  private readonly now: () => string;
  private activeStarts = 0;
  private lastStartAt = 0;

  constructor(private readonly options: StartCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  enqueue(input: EnqueueStartInput): StartQueueEntry {
    const dedupeKey = `${input.workspaceId}:${input.agentId}:start`;
    const existing = this.entries.find((entry) => entry.dedupeKey === dedupeKey && (entry.state === "queued" || entry.state === "starting"));
    if (existing) return existing;

    const entry: StartQueueEntry = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      machineId: input.machineId,
      reason: input.reason,
      state: "queued",
      dedupeKey,
      requestedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      lastError: null,
      metadata: {},
    };
    this.entries.push(entry);
    return entry;
  }

  async pump(starter: (entry: StartQueueEntry) => Promise<void>): Promise<void> {
    const nowMs = Date.now();
    if (this.activeStarts >= this.options.maxConcurrentStarts) return;
    if (this.lastStartAt && nowMs - this.lastStartAt < this.options.startIntervalMs) return;

    const entry = this.entries.find((candidate) => candidate.state === "queued");
    if (!entry) return;

    entry.state = "starting";
    entry.startedAt = this.now();
    this.activeStarts += 1;
    this.lastStartAt = nowMs;
    try {
      await starter(entry);
      entry.state = "started";
      entry.finishedAt = this.now();
    } catch (error) {
      entry.state = "failed";
      entry.finishedAt = this.now();
      entry.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.activeStarts -= 1;
    }
  }

  snapshot(): StartQueueEntry[] {
    return this.entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
  }
}
```

- [ ] **Step 4: Run start coordinator test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/start-coordinator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/runtime/start-coordinator.ts apps/bridge/src/runtime/start-coordinator.test.ts
git commit -m "feat: add daemon start coordinator"
```

---

### Task 8: Agent Supervisor Boundary

**Files:**
- Create: `apps/bridge/src/runtime/agent-supervisor.ts`
- Create: `apps/bridge/src/runtime/agent-supervisor.test.ts`
- Modify: `apps/bridge/src/agent-manager.ts`

- [ ] **Step 1: Write failing supervisor tests**

Create `apps/bridge/src/runtime/agent-supervisor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentSupervisor } from "./agent-supervisor";

describe("AgentSupervisor", () => {
  it("reports missing agents as stopped", () => {
    const supervisor = new AgentSupervisor();
    expect(supervisor.getState("agent-1")).toEqual({ state: "stopped", busy: false, queueDepth: 0, sessionId: null });
  });

  it("tracks busy and idle states", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markBusy("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "busy", busy: true, sessionId: "session-1" });

    supervisor.markIdle("agent-1");
    expect(supervisor.getState("agent-1")).toMatchObject({ state: "idle", busy: false, sessionId: "session-1" });
  });

  it("buffers gated deliveries in sequence order", () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markGated("agent-1");
    supervisor.bufferGatedDelivery("agent-1", "delivery-2");
    supervisor.bufferGatedDelivery("agent-1", "delivery-1");

    expect(supervisor.drainGatedDeliveries("agent-1").sort()).toEqual(["delivery-1", "delivery-2"]);
  });
});
```

- [ ] **Step 2: Run failing supervisor test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/agent-supervisor.test.ts
```

Expected: FAIL because `agent-supervisor.ts` does not exist.

- [ ] **Step 3: Implement supervisor state boundary**

Create `apps/bridge/src/runtime/agent-supervisor.ts`:

```ts
export type SupervisorAgentState = "stopped" | "starting" | "ready" | "busy" | "gated" | "idle" | "stale" | "failed";

export interface SupervisorStateSnapshot {
  state: SupervisorAgentState;
  busy: boolean;
  queueDepth: number;
  sessionId: string | null;
  processId?: number | null;
}

interface SupervisorAgentEntry {
  state: SupervisorAgentState;
  sessionId: string | null;
  processId: number | null;
  gatedDeliveryIds: string[];
}

export class AgentSupervisor {
  private readonly agents = new Map<string, SupervisorAgentEntry>();

  getState(agentId: string): SupervisorStateSnapshot {
    const entry = this.agents.get(agentId);
    if (!entry) return { state: "stopped", busy: false, queueDepth: 0, sessionId: null };
    return {
      state: entry.state,
      busy: entry.state === "busy" || entry.state === "gated" || entry.state === "starting",
      queueDepth: entry.gatedDeliveryIds.length,
      sessionId: entry.sessionId,
      processId: entry.processId,
    };
  }

  markStarting(agentId: string): void {
    this.set(agentId, { state: "starting" });
  }

  registerReady(input: { agentId: string; sessionId: string | null; processId: number | null }): void {
    this.agents.set(input.agentId, { state: "ready", sessionId: input.sessionId, processId: input.processId, gatedDeliveryIds: [] });
  }

  markBusy(agentId: string): void {
    this.set(agentId, { state: "busy" });
  }

  markGated(agentId: string): void {
    this.set(agentId, { state: "gated" });
  }

  markIdle(agentId: string): void {
    this.set(agentId, { state: "idle" });
  }

  markStale(agentId: string): void {
    this.set(agentId, { state: "stale" });
  }

  markFailed(agentId: string): void {
    this.set(agentId, { state: "failed" });
  }

  bufferGatedDelivery(agentId: string, deliveryId: string): void {
    const entry = this.ensure(agentId);
    if (!entry.gatedDeliveryIds.includes(deliveryId)) entry.gatedDeliveryIds.push(deliveryId);
  }

  drainGatedDeliveries(agentId: string): string[] {
    const entry = this.ensure(agentId);
    const deliveryIds = [...entry.gatedDeliveryIds];
    entry.gatedDeliveryIds = [];
    return deliveryIds;
  }

  private set(agentId: string, patch: Partial<SupervisorAgentEntry>): void {
    const entry = this.ensure(agentId);
    this.agents.set(agentId, { ...entry, ...patch });
  }

  private ensure(agentId: string): SupervisorAgentEntry {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const entry: SupervisorAgentEntry = { state: "stopped", sessionId: null, processId: null, gatedDeliveryIds: [] };
    this.agents.set(agentId, entry);
    return entry;
  }
}
```

- [ ] **Step 4: Add AgentManager driver hooks without changing old delivery behavior**

Modify `apps/bridge/src/agent-manager.ts` by exporting process state methods near `sendToAgent(...)`:

```ts
getRuntimeAgentState(agentId: string) {
  const agentProc = this.processes.get(agentId);
  if (!agentProc || agentProc.proc.killed || agentProc.proc.exitCode !== null) {
    return { state: "stopped" as const, busy: false, queueDepth: 0, sessionId: null, processId: null };
  }
  return {
    state: agentProc.busy ? "busy" as const : "ready" as const,
    busy: agentProc.busy,
    queueDepth: agentProc.messageQueue.length,
    sessionId: agentProc.sessionId,
    processId: agentProc.proc.pid ?? null,
  };
}

async deliverRuntimeMessage(agentId: string, prompt: string): Promise<void> {
  await this.sendToAgent(agentId, prompt);
}
```

- [ ] **Step 5: Run supervisor tests and bridge build**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/agent-supervisor.test.ts
pnpm --filter @fehey/zano-bridge build
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bridge/src/runtime/agent-supervisor.ts apps/bridge/src/runtime/agent-supervisor.test.ts apps/bridge/src/agent-manager.ts
git commit -m "feat: add daemon agent supervisor boundary"
```

---

### Task 9: Delivery Runtime State Machine

**Files:**
- Create: `apps/bridge/src/runtime/delivery-runtime.ts`
- Create: `apps/bridge/src/runtime/delivery-runtime.test.ts`

- [ ] **Step 1: Write failing delivery runtime tests**

Create `apps/bridge/src/runtime/delivery-runtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentSupervisor } from "./agent-supervisor";
import { DeliveryLedger, InMemoryDeliveryLedgerStore } from "./delivery-ledger";
import { DeliveryRuntime } from "./delivery-runtime";
import { StartCoordinator } from "./start-coordinator";

function input(overrides = {}) {
  return {
    workspaceId: "server-1",
    agentId: "agent-1",
    channelId: "channel-1",
    sourceMessageId: "msg-1",
    threadParentId: null,
    taskId: null,
    target: "#general",
    activationReasons: ["channel_broadcast"],
    activationStrength: "medium" as const,
    prompt: "hello",
    sourceCreatedAt: "2026-05-22T00:00:00.000Z",
    senderId: "human-1",
    senderType: "human" as const,
    ...overrides,
  };
}

describe("DeliveryRuntime", () => {
  it("queues delivery when agent is stopped and enqueues start", async () => {
    const store = new InMemoryDeliveryLedgerStore();
    const runtime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store, now: () => "2026-05-22T00:00:00.000Z" }),
      supervisor: new AgentSupervisor(),
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" }),
      driver: { deliver: async () => undefined },
      machineId: "machine-1",
    });

    const result = await runtime.accept(input());

    expect(result.state).toBe("queued_starting");
    expect(runtime.startQueueSnapshot()).toHaveLength(1);
  });

  it("delivers immediately when agent is ready", async () => {
    const delivered: string[] = [];
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    const runtime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore(), now: () => "2026-05-22T00:00:00.000Z" }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" }),
      driver: { deliver: async (_agentId, prompt) => { delivered.push(prompt); } },
      machineId: "machine-1",
    });

    const result = await runtime.accept(input());

    expect(result.state).toBe("accepted");
    expect(delivered[0]).toContain("delivery=");
    expect(delivered[0]).toContain("traceparent=");
  });

  it("queues busy agents as gated deliveries", async () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerReady({ agentId: "agent-1", sessionId: "session-1", processId: 123 });
    supervisor.markBusy("agent-1");
    const runtime = new DeliveryRuntime({
      ledger: new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore(), now: () => "2026-05-22T00:00:00.000Z" }),
      supervisor,
      startCoordinator: new StartCoordinator({ maxConcurrentStarts: 1, startIntervalMs: 0, now: () => "2026-05-22T00:00:00.000Z" }),
      driver: { deliver: async () => undefined },
      machineId: "machine-1",
    });

    const result = await runtime.accept(input());

    expect(result.state).toBe("queued_gated");
    expect(supervisor.getState("agent-1").queueDepth).toBe(1);
  });
});
```

- [ ] **Step 2: Run failing runtime test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/delivery-runtime.test.ts
```

Expected: FAIL because `delivery-runtime.ts` does not exist.

- [ ] **Step 3: Implement delivery runtime**

Create `apps/bridge/src/runtime/delivery-runtime.ts`:

```ts
import type { AgentSupervisor } from "./agent-supervisor";
import type { DeliveryLedger } from "./delivery-ledger";
import type { StartCoordinator } from "./start-coordinator";
import type { RuntimeDeliveryInput, RuntimeDeliveryRecord } from "./types";

export interface RuntimeAgentDriver {
  deliver(agentId: string, prompt: string): Promise<void>;
}

export interface DeliveryRuntimeOptions {
  ledger: DeliveryLedger;
  supervisor: AgentSupervisor;
  startCoordinator: StartCoordinator;
  driver: RuntimeAgentDriver;
  machineId: string;
}

export class DeliveryRuntime {
  constructor(private readonly options: DeliveryRuntimeOptions) {}

  async accept(input: RuntimeDeliveryInput): Promise<RuntimeDeliveryRecord> {
    const delivery = await this.options.ledger.createOrReuseDelivery(input);
    if (delivery.state === "deduped") return delivery;

    await this.options.ledger.transition(delivery.id, "received", { eventName: "delivery.received" });
    const state = this.options.supervisor.getState(delivery.agentId);

    if (state.state === "stopped" || state.state === "stale" || state.state === "failed" || state.state === "starting") {
      this.options.startCoordinator.enqueue({
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        machineId: this.options.machineId,
        reason: "delivery",
      });
      return this.options.ledger.transition(delivery.id, "queued_starting", { eventName: "delivery.queued_starting" });
    }

    if (state.busy) {
      this.options.supervisor.markGated(delivery.agentId);
      this.options.supervisor.bufferGatedDelivery(delivery.agentId, delivery.id);
      return this.options.ledger.transition(delivery.id, "queued_gated", { eventName: "delivery.queued_gated" });
    }

    return this.deliverNow(delivery);
  }

  async deliverNow(delivery: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    await this.options.ledger.transition(delivery.id, "delivering", { eventName: "delivery.delivering" });
    await this.options.driver.deliver(delivery.agentId, this.withDeliveryHeader(delivery));
    await this.options.ledger.transition(delivery.id, "delivered", { eventName: "delivery.delivered" });
    return this.options.ledger.transition(delivery.id, "accepted", { eventName: "delivery.accepted" });
  }

  startQueueSnapshot() {
    return this.options.startCoordinator.snapshot();
  }

  private withDeliveryHeader(delivery: RuntimeDeliveryRecord): string {
    const shortDeliveryId = delivery.id.replace(/-/g, "").slice(0, 8);
    return delivery.prompt.replace(/^\[target=/, `[delivery=${shortDeliveryId} seq=${delivery.deliverySeq} traceparent=${delivery.traceparent} target=`);
  }
}
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/delivery-runtime.test.ts src/runtime/delivery-ledger.test.ts src/runtime/start-coordinator.test.ts src/runtime/agent-supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/runtime/delivery-runtime.ts apps/bridge/src/runtime/delivery-runtime.test.ts
git commit -m "feat: add daemon delivery runtime"
```

---

### Task 10: Bridge Runtime Integration Behind `ZANO_DAEMON_V2`

**Files:**
- Modify: `apps/bridge/src/bridge.ts`
- Modify: `apps/bridge/src/index.ts`
- Modify: `apps/bridge/src/agent-manager.ts`
- Create: `apps/bridge/src/bridge-runtime.test.ts`

- [ ] **Step 1: Write integration tests for v2 delivery submission**

Create `apps/bridge/src/bridge-runtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRuntimeDeliveryInput } from "./bridge";

describe("buildRuntimeDeliveryInput", () => {
  it("converts routing deliveries to runtime inputs", () => {
    const result = buildRuntimeDeliveryInput({
      workspaceId: "server-1",
      msg: {
        id: "msg-1",
        channel_id: "channel-1",
        sender_id: "human-1",
        sender_type: "human",
        content: "continue",
        thread_parent_id: null,
        created_at: "2026-05-22T00:00:00.000Z",
      },
      delivery: {
        candidate: { agentId: "agent-1", strength: "medium", reasons: ["channel_broadcast"] },
        agent: { id: "agent-1", name: "alpha", display_name: "Alpha", description: null, system_prompt: null, model: "opus", status: "online" },
        prompt: "[target=#general msg=msg1 time=2026-05-22T00:00:00.000Z sender=@Human type=human] continue",
      },
      target: "#general",
      taskId: null,
    });

    expect(result).toMatchObject({
      workspaceId: "server-1",
      agentId: "agent-1",
      sourceMessageId: "msg-1",
      target: "#general",
      activationReasons: ["channel_broadcast"],
      activationStrength: "medium",
    });
  });
});
```

- [ ] **Step 2: Run failing integration test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/bridge-runtime.test.ts
```

Expected: FAIL because `buildRuntimeDeliveryInput` is not exported.

- [ ] **Step 3: Export bridge routing types and runtime input helper**

Modify `apps/bridge/src/bridge.ts` so these interfaces are exported:

```ts
export interface DbMessage { ... }
export interface DbAgent { ... }
export interface RoutingDelivery { ... }
```

Add this exported helper near the routing types:

```ts
import type { RuntimeDeliveryInput } from "./runtime/types";

export function buildRuntimeDeliveryInput(input: {
  workspaceId: string;
  msg: DbMessage;
  delivery: RoutingDelivery;
  target: string;
  taskId: string | null;
}): RuntimeDeliveryInput {
  return {
    workspaceId: input.workspaceId,
    agentId: input.delivery.candidate.agentId,
    channelId: input.msg.channel_id,
    sourceMessageId: input.msg.id,
    threadParentId: input.msg.thread_parent_id,
    taskId: input.taskId,
    target: input.target,
    activationReasons: input.delivery.candidate.reasons,
    activationStrength: input.delivery.candidate.strength,
    prompt: input.delivery.prompt,
    sourceCreatedAt: input.msg.created_at,
    senderId: input.msg.sender_id,
    senderType: input.msg.sender_type,
  };
}
```

- [ ] **Step 4: Instantiate runtime in bridge constructor when enabled**

Add fields to `Bridge`:

```ts
private deliveryRuntime: DeliveryRuntime | null = null;
private daemonV2Enabled = process.env.ZANO_DAEMON_V2 === "1";
```

Add imports:

```ts
import { AgentSupervisor, DeliveryLedger, DeliveryRuntime, InMemoryDeliveryLedgerStore, StartCoordinator } from "./runtime";
```

In the constructor after `AgentManager` creation, add:

```ts
if (this.daemonV2Enabled) {
  const supervisor = new AgentSupervisor();
  this.deliveryRuntime = new DeliveryRuntime({
    ledger: new DeliveryLedger({ store: new InMemoryDeliveryLedgerStore() }),
    supervisor,
    startCoordinator: new StartCoordinator({ maxConcurrentStarts: 2, startIntervalMs: 1_000 }),
    driver: { deliver: (agentId, prompt) => this.agentManager.deliverRuntimeMessage(agentId, prompt) },
    machineId: config.hostname ? `${config.hostname}-${config.serverId.slice(0, 8)}` : `machine-${config.serverId.slice(0, 8)}`,
  });
}
```

This uses the in-memory store for the first bridge integration. Task 11 replaces it with the Supabase store.

- [ ] **Step 5: Route executor through runtime when v2 is enabled**

Modify `executeRoutingPlan(...)` in `apps/bridge/src/bridge.ts`:

```ts
private async executeRoutingPlan(plan: RoutingPlan) {
  const results = await Promise.allSettled(
    plan.deliveries.map(async (delivery) => {
      console.log(
        `  [${delivery.agent.display_name}] A2A activated (${delivery.candidate.strength}:${delivery.candidate.reasons.join("+")}): "${plan.msg.content.substring(0, 60)}${plan.msg.content.length > 60 ? "..." : ""}"`
      );

      if (this.deliveryRuntime) {
        await this.deliveryRuntime.accept(buildRuntimeDeliveryInput({
          workspaceId: this.config.serverId,
          msg: plan.msg,
          delivery,
          target: this.buildChannelTarget(plan.msg.channel_id, undefined, plan.msg.thread_parent_id),
          taskId: null,
        }));
        return;
      }

      await this.agentManager.sendToAgent(delivery.candidate.agentId, delivery.prompt);
    }),
  );

  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    const delivery = plan.deliveries[index];
    console.error(
      `  [${delivery.agent.display_name}] Error:`,
      result.reason instanceof Error ? result.reason.message : result.reason
    );
  }
}
```

- [ ] **Step 6: Run bridge tests and build**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/bridge-runtime.test.ts src/a2a-protocol.test.ts
pnpm --filter @fehey/zano-bridge build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bridge/src/bridge.ts apps/bridge/src/index.ts apps/bridge/src/agent-manager.ts apps/bridge/src/bridge-runtime.test.ts
git commit -m "feat: route bridge deliveries through daemon runtime"
```

---

### Task 11: Supabase Ledger Store and Recovery Query

**Files:**
- Modify: `apps/bridge/src/runtime/delivery-ledger.ts`
- Modify: `apps/bridge/src/runtime/delivery-ledger.test.ts`
- Modify: `apps/bridge/src/bridge.ts`

- [ ] **Step 1: Add store contract tests for row mapping**

Append to `apps/bridge/src/runtime/delivery-ledger.test.ts`:

```ts
import { mapDeliveryRow, mapDeliveryRecordToInsert } from "./delivery-ledger";

it("maps delivery records to daemon_deliveries rows", () => {
  const record = {
    id: "delivery-1",
    workspaceId: "server-1",
    agentId: "agent-1",
    channelId: "channel-1",
    sourceMessageId: "msg-1",
    threadParentId: null,
    taskId: null,
    deliverySeq: 1,
    idempotencyKey: "key",
    traceId: "trace",
    spanId: "span",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    target: "#general",
    activationReasons: ["channel_broadcast"],
    activationStrength: "medium" as const,
    prompt: "hello",
    sourceCreatedAt: "2026-05-22T00:00:00.000Z",
    senderId: "human-1",
    senderType: "human" as const,
    state: "planned" as const,
    queueReason: null,
    attempts: 0,
    lastError: null,
    receivedAt: null,
    deliveredAt: null,
    acceptedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };

  expect(mapDeliveryRecordToInsert(record)).toMatchObject({
    workspace_id: "server-1",
    agent_id: "agent-1",
    source_message_id: "msg-1",
    delivery_seq: 1,
    idempotency_key: "key",
  });
});
```

- [ ] **Step 2: Run failing mapping test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/delivery-ledger.test.ts
```

Expected: FAIL because mapping helpers do not exist.

- [ ] **Step 3: Add Supabase row mappers and store**

Append to `apps/bridge/src/runtime/delivery-ledger.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export function mapDeliveryRecordToInsert(record: RuntimeDeliveryRecord) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    agent_id: record.agentId,
    channel_id: record.channelId,
    source_message_id: record.sourceMessageId,
    thread_parent_id: record.threadParentId,
    task_id: record.taskId,
    delivery_seq: record.deliverySeq,
    idempotency_key: record.idempotencyKey,
    trace_id: record.traceId,
    span_id: record.spanId,
    traceparent: record.traceparent,
    target: record.target,
    activation_strength: record.activationStrength,
    activation_reasons: record.activationReasons,
    state: record.state,
    queue_reason: record.queueReason,
    attempts: record.attempts,
    last_error: record.lastError,
    received_at: record.receivedAt,
    delivered_at: record.deliveredAt,
    accepted_at: record.acceptedAt,
    completed_at: record.completedAt,
    failed_at: record.failedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function mapDeliveryRow(row: Record<string, unknown>): RuntimeDeliveryRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    agentId: row.agent_id as string,
    channelId: row.channel_id as string,
    sourceMessageId: row.source_message_id as string,
    threadParentId: row.thread_parent_id as string | null,
    taskId: row.task_id as string | null,
    deliverySeq: Number(row.delivery_seq),
    idempotencyKey: row.idempotency_key as string,
    traceId: row.trace_id as string,
    spanId: row.span_id as string,
    traceparent: row.traceparent as string,
    target: row.target as string,
    activationStrength: row.activation_strength as "strong" | "medium" | "weak",
    activationReasons: row.activation_reasons as string[],
    state: row.state as DeliveryState,
    queueReason: row.queue_reason as RuntimeDeliveryRecord["queueReason"],
    attempts: Number(row.attempts),
    lastError: row.last_error as string | null,
    prompt: "",
    sourceCreatedAt: row.created_at as string,
    senderId: "",
    senderType: "system",
    receivedAt: row.received_at as string | null,
    deliveredAt: row.delivered_at as string | null,
    acceptedAt: row.accepted_at as string | null,
    completedAt: row.completed_at as string | null,
    failedAt: row.failed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SupabaseDeliveryLedgerStore implements DeliveryLedgerStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<RuntimeDeliveryRecord | null> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapDeliveryRow(data) : null;
  }

  async nextDeliverySeq(workspaceId: string, agentId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .select("delivery_seq")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("delivery_seq", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return Number(data?.[0]?.delivery_seq ?? 0) + 1;
  }

  async insertDelivery(record: RuntimeDeliveryRecord): Promise<RuntimeDeliveryRecord> {
    const { data, error } = await this.supabase
      .from("daemon_deliveries")
      .insert(mapDeliveryRecordToInsert(record))
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapDeliveryRow(data);
  }

  async getDelivery(id: string): Promise<RuntimeDeliveryRecord | null> {
    const { data, error } = await this.supabase.from("daemon_deliveries").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapDeliveryRow(data) : null;
  }

  async updateDelivery(id: string, patch: Partial<RuntimeDeliveryRecord>): Promise<RuntimeDeliveryRecord> {
    const rowPatch = mapDeliveryPatch(patch);
    const { data, error } = await this.supabase.from("daemon_deliveries").update(rowPatch).eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return mapDeliveryRow(data);
  }

  async insertTraceEvent(event: RuntimeTraceEvent): Promise<void> {
    const { error } = await this.supabase.from("daemon_trace_events").insert({
      id: event.id,
      workspace_id: event.workspaceId,
      trace_id: event.traceId,
      span_id: event.spanId,
      parent_span_id: event.parentSpanId,
      delivery_id: event.deliveryId,
      agent_id: event.agentId,
      event_type: event.eventType,
      event_name: event.eventName,
      severity: event.severity,
      attributes: event.attributes,
      created_at: event.createdAt,
    });
    if (error) throw new Error(error.message);
  }
}

function mapDeliveryPatch(patch: Partial<RuntimeDeliveryRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.state) row.state = patch.state;
  if (patch.queueReason !== undefined) row.queue_reason = patch.queueReason;
  if (patch.attempts !== undefined) row.attempts = patch.attempts;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.receivedAt !== undefined) row.received_at = patch.receivedAt;
  if (patch.deliveredAt !== undefined) row.delivered_at = patch.deliveredAt;
  if (patch.acceptedAt !== undefined) row.accepted_at = patch.acceptedAt;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
  if (patch.failedAt !== undefined) row.failed_at = patch.failedAt;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  return row;
}
```

- [ ] **Step 4: Use Supabase store in bridge v2 runtime**

Modify the runtime imports in `apps/bridge/src/bridge.ts`:

```ts
import { AgentSupervisor, DeliveryLedger, DeliveryRuntime, StartCoordinator, SupabaseDeliveryLedgerStore } from "./runtime";
```

Replace `new InMemoryDeliveryLedgerStore()` with:

```ts
new SupabaseDeliveryLedgerStore(this.supabase)
```

- [ ] **Step 5: Run ledger tests and bridge build**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/delivery-ledger.test.ts src/bridge-runtime.test.ts
pnpm --filter @fehey/zano-bridge build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bridge/src/runtime/delivery-ledger.ts apps/bridge/src/runtime/delivery-ledger.test.ts apps/bridge/src/bridge.ts
git commit -m "feat: persist daemon deliveries in supabase"
```

---

### Task 12: CLI Daemon Inspection and Delivery Context

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add daemon command helpers**

In `packages/cli/src/index.ts`, add this after `decodeJwtClaims(...)`:

```ts
const DELIVERY_ID = process.env.ZANO_DELIVERY_ID;
const DELIVERY_SEQ = process.env.ZANO_DELIVERY_SEQ;
const TRACEPARENT = process.env.ZANO_TRACEPARENT;

function deliveryContextMetadata(): JsonObject {
  return {
    ...(DELIVERY_ID ? { delivery_id: DELIVERY_ID } : {}),
    ...(DELIVERY_SEQ ? { delivery_seq: Number(DELIVERY_SEQ) } : {}),
    ...(TRACEPARENT ? { traceparent: TRACEPARENT } : {}),
  };
}
```

- [ ] **Step 2: Add daemon command implementations**

Add near the other command functions:

```ts
async function cmdDaemonStatus() {
  const { data: deliveries, error: deliveryError } = await actorSupabase
    .from("daemon_deliveries")
    .select("id,state,agent_id,delivery_seq,updated_at")
    .order("updated_at", { ascending: false })
    .limit(10);
  if (deliveryError) fail("DAEMON_STATUS_FAILED", deliveryError.message);

  const { data: sessions, error: sessionError } = await actorSupabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,state,machine_id,session_id,last_active_at")
    .order("started_at", { ascending: false })
    .limit(10);
  if (sessionError) fail("DAEMON_STATUS_FAILED", sessionError.message);

  console.log(JSON.stringify({ ok: true, deliveries: deliveries ?? [], sessions: sessions ?? [] }, null, 2));
}

async function cmdDaemonDeliveries(flags: Record<string, string>) {
  let query = actorSupabase
    .from("daemon_deliveries")
    .select("id,agent_id,source_message_id,state,delivery_seq,traceparent,target,last_error,updated_at")
    .order("updated_at", { ascending: false })
    .limit(Number(flags.limit ?? 20));
  if (flags.agent) query = query.eq("agent_id", flags.agent);
  if (flags.state) query = query.eq("state", flags.state);
  if (flags.message) query = query.eq("source_message_id", flags.message);

  const { data, error } = await query;
  if (error) fail("DAEMON_DELIVERIES_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, deliveries: data ?? [] }, null, 2));
}

async function cmdDaemonTraces(flags: Record<string, string>) {
  const traceId = flags.trace;
  if (!traceId) fail("INVALID_ARG", "Missing --trace");
  const { data, error } = await actorSupabase
    .from("daemon_trace_events")
    .select("trace_id,span_id,delivery_id,agent_id,event_type,event_name,severity,attributes,created_at")
    .eq("trace_id", traceId)
    .order("created_at", { ascending: true });
  if (error) fail("DAEMON_TRACES_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, events: data ?? [] }, null, 2));
}

async function cmdAgentSessions(flags: Record<string, string>) {
  const agentId = flags.agent ?? REQUIRED_AGENT_ID;
  const { data, error } = await actorSupabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,machine_id,runtime,runtime_model,session_id,process_id,state,prompt_hash,wrapper_hash,started_at,last_active_at,idle_at,ended_at,last_error")
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(Number(flags.limit ?? 20));
  if (error) fail("AGENT_SESSIONS_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, sessions: data ?? [] }, null, 2));
}

async function cmdAgentLocalState() {
  const localState = process.env.ZANO_AGENT_LOCAL_STATE ?? null;
  console.log(JSON.stringify({ ok: true, localState }, null, 2));
}
```

- [ ] **Step 3: Dispatch daemon and agent commands**

Modify `main()` before the existing `if (group === "agent" && action === "blueprint")` block:

```ts
if (group === "daemon") {
  switch (action) {
    case "status":
      return cmdDaemonStatus();
    case "deliveries":
      return cmdDaemonDeliveries(flags);
    case "traces":
      return cmdDaemonTraces(flags);
  }
}

if (group === "agent" && action === "sessions") {
  return cmdAgentSessions(flags);
}

if (group === "agent" && action === "local-state") {
  return cmdAgentLocalState();
}
```

- [ ] **Step 4: Attach delivery context to message metadata**

In `cmdMessageSend(...)` and `cmdThreadReply(...)`, merge delivery context into the inserted message metadata if the current insert includes a metadata object. If the current message insert has no metadata column, add activity/event metadata only by merging `deliveryContextMetadata()` into existing activity event metadata in the command.

Use this exact merge expression wherever metadata is written:

```ts
metadata: {
  ...existingMetadata,
  daemon: deliveryContextMetadata(),
}
```

If there is no `existingMetadata` variable in that function, define:

```ts
const existingMetadata: JsonObject = {};
```

- [ ] **Step 5: Update CLI help**

Add these lines to the usage text:

```text
  zano daemon status                       Show daemon delivery/session status
  zano daemon deliveries [--agent UUID]    List daemon deliveries
  zano daemon traces --trace TRACE_ID      Show daemon trace events
  zano agent sessions [--agent UUID]       List runtime sessions
  zano agent local-state                   Show local runtime state path
```

Add environment lines:

```text
  ZANO_DELIVERY_ID     Current daemon delivery id, set by bridge runtime
  ZANO_DELIVERY_SEQ    Current per-agent delivery sequence
  ZANO_TRACEPARENT     Current daemon traceparent
```

- [ ] **Step 6: Build CLI**

Run:

```bash
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat: add daemon inspection cli commands"
```

---

### Task 13: Web Delivery Observability

**Files:**
- Create: `apps/web/src/app/api/daemon/deliveries/route.ts`
- Create: `apps/web/src/app/api/daemon/sessions/route.ts`
- Create: `apps/web/src/components/message-delivery-drawer.tsx`
- Modify: `apps/web/src/components/message-area.tsx`
- Modify: `apps/web/src/components/member-activity-tab.tsx`

- [ ] **Step 1: Add delivery API route**

Create `apps/web/src/app/api/daemon/deliveries/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const messageId = searchParams.get("messageId");
  const agentId = searchParams.get("agentId");

  let query = supabase
    .from("daemon_deliveries")
    .select("id,agent_id,source_message_id,state,delivery_seq,trace_id,traceparent,target,activation_strength,activation_reasons,last_error,updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (messageId) query = query.eq("source_message_id", messageId);
  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deliveries: data ?? [] });
}
```

- [ ] **Step 2: Add sessions API route**

Create `apps/web/src/app/api/daemon/sessions/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agentId");

  let query = supabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,machine_id,runtime,runtime_model,session_id,process_id,state,prompt_hash,wrapper_hash,started_at,last_active_at,idle_at,ended_at,last_error")
    .order("started_at", { ascending: false })
    .limit(20);

  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}
```

- [ ] **Step 3: Add delivery drawer component**

Create `apps/web/src/components/message-delivery-drawer.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface DeliveryRow {
  id: string;
  agent_id: string;
  source_message_id: string;
  state: string;
  delivery_seq: number;
  trace_id: string;
  traceparent: string;
  target: string;
  activation_strength: string;
  activation_reasons: string[];
  last_error: string | null;
  updated_at: string;
}

export function MessageDeliveryDrawer({ messageId, open, onClose }: { messageId: string | null; open: boolean; onClose: () => void }) {
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !messageId) return;
    setLoading(true);
    fetch(`/api/daemon/deliveries?messageId=${encodeURIComponent(messageId)}`)
      .then((res) => res.json())
      .then((body: { deliveries?: DeliveryRow[] }) => setDeliveries(body.deliveries ?? []))
      .finally(() => setLoading(false));
  }, [messageId, open]);

  if (!open || !messageId) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[420px] border-l border-border bg-background p-4 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Daemon deliveries</h2>
          <p className="text-xs text-muted-foreground">Message {messageId.slice(0, 8)}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      <div className="space-y-3">
        {deliveries.map((delivery) => (
          <div key={delivery.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-medium">Agent {delivery.agent_id.slice(0, 8)}</span>
              <Badge variant={delivery.state === "failed" ? "destructive" : "secondary"}>{delivery.state}</Badge>
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div>seq={delivery.delivery_seq}</div>
              <div>target={delivery.target}</div>
              <div>trace={delivery.trace_id}</div>
              <div>reasons={delivery.activation_reasons.join("+")}</div>
              {delivery.last_error ? <div className="text-destructive">{delivery.last_error}</div> : null}
            </div>
          </div>
        ))}
        {!loading && deliveries.length === 0 ? <p className="text-sm text-muted-foreground">No daemon deliveries recorded.</p> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire drawer into message area**

Modify `apps/web/src/components/message-area.tsx` imports:

```tsx
import { MessageDeliveryDrawer } from "./message-delivery-drawer";
```

Add state inside `MessageArea`:

```tsx
const [deliveryMessageId, setDeliveryMessageId] = useState<string | null>(null);
```

Add a button in each message action row near `MessageActionMenu`:

```tsx
<Button size="xs" variant="ghost" onClick={() => setDeliveryMessageId(message.id)}>
  Deliveries
</Button>
```

Add the drawer near the bottom of the returned JSX:

```tsx
<MessageDeliveryDrawer
  messageId={deliveryMessageId}
  open={Boolean(deliveryMessageId)}
  onClose={() => setDeliveryMessageId(null)}
/>
```

- [ ] **Step 5: Add runtime sessions to member activity tab**

In `apps/web/src/components/member-activity-tab.tsx`, add state inside `MemberActivityTab`:

```tsx
const [runtimeSessions, setRuntimeSessions] = useState<Array<{ id: string; state: string; machine_id: string; session_id: string | null; prompt_hash: string; last_active_at: string | null }>>([]);
```

Add an effect after state declarations:

```tsx
useEffect(() => {
  if (memberType !== "agent") return;
  fetch(`/api/daemon/sessions?agentId=${encodeURIComponent(memberId)}`)
    .then((res) => res.json())
    .then((body: { sessions?: Array<{ id: string; state: string; machine_id: string; session_id: string | null; prompt_hash: string; last_active_at: string | null }> }) => {
      setRuntimeSessions(body.sessions ?? []);
    });
}, [memberId, memberType]);
```

Add a runtime card above the activity timeline:

```tsx
{memberType === "agent" ? (
  <Card>
    <CardContent className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Daemon runtime</div>
        <Badge variant="secondary">{runtimeSessions[0]?.state ?? "unknown"}</Badge>
      </div>
      {runtimeSessions[0] ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>machine={runtimeSessions[0].machine_id}</div>
          <div>session={runtimeSessions[0].session_id?.slice(0, 8) ?? "none"}</div>
          <div>prompt={runtimeSessions[0].prompt_hash.slice(0, 8)}</div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No daemon runtime session recorded.</div>
      )}
    </CardContent>
  </Card>
) : null}
```

- [ ] **Step 6: Build web app**

Run:

```bash
pnpm --filter @zano/web build
```

Expected: PASS.

- [ ] **Step 7: Browser smoke the UI**

Run:

```bash
pnpm dev:web
```

Open a local browser session to a workspace channel, click a message's `Deliveries` button, and verify the drawer opens. Open an agent member page and verify the daemon runtime card renders. If the local web app requires authentication, use the user's existing authenticated browser profile.

Expected: drawer and runtime card render without client errors. If the daemon tables are not applied yet, the API should return an error response and the UI should still avoid a crash.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/api/daemon/deliveries/route.ts apps/web/src/app/api/daemon/sessions/route.ts apps/web/src/components/message-delivery-drawer.tsx apps/web/src/components/message-area.tsx apps/web/src/components/member-activity-tab.tsx
git commit -m "feat: add daemon delivery observability ui"
```

---

### Task 14: Runtime Session Persistence and Materialized Startup

**Files:**
- Create: `apps/bridge/src/runtime/session-ledger.ts`
- Create: `apps/bridge/src/runtime/session-ledger.test.ts`
- Modify: `apps/bridge/src/runtime/agent-supervisor.ts`
- Modify: `apps/bridge/src/runtime/delivery-runtime.ts`
- Modify: `apps/bridge/src/agent-manager.ts`
- Modify: `apps/bridge/src/bridge.ts`

- [ ] **Step 1: Write failing session ledger tests**

Create `apps/bridge/src/runtime/session-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeSessionStore, RuntimeSessionLedger, mapRuntimeSessionRecordToInsert } from "./session-ledger";

describe("RuntimeSessionLedger", () => {
  it("creates runtime session records", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });

    const session = await ledger.startSession({
      workspaceId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      runtimeModel: "opus",
      sessionId: null,
      processId: 123,
      promptHash: "a".repeat(64),
      wrapperHash: "b".repeat(64),
    });

    expect(session.state).toBe("starting");
    expect(store.sessions.get(session.id)).toMatchObject({ agentId: "agent-1", processId: 123 });
  });

  it("updates runtime session state", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const ledger = new RuntimeSessionLedger({ store, now: () => "2026-05-22T00:00:00.000Z" });
    const session = await ledger.startSession({
      workspaceId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      runtimeModel: "opus",
      sessionId: null,
      processId: 123,
      promptHash: "a".repeat(64),
      wrapperHash: "b".repeat(64),
    });

    const ready = await ledger.updateState(session.id, "ready", { sessionId: "claude-session-1" });

    expect(ready).toMatchObject({ state: "ready", sessionId: "claude-session-1" });
  });

  it("maps runtime session records to database rows", () => {
    expect(mapRuntimeSessionRecordToInsert({
      id: "runtime-1",
      workspaceId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      runtime: "claude-code",
      runtimeModel: "opus",
      sessionId: "session-1",
      processId: 123,
      state: "ready",
      promptHash: "a".repeat(64),
      wrapperHash: "b".repeat(64),
      startedAt: "2026-05-22T00:00:00.000Z",
      lastActiveAt: "2026-05-22T00:00:00.000Z",
      idleAt: null,
      endedAt: null,
      lastError: null,
      metadata: { safe: true },
    })).toMatchObject({
      workspace_id: "server-1",
      agent_id: "agent-1",
      machine_id: "machine-1",
      runtime: "claude-code",
      state: "ready",
      prompt_hash: "a".repeat(64),
    });
  });
});
```

- [ ] **Step 2: Run failing session ledger test**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/session-ledger.test.ts
```

Expected: FAIL because `session-ledger.ts` does not exist.

- [ ] **Step 3: Implement runtime session ledger**

Create `apps/bridge/src/runtime/session-ledger.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeSessionRecord, RuntimeSessionState } from "./types";

export interface RuntimeSessionStartInput {
  workspaceId: string;
  agentId: string;
  machineId: string;
  runtimeModel: string | null;
  sessionId: string | null;
  processId: number | null;
  promptHash: string;
  wrapperHash: string | null;
}

export interface RuntimeSessionStore {
  insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord>;
  updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord>;
  latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null>;
}

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  readonly sessions = new Map<string, RuntimeSessionRecord>();

  async insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    this.sessions.set(record.id, record);
    return record;
  }

  async updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`Runtime session not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.sessions.set(id, updated);
    return updated;
  }

  async latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId && session.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }
}

export class RuntimeSessionLedger {
  private readonly now: () => string;

  constructor(private readonly options: { store: RuntimeSessionStore; now?: () => string }) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async startSession(input: RuntimeSessionStartInput): Promise<RuntimeSessionRecord> {
    const now = this.now();
    return this.options.store.insertSession({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      machineId: input.machineId,
      runtime: "claude-code",
      runtimeModel: input.runtimeModel,
      sessionId: input.sessionId,
      processId: input.processId,
      state: "starting",
      promptHash: input.promptHash,
      wrapperHash: input.wrapperHash,
      startedAt: now,
      lastActiveAt: now,
      idleAt: null,
      endedAt: null,
      lastError: null,
      metadata: {},
    });
  }

  async updateState(id: string, state: RuntimeSessionState, patch: Partial<RuntimeSessionRecord> = {}): Promise<RuntimeSessionRecord> {
    const now = this.now();
    return this.options.store.updateSession(id, {
      ...patch,
      state,
      lastActiveAt: state === "ready" || state === "busy" || state === "gated" ? now : patch.lastActiveAt,
      idleAt: state === "idle" ? now : patch.idleAt,
      endedAt: state === "ended" || state === "failed" ? now : patch.endedAt,
    });
  }

  latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    return this.options.store.latestForAgent(workspaceId, agentId);
  }
}

export function mapRuntimeSessionRecordToInsert(record: RuntimeSessionRecord) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    agent_id: record.agentId,
    machine_id: record.machineId,
    runtime: record.runtime,
    runtime_model: record.runtimeModel,
    session_id: record.sessionId,
    process_id: record.processId,
    state: record.state,
    prompt_hash: record.promptHash,
    wrapper_hash: record.wrapperHash,
    started_at: record.startedAt,
    last_active_at: record.lastActiveAt,
    idle_at: record.idleAt,
    ended_at: record.endedAt,
    last_error: record.lastError,
    metadata: record.metadata,
  };
}

export class SupabaseRuntimeSessionStore implements RuntimeSessionStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async insertSession(record: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    const { error } = await this.supabase.from("daemon_runtime_sessions").insert(mapRuntimeSessionRecordToInsert(record));
    if (error) throw new Error(error.message);
    return record;
  }

  async updateSession(id: string, patch: Partial<RuntimeSessionRecord>): Promise<RuntimeSessionRecord> {
    const { data, error } = await this.supabase
      .from("daemon_runtime_sessions")
      .update(mapRuntimeSessionPatch(patch))
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapRuntimeSessionRow(data);
  }

  async latestForAgent(workspaceId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    const { data, error } = await this.supabase
      .from("daemon_runtime_sessions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapRuntimeSessionRow(data) : null;
  }
}

function mapRuntimeSessionPatch(patch: Partial<RuntimeSessionRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.sessionId !== undefined) row.session_id = patch.sessionId;
  if (patch.processId !== undefined) row.process_id = patch.processId;
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.lastActiveAt !== undefined) row.last_active_at = patch.lastActiveAt;
  if (patch.idleAt !== undefined) row.idle_at = patch.idleAt;
  if (patch.endedAt !== undefined) row.ended_at = patch.endedAt;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.metadata !== undefined) row.metadata = patch.metadata;
  return row;
}

function mapRuntimeSessionRow(row: Record<string, unknown>): RuntimeSessionRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    agentId: row.agent_id as string,
    machineId: row.machine_id as string,
    runtime: "claude-code",
    runtimeModel: row.runtime_model as string | null,
    sessionId: row.session_id as string | null,
    processId: row.process_id as number | null,
    state: row.state as RuntimeSessionState,
    promptHash: row.prompt_hash as string,
    wrapperHash: row.wrapper_hash as string | null,
    startedAt: row.started_at as string,
    lastActiveAt: row.last_active_at as string | null,
    idleAt: row.idle_at as string | null,
    endedAt: row.ended_at as string | null,
    lastError: row.last_error as string | null,
    metadata: row.metadata as Record<string, unknown>,
  };
}
```

- [ ] **Step 4: Thread materialized prompt and wrapper into AgentManager**

Modify `apps/bridge/src/agent-manager.ts` constructor to accept optional materializers:

```ts
interface AgentManagerRuntimeOptions {
  workspaceId: string;
  workspaceName: string;
  machineId: string;
  hostname: string;
  platform: string;
  arch: string;
  bridgeVersion: string;
}
```

Add a private field:

```ts
private runtimeOptions: AgentManagerRuntimeOptions | null = null;
```

Add a setter:

```ts
configureDaemonRuntime(options: AgentManagerRuntimeOptions) {
  this.runtimeOptions = options;
}
```

In `spawnProcess(...)`, after memory and autonomous skill context are available, replace direct `systemPrompt` usage only when `this.runtimeOptions` exists:

```ts
const promptMaterializer = new PromptMaterializer({ rootDir: resolve(this.agentsDir, "..") });
const materializedPrompt = this.runtimeOptions
  ? promptMaterializer.materialize({
      agentId,
      displayName: session.displayName,
      name: session.name,
      description: agent?.description ?? null,
      systemPrompt: agent?.system_prompt ?? null,
      memoryContext,
      autonomousSkillContext,
      workspaceId: this.runtimeOptions.workspaceId,
      workspaceName: this.runtimeOptions.workspaceName,
      machineId: this.runtimeOptions.machineId,
      hostname: this.runtimeOptions.hostname,
      platform: this.runtimeOptions.platform,
      workDir: session.workDir,
      bridgeVersion: this.runtimeOptions.bridgeVersion,
      model,
    }).content
  : systemPrompt;
```

Use `materializedPrompt` in the Claude args:

```ts
"--append-system-prompt",
materializedPrompt,
```

Replace `prepareCliTransport(...)` wrapper writing with `CliTransportMaterializer` when `this.runtimeOptions` exists:

```ts
const wrapper = new CliTransportMaterializer({ rootDir: resolve(this.agentsDir, ".."), nodePath: process.execPath }).materialize({
  agentId,
  cliEntrypoint: cliPath,
  mode: cliPath.endsWith(".ts") ? "tsx" : "node",
});
console.log(`  [${session.displayName}] CLI wrapper written: ${wrapper.wrapperPath}`);
return dirname(wrapper.wrapperPath);
```

- [ ] **Step 5: Store current delivery context in local state before stdin delivery**

In `DeliveryRuntime.deliverNow(...)`, before calling `driver.deliver(...)`, write current delivery context through the driver:

```ts
if (this.options.driver.setCurrentDelivery) {
  await this.options.driver.setCurrentDelivery(delivery.agentId, {
    deliveryId: delivery.id,
    deliverySeq: delivery.deliverySeq,
    traceparent: delivery.traceparent,
  });
}
```

Update `RuntimeAgentDriver`:

```ts
setCurrentDelivery?(agentId: string, context: { deliveryId: string; deliverySeq: number; traceparent: string }): Promise<void>;
```

Add `AgentManager.setCurrentDelivery(...)`:

```ts
async setCurrentDelivery(agentId: string, context: { deliveryId: string; deliverySeq: number; traceparent: string }) {
  const session = this.sessions.get(agentId);
  if (!session) return;
  const statePath = join(session.workDir, ".zano", "state.json");
  const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown> : {};
  writeFileSync(statePath, JSON.stringify({ ...current, currentDelivery: context }, null, 2) + "\n", "utf8");
}
```

Pass it from bridge runtime driver:

```ts
driver: {
  deliver: (agentId, prompt) => this.agentManager.deliverRuntimeMessage(agentId, prompt),
  setCurrentDelivery: (agentId, context) => this.agentManager.setCurrentDelivery(agentId, context),
},
```

- [ ] **Step 6: Make CLI read delivery context from local state**

Modify `packages/cli/src/index.ts` `deliveryContextMetadata()` from Task 12 to read `ZANO_AGENT_LOCAL_STATE` when env values are missing:

```ts
function deliveryContextMetadata(): JsonObject {
  const localStatePath = process.env.ZANO_AGENT_LOCAL_STATE;
  const localState = localStatePath && existsSync(localStatePath)
    ? JSON.parse(readFileSync(localStatePath, "utf8")) as JsonObject
    : {};
  const currentDelivery = isRecord(localState.currentDelivery) ? localState.currentDelivery : {};
  return {
    delivery_id: DELIVERY_ID ?? currentDelivery.deliveryId ?? null,
    delivery_seq: DELIVERY_SEQ ? Number(DELIVERY_SEQ) : currentDelivery.deliverySeq ?? null,
    traceparent: TRACEPARENT ?? currentDelivery.traceparent ?? null,
  };
}
```

- [ ] **Step 7: Run runtime session and bridge builds**

Run:

```bash
pnpm --filter @fehey/zano-bridge test -- src/runtime/session-ledger.test.ts src/runtime/prompt-materializer.test.ts src/runtime/cli-transport.test.ts src/runtime/delivery-runtime.test.ts
pnpm --filter @fehey/zano-bridge build
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/bridge/src/runtime/session-ledger.ts apps/bridge/src/runtime/session-ledger.test.ts apps/bridge/src/runtime/agent-supervisor.ts apps/bridge/src/runtime/delivery-runtime.ts apps/bridge/src/agent-manager.ts apps/bridge/src/bridge.ts packages/cli/src/index.ts
git commit -m "feat: persist daemon runtime sessions"
```

---

### Task 15: End-to-End Verification and Cleanup

**Files:**
- Modify only files required by failed checks from previous tasks.

- [ ] **Step 1: Run database schema verification**

Run:

```bash
pnpm --filter @zano/db verify:daemon
pnpm --filter @zano/db build
```

Expected: PASS.

- [ ] **Step 2: Run bridge runtime tests**

Run:

```bash
pnpm --filter @fehey/zano-bridge test
pnpm --filter @fehey/zano-bridge build
pnpm --filter @fehey/zano-bridge verify:autonomous
```

Expected: PASS.

- [ ] **Step 3: Run CLI build**

Run:

```bash
pnpm --filter @fehey/zano-cli build
```

Expected: PASS.

- [ ] **Step 4: Run web build**

Run:

```bash
pnpm --filter @zano/web build
```

Expected: PASS.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Isolated daemon v2 smoke**

Use a non-production workspace or get explicit approval before sending live messages that wake real agents. Start the bridge with v2 enabled:

```bash
ZANO_DAEMON_V2=1 pnpm --filter @fehey/zano-bridge dev
```

In an isolated workspace, send one human top-level group message and one agent-scoped handoff. Verify with CLI:

```bash
zano daemon deliveries --message <source-message-id>
zano daemon status
```

Expected:

```text
- one delivery row per activated human-broadcast agent
- scoped agent handoff only creates scoped deliveries
- seq values increase per agent
- traceparent is present for every delivery
- busy agents enter queued_gated or queued_busy instead of dropping messages
```

- [ ] **Step 7: Final commit**

```bash
git status --short
git add apps/bridge/src apps/web/src packages/cli/src packages/db/src packages/db/scripts packages/db/package.json
git commit -m "feat: add zano daemon platform v2"
```

---

## Self-Review Checklist

- Spec coverage:
  - Delivery ids, idempotency keys, seq, and traceparent: Tasks 1, 2, 6, 9, 10, 11.
  - Durable delivery ledger: Tasks 3, 6, 11.
  - Busy/gated delivery state machine: Tasks 8, 9.
  - Start queue and dedupe: Task 7.
  - Idle/restart foundation and runtime session persistence: Tasks 7, 8, 9, 14.
  - Two-level local `~/.zano` state: Task 4.
  - Materialized prompt and wrapper: Tasks 5, 14.
  - CLI runtime inspection and delivery context propagation: Tasks 12, 14.
  - Web observability: Task 13.
  - Verification gates: Task 15.
- Type consistency:
  - `RuntimeDeliveryInput`, `RuntimeDeliveryRecord`, `DeliveryState`, `RuntimeTraceEvent`, and `StartQueueEntry` originate in `apps/bridge/src/runtime/types.ts`.
  - `DeliveryRuntime.accept(...)` consumes `RuntimeDeliveryInput` from `buildRuntimeDeliveryInput(...)`.
  - CLI and web use DB column names returned by Supabase; runtime code uses camelCase records.
- Safety notes:
  - Generated prompts and wrappers do not inline bridge API keys, Supabase keys, auth tokens, agent tokens, or MCP auth values.
  - Live workspace smoke requires explicit approval because it can wake real agents.
  - The `ZANO_DAEMON_V2=1` flag controls rollout safety; it is not a reduced-scope product design.
