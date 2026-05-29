#!/usr/bin/env node

/**
 * Zano CLI — The command-line tool agents use to communicate with Zano.
 *
 * Auth uses local runtime references materialized by the bridge:
 *   ZANO_AGENT_ID              — UUID of the agent
 *   ZANO_SERVER_URL            — Supabase project URL
 *   ZANO_AGENT_TOKEN_FILE      — agent actor token file
 *   ZANO_AGENT_PROXY_TOKEN_FILE — local proxy token file
 *
 * Usage:
 *   zano message send --target "#general" <<'EOF'
 *   Hello everyone!
 *   EOF
 *   zano message check
 *   zano message read --channel "#general"
 *   zano message search --query "keyword"
 *   zano server info
 *   zano task list --channel "#general"
 *   zano task create --channel "#general" --title "Fix the bug"
 *   zano task claim --number 3
 *   zano task unclaim --number 3
 *   zano task verify --number 3 --type test --check "pnpm test" --passed --summary "All tests pass"
 *   zano task update --number 3 --status done
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { buildAgentCreatePayload, formatAgentCreateResult, type AgentCreateResult } from "./agent-create";
import { findSingleOtherDmMember } from "./channel-display";
import { evaluateFreshnessPreflight, saveHeldDraft, validateSafeDraftId, type FreshnessAction, type FreshnessMessage } from "./freshness";
import { readAgentLocalState } from "./local-state";
import { findDisallowedTaskReferenceShorthand, taskReferenceRewriteMessage } from "./message-format";
import { parseTargetAddress } from "./target";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
  process.exit(1);
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function readCredentialFile(path: string | undefined, label: string): string | undefined {
  if (!path) return undefined;

  try {
    const value = readFileSync(path, "utf8").trim();
    if (!value) fail("EMPTY_CREDENTIAL_FILE", `${label} is empty`);
    return value;
  } catch {
    fail("CREDENTIAL_FILE_READ_FAILED", `${label} could not be read`);
  }
}

const AGENT_ID = process.env.ZANO_AGENT_ID;
const SUPABASE_URL = firstPresent(process.env.ZANO_SERVER_URL, process.env.ZANO_SUPABASE_URL);
const AGENT_TOKEN_FILE = process.env.ZANO_AGENT_TOKEN_FILE;
const AGENT_PROXY_TOKEN_FILE = process.env.ZANO_AGENT_PROXY_TOKEN_FILE;
const SUPABASE_KEY_FILE = process.env.ZANO_SUPABASE_KEY_FILE;
const AGENT_LOCAL_STATE = process.env.ZANO_AGENT_LOCAL_STATE;
const AGENT_TOKEN = readCredentialFile(AGENT_TOKEN_FILE, "ZANO_AGENT_TOKEN_FILE");
const PROXY_TOKEN = readCredentialFile(AGENT_PROXY_TOKEN_FILE, "ZANO_AGENT_PROXY_TOKEN_FILE");
const FILE_SUPABASE_KEY = readCredentialFile(SUPABASE_KEY_FILE, "ZANO_SUPABASE_KEY_FILE");
const LEGACY_AUTH_TOKEN = process.env.ZANO_AUTH_TOKEN;
const LEGACY_AGENT_AUTH_TOKEN = process.env.ZANO_AGENT_AUTH_TOKEN;
const AUTH_TOKEN = firstPresent(AGENT_TOKEN, PROXY_TOKEN, LEGACY_AUTH_TOKEN);
const ACTOR_AUTH_TOKEN = firstPresent(AGENT_TOKEN, PROXY_TOKEN, LEGACY_AGENT_AUTH_TOKEN, LEGACY_AUTH_TOKEN);
const SUPABASE_KEY = firstPresent(FILE_SUPABASE_KEY, process.env.ZANO_SUPABASE_KEY, ACTOR_AUTH_TOKEN, AUTH_TOKEN);

if (!AGENT_ID) fail("MISSING_AGENT_ID", "ZANO_AGENT_ID is not set");
if (!SUPABASE_URL) fail("MISSING_SERVER_URL", "ZANO_SERVER_URL is not set");
if (!SUPABASE_KEY) fail("MISSING_CREDENTIAL", "ZANO_AGENT_TOKEN_FILE or ZANO_AGENT_PROXY_TOKEN_FILE is not set");

const REQUIRED_AGENT_ID: string = AGENT_ID;
const REQUIRED_SUPABASE_URL: string = SUPABASE_URL;
const REQUIRED_SUPABASE_KEY: string = SUPABASE_KEY;

function createZanoClient(authToken?: string): SupabaseClient {
  return createClient(REQUIRED_SUPABASE_URL, REQUIRED_SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(authToken
      ? { global: { headers: { Authorization: `Bearer ${authToken}` } } }
      : {}),
  });
}

const supabase = createZanoClient(AUTH_TOKEN);
const actorSupabase = createZanoClient(ACTOR_AUTH_TOKEN);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

function validateVisibleMessageContent(content: string): void {
  const shorthand = findDisallowedTaskReferenceShorthand(content);
  if (!shorthand) return;

  fail("MESSAGE_FORMAT_REWRITE_REQUIRED", taskReferenceRewriteMessage(shorthand));
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const positional: string[] = [];
  const greedyFlags = new Set([
    "body",
    "check",
    "command",
    "description",
    "display-name",
    "name",
    "name-template",
    "query",
    "rationale",
    "reason",
    "summary",
    "subject",
    "system-prompt",
    "title",
    "trigger",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      let val = "true";
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        val = args[++i];
        if (greedyFlags.has(key)) {
          while (args[i + 1] && !args[i + 1].startsWith("--")) {
            val += ` ${args[++i]}`;
          }
        }
      }
      counts[key] = (counts[key] ?? 0) + 1;
      result[counts[key] > 1 ? `${key}_${counts[key]}` : key] = val;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length > 0) result._ = positional.join(" ");
  return result;
}

function collectFlagValues(flags: Record<string, string>, key: string): string[] {
  return Object.entries(flags)
    .filter(([flag]) => flag === key || flag.startsWith(`${key}_`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}

interface TaskDependencyEdge {
  predecessorTaskId: string;
  successorTaskId: string;
}

type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "changes_requested"
  | "done"
  | "archived";

type ReminderState = "pending" | "snoozed" | "firing" | "fired" | "completed" | "cancelled" | "failed";

interface TaskTransitionContext {
  hasBlockingDependencies: boolean;
  hasPassingVerification: boolean;
  requiresReview: boolean;
  hasPassingRequiredReview: boolean;
}

const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "blocked", "archived"],
  in_progress: ["blocked", "in_review", "done", "changes_requested", "archived"],
  blocked: ["todo", "in_progress", "archived"],
  in_review: ["changes_requested", "done", "archived"],
  changes_requested: ["in_progress", "blocked", "archived"],
  done: ["archived"],
  archived: [],
};

function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  context: TaskTransitionContext
): { allowed: boolean; reason?: string } {
  if (!allowedTransitions[from]?.includes(to)) {
    return { allowed: false, reason: `Invalid transition from ${from} to ${to}` };
  }

  if ((to === "in_progress" || to === "todo") && context.hasBlockingDependencies) {
    return { allowed: false, reason: "Task has unresolved blocking dependencies" };
  }

  if (to === "done") {
    if (!context.hasPassingVerification) {
      return { allowed: false, reason: "Task needs passing verification evidence" };
    }

    if (context.requiresReview && !context.hasPassingRequiredReview) {
      return { allowed: false, reason: "Task requires review before completion" };
    }
  }

  return { allowed: true };
}

function isTaskStatus(status: string): status is TaskStatus {
  return status in allowedTransitions;
}

function taskMissingVerificationMessage(taskNumber: number) {
  return `Task needs passing verification evidence. Record it first with: zano task verify --number ${taskNumber} --type test --check "what you ran or inspected" --passed --summary "result"; then retry: zano task update --number ${taskNumber} --status done. Review/comment text alone does not satisfy the done gate.`;
}

function hasDependencyCycle(edges: TaskDependencyEdge[]): boolean {
  const graph = new Map<string, string[]>();

  for (const edge of edges) {
    const existing = graph.get(edge.predecessorTaskId) ?? [];
    existing.push(edge.successorTaskId);
    graph.set(edge.predecessorTaskId, existing);

    if (!graph.has(edge.successorTaskId)) {
      graph.set(edge.successorTaskId, []);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;

    visiting.add(node);

    for (const next of graph.get(node) ?? []) {
      if (visit(next)) return true;
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (visit(node)) return true;
  }

  return false;
}

function shortId(uuid: string): string {
  return uuid.replace(/-/g, "").substring(0, 8);
}

function fmtTime(iso: string): string {
  return iso.replace(/\.\d+\+/, "+").replace(/\+00:00$/, "Z");
}

type JsonObject = Record<string, unknown>;

interface ActorClaims {
  actor_id?: string;
  actor_type?: string;
  server_id?: string;
  sub?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtClaims(token?: string): ActorClaims {
  if (!token) return {};

  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (!isRecord(decoded)) return {};

    return {
      actor_id: typeof decoded.actor_id === "string" ? decoded.actor_id : undefined,
      actor_type: typeof decoded.actor_type === "string" ? decoded.actor_type : undefined,
      server_id: typeof decoded.server_id === "string" ? decoded.server_id : undefined,
      sub: typeof decoded.sub === "string" ? decoded.sub : undefined,
    };
  } catch {
    return {};
  }
}

const DELIVERY_ID = process.env.ZANO_DELIVERY_ID;
const DELIVERY_SEQ = process.env.ZANO_DELIVERY_SEQ;
const TRACEPARENT = process.env.ZANO_TRACEPARENT;

function readCurrentDeliveryFromLocalState(): JsonObject {
  const localDelivery = readAgentLocalState(AGENT_LOCAL_STATE).currentDelivery;
  return isRecord(localDelivery) ? localDelivery : {};
}

function parseDeliverySeq(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function deliveryContextMetadata(): JsonObject {
  const localDelivery = (!DELIVERY_ID || !DELIVERY_SEQ || !TRACEPARENT)
    ? readCurrentDeliveryFromLocalState()
    : {};
  const deliveryId = DELIVERY_ID ?? (typeof localDelivery.deliveryId === "string" ? localDelivery.deliveryId : undefined);
  const deliverySeq = DELIVERY_SEQ ? Number(DELIVERY_SEQ) : parseDeliverySeq(localDelivery.deliverySeq);
  const traceparent = TRACEPARENT ?? (typeof localDelivery.traceparent === "string" ? localDelivery.traceparent : undefined);

  return {
    ...(deliveryId ? { delivery_id: deliveryId } : {}),
    ...(deliverySeq !== undefined ? { delivery_seq: deliverySeq } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

function withDaemonMetadata(existingMetadata: JsonObject = {}): JsonObject {
  const daemon = deliveryContextMetadata();
  return Object.keys(daemon).length === 0
    ? existingMetadata
    : { ...existingMetadata, daemon };
}

const ACTOR_CLAIMS = decodeJwtClaims(ACTOR_AUTH_TOKEN);

function currentActorId(): string {
  return ACTOR_CLAIMS.actor_id ?? ACTOR_CLAIMS.sub ?? REQUIRED_AGENT_ID;
}

function currentActorType(): string {
  return ACTOR_CLAIMS.actor_type ?? "agent";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseConfidence(value: string | undefined): number {
  if (!value) return 0.7;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    fail("INVALID_ARG", "--confidence must be a number between 0 and 1");
  }
  return parsed;
}

function parseJsonFlag(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    fail("INVALID_JSON", `Invalid JSON: ${value}`);
  }
}

function parseJsonObjectFlag(value: string | undefined, fallback: JsonObject = {}): JsonObject {
  const parsed = parseJsonFlag(value, fallback);
  if (!isRecord(parsed)) {
    fail("INVALID_JSON", "Expected a JSON object");
  }
  return parsed;
}

function parseEvidenceRefs(flags: Record<string, string>, key = "evidence"): unknown[] {
  return collectFlagValues(flags, key).map((value) => {
    try {
      return JSON.parse(value);
    } catch {
      return { ref: value };
    }
  });
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicAgentHandle(displayName: string, fallback = "Agent") {
  const handle = displayName
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
  return handle || fallback;
}

async function resolveAutonomousServerId(flags: Record<string, string>): Promise<string> {
  if (flags["server-id"]) return flags["server-id"];
  if (ACTOR_CLAIMS.server_id) return ACTOR_CLAIMS.server_id;

  const { data, error } = await supabase
    .from("agents")
    .select("server_id")
    .eq("id", AGENT_ID)
    .single();

  if (error || !data?.server_id) {
    fail("SERVER_RESOLVE_FAILED", error?.message ?? "Cannot resolve server_id for this agent");
  }

  return data.server_id;
}

// ---------------------------------------------------------------------------
// Target Resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  channelId: string;
  threadParentId: string | null;
}

/**
 * Resolve a target string to a channel_id (and optional thread parent).
 *
 * Formats:
 *   #channel-name           → public/private channel by name
 *   #channel-name:shortid   → thread in that channel
 *   dm:@person-name         → DM channel with that person
 *   dm:@person-name:shortid → thread in DM
 *   raw-uuid                → channel by ID
 */
