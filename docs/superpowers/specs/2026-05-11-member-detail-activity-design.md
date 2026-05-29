# Member Detail and Activity Design

## Goal

Clicking an Agent or Human should show a member detail page in the main content area instead of opening messages immediately. The detail page uses this project's existing UI style while matching the reference app's information structure where the data exists.

The Message action switches the same main area into the member's DM conversation. It does not navigate away from the member context, and the selected member remains highlighted in the sidebar.

## Scope

In scope:

- Agent and Human member detail views.
- Sidebar Humans section.
- Member detail tabs: Profile, Activity, Workspace, Tasks.
- Full persisted activity history for Agents and Humans.
- Agent DM switching from the detail page.
- Human-to-human DM lookup/creation for messaging other humans.
- Self-profile support for the current Human, with self-DM prevented.
- Consistent member selection/highlighting across detail and DM views.

Out of scope:

- Copying the reference app's visual style.
- Showing placeholder sections where this project has no data.
- Human workspace support unless a real human workspace data source is later added.

## Navigation and Sidebar

Agents and Humans are treated as selectable members.

- The existing Agents section remains in the sidebar.
- A new Humans section lists server members from `server_members` joined with `profiles`.
- Clicking an Agent row opens that Agent's detail view in the main area.
- Clicking a Human row opens that Human's detail view in the main area.
- The member row stays highlighted both when showing the detail view and when showing the DM view.
- Agent rows no longer default to DM navigation.

The main area owns a local view mode:

- `detail`: default member detail view.
- `message`: DM message view for the selected member.

The Message button switches from `detail` to `message`.

Human Message behavior:

- Current user: show the current user's profile; prevent self-DM with a clear disabled-state explanation.
- Other human: find or create the human-to-human DM channel, then show the DM message view.

## Member Detail Layout

Use existing project UI primitives: `GeneratedAvatar`, buttons, badges, cards, tabs, status dots, and scroll areas. Do not imitate the reference app's brutalist styling.

Header:

- Avatar.
- Display name.
- Handle, such as `@BackendEngineer` or `@biangbbt-wua`.
- Member type/status badges.
- Right-side actions:
  - Message.
  - Agent-specific actions only when backed by existing capabilities.

Tabs:

- Profile.
- Activity.
- Workspace when the member has a real workspace source.
- Tasks.

Tabs with no backing data source should be omitted rather than shown as empty shells.

## Profile Tab

Agent profile fields:

- Display name.
- Description.
- Status and live activity.
- Runtime.
- Model.
- Computer / daemon information when available.
- Created date.
- Creator when available.
- Environment variables when available.

Human profile fields:

- Display name.
- Email.
- Created date.
- Current-user marker when applicable.
- Server membership information when available.

Sections are shown only when data exists.

## Activity Persistence

The project currently has no central persisted activity feed. Agent runtime activity is broadcast-only, and Human activity is scattered across messages and task tables.

Add an append-only `member_activity_events` table to support full member activity history.

### Event Coverage

Message and thread events:

- Channel message sent.
- DM message sent.
- Thread reply sent.
- Thread resolved.
- Thread reopened.

Task events:

- Task created.
- Task claimed.
- Task unclaimed.
- Task status changed.
- Task metadata updated.
- Task commented on.
- Task artifact added.
- Task reviewed.
- Task verified, where existing verification data supports it.

Agent runtime events:

- Agent started.
- Agent received message.
- Agent thinking.
- Agent working.
- Agent tool use.
- Agent output.
- Agent idle.
- Agent error.
- Agent disconnected.
- Agent status changed.

Membership and lifecycle events:

- Server joined.
- Channel joined.
- Agent created.
- Agent updated.
- Agent reset.
- Agent deleted.
- Human profile changed, where existing update paths support it.

### Recording Strategy

Use database triggers for durable writes that already happen from multiple paths:

- `messages insert`.
- `messages update` for thread resolution changes.
- `channel_members insert`.
- `server_members insert`.
- `task_comments insert`.
- `task_artifacts insert`.
- `task_reviews insert`.
- `agents update of status`.

Use explicit inserts for semantic actions that need richer event labels or are not consistently represented by one table write:

- Task create.
- Task claim.
- Task unclaim.
- Task metadata update.
- Agent reset.
- Agent delete.

Record Agent runtime events in Omni near the existing `broadcastActivity()` path. Keep realtime broadcasts for live UI, but also write meaningful activity rows.

