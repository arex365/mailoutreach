"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NotificationItem } from "@/server/notifications";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/shell/notification-bell";
import { useGuardedNavigate } from "@/components/navigation/nav-guard";
import { markAllNotificationsReadAction, markNotificationsReadAction } from "./actions";

/** Tells the bell in the top bar to refresh its count now instead of at the next 20-second check. */
function tellBell() {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

export type NotificationRow = NotificationItem & {
  /** Formatted on the server in the viewer's time zone. */
  when: string;
  ago: string;
};

/** The full notification list: unread ones are highlighted; clicking marks read and opens the link. */
export function NotificationList({ items }: { items: NotificationRow[] }) {
  const router = useRouter();
  // Like every in-app move: a page with unsaved changes is asked first.
  const navigate = useGuardedNavigate();
  const [readHere, setReadHere] = useState<ReadonlySet<number>>(new Set());
  const [openingId, setOpeningId] = useState<number | null>(null);

  async function open(n: NotificationRow) {
    const unread = !n.readAt && !readHere.has(n.id);
    if (unread) {
      setOpeningId(n.id);
      const res = await markNotificationsReadAction({ ids: [n.id] });
      setOpeningId(null);
      if (res.ok) {
        setReadHere((prev) => new Set(prev).add(n.id));
        tellBell();
      } else {
        toast.error(res.error);
      }
    }
    if (n.link) navigate(n.link);
    else router.refresh();
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      {items.map((n) => {
        const unread = !n.readAt && !readHere.has(n.id);
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => void open(n)}
              disabled={openingId === n.id}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60 disabled:opacity-70",
                unread && "bg-accent/40",
              )}
            >
              <span
                aria-hidden
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", unread ? "bg-foreground" : "bg-transparent")}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", unread ? "font-semibold text-foreground" : "text-foreground/90")}>
                  {unread ? <span className="sr-only">Unread: </span> : null}
                  {n.title}
                </span>
                {n.body ? <span className="mt-0.5 block text-sm text-muted-foreground">{n.body}</span> : null}
                <span className="mt-1 block text-xs text-muted-foreground" title={n.when}>
                  {n.ago} · {n.when}
                </span>
              </span>
              {n.link ? <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await markAllNotificationsReadAction();
          if (res.ok) {
            toast.success(res.message ?? "All notifications marked as read.");
            tellBell();
            router.refresh();
          } else {
            toast.error(res.error);
          }
        })
      }
    >
      <CheckCheck aria-hidden /> {pending ? "Marking…" : "Mark all read"}
    </Button>
  );
}
