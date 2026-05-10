"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import TiptapMessageInput, { type TiptapMessageInputHandle } from "./tiptap-message-input";

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
  onClose: () => void;
}

export function ThreadPanel({ parentMessageId, userId, onClose }: ThreadPanelProps) {
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

      <ScrollArea className="flex-1 px-4 py-3">
        {parent ? (
          <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{parent.content}</ReactMarkdown>
          </div>
        ) : null}

        <div className="space-y-3">
          {replies.map((reply) => (
            <div key={reply.id} className="rounded-lg border p-3 text-sm">
              <div className="mb-1 text-xs text-muted-foreground">
                {reply.sender_type} · {new Date(reply.created_at).toLocaleString()}
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply.content}</ReactMarkdown>
            </div>
          ))}
        </div>
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
