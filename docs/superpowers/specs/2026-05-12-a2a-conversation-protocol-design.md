# A2A Conversation Protocol Design

**Goal:** Define a complete, general-purpose Agent-to-Agent conversation protocol that makes AI agents behave more like human teammates in group chat while preventing duplicate work, noisy acknowledgements, and infinite response loops.

**Architecture:** Zano should treat A2A as a conversation obligation protocol, not a mention router. Omni computes candidate activations from channel context, task ownership, conversational addressability, and loop safety; the awakened agent makes the final decision to reply, work silently, observe, or skip.

**Scope:** This design covers group channels, project channels, task threads, regular threads, and DMs. It defines target-state protocol semantics; implementation may be sliced safely, but the product behavior should be designed as one coherent system rather than as temporary versions.

---

## Problem

Current A2A behavior is too binary:

- Human channel messages can wake many agents.
- Agent channel messages only wake explicitly `@mentioned` agents.
- Natural language references like “the reviewer should take another look” or “the owner needs to confirm” do not wake anyone unless formatted as an exact `@mention`.

This avoids some loops, but it does not match human group chat. Humans infer responsibility from context: who owns the work, who just spoke, who is being handed off to, who is blocking whom, and whether a message actually requires action.

The protocol should not hard-code a specific industry, role set, project type, or example conversation. It should model general collaboration semantics.

---

## Design Principles

1. **Human-like, not human-spammy**
   - Agents should understand address, responsibility, and handoff the way people do.
   - Agents should not reply merely because their name appeared.

2. **Wake eligibility is not response obligation**
   - Omni decides who may need to inspect a message.
   - The agent decides whether to reply, work silently, observe, or skip.

3. **Action beats narration**
   - A message is valuable when it reduces uncertainty, removes a blocker, delivers evidence, makes a decision, or hands off ownership.
   - Empty acknowledgements and repeated summaries should be suppressed.

4. **Ownership prevents duplicate work**
   - Once a task, blocker, review, or decision has an owner, other agents should not self-assign unless explicitly invited, ownership changes, or a new blocker appears.

5. **Loop prevention is protocol-level**
   - Avoiding loops cannot rely only on “do not broadcast agent messages.”
   - The protocol needs fanout limits, topic cooldowns, hop budgets, ownership locks, and response-value checks.

6. **Channels define social expectations**
   - DM, thread, task thread, project channel, and general channel have different expectations for reply density and relevance.

---

## Conversation Spaces

The same text means different things in different spaces.

### DM

A DM is strongly directed. The recipient agent should be activated for every new DM message and should normally choose one of:

- `REPLY_AND_WORK`
- `REPLY_ONLY`
- `WORK_SILENTLY`
- `SKIP` only when the message is clearly irrelevant, duplicated, or already resolved

DMs should not create broad fanout. If the recipient needs another agent, it should explicitly hand off in an appropriate channel or DM.

### Thread

A regular thread has strong conversational continuity. Agents should be activated when they are:

- explicitly mentioned
- the parent-message owner
- a recent participant with unresolved responsibility
- the target of a handoff in the thread

Thread replies should stay in the thread. A thread should not wake unrelated channel members just because their role is broadly relevant.

### Task Thread

A task thread has the strongest ownership semantics. Omni should consider:

- task owner
- task creator
- current reviewer/verifier if such responsibility is present
- recent blocker owner
- explicit handoff target

Task thread activity should prefer `WORK_SILENTLY` over repeated progress chatter. Agents should post visible updates when they have results, blockers, decisions, or require another person.

### Project Channel

A project channel is an active collaboration space. Omni may activate agents from:

- explicit mentions
- natural references with action semantics
- task ownership
- recent conversation responsibility
- open calls where an agent’s role is a strong fit

Project channels should support human-like handoffs without requiring perfect `@mention` syntax.

### General Channel

A general channel is low-density by default. Natural language activation should be conservative:

- explicit mentions always activate
- open calls may activate the best-fit candidates
- natural references activate only when paired with clear responsibility or action semantics
- status, acknowledgement, and chatter should not fan out

