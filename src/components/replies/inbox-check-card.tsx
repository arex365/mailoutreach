"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { INBOX_CHECK_TEXTS } from "@/core/sending/own-mailbox";
import { plural } from "@/core/text";
import { formatDate, formatShortDate, formatTime } from "@/core/time/format";
import { markInboxCheckedAction } from "./inbox-check-actions";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

/**
 * The last-check line (§3.9): "Last read today at 09:12 by Arslan." when today's check is done; otherwise "Nobody has
 * read it today.", followed by the last check when there was one ("Last read on 26 Sept at 16:40 by Arslan."). Times in
 * the viewer's own zone; "today" only for a check of today's cap day that is also today on the viewer's clock.
 */
export function inboxCheckLastLine(
  i: { checkedToday: boolean; lastAt: Date | null; byName: string | null },
  timeZone: string,
  now: Date,
): string {
  if (!i.lastAt) return INBOX_CHECK_TEXTS.notToday;
  const time = formatTime(i.lastAt, timeZone);
  const sameDay = formatDate(i.lastAt, timeZone) === formatDate(now, timeZone);
  const when = i.checkedToday && sameDay ? `today at ${time}` : `on ${formatShortDate(i.lastAt, timeZone, now)} at ${time}`;
  const line = INBOX_CHECK_TEXTS.last(when, i.byName ?? "a teammate");
  return i.checkedToday ? line : `${INBOX_CHECK_TEXTS.notToday} ${line}`;
}

export type InboxCheckCardProps = {
  /** The own mailbox (contact@polygonparadise.com). */
  from: string;
  /** Someone has done today's check (the cap day's): the button turns outline. */
  checkedToday: boolean;
  /** The last check (ISO), or null when nobody has checked yet. */
  lastAtIso: string | null;
  byName: string | null;
  /** The viewer's zone and the page's "now" (ISO), so the server and the browser write the same line. */
  timeZone: string;
  nowIso: string;
  /** Companies with live follow-ups due within 24 hours (at most 20). */
  waiting: ReadonlyArray<{ companyId: number; companyName: string; count: number }>;
  /** Companies with such follow-ups that aren't listed. */
  more: number;
};

/**
 * "Today's inbox check" (MAIN-DOMAIN-DESIGN O33, §3.9), own-mailbox mode only, first on the Notifications page (the bell
 * notification and the dashboard item link to `#inbox-check`): what to read, the companies whose live follow-ups are due
 * within 24 hours, the last check and "I've read contact@…" (primary until today's check is done, then outline). Anyone
 * signed in may click it; live follow-ups wait for it each day.
 */
export function InboxCheckCard({ from, checkedToday, lastAtIso, byName, timeZone, nowIso, waiting, more }: InboxCheckCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const lastLine = inboxCheckLastLine(
    { checkedToday, lastAt: lastAtIso ? new Date(lastAtIso) : null, byName },
    timeZone,
    new Date(nowIso),
  );

  function check() {
    startTransition(async () => {
      try {
        const res = await markInboxCheckedAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? INBOX_CHECK_TEXTS.done);
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <section
      id="inbox-check"
      aria-labelledby="inbox-check-title"
      className="grid scroll-mt-4 grid-cols-1 gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
    >
      <div className="flex items-start gap-3">
        <Inbox className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="grid min-w-0 gap-1">
          <h2 id="inbox-check-title" className="text-base font-semibold">
            {INBOX_CHECK_TEXTS.title}
          </h2>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{INBOX_CHECK_TEXTS.intro(from)}</p>
        </div>
      </div>
      {waiting.length > 0 ? (
        <div className="grid min-w-0 grid-cols-1 gap-1.5">
          <p className="text-sm font-medium">{INBOX_CHECK_TEXTS.waitingHeading}</p>
          <ul className="grid grid-cols-1 gap-1 text-sm">
            {waiting.map((w) => (
              <li key={w.companyId} className="flex min-w-0 items-baseline justify-between gap-3">
                <Link
                  href={`/contacts?company=${w.companyId}`}
                  className="min-w-0 underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                >
                  {w.companyName}
                </Link>
                <span className="shrink-0 text-muted-foreground tabular-nums">{plural(w.count, "follow-up", "follow-ups")}</span>
              </li>
            ))}
            {more > 0 ? <li className="text-muted-foreground">{INBOX_CHECK_TEXTS.more(more)}</li> : null}
          </ul>
        </div>
      ) : null}
      <p className="text-sm [overflow-wrap:anywhere]">{lastLine}</p>
      <div className="min-w-0">
        <Button
          variant={checkedToday ? "outline" : "default"}
          disabled={pending}
          onClick={check}
          className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]"
        >
          {INBOX_CHECK_TEXTS.button(from)}
        </Button>
      </div>
    </section>
  );
}
