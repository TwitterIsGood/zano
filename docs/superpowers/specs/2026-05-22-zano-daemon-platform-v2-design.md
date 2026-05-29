# Zano Daemon Platform v2 Design

**Goal:** Rebuild Zano's bridge runtime into a daemon-grade delivery platform with Slock-parity semantics: delivery ids, per-agent sequence numbers, trace context, durable delivery ledger, start queue, idle cache, safe busy-message gating, two-level local state, materialized prompts, runtime session records, and local trace files.

**Architecture:** Keep the existing Supabase-backed product model and A2A routing planner, but move process lifecycle and message delivery behind a new daemon runtime layer. Omni plans who should wake; the runtime records, queues, starts, gates, delivers, traces, and acknowledges each delivery.

**Scope:** This design covers Omni runtime, database schema, local `~/.zano` state, prompt/wrapper materialization, CLI/runtime surface, delivery observability, and verification gates. It is intentionally not an MVP: the target behavior is a full runtime foundation comparable to `@slock-ai/daemon@0.52.2`, adapted to Zano's current architecture.

---

## Problem

Zano now has a stronger A2A planner, but delivery is still mostly process-local behavior inside `AgentManager`:

- Routing decisions are logged, but not represented as durable delivery records.
- A message can be planned for agents A/B/C, but there is no durable answer for whether each delivery was received, queued, started, delivered to stdin, accepted by the runtime, completed, or failed.
- Per-agent ordering exists only as an in-memory queue.
- Busy delivery is simple: if the agent is busy, queue until the current turn finishes.
- Process lifecycle is spawn-on-demand and reuse-if-present, without a daemon-grade start queue, dedupe, idle state, restart-from-idle, or stale-process recovery model.
- Runtime context is mostly assembled in memory, not materialized into per-agent local state.
- Local traces, runtime sessions, generated prompts, and CLI wrappers are not first-class daemon artifacts.

This is why Zano can wake the right agents yet still feel weaker than Slock: the collaboration protocol is improving, but the daemon runtime underneath lacks durable control-plane semantics.

---

## Design Principles

1. **Planner and runtime stay separate**
   - The A2A planner decides which agents should inspect a message.
   - The daemon runtime decides how each delivery is accepted, ordered, queued, delivered, recovered, and traced.

2. **Every wake-up becomes a delivery record**
   - Console logs are not the source of truth.
   - Each planned delivery gets a delivery id, idempotency key, per-agent sequence number, state history, and trace context.

3. **Agent process state is explicit**
   - Runtime behavior must distinguish starting, idle, busy, gated, compacting, stale, failed, and stopped agents.
   - These states must be visible in local traces and database ledger rows.

4. **Human broadcast does not imply runtime spam**
   - Human top-level group messages may create deliveries for all channel agents.
   - The runtime still preserves per-agent order and safe injection boundaries.
   - The prompt still tells agents that wake-up means awareness, not automatic speaking.

5. **Agent messages remain bounded**
   - The v2 runtime must not weaken loop prevention.
   - Agent-authored deliveries continue to come only from scoped planner decisions: explicit mention, task/thread relation, handoff, natural reference fallback, or capped domain fanout.

6. **Local state mirrors daemon reality**
   - `~/.zano/machines` stores daemon/machine control-plane state.
   - `~/.zano/agents` stores agent identity, memory, generated prompt, wrapper, runtime sessions, inbox fragments, and traces.

7. **Secrets stay out of generated prompts, wrappers, and logs**
   - Tokens may exist in dedicated local secret files or environment providers.
   - Generated prompts and wrappers must not inline bridge API keys, Supabase service-role keys, agent tokens, or MCP auth values.

---

## Target Runtime Contract

A planned activation becomes a delivery with this conceptual envelope:

```text
Delivery {
  id: uuid
  idempotencyKey: string
  agentId: uuid
  sourceMessageId: uuid
  channelId: uuid
  threadParentId: uuid | null
  taskId: uuid | null
  target: string
  seq: number
  traceparent: string
  activationReasons: ActivationReason[]
  activationStrength: "strong" | "medium" | "weak"
  state: DeliveryState
  attempts: number
  createdAt: timestamptz
  updatedAt: timestamptz
}
```