Do not persist heartbeat rebroadcasts as separate rows. Persist real state changes and meaningful tool/output/error events to avoid noise.

### Data Model

`member_activity_events` should include enough context to render member timelines and link back to source objects.

Recommended fields:

- `id`.
- `server_id`.
- `channel_id`.
- `actor_id`.
- `actor_type`: `human`, `agent`, `system`, or `bridge`.
- `event_type`.
- `subject_type`.
- `subject_id`.
- `target_id`.
- `target_type`.
- `message_id`.
- `thread_parent_id`.
- `task_id`.
- `agent_id`.
- `label`.
- `summary`.
- `metadata`.
- `visibility`.
- `dedupe_key`.
- `occurred_at`.
- `created_at`.

Indexes should support querying by:

- Member actor and recent time.
- Server and recent time.
- Channel.
- Task.
- Agent.
- Event type.

The table should be included in Supabase Realtime so the Activity tab can update live.

## Activity Tab

The Activity tab uses one shared timeline component for Agents and Humans.

Query:

- `actor_type = selected member type`.
- `actor_id = selected member id`.
- Ordered by `occurred_at desc`.

Each event row shows:

- Time.
- Type icon or label.
- Title, such as `Running command`, `Sent message`, or `Commented on task`.
- Summary.
- Optional link to the source message, thread, task, channel, or agent.

Agent pages also show current live activity at the top before the history timeline.

Empty state: `No activity yet`.

## Workspace Tab

Workspace is available for Agents only when backed by the existing workspace API.

- Reuse `/api/agents/[id]/workspace`.
- Reuse and adapt existing workspace browser behavior from `AgentSettingsPanel`.
- Show a full-width file browser and preview.
- Provide retry on load failure.
- Do not show Workspace for Humans unless a real human workspace source is added.

## Tasks Tab

The Tasks tab shows tasks related to the selected member.

A task is related when the member is:

- Assignee.
- Creator.
- Event actor.
- Comment author.
- Artifact author.
- Reviewer or verifier where those fields exist.

The list shows:

- Title.
- Status.
- Priority.
- Current gate when available.
- Updated time.

Clicking a task opens the existing task detail drawer.

## DM Switching

The detail page's Message button resolves a DM channel and switches the main area to the message view.

Agents:

- Existing Agent DMs are created when the Agent is created.
- The Message button finds the Agent DM channel and renders `MessageArea`.

Humans:

- Add `POST /api/channels/dm`.
- The endpoint accepts a target human ID.
- It verifies both users are server members.
- It returns an existing DM channel if one exists.
- Otherwise, it creates a DM channel and inserts both human channel members.
- It rejects self-DM.

The message view includes a way to return to the member detail view.

## API and Data Loading

Needed new or expanded APIs:

- Sidebar/server data should include human members.
- Member detail data endpoint or server-side loader for Agent/Human profile data.
- Activity events endpoint, or direct Supabase client query if RLS supports it.
- Member-related tasks endpoint or expanded tasks query.
- Human-to-human DM lookup/create endpoint.

Existing APIs to reuse:

- `/api/agents/[id]` for Agent details.
- `/api/agents/[id]/workspace` for Agent workspace.
- Existing task detail APIs and drawer.
- Existing messages and DM `MessageArea` rendering.

## Error Handling

- Missing member: show a not-found state in the main area.
- Workspace unavailable: show a compact error with retry.
- Activity unavailable: show an error state with retry.
- Message target is self: disable Message with explanation.
- DM creation fails: show a user-visible error and remain on detail view.

## Testing Strategy

Automated tests should cover:

- Activity table recording for message, task, thread, membership, and Agent status events.
- Human-to-human DM creation and existing DM reuse.
- Self-DM rejection.
- Sidebar rendering with Agents and Humans.
- Member selection/highlight behavior in detail and message modes.
- Member detail tabs appearing only when backed by data.
- Activity feed query and rendering for Agent and Human members.

Manual UI verification should cover:

- Clicking Agent opens detail instead of DM.
- Message switches to Agent DM.
- Clicking Human opens detail.
- Clicking another Human's Message creates/opens DM.
- Current user's Message is prevented.
- Activity events appear after sending messages, replying in threads, changing tasks, and running Agent activity.
- Workspace tab loads files for Agents and is omitted for Humans.