async function resolveTarget(target: string): Promise<ResolvedTarget> {
  const { channelPart, threadShortId } = parseTargetAddress(target);

  // Resolve channel
  let channelId: string;
  if (channelPart.startsWith("dm:@")) {
    const personName = channelPart.slice(4);
    channelId = await resolveDmChannel(personName);
  } else if (channelPart.startsWith("#")) {
    const channelName = channelPart.slice(1);
    channelId = await resolveChannelByName(channelName);
  } else {
    channelId = channelPart;
  }

  // Resolve thread parent if present
  let threadParentId: string | null = null;
  if (threadShortId) {
    threadParentId = await resolveMessageByShortId(channelId, threadShortId);
  }

  return { channelId, threadParentId };
}

async function resolveChannelByName(name: string): Promise<string> {
  const { data, error } = await supabase
    .from("channels")
    .select("id")
    .eq("name", name)
    .single();

  if (error || !data) {
    fail("RESOLVE_FAILED", `Cannot resolve channel #${name}`);
  }
  return data.id;
}

async function resolveDmChannel(personName: string): Promise<string> {
  // Find the person (could be human or agent)
  let personId: string | null = null;

  // Try profiles first
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("display_name", personName)
    .single();

  if (profile) {
    personId = profile.id;
  } else {
    const { data: agents } = await supabase
      .from("agents")
      .select("id, display_name, name");

    const agent = (agents ?? []).find(
      (candidate) =>
        candidate.display_name === personName ||
        candidate.name === personName ||
        publicAgentHandle(candidate.display_name, candidate.name) === personName,
    );

    if (agent) {
      personId = agent.id;
    }
  }

  if (!personId) {
    fail("RESOLVE_FAILED", `Cannot find user or agent: ${personName}`);
  }

  // Find DM channel where both agent and person are members
  const { data: agentChannels } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID);

  const { data: personChannels } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", personId);

  if (!agentChannels || !personChannels) {
    fail("RESOLVE_FAILED", `Cannot find DM channel with ${personName}`);
  }

  const agentSet = new Set(agentChannels.map((c) => c.channel_id));
  const common = personChannels
    .map((c) => c.channel_id)
    .filter((id) => agentSet.has(id));

  // Check which of the common channels is a DM
  for (const chId of common) {
    const { data: ch } = await supabase
      .from("channels")
      .select("id, type")
      .eq("id", chId)
      .eq("type", "dm")
      .single();

    if (ch) return ch.id;
  }

  fail("RESOLVE_FAILED", `No DM channel found with ${personName}`);
}