The prompt header delivered to an agent should move from the current message-only header:

```text
[target=#general msg=a1b2c3d4 time=... sender=@richard type=human]
```

to a daemon-delivery header:

```text
[delivery=d1e2f3a4 seq=43 traceparent=00-... target=#general msg=a1b2c3d4 time=... sender=@richard type=human]
```

`delivery` identifies this runtime delivery, not just the source chat message. `seq` is monotonic per agent. `traceparent` links bridge routing, queueing, process lifecycle, stdin injection, CLI sends, and completion/failure records.

---

## Delivery State Model

Delivery states are durable and append-only in trace history, with the latest state mirrored on the delivery row.

### Core states

- `planned` — bridge planner selected this agent.
- `received` — daemon runtime accepted the delivery request.
- `deduped` — runtime recognized an equivalent idempotency key and reused the existing delivery.
- `queued_starting` — agent is being started; delivery is held in the starting inbox.
- `queued_busy` — agent is busy and cannot safely receive it yet.
- `queued_gated` — Claude-compatible gated stream delivery is waiting for a safe boundary.
- `queued_compaction` — runtime is at or near a compaction boundary and must not inject immediately.
- `restarting_idle` — delivery triggered restart from idle cache.
- `delivering` — runtime is actively writing the message to the agent transport.
- `delivered` — message reached the runtime transport boundary, usually stdin.
- `accepted` — agent runtime acknowledged the delivery boundary or Omni deems stdin injection accepted.
- `completed` — runtime observed the turn finish after this delivery.
- `failed` — delivery cannot proceed without manual or automatic retry.
- `cancelled` — delivery was intentionally abandoned because the source context was reset or superseded.

### Acknowledgement points

The runtime should emit trace and ledger updates at these points:

1. **Received ack** — delivery was accepted into the daemon state machine.
2. **Delivered ack** — delivery was injected into the agent runtime transport.
3. **Accepted ack** — runtime accepted the prompt as an active turn or queued safe-boundary input.
4. **Completed ack** — the turn associated with the delivery finished.
5. **Failed ack** — no further progress is possible without retry or restart.

This differs from a WebSocket-only Slock ack because Zano's control plane is Supabase-backed. The same semantics should be represented in Postgres rows and local JSONL traces rather than only a server socket message.

---

## Runtime Components

### `DeliveryRuntime`

Owns the delivery state machine.

Responsibilities:

- Accept `RoutingDelivery` objects from Omni executor.
- Allocate delivery id, idempotency key, per-agent seq, and trace context.
- Write `daemon_deliveries` records.
- Route deliveries based on current agent process state.
- Update delivery states and trace events.
- Recover queued deliveries on bridge restart.
- Expose a compatibility method used by `AgentManager.sendToAgent(...)` during migration.

Proposed file:

```text
apps/omni/src/runtime/delivery-runtime.ts
```

### `AgentSupervisor`

Owns process lifecycle and runtime sessions.

Responsibilities:

- Spawn Claude Code subprocesses.
- Dedupe starts for the same agent.
- Enforce max concurrent starts and start interval.
- Track process state: `starting`, `ready`, `busy`, `gated`, `idle`, `stale`, `stopping`, `failed`.
- Cache idle agent configs after clean exit.
- Restart from idle cache when a new delivery arrives.
- Detect stale or crashed processes and trigger recovery.
- Persist runtime session records locally and in DB.

Proposed file:

```text
apps/omni/src/runtime/agent-supervisor.ts
```

### `StartCoordinator`

Owns start queue policy.

Responsibilities:

- Serialize and dedupe starts.
- Limit concurrent agent startup.
- Persist pending start intents locally so bridge restart does not lose them.
- Move messages from `startingInboxes` into the delivery path once the agent is ready.

Proposed file:

```text
apps/omni/src/runtime/start-coordinator.ts
```

### `DeliveryLedger`

