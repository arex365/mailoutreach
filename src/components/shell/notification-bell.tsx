"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, MessageSquareReply } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pollDelayMs, shouldPopUp } from "@/core/notifications/popups";
import { timeAgo } from "@/core/time/format";
import { cn } from "@/lib/utils";
import type { NotificationItem } from "@/server/notifications";
import { markAllNotificationsReadAction, markNotificationsReadAction } from "@/app/(app)/notifications/actions";
import {
  currentPopupState,
  planPopups,
  popupOpener,
  POPUPS_CHANGED_EVENT,
  raisePopupMark,
  readPopupMark,
  resetPopupMark,
  showDesktopPopup,
  waitingRepliesText,
  type SummaryResponse,
} from "@/app/(app)/settings/notifications/desktop-popups";
import { useGuardedNavigate } from "@/components/navigation/nav-guard";
import { publishAiWaiting } from "./nav-items";

/**
 * The bell in the top bar (PLAN.md B6.14, M4-DESIGN §5.2–§5.3, §9.2). It polls GET /api/notifications/summary with a
 * `setTimeout` chain: every 20 s ± 2 s while the tab is visible, every 60 s while it is hidden with desktop pop-ups on
 * in this browser, and not at all while it is hidden with pop-ups off. It polls at once when the tab becomes visible,
 * the window gets focus, or another screen fires NOTIFICATIONS_CHANGED_EVENT, and stops for good on a 401 (signed out).
 * No SSE (Cloudflare buffers it). The count badge is neutral: orange only means "primary" or "selected".
 *
 * Desktop pop-ups: the first poll after a page load only records the latest id (nothing old ever pops up); later polls
 * pass that high-water mark as `after`, and the pure decisions (`planPopups`, `pickPopups`) choose each new pop-up or
 * one batch pop-up. They show only while permission is granted, pop-ups are on in this browser, and the person isn't
 * looking at the app (tab hidden or window without focus). The mark is shared with other tabs through `localStorage`
 * and each pop-up has the tag "pp-n-<id>", so none shows twice. Clicking a pop-up marks its notification read (not the
 * batch pop-up, which stands for many) and opens its link, like choosing it in the menu.
 *
 * Every good poll also hands the summary's `aiWaiting` (AI lines waiting for review) to the sidebar's badge through
 * AI_WAITING_EVENT (M5-DESIGN §6.7).
 */

/** Other screens (e.g. the Notifications page) fire this after marking notifications read. */
export const NOTIFICATIONS_CHANGED_EVENT = "pp:notifications-changed";

const SUMMARY_URL = "/api/notifications/summary";

/** What the last good poll told us: whose notifications, their M1–M3 switch and the pop-up high-water mark. */
type Baseline = { userId: number; legacy: boolean; mark: number };