async function resolveMessageByShortId(
  channelId: string,
  shortid: string
): Promise<string> {
  // Short ID is first 8 chars of UUID without dashes
  // Query messages in channel and match
  const { data: messages } = await supabase
    .from("messages")
    .select("id")
    .eq("channel_id", channelId)
    .is("thread_parent_id", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (messages) {
    for (const m of messages) {
      if (shortId(m.id) === shortid) return m.id;
    }
  }

  fail("RESOLVE_FAILED", `Cannot find message with short ID: ${shortid}`);
}

// ---------------------------------------------------------------------------
// Sender Name Resolution
// ---------------------------------------------------------------------------

const nameCache = new Map<string, string>();

async function resolveSenderName(
  senderId: string,
  senderType: string
): Promise<string> {
  if (nameCache.has(senderId)) return nameCache.get(senderId)!;

  let name = "Unknown";
  if (senderType === "agent") {
    const { data } = await supabase
      .from("agents")
      .select("display_name, name")
      .eq("id", senderId)
      .single();
    if (data) name = publicAgentHandle(data.display_name, data.name);
  } else if (senderType === "human") {
    const { data } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", senderId)
      .single();
    if (data) name = data.display_name;
  } else {
    name = "System";
  }

  nameCache.set(senderId, name);
  return name;
}

// ---------------------------------------------------------------------------
// Channel Name Resolution
// ---------------------------------------------------------------------------

async function resolveChannelDisplay(channelId: string): Promise<string> {
  const { data: ch } = await supabase
    .from("channels")
    .select("name, type")
    .eq("id", channelId)
    .single();

  if (!ch) return channelId;

  if (ch.type === "dm") {
    // Find the other member
    const { data: members } = await supabase
      .from("channel_members")
      .select("member_id, member_type")
      .eq("channel_id", channelId);

    if (members) {
      const other = findSingleOtherDmMember(REQUIRED_AGENT_ID, members);
      if (other) {
        const name = await resolveSenderName(other.member_id, other.member_type);
        return `dm:@${name}`;
      }
      return channelId;
    }
    return `dm:${ch.name}`;
  }

  return `#${ch.name}`;
}

// ---------------------------------------------------------------------------
// Message Formatting
// ---------------------------------------------------------------------------

async function formatMessage(msg: {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  thread_parent_id: string | null;
  created_at: string;
}): Promise<string> {
  const channelDisplay = await resolveChannelDisplay(msg.channel_id);
  const senderName = await resolveSenderName(msg.sender_id, msg.sender_type);
  const time = fmtTime(msg.created_at);
  const sid = shortId(msg.id);

  let target = channelDisplay;
  if (msg.thread_parent_id) {
    target += `:${shortId(msg.thread_parent_id)}`;
  }

  return `[target=${target} msg=${sid} time=${time} type=${msg.sender_type}] @${senderName}: ${msg.content}`;
}

// ---------------------------------------------------------------------------
// Last-Checked Tracking
// ---------------------------------------------------------------------------

function getLastCheckedPath(): string {
  return join(process.cwd(), ".zano", "last-checked");
}

function getLastChecked(): string | null {
  const p = getLastCheckedPath();
  if (existsSync(p)) {
    return readFileSync(p, "utf-8").trim();
  }
  return null;
}

function setLastChecked(ts: string) {
  const p = getLastCheckedPath();
  writeFileSync(p, ts, "utf-8");
}

function agentStateDir(): string {
  return dirname(AGENT_LOCAL_STATE ?? join(process.cwd(), ".zano", "state.json"));
}

function flagEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

async function fetchNewerVisibleMessages(input: {
  channelId: string;
  threadParentId: string | null;
  after: string | null;
  limit: number;
}): Promise<FreshnessMessage[]> {
  if (!input.after) return [];

  let query = supabase
    .from("messages")
    .select("id,sender_id,sender_type,content,created_at")
    .eq("channel_id", input.channelId)
    .neq("sender_id", AGENT_ID)
    .gt("created_at", input.after);

  query = input.threadParentId ? query.eq("thread_parent_id", input.threadParentId) : query.is("thread_parent_id", null);

  const { data, error } = await query.order("created_at", { ascending: true }).limit(input.limit);
  if (error) fail("FRESHNESS_CHECK_FAILED", error.message);

  return Promise.all((data ?? []).map(async (message) => ({
    id: message.id,
    sender: `@${await resolveSenderName(message.sender_id, message.sender_type)}`,
    createdAt: message.created_at,
    text: message.content,
  })));
}

async function runFreshnessPreflight(input: {
  action: FreshnessAction;
  target: string;
  channelId: string;
  threadParentId: string | null;
  text?: string;
  anyway: boolean;
}): Promise<boolean> {
  const localState = readAgentLocalState(AGENT_LOCAL_STATE);
  const lastSeenMessageCreatedAt = localState.freshness?.[input.target]?.lastSeenMessageCreatedAt
    ?? localState.currentDelivery?.messageCreatedAt
    ?? null;
  const newerMessages = await fetchNewerVisibleMessages({
    channelId: input.channelId,
    threadParentId: input.threadParentId,
    after: lastSeenMessageCreatedAt,
    limit: 10,
  });
  const freshness = evaluateFreshnessPreflight({
    action: input.action,
    target: input.target,
    lastSeenMessageCreatedAt,
    newerMessages,
    anyway: input.anyway,
  });
  if (freshness.state === "allowed") return true;

  const draft = input.action === "message_send" && input.text !== undefined
    ? saveHeldDraft({ stateDir: agentStateDir(), target: input.target, text: input.text, reason: "freshness" })
    : null;
  console.log(JSON.stringify({ ...freshness, ...(draft ? { draftId: draft.id, draftPath: draft.path } : {}) }, null, 2));
  process.exitCode = 2;
  return false;
}

function readHeldDraft(id: string): { target: string; text: string } {
  try {
    validateSafeDraftId(id);
  } catch {
    fail("DRAFT_INVALID", "Held draft id is invalid");
  }

  const path = join(agentStateDir(), ".zano-drafts", `${id}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed.target !== "string" || typeof parsed.text !== "string") {
      fail("DRAFT_INVALID", "Held draft is invalid");
    }
    return { target: parsed.target, text: parsed.text };
  } catch (error) {
    if (error instanceof SyntaxError) fail("DRAFT_INVALID", "Held draft is invalid JSON");
    fail("DRAFT_NOT_FOUND", `Held draft not found: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdDaemonStatus() {
  const { data: deliveries, error: deliveryError } = await actorSupabase
    .from("daemon_deliveries")
    .select("id,state,agent_id,delivery_seq,updated_at")
    .order("updated_at", { ascending: false })
    .limit(10);
  if (deliveryError) fail("DAEMON_STATUS_FAILED", deliveryError.message);

  const { data: sessions, error: sessionError } = await actorSupabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,state,machine_id,session_id,last_active_at")
    .order("started_at", { ascending: false })
    .limit(10);
  if (sessionError) fail("DAEMON_STATUS_FAILED", sessionError.message);

  console.log(JSON.stringify({ ok: true, deliveries: deliveries ?? [], sessions: sessions ?? [] }, null, 2));
}

async function cmdDaemonDeliveries(flags: Record<string, string>) {
  let query = actorSupabase
    .from("daemon_deliveries")
    .select("id,agent_id,source_message_id,state,delivery_seq,traceparent,target,last_error,updated_at")
    .order("updated_at", { ascending: false })
    .limit(Number(flags.limit ?? 20));
  if (flags.agent) query = query.eq("agent_id", flags.agent);
  if (flags.state) query = query.eq("state", flags.state);
  if (flags.message) query = query.eq("source_message_id", flags.message);

  const { data, error } = await query;
  if (error) fail("DAEMON_DELIVERIES_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, deliveries: data ?? [] }, null, 2));
}

async function cmdDaemonTraces(flags: Record<string, string>) {
  const traceId = flags.trace;
  if (!traceId) fail("INVALID_ARG", "Missing --trace");
  const { data, error } = await actorSupabase
    .from("daemon_trace_events")
    .select("trace_id,span_id,delivery_id,agent_id,event_type,event_name,severity,attributes,created_at")
    .eq("trace_id", traceId)
    .order("created_at", { ascending: true });
  if (error) fail("DAEMON_TRACES_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, events: data ?? [] }, null, 2));
}

async function cmdAgentSessions(flags: Record<string, string>) {
  const agentId = flags.agent ?? REQUIRED_AGENT_ID;
  const { data, error } = await actorSupabase
    .from("daemon_runtime_sessions")
    .select("id,agent_id,machine_id,runtime,runtime_model,session_id,process_id,state,prompt_hash,wrapper_hash,started_at,last_active_at,idle_at,ended_at,last_error")
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(Number(flags.limit ?? 20));
  if (error) fail("AGENT_SESSIONS_FAILED", error.message);
  console.log(JSON.stringify({ ok: true, sessions: data ?? [] }, null, 2));
}

async function cmdAgentLocalState() {
  const localState = process.env.ZANO_AGENT_LOCAL_STATE ?? null;
  console.log(JSON.stringify({ ok: true, localState }, null, 2));
}

async function sendMessageToTarget(target: string, content: string): Promise<void> {
  const { channelId, threadParentId } = await resolveTarget(target);

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content,
      thread_parent_id: threadParentId,
    })
    .select("id")
    .single();

  if (error) fail("SEND_FAILED", error.message);

  if (threadParentId) {
    await supabase.from("thread_participants").upsert({
      thread_parent_id: threadParentId,
      participant_id: AGENT_ID,
      participant_type: "agent",
      last_read_at: new Date().toISOString(),
    });
  }

  const sid = shortId(data.id);
  console.log(`Message sent to ${target}. Message ID: ${sid}`);
}

async function cmdMessageSend(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const content = await readStdin();
  if (!content) fail("INVALID_ARG", "Message content must be provided via stdin");
  validateVisibleMessageContent(content);

  const { channelId, threadParentId } = await resolveTarget(target);
  const fresh = await runFreshnessPreflight({
    action: "message_send",
    target,
    channelId,
    threadParentId,
    text: content,
    anyway: flagEnabled(flags.anyway),
  });
  if (!fresh) return;

  await sendMessageToTarget(target, content);
}

async function cmdMessageSendDraft(flags: Record<string, string>) {
  const draftId = flags._;
  if (!draftId) fail("INVALID_ARG", "Missing draft id");
  const draft = readHeldDraft(draftId);
  validateVisibleMessageContent(draft.text);
  const { channelId, threadParentId } = await resolveTarget(draft.target);
  const fresh = await runFreshnessPreflight({
    action: "message_send",
    target: draft.target,
    channelId,
    threadParentId,
    text: draft.text,
    anyway: flagEnabled(flags.anyway),
  });
  if (!fresh) return;

  await sendMessageToTarget(draft.target, draft.text);
}

async function cmdMessageCheck() {
  // Get channels where this agent is a member
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  if (!memberships || memberships.length === 0) {
    console.log("No new messages.");
    return;
  }

  const channelIds = memberships.map((m) => m.channel_id);

  // Get messages since last check
  const lastChecked = getLastChecked();
  let query = supabase
    .from("messages")
    .select("*")
    .in("channel_id", channelIds)
    .neq("sender_id", AGENT_ID)
    .order("created_at", { ascending: true });

  if (lastChecked) {
    query = query.gt("created_at", lastChecked);
  } else {
    // First check — only get last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    query = query.gt("created_at", fiveMinAgo);
  }

  const { data: messages } = await query.limit(50);

  if (!messages || messages.length === 0) {
    console.log("No new messages.");
  } else {
    for (const msg of messages) {
      console.log(await formatMessage(msg));
    }
  }

  // Update last-checked timestamp
  setLastChecked(new Date().toISOString());
}

async function cmdMessageRead(flags: Record<string, string>) {
  const channel = flags.channel;
  if (!channel) fail("INVALID_ARG", "Missing --channel");

  const { channelId, threadParentId } = await resolveTarget(channel);
  const limit = flags.limit ? parseInt(flags.limit) : 20;

  let query = supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (threadParentId) {
    query = query.eq("thread_parent_id", threadParentId);
  } else {
    query = query.is("thread_parent_id", null);
  }

  // Pagination
  if (flags.before) {
    query = query.lt("created_at", flags.before);
  }
  if (flags.after) {
    query = query.gt("created_at", flags.after);
  }

  // Around: get messages centered around a specific message
  if (flags.around) {
    const targetMsg = await findMessageById(channelId, flags.around);
    if (targetMsg) {
      const half = Math.floor(limit / 2);
      const { data: before } = await supabase
        .from("messages")
        .select("*")
        .eq("channel_id", channelId)
        .lte("created_at", targetMsg.created_at)
        .order("created_at", { ascending: false })
        .limit(half);

      const { data: after } = await supabase
        .from("messages")
        .select("*")
        .eq("channel_id", channelId)
        .gt("created_at", targetMsg.created_at)
        .order("created_at", { ascending: true })
        .limit(half);

      const all = [...(before || []).reverse(), ...(after || [])];
      for (const msg of all) {
        console.log(await formatMessage(msg));
      }
      return;
    }
  }

  const { data: messages } = await query;

  if (!messages || messages.length === 0) {
    console.log("No messages found.");
    return;
  }

  // Print in chronological order
  for (const msg of messages.reverse()) {
    console.log(await formatMessage(msg));
  }
}

async function findMessageById(
  channelId: string,
  idOrShort: string
): Promise<{ id: string; created_at: string } | null> {
  // Try as full UUID first
  if (idOrShort.length > 8) {
    const { data } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", idOrShort)
      .single();
    return data;
  }

  // Try as short ID
  const { data: messages } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (messages) {
    for (const m of messages) {
      if (shortId(m.id) === idOrShort) return m;
    }
  }
  return null;
}

async function cmdMessageSearch(flags: Record<string, string>) {
  const query = flags.query;
  if (!query) fail("INVALID_ARG", "Missing --query");

  // Get agent's channels
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  if (!memberships || memberships.length === 0) {
    console.log("No results.");
    return;
  }

  const channelIds = memberships.map((m) => m.channel_id);
  const limit = flags.limit ? parseInt(flags.limit) : 20;

  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .in("channel_id", channelIds)
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!messages || messages.length === 0) {
    console.log("No results.");
    return;
  }

  for (const msg of messages.reverse()) {
    console.log(await formatMessage(msg));
  }
}

async function cmdServerInfo() {
  // Get agent's channels
  const { data: memberships } = await supabase
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", AGENT_ID)
    .eq("member_type", "agent");

  const myChannelIds = new Set(
    (memberships || []).map((m) => m.channel_id)
  );

  // Get all visible channels
  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, description, type")
    .order("name");

  console.log("## Channels");
  if (channels) {
    for (const ch of channels) {
      if (ch.type === "dm") continue; // Skip DM channels in listing
      const joined = myChannelIds.has(ch.id);
      const desc = ch.description ? ` — ${ch.description}` : "";
      console.log(
        `  #${ch.name} (${ch.type}, joined=${joined})${desc}`
      );
    }
  }

  // Get all agents
  const { data: agents } = await supabase
    .from("agents")
    .select("name, display_name, status, description")
    .order("name");

  console.log("\n## Agents");
  if (agents) {
    for (const ag of agents) {
      const desc = ag.description ? ` — ${ag.description}` : "";
      console.log(`  @${publicAgentHandle(ag.display_name, ag.name)} (${ag.status})${desc}`);
    }
  }

  // Get all humans
  const { data: humans } = await supabase
    .from("profiles")
    .select("display_name, email")
    .order("display_name");

  console.log("\n## Humans");
  if (humans) {
    for (const h of humans) {
      console.log(`  @${h.display_name}`);
    }
  }
}

async function cmdThreadList(flags: Record<string, string>) {
  const channel = flags.channel;
  if (!channel) fail("INVALID_ARG", "Missing --channel");

  const { channelId } = await resolveTarget(channel);
  const { data: threads, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .is("thread_parent_id", null)
    .gt("reply_count", 0)
    .order("last_reply_at", { ascending: false });

  if (error) fail("THREAD_LIST_FAILED", error.message);
  if (!threads || threads.length === 0) {
    console.log("No threads.");
    return;
  }

  const channelDisplay = await resolveChannelDisplay(channelId);
  for (const thread of threads) {
    const sender = await resolveSenderName(thread.sender_id, thread.sender_type);
    const resolved = thread.thread_resolved_at ? " resolved" : "";
    console.log(
      `[target=${channelDisplay}:${shortId(thread.id)} replies=${thread.reply_count ?? 0}${resolved} time=${fmtTime(thread.last_reply_at ?? thread.created_at)}] @${sender}: ${thread.content}`
    );
  }
}

async function cmdThreadRead(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const { channelId, threadParentId } = await resolveTarget(target);
  if (!threadParentId) fail("INVALID_ARG", "Target must include a thread message ID");

  const { data: parent, error: parentError } = await supabase
    .from("messages")
    .select("*")
    .eq("id", threadParentId)
    .single();
  if (parentError || !parent) fail("THREAD_READ_FAILED", parentError?.message ?? "Thread not found");

  console.log(await formatMessage(parent));

  const { data: replies, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .eq("thread_parent_id", threadParentId)
    .order("created_at", { ascending: true });

  if (error) fail("THREAD_READ_FAILED", error.message);
  for (const reply of replies ?? []) {
    console.log(await formatMessage(reply));
  }
}

async function cmdThreadReply(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const content = await readStdin();
  if (!content) fail("INVALID_ARG", "Reply content must be provided via stdin");
  validateVisibleMessageContent(content);

  const { channelId, threadParentId } = await resolveTarget(target);
  if (!threadParentId) fail("INVALID_ARG", "Target must include a thread message ID");

  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content,
      thread_parent_id: threadParentId,
    })
    .select("id")
    .single();

  if (error) fail("THREAD_REPLY_FAILED", error.message);

  await supabase.from("thread_participants").upsert({
    thread_parent_id: threadParentId,
    participant_id: AGENT_ID,
    participant_type: "agent",
    last_read_at: new Date().toISOString(),
  });

  console.log(`Reply sent to ${target}. Message ID: ${shortId(data.id)}`);
}

async function cmdThreadResolve(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const { threadParentId } = await resolveTarget(target);
  if (!threadParentId) fail("INVALID_ARG", "Target must include a thread message ID");

  const unresolved = flags.resolved === "false" || flags.unresolve === "true";
  const patch = unresolved
    ? {
        thread_resolved_at: null,
        thread_resolved_by: null,
        thread_resolved_by_type: null,
      }
    : {
        thread_resolved_at: new Date().toISOString(),
        thread_resolved_by: AGENT_ID,
        thread_resolved_by_type: "agent",
      };

  const { error } = await supabase.from("messages").update(patch).eq("id", threadParentId);
  if (error) fail("THREAD_RESOLVE_FAILED", error.message);
  console.log(`Thread ${target} ${unresolved ? "unresolved" : "resolved"}.`);
}

async function resolveTask(flags: Record<string, string>, code = "TASK_NOT_FOUND") {
  const taskNumber = flags.number ? parseInt(flags.number) : null;
  const messageId = flags["message-id"] ?? null;

  if (!taskNumber && !messageId) {
    fail("INVALID_ARG", "Missing --number or --message-id");
  }

  if (taskNumber) {
    let query = supabase
      .from("tasks")
      .select("id, task_number, status, assignee_id, assignee_type, channel_id")
      .eq("task_number", taskNumber);

    if (flags.channel) {
      const { channelId } = await resolveTarget(flags.channel);
      query = query.eq("channel_id", channelId);
    } else {
      const { data: memberships } = await supabase
        .from("channel_members")
        .select("channel_id")
        .eq("member_id", AGENT_ID)
        .eq("member_type", "agent");
      if (!memberships || memberships.length === 0) fail(code, "Task not found");
      query = query.in(
        "channel_id",
        memberships.map((m) => m.channel_id)
      );
    }

    const { data: tasks, error } = await query;
    if (error) fail(code, error.message);
    if (!tasks || tasks.length === 0) fail(code, "Task not found");
    if (tasks.length > 1) fail("AMBIGUOUS_TASK", "Multiple tasks match; provide --channel");
    return tasks[0];
  }

  const task = await findTaskByMessageId(messageId!, flags);
  if (!task) fail(code, `Task with message ID ${messageId} not found`);
  return task;
}

async function findTaskByMessageId(messageIdOrShort: string, flags: Record<string, string>) {
  const channelId = flags.channel ? (await resolveTarget(flags.channel)).channelId : null;
  const message = await findMessageForTaskClaim(messageIdOrShort, channelId);
  if (!message) return null;

  const { data: tasksByMsg, error: msgError } = await supabase
    .from("tasks")
    .select("id, task_number, status, assignee_id, assignee_type, channel_id")
    .or(`message_id.eq.${message.id},source_message_id.eq.${message.id}`);

  if (msgError) fail("TASK_NOT_FOUND", msgError.message);
  return tasksByMsg?.[0] ?? null;
}

async function createTaskFromMessage(messageIdOrShort: string, flags: Record<string, string>) {
  const channelId = flags.channel ? (await resolveTarget(flags.channel)).channelId : null;
  const message = await findMessageForTaskClaim(messageIdOrShort, channelId);
  if (!message) fail("CLAIM_FAILED", `Message ${messageIdOrShort} not found`);
  if (message.thread_parent_id) fail("CLAIM_FAILED", "Only top-level messages can be claimed as tasks");

  const title = message.content.trim().split(/\n+/)[0]?.slice(0, 160) || "Untitled task";
  const { data: task, error: createError } = await supabase
    .from("tasks")
    .insert({
      message_id: message.id,
      channel_id: message.channel_id,
      title,
      description: message.content,
      priority: "medium",
      tags: [],
      source_message_id: message.id,
      created_by_id: message.sender_id,
      created_by_type: message.sender_type,
      assignee_id: AGENT_ID,
      assignee_type: "agent",
      status: "in_progress",
      started_at: new Date().toISOString(),
      current_gate: "executing",
    })
    .select("id, task_number, status, assignee_id, assignee_type, channel_id")
    .single();

  if (createError || !task) fail("CLAIM_FAILED", createError?.message ?? "Failed to create task from message");
  return task;
}

async function findMessageForTaskClaim(messageIdOrShort: string, channelId: string | null) {
  if (messageIdOrShort.length > 8) {
    let query = supabase
      .from("messages")
      .select("id, channel_id, sender_id, sender_type, content, thread_parent_id")
      .eq("id", messageIdOrShort);
    if (channelId) query = query.eq("channel_id", channelId);

    const { data, error } = await query.single();
    if (error) return null;
    return data;
  }

  let query = supabase
    .from("messages")
    .select("id, channel_id, sender_id, sender_type, content, thread_parent_id")
    .order("created_at", { ascending: false })
    .limit(100);
  if (channelId) query = query.eq("channel_id", channelId);
  else {
    const { data: memberships } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", AGENT_ID)
      .eq("member_type", "agent");
    if (!memberships || memberships.length === 0) return null;
    query = query.in("channel_id", memberships.map((m) => m.channel_id));
  }

  const { data: messages } = await query;
  return messages?.find((message) => shortId(message.id) === messageIdOrShort) ?? null;
}

async function resolveTaskByNumber(taskNumber: number, channelId?: string) {
  let query = supabase.from("tasks").select("id, task_number, channel_id").eq("task_number", taskNumber);
  if (channelId) query = query.eq("channel_id", channelId);
  const { data: tasks, error } = await query;
  if (error) fail("TASK_NOT_FOUND", error.message);
  if (!tasks || tasks.length === 0) fail("TASK_NOT_FOUND", `Task #${taskNumber} not found`);
  if (tasks.length > 1) fail("AMBIGUOUS_TASK", `Multiple tasks match #${taskNumber}; provide --channel`);
  return tasks[0];
}

async function cmdTaskList(flags: Record<string, string>) {
  const channel = flags.channel;
  const status = flags.status;
  const tag = flags.tag;

  let query = supabase
    .from("tasks")
    .select(
      "id, task_number, status, title, assignee_id, assignee_type, channel_id, created_at, tags, priority"
    )
    .order("task_number", { ascending: true });

  if (channel) {
    const { channelId } = await resolveTarget(channel);
    query = query.eq("channel_id", channelId);
  } else {
    const { data: memberships } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", AGENT_ID)
      .eq("member_type", "agent");

    if (!memberships || memberships.length === 0) {
      console.log("No tasks.");
      return;
    }
    query = query.in(
      "channel_id",
      memberships.map((m) => m.channel_id)
    );
  }

  if (status) query = query.eq("status", status);
  if (tag) query = query.contains("tags", [tag]);

  const { data: tasks, error } = await query;
  if (error) fail("TASK_LIST_FAILED", error.message);

  if (!tasks || tasks.length === 0) {
    console.log("No tasks.");
    return;
  }

  for (const task of tasks) {
    const title = task.title?.substring(0, 80) || "(untitled)";
    const assignee = task.assignee_id
      ? await resolveSenderName(
          task.assignee_id,
          task.assignee_type || "agent"
        )
      : "unassigned";

    const chDisplay = await resolveChannelDisplay(task.channel_id);
    const prio = task.priority && task.priority !== "medium" ? ` prio=${task.priority}` : "";
    console.log(
      `  task #${task.task_number} [${task.status}] ${chDisplay} — ${title} (${assignee})${prio}`
    );
  }
}

async function cmdTaskCreate(flags: Record<string, string>) {
  const channel = flags.channel;
  const title = (flags.title || flags._ || "").trim();
  if (!channel) fail("INVALID_ARG", "Missing --channel");
  if (!title) fail("INVALID_ARG", "Missing --title (use --title <title> or provide title after flags)");

  const { channelId } = await resolveTarget(channel);
  const parentTask = flags.parent ? await resolveTaskByNumber(parseInt(flags.parent), channelId) : null;
  const tagValues = collectFlagValues(flags, "tag");
  const shouldClaim = flags.claim === "true";

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      channel_id: channelId,
      title,
      description: flags.description ?? null,
      priority: flags.priority ?? "medium",
      tags: tagValues.length > 0 ? tagValues : [],
      parent_task_id: parentTask?.id ?? null,
      created_by_id: AGENT_ID,
      created_by_type: "agent",
      current_gate: shouldClaim ? "executing" : "ready_to_execute",
      ...(shouldClaim
        ? { assignee_id: AGENT_ID, assignee_type: "agent", status: "in_progress", started_at: new Date().toISOString() }
        : {}),
    })
    .select("id, task_number")
    .single();

  if (taskError) fail("CREATE_FAILED", taskError.message);

  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      sender_id: AGENT_ID,
      sender_type: "agent",
      content: title,
    })
    .select("id")
    .single();

  if (msgError) {
    await supabase.from("tasks").delete().eq("id", task.id);
    fail("CREATE_FAILED", msgError.message);
  }

  const { error: bindError } = await supabase
    .from("tasks")
    .update({ message_id: msg.id, source_message_id: msg.id })
    .eq("id", task.id);

  if (bindError) {
    await supabase.from("messages").delete().eq("id", msg.id);
    await supabase.from("tasks").delete().eq("id", task.id);
    fail("CREATE_FAILED", bindError.message);
  }

  console.log(`Task #${task.task_number} created${shouldClaim ? " and claimed" : ""} in ${channel}.`);
}