---

## Message Intent Layer

Each message should be classified by intent. A message can have multiple intents.

### Actionable Intents

- `request`: asks someone to do something
- `question`: asks for an answer or judgement
- `handoff`: transfers responsibility or asks another participant to continue
- `blocker`: identifies something preventing progress
- `decision_needed`: asks for approval, selection, or final judgement
- `review_needed`: asks for critique, validation, or acceptance
- `verification_needed`: asks for testing, evidence, or confirmation
- `correction`: redirects previous work or changes the desired behavior
- `assignment`: names an owner or expected actor
- `escalation`: asks for help because normal progress is stuck

### Informational Intents

- `status`: reports progress
- `result`: delivers outcome or evidence
- `decision`: states a decision already made
- `ack`: acknowledges receipt
- `thanks`: closes a social loop
- `chatter`: casual or non-work conversation

### Intent Rules

- Informational intent alone should not usually create A2A fanout.
- Informational intent plus a new blocker, handoff, or request can create fanout.
- Acknowledgements and thanks should not trigger natural-language A2A activation.
- A result should activate another agent only when it explicitly needs review, verification, decision, or follow-up action.

---

## Addressability Layer

Addressability answers: “Who is this message pointed at?”

Signals include:

1. **Explicit address**
   - `@handle`
   - stable agent name
   - exact display name when unambiguous

2. **Natural role/name reference**
   - a role or name appears without `@`
   - only counts strongly when paired with action semantics

3. **Second-person continuation**
   - “you”, “your”, “can you”, “please continue” in a thread or after a direct exchange
   - resolves to the previous speaker or current owner when context is clear

4. **Ownership reference**
   - a task number, thread, artifact, blocker, or decision owned by an agent is referenced

5. **Conversation continuation**
   - a message replies to an agent’s immediately prior claim, result, question, or blocker

6. **Domain fit**
   - a message asks for work that clearly belongs to a role represented in the channel
   - domain fit is weak unless paired with an open call or responsibility signal

7. **Open call**
   - “can someone”, “who can”, “need help with”, or equivalent open request
   - activates best-fit candidates, not everyone

Addressability is not obligation. It only says an agent may need to inspect the message.

---

## Obligation Layer

Obligation answers: “Who is responsible for doing something now?”

An agent has obligation when one or more of these are true:

- it is explicitly assigned or requested
- it owns the referenced task, thread, blocker, review, decision, or artifact
- it previously promised the next step
- it is the handoff target
- it is the only available or best-fit role for an open request
- another agent is blocked on it
- a human asks for its judgement
- a system event assigns work to it

An agent does not gain obligation merely because:

- its name appears in a status summary
- someone thanks it
- someone describes completed work it already reported
- a message mentions its role historically
- another agent repeats a known plan without requesting action

---

## Activation Reasons

Omni should send an activation envelope to each candidate agent. The envelope explains why the agent was awakened.

Activation reasons:

- `direct_mention`
- `dm_recipient`
- `thread_participant`
- `task_owner`
- `task_creator`
- `handoff_target`
- `blocker_owner`
- `decision_owner`
- `review_owner`
- `verification_owner`
- `natural_reference`
- `domain_fit`
- `open_call_candidate`
- `conversation_continuation`
- `system_assignment`

Each activation has strength:

- `strong`: agent is directly addressed or owns the work
- `medium`: agent is likely responsible but context has some ambiguity
- `weak`: agent may be relevant, but should usually observe unless it can add clear value

The activation envelope should include:

```text
space=<dm|thread|task_thread|project_channel|general_channel>
intent=<one or more intents>
activation_reason=<one or more reasons>
activation_strength=<strong|medium|weak>
source_message=<message id>
topic_key=<topic identifier>
hop_count=<number>
expected_decision=<agent must choose a decision mode>
loop_constraints=<cooldown / fanout / reply-value notes>
```

This gives the agent enough context to decide what to do without making Omni a full conversation actor.

---

## Candidate Selection and Fanout

### Strong Activation

Strong activation wakes all directly addressed agents, except the sender.

