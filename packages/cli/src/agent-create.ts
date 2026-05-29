export interface AgentCreateResult {
  created?: boolean;
  denied?: boolean;
  reason?: string;
  agent_id?: string;
  agent_name?: string;
  display_name?: string;
  channel_id?: string;
  parent_agent_id?: string;
  idempotent?: boolean;
}

export interface AgentCreatePayload {
  p_display_name: string;
  p_description: string | null;
  p_system_prompt: string | null;
  p_reason: string;
  p_parent_agent_id: string | null;
  p_source_refs: Array<{ type: string; id: string }>;
  p_creation_context: Record<string, unknown>;
  p_server_id: string | null;
  p_idempotency_key: string | null;
}

const secretLikePattern = /\b(?:api[_-]?key|auth[_-]?token|agent[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{12,})\b/i;

function assertNoSecretLikeValue(flagName: string, value: string | null | undefined) {
  if (value && secretLikePattern.test(value)) {
    throw new Error(`Secret-like value not allowed in ${flagName}`);
  }
}

export function parseSourceRefs(values: string[] = []): Array<{ type: string; id: string }> {
  return values.map((value) => {
    assertNoSecretLikeValue("--source", value);
    const [type, ...rest] = value.split(":");
    const id = rest.join(":");
    if (!type || !id) throw new Error(`Invalid --source value: ${value}`);
    return { type, id };
  });
}

export function formatAgentCreateResult(result: AgentCreateResult): string[] {
  if (result.denied || result.created === false) {
    throw new Error(`Agent creation denied: ${result.reason ?? "policy_denied"}`);
  }

  const label = result.display_name ?? result.agent_name ?? result.agent_id;
  const lines = [
    `${result.idempotent ? "Agent reused" : "Agent created"}: ${label}`,
    `Agent ID: ${result.agent_id}`,
  ];

  if (result.channel_id) lines.push(`DM channel: ${result.channel_id}`);
  if (result.parent_agent_id) lines.push(`Parent agent: ${result.parent_agent_id}`);
  if (result.idempotent) lines.push("Idempotent: reused existing child agent");

  return lines;
}

export function buildAgentCreatePayload(flags: Record<string, string>): AgentCreatePayload {
  const displayName = flags["display-name"]?.trim();
  if (!displayName) throw new Error("Missing --display-name");

  const description = flags.description?.trim() || null;
  const systemPrompt = flags["system-prompt"]?.trim() || null;
  const reason = flags.reason?.trim();
  if (!reason) throw new Error("Missing --reason");

  assertNoSecretLikeValue("--display-name", displayName);
  assertNoSecretLikeValue("--description", description);
  assertNoSecretLikeValue("--system-prompt", systemPrompt);
  assertNoSecretLikeValue("--reason", reason);

  const sourceValues = Object.entries(flags)
    .filter(([key]) => key === "source" || key.startsWith("source_"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
  if (sourceValues.length === 0) throw new Error("Missing --source");

  return {
    p_display_name: displayName,
    p_description: description,
    p_system_prompt: systemPrompt,
    p_reason: reason,
    p_parent_agent_id: flags["parent-agent-id"] || null,
    p_source_refs: parseSourceRefs(sourceValues),
    p_creation_context: {},
    p_server_id: flags["server-id"] || null,
    p_idempotency_key: flags["idempotency-key"] || null,
  };
}