async function cmdTaskClaim(flags: Record<string, string>) {
  let task = flags["message-id"] ? await findTaskByMessageId(flags["message-id"], flags) : null;
  if (!task && flags["message-id"]) {
    const channelId = flags.channel ? (await resolveTarget(flags.channel)).channelId : null;
    const message = await findMessageForTaskClaim(flags["message-id"], channelId);
    if (!message) fail("CLAIM_FAILED", `Message ${flags["message-id"]} not found`);
    if (message.thread_parent_id) fail("CLAIM_FAILED", "Only top-level messages can be claimed as tasks");

    const target = await resolveChannelDisplay(message.channel_id);
    const fresh = await runFreshnessPreflight({
      action: "task_claim",
      target,
      channelId: message.channel_id,
      threadParentId: null,
      anyway: flagEnabled(flags.anyway),
    });
    if (!fresh) return;

    task = await createTaskFromMessage(flags["message-id"], flags);
    console.log(`Task #${task.task_number} claimed and set to in_progress.`);
    return;
  } else if (!task) {
    task = await resolveTask(flags, "CLAIM_FAILED");
  }

  if (task.assignee_id && task.assignee_id !== AGENT_ID) {
    const owner = await resolveSenderName(task.assignee_id, task.assignee_type || "agent");
    fail(
      "CLAIM_FAILED",
      `Task #${task.task_number} is already claimed by @${owner}`
    );
  }

  const target = await resolveChannelDisplay(task.channel_id);
  const fresh = await runFreshnessPreflight({
    action: "task_claim",
    target,
    channelId: task.channel_id,
    threadParentId: null,
    anyway: flagEnabled(flags.anyway),
  });
  if (!fresh) return;

  let query = supabase
    .from("tasks")
    .update({
      assignee_id: AGENT_ID,
      assignee_type: "agent",
      status: "in_progress",
      started_at: new Date().toISOString(),
      current_gate: "executing",
    })
    .eq("id", task.id);

  query = task.assignee_id ? query.eq("assignee_id", AGENT_ID) : query.is("assignee_id", null);

  const { data, error } = await query.select("task_number").single();

  if (error || !data) fail("CLAIM_FAILED", error?.message ?? "Task is already claimed");

  console.log(`Task #${task.task_number} claimed and set to in_progress.`);
}

