import { describe, expect, it } from "vitest";
import { findSingleOtherDmMember } from "./channel-display";

describe("DM channel display", () => {
  it("returns the other member for a two-member DM", () => {
    expect(findSingleOtherDmMember("agent-1", [
      { member_id: "agent-1", member_type: "agent" },
      { member_id: "agent-2", member_type: "agent" },
    ])).toEqual({ member_id: "agent-2", member_type: "agent" });
  });

  it("does not pick an arbitrary name for a multi-member DM", () => {
    expect(findSingleOtherDmMember("agent-1", [
      { member_id: "agent-1", member_type: "agent" },
      { member_id: "human-1", member_type: "human" },
      { member_id: "agent-2", member_type: "agent" },
    ])).toBeNull();
  });
});
