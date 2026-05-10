"use client";

import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ThreadButtonProps {
  replyCount: number;
  lastReplyAt: string | null;
  resolved: boolean;
  onOpen: () => void;
}

export function ThreadButton({ replyCount, lastReplyAt, resolved, onOpen }: ThreadButtonProps) {
  const label = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Reply in thread";

  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={onOpen}>
      <MessageSquareText className="h-3.5 w-3.5" />
      <span>{label}</span>
      {lastReplyAt ? <span>· {new Date(lastReplyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
      {resolved ? <span>· resolved</span> : null}
    </Button>
  );
}