Owns database persistence for daemon delivery records.

Responsibilities:

- Create or reuse delivery rows by idempotency key.
- Allocate and persist per-agent sequence numbers.
- Update latest state, attempt count, queue reason, error, and timestamps.
- Record trace event rows when DB tracing is enabled.
- Load recoverable deliveries after daemon restart.

Proposed file:

```text
apps/omni/src/runtime/delivery-ledger.ts
```

### `AgentLocalStateStore`

Owns local filesystem state under `~/.zano`.

Responsibilities:

- Ensure machine and agent directories exist.
- Write machine metadata, lock owner, trace files, runtime session snapshots, start queue snapshots, and agent state.
- Materialize per-agent memory entrypoints and notes directories.
- Keep secret-bearing files separate from generated prompt and wrapper output.

Proposed file:

```text
apps/omni/src/runtime/local-state.ts
```

### `PromptMaterializer`

Owns generated prompt snapshots.

Responsibilities:

- Build the runtime standing prompt from agent identity, workspace identity, CLI command surface, target grammar, task/thread rules, memory protocol, runtime notes, and daemon delivery header grammar.
- Write prompt snapshots to `~/.zano/agents/<agent-id>/.zano/prompts/`.
- Maintain a stable `current-system-prompt.md` symlink or pointer file.
- Trigger controlled process restart when prompt material changes.

Proposed file:

```text
apps/omni/src/runtime/prompt-materializer.ts
```

### `CliTransportMaterializer`

Owns the local CLI wrapper and runtime environment handoff.

Responsibilities:

- Generate a per-agent `zano` wrapper in `~/.zano/agents/<agent-id>/.zano/wrappers/zano`.
- Keep secrets out of the wrapper body.
- Point the wrapper at the project CLI entrypoint and the agent's local runtime environment provider.
- Record wrapper version and generated-at timestamp.

Proposed file:

```text
apps/omni/src/runtime/cli-transport.ts
```

### `TraceContext` and `LocalTraceSink`

Own trace ids and local JSONL traces.

Responsibilities:

- Create W3C-style `traceparent` values.
- Link routing, delivery, process, stdin, CLI, and completion events.
- Write rotated JSONL trace files under `~/.zano/machines/<machine-id>/traces/`.
- Redact known secret-bearing fields before writing.

Proposed files:

```text
apps/omni/src/runtime/trace-context.ts
apps/omni/src/runtime/local-trace-sink.ts
```

### `AgentManager` compatibility façade

`AgentManager` should remain Omni-facing interface during migration, but its internals should delegate to `DeliveryRuntime` when v2 is enabled.

Responsibilities:

- Preserve current bridge call sites initially.
- Allow `ZANO_DAEMON_V2=1` to route delivery through the new runtime.
- Allow a temporary fallback to current behavior while v2 is being verified.
- Eventually shrink to a thin compatibility wrapper around the runtime components.

---

## Database Schema

Add a daemon schema file:

```text
packages/db/src/daemon.sql
```

Export it from the DB package in the same pattern as existing SQL schema files.

### `daemon_deliveries`

Durable delivery ledger.

Fields:

- `id uuid primary key`
- `workspace_id uuid not null`
- `agent_id uuid not null`
- `channel_id uuid not null`
- `source_message_id uuid not null`
- `thread_parent_id uuid null`
- `task_id uuid null`
- `delivery_seq bigint not null`
- `idempotency_key text not null`
- `trace_id text not null`
- `span_id text not null`
- `traceparent text not null`
- `target text not null`
- `activation_strength text not null`
- `activation_reasons jsonb not null default '[]'::jsonb`
- `state text not null`
- `queue_reason text null`
- `attempts integer not null default 0`
- `last_error text null`
- `planned_at timestamptz not null default now()`
- `received_at timestamptz null`
- `delivered_at timestamptz null`
- `accepted_at timestamptz null`
- `completed_at timestamptz null`
- `failed_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- unique `(workspace_id, idempotency_key)`
- unique `(workspace_id, agent_id, delivery_seq)`
- index `(workspace_id, source_message_id)`
- index `(workspace_id, agent_id, state, created_at)`
- index `(workspace_id, trace_id)`

### `daemon_runtime_sessions`

Runtime process/session ledger.

Fields:

- `id uuid primary key`
- `workspace_id uuid not null`
- `agent_id uuid not null`
- `machine_id text not null`
- `runtime text not null`
- `runtime_model text null`
- `session_id text null`
- `process_id integer null`
- `state text not null`
- `prompt_hash text not null`
- `wrapper_hash text null`
- `started_at timestamptz not null default now()`
- `last_active_at timestamptz null`
- `idle_at timestamptz null`
- `ended_at timestamptz null`
- `last_error text null`
- `metadata jsonb not null default '{}'::jsonb`

Indexes:

- index `(workspace_id, agent_id, state)`
- index `(workspace_id, machine_id, started_at desc)`
- index `(workspace_id, session_id)`

### `daemon_start_queue`

Optional DB-visible start queue mirror. Local state remains authoritative for live daemon scheduling, but this table makes startup visible and recoverable.

Fields:

- `id uuid primary key`
- `workspace_id uuid not null`
- `agent_id uuid not null`
- `machine_id text not null`
- `reason text not null`
- `state text not null`
- `dedupe_key text not null`
- `requested_at timestamptz not null default now()`
- `started_at timestamptz null`
- `finished_at timestamptz null`
- `last_error text null`
- `metadata jsonb not null default '{}'::jsonb`

Constraints and indexes:

- unique `(workspace_id, dedupe_key)` for active dedupe keys
- index `(workspace_id, agent_id, state, requested_at)`

### `daemon_trace_events`

DB trace event mirror for important lifecycle events. Local JSONL traces keep the full stream; DB rows keep queryable milestones.

Fields:

- `id uuid primary key`
- `workspace_id uuid not null`
- `trace_id text not null`
- `span_id text not null`
- `parent_span_id text null`
- `delivery_id uuid null`
- `agent_id uuid null`
- `event_type text not null`
- `event_name text not null`
- `severity text not null default 'info'`
- `attributes jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Indexes:

- index `(workspace_id, trace_id, created_at)`
- index `(workspace_id, delivery_id, created_at)`
- index `(workspace_id, agent_id, created_at desc)`

---

## Local State Layout

Zano should adopt a two-level local state model:

```text
~/.zano/
  machines/
    <machine-id>/
      machine.json
      bridge.json
      daemon.lock/
        owner.json
      runtime-sessions.json
      start-queue.jsonl
      traces/
        daemon-trace-YYYYMMDD-HHMMSS.jsonl
      locks/
  agents/
    <agent-id>/
      MEMORY.md
      notes/
      .zano/
        agent.json
        state.json
        current-system-prompt.md
        prompts/
          system-prompt-<hash>.md
        wrappers/
          zano
        runtime-sessions/
          <session-id>.json
        inbox/
          pending-<delivery-id>.json
        traces/
        skills/
        secrets/
          agent-token
          env.json
```

### Machine plane

`machines/<machine-id>` stores daemon control-plane facts:

- machine identity
- hostname and platform
- bridge version
- daemon process owner and pid
- start queue snapshots
- runtime session summary
- rotated local traces
- local locks

### Agent plane

`agents/<agent-id>` stores agent runtime facts:

- stable memory entrypoint
- notes directory
- generated system prompt snapshots
- generated local CLI wrapper
- local runtime session records
- inbox fragments for not-yet-delivered prompts
- per-agent trace fragments
- secret-bearing files isolated under `.zano/secrets/`

The generated wrapper must not contain raw tokens. It should locate the correct project CLI and load credentials from the agent's local secret provider or bridge-provided environment.

---

## Busy, Gated, and Idle Delivery

The v2 runtime should handle delivery by agent state.

### Agent is starting

- Store delivery in a starting inbox.
- Mark delivery `queued_starting`.
- When process reaches ready state, drain starting inbox in sequence order.

### Agent is idle with cached config

