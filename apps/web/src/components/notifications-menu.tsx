"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Notification } from "@zano/shared";

interface NotificationsMenuProps {
  userId: string;
}

export function NotificationsMenu({ userId }: NotificationsMenuProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/notifications?recipientId=${userId}&recipientType=human&unreadOnly=true`);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications ?? []);
      }
    }
    load();
  }, [userId]);

  return (
    <Popover>
      <PopoverTrigger
        className="relative inline-flex items-center justify-center rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground h-9 w-9"
      >
        <Bell className="h-4 w-4" />
        {notifications.length > 0 ? <Badge className="absolute -right-1 -top-1 h-5 min-w-5 px-1 text-[10px]">{notifications.length}</Badge> : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="mb-2 font-medium">Notifications</div>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unread notifications</p>
        ) : (
          <div className="space-y-2">
            {notifications.map((notification) => (
              <div key={notification.id} className="rounded-md border p-2 text-sm">
                <div className="font-medium">{notification.type}</div>
                <div className="text-xs text-muted-foreground">{new Date(notification.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