async function cmdTaskUnclaim(flags: Record<string, string>) {
  const task = await resolveTask(flags, "UNCLAIM_FAILED");

  if (task.assignee_id !== AGENT_ID) {
    fail("UNCLAIM_FAILED", "You are not the assignee of this task");
  }

  const { error } = await supabase
    .from("tasks")
    .update({
      assignee_id: null,
      assignee_type: null,
      status: "todo",
      current_gate: "ready_to_execute",
    })
    .eq("id", task.id);

  if (error) fail("UNCLAIM_FAILED", error.message);

  console.log(`Task #${task.task_number} unclaimed.`);
}

async function cmdTaskUpdate(flags: Record<string, string>) {
  const task = await resolveTask(flags, "UPDATE_FAILED");
  const status = flags.status;
  const summary = flags.summary;

  const patch: Record<string, string | null> = {};
  if (status) patch.status = status;
  if (summary) patch.resolution_summary = summary;
  if (flags.title) patch.title = flags.title;
  if (flags.description) patch.description = flags.description;

  if (Object.keys(patch).length === 0) {
    fail("INVALID_ARG", "Provide --status, --summary, --title, or --description");
  }

  // F7: warn if transition would be blocked by rules
  if (status && isTaskStatus(status) && isTaskStatus(task.status)) {
    const [depsResult, verificationsResult] = await Promise.all([
      supabase
        .from("task_dependencies")
        .select("predecessor_task_id, tasks!task_dependencies_predecessor_task_id_fkey(status)")
        .eq("successor_task_id", task.id)
        .eq("dependency_type", "blocks"),
      supabase
        .from("task_verifications")
        .select("id")
        .eq("task_id", task.id)
        .eq("passed", true)
        .limit(1),
    ]);

    const hasBlockingDeps = (depsResult.data ?? []).some((row) => {
      const joined = row as unknown as { tasks?: { status?: string } | { status?: string }[] };
      const predecessor = Array.isArray(joined.tasks) ? joined.tasks[0] : joined.tasks;
      return predecessor?.status !== "done" && predecessor?.status !== "archived";
    });

    const context: TaskTransitionContext = {
      hasBlockingDependencies: hasBlockingDeps,
      hasPassingVerification: (verificationsResult.data ?? []).length > 0,
      requiresReview: false,
      hasPassingRequiredReview: false,
    };

    const check = canTransitionTask(task.status, status, context);
    if (!check.allowed) {
      if (!flagEnabled(flags.anyway)) {
        const message = status === "done" && !context.hasPassingVerification
          ? taskMissingVerificationMessage(task.task_number)
          : check.reason ?? `Invalid transition from ${task.status} to ${status}`;
        fail("INVALID_TASK_TRANSITION", message);
      }
      process.stderr.write(`WARNING: Transition from ${task.status} to ${status} would be blocked by server rules: ${check.reason}\n`);
    }
  } else if (status) {
    fail("INVALID_TASK_STATUS", `Unknown task status: ${status}`);
  }

  const target = await resolveChannelDisplay(task.channel_id);
  const fresh = await runFreshnessPreflight({
    action: "task_update",
    target,
    channelId: task.channel_id,
    threadParentId: null,
    anyway: flagEnabled(flags.anyway),
  });
  if (!fresh) return;

  const fromStatus = task.status;
  const { error } = await supabase
    .from("tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", task.id);

  if (error) fail("UPDATE_FAILED", error.message);

  if (status && status !== fromStatus) {
    await supabase.from("task_events").insert({
      task_id: task.id,
      actor_id: AGENT_ID,
      actor_type: "agent",
      event_type: "status_changed",
      from_state: { status: fromStatus },
      to_state: { status },
      reason: summary ?? null,
    });
  }

  console.log(`Task #${task.task_number} updated${status ? ` to ${status}` : ""}.`);
}

async function cmdTaskVerify(flags: Record<string, string>) {
  const task = await resolveTask(flags, "VERIFY_FAILED");
  const passed = flagEnabled(flags.passed) || flagEnabled(flags.pass);
  const failed = flagEnabled(flags.failed) || flagEnabled(flags.fail);
  if ([passed, failed].filter(Boolean).length !== 1) {
    fail("INVALID_ARG", "Provide exactly one of --passed or --failed");
  }

  const verificationType = (flags.type ?? "manual").trim();
  if (!verificationType) fail("INVALID_ARG", "Missing --type");

  const commandOrCheck = (flags.check ?? flags.command ?? "").trim();
  if (!commandOrCheck) fail("INVALID_ARG", "Missing --check (what you ran or inspected)");

  const stdinSummary = await readStdin();
  const outputSummary = (flags.summary ?? stdinSummary).trim();
  const evidenceUrl = (flags["evidence-url"] ?? flags.url ?? "").trim();

  const { data, error } = await supabase
    .from("task_verifications")
    .insert({
      task_id: task.id,
      step_id: flags["step-id"] ?? null,
      actor_id: REQUIRED_AGENT_ID,
      actor_type: "agent",
      verification_type: verificationType,
      command_or_check: commandOrCheck,
      output_summary: outputSummary || null,
      passed,
      evidence_url: evidenceUrl || null,
    })
    .select("id")
    .single();

  if (error || !data) fail("VERIFY_FAILED", error?.message ?? "Verification was not recorded");
  console.log(`Verification ${passed ? "passed" : "failed"} recorded for task #${task.task_number}: ${shortId(data.id)}.`);
}

async function cmdTaskComment(flags: Record<string, string>) {
  const task = await resolveTask(flags, "COMMENT_FAILED");
  const content = await readStdin();
  if (!content) fail("INVALID_ARG", "Comment content must be provided via stdin");

  const { error } = await supabase.from("task_comments").insert({
    task_id: task.id,
    author_id: AGENT_ID,
    author_type: "agent",
    content,
  });
  if (error) fail("COMMENT_FAILED", error.message);
  console.log(`Comment added to task #${task.task_number}.`);
}

async function cmdTaskArtifactAdd(flags: Record<string, string>) {
  const task = await resolveTask(flags, "ARTIFACT_FAILED");
  const artifactType = flags.type;
  const title = flags.title;
  if (!artifactType) fail("INVALID_ARG", "Missing --type");
  if (!title) fail("INVALID_ARG", "Missing --title");

  const { error } = await supabase.from("task_artifacts").insert({
    task_id: task.id,
    artifact_type: artifactType,
    title,
    url: flags.url ?? null,
    metadata: withDaemonMetadata(),
    created_by_id: AGENT_ID,
    created_by_type: "agent",
  });
  if (error) fail("ARTIFACT_FAILED", error.message);
  console.log(`Artifact added to task #${task.task_number}.`);
}

async function cmdTaskDependencyAdd(flags: Record<string, string>) {
  const task = await resolveTask(flags, "DEPENDENCY_FAILED");
  const blockedBy = flags.blocks ? parseInt(flags.blocks) : null;
  if (!blockedBy) fail("INVALID_ARG", "Missing --blocks");

  const predecessor = await resolveTaskByNumber(blockedBy, flags.channel ? task.channel_id : undefined);

  const { data: existing, error: existingError } = await supabase
    .from("task_dependencies")
    .select("predecessor_task_id, successor_task_id");
  if (existingError) fail("DEPENDENCY_FAILED", existingError.message);

  const edges: TaskDependencyEdge[] = [
    ...(existing ?? []).map((edge) => ({
      predecessorTaskId: edge.predecessor_task_id,
      successorTaskId: edge.successor_task_id,
    })),
    { predecessorTaskId: predecessor.id, successorTaskId: task.id },
  ];

  if (hasDependencyCycle(edges)) {
    fail("DEPENDENCY_FAILED", "Dependency would create a cycle");
  }

  const { error } = await supabase.from("task_dependencies").insert({
    predecessor_task_id: predecessor.id,
    successor_task_id: task.id,
    dependency_type: "blocks",
  });
  if (error) fail("DEPENDENCY_FAILED", error.message);
  console.log(`Task #${task.task_number} now depends on task #${predecessor.task_number}.`);
}

async function cmdTaskReview(flags: Record<string, string>) {
  const task = await resolveTask(flags, "REVIEW_FAILED");
  const approve = flagEnabled(flags.approve);
  const changesRequested = flagEnabled(flags["changes-requested"]);
  const blocked = flagEnabled(flags.blocked);
  if ([approve, changesRequested, blocked].filter(Boolean).length !== 1) {
    fail("INVALID_ARG", "Provide exactly one of --approve, --changes-requested, or --blocked");
  }

  const summary = flags.summary ?? ((await readStdin()) || (approve ? "Approved" : blocked ? "Blocked" : "Changes requested"));
  const verdict = approve ? "pass" : blocked ? "blocked" : "fail";

  const { error } = await supabase.from("task_reviews").insert({
    task_id: task.id,
    reviewer_id: AGENT_ID,
    reviewer_type: "agent",
    review_type: flags.type ?? "agent_review",
    findings: [],
    verdict,
    summary,
  });
  if (error) fail("REVIEW_FAILED", error.message);

  const nextStatus: TaskStatus | null = changesRequested ? "changes_requested" : blocked ? "blocked" : null;
  if (nextStatus && isTaskStatus(task.status)) {
    const check = canTransitionTask(task.status, nextStatus, {
      hasBlockingDependencies: false,
      hasPassingVerification: false,
      requiresReview: false,
      hasPassingRequiredReview: false,
    });
    if (check.allowed) {
      const { error: updateError } = await supabase
        .from("tasks")
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq("id", task.id);
      if (updateError) fail("REVIEW_FAILED", updateError.message);

      await supabase.from("task_events").insert({
        task_id: task.id,
        actor_id: AGENT_ID,
        actor_type: "agent",
        event_type: "status_changed",
        from_state: { status: task.status },
        to_state: { status: nextStatus },
        reason: summary,
      });
    } else {
      process.stderr.write(`WARNING: Review recorded, but task #${task.task_number} stayed ${task.status}: ${check.reason}\n`);
    }
  }

  console.log(`Review added to task #${task.task_number}: ${verdict}${nextStatus ? `; task status ${nextStatus}` : ""}.`);
}

interface ReminderRow {
  id: string;
  server_id: string;
  created_by_id: string;
  created_by_type: string;
  recipient_id: string;
  recipient_type: string;
  channel_id: string;
  source_message_id: string | null;
  thread_parent_id: string | null;
  task_id: string | null;
  target: string;
  body: string;
  due_at: string;
  snoozed_until: string | null;
  state: ReminderState;
  fired_at: string | null;
  fired_delivery_id: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
}

const REMINDER_SELECT = "id, server_id, created_by_id, created_by_type, recipient_id, recipient_type, channel_id, source_message_id, thread_parent_id, task_id, target, body, due_at, snoozed_until, state, fired_at, fired_delivery_id, cancelled_at, completed_at, last_error, created_at";

function parseReminderDuration(value: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) fail("INVALID_ARG", "Use --in with a duration like 15m, 2h, or 1d");
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

function parseReminderTimestamp(flags: Record<string, string>, code: string): string {
  const raw = flags.at ?? flags.until;
  const date = raw ? new Date(raw) : flags.in ? new Date(Date.now() + parseReminderDuration(flags.in)) : null;
  if (!date || Number.isNaN(date.getTime())) {
    fail(code, "Provide --at/--until as an ISO timestamp or --in as 15m, 2h, or 1d");
  }
  return date.toISOString();
}