- Mark delivery `restarting_idle`.
- Enqueue a deduped start intent.
- Restart with cached agent config, prompt hash, wrapper hash, and runtime metadata.
- Deliver after ready.

### Agent is idle and stdin-capable

- If the process still exists and stdin is safe, deliver directly.
- Mark `delivering`, then `delivered`, then `accepted`.

### Agent is busy and supports gated delivery

- Mark delivery `queued_gated`.
- Buffer the prompt until a safe Claude Code stream-json boundary is observed.
- Inject the message at the boundary without corrupting same-turn steering.
- Preserve delivery sequence order.

### Agent is busy and cannot accept gated stdin

- Mark delivery `queued_busy`.
- Deliver when current turn completes.

### Agent is at a compaction boundary

- Mark delivery `queued_compaction`.
- Buffer until compaction is complete or until the runtime reaches a safe post-compaction boundary.

### Agent is stale or crashed

- Mark the current runtime session stale/failed.
- Attempt controlled restart if retry policy allows it.
- Keep delivery queued with attempts incremented.
- Mark failed only after the restart policy is exhausted.

---

## Prompt Surface

The materialized prompt should include the current Zano collaboration rules plus daemon runtime context.

Required sections:

- Agent identity: id, display name, handle, role, model.
- Workspace identity: workspace id/name, project context, current machine id.
- Runtime context: OS, hostname, working directory, bridge version, prompt hash.
- CLI-only operation rule: agents must use the `zano` CLI for visible collaboration actions.
- Message header grammar including `delivery`, `seq`, and `traceparent`.
- Target grammar:
  - `#channel`
  - `#channel:<thread-short-id>`
  - `dm:@name`
- Thread rule: if target has a thread suffix, replies must use that exact target.
- Task rule: task progress, evidence, blockers, review requests, and completion notes belong in the task thread unless a human explicitly asks for a main-channel summary.
- A2A wake rule: human top-level group wake-up means awareness, not mandatory speech.
- Agent handoff rule: use explicit `@agent` plus the concrete next action.
- Internal decision modes: reply and work, work silently, reply only, observe, skip.
- Available CLI commands and examples.
- Memory protocol: how to use local memory/notes without leaking secrets.
- Runtime note: busy messages may be buffered and delivered at safe boundaries.

The generated prompt should be materialized locally before process start and referenced by hash in `daemon_runtime_sessions`.

---

## CLI Surface

The existing `zano` CLI should gain daemon-aware commands without breaking current message/task commands.

New or extended commands:

- `zano daemon status`
  - show machine id, bridge pid, connected workspace, active sessions, queued starts, queued deliveries.
- `zano daemon deliveries --agent <agent> --state <state>`
  - inspect delivery ledger rows.
- `zano daemon traces --trace <trace-id>`
  - print local or DB trace milestones.
- `zano agent sessions --agent <agent>`
  - list runtime sessions and prompt hashes.
- `zano agent local-state --agent <agent>`
  - show generated prompt/wrapper/session paths without printing secrets.
- `zano message send` and `zano thread reply`
  - include current delivery context when invoked inside an agent runtime so agent-authored replies can be trace-linked.

The generated wrapper should make these commands available from inside the agent workspace while preserving the same external CLI behavior for humans.

---

## Bridge Integration

The existing bridge routing flow should become:

1. Supabase message insert arrives.
2. Bridge ignores already processed/system messages.
3. Bridge builds `RoutingPlan` with activated candidates and suppressed candidates.
4. Bridge passes every `RoutingDelivery` to `DeliveryRuntime.accept(...)` concurrently.
5. `DeliveryRuntime` creates or reuses durable delivery rows.
6. Runtime state machine queues, starts, gates, or injects each delivery.
7. Runtime updates delivery states and local traces.
8. Agent CLI replies carry delivery context when available.

`executeRoutingPlan(...)` should stop calling process delivery directly. Its responsibility should become submitting planned deliveries to the runtime and reporting acceptance failures.

---

## Observability

The first observability layer should be CLI and database inspection; UI can follow once the runtime records are stable.

Minimum visible facts:

- For a source message: planned agents, delivery ids, states, seq values, and last errors.
- For an agent: current process state, busy/gated queue depth, idle cache status, active session id, prompt hash.
- For a trace id: route planned, delivery received, start queued, process started, stdin delivered, accepted, completed/failed.
- For bridge startup: recovered queued deliveries and recovered idle configs.

Later web UI should show a per-message delivery drawer:

```text
Message a1b2c3d4
  Alpha  seq=41  accepted   trace=...
  Beta   seq=18  queued_gated
  Gamma  seq=27  completed
```

---

## Error Handling and Recovery

### Bridge restart

On startup:

- Acquire machine lock.
- Load local machine state.
- Load recoverable `daemon_deliveries` states from DB.
- Load local start queue snapshots.
- Reconcile local runtime sessions with live processes.
- Mark impossible stale sessions as failed/stale.
- Resume queued deliveries in per-agent sequence order.

### Duplicate routing event

If Supabase realtime redelivers a message event:

- Planner may produce the same candidate.
- Runtime idempotency key should reuse the existing delivery row.
- The delivery should not be injected twice.

Recommended idempotency key:

```text
<source-message-id>:<agent-id>:<target>:<activation-reasons-hash>
```

### Process crash

If a process exits unexpectedly:

- Mark runtime session failed.
- Keep not-yet-accepted deliveries recoverable.
- Retry start if policy allows.
- Mark affected deliveries failed only after retry exhaustion.

### Prompt or wrapper change

If materialized prompt or wrapper hash changes:

- Do not mutate a running process silently.
- Mark the active session as requiring restart.
- Restart at the next safe boundary or before the next delivery if idle.

### Secret exposure prevention

- Redact known secret fields before trace/log writes.
- Do not include secret file contents in prompts.
- Do not inline tokens in wrappers.
- Do not mirror local secret values to DB trace events.

---

## Implementation Phases

### Phase 1 — Runtime types and trace foundation

Create:

```text
apps/omni/src/runtime/types.ts
apps/omni/src/runtime/trace-context.ts
apps/omni/src/runtime/local-trace-sink.ts
```

Add tests for:

- traceparent generation and parsing
- per-agent sequence allocation interface
- delivery state transition validation
- redaction behavior

### Phase 2 — Database daemon schema

Create:

```text
packages/db/src/daemon.sql
```

Update DB exports and migrations so daemon tables are included consistently.

Add tests or SQL checks for:

- unique idempotency key
- unique per-agent delivery seq
- indexes for message/agent/trace lookup
- valid delivery/session/start states

### Phase 3 — Local state store

Create:

```text
apps/omni/src/runtime/local-state.ts
```

Add tests for:

- machine directory creation
- agent directory creation
- prompt/wrapper/session path generation
- secret path isolation
- JSON write/read round trip

### Phase 4 — Prompt and wrapper materialization

Create:

```text
apps/omni/src/runtime/prompt-materializer.ts
apps/omni/src/runtime/cli-transport.ts
```

Update prompt tests to assert:

- delivery header grammar is documented
- thread targets must be reused exactly
- task progress belongs in task thread
- handoff requires explicit `@`
- wake-up is not mandatory speech
- wrapper generation does not inline secrets

### Phase 5 — Delivery ledger abstraction

Create:

```text
apps/omni/src/runtime/delivery-ledger.ts
```

Add tests for:

- create delivery
- dedupe delivery
- allocate monotonic seq per agent
- transition states
- recover queued deliveries
- write trace event milestones

### Phase 6 — Start coordinator

Create:

```text
apps/omni/src/runtime/start-coordinator.ts
```

Add tests for:

- dedupe same-agent start
- max concurrent starts
- start interval
- starting inbox drain order
- local start queue persistence

### Phase 7 — Agent supervisor

Create:

```text
apps/omni/src/runtime/agent-supervisor.ts
```

Refactor current process spawning from `AgentManager` into the supervisor.

Add tests for:

- spawn lifecycle
- idle cache creation after clean exit
- restart from idle
- stale process recovery
- prompt hash restart detection
- runtime session persistence