export function NotificationBell() {
  const router = useRouter();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [now, setNow] = useState(0);
  // Polls once more and restarts the timer chain (the menu opening, "Mark all read").
  const pollNow = useRef<() => void>(() => undefined);

  // Asks the open page first when it has unsaved changes (template editor, campaign wizard…).
  const navigate = useGuardedNavigate();
  const openLink = useCallback((link: string | null) => navigate(link ?? "/notifications"), [navigate]);
  const openLinkRef = useRef(openLink);
  useEffect(() => {
    openLinkRef.current = openLink;
  }, [openLink]);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let stopped = false;
    let timer: number | null = null;
    let baseline: Baseline | null = null;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const popupsOn = () => (baseline ? currentPopupState(baseline.userId, baseline.legacy) === "on" : false);
    // A click on a pop-up marks that notification read (as opening it from the menu does), refreshes the count, then
    // opens its link.
    const openFromPopup = popupOpener({
      markRead: (ids) => markNotificationsReadAction({ ids }),
      onMarked: () => pollNow.current(),
      onError: (message) => toast.error(message),
      open: (link) => openLinkRef.current(link),
    });

    async function poll(): Promise<void> {
      if (loading || stopped || cancelled) return;
      loading = true;
      try {
        const base = baseline;
        const after = base ? Math.max(base.mark, readPopupMark(base.userId)) : null;
        const res = await fetch(after === null ? SUMMARY_URL : `${SUMMARY_URL}?after=${after}`, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (res.status === 401) {
          stopped = true; // signed out: the next page load goes to the sign-in page
          clearTimer();
          return;
        }
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as SummaryResponse;
        if (cancelled) return;
        // The first poll after a page load, or someone else signed in (another tab) since: start from their latest id.
        const first = base === null || base.userId !== data.userId;
        const canShow =
          !first &&
          currentPopupState(data.userId, data.legacyDesktopReplies) === "on" &&
          shouldPopUp({ hidden: document.hidden, focused: document.hasFocus() });
        const plan = planPopups(data, { first, mark: after ?? 0, canShow });
        for (const p of plan.show) showDesktopPopup(p, data.userId, (link, id) => void openFromPopup(link, id));
        if (first) resetPopupMark(data.userId, plan.mark);
        else raisePopupMark(data.userId, plan.mark);
        baseline = { userId: data.userId, legacy: data.legacyDesktopReplies, mark: plan.mark };
        setSummary(data);
        setNow(Date.now());
        // The sidebar's "AI lines" badge follows the Waiting count of every poll (M5-DESIGN §6.7).
        if (typeof data.aiWaiting === "number") publishAiWaiting(data.aiWaiting);
      } catch {
        // Offline or the app is restarting: try again at the next tick.
      } finally {
        loading = false;
      }
    }

    function schedule() {
      clearTimer();
      if (stopped || cancelled) return;
      const delay = pollDelayMs({ hidden: document.hidden, popupsOn: popupsOn(), random: Math.random });
      if (delay === null) return; // hidden with pop-ups off: wait until the tab is visible again
      timer = window.setTimeout(() => {
        timer = null;
        if (document.hidden && !popupsOn()) return;
        void poll().then(schedule);
      }, delay);
    }

    const pollAndSchedule = () => void poll().then(schedule);
    pollNow.current = pollAndSchedule;

    const firstPoll = window.setTimeout(pollAndSchedule, 0);
    const onVisibility = () => (document.hidden ? schedule() : pollAndSchedule());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", pollAndSchedule);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, pollAndSchedule);
    window.addEventListener(POPUPS_CHANGED_EVENT, schedule);
    return () => {
      cancelled = true;
      window.clearTimeout(firstPoll);
      clearTimer();
      pollNow.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", pollAndSchedule);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, pollAndSchedule);
      window.removeEventListener(POPUPS_CHANGED_EVENT, schedule);
    };
  }, []);

  async function openItem(n: NotificationItem) {
    if (!n.readAt) {
      setSummary((s) =>
        s
          ? {
              ...s,
              unread: Math.max(0, s.unread - 1),
              latest: s.latest.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)),
            }
          : s,
      );
      const res = await markNotificationsReadAction({ ids: [n.id] });
      if (!res.ok) toast.error(res.error);
    }
    openLink(n.link);
  }

  async function markAll() {
    const res = await markAllNotificationsReadAction();
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    pollNow.current();
    router.refresh();
  }

  const unread = summary?.unread ?? 0;
  const latest = summary?.latest ?? [];
  const waiting = summary ? waitingRepliesText(summary.waitingReplies) : null;
  const nowDate = new Date(now);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) pollNow.current();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications: ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] leading-none font-semibold text-background tabular"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel className="flex items-center justify-between text-sm text-foreground">
          <span>Notifications</span>
          {unread > 0 ? <span className="text-xs font-normal text-muted-foreground">{unread} unread</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {waiting ? (
          <>
            <DropdownMenuItem onSelect={() => openLink("/notifications#replies")} className="gap-2.5 py-2 font-medium">
              <MessageSquareReply aria-hidden />
              {waiting}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {summary === null ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : latest.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : (
          latest.map((n) => (
            <DropdownMenuItem key={n.id} onSelect={() => void openItem(n)} className="items-start gap-2.5 py-2">
              <span
                aria-hidden
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-foreground")}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate", n.readAt ? "text-muted-foreground" : "font-medium text-foreground")}>
                  {n.readAt ? null : <span className="sr-only">Unread: </span>}
                  {n.title}
                </span>
                <span className="block text-xs text-muted-foreground">{now ? timeAgo(n.createdAt, nowDate) : ""}</span>
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        {unread > 0 ? (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault(); // keep the menu open to show the result
              void markAll();
            }}
          >
            <CheckCheck aria-hidden /> Mark all read
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/notifications">See all</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