Examples of strong activation:

- explicit `@mention`
- DM recipient
- task owner asked to act
- handoff target
- blocker owner
- decision owner

Strong activation bypasses normal fanout caps, but agents still apply response-value rules before posting.

### Medium Activation

Medium activation wakes a small number of likely responsible agents.

Examples:

- natural role/name reference plus action intent
- thread continuation to recent participant
- open call with a clearly best-fit role
- result that requests review or verification

Medium activation should be capped:

- project channel: up to 2 natural candidates
- general channel: up to 1 natural candidate
- thread/task thread: candidates tied to the thread/task, not broad channel members

### Weak Activation

Weak activation should usually become observation, not visible speech.

Examples:

- broad domain relevance without direct request
- vague open call
- informational update relevant to a role

Weak activation should be heavily dampened in general channels and should not trigger further natural-language fanout.

---

## Agent Decision Modes

Every awakened agent must internally choose one decision mode.

### `REPLY_AND_WORK`

Use when:

- the agent is taking ownership
- another participant needs to know it is acting
- a blocker will remain ambiguous without a public response
- the work is new and visible commitment matters

Behavior:

- send a concise message with ownership and next step
- claim or update the relevant task when work requires action
- then perform the work
- report result, blocker, or review outcome when done

### `WORK_SILENTLY`

Use when:

- the agent already owns the work
- the next action is obvious from context
- a visible acknowledgement would add noise
- the task/thread state already communicates ownership

Behavior:

- do the work without sending an acknowledgement
- use tools/tasks as needed
- post only when there is a result, blocker, evidence, or handoff

### `REPLY_ONLY`

Use when:

- the message is a question
- a clarification or decision is requested
- the agent can unblock others by answering
- no task/action is required beyond communication

Behavior:

- answer directly and concisely
- do not claim work unless additional action is needed

### `OBSERVE`

Use when:

- the message is relevant to the agent’s role
- another agent owns the action
- no immediate contribution is needed
- the agent may need future context but should not interrupt

Behavior:

- do not send a message
- do not claim work
- remain available for explicit handoff, blocker, or direct request

### `SKIP`

Use when:

- the message is irrelevant
- the work is already handled
- the message is pure acknowledgement, thanks, or repeated status
- replying would not add new value

Behavior:

- send nothing
- do no work
- become idle for this topic

Agents should never send the literal word `SKIP` into chat. `SKIP` is an internal decision.

---

## Response Value Rule

Before sending any visible message, an agent must verify that the message contributes at least one of:

- new result
- new evidence
- new blocker
- new decision
- new question needed to proceed
- new ownership claim
- new handoff
- correction of a misunderstanding
- completion signal for a previously open item

Messages with only these contents should be suppressed:

- “received”
- “waiting”
- “I will keep watching”
- “sounds good”
- repeated summary of someone else’s update
- status with no changed state
- agreement without decision value

This rule is the main protection against human-like chat becoming agent spam.

---

## Loop Control

### Hop Budget

Each activation carries a hop count.

- Human-originated messages start at hop `0`.
- Agent messages caused by human-originated work increment the hop.
- Natural-language A2A activation is allowed only while hop budget remains.
- Explicit `@mention`, task assignment, human message, new blocker, or task status change can reset or extend the budget.

Default budget:

- DM: no broad A2A fanout; handoffs must be explicit
- Thread/task thread: natural continuation up to 2 hops
- Project channel: natural A2A up to 2 hops
- General channel: natural A2A up to 1 hop

### Topic Cooldown

Omni tracks recent activations by:

```text
topic_key + channel/thread + source_agent + target_agent + activation_reason
```

If the same semantic activation repeats within the cooldown window, it should be suppressed unless there is new information.

Cooldown is bypassed by:

- explicit `@mention`
- human message
- new task assignment
- new blocker
- new failed result
- ownership transfer
- requested decision

### Ownership Lock

When a work item has an owner:

- non-owners should not claim duplicate work
- non-owners may observe
- non-owners may respond only if explicitly asked, if they own a dependency, or if they detect a blocker that affects the owner

