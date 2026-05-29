import { describe, expect, it } from "vitest";
import { mapClaudeStreamJsonToGatedEvent } from "./claude-stream-events";
import { redactRuntimeText } from "./redaction";

describe("Claude stream event mapping", () => {
  it("maps assistant text and thinking to continuation", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })).toEqual({ type: "assistant_text" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "work" }] } })).toEqual({ type: "assistant_thinking" });
  });

  it("maps tool use and tool result boundaries", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } })).toEqual({ type: "tool_call", toolUseId: "tool-1" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } })).toEqual({ type: "tool_result", toolUseId: "tool-1" });
  });

  it("maps compaction, turn end, and runtime error", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "system", subtype: "compacting" })).toEqual({ type: "compaction_started" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "system", subtype: "compacted" })).toEqual({ type: "compaction_finished" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "result", subtype: "success" })).toEqual({ type: "turn_end" });
    expect(mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message: "thinking cannot be modified after redacted_thinking" } })).toEqual({
      type: "runtime_error",
      message: "thinking cannot be modified after redacted_thinking",
    });
  });

  it("maps top-level runtime error messages", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "error", message: "top-level failure" })).toEqual({
      type: "runtime_error",
      message: "top-level failure",
    });
  });

  it("redacts secrets from top-level runtime error messages", () => {
    const event = mapClaudeStreamJsonToGatedEvent({ type: "error", message: "failed with access_token=top-secret-value" });

    expect(event).toEqual({ type: "runtime_error", message: "failed with access_token=[REDACTED]" });
    expect(JSON.stringify(event)).not.toContain("top-secret-value");
  });

  it("redacts bare JWT-like values from runtime error messages", () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIiLCJyb2xlIjoiYWdlbnQifQ.fakeSignaturePlaceholder";

    const event = mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message: `runtime failed with ${fakeJwt} while handling stdin` } });

    expect(event).toEqual({ type: "runtime_error", message: "runtime failed with [REDACTED] while handling stdin" });
    expect(JSON.stringify(event)).not.toContain(fakeJwt);
  });

  it("redacts quoted multiline private-key values from runtime error messages", () => {
    const fakePem = "-----BEGIN PRIVATE KEY-----\nfake-private-key-line\nfake-private-key-tail\n-----END PRIVATE KEY-----";

    const event = mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message: `{"private_key":"${fakePem}","safe":"ok"}` } });

    expect(event).toEqual({ type: "runtime_error", message: '{"private_key":"[REDACTED]","safe":"ok"}' });
    expect(JSON.stringify(event)).not.toContain("fake-private-key-line");
    expect(JSON.stringify(event)).not.toContain("fake-private-key-tail");
    expect(JSON.stringify(event)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("redacts bare Supabase and API-key-like token values with the shared helper", () => {
    const fakeSupabaseToken = "sb_secret_fake_placeholder_value_1234567890";
    const fakeApiKey = "sk-ant-api03-fakePlaceholderValue1234567890";

    const redacted = redactRuntimeText(`tokens ${fakeSupabaseToken} ${fakeApiKey}`);

    expect(redacted).toBe("tokens [REDACTED] [REDACTED]");
    expect(redacted).not.toContain(fakeSupabaseToken);
    expect(redacted).not.toContain(fakeApiKey);
  });

  it("redacts secrets from runtime error messages", () => {
    const cases = [
      ["access_token=secret-value cannot be modified", "access_token=[REDACTED] cannot be modified", "secret-value"],
      ["password: hunter2", "password: [REDACTED]", "hunter2"],
      ["Authorization: Bearer auth-secret", "Authorization: Bearer [REDACTED]", "auth-secret"],
      ["api-key: api-secret", "api-key: [REDACTED]", "api-secret"],
      ["refresh_token: refresh-secret", "refresh_token: [REDACTED]", "refresh-secret"],
      ["clientSecret=client-secret", "clientSecret=[REDACTED]", "client-secret"],
      ["privateKey=private-secret", "privateKey=[REDACTED]", "private-secret"],
      ["serviceRoleKey=service-secret", "serviceRoleKey=[REDACTED]", "service-secret"],
      ["credentials: creds-secret", "credentials: [REDACTED]", "creds-secret"],
      ["jwt: Bearer jwt-secret", "jwt: Bearer [REDACTED]", "jwt-secret"],
      ["supabase_key = supabase-secret", "supabase_key = [REDACTED]", "supabase-secret"],
      ["service-role-key: service-kebab-secret", "service-role-key: [REDACTED]", "service-kebab-secret"],
      ["service_role_key: service-snake-secret", "service_role_key: [REDACTED]", "service-snake-secret"],
      ["client_secret: client-snake-secret", "client_secret: [REDACTED]", "client-snake-secret"],
      ["private_key: private-snake-secret", "private_key: [REDACTED]", "private-snake-secret"],
      ["private-key=private-secret", "private-key=[REDACTED]", "private-secret"],
      ['{"private-key":"private-secret"}', '{"private-key":"[REDACTED]"}', "private-secret"],
      ['{"private_key":"private-secret"}', '{"private_key":"[REDACTED]"}', "private-secret"],
      ['{"privateKey":"private-secret"}', '{"privateKey":"[REDACTED]"}', "private-secret"],
      ['{"private-key" : "private-secret"}', '{"private-key" : "[REDACTED]"}', "private-secret"],
      ["private-key: -----BEGINPRIVATEKEY-----", "private-key: [REDACTED]", "BEGINPRIVATEKEY"],
    ] as const;

    for (const [message, expectedMessage, rawSecret] of cases) {
      const event = mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message } });

      expect(event).toEqual({ type: "runtime_error", message: expectedMessage });
      expect(JSON.stringify(event)).not.toContain(rawSecret);
    }
  });

  it("truncates long runtime error messages", () => {
    const event = mapClaudeStreamJsonToGatedEvent({ type: "error", error: { message: `failed: ${"x".repeat(600)}` } });

    expect(event).toEqual({ type: "runtime_error", message: `${"failed: "}${"x".repeat(491)}…` });
  });

  it("ignores unrelated stream events", () => {
    expect(mapClaudeStreamJsonToGatedEvent({ type: "system", subtype: "init" })).toBeNull();
  });
});