### Phase 8 — Delivery runtime state machine

Create:

```text
apps/omni/src/runtime/delivery-runtime.ts
```

Add tests for:

- starting agent queues delivery
- idle cached agent restarts before delivery
- busy agent queues delivery
- gated delivery waits for safe boundary
- compaction boundary buffers delivery
- failed process retries then fails delivery
- duplicate delivery does not inject twice

### Phase 9 — Bridge routing integration

Change `apps/omni/src/bridge.ts` so `executeRoutingPlan(...)` submits deliveries to `DeliveryRuntime` instead of directly calling `AgentManager.sendToAgent(...)` when `ZANO_DAEMON_V2=1`.

Add tests for:

- human broadcast creates one delivery per activated agent
- agent-scoped message creates only scoped deliveries
- thread/task messages keep bounded delivery set
- delivery prompt includes `delivery`, `seq`, and `traceparent`
- executor accepts deliveries concurrently without serial process blocking

### Phase 10 — CLI daemon commands

Update:

```text
packages/cli/src/index.ts
```

Add tests for:

- `zano daemon status`
- `zano daemon deliveries`
- `zano daemon traces`
- `zano agent sessions`
- secret-safe local-state display
- message sends carrying delivery context when available

### Phase 11 — UI observability

Add a delivery-inspection surface after ledger semantics are stable.

Candidate UI:

- message delivery drawer
- agent runtime/session status in member detail
- queued/busy/gated badges
- trace id copy action

### Phase 12 — End-to-end smoke

Run Omni with v2 enabled:

```text
ZANO_DAEMON_V2=1
```

Smoke cases:

1. Human top-level group message wakes all channel agents and creates durable deliveries.
2. Agent-authored task handoff wakes only scoped target agents.
3. Busy agent receives a second message and queues/gates it safely.
4. Idle agent is restarted from idle cache.
5. Bridge restart recovers queued deliveries without duplicate stdin injection.
6. Prompt/wrapper/session files are materialized under `~/.zano`.
7. CLI can inspect delivery state and trace milestones without printing secrets.

---

## Verification Gates

Before declaring v2 complete:

- Unit tests cover delivery state transitions and recovery.
- A2A routing tests still pass unchanged for planner semantics.
- Bridge build passes.
- CLI build passes.
- DB schema exports include daemon tables.
- Local state tests prove secrets are not in generated prompts/wrappers.
- A manual isolated runtime smoke proves:
  - delivery rows are created,
  - seq is monotonic per agent,
  - traceparent is present in prompt headers,
  - busy delivery is queued or gated,
  - idle restart works,
  - duplicate realtime events do not duplicate delivery.

Live workspace smoke should not send real messages to production-like workspaces unless explicitly approved, because it can wake real agents.

---

## Migration Strategy

Use a feature flag during implementation:

```text
ZANO_DAEMON_V2=1
```

Default behavior remains current until v2 has passed isolated verification. The migration path is:

1. Build v2 runtime components with tests.
2. Wire them behind `AgentManager` as an optional path.
3. Enable v2 in local isolated bridge smoke.
4. Compare ledger/trace behavior against expected Slock-parity semantics.
5. Make v2 the default only after the runtime is stable.
6. Remove the old in-memory-only delivery path after the new runtime has equivalent or better coverage.

The feature flag is for rollout safety, not for designing a smaller product. The target architecture remains the full daemon platform described above.

---

## Final Shape

When complete, Zano should be able to answer these questions durably:

- Which source message woke which agents?
- Why was each agent selected?
- What delivery id and seq did each agent receive?
- Was the delivery received, queued, gated, delivered, accepted, completed, or failed?
- Which runtime session handled it?
- Which prompt and wrapper version were active?
- What trace links routing, process lifecycle, stdin injection, and CLI replies?
- What local files represent this daemon and this agent?
- Can Omni restart without losing or duplicating deliveries?

That is the Slock-parity line: not just better routing, but a protocolized local daemon runtime that makes agent collaboration observable, recoverable, and safe under real multi-agent load.
