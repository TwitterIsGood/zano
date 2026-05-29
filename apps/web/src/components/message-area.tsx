'use client';

import type { Task } from '@zano/shared';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { GearSix } from '@phosphor-icons/react';
import { Check, MessageSquareText, RotateCcw } from 'lucide-react';
import TiptapMessageInput, { type TiptapMessageInputHandle } from './tiptap-message-input';
import { useAgentActivity, type ActivityState } from '@/hooks/use-agent-activity';
import { usePageRecovery } from '@/hooks/use-page-recovery';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GeneratedAvatar } from './generated-avatar';
import { ThreadPanel } from './thread-panel';
import { MessageActionMenu } from './message-action-menu';
import { ContextMenu } from './context-menu';
import { MessageBody } from './message-body';
import { MessageDeliveryDrawer } from './message-delivery-drawer';
import { TaskDetailDrawer } from './task-detail-drawer';

interface Message {
  id: string;
  content: string;
  sender_id: string;
  sender_type: 'human' | 'agent' | 'system';
  seq: number | null;
  created_at: string;
  thread_parent_id: string | null;
  reply_count: number;
  last_reply_at: string | null;
  thread_resolved_at: string | null;
  profiles?: { display_name: string } | null;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface AgentInfo {
  id: string;
  name: string;
  display_name: string;
  status: string;
  description: string | null;
  archived_at: string | null;
}

interface ChannelMember {
  member_id: string;
}

interface MessageInsertPayload {
  new: unknown;
}

function publicAgentHandle(displayName: string, fallback = 'Agent') {
  const handle = displayName
    .trim()
    .replace(/\s+/gu, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '');
  return handle || fallback;
}

function agentMentionHandle(agent: AgentInfo) {
  return publicAgentHandle(agent.display_name, agent.name);
}

function agentIdFromDmChannelName(name: string) {
  return name.startsWith('dm-') ? name.slice(3) : null;
}

function getDmTargetAgent(channel: Channel, agents: AgentInfo[]) {
  if (!channel.name) return null;
  const targetAgentId = agentIdFromDmChannelName(channel.name);
  if (targetAgentId) {
    return agents.find((agent) => agent.id === targetAgentId) ?? null;
  }
  return agents.length === 1 ? agents[0] : null;
}

function isChannelActivity(act: ActivityState | undefined, channelId: string) {
  return (act?.activity === 'thinking' || act?.activity === 'working') && act.channelId === channelId;
}

function mergeMessages(prev: Message[], incoming: Message[]) {
  if (incoming.length === 0) return prev;

  let changed = false;
  const next = [...prev];

  for (const message of incoming) {
    const existingIndex = next.findIndex((existing) => existing.id === message.id);
    if (existingIndex !== -1) {
      next[existingIndex] = { ...next[existingIndex], ...message };
      changed = true;
      continue;
    }

    const optimisticIndex = next.findIndex(
      (existing) =>
        existing.id.startsWith('optimistic-') &&
        existing.sender_id === message.sender_id &&
        existing.sender_type === message.sender_type &&
        existing.content === message.content,
    );
    if (optimisticIndex !== -1) {
      next[optimisticIndex] = message;
    } else {
      next.push(message);
    }
    changed = true;
  }

  if (!changed) return prev;

  return next.sort((a, b) => {
    if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

export function MessageArea({
  channel,
  onToggleSettings,
  showSettings,
}: {
  channel: Channel | null;
  onToggleSettings?: (agent: AgentInfo | null) => void;
  showSettings?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [sending, setSending] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [currentUserDisplayName, setCurrentUserDisplayName] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [channelAgents, setChannelAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [dmAgentUnavailable, setDmAgentUnavailable] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStartRef = useRef<string | null>(null);
  const latestMessageSeqRef = useRef(0);
  const channelLoadIdRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const inputRef = useRef<TiptapMessageInputHandle>(null);
  const [openThreadMessageId, setOpenThreadMessageId] = useState<string | null>(null);
  const [deliveryMessageId, setDeliveryMessageId] = useState<string | null>(null);
  const [tasksByNumber, setTasksByNumber] = useState<Map<number, Task>>(new Map());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
  const supabase = createClient();
  const agentActivities = useAgentActivity();
  const channelId = channel?.id ?? null;

  const loadTasks = useCallback(async () => {
    if (!channelId) {
      setTasksByNumber(new Map());
      return;
    }

    const res = await fetch(`/api/tasks?channelId=${channelId}`);
    if (!res.ok) return;

    const data = (await res.json()) as { tasks?: Task[] };
    setTasksByNumber(new Map((data.tasks ?? []).map((task) => [task.task_number, task])));
  }, [channelId]);

  const applyIncomingMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;

    setMessages((prev) => mergeMessages(prev, incoming));

    if (incoming.some((msg) => msg.sender_type === 'agent')) {
      setAgentTyping(false);
      typingStartRef.current = null;
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    }

    if (incoming.some((msg) => /#\d+\b/.test(msg.content))) {
      void loadTasks();
    }
  }, [loadTasks]);

  const loadChannelSnapshot = useCallback(async ({ reset = false, scrollToBottom = false } = {}) => {
    if (!channel) return;

    const loadId = ++channelLoadIdRef.current;
    const channelId = channel.id;

    const { data: members } = await supabase
      .from('channel_members')
      .select('member_id')
      .eq('channel_id', channelId)
      .eq('member_type', 'agent');

    if (loadId !== channelLoadIdRef.current) return;

    if (members && members.length > 0) {
      const agentIds = (members as ChannelMember[]).map((m) => m.member_id);
      const { data: agentsData } = await supabase
        .from('agents')
        .select('id, name, display_name, status, description, archived_at')
        .in('id', agentIds)
        .is('archived_at', null);

      if (loadId !== channelLoadIdRef.current) return;

      const activeAgents = (agentsData ?? []) as AgentInfo[];
      const agentMap = new Map<string, AgentInfo>();
      for (const agent of activeAgents) {
        agentMap.set(agent.id, agent);
      }

      if (channel.type === 'dm') {
        const dmAgent = getDmTargetAgent(channel, activeAgents);
        setChannelAgents(dmAgent ? new Map([[dmAgent.id, dmAgent]]) : new Map());
        setAgentInfo(dmAgent);
        setDmAgentUnavailable(!dmAgent);
      } else {
        setChannelAgents(agentMap);
        setDmAgentUnavailable(false);
      }
    } else {
      setChannelAgents(new Map());
      setAgentInfo(null);
      setDmAgentUnavailable(channel.type === 'dm');
    }

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('channel_id', channelId)
      .is('thread_parent_id', null)
      .order('seq', { ascending: false })
      .limit(50);

    if (loadId !== channelLoadIdRef.current) return;

    if (data) {
      const reversed = (data as Message[]).reverse();
      if (reset) {
        setMessages(reversed);
        setHasMore(data.length === 50);
      } else {
        setMessages((prev) => mergeMessages(prev, reversed));
      }
      if (scrollToBottom) {
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    }

    await loadTasks();
  }, [channel, loadTasks, supabase]);

  const syncMessagesSince = useCallback(async (sinceSeq: number) => {
    if (!channel || sinceSeq <= 0) return;

    let cursor = sinceSeq;
    const recovered: Message[] = [];

    for (;;) {
      const params = new URLSearchParams({
        channel_id: channel.id,
        since_seq: String(cursor),
        limit: '200',
      });
      const res = await fetch(`/api/messages/sync?${params.toString()}`);
      if (!res.ok) return;

      const payload = (await res.json()) as {
        messages?: Message[];
        currentSeq?: number;
        hasMore?: boolean;
      };
      const batch = payload.messages ?? [];
      if (batch.length > 0) {
        recovered.push(...batch);
      }

      const batchMaxSeq = batch.reduce((max, msg) => Math.max(max, msg.seq ?? 0), cursor);
      cursor = Math.max(cursor, payload.currentSeq ?? 0, batchMaxSeq);

      if (!payload.hasMore || batch.length === 0) break;
    }

    applyIncomingMessages(recovered);
  }, [applyIncomingMessages, channel]);

  const reconcileChannelState = useCallback(async () => {
    const sinceSeq = latestMessageSeqRef.current;
    await loadChannelSnapshot({ reset: false });
    if (sinceSeq > 0) await syncMessagesSince(sinceSeq);
    await loadTasks();
  }, [loadChannelSnapshot, loadTasks, syncMessagesSince]);

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
      setCurrentUserDisplayName(data?.display_name ?? null);
    })();
  }, [supabase]);

  useEffect(() => {
    if (!channel) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMessages([]);
      setAgentInfo(null);
      setChannelAgents(new Map());
      setDmAgentUnavailable(channel.type === 'dm');
      setTasksByNumber(new Map());
      setSelectedTask(null);
      setAgentTyping(false);
      setHasMore(true);
      setLoadingMore(false);
      latestMessageSeqRef.current = 0;
      isNearBottomRef.current = true;
      void loadChannelSnapshot({ reset: true, scrollToBottom: true });
    });

    const subscription = supabase
      .channel(`messages:${channel.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channel.id}`,
        },
        (payload: MessageInsertPayload) => {
          const newMsg = payload.new as Message;
          if (!newMsg.thread_parent_id) {
            applyIncomingMessages([newMsg]);
          }
        },
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          void reconcileChannelState();
        }
      });

    inputRef.current?.focus();

    return () => {
      cancelled = true;
      channelLoadIdRef.current += 1;
      supabase.removeChannel(subscription);
    };
  }, [applyIncomingMessages, channel, loadChannelSnapshot, reconcileChannelState, supabase]);

  useEffect(() => {
    latestMessageSeqRef.current = messages.reduce((maxSeq, msg) => Math.max(maxSeq, msg.seq ?? 0), 0);
  }, [messages]);

  useEffect(() => {
    if (!channel) return;

    let cancelled = false;

    const poll = async () => {
      const latestSeq = latestMessageSeqRef.current;
      if (latestSeq <= 0 || cancelled) return;
      await syncMessagesSince(latestSeq);
    };

    const interval = setInterval(poll, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [channel, syncMessagesSince]);

  usePageRecovery(() => {
    void reconcileChannelState();
  }, { minIntervalMs: 1500 });

  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, agentTyping]);

  const loadOlderMessages = useCallback(async () => {
    if (!channel || loadingMore || !hasMore || messages.length === 0) return;
    const oldestSeq = messages[0]?.seq;
    if (!oldestSeq) return;

    setLoadingMore(true);
    const el = scrollContainerRef.current;
    const prevScrollHeight = el?.scrollHeight || 0;

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('channel_id', channel.id)
      .is('thread_parent_id', null)
      .lt('seq', oldestSeq)
      .order('seq', { ascending: false })
      .limit(50);

    if (data) {
      const older = (data as Message[]).reverse();
      setHasMore(data.length === 50);
      setMessages((prev) => [...older, ...prev]);
      requestAnimationFrame(() => {
        if (el) {
          el.scrollTop = el.scrollHeight - prevScrollHeight;
        }
      });
    }
    setLoadingMore(false);
  }, [channel, loadingMore, hasMore, messages, supabase]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (el.scrollTop < 100 && hasMore && !loadingMore) {
      loadOlderMessages();
    }
  }, [hasMore, loadingMore, loadOlderMessages]);

  async function verifyDmTargetActive() {
    if (!channel || channel.type !== 'dm') return true;

    const targetAgent = agentInfo ?? getDmTargetAgent(channel, Array.from(channelAgents.values()));
    if (!targetAgent) {
      setAgentInfo(null);
      setDmAgentUnavailable(true);
      return false;
    }

    const { data } = await supabase
      .from('agents')
      .select('id')
      .eq('id', targetAgent.id)
      .is('archived_at', null)
      .maybeSingle();

    if (data) return true;

    setAgentInfo(null);
    setDmAgentUnavailable(true);
    return false;
  }

  const doSend = useCallback(
    async (markdown: string) => {
      const content = markdown.trim();
      if (!content || !channel || !userId) return;
      if (channel.type === 'dm' && dmAgentUnavailable) return;
      if (channel.type === 'dm' && !(await verifyDmTargetActive())) return;

      setSending(true);
      setHasContent(false);

      const shouldExpectAgentResponse = channel.type === 'dm' ? Boolean(agentInfo) : channelAgents.size > 0;
      if (shouldExpectAgentResponse) {
        const startedAt = new Date().toISOString();
        setAgentTyping(true);
        typingStartRef.current = startedAt;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setAgentTyping(false);
          typingStartRef.current = null;
        }, 130000);
      }

      const optimisticMsg: Message = {
        id: `optimistic-${Date.now()}`,
        content,
        sender_id: userId,
        sender_type: 'human',
        seq: null,
        created_at: new Date().toISOString(),
        thread_parent_id: null,
        reply_count: 0,
        last_reply_at: null,
        thread_resolved_at: null,
        profiles: null,
      };
      setMessages((prev) => [...prev, optimisticMsg]);

      const { data: inserted } = await supabase
        .from('messages')
        .insert({
          channel_id: channel.id,
          sender_id: userId,
          sender_type: 'human',
          content,
        })
        .select()
        .single();

      if (inserted) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === inserted.id)) {
            return prev.filter((m) => m.id !== optimisticMsg.id);
          }
          return prev.map((m) => (m.id === optimisticMsg.id ? ({ ...inserted, profiles: null } as Message) : m));
        });
      }

      setSending(false);
      inputRef.current?.focus();
    },
    [channel, userId, supabase, channelAgents, agentInfo, dmAgentUnavailable],
  );

  const contextMenuMessage = contextMenu ? messages.find((m) => m.id === contextMenu.messageId) : null;
  const mentions = useMemo(() => {
    const list: Array<{ id?: string; name: string; displayName: string; aliases?: string[] }> = Array.from(channelAgents.values()).map((a) => ({
      id: a.id,
      name: agentMentionHandle(a),
      displayName: a.display_name,
      aliases: [a.name],
    }));
    if (userId) {
      list.push({ id: userId, name: userId, displayName: 'You' });
    }
    if (currentUserDisplayName) {
      list.push({ name: currentUserDisplayName, displayName: 'You' });
    }
    return list;
  }, [channelAgents, userId, currentUserDisplayName]);

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center bg-card">
        <div className="text-center">
          <div className="text-5xl font-light text-muted-foreground/20 mb-4">Z</div>
          <p className="text-sm text-muted-foreground">Select a conversation to start chatting</p>
        </div>
      </div>
    );
  }

  function getSenderName(msg: Message) {
    if (msg.sender_type === 'system') return 'System';
    if (msg.sender_type === 'agent') {
      const agent = channelAgents.get(msg.sender_id);
      return agent?.display_name || agentInfo?.display_name || 'Agent';
    }
    if (msg.profiles?.display_name) return msg.profiles.display_name;
    return 'You';
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function toggleThreadResolved(messageId: string, resolved: boolean) {
    const res = await fetch(`/api/threads/${messageId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved }),
    });
    if (!res.ok) return;

    const data = await res.json();
    setMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, ...data.thread } : msg)));
  }

  function openMessageMenu(messageId: string, x: number, y: number) {
    setContextMenu({ messageId, x, y });
  }

  return (
    <div className="flex min-h-0 flex-1 bg-card max-w-full text-pretty">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Channel header */}
        <div className="flex items-center gap-3 border-b-[0.5px] py-2 px-3">
        {channel.type === 'dm' && agentInfo ? (
          <>
            <div className="relative size-8">
              <GeneratedAvatar id={agentInfo.id} name={agentInfo.display_name} size="md" />
              {(() => {
                const act = agentActivities.get(agentInfo.id);
                const isActive = isChannelActivity(act, channel.id);
                const isOnline = agentInfo.status === 'online' || agentInfo.status === 'active';
                const dotColor = isActive
                  ? 'bg-green-500 animate-status-pulse'
                  : isOnline
                    ? 'bg-green-500'
                    : agentInfo.status === 'sleeping'
                      ? 'bg-yellow-500'
                      : act?.activity === 'error'
                        ? 'bg-red-500'
                        : 'bg-gray-400';
                return (
                  <div
                    className={`absolute bottom-0 right-0 h-2.5 w-2.5 translate-x-[2px] translate-y-[2px] rounded-full border-2 border-card ${dotColor}`}
                  />
                );
              })()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">{agentInfo.display_name}</h2>
                {(() => {
                  const act = agentActivities.get(agentInfo.id);
                  if (!act || !isChannelActivity(act, channel.id)) return null;
                  const label = act.label || (act.activity === 'thinking' ? 'Thinking' : 'Working');
                  return (
                    <span className="flex items-center gap-1.5 text-[11px] text-primary">
                      <span className="font-medium">{label}</span>
                      {act.detail && <span className="text-muted-foreground truncate max-w-[200px]">{act.detail}</span>}
                    </span>
                  );
                })()}
              </div>
              {agentInfo.description && (
                <p className="text-[12px] text-muted-foreground truncate">{agentInfo.description}</p>
              )}
            </div>
            {onToggleSettings && (
              <Button
                onClick={() => onToggleSettings(showSettings ? null : agentInfo)}
                variant={showSettings ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-label="Agent Settings">
                <GearSix size={18} />
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="text-lg text-muted-foreground">#</span>
            <div className="flex-1 min-w-0">
              <h2 className="text-[14px] font-semibold">{channel.name}</h2>
              {channel.description && (
                <p className="text-[12px] text-muted-foreground truncate">{channel.description}</p>
              )}
            </div>
            {channelAgents.size > 0 && (
              <div className="flex items-center gap-1">
                {Array.from(channelAgents.values()).map((agent) => {
                  const act = agentActivities.get(agent.id);
                  const isActive = isChannelActivity(act, channel.id);
                  const isOnline = agent.status === 'online' || agent.status === 'active';
                  const dotColor = isActive
                    ? 'bg-green-500 animate-status-pulse'
                    : isOnline
                      ? 'bg-green-500'
                      : agent.status === 'sleeping'
                        ? 'bg-yellow-500'
                        : act?.activity === 'error'
                          ? 'bg-red-500'
                          : 'bg-gray-400';
                  const title = act && (isActive || act.activity === 'error')
                    ? `${agent.display_name}: ${act.label || act.activity}${act.detail ? ` · ${act.detail}` : ''}`
                    : agent.display_name;

                  return (
                    <div key={agent.id} className="relative" title={title}>
                      <GeneratedAvatar id={agent.id} name={agent.display_name} size="xs" />
                      <div className={`absolute bottom-0 right-0 h-2 w-2 translate-x-[2px] translate-y-[2px] rounded-full border border-card ${dotColor}`} />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
        {loadingMore && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-muted-foreground">Loading older messages...</span>
          </div>
        )}
        {!hasMore && messages.length > 0 && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-muted-foreground">Beginning of conversation</span>
          </div>
        )}
        {messages.map((msg, i) => {
          const prevMsg = messages[i - 1];
          const sameSender =
            prevMsg &&
            prevMsg.sender_id === msg.sender_id &&
            new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() < 5 * 60 * 1000;
          const isOwn = msg.sender_id === userId;

          return (
            <div
              key={msg.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMessageMenu(msg.id, event.clientX, event.clientY);
              }}
              className={`group flex gap-3 rounded-lg px-2 py-1.5 transition-colors ${
                sameSender ? '' : 'mt-5 first:mt-0'
              }`}>
              <div className="w-8 shrink-0 pt-0.5">
                {!sameSender && <GeneratedAvatar id={msg.sender_id} name={getSenderName(msg)} size="md" />}
              </div>

              <div className="relative flex-1 min-w-0">
                {!sameSender && (
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[13px] font-semibold">{getSenderName(msg)}</span>
                    {msg.sender_type === 'agent' && (
                      <Badge variant="secondary" className="text-[10px] py-0">
                        agent
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground">{formatTime(msg.created_at)}</span>
                  </div>
                )}
                <MessageBody
                  content={msg.content}
                  senderType={msg.sender_type}
                  mentions={mentions}
                  tasksByNumber={tasksByNumber}
                  onOpenTask={setSelectedTask}
                />
                <div className="absolute right-9 top-0 z-10 flex h-7 translate-y-1 items-center opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100">
                  <Button size="xs" variant="outline" onClick={() => setDeliveryMessageId(msg.id)}>
                    Deliveries
                  </Button>
                </div>
                <MessageActionMenu
                  replyCount={msg.reply_count ?? 0}
                  lastReplyAt={msg.last_reply_at ?? null}
                  resolved={Boolean(msg.thread_resolved_at)}
                  onOpenThread={() => setOpenThreadMessageId(msg.id)}
                  onResolve={() => toggleThreadResolved(msg.id, true)}
                  onReopen={() => toggleThreadResolved(msg.id, false)}
                />
              </div>

              {sameSender && (
                <span className="hidden group-hover:block text-[11px] text-muted-foreground self-center flex-shrink-0">
                  {formatTime(msg.created_at)}
                </span>
              )}
            </div>
          );
        })}

        {/* Typing indicator */}
        {(() => {
          let activeAgentName: string | null = null;
          let activeAgentId: string | null = null;
          let activityLabel = '';
          let activityDetail = '';
          let isActive = false;

          if (channel?.type === 'dm' && agentInfo) {
            const act = agentActivities.get(agentInfo.id);
            if (act && isChannelActivity(act, channel.id)) {
              isActive = true;
              activeAgentName = agentInfo.display_name;
              activeAgentId = agentInfo.id;
              activityLabel = act.label || '';
              activityDetail = act.detail || '';
            }
          } else if (channel) {
            for (const [agentId, agent] of channelAgents) {
              const act = agentActivities.get(agentId);
              if (act && isChannelActivity(act, channel.id)) {
                isActive = true;
                activeAgentName = agent.display_name;
                activeAgentId = agentId;
                activityLabel = act.label || '';
                activityDetail = act.detail || '';
                break;
              }
            }
          }

          if (!isActive && agentTyping) {
            isActive = true;
            const firstAgent = agentInfo || Array.from(channelAgents.values())[0];
            activeAgentName = firstAgent?.display_name || 'Agent';
            activeAgentId = firstAgent?.id || 'unknown';
            activityLabel = 'Thinking';
            activityDetail = '';
          }

          if (!isActive) return null;

          const isTextOutput = !activityLabel && activityDetail;
          const displayLabel = activityLabel || 'Thinking';

          return (
            <div className="flex gap-3 px-2 py-1 mt-4">
              <div className="w-8 flex-shrink-0 pt-0.5">
                <GeneratedAvatar id={activeAgentId || 'unknown'} name={activeAgentName || 'A'} size="md" />
              </div>
              <div className="flex-1 min-w-0 py-1.5">
                {isTextOutput ? (
                  <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2">{activityDetail}</p>
                ) : (
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex shrink-0 gap-1">
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
                    </div>
                    <span className="shrink-0 text-[12px] font-medium text-primary">{displayLabel}</span>
                    {activityDetail && (
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{activityDetail}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="relative px-4 pb-4 pt-2">
        {/* @mention autocomplete dropdown */}
        {mentionQuery !== null &&
          channel.type !== 'dm' &&
          (() => {
            const agents = Array.from(channelAgents.values()).filter((a) => {
              const query = mentionQuery.toLowerCase();
              return a.display_name.toLowerCase().includes(query) || agentMentionHandle(a).toLowerCase().includes(query);
            });
            if (agents.length === 0) return null;
            return (
              <div className="absolute bottom-full left-4 right-4 mb-1 py-1 max-h-48 overflow-y-auto z-50 rounded-lg border bg-popover shadow-lg">
                {agents.map((agent, i) => (
                  <button
                    key={agent.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      inputRef.current?.replaceMention(mentionQuery, `@${agentMentionHandle(agent)} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      inputRef.current?.focus();
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors ${
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50'
                    }`}>
                    <GeneratedAvatar id={agent.id} name={agent.display_name} size="xs" />
                    <div className="flex-1 min-w-0 text-left">
                      <div>{agent.display_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">@{agentMentionHandle(agent)}</div>
                      {agent.description && (
                        <div className="text-[10px] text-muted-foreground truncate">{agent.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}
        {dmAgentUnavailable ? (
          <div className="mb-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This DM is no longer active because the agent was archived.
          </div>
        ) : null}
        <div className="rounded-lg border bg-card shadow-xs/5 overflow-hidden focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 transition-shadow">
          <div className="px-4 pt-3 pb-1 text-[15px] leading-[1.54]">
            <TiptapMessageInput
              ref={inputRef}
              placeholder={
                channel.type === 'dm'
                  ? `Message ${agentInfo?.display_name || 'agent'}...`
                  : `@ to mention an agent in #${channel.name}...`
              }
              disabled={sending || dmAgentUnavailable}
              onSend={doSend}
              onTextUpdate={(textBeforeCursor, fullText) => {
                if (channel.type !== 'dm') {
                  const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
                  if (atMatch) {
                    setMentionQuery(atMatch[1]);
                    setMentionIndex(0);
                  } else {
                    setMentionQuery(null);
                  }
                }
                setHasContent(fullText.trim().length > 0);
              }}
              onKeyDown={(event) => {
                if (mentionQuery !== null && channel.type !== 'dm') {
                  const agents = Array.from(channelAgents.values()).filter((a) => {
                    const query = mentionQuery.toLowerCase();
                    return a.display_name.toLowerCase().includes(query) || agentMentionHandle(a).toLowerCase().includes(query);
                  });
                  if (agents.length > 0) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      const agent = agents[mentionIndex];
                      inputRef.current?.replaceMention(mentionQuery, `@${agentMentionHandle(agent)} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      return true;
                    }
                    if (event.key === 'ArrowDown') {
                      setMentionIndex((prev) => (prev + 1) % agents.length);
                      return true;
                    }
                    if (event.key === 'ArrowUp') {
                      setMentionIndex((prev) => (prev - 1 + agents.length) % agents.length);
                      return true;
                    }
                    if (event.key === 'Tab') {
                      const agent = agents[mentionIndex];
                      inputRef.current?.replaceMention(mentionQuery, `@${agentMentionHandle(agent)} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      return true;
                    }
                    if (event.key === 'Escape') {
                      setMentionQuery(null);
                      return true;
                    }
                  }
                }
                return false;
              }}
            />
          </div>
          <div className="flex items-center justify-end px-2.5 pb-2.5">
            <Button
              type="button"
              onClick={() => {
                const md = inputRef.current?.getMarkdown() ?? '';
                if (md.trim()) {
                  doSend(md);
                  inputRef.current?.clear();
                }
              }}
              disabled={sending || !hasContent || dmAgentUnavailable}
              size="sm">
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
      </div>
      </div>
      <ThreadPanel
        parentMessageId={openThreadMessageId}
        userId={userId}
        mentions={mentions}
        tasksByNumber={tasksByNumber}
        onOpenTask={setSelectedTask}
        onClose={() => setOpenThreadMessageId(null)}
      />
      <TaskDetailDrawer
        task={selectedTask}
        open={Boolean(selectedTask)}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
      />
      <MessageDeliveryDrawer
        messageId={deliveryMessageId}
        open={Boolean(deliveryMessageId)}
        onClose={() => setDeliveryMessageId(null)}
      />
      {contextMenu && contextMenuMessage && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              label: contextMenuMessage.reply_count > 0
                ? `View thread · ${contextMenuMessage.reply_count} ${contextMenuMessage.reply_count === 1 ? 'reply' : 'replies'}`
                : 'Reply in thread',
              icon: <MessageSquareText className="h-4 w-4" />,
              onClick: () => setOpenThreadMessageId(contextMenu.messageId),
            },
            ...(contextMenuMessage.reply_count > 0 && Boolean(contextMenuMessage.thread_resolved_at)
              ? [{
                  label: 'Reopen thread',
                  icon: <RotateCcw className="h-4 w-4" />,
                  onClick: () => toggleThreadResolved(contextMenu.messageId, false),
                }]
              : contextMenuMessage.reply_count > 0
                ? [{
                    label: 'Resolve thread',
                    icon: <Check className="h-4 w-4" />,
                    onClick: () => toggleThreadResolved(contextMenu.messageId, true),
                  }]
              : []),
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
