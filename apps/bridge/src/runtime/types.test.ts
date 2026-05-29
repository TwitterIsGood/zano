import { describe, expect, it } from "vitest";
import {
  DELIVERY_TERMINAL_STATES,
  DELIVERY_TRANSITIONS,
  buildDeliveryIdempotencyKey,
  canTransitionDelivery,
  isDeliveryAckState,
  isOrdinaryDeliveryCompletionState,
  isRecoverableDeliveryState,
  redactTraceAttributes,
  type DeliveryState,
} from "./types";

describe("delivery state transitions", () => {
  it("allows planned deliveries to enter the runtime", () => {
    expect(canTransitionDelivery("planned", "received")).toBe(true);
  });

  it("allows received deliveries to enter daemon custody", () => {
    expect(DELIVERY_TRANSITIONS.received).toEqual(["accepted", "failed", "cancelled"]);
  });

  it("rejects transitions out of terminal states", () => {
    for (const state of DELIVERY_TERMINAL_STATES) {
      expect(canTransitionDelivery(state, "received")).toBe(false);
    }
  });

  it("treats accepted as daemon custody rather than business completion", () => {
    expect(canTransitionDelivery("received", "accepted")).toBe(true);
    expect(canTransitionDelivery("accepted", "queued_starting")).toBe(true);
    expect(canTransitionDelivery("accepted", "queued_busy")).toBe(true);
    expect(canTransitionDelivery("accepted", "queued_gated")).toBe(true);
    expect(canTransitionDelivery("accepted", "queued_compaction")).toBe(true);
    expect(canTransitionDelivery("accepted", "delivering")).toBe(true);
    expect(canTransitionDelivery("accepted", "completed")).toBe(false);
  });

  it("keeps completed as legacy derived evidence only", () => {
    expect(isDeliveryAckState("accepted")).toBe(true);
    expect(isDeliveryAckState("delivered")).toBe(true);
    expect(isDeliveryAckState("completed")).toBe(false);
    expect(isOrdinaryDeliveryCompletionState("completed")).toBe(false);
  });

  it("marks only queued and restart states as recoverable", () => {
    const recoverable: DeliveryState[] = ["queued_starting", "queued_busy", "queued_gated", "queued_compaction", "restarting_idle", "delivering"];
    const nonRecoverable: DeliveryState[] = ["planned", "deduped", "completed", "failed", "cancelled"];

    for (const state of recoverable) expect(isRecoverableDeliveryState(state)).toBe(true);
    for (const state of nonRecoverable) expect(isRecoverableDeliveryState(state)).toBe(false);
  });
});

describe("delivery idempotency", () => {
  it("uses source message, agent, target, and sorted reasons", () => {
    expect(
      buildDeliveryIdempotencyKey({
        sourceMessageId: "msg-1",
        agentId: "agent-1",
        target: "#general",
        activationReasons: ["domain_fit", "direct_mention"],
      }),
    ).toBe(JSON.stringify(["msg-1", "agent-1", "#general", ["direct_mention", "domain_fit"]]));
  });

  it("ignores duplicate activation reasons when building keys", () => {
    const withoutDuplicate = buildDeliveryIdempotencyKey({
      sourceMessageId: "msg-1",
      agentId: "agent-1",
      target: "#general",
      activationReasons: ["domain_fit", "direct_mention"],
    });

    const withDuplicate = buildDeliveryIdempotencyKey({
      sourceMessageId: "msg-1",
      agentId: "agent-1",
      target: "#general",
      activationReasons: ["domain_fit", "direct_mention", "domain_fit"],
    });

    expect(withDuplicate).toBe(withoutDuplicate);
  });

  it("keeps delimiter-containing values distinct from semantically different inputs", () => {
    const keyWithDelimiterInTarget = buildDeliveryIdempotencyKey({
      sourceMessageId: "msg-1",
      agentId: "agent-1",
      target: "#general:agent-2",
      activationReasons: ["direct_mention"],
    });

    const keyWithDelimiterInAgent = buildDeliveryIdempotencyKey({
      sourceMessageId: "msg-1",
      agentId: "agent-1:#general",
      target: "agent-2",
      activationReasons: ["direct_mention"],
    });

    expect(keyWithDelimiterInTarget).not.toBe(keyWithDelimiterInAgent);
  });
});

describe("trace redaction", () => {
  it("redacts known secret-bearing attributes recursively", () => {
    expect(
      redactTraceAttributes({
        apiKey: "zk_secret",
        token: "jwt_secret",
        nested: { authorization: "Bearer secret", safe: "visible" },
        list: [{ supabaseKey: "anon_secret" }, "ok"],
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
      list: [{ supabaseKey: "[REDACTED]" }, "ok"],
    });
  });

  it("redacts nested local state secret attributes", () => {
    expect(
      redactTraceAttributes({
        oauth: { refreshToken: "r", clientSecret: "c" },
        privateKey: "k",
        credentials: { value: "v" },
        accessToken: "a",
        credential: "single",
      }),
    ).toEqual({
      oauth: { refreshToken: "[REDACTED]", clientSecret: "[REDACTED]" },
      privateKey: "[REDACTED]",
      credentials: "[REDACTED]",
      accessToken: "[REDACTED]",
      credential: "[REDACTED]",
    });
  });

  it("replaces cyclic attributes with a circular marker", () => {
    const attributes: Record<string, unknown> = { safe: "visible" };
    attributes.self = attributes;

    expect(redactTraceAttributes(attributes)).toEqual({
      safe: "visible",
      self: "[Circular]",
    });
  });
});
