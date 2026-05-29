"use client";

import type { Task } from "@zano/shared";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GeneratedAvatar } from "./generated-avatar";
import TiptapMessageInput, { type TiptapMessageInputHandle } from "./tiptap-message-input";
import { MessageBody } from "./message-body";

interface ThreadMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: "human" | "agent" | "system";
  content: string;
  created_at: string;
  thread_resolved_at?: string | null;
}

interface ThreadPanelProps {
  parentMessageId: string | null;
  userId: string | null;
  mentions?: Array<{ id?: string; name: string; displayName: string; aliases?: string[] }>;
  tasksByNumber?: Map<number, Task>;
  onOpenTask?: (task: Task) => void;
  onClose: () => void;
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ThreadPanel({ parentMessageId, userId, mentions = [], tasksByNumber, onOpenTask, onClose }: ThreadPanelProps) {
  const [parent, setParent] = useState<ThreadMessage | null>(null);
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TiptapMessageInputHandle>(null);

  useEffect(() => {
    if (!parentMessageId) return;

    async function loadThread() {
      const res = await fetch(`/api/threads/${parentMessageId}`);
      if (!res.ok) {
        setError("Failed to load thread");
        return;
      }
      const data = await res.json();
      setParent(data.parent);
      setReplies(data.replies ?? []);
    }

    loadThread();
  }, [parentMessageId]);

  if (!parentMessageId) return null;

  async function sendReply(markdown: string) {
    const content = markdown.trim();
    if (!parent || !userId || !content) return;
    setSending(true);
    setError(null);
    const res = await fetch(`/api/threads/${parent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: parent.channel_id, content }),
    });
    if (res.ok) {
      const data = await res.json();
      setReplies((prev) => [...prev, data.message]);
      inputRef.current?.clear();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to send reply");
    }
    setSending(false);
  }

  async function toggleResolved() {
    if (!parent || !userId) return;
    setError(null);
    const res = await fetch(`/api/threads/${parent.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: !parent.thread_resolved_at }),
    });
    if (res.ok) {
      const data = await res.json();
      setParent(data.thread);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update thread");
    }
  }

  function getSenderLabel(msg: ThreadMessage) {
    if (msg.sender_type === "system") return "System";
    if (msg.sender_type === "human") return msg.sender_id === userId ? "You" : "Human";
    return mentions.find((mention) => mention.id === msg.sender_id)?.displayName ?? "Agent";
  }

  function renderThreadMessage(msg: ThreadMessage, isParent?: boolean) {
    const label = getSenderLabel(msg);
    return (
      <div className={`flex gap-3 rounded-lg px-2 py-1.5 ${isParent ? "rounded-lg border bg-muted/30 p-3" : ""}`}>
        <div className="w-8 shrink-0 pt-0.5">
          <GeneratedAvatar id={msg.sender_id} name={label} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{label}</span>
            <span className="text-[11px] text-muted-foreground">{formatTime(msg.created_at)}</span>
          </div>
          <MessageBody
            content={msg.content}
            senderType={msg.sender_type}
            mentions={mentions}
            tasksByNumber={tasksByNumber}
            onOpenTask={onOpenTask}
          />
        </div>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Thread</h2>
          <p className="text-xs text-muted-foreground">{replies.length} replies</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-4 py-3 space-y-1">
        {parent ? renderThreadMessage(parent, true) : null}
        {replies.map((reply) => (
          <div key={reply.id}>{renderThreadMessage(reply)}</div>
        ))}
      </ScrollArea>

      <div className="border-t p-3">
        {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
        <div className="mb-2 flex justify-end">
          <Button variant="outline" size="sm" onClick={toggleResolved} disabled={!parent}>
            {parent?.thread_resolved_at ? "Reopen" : "Resolve"}
          </Button>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2">
          <TiptapMessageInput ref={inputRef} onSend={sendReply} disabled={sending} placeholder="Reply in thread..." />
        </div>
      </div>
    </aside>
  );
}
