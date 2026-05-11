#!/usr/bin/env node

/**
 * Zano CLI — The command-line tool agents use to communicate with Zano.
 *
 * Talks directly to Supabase. Auth via environment variables:
 *   ZANO_AGENT_ID      — UUID of the agent
 *   ZANO_SUPABASE_URL  — Supabase project URL
 *   ZANO_SUPABASE_KEY  — Supabase anon/service key
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
 *   zano task update --number 3 --status done
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const AGENT_ID = process.env.ZANO_AGENT_ID;
const SUPABASE_URL = process.env.ZANO_SUPABASE_URL;
const SUPABASE_KEY = process.env.ZANO_SUPABASE_KEY;
const AUTH_TOKEN = process.env.ZANO_AUTH_TOKEN;

function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
  process.exit(1);
}

if (!AGENT_ID) fail("MISSING_AGENT_ID", "ZANO_AGENT_ID is not set");
if (!SUPABASE_URL) fail("MISSING_SUPABASE_URL", "ZANO_SUPABASE_URL is not set");
if (!SUPABASE_KEY) fail("MISSING_SUPABASE_KEY", "ZANO_SUPABASE_KEY is not set");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  ...(AUTH_TOKEN
    ? { global: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
    : {}),
});

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

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      let val = "true";
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        val = args[++i];
        if (key === "title" || key === "description" || key === "summary" || key === "reason") {
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
  let channelPart: string;
  let threadShortId: string | null = null;

  if (target.startsWith("dm:")) {
    // dm:@person or dm:@person:threadid
    const rest = target.slice(3); // @person or @person:threadid
    const colonIdx = rest.indexOf(":", 1); // skip the @ at index 0
    if (colonIdx > 0) {
      channelPart = "dm:" + rest.substring(0, colonIdx);
      threadShortId = rest.substring(colonIdx + 1);
    } else {
      channelPart = target;
    }
  } else if (target.startsWith("#")) {
    // #channel or #channel:threadid
    const colonIdx = target.indexOf(":");
    if (colonIdx > 0) {
      channelPart = target.substring(0, colonIdx);
      threadShortId = target.substring(colonIdx + 1);
    } else {
      channelPart = target;
    }
  } else {
    // Raw UUID
    return { channelId: target, threadParentId: null };
  }

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
    // Try agents
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .or(`display_name.eq.${personName},name.eq.${personName}`)
      .single();

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
    if (data) name = data.name || data.display_name;
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
      const other = members.find((m) => m.member_id !== AGENT_ID);
      if (other) {
        const name = await resolveSenderName(other.member_id, other.member_type);
        return `dm:@${name}`;
      }
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMessageSend(flags: Record<string, string>) {
  const target = flags.target;
  if (!target) fail("INVALID_ARG", "Missing --target");

  const content = await readStdin();
  if (!content) fail("INVALID_ARG", "Message content must be provided via stdin");

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

  const sid = shortId(data.id);
  console.log(`Message sent to ${target}. Message ID: ${sid}`);
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
      console.log(`  @${ag.name} "${ag.display_name}" (${ag.status})${desc}`);
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

  // --message-id fallback: look up task by message_id field
  const { data: tasksByMsg, error: msgError } = await supabase
    .from("tasks")
    .select("id, task_number, status, assignee_id, assignee_type, channel_id")
    .eq("message_id", messageId!);

  if (msgError) fail(code, msgError.message);
  if (!tasksByMsg || tasksByMsg.length === 0) fail(code, `Task with message ID ${messageId} not found`);
  return tasksByMsg[0];
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

  if (msgError) fail("CREATE_FAILED", msgError.message);

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      message_id: msg.id,
      channel_id: channelId,
      title,
      description: flags.description ?? null,
      priority: flags.priority ?? "medium",
      tags: tagValues.length > 0 ? tagValues : [],
      source_message_id: msg.id,
      parent_task_id: parentTask?.id ?? null,
      created_by_id: AGENT_ID,
      created_by_type: "agent",
      current_gate: shouldClaim ? "executing" : "ready_to_execute",
      ...(shouldClaim
        ? { assignee_id: AGENT_ID, assignee_type: "agent", status: "in_progress", started_at: new Date().toISOString() }
        : {}),
    })
    .select("task_number")
    .single();

  if (taskError) fail("CREATE_FAILED", taskError.message);

  console.log(`Task #${task.task_number} created${shouldClaim ? " and claimed" : ""} in ${channel}.`);
}

async function cmdTaskClaim(flags: Record<string, string>) {
  const task = await resolveTask(flags, "CLAIM_FAILED");

  if (task.assignee_id && task.assignee_id !== AGENT_ID) {
    const owner = await resolveSenderName(task.assignee_id, task.assignee_type || "agent");
    fail(
      "CLAIM_FAILED",
      `Task #${task.task_number} is already claimed by @${owner}`
    );
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({
      assignee_id: AGENT_ID,
      assignee_type: "agent",
      status: "in_progress",
      started_at: new Date().toISOString(),
      current_gate: "executing",
    })
    .eq("id", task.id)
    .is("assignee_id", null)
    .select("task_number")
    .single();

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
      process.stderr.write(`WARNING: Transition from ${task.status} to ${status} would be blocked by server rules: ${check.reason}\n`);
    }
  }

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
    metadata: {},
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
  const approve = flags.approve === "true";
  const changesRequested = flags["changes-requested"] === "true";
  if (approve === changesRequested) {
    fail("INVALID_ARG", "Provide exactly one of --approve or --changes-requested");
  }

  const summary = flags.summary ?? ((await readStdin()) || (approve ? "Approved" : "Changes requested"));
  const verdict = approve ? "pass" : "fail";

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
  console.log(`Review added to task #${task.task_number}: ${verdict}.`);
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

  if (group === "task" && action === "comment") {
    return cmdTaskComment(flags);
  }

  switch (`${group} ${action}`) {
    case "message send":
      return cmdMessageSend(flags);

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

    default:
      console.log(`Zano CLI v0.2.0

Usage:
  zano message send --target "#channel"    Send a message (content via stdin)
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
  zano task comment --number N             Comment on task (stdin)
  zano task artifact add --number N --type pr --title "T" [--url ...]
                                           Add artifact
  zano task dependency add --number N --blocks M
                                           Add blocking dependency
  zano task review --number N --approve|--changes-requested [--summary "..."]
                                           Review task

Environment:
  ZANO_AGENT_ID        Agent UUID
  ZANO_SUPABASE_URL    Supabase project URL
  ZANO_SUPABASE_KEY    Supabase anon key`);
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
