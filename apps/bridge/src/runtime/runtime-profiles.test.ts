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

  it("freezes profiles returned by lookup so callers cannot mutate shared state", () => {
    const profile = getRuntimeDriverProfile("claude");

    expect(Object.isFrozen(profile)).toBe(true);
    expect(() => {
      (profile as { busyDeliveryMode: string }).busyDeliveryMode = "direct";
    }).toThrow(TypeError);
    expect(getRuntimeDriverProfile("claude").busyDeliveryMode).toBe("gated");
  });

  it("returns a fresh list array containing frozen profiles", () => {
    const profiles = listRuntimeDriverProfiles();
    const nextProfiles = listRuntimeDriverProfiles();

    expect(profiles).not.toBe(nextProfiles);
    expect(profiles.every((profile) => Object.isFrozen(profile))).toBe(true);
    profiles.pop();
    expect(listRuntimeDriverProfiles()).toHaveLength(7);
  });
});
