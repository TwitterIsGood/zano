export type RuntimeProfileControlKind = "migration" | "daemon_release_notice";

export interface RuntimeProfileControl {
  type: "agent:runtime_profile:migration" | "agent:runtime_profile:daemon_release_notice";
  agentId: string;
  key: string;
  requiresAck: boolean;
}

export interface RuntimeProfileControlAck {
  type: "agent:runtime_profile:migration:ack" | "agent:runtime_profile:daemon_release_notice:ack";
  agentId: string;
  key: string;
}

export const RUNTIME_PROFILE_CONTROLS_PROMPT_BLOCK = `## Runtime Profile Controls

If the daemon delivers a runtime-profile migration notice, stop ordinary inbox handling long enough to re-ground in the new runtime context.
Call the reserved MCP action \`runtime_profile_migration_done\` with the exact migration key from the notice.
Do not acknowledge migration completion with \`zano message send\`, task updates, or a normal chat reply.
Daemon release notices are runtime notices; follow the notice text and only ACK through the reserved control path when the notice requires it.`;

export function buildRuntimeProfileControlsPromptBlock(): string {
  return RUNTIME_PROFILE_CONTROLS_PROMPT_BLOCK;
}

export function createRuntimeProfileControl(input: { agentId: string; kind: RuntimeProfileControlKind; key: string }): RuntimeProfileControl {
  return {
    type: input.kind === "migration" ? "agent:runtime_profile:migration" : "agent:runtime_profile:daemon_release_notice",
    agentId: input.agentId,
    key: input.key,
    requiresAck: input.kind === "migration",
  };
}

export function observeRuntimeProfileMigrationDone(
  control: RuntimeProfileControl,
  toolCall: { toolName: string; arguments: Record<string, unknown> },
): RuntimeProfileControlAck | null {
  if (control.type !== "agent:runtime_profile:migration") return null;
  if (toolCall.toolName !== "runtime_profile_migration_done") return null;
  if (toolCall.arguments.key !== control.key) return null;
  return { type: "agent:runtime_profile:migration:ack", agentId: control.agentId, key: control.key };
}

export function isRuntimeProfileControlAck(value: unknown): value is RuntimeProfileControlAck {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "agent:runtime_profile:migration:ack" || type === "agent:runtime_profile:daemon_release_notice:ack";
}
