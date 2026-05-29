# Zano Daemon Slock Strict-Parity Design

## Goal

Zano daemon/runtime should match Slock's core product mechanisms closely enough that Zano agents behave like workspace teammates rather than webhook bots. The work should preserve Slock's boundaries: delivery ACK custody, safe runtime steering, local runtime materialization, runtime-profile controls, freshness checks, and a concrete agent collaboration prompt contract.

This is strict mechanism parity, not a new Zano-specific workflow layer. Zano may use its own names, database, and CLI prefix, but it should not omit Slock mechanisms or add unrelated product mechanisms.

## Evidence Sources

This design is based on two Slock evidence sources:

```text
Slock daemon source:
/Users/biangwua/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon

Observed local runtime state:
/Users/biangwua/.slock
```

Sensitive local files are evidence only for existence, path role, and permissions. Their contents must not be read, printed, logged, or copied:

```text
.slock/agent-token
.slock/env.json
.slock/claude-mcp-config.json
machines/*/daemon.lock/owner.json token-like fields
```

## Product Principle

Slock's human-like machine chat comes from the combination of server/daemon reliability and prompt/runtime contract:

- Server and daemon decide who should be notified, when delivery is safe, and whether a delivery has been accepted into daemon custody.
- Prompt and runtime contract decide how an agent behaves after wake-up: whether to speak, keep working silently, update a task thread, search history, or hand off to another teammate.

Zano should therefore prioritize the full runtime contract, not only the database ledger or routing rules.

## Slock Parity Map

| Slock mechanism | Observed Slock behavior | Zano mapping | Must not do |
| --- | --- | --- | --- |
| Delivery ACK | `agent:deliver:ack` is sent only when `AgentProcessManager.deliverMessage(...)` accepts a delivery. ACK includes `agentId`, `seq`, `traceparent`, and `deliveryId`. | ACK/accepted means daemon accepted custody of the delivery. | Do not treat ACK as agent reply or business completion. |
| Delivery completion | No ordinary `agent:deliver:completed` wire event was found. Work completion is inferred from runtime, task, message, and activity effects. | Delivery rows may expose custody/delivery/error state; completion is derived from task/reply/session evidence. | Do not invent ordinary delivery completion protocol. |
| Replay/retry | If daemon does not ACK, server can retry. After ACK, daemon has local/process custody. | Unacked deliveries remain server-retryable; ACKed deliveries are daemon-owned. | Do not add a new dead-letter product layer. |
| Claude gated steering | `createGatedSteeringState()` tracks `phase`, tool count, compaction, `toolBoundaryFlushDisabled`, recent events, and in-flight batch. | Replace coarse busy boolean with Slock-like gated steering. | Do not inject full messages into unsafe Claude states. |
| Busy notification | Non-turn safe boundaries send a stdin notification/inbox count; `turn_end` is the strongest full delivery flush boundary. | Tool-boundary flush should notify; full delivery should wait for idle/turn-end unless source behavior says otherwise. | Do not treat every tool boundary as safe full-message injection. |
| Runtime profiles | Source has profile behavior for Claude, Codex, Kimi, Copilot, Cursor, Gemini, and OpenCode. | Zano should model runtime behavior through profiles, with Claude parity as the current required path. | Do not hardcode one global busy policy. |
| Runtime profile controls | Source supports migration/release-notice controls, ACKs, prompt instructions, and `runtime_profile_migration_done` MCP action. | Add equivalent runtime-profile control path. | Do not use ordinary chat reply or CLI command as migration ACK. |
| CLI transport | `prepareCliTransport(...)` writes `.slock/slock`, token file or proxy token, prompt/config inputs, spawn env, and removes raw credential env vars. | Materialize `.zano/zano`, token/proxy token role, prompt/config, and spawn env. | Do not inline raw credentials into prompt/wrapper/logs. |
| Ordinary agent communication | Prompt/source use `slock` CLI for messages/tasks/channels. MCP exception is runtime-profile migration completion. | Ordinary collaboration uses `zano` CLI; MCP is reserved for Slock-equivalent runtime actions unless separately evidenced. | Do not claim ordinary MCP chat/task tools are Slock daemon parity. |
| Freshness hold | Send/task claim/task update can be held when newer visible messages exist; CLI supports draft, send-draft, and `--anyway` escape hatch. | Add freshness preflight for side effects. | Do not let stale agent actions silently land over newer human/team context. |
| Thread context | Source formats thread join context with parent/recent thread messages and suggested read target. | Include thread join context in deliveries/prompts. | Do not wake an agent into a thread without bounded context. |
| Task workflow | Prompt uses `todo -> in_progress -> in_review -> done`; agents set `in_review` when work is done and `done` after human approval. | Zano prompt/task CLI must teach the same flow. | Do not have agents mark human-review work directly done by default. |
| Local state | Observed `~/.slock/agents/*` and `~/.slock/machines/*` layouts. Source prefers native Claude/Codex session files and uses `.slock/runtime-sessions` as fallback handoff. | Mirror path roles under `~/.zano`; treat DB records as Zano observability representation. | Do not claim every runtime event is written to `.slock/runtime-sessions`. |
| Traces | Local traces are JSONL spans with trace/span IDs, status, attrs, events, and timing; upload markers are `.uploaded.json`. | Keep daemon traces diagnostic. | Do not turn trace errors into a user-facing dead-letter workflow. |

