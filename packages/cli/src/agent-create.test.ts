import { describe, expect, it } from "vitest";
import { buildAgentCreatePayload, formatAgentCreateResult, parseSourceRefs } from "./agent-create";

describe("agent create payload", () => {
  it("requires display name and reason", () => {
    expect(() => buildAgentCreatePayload({})).toThrow("Missing --display-name");
    expect(() => buildAgentCreatePayload({ "display-name": "Browser QA" })).toThrow("Missing --reason");
  });

  it("builds child creation payload", () => {
    expect(buildAgentCreatePayload({
      "display-name": "Browser QA",
      description: "Validate browser behavior",
      reason: "Task #72 needs independent QA",
      "system-prompt": "Focus on browser evidence.",
      source: "task:72",
      "idempotency-key": "task-72-browser-qa",
    })).toEqual({
      p_display_name: "Browser QA",
      p_description: "Validate browser behavior",
      p_system_prompt: "Focus on browser evidence.",
      p_reason: "Task #72 needs independent QA",
      p_source_refs: [{ type: "task", id: "72" }],
      p_creation_context: {},
      p_parent_agent_id: null,
      p_server_id: null,
      p_idempotency_key: "task-72-browser-qa",
    });
  });

  it("requires at least one source ref", () => {
    expect(() => buildAgentCreatePayload({
      "display-name": "Browser QA",
      reason: "Task #72 needs independent QA",
    })).toThrow("Missing --source");
  });

  it("rejects secret-like child profile fields", () => {
    expect(() => buildAgentCreatePayload({
      "display-name": "agent_token=fake-secret-token-for-task-4",
      reason: "Task #72 needs independent QA",
      source: "task:72",
    })).toThrow("Secret-like value not allowed in --display-name");
  });

  it("parses multiple source refs", () => {
    expect(parseSourceRefs(["task:72", "channel:glass-easel-web"])).toEqual([
      { type: "task", id: "72" },
      { type: "channel", id: "glass-easel-web" },
    ]);
  });

  it("formats successful creation output", () => {
    expect(formatAgentCreateResult({
      agent_id: "agent-1",
      agent_name: "BrowserQA",
      display_name: "Browser QA",
      channel_id: "channel-1",
      parent_agent_id: "parent-1",
    })).toEqual([
      "Agent created: Browser QA",
      "Agent ID: agent-1",
      "DM channel: channel-1",
      "Parent agent: parent-1",
    ]);
  });

  it("formats minimal idempotent reuse without undefined fields", () => {
    expect(formatAgentCreateResult({
      agent_id: "agent-1",
      idempotent: true,
    })).toEqual([
      "Agent reused: agent-1",
      "Agent ID: agent-1",
      "Idempotent: reused existing child agent",
    ]);
  });

  it("rejects denied creation results", () => {
    expect(() => formatAgentCreateResult({
      created: false,
      denied: true,
      reason: "rate_limit",
      parent_agent_id: "parent-1",
    })).toThrow("Agent creation denied: rate_limit");
  });
});
