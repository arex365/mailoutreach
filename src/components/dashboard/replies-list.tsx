import Link from "next/link";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { Button } from "@/components/ui/button";
import { notificationsHref } from "@/components/replies/format";
import { ReplyCard } from "@/components/replies/reply-card";
import type { WaitingReplyView } from "@/server/services/replies/waiting";
import { repliesFooterLabel } from "./format";
import { DASHBOARD_TEXTS } from "./texts";

/** "/notifications?scope=mine#replies": the viewer's own waiting replies, as this list counts them. */
const REPLIES_HREF = notificationsHref({ scope: "mine" }, "replies");

/**
 * "Replies waiting for an answer" on the dashboard (M6-DESIGN §4.2a, PLAN Q7): the viewer's own waiting replies,
 * oldest first, at most 5, as the Notifications page's cards with their actions (Answered, No answer needed, …; the
 * card refreshes the page after one). The footer leads to the same list on the Notifications page, the viewer's own
 * (`?scope=mine`), so "(3 more)" are the ones it shows (review DASHBOARD-5: the Owner's default there is everyone's).
 * `null` data: it couldn't be loaded. Server component. `ownFrom` (own-mailbox mode, MAIN-DOMAIN-DESIGN §3.9): the
 * empty state says replies go straight to that mailbox (`OWN_MAILBOX_TEXTS.repliesEmpty`); absent or null = today's.
 */
export function RepliesList({
  replies,
  ownFrom = null,
}: {
  replies: { rows: readonly WaitingReplyView[]; total: number } | null;
  ownFrom?: string | null;
}) {
  const t = DASHBOARD_TEXTS.replies;
  return (
    <section aria-labelledby="dashboard-replies-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="dashboard-replies-heading" className="text-base font-semibold">
          {t.heading}
        </h2>
        <p className="text-sm text-muted-foreground">{t.description}</p>
      </div>
      {replies === null ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">{DASHBOARD_TEXTS.unavailable}</p>
      ) : replies.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
          {ownFrom ? OWN_MAILBOX_TEXTS.repliesEmpty(ownFrom) : t.empty}
        </p>
      ) : (
        <ul className="grid gap-3">
          {replies.rows.map((r) => (
            <li key={r.id}>
              <ReplyCard reply={r} showAssignee={false} />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button asChild variant="ghost" size="sm" className="h-11 w-full justify-start sm:h-7 sm:w-auto">
          <Link href={REPLIES_HREF}>{repliesFooterLabel(replies?.total ?? 0, replies?.rows.length ?? 0)}</Link>
        </Button>
      </div>
    </section>
  );
}