## Architecture

Zano should align to four layers:

```text
Web / Server
  Owns workspace, channel, member, task, and message facts.
  Decides which agents should receive a delivery.

Bridge / Daemon
  Owns local agent runtime custody.
  Handles ACK, queueing, gating, restart, trace, local state, freshness, and runtime-profile controls.

Agent Runtime
  Runs Claude Code or a future runtime from a materialized local workspace.
  Receives prompt, wrapper, token/proxy-token config, MCP runtime-control config, and runtime session references.

Zano CLI / runtime-control MCP
  Ordinary collaboration happens through the local zano CLI.
  Runtime-profile migration completion is the Slock-backed MCP exception.
```

The key boundary is:

```text
server decides who should be called
daemon decides when it is safe to call them
prompt/runtime decides how the agent acts like a teammate after wake-up
```

## Delivery ACK and Completion Semantics

ACK must mean daemon custody, not business completion.

```text
ACK = the daemon accepted responsibility for this delivery.
ACK != the agent completed the requested work.
ACK != the agent sent a visible reply.
```

Zano should model the lifecycle as separate concepts:

```text
received by daemon
accepted / ACKed into daemon custody
delivered to runtime stdin, queued in daemon inbox, or represented as a pending notification
runtime activity / task update / reply later indicates work progress or completion
```

Field semantics should be constrained to avoid inventing delivery completion:

- `received_at`: daemon saw the delivery.
- `acked_at` or `accepted_at`: daemon accepted custody and server should stop retrying this delivery.
- `ack_traceparent`: trace context for the daemon ACK path.
- `delivered_at`: delivery reached runtime stdin or equivalent runtime input path.
- `last_runtime_event_at` / session/task/message evidence: used to derive progress or completion outside the delivery ACK protocol.

Do not add ordinary `agent:deliver:completed`. If Zano keeps a `completed_at` field for existing schema compatibility, it must be explicitly documented as a derived observation from task/session/reply evidence, never a wire-level ACK/completion state.

## Replay, Retry, and Dead-Letter Boundary

Replay and retry should follow the Slock-style mailbox boundary:

```text
not ACKed:
  server/bridge can retry or replay because the daemon did not accept custody.

ACKed:
  daemon owns the delivery locally; server should not retry the same delivery.
  daemon handles local inbox, pending notification, gated flush, idle delivery, restart, or runtime recovery.
```

Zano should represent ownership clearly:

```text
server_retryable: delivery has not been ACKed by daemon
daemon_owned: delivery has been ACKed and is now daemon responsibility
```