function formatReminderDue(reminder: ReminderRow): string {
  return fmtTime(reminder.snoozed_until ?? reminder.due_at);
}

async function resolveReminder(ref: string): Promise<ReminderRow> {
  let query = supabase
    .from("reminders")
    .select(REMINDER_SELECT)
    .or(`created_by_id.eq.${AGENT_ID},recipient_id.eq.${AGENT_ID}`)
    .order("created_at", { ascending: false })
    .limit(200);

  if (isUuid(ref)) query = query.eq("id", ref);

  const { data, error } = await query;
  if (error) fail("REMINDER_NOT_FOUND", error.message);

  const matches = ((data ?? []) as ReminderRow[]).filter((reminder) => isUuid(ref) ? reminder.id === ref : shortId(reminder.id) === ref);
  if (matches.length === 0) fail("REMINDER_NOT_FOUND", `Reminder not found: ${ref}`);
  if (matches.length > 1) fail("AMBIGUOUS_REMINDER", "Multiple reminders match; provide full id");
  return matches[0];
}

async function cmdReminderCreate(flags: Record<string, string>) {
  const localTarget = readAgentLocalState(AGENT_LOCAL_STATE).currentDelivery?.target;
  const target = flags.target ?? localTarget;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const body = (flags.body ?? flags._ ?? (await readStdin())).trim();
  if (!body) fail("INVALID_ARG", "Reminder body must be provided via stdin or --body");

  const dueAt = parseReminderTimestamp(flags, "REMINDER_CREATE_FAILED");
  const { channelId, threadParentId } = await resolveTarget(target);
  const serverId = await resolveAutonomousServerId(flags);
  const taskNumber = flags.task ?? flags.number;
  const task = taskNumber ? await resolveTask({ number: taskNumber, channel: target }, "REMINDER_CREATE_FAILED") : null;

  const { data, error } = await supabase
    .from("reminders")
    .insert({
      server_id: serverId,
      created_by_id: AGENT_ID,
      created_by_type: "agent",
      recipient_id: AGENT_ID,
      recipient_type: "agent",
      channel_id: channelId,
      source_message_id: flags["message-id"] ?? null,
      thread_parent_id: threadParentId,
      task_id: task?.id ?? null,
      target,
      body,
      due_at: dueAt,
      metadata: withDaemonMetadata(),
    })
    .select("id")
    .single();

  if (error || !data) fail("REMINDER_CREATE_FAILED", error?.message ?? "Failed to create reminder");
  console.log(`Reminder ${shortId(data.id)} scheduled for ${fmtTime(dueAt)} on ${target}.`);
}

async function cmdReminderList(flags: Record<string, string>) {
  let query = supabase
    .from("reminders")
    .select(REMINDER_SELECT)
    .or(`created_by_id.eq.${AGENT_ID},recipient_id.eq.${AGENT_ID}`)
    .order("due_at", { ascending: true })
    .limit(parsePositiveInt(flags.limit, 20));

  if (flags.state) query = query.eq("state", flags.state);
  else if (!flagEnabled(flags.all)) query = query.in("state", ["pending", "snoozed", "firing"]);

  const { data, error } = await query;
  if (error) fail("REMINDER_LIST_FAILED", error.message);

  const reminders = (data ?? []) as ReminderRow[];
  if (reminders.length === 0) {
    console.log("No reminders.");
    return;
  }

  for (const reminder of reminders) {
    const taskRef = reminder.task_id ? " task-linked" : "";
    console.log(`  reminder ${shortId(reminder.id)} [${reminder.state}] ${reminder.target} due=${formatReminderDue(reminder)}${taskRef} — ${reminder.body.slice(0, 120)}`);
  }
}

async function cmdReminderSnooze(flags: Record<string, string>) {
  const ref = flags.id ?? flags._;
  if (!ref) fail("INVALID_ARG", "Missing --id");
  const reminder = await resolveReminder(ref);
  const snoozedUntil = parseReminderTimestamp(flags, "REMINDER_SNOOZE_FAILED");

  const { error } = await supabase
    .from("reminders")
    .update({ state: "snoozed", snoozed_until: snoozedUntil, updated_at: new Date().toISOString() })
    .eq("id", reminder.id);
  if (error) fail("REMINDER_SNOOZE_FAILED", error.message);
  console.log(`Reminder ${shortId(reminder.id)} snoozed until ${fmtTime(snoozedUntil)}.`);
}

