import type { RuntimeDriverProfile, RuntimeKind } from "./types";

function freezeRuntimeDriverProfile(profile: RuntimeDriverProfile): RuntimeDriverProfile {
  return Object.freeze(profile);
}

export const CLAUDE_RUNTIME_PROFILE: RuntimeDriverProfile = freezeRuntimeDriverProfile({
  runtime: "claude",
  lifecycle: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "gated",
  supportsNativeStandingPrompt: true,
  terminateProcessOnTurnEnd: false,
});

const RUNTIME_DRIVER_PROFILES: Readonly<Record<RuntimeKind, RuntimeDriverProfile>> = Object.freeze({
  claude: CLAUDE_RUNTIME_PROFILE,
  codex: freezeRuntimeDriverProfile({
    runtime: "codex",
    lifecycle: "persistent",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: false,
  }),
  kimi: freezeRuntimeDriverProfile({
    runtime: "kimi",
    lifecycle: "persistent",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: false,
  }),
  copilot: freezeRuntimeDriverProfile({
    runtime: "copilot",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  }),
  cursor: freezeRuntimeDriverProfile({
    runtime: "cursor",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  }),
  gemini: freezeRuntimeDriverProfile({
    runtime: "gemini",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  }),
  opencode: freezeRuntimeDriverProfile({
    runtime: "opencode",
    lifecycle: "per_turn",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    supportsNativeStandingPrompt: false,
    terminateProcessOnTurnEnd: true,
  }),
});

export function getRuntimeDriverProfile(runtime: RuntimeKind): RuntimeDriverProfile {
  return RUNTIME_DRIVER_PROFILES[runtime];
}

export function listRuntimeDriverProfiles(): RuntimeDriverProfile[] {
  return Object.values(RUNTIME_DRIVER_PROFILES);
}
