import { describe, expect, it } from "vitest";

import { resolveLatestAgentActivities } from "./latest-agent-activities";

const NOW = Date.parse("2026-05-27T17:50:00.000Z");

function activityRow(overrides: Partial<Parameters<typeof resolveLatestAgentActivities>[0][number]> = {}) {
  return {
    actor_id: "agent-1",
    event_type: "agent.tool_use",
    label: "Running command",
    summary: "zano task list --channel \"#glass-easel-web\"",
    occurred_at: "2026-05-27T17:45:43.334Z",
    created_at: "2026-05-27T17:45:43.334Z",
    channel_id: null,
    message_id: null,
    thread_parent_id: null,
    task_id: null,
    ...overrides,
  };
}

function sessionRow(overrides: Partial<Parameters<typeof resolveLatestAgentActivities>[1][number]> = {}) {
  return {
    agent_id: "agent-1",
    state: "ready",
    started_at: "2026-05-27T17:00:00.000Z",
    last_active_at: "2026-05-27T17:45:24.797Z",
    idle_at: null,
    ended_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("resolveLatestAgentActivities", () => {
  it("does not revive stale tool-use events as running commands", () => {
    const activities = resolveLatestAgentActivities(
      [activityRow()],
      [sessionRow()],
      NOW,
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      agentId: "agent-1",
      activity: "idle",
      label: "Idle",
      detail: "",
    });
  });

  it("keeps fresh tool-use events visible as running commands", () => {
    const activities = resolveLatestAgentActivities(
      [activityRow({ occurred_at: "2026-05-27T17:49:30.000Z" })],
      [sessionRow()],
      NOW,
    );

    expect(activities[0]).toMatchObject({
      agentId: "agent-1",
      activity: "working",
      label: "Running command",
      detail: "zano task list --channel \"#glass-easel-web\"",
    });
  });

  it("preserves channel scope from fresh activity events", () => {
    const activities = resolveLatestAgentActivities(
      [activityRow({
        occurred_at: "2026-05-27T17:49:30.000Z",
        channel_id: "channel-1",
        message_id: "message-1",
        thread_parent_id: null,
        task_id: "task-1",
      })],
      [],
      NOW,
    );

    expect(activities[0]).toMatchObject({
      agentId: "agent-1",
      activity: "working",
      channelId: "channel-1",
      sourceMessageId: "message-1",
      taskId: "task-1",
    });
  });

  it("does not keep stale busy runtime sessions active forever", () => {
    const activities = resolveLatestAgentActivities(
      [],
      [sessionRow({ state: "busy", last_active_at: "2026-05-27T17:35:00.000Z" })],
      NOW,
    );

    expect(activities[0]).toMatchObject({
      agentId: "agent-1",
      activity: "idle",
      label: "Idle",
      detail: "",
    });
  });

  it("keeps recent busy runtime sessions active", () => {
    const activities = resolveLatestAgentActivities(
      [],
      [sessionRow({ state: "busy", last_active_at: "2026-05-27T17:49:30.000Z" })],
      NOW,
    );

    expect(activities[0]).toMatchObject({
      agentId: "agent-1",
      activity: "working",
      label: "Working",
    });
  });
});
