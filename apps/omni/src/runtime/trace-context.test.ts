import { describe, expect, it } from "vitest";
import { createTraceContext, formatTraceparent, parseTraceparent } from "./trace-context";

describe("trace context", () => {
  it("creates W3C-style traceparent values", () => {
    const context = createTraceContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(formatTraceparent(context)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("creates a new trace ID when parent trace ID is invalid", () => {
    const context = createTraceContext({ traceId: "00000000000000000000000000000000" });

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.traceId).not.toBe("00000000000000000000000000000000");
  });

  it("parses traceparent values", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("parses non-01 trace flags and derives sampling from the low bit", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceparent("bad")).toBeNull();
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });

  it("throws when formatting invalid trace IDs or span IDs", () => {
    expect(() =>
      formatTraceparent({ traceId: "00000000000000000000000000000000", spanId: "00f067aa0ba902b7", sampled: true }),
    ).toThrow(Error);
    expect(() =>
      formatTraceparent({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "0000000000000000", sampled: true }),
    ).toThrow(Error);
  });
});
