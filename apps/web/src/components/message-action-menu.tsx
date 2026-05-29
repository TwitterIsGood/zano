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

    function handleOpenThread(event: React.MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
      event.stopPropagation();
      onOpenThread();
    }

    function handleToggleResolved(event: React.MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
      event.stopPropagation();
      if (resolved) onReopen();
      else onResolve();
    }

    const lastReplyLabel = lastReplyAt
      ? new Date(lastReplyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;

    return (
      <>
        {replyCount > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={handleOpenThread}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ x: event.clientX, y: event.clientY });
              }}
              className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded border border-border bg-muted/40 px-1.5 text-[10px] font-medium leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`View thread, ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
            >
              <MessageSquareText className="h-3 w-3" />
              <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
              {lastReplyLabel ? <span className="text-muted-foreground/70">· Last reply {lastReplyLabel}</span> : null}
            </button>
            <button
              type="button"
              onClick={handleToggleResolved}
              className="inline-flex h-5 items-center gap-1 rounded border border-border bg-background px-1.5 text-[10px] font-medium leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={resolved ? "Reopen thread" : "Resolve thread"}
            >
              {resolved ? <RotateCcw className="h-3 w-3" /> : <Check className="h-3 w-3" />}
              <span>{resolved ? "Resolved" : "Resolve"}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={openFromButton}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY });
            }}
            className="absolute right-0 top-0 flex h-7 items-center gap-1 rounded-md border bg-popover px-1.5 text-xs text-muted-foreground shadow-sm opacity-0 translate-y-1 transition-all duration-150 hover:bg-accent hover:text-accent-foreground group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Message actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}

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