Ownership lock applies to tasks, reviews, verifications, decisions, blockers, and handoffs.

### Status Broadcast Dampening

Status messages do not trigger further A2A activation unless they include:

- a new request
- a new blocker
- a new handoff
- a decision request
- a review/verification request
- an ownership change

A status update that only says “work is ongoing” should not create another round of status updates.

### Fanout Caps

Natural-language activation must be bounded.

- Agent-authored message in project channel: at most 2 natural candidates
- Agent-authored message in general channel: at most 1 natural candidate
- Human-authored open call in project channel: at most 3 best-fit candidates
- Thread/task thread: limited to participants and owners
- Explicit mentions are not capped, but agents still apply response-value rules

### No Echo Rule

Agents should not summarize or restate another agent’s work unless:

- they are asked to synthesize
- they are the coordinator for the thread/task
- they are correcting a misunderstanding
- they are handing off to someone with a concrete next step

---

## Topic Identity

A topic key should be derived from the most stable available object:

1. task id
2. thread parent id
3. message id for direct replies
4. referenced artifact or decision id
5. normalized short subject when no structured object exists

Topic identity is used for cooldowns, ownership locks, and loop budgets. It should not be displayed as a user-facing concept unless useful for debugging.

---

## Bridge Responsibilities

Omni should:

1. Maintain channel membership and agent identity.
2. Maintain recent conversation context per channel/thread.
3. Read task ownership and task state relevant to the message.
4. Classify message space and likely intents.
5. Compute candidate activations and strengths.
6. Apply fanout caps, hop budgets, cooldowns, and ownership locks.
7. Send each awakened agent a structured activation envelope plus recent context.
8. Never require agents to visibly reply.
9. Log routing decisions for debugging: activated, suppressed, reason, strength, topic, and loop guard outcome.

Omni should not:

- hard-code project-specific role names
- force every awakened agent to speak
- create tasks on behalf of agents
- use broad agent-to-agent broadcast as the default
- treat every natural name mention as obligation

---

## Agent Responsibilities

An awakened agent should:

1. Read the activation envelope and recent context.
2. Choose a decision mode before doing anything visible.
3. If action is required, claim or reuse the correct task before working.
4. Prefer existing tasks and threads over creating duplicates.
5. Reply only when the response-value rule is satisfied.
6. Use explicit `@mention` when handing off to another agent.
7. Use threads for task-specific discussion.
8. Stop when it has no obligation, no useful message, and no work to perform.

An agent should not:

- reply with idle narration
- echo another agent’s status
- claim work owned by someone else
- create duplicate tasks for the same work
- continue a chain just because it was mentioned historically
- send literal protocol decisions like `SKIP` into chat

---

## Prompt Contract

The system prompt should teach agents the protocol directly.

When an agent receives an activation envelope, it must interpret it as:

```text
You were awakened because the conversation may involve you. You are not required to reply. First choose whether to reply and work, work silently, reply only, observe, or skip. Send a message only if it adds new value.
```

For direct mentions:

```text
You were directly addressed. If the message asks for action, claim/reuse the work and begin. If it asks a question, answer. If it is already resolved or misdirected, say so briefly only if useful.
```

For natural references:

```text
You were naturally referenced, not explicitly mentioned. Decide whether the message creates an obligation for you. If it does not, observe or skip silently.
```

For task ownership:

```text
You own or are responsible for the referenced work. Continue silently if the next action is obvious; reply only for ownership, blocker, evidence, result, decision, or handoff.
```

For broadcasts:

```text
This is a group-channel broadcast. Join only if your role is clearly needed and you can add immediate value. Otherwise skip silently.
```

---

## Visible State Semantics

The UI should eventually distinguish these states so users can understand why an agent is quiet.

### `working`

The agent is executing visible work, using tools, claiming/updating tasks, or preparing a result.

### `working_silently`

The agent has obligation and is acting without posting an acknowledgement.

### `observing`

The agent was contextually activated but decided not to intervene because another owner is handling the work.

### `blocked`

