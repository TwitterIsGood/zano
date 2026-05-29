const REDACTION = "[REDACTED]";

const SECRET_KEY_PATTERN = [
  "access[-_]?token",
  "refresh[-_]?token",
  "api[-_]?key",
  "authorization",
  "supabase[-_]?key",
  "service[-_]?role(?:[-_]?key)?",
  "jwt",
  "[A-Za-z0-9_-]*token[A-Za-z0-9_-]*",
  "client[-_]?secret",
  "private[-_]?key",
  "secret",
  "password",
  "credentials?",
].join("|");

const PEM_PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(["'])(${SECRET_KEY_PATTERN})\\1(\\s*[:=]\\s*)(["'])(Bearer\\s+)?[\\s\\S]*?\\4`,
  "gi",
);
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_PATTERN})(\\s*[:=]\\s*)(Bearer\\s+)?([^\\s,;}\\]\\)]+)`,
  "gi",
);
const BEARER_VALUE_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const BARE_JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;
const BARE_SUPABASE_KEY_PATTERN = /\bsb_(?:publishable|secret|service_role)_[A-Za-z0-9_-]{8,}\b/gi;
const BARE_API_KEY_PATTERN = /\b(?:sk-ant-api\d{2}|sk|pk|rk|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{10,}\b/gi;

export function redactRuntimeText(value: string, options: { maxLength?: number } = {}): string {
  const redacted = value
    .replace(PEM_PRIVATE_KEY_BLOCK_PATTERN, REDACTION)
    .replace(
      QUOTED_SECRET_ASSIGNMENT_PATTERN,
      (_match, keyQuote: string, key: string, separator: string, valueQuote: string, bearerPrefix: string | undefined) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${bearerPrefix ?? ""}${REDACTION}${valueQuote}`,
    )
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string, bearerPrefix: string | undefined) => `${key}${separator}${bearerPrefix ?? ""}${REDACTION}`,
    )
    .replace(BEARER_VALUE_PATTERN, `$1 ${REDACTION}`)
    .replace(BARE_JWT_PATTERN, REDACTION)
    .replace(BARE_SUPABASE_KEY_PATTERN, REDACTION)
    .replace(BARE_API_KEY_PATTERN, REDACTION);

  if (options.maxLength === undefined || redacted.length <= options.maxLength) return redacted;
  return `${redacted.slice(0, options.maxLength - 1)}…`;
}

export function serializeRuntimeError(error: unknown): string {
  if (error instanceof Error) return redactRuntimeText(`${error.name}: ${error.message}`);
  if (typeof error === "string") return redactRuntimeText(error);

  try {
    return redactRuntimeText(JSON.stringify(error));
  } catch {
    return redactRuntimeText(String(error));
  }
}