Important strict-parity constraint: Slock daemon source shows process/local daemon custody after ACK, not a disk-backed delivery mailbox that survives arbitrary daemon process loss. Zano may persist DB observability rows for its own architecture, but the product mechanism must not be described as a stronger Slock-backed durable local mailbox unless separately evidenced.

Failure behavior:

- If daemon cannot accept custody, do not ACK. Let server retry/replay.
- If daemon accepts while runtime is starting, busy, gated, compacting, idle, or stalled, ACK and queue/notify locally according to runtime profile.
- If runtime later fails after daemon custody, record local/session/trace error state; do not add a new server-side dead-letter product mechanism.

Allowed diagnostic state:

```text
local trace error
runtime session error
server-visible diagnostic state
uploaded trace bundle metadata
```

Forbidden dead-letter product state:

```text
daemon_dead_letters table
user-facing dead-letter inbox
manual replay workflow for ACKed deliveries
failed delivery becoming a business task/todo automatically
```

## Runtime Driver Profiles

Runtime behavior must come from a profile, not from a global busy boolean.

Observed Slock profile behavior includes:

```text
Claude:
  lifecycle = persistent
  supportsStdinNotification = true
  busyDeliveryMode = gated
  supportsNativeStandingPrompt = true
  terminateProcessOnTurnEnd = false

Codex / Kimi:
  lifecycle = persistent
  supportsStdinNotification = true
  busyDeliveryMode = direct

Copilot / Cursor / Gemini:
  lifecycle = per_turn or non-stdin ordinary delivery
  supportsStdinNotification = false
  busyDeliveryMode = none

OpenCode:
  lifecycle = per_turn
  supportsStdinNotification = false
  busyDeliveryMode = none
  terminateProcessOnTurnEnd = true
```

Zano's strict required implementation path is Claude gated steering because Zano currently uses Claude Code. The profile model should still be explicit so future runtime support does not corrupt Claude-specific parity.

## Busy, Gated, and Safe-Boundary State

Zano needs a boundary state equivalent to Slock's Claude gated steering state.

Source-backed gated steering state:

```text
phase:
  idle
  assistant_continuation
  tool_wait
  tool_boundary
  compacting
  error

outstandingToolUses
compacting
toolBoundaryFlushDisabled
lastFlushReason
recentEvents
inFlightBatch
```

Agent process state, adjacent to gated steering:

```text
inbox
pendingNotificationCount
notificationTimer
sessionId
runtimeProgressStaleSince
lastRuntimeEventAt
expectedTerminationReason
```

Claude event rules:

- `thinking` / text continuation: enter `assistant_continuation`.
- `tool_call`: increment outstanding tool count and enter `tool_wait`.
- `tool_output`: decrement outstanding tool count; when all tools finish, enter `tool_boundary`.
- `compaction_started`: enter `compacting`; do not flush.
- `compaction_finished`: leave compaction and enter `assistant_continuation`.
- `turn_end`: strongest safe boundary; enter `idle`, reset outstanding tools/compaction, and flush queued full deliveries.
- runtime error matching thinking/redacted-thinking mutation: enter `error`, requeue in-flight batch, set `toolBoundaryFlushDisabled = true`, and wait for a safer boundary.

Safe-boundary delivery behavior:

- Idle/turn-end can deliver full messages through stdin.
- Tool-boundary and compaction-boundary behavior should prefer pending-message notification, not full message injection, unless source behavior proves full injection is safe.
- Compaction never flushes full messages.
- If tool-boundary flush is disabled, wait for turn-end/idle.
- Stalled recovery is runtime/process state, not a gated steering phase.

Delivery outcomes should stay close to observed Slock outcomes:

```text
queued_busy
queued_during_start
deferred_wake_message
auto_restart_from_idle
rejected_no_process
stdin_idle_delivery
queued_stalled_recovery
queued_busy_non_stdin
queued_before_session
queued_compaction_boundary
queued_busy_gated
queued_busy_notification
```

Do not add `stdin_written` as a Slock outcome name. If Zano records stdin write traces, use them as trace attributes/events rather than a new parity state name.