The agent cannot proceed without another participant, missing environment, missing decision, or failed dependency.

### `idle`

The agent has no current obligation and no useful action for the active topic.

This distinction matters because silence can mean “I am working,” “I am watching,” or “this is not mine.”

---

## Expected Behavior Examples

These examples are intentionally generic and not tied to one industry or team type.

### Direct Handoff

Message:

```text
The implementation is complete; reviewer should check the risk section before we close this.
```

Protocol outcome:

- `reviewer` role candidate is activated with `handoff_target` or `review_needed`.
- The responsible reviewer role chooses `WORK_SILENTLY` if it can review immediately.
- The responsible reviewer role posts only when it has findings, approval, or a blocker.

### Status Without Action

Message:

```text
The verifier already completed the smoke check and found no issue.
```

Protocol outcome:

- Verifier may be naturally referenced.
- No action intent exists.
- Bridge suppresses activation or agent chooses `SKIP`.

### Open Call

Message:

```text
Can someone inspect why the import flow is timing out?
```

Protocol outcome:

- Bridge activates the best-fit candidate agents based on domain and availability, capped by channel policy.
- First agent to claim becomes owner.
- Others observe and do not duplicate work unless requested.

### Blocker Handoff

Message:

```text
I cannot finish this until the data owner confirms whether field X is required.
```

Protocol outcome:

- Data owner is activated as `blocker_owner` or `decision_owner` if identifiable.
- If not identifiable, coordinator or best-fit owner may be activated.
- The blocked agent should not keep posting “waiting” messages.

### Noisy Chain Suppression

Message sequence:

```text
A: I will review it.
B: Sounds good.
C: Agreed.
```

Protocol outcome:

- `B` and `C` messages are `ack`/`thanks` style.
- They do not create new natural activations.
- No agent responds unless directly asked.

---

## Debugging and Observability

Routing decisions must be inspectable. For each message, Omni should be able to log:

- message id
- channel/thread id
- sender type and id
- detected space
- detected intents
- candidate agents
- activation reasons
- activation strengths
- suppressed candidates with suppression reason
- fanout cap result
- cooldown result
- hop budget result
- final awakened agents

Example log shape:

```json
{
  "messageId": "...",
  "space": "project_channel",
  "intents": ["handoff", "review_needed"],
  "topicKey": "task:123",
  "activated": [
    { "agentId": "...", "reason": "review_owner", "strength": "strong" }
  ],
  "suppressed": [
    { "agentId": "...", "reason": "ownership_lock" }
  ],
  "hopCount": 1
}
```

This makes A2A behavior debuggable without relying on guesswork.

---

## Success Criteria

The protocol succeeds when:

1. Explicit `@mentions` still reliably wake the intended agents.
2. Clear natural-language handoffs wake the responsible agents even without perfect `@mention` syntax.
3. Pure status summaries do not trigger response chains.
4. Open calls wake a bounded set of best-fit agents rather than everyone.
5. Owned tasks do not produce duplicate work from other agents.
6. Agents can work silently without posting empty acknowledgements.
7. Agents can observe without interfering.
8. Agent-to-agent chains terminate without needing human cleanup.
9. Users can understand whether an agent is working, observing, blocked, or idle.
10. The protocol remains general across different domains, team structures, and role names.

---

## Non-Goals

- This protocol does not require hard-coded business-domain vocabulary.
- This protocol does not make every agent message a broadcast.
- This protocol does not require every natural language mention to wake someone.
- This protocol does not replace task claiming or task ownership.
- This protocol does not force agents to post acknowledgements.
- This protocol does not rely on a single coordinator agent to make normal group chat work.

---

## Design Decision

Zano should implement A2A as a layered conversation obligation protocol:

1. classify conversation space
2. classify message intent
3. determine addressability
4. determine obligation
5. compute bounded candidate activation
6. send structured activation envelopes
7. let agents choose reply/work/observe/skip
8. enforce loop controls
9. expose enough state and logs for humans to understand agent silence

This gives AI agents a human-like group chat model without allowing the channel to devolve into infinite agent chatter.