async function cmdReminderCancel(flags: Record<string, string>) {
  const ref = flags.id ?? flags._;
  if (!ref) fail("INVALID_ARG", "Missing --id");
  const reminder = await resolveReminder(ref);

  const { error } = await supabase
    .from("reminders")
    .update({ state: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", reminder.id);
  if (error) fail("REMINDER_CANCEL_FAILED", error.message);
  console.log(`Reminder ${shortId(reminder.id)} cancelled.`);
}

async function cmdReminderDone(flags: Record<string, string>) {
  const ref = flags.id ?? flags._;
  if (!ref) fail("INVALID_ARG", "Missing --id");
  const reminder = await resolveReminder(ref);

  const { error } = await supabase
    .from("reminders")
    .update({ state: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", reminder.id);
  if (error) fail("REMINDER_DONE_FAILED", error.message);
  console.log(`Reminder ${shortId(reminder.id)} marked done.`);
}

interface SkillRow {
  id: string;
  server_id: string;
  slug: string;
  name: string;
  description: string;
  state: string;
  risk_level: string;
  active_version_id: string | null;
  updated_at: string;
}

interface AgentBlueprintRow {
  id: string;
  server_id: string;
  slug: string;
  display_name_template: string;
  description: string;
  state: string;
  default_model: string;
  created_at: string;
}

async function resolveSkillBySlug(
  slug: string,
  flags: Record<string, string>
): Promise<SkillRow> {
  let query = actorSupabase
    .from("skills")
    .select("id, server_id, slug, name, description, state, risk_level, active_version_id, updated_at")
    .eq("slug", slug)
    .limit(2);

  const serverId = flags["server-id"] ?? ACTOR_CLAIMS.server_id;
  if (serverId) {
    query = query.eq("server_id", serverId);
  }

  const { data, error } = await query;
  if (error) fail("SKILL_RESOLVE_FAILED", error.message);

  const skills = (data ?? []) as SkillRow[];
  if (skills.length === 0) fail("SKILL_NOT_FOUND", `Skill not found: ${slug}`);
  if (skills.length > 1) fail("AMBIGUOUS_SKILL", "Multiple skills match; provide --server-id");
  return skills[0];
}

async function cmdSkillList(flags: Record<string, string>) {
  const limit = parsePositiveInt(flags.limit, 25);

  let query = actorSupabase
    .from("skills")
    .select("slug, name, description, state, risk_level, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (flags.state) query = query.eq("state", flags.state);

  const { data, error } = await query;
  if (error) fail("SKILL_LIST_FAILED", error.message);

  const skills = (data ?? []) as Array<Omit<SkillRow, "id" | "server_id" | "active_version_id">>;
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  for (const skill of skills) {
    console.log(
      `[${skill.state}/${skill.risk_level}] ${skill.slug} — ${skill.name}: ${skill.description}`
    );
  }
}

async function cmdSkillSearch(flags: Record<string, string>) {
  const queryText = flags.query;
  if (!queryText) fail("INVALID_ARG", "Missing --query");

  const limit = parsePositiveInt(flags.limit, 25);
  const { data, error } = await actorSupabase
    .from("skills")
    .select("slug, name, description, state, risk_level, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) fail("SKILL_SEARCH_FAILED", error.message);

  const normalized = queryText.toLowerCase();
  const skills = ((data ?? []) as Array<Omit<SkillRow, "id" | "server_id" | "active_version_id">>)
    .filter((skill) =>
      `${skill.slug} ${skill.name} ${skill.description}`.toLowerCase().includes(normalized)
    )
    .slice(0, limit);

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  for (const skill of skills) {
    console.log(
      `[${skill.state}/${skill.risk_level}] ${skill.slug} — ${skill.name}: ${skill.description}`
    );
  }
}

async function cmdSkillView(flags: Record<string, string>) {
  const slug = flags.slug ?? flags._;
  if (!slug) fail("INVALID_ARG", "Missing --slug");

  const skill = await resolveSkillBySlug(slug, flags);
  console.log(`# ${skill.name} (${skill.slug})`);
  console.log(`state=${skill.state} risk=${skill.risk_level} updated=${fmtTime(skill.updated_at)}`);
  console.log(skill.description);

  const { data: version, error } = await actorSupabase
    .from("skill_versions")
    .select("version_number, content, change_summary, created_at")
    .eq("skill_id", skill.id)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) fail("SKILL_VIEW_FAILED", error.message);
  if (!version) {
    console.log("\nNo materialized skill version yet.");
    return;
  }

  console.log(`\n## v${version.version_number} — ${fmtTime(version.created_at)}`);
  console.log(version.change_summary);
  console.log("\n" + version.content);
}

async function cmdSkillCandidateCreate(flags: Record<string, string>) {
  const targetSlug = flags.slug ?? flags["target-slug"] ?? null;
  const targetSkillId = flags["target-skill-id"] ?? null;
  const candidateType = flags.type ?? "create";
  const rationale = flags.rationale ?? flags.reason;
  if (!targetSlug && !targetSkillId) fail("INVALID_ARG", "Missing --slug or --target-skill-id");
  if (!rationale) fail("INVALID_ARG", "Missing --rationale");

  const stdinContent = await readStdin();
  const proposedContent = flags.content ?? (stdinContent || null);
  const serverId = await resolveAutonomousServerId(flags);
  const classification = {
    ...parseJsonObjectFlag(flags.classification),
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.trigger ? { trigger: flags.trigger } : {}),
  };

  const { data, error } = await actorSupabase.rpc("skill_create_candidate", {
    p_candidate_type: candidateType,
    p_target_slug: targetSlug,
    p_target_skill_id: targetSkillId,
    p_proposed_content: proposedContent,
    p_proposed_files: parseJsonFlag(flags.files, []),
    p_rationale: rationale,
    p_classification: classification,
    p_evidence_refs: parseEvidenceRefs(flags),
    p_risk_level: flags.risk ?? "low",
    p_server_id: serverId,
  });

  if (error) fail("SKILL_CANDIDATE_FAILED", error.message);
  console.log(`Skill candidate created: ${data}`);
}

async function cmdSkillEpisodeCreate(flags: Record<string, string>) {
  const triggerType = flags.trigger ?? flags.type;
  const summary = flags.summary ?? (await readStdin());
  if (!triggerType) fail("INVALID_ARG", "Missing --trigger");
  if (!summary) fail("INVALID_ARG", "Missing --summary or stdin content");

  const serverId = await resolveAutonomousServerId(flags);
  const { data, error } = await actorSupabase.rpc("skill_episode_create", {
    p_trigger_type: triggerType,
    p_trigger_strength: flags.strength ?? "medium",
    p_summary: summary,
    p_signals: parseJsonFlag(flags.signals, {}),
    p_source_refs: parseEvidenceRefs(flags, "source"),
    p_channel_id: flags.channel ? (await resolveTarget(flags.channel)).channelId : null,
    p_thread_parent_id: flags.thread ?? null,
    p_task_id: flags["task-id"] ?? null,
    p_agent_id: flags["agent-id"] ?? AGENT_ID,
    p_server_id: serverId,
  });

  if (error) fail("SKILL_EPISODE_CREATE_FAILED", error.message);
  console.log(`Skill episode created: ${data}`);
}

async function cmdSkillEpisodeList(flags: Record<string, string>) {
  const limit = parsePositiveInt(flags.limit, 25);
  let query = actorSupabase
    .from("skill_episodes")
    .select("id, trigger_type, trigger_strength, summary, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (flags.status) query = query.eq("status", flags.status);

  const { data, error } = await query;
  if (error) fail("SKILL_EPISODE_LIST_FAILED", error.message);

  const episodes = (data ?? []) as Array<{
    id: string;
    trigger_type: string;
    trigger_strength: string;
    summary: string;
    status: string;
    created_at: string;
  }>;

  if (episodes.length === 0) {
    console.log("No skill episodes found.");
    return;
  }

  for (const episode of episodes) {
    console.log(
      `[${episode.status}/${episode.trigger_strength}] ${shortId(episode.id)} ${episode.trigger_type} — ${episode.summary}`
    );
  }
}

async function cmdSkillEpisodeGenerate(flags: Record<string, string>) {
  const turnId = flags["turn-id"] ?? flags.turn ?? flags.id ?? flags._;
  if (!turnId) fail("INVALID_ARG", "Missing --turn-id");

  const { data, error } = await actorSupabase.rpc("skill_episode_generate_from_turn", {
    p_turn_id: turnId,
    p_trigger_strength: flags.strength ?? null,
  });

  if (error) fail("SKILL_EPISODE_GENERATE_FAILED", error.message);
  console.log(`Skill episode generated: ${data}`);
}

async function resolveSkillEpisodeId(flags: Record<string, string>): Promise<string> {
  const idOrShort = flags.id ?? flags._;
  if (!idOrShort) fail("INVALID_ARG", "Missing --id");
  if (isUuid(idOrShort)) return idOrShort;

  const { data, error } = await actorSupabase
    .from("skill_episodes")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) fail("SKILL_EPISODE_RESOLVE_FAILED", error.message);

  const matches = ((data ?? []) as Array<{ id: string }>).filter(
    (episode) => shortId(episode.id) === idOrShort
  );
  if (matches.length === 0) fail("SKILL_EPISODE_NOT_FOUND", `Episode not found: ${idOrShort}`);
  if (matches.length > 1) fail("AMBIGUOUS_SKILL_EPISODE", "Multiple episodes match; use full UUID");
  return matches[0].id;
}

async function cmdSkillEpisodeNoOp(flags: Record<string, string>) {
  const episodeId = await resolveSkillEpisodeId(flags);
  const stdinReason = await readStdin();
  const reason = flags.reason ?? flags.summary ?? (stdinReason || null);

  const { data, error } = await actorSupabase.rpc("skill_episode_mark_no_op", {
    p_episode_id: episodeId,
    p_reason: reason,
  });

  if (error) fail("SKILL_EPISODE_NO_OP_FAILED", error.message);
  console.log(`Skill episode marked no-op: ${data}`);
}

async function cmdSkillCandidateList(flags: Record<string, string>) {
  const limit = parsePositiveInt(flags.limit, 25);
  let query = actorSupabase
    .from("skill_candidates")
    .select("id, candidate_type, target_slug, risk_level, state, rationale, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (flags.state) query = query.eq("state", flags.state);
  else query = query.eq("state", "pending");

  const { data, error } = await query;
  if (error) fail("SKILL_CANDIDATE_LIST_FAILED", error.message);

  const candidates = (data ?? []) as Array<{
    id: string;
    candidate_type: string;
    target_slug: string | null;
    risk_level: string;
    state: string;
    rationale: string;
    created_at: string;
  }>;

  if (candidates.length === 0) {
    console.log("No skill candidates found.");
    return;
  }

  for (const candidate of candidates) {
    console.log(
      `[${candidate.state}/${candidate.risk_level}] ${shortId(candidate.id)} ${candidate.candidate_type} ${candidate.target_slug ?? "(no slug)"} — ${candidate.rationale}`
    );
  }
}

async function resolveSkillCandidateId(flags: Record<string, string>): Promise<string> {
  const idOrShort = flags.id ?? flags._;
  if (!idOrShort) fail("INVALID_ARG", "Missing --id");
  if (isUuid(idOrShort)) return idOrShort;

  const { data, error } = await actorSupabase
    .from("skill_candidates")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) fail("SKILL_CANDIDATE_RESOLVE_FAILED", error.message);

  const matches = ((data ?? []) as Array<{ id: string }>).filter(
    (candidate) => shortId(candidate.id) === idOrShort
  );
  if (matches.length === 0) fail("SKILL_CANDIDATE_NOT_FOUND", `Candidate not found: ${idOrShort}`);
  if (matches.length > 1) fail("AMBIGUOUS_SKILL_CANDIDATE", "Multiple candidates match; use full UUID");
  return matches[0].id;
}

async function cmdSkillCandidateApply(flags: Record<string, string>) {
  const candidateId = await resolveSkillCandidateId(flags);
  const stdinReason = await readStdin();
  const reason = flags.reason ?? flags.summary ?? (stdinReason || null);

  const { data, error } = await actorSupabase.rpc("skill_apply_candidate", {
    p_candidate_id: candidateId,
    p_reason: reason,
  });

  if (error) fail("SKILL_CANDIDATE_APPLY_FAILED", error.message);
  console.log(`Skill candidate apply result: ${JSON.stringify(data)}`);
}

async function cmdSkillCandidateLint(flags: Record<string, string>) {
  const candidateId = await resolveSkillCandidateId(flags);
  const { data: lintId, error } = await actorSupabase.rpc("skill_lint_candidate", {
    p_candidate_id: candidateId,
  });

  if (error) fail("SKILL_CANDIDATE_LINT_FAILED", error.message);

  const { data: lintResult, error: readError } = await actorSupabase
    .from("skill_lint_results")
    .select("lint_status, issues")
    .eq("id", lintId)
    .single();

  if (readError || !lintResult) {
    console.log(`Skill candidate lint recorded: ${lintId}`);
    return;
  }

  console.log(`Skill candidate lint: ${lintResult.lint_status}`);
  const issues = Array.isArray(lintResult.issues) ? lintResult.issues : [];
  for (const issue of issues) {
    console.log(`- ${JSON.stringify(issue)}`);
  }
}

async function cmdSkillAttest(flags: Record<string, string>) {
  const slug = flags.slug;
  const attestationType = flags.type;
  if (!slug) fail("INVALID_ARG", "Missing --slug");
  if (!attestationType) fail("INVALID_ARG", "Missing --type");

  const summary = flags.summary ?? (await readStdin());
  if (!summary) fail("INVALID_ARG", "Missing --summary or stdin content");

  const skill = await resolveSkillBySlug(slug, flags);
  const { error } = await actorSupabase.from("skill_attestations").insert({
    skill_id: skill.id,
    version_id: skill.active_version_id,
    server_id: skill.server_id,
    actor_id: currentActorId(),
    actor_type: currentActorType(),
    attestation_type: attestationType,
    confidence: parseConfidence(flags.confidence),
    summary,
    evidence_refs: parseEvidenceRefs(flags),
  });

  if (error) fail("SKILL_ATTEST_FAILED", error.message);
  console.log(`Attestation added to skill ${slug}: ${attestationType}.`);
}

async function cmdKnowledgeSave(flags: Record<string, string>) {
  const subject = flags.subject;
  if (!subject) fail("INVALID_ARG", "Missing --subject");

  const content = flags.content ?? (await readStdin());
  if (!content) fail("INVALID_ARG", "Knowledge content must be provided via stdin or --content");

  const serverId = await resolveAutonomousServerId(flags);
  const { data, error } = await actorSupabase.rpc("knowledge_save", {
    p_subject: subject,
    p_content: content,
    p_kind: flags.kind ?? "domain_note",
    p_scope: flags.scope ?? "server",
    p_channel_id: flags.channel ? (await resolveTarget(flags.channel)).channelId : null,
    p_task_id: flags["task-id"] ?? null,
    p_confidence: parseConfidence(flags.confidence),
    p_freshness: flags.freshness ?? "stable",
    p_expires_at: flags["expires-at"] ?? null,
    p_source_refs: parseEvidenceRefs(flags, "source"),
    p_server_id: serverId,
  });

  if (error) fail("KNOWLEDGE_SAVE_FAILED", error.message);
  console.log(`Knowledge saved: ${data}`);
}

async function cmdKnowledgeSearch(flags: Record<string, string>) {
  const queryText = flags.query ?? "";
  const limit = parsePositiveInt(flags.limit, 25);

  let query = actorSupabase
    .from("knowledge_items")
    .select("subject, content, kind, confidence, freshness, updated_at")
    .eq("state", "active")
    .order("updated_at", { ascending: false })
    .limit(queryText ? 100 : limit);

  if (flags.kind) query = query.eq("kind", flags.kind);

  const { data, error } = await query;
  if (error) fail("KNOWLEDGE_SEARCH_FAILED", error.message);

  const normalized = queryText.toLowerCase();
  const items = ((data ?? []) as Array<{
    subject: string;
    content: string;
    kind: string;
    confidence: number;
    freshness: string;
    updated_at: string;
  }>)
    .filter((item) =>
      !normalized || `${item.subject} ${item.content} ${item.kind}`.toLowerCase().includes(normalized)
    )
    .slice(0, limit);

  if (items.length === 0) {
    console.log("No knowledge found.");
    return;
  }

  for (const item of items) {
    console.log(
      `[${item.kind}/${item.freshness} confidence=${item.confidence}] ${item.subject} — ${item.content}`
    );
  }
}

async function cmdAgentBlueprintList(flags: Record<string, string>) {
  const limit = parsePositiveInt(flags.limit, 25);
  let query = actorSupabase
    .from("agent_blueprints")
    .select("id, server_id, slug, display_name_template, description, state, default_model, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (flags.state) query = query.eq("state", flags.state);

  const { data, error } = await query;
  if (error) fail("BLUEPRINT_LIST_FAILED", error.message);

  const blueprints = (data ?? []) as AgentBlueprintRow[];
  if (blueprints.length === 0) {
    console.log("No agent blueprints found.");
    return;
  }

  for (const blueprint of blueprints) {
    console.log(
      `[${blueprint.state}/${blueprint.default_model}] ${blueprint.slug} (${shortId(blueprint.id)}) — ${blueprint.display_name_template}: ${blueprint.description}`
    );
  }
}

async function cmdAgentBlueprintCreate(flags: Record<string, string>) {
  const slug = flags.slug;
  const displayNameTemplate = flags["display-name"] ?? flags["name-template"];
  const description = flags.description;
  const systemPromptTemplate = flags["system-prompt"] ?? (await readStdin());

  if (!slug) fail("INVALID_ARG", "Missing --slug");
  if (!displayNameTemplate) fail("INVALID_ARG", "Missing --display-name");
  if (!description) fail("INVALID_ARG", "Missing --description");
  if (!systemPromptTemplate) {
    fail("INVALID_ARG", "System prompt template must be provided via stdin or --system-prompt");
  }

  const requiredSkills = [
    ...parseStringList(flags.skills),
    ...collectFlagValues(flags, "skill").flatMap(parseStringList),
  ];
  const serverId = await resolveAutonomousServerId(flags);

  const { data, error } = await actorSupabase.rpc("agent_blueprint_create", {
    p_slug: slug,
    p_display_name_template: displayNameTemplate,
    p_description: description,
    p_system_prompt_template: systemPromptTemplate,
    p_default_model: flags.model ?? "opus",
    p_scope: flags.scope ?? "server",
    p_required_skills: requiredSkills,
    p_allowed_tools: parseJsonFlag(flags["allowed-tools"], {}),
    p_spawn_policy: parseJsonFlag(flags["spawn-policy"], {}),
    p_lifecycle_policy: parseJsonFlag(flags["lifecycle-policy"], {}),
    p_server_id: serverId,
  });

  if (error) fail("BLUEPRINT_CREATE_FAILED", error.message);
  console.log(`Agent blueprint created: ${data}`);
}

async function resolveBlueprintId(
  value: string,
  flags: Record<string, string>
): Promise<string> {
  if (isUuid(value)) return value;

  let query = actorSupabase
    .from("agent_blueprints")
    .select("id")
    .eq("slug", value)
    .limit(2);

  const serverId = flags["server-id"] ?? ACTOR_CLAIMS.server_id;
  if (serverId) query = query.eq("server_id", serverId);

  const { data, error } = await query;
  if (error) fail("BLUEPRINT_RESOLVE_FAILED", error.message);

  const blueprints = (data ?? []) as Array<{ id: string }>;
  if (blueprints.length === 0) fail("BLUEPRINT_NOT_FOUND", `Blueprint not found: ${value}`);
  if (blueprints.length > 1) fail("AMBIGUOUS_BLUEPRINT", "Multiple blueprints match; provide --server-id");
  return blueprints[0].id;
}

async function cmdAgentCreate(flags: Record<string, string>) {
  let payload;
  try {
    payload = buildAgentCreatePayload(flags);
  } catch (error) {
    fail("INVALID_ARG", error instanceof Error ? error.message : "Invalid agent create arguments");
  }

  const { data, error } = await actorSupabase.rpc("agent_create_child", payload);
  if (error) fail("AGENT_CREATE_FAILED", error.message);

  let lines;
  try {
    lines = formatAgentCreateResult(data as AgentCreateResult);
  } catch (formatError) {
    fail("AGENT_CREATE_FAILED", formatError instanceof Error ? formatError.message : "Agent creation failed");
  }

  for (const line of lines) {
    console.log(line);
  }
}

async function cmdAgentSpawnRequest(flags: Record<string, string>) {
  const blueprintRef = flags.blueprint ?? flags["blueprint-id"] ?? null;
  const blueprintId = blueprintRef ? await resolveBlueprintId(blueprintRef, flags) : null;
  const reason = flags.reason ?? (await readStdin());
  if (!reason) fail("INVALID_ARG", "Missing --reason or stdin content");

  const serverId = await resolveAutonomousServerId(flags);
  const { data, error } = await actorSupabase.rpc("agent_spawn_request", {
    p_blueprint_id: blueprintId,
    p_reason: reason,
    p_source_refs: parseEvidenceRefs(flags, "source"),
    p_policy_result: parseJsonFlag(flags["policy-result"], {}),
    p_server_id: serverId,
  });

  if (error) fail("SPAWN_REQUEST_FAILED", error.message);
  console.log(`Agent spawn requested: ${data}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const [group, action, subaction] = args;
  const flags = parseArgs(args.slice(2));

  // Handle three-token commands first
  if (group === "thread") {
    switch (action) {
      case "list":
        return cmdThreadList(flags);
      case "read":
        return cmdThreadRead(flags);
      case "reply":
        return cmdThreadReply(flags);
      case "resolve":
        return cmdThreadResolve(flags);
    }
  }

  if (group === "task" && action === "artifact" && subaction === "add") {
    return cmdTaskArtifactAdd(flags);
  }

  if (group === "task" && action === "dependency" && subaction === "add") {
    return cmdTaskDependencyAdd(flags);
  }

  if (group === "task" && action === "review") {
    return cmdTaskReview(flags);
  }

  if (group === "task" && action === "verify") {
    return cmdTaskVerify(flags);
  }

  if (group === "task" && action === "comment") {
    return cmdTaskComment(flags);
  }

  if (group === "skill" && action === "candidate") {
    switch (subaction) {
      case "list":
        return cmdSkillCandidateList(flags);
      case "create":
        return cmdSkillCandidateCreate(flags);
      case "lint":
        return cmdSkillCandidateLint(flags);
      case "apply":
        return cmdSkillCandidateApply(flags);
    }
  }

  if (group === "skill" && action === "episode") {
    switch (subaction) {
      case "list":
        return cmdSkillEpisodeList(flags);
      case "create":
        return cmdSkillEpisodeCreate(flags);
      case "generate":
        return cmdSkillEpisodeGenerate(flags);
      case "no-op":
        return cmdSkillEpisodeNoOp(flags);
    }
  }

  if (group === "reminder") {
    switch (action) {
      case "create":
        return cmdReminderCreate(flags);
      case "list":
        return cmdReminderList(flags);
      case "snooze":
        return cmdReminderSnooze(flags);
      case "cancel":
        return cmdReminderCancel(flags);
      case "done":
        return cmdReminderDone(flags);
    }
  }

  if (group === "daemon") {
    switch (action) {
      case "status":
        return cmdDaemonStatus();
      case "deliveries":
        return cmdDaemonDeliveries(flags);
      case "traces":
        return cmdDaemonTraces(flags);
    }
  }

  if (group === "agent" && action === "create") {
    return cmdAgentCreate(flags);
  }

  if (group === "agent" && action === "sessions") {
    return cmdAgentSessions(flags);
  }

  if (group === "agent" && action === "local-state") {
    return cmdAgentLocalState();
  }

  if (group === "agent" && action === "blueprint") {
    switch (subaction) {
      case "list":
        return cmdAgentBlueprintList(flags);
      case "create":
        return cmdAgentBlueprintCreate(flags);
    }
  }

  if (group === "agent" && action === "spawn" && subaction === "request") {
    return cmdAgentSpawnRequest(flags);
  }

  switch (`${group} ${action}`) {
    case "message send":
      return cmdMessageSend(flags);

    case "message send-draft":
      return cmdMessageSendDraft(flags);

    case "message check":
      return cmdMessageCheck();

    case "message read":
      return cmdMessageRead(flags);

    case "message search":
      return cmdMessageSearch(flags);

    case "server info":
      return cmdServerInfo();

    case "task list":
      return cmdTaskList(flags);

    case "task create":
      return cmdTaskCreate(flags);

    case "task claim":
      return cmdTaskClaim(flags);

    case "task unclaim":
      return cmdTaskUnclaim(flags);

    case "task update":
      return cmdTaskUpdate(flags);

    case "skill list":
      return cmdSkillList(flags);

    case "skill search":
      return cmdSkillSearch(flags);

    case "skill view":
      return cmdSkillView(flags);

    case "skill attest":
      return cmdSkillAttest(flags);

    case "knowledge save":
      return cmdKnowledgeSave(flags);

    case "knowledge search":
    case "knowledge list":
      return cmdKnowledgeSearch(flags);

    default:
      console.log(`Zano CLI v0.2.0

Usage:
  zano message send --target "#channel"    Send a message (content via stdin)
  zano message send-draft <draft-id>       Send a held draft after freshness review
  zano message check                       Check for new messages
  zano message read --channel "#channel"   Read channel history
  zano message search --query "keyword"    Search messages
  zano server info                         Show server info
  zano thread list --channel "#channel"    List threads
  zano thread read --target "#ch:abcd1234" Read thread with replies
  zano thread reply --target "#ch:abcd1234" Reply to thread (stdin)
  zano thread resolve --target "#ch:abcd"  Resolve/unresolve thread
  zano task list [--channel "#ch"] [--status S] [--tag T]
                                           List tasks
  zano task create --channel "#ch" --title "T" [--priority high] [--tag T] [--claim]
                                           Create a task
  zano task claim --number N               Claim a task
  zano task unclaim --number N             Release a task
  zano task update --number N [--status S] [--summary "..."]
                                           Update task
  zano task verify --number N --type T --check "..." --passed|--failed [--summary "..."]
                                           Record verification evidence
  zano task comment --number N             Comment on task (stdin)
  zano task artifact add --number N --type pr --title "T" [--url ...]
                                           Add artifact
  zano task dependency add --number N --blocks M
                                           Add blocking dependency
  zano task review --number N --approve|--changes-requested|--blocked [--summary "..."]
                                           Review task
  zano reminder create --target "#ch" --at ISO [--body "..."]
                                           Create author-owned wake-up
  zano reminder list [--state pending]     List reminders
  zano reminder snooze --id ID --in 30m    Snooze reminder
  zano reminder cancel --id ID             Cancel reminder
  zano reminder done --id ID               Mark reminder handled
  zano skill list [--state active]         List visible skills
  zano skill search --query "keyword"      Search visible skills
  zano skill view --slug skill-slug        Show a skill and latest version
  zano skill candidate create --slug S --rationale "why"
                                           Propose a skill create/patch (stdin)
  zano skill candidate list [--state pending]
                                           List skill candidates
  zano skill candidate apply --id abcd1234 [--reason "..."]
                                           Lint and apply low/medium-risk candidate
  zano skill candidate lint --id abcd1234  Run deterministic candidate lint
  zano skill episode create --trigger correction --strength medium
                                           Record a learning episode (stdin)
  zano skill episode generate --turn-id UUID [--strength strong]
                                           Generate an episode from turn evidence
  zano skill episode list [--status open]  List learning episodes
  zano skill episode no-op --id abcd1234 [--reason "..."]
                                           Mark an episode as explicitly no-op
  zano skill attest --slug S --type useful [--summary "..."]
                                           Add skill curation evidence
  zano knowledge save --subject "topic"    Save knowledge (stdin)
  zano knowledge search [--query "term"]   Search saved knowledge
  zano daemon status                       Show daemon delivery/session status
  zano daemon deliveries [--agent UUID]    List daemon deliveries
  zano daemon traces --trace TRACE_ID      Show daemon trace events
  zano agent create --display-name "Name" --reason "why" [--description "..."] [--system-prompt "..."] [--source task:72]
                                           Create a child agent
  zano agent sessions [--agent UUID]       List runtime sessions
  zano agent local-state                   Show local runtime state path
  zano agent blueprint list                List agent blueprints
  zano agent blueprint create --slug S --display-name "Name" --description "..."
                                           Create blueprint (prompt via stdin)
  zano agent spawn request [--blueprint S] --reason "why"
                                           Request autonomous agent spawn

Environment:
  ZANO_AGENT_ID        Agent UUID
  ZANO_SERVER_URL      Supabase project URL materialized by the bridge
  ZANO_AGENT_TOKEN_FILE Agent-scoped actor token file
  ZANO_AGENT_PROXY_URL Local credential proxy endpoint
  ZANO_AGENT_PROXY_TOKEN_FILE Local proxy token file
  ZANO_AGENT_ACTIVE_CAPABILITIES Active local proxy capabilities
  ZANO_AGENT_LOCAL_STATE Agent-local runtime state file path
  ZANO_DELIVERY_ID     Current daemon delivery id, set by bridge runtime
  ZANO_DELIVERY_SEQ    Current per-agent delivery sequence
  ZANO_TRACEPARENT     Current daemon traceparent`);
      break;
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ ok: false, code: "CLI_ERROR", message: err.message }) +
      "\n"
  );
  process.exit(1);
});