## Runtime Profile Controls

Slock has runtime-profile control messages in addition to ordinary message deliveries. Zano should include the same mechanism.

Source-backed controls:

```text
agent:runtime_profile:migration
agent:runtime_profile:daemon_release_notice
agent:runtime_profile:migration:ack
agent:runtime_profile:daemon_release_notice:ack
agent:runtime_profile reports
runtime_profile_migration_done MCP action
```

Prompt/runtime behavior:

- Migration notice interrupts normal inbox handling.
- Agent must re-ground in the new runtime context.
- Agent must call the runtime-control MCP action with the exact migration key.
- Agent must not acknowledge migration completion with a normal chat reply or ordinary CLI command.
- Daemon observes the tool call and sends the matching ACK.
- Daemon release notice is notice-only unless the source protocol requires an ACK.

Zano should materialize this as a reserved runtime-control action, not as a general-purpose MCP collaboration surface.

## Freshness Hold and Side-Effect Preflight

Slock's human-like correctness includes freshness protection before visible side effects.

Before these actions, daemon/CLI should check whether newer visible messages exist for the target:

```text
message send
task claim
task update
```

If the agent is stale, the action is held:

```text
state = held
outcome = held
subtype = freshness
heldMessages = bounded newer visible context
available_actions = review / send draft / send anyway where allowed
```

Agent-facing behavior:

- The attempted message can be saved as a draft.
- Agent must review the bounded newer context before sending.
- `send-draft` sends the saved draft after review.
- `--anyway` is an explicit escape hatch, not the default.
- Task claim/update should not land silently over newer relevant human/team context.

Zano prompt must teach this behavior because it is part of why Slock agents feel context-aware instead of blindly responding from stale state.

## Thread Join Context

When an agent is pulled into a thread, the delivery should include bounded context rather than only the latest message.

Slock source supports thread join context with:

```text
parent message
recent thread context
suggested read target
thread target
sender metadata
message id / seq / timestamp
```

Zano should provide equivalent thread join context so the agent can reply like a teammate who just entered the conversation, not like a bot seeing one isolated line.

## Local Runtime Materialization

Zano should materialize runtime state locally, rather than only passing a generated prompt to a child process.

Brand mapping:

```text
Slock observed: ~/.slock and .slock/slock
Zano target:   ~/.zano and .zano/zano
```

Per-agent target layout:

```text
~/.zano/agents/<agentId>/
  MEMORY.md
  notes/
    *.md

  .zano/
    zano
    claude-system-prompt.md
    runtime-sessions/
      *.jsonl

    agent-token
    claude-mcp-config.json
```

Observed local Slock notes:

- Agent directory names may be raw UUIDs or `agent-<uuid>`; Zano should use the server/runtime agent id safely, not assume one prefix.
- `notes/` exists as a directory capability; it may contain zero or more Markdown files.
- `.slock/runtime-sessions/*.jsonl` may be empty or use `claude-*` / `claude-launch-*` naming.
- `env.json` exists in some local Slock agent directories, but it is not written by the reviewed v0.52.2 daemon `prepareCliTransport(...)`; Zano must not treat `env.json` as a required Slock v0.52.2 mechanism. If Zano keeps an `env.json`, it is a Zano implementation detail and must remain secret/local-only.

Machine-level target layout:

```text
~/.zano/machines/<machineId>/
  daemon.lock/
    owner.json

  traces/
    *.jsonl

  trace-uploads/
    *.uploaded.json
```

Observed local Slock notes:

- `daemon.lock/owner.json` is the core machine ownership/lock file role.
- `traces/` and `trace-uploads/` appear when trace/upload activity exists; not every machine directory must have both at all times.
- Trace JSONL spans contain trace/span ids, parent span id, name, kind, surface, status, attrs, events, start/end time, and duration.
- Upload markers are `.uploaded.json` files with bundle/file/upload/checksum/size-style metadata.

Responsibilities:

- `MEMORY.md`: long-lived agent memory.
- `notes/`: private agent notes.
- `.zano/claude-system-prompt.md`: materialized final runtime contract.
- `.zano/zano`: local CLI wrapper exposed to the runtime.
- `.zano/agent-token`: sensitive token file role only when direct token mode is used.
- `~/.zano/agent-proxy-tokens/<agentId>/<launch>.token`: sensitive proxy token role when credential proxy mode is used.
- `.zano/claude-mcp-config.json`: runtime MCP configuration role for runtime-control actions.
- `.zano/runtime-sessions/*.jsonl`: fallback runtime session handoff/reference files, not guaranteed full event journals.
- `machines/<machineId>/daemon.lock/owner.json`: daemon ownership/lock state; token-like fields must be redacted in logs and UI.
- `machines/<machineId>/traces/*.jsonl`: daemon trace/span observability.
- `machines/<machineId>/trace-uploads/*.uploaded.json`: upload markers.

DB and local state should remain distinct:

```text
daemon_runtime_sessions = Zano server-visible lifecycle representation
native Claude/Codex transcript files = preferred runtime session source when reachable
.zano/runtime-sessions/*.jsonl = fallback handoff/reference role
traces/*.jsonl / daemon_trace_events = daemon trace/span observability
```

## CLI Transport, Environment, and Secrets

Before launching an agent runtime, daemon should:

1. Create the agent local runtime directory.
2. Write token file or local credential proxy token.
3. Write the `zano` wrapper.
4. Write `claude-system-prompt.md`.
5. Write Claude MCP config for reserved runtime-control actions.
6. Launch Claude Code with the materialized prompt/config and spawn env.
7. Avoid retaining or forwarding raw credential environment variables after materialization.

Runtime-visible environment should use stable local references such as:

```text
ZANO_HOME
ZANO_AGENT_ID
ZANO_AGENT_LAUNCH_ID
ZANO_SERVER_URL
ZANO_AGENT_TOKEN_FILE                 # direct token mode
ZANO_AGENT_PROXY_URL                  # proxy mode
ZANO_AGENT_PROXY_TOKEN_FILE           # proxy mode
ZANO_AGENT_ACTIVE_CAPABILITIES        # proxy mode
PATH including the local .zano wrapper
```

Secrets must not be written into generated prompts, UI, trace logs, or non-sensitive text. Wrapper text may reference token file paths or proxy token file paths, but must not inline raw tokens.

Secret categories:

```text
bridge API keys
Supabase service-role key
Supabase JWT secret
raw Omni auth token
raw agent token
MCP auth parameters
proxy token contents
machine lock token-like fields
```

Agent runtime should see a stable command/tool surface, not raw infrastructure credentials.

## Runtime Session Reporting

Slock reports session and runtime profile facts separately from local files. Zano should model the same distinction.

Runtime session reporting should include:

```text
agent id
runtime
model
reasoning effort / execution mode if available
launch id
session id
sessionRef
workspacePathRef
reachable/unreachable session reference
```

Session reference rules:

- Prefer native Claude session JSONL under the runtime's normal home.
- Prefer native Codex session JSONL for Codex when applicable.
- Use `.zano/runtime-sessions/*.jsonl` only as fallback handoff/reference when native session file cannot be found.
- Do not claim `.zano/runtime-sessions` is the full runtime event journal unless the implementation actually writes and owns those events.

## Prompt Surface

Zano prompt materialization must be a full teammate runtime contract, not a short assistant instruction.

Source-backed prompt sections/behaviors include:

```text
Who you are / Initial role
Current Runtime Context
Communication — zano CLI ONLY
Startup sequence
Messaging
Message Notifications
Threads
Tasks
@Mentions
Discovering people and channels
Channel awareness
Reading history / search / check
Reminders
Action cards
Attachments / profile context
Workspace & Memory
Communication style
Formatting
Runtime Profile migration/control notice
```

Core rules:

- Agent is a workspace member, not a generic assistant.
- Ordinary visible collaboration happens through Zano CLI.
- Runtime-profile migration completion uses the reserved MCP runtime-control action.
- Agent must not directly write the database or call Supabase.
- Wake-up does not always require a visible reply.
- If the right action is continuing work, continue work.
- If the right action is task progress, update the task thread.
- If message arrives from a thread, reply in that thread by default.
- If working on a task, claim it first unless already owner.
- If handing off, explicitly mention the target and next action.
- If context is unclear, read/check/search recent messages or task/thread history before asking humans to repeat context.
- Before sending/task-claim/task-update, respect freshness hold output.
- Avoid noisy acknowledgements.
- Never write secrets into memory, notes, messages, or logs.

The desired human-like feel should come from collaboration discipline, not fake personality. The prompt should prefer concise teammate behavior over generic friendliness.

## Agent Collaboration Protocol

Zano should align the agent-visible protocol to Slock-style workspace collaboration.

Ordinary collaboration command surface should include equivalents of:

```text
zano message send/read/check/search/react
zano server/workspace info
zano channel members/join/leave
zano thread unfollow
zano message send/read with thread targets
zano task list/create/claim/unclaim/update
attachments
profile/context
reminders
action cards
```

Do not list `thread follow` as a required CLI command unless Zano has separate source evidence. Slock exposes `thread unfollow`; following is generally implicit through membership, visibility, mention, or delivery rules.

Thread/message target grammar should support equivalents of:

```text
#channel
dm:@peer
#channel:threadId
dm:@peer:threadId
```

Collaboration rules:

- To make a specific member or agent act, explicitly `@mention` them.
- Casual name mentions are weak context, not a strong handoff.
- Channel membership is the reachability boundary for mentions.
- Task progress belongs in the task thread.
- Blockers should be explained in the task thread.
- Handoffs should include what is being handed off and the next action.
- Task status flow is `todo -> in_progress -> in_review -> done`.
- When agent work is ready, set task to `in_review` so a human can validate.
- Set task to `done` only after human approval or explicit instruction.
- Top-level channels are for broad coordination, announcements, or human group prompts.
- Thread/task context should not be expanded back to top-level channel unless useful and explicit.

Zano backend may keep natural-mention fallback only as bounded resilience for legacy/non-ideal agent phrasing. It must not become a prompt-endorsed strong handoff mechanism or an agent-authored all-agent broadcast path.

## UI and Observability Semantics

Existing delivery/runtime UI should label states according to daemon/runtime meaning:

```text
ACKed / accepted = daemon accepted custody
queued_gated = waiting for a safe runtime boundary
queued_busy = runtime is busy and cannot accept direct injection
queued_compaction_boundary = waiting for compaction-safe boundary
queued_busy_notification = pending-message notification path
stdin_idle_delivery = full delivery written at idle/turn-end boundary
completed = derived task/session/reply evidence, not delivery ACK
failed = daemon/runtime diagnostic error
```

UI must not imply:

```text
ACK = agent replied
accepted = agent completed the work
queued = lost
trace error = dead-letter workflow
```

Trace/error UI is diagnostic. It must not create a user-facing dead-letter inbox, manual replay workflow, or automatic business task.

## Testing Strategy

Implementation should include tests for these contracts.

### ACK semantics

- Given daemon receives `agent:deliver`, when agent manager rejects custody, then no ACK is sent/recorded.
- Given daemon receives `agent:deliver`, when agent manager accepts custody, then ACK includes `agentId`, `seq`, `traceparent`, and `deliveryId`.
- Given ACK is recorded, then no ordinary delivery completion is recorded from ACK alone.
- Given ordinary delivery completes a runtime turn, then no `agent:deliver:completed` wire event is required or emitted.

### Replay boundary

- Given delivery is unacked, then server path may retry/replay.
- Given delivery is ACKed, then server path treats it as daemon-owned.
- Given ACKed delivery later fails in runtime, then only diagnostic/session/trace state is recorded; no dead-letter workflow is created.

### Gated boundaries

