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
