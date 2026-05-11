"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { MessageSquareText, Check, RotateCcw, MoreHorizontal } from "lucide-react";
import { ContextMenu } from "./context-menu";

export interface MessageActionMenuHandle {
  openAt: (x: number, y: number) => void;
}

interface MessageActionMenuProps {
  replyCount: number;
  lastReplyAt: string | null;
  resolved: boolean;
  onOpenThread: () => void;
  onResolve: () => void;
  onReopen: () => void;
}

export const MessageActionMenu = forwardRef<MessageActionMenuHandle, MessageActionMenuProps>(
  function MessageActionMenu({ replyCount, lastReplyAt, resolved, onOpenThread, onResolve, onReopen }, ref) {
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    useImperativeHandle(ref, () => ({
      openAt: (x, y) => setContextMenu({ x, y }),
    }));

    const items = useMemo(() => {
      const menuItems = [
        {
          label: replyCount > 0
            ? `View thread · ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
            : "Reply in thread",
          icon: <MessageSquareText className="h-4 w-4" />,
          onClick: onOpenThread,
        },
      ];

      if (replyCount > 0 && resolved) {
        menuItems.push({
          label: "Reopen thread",
          icon: <RotateCcw className="h-4 w-4" />,
          onClick: onReopen,
        });
      } else if (replyCount > 0) {
        menuItems.push({
          label: "Resolve thread",
          icon: <Check className="h-4 w-4" />,
          onClick: onResolve,
        });
      }

      return menuItems;
    }, [onOpenThread, onReopen, onResolve, replyCount, resolved]);

    useEffect(() => {
      if (!contextMenu) return;
      function handleScroll() {
        setContextMenu(null);
      }
      window.addEventListener("scroll", handleScroll, true);
      return () => window.removeEventListener("scroll", handleScroll, true);
    }, [contextMenu]);

    function openFromButton(event: React.MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setContextMenu({ x: rect.right - 8, y: rect.bottom + 4 });
    }

    return (
      <>
        <button
          type="button"
          onClick={openFromButton}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({ x: event.clientX, y: event.clientY });
          }}
          className="absolute right-0 top-0 flex h-7 items-center gap-1 rounded-md border bg-popover px-1.5 text-xs text-muted-foreground shadow-sm opacity-0 translate-y-1 transition-all duration-150 hover:bg-accent hover:text-accent-foreground group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={replyCount > 0 ? `Thread actions, ${replyCount} replies` : "Message actions"}
        >
          {replyCount > 0 ? (
            <>
              <MessageSquareText className="h-3.5 w-3.5" />
              <span>{replyCount}</span>
              {resolved ? <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" /> : null}
              {lastReplyAt ? <span className="sr-only">Last reply {new Date(lastReplyAt).toLocaleTimeString()}</span> : null}
            </>
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </button>

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={items}
            onClose={() => setContextMenu(null)}
          />
        )}
      </>
    );
  },
);