- Given Claude is in `tool_wait`, then full delivery is not flushed.
- Given Claude reaches `tool_boundary`, then daemon sends pending notification only when safe and enabled.
- Given Claude is `compacting`, then no full delivery is flushed.
- Given Claude reaches `turn_end`, then queued full deliveries flush and phase returns to `idle`.
- Given thinking/redacted-thinking mutation error, then in-flight batch is requeued and tool-boundary flush is disabled.

### Runtime profile controls

- Given migration control arrives, then prompt instructs the runtime to call the reserved migration-done MCP action with the exact key.
- Given migration-done action is observed, then daemon sends the matching runtime-profile migration ACK.
- Given migration control arrives, then ordinary chat reply or CLI message is not treated as migration ACK.

### Freshness hold

- Given newer visible messages exist, when agent sends a message, then the send is held with bounded context/draft behavior.
- Given newer visible messages exist, when agent claims or updates a task, then the side effect is held or preflighted.
- Given agent uses explicit send-draft/anyway path, then behavior is recorded as an explicit escape hatch.

### Thread context

- Given agent is pulled into a thread, then delivery includes bounded parent/recent context and suggested read target.
- Given agent replies to a thread message, then default target remains the thread.

### Materialization

- Agent and machine directory layouts are created with Slock-equivalent roles.
- Prompt, wrapper, token/proxy-token file, MCP config, fallback runtime session reference, trace files, and upload markers have correct roles.
- `env.json`, if present, is treated as Zano-only/local secret detail, not as required Slock v0.52.2 parity.
- Secrets are absent from prompt, logs, traces, UI-visible output, and wrapper raw text.
- Wrapper may reference token/proxy-token file paths but does not inline raw token contents.

### Prompt contract

- Prompt includes CLI-only ordinary communication, startup sequence, messaging, thread, task, mention, history/search, freshness, memory, silent-continuation, and runtime-profile control rules.

### Collaboration behavior

- Task work claims/updates task state.
- Completed work goes to `in_review` before human approval.
- Task progress goes to task thread.
- Thread replies stay in thread by default.
- Explicit `@mention` is the strong handoff protocol.
- Wake-up can lead to silence when no useful visible reply is needed.

### Non-goal enforcement

- No `daemon_dead_letters` product table is added.
- No user-facing dead-letter inbox/manual replay workflow is added.
- No ordinary chat/task MCP surface is claimed as Slock daemon parity.
- No personality/emotion system is added.

## Explicit Non-Goals

Strict parity excludes these additions:

```text
Zano-specific personality marketplace
emotion/persona system
new independent daemon dead-letter product table
user-facing dead-letter inbox/manual replay workflow
non-Slock workflow engine
ordinary collaboration MCP tools unless separately evidenced
agents directly writing DB or using Supabase credentials
full server sync of every runtime local file as product objects
random small talk to appear human
agent-authored all-agent broadcast loops
```

## Acceptance Criteria

This design is satisfied when:

1. ACK means daemon custody and no longer implies agent completion.
2. Replay/retry boundary is based on ACK ownership, without a new dead-letter product mechanism.
3. Claude busy/gated delivery follows observed Slock safe boundaries: notification before unsafe full injection, full delivery at idle/turn-end.
4. Runtime-profile migration/release controls, ACKs, prompt instructions, and reserved MCP action are modeled.
5. Freshness hold protects message send, task claim, and task update from stale side effects.
6. Thread join context gives bounded parent/recent context and suggested read target.
7. Runtime materialization creates agent and machine local state with Slock-equivalent roles, while avoiding unsupported `env.json`/runtime-session overclaims.
8. Prompt surface teaches teammate collaboration through CLI, threads, tasks, mentions, history, freshness, memory, and runtime-profile controls.
9. Agent collaboration protocol is explicit, bounded, and Slock-like, including `in_review` before `done`.
10. UI/observability labels reflect daemon/runtime truth and keep traces diagnostic.
11. Tests cover ACK, replay, gating, runtime-profile controls, freshness, thread context, materialization, prompt contract, collaboration behavior, and non-goal enforcement.
12. No extra Zano-specific workflow/dead-letter/personality layer is introduced.
