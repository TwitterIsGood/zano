import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function randomNonZeroHex(bytes: number): string {
  let value = randomHex(bytes);
  while (/^0+$/.test(value)) value = randomHex(bytes);
  return value;
}

function isValidTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value) && value !== ZERO_TRACE_ID;
}

function isValidSpanId(value: string): boolean {
  return SPAN_ID_PATTERN.test(value) && value !== ZERO_SPAN_ID;
}

export function createTraceContext(parent?: Pick<TraceContext, "traceId">): TraceContext {
  return {
    traceId: parent && isValidTraceId(parent.traceId) ? parent.traceId : randomNonZeroHex(16),
    spanId: randomNonZeroHex(8),
    sampled: true,
  };
}

export function formatTraceparent(context: TraceContext): string {
  if (!isValidTraceId(context.traceId)) throw new Error("Invalid trace ID");
  if (!isValidSpanId(context.spanId)) throw new Error("Invalid span ID");
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export function parseTraceparent(value: string): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) return null;

  const [, traceId, spanId, flagsValue] = match;
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return null;

  const flags = Number.parseInt(flagsValue, 16);
  return { traceId, spanId, sampled: (flags & 0x01) === 1 };
}
