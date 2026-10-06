import type { Metadata } from "next";
import Link from "next/link";
import { BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/dal";
import { NOTIFICATION_FILTER_LABELS, NOTIFICATION_FILTERS, parseNotificationFilter } from "@/core/notification-types";
import { plural } from "@/core/text";
import { formatDateTime, formatShortDate, timeAgo } from "@/core/time/format";
import { listNotifications } from "@/server/notifications";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { getWaitingReply, listOtherMessages, listWaitingReplies } from "@/server/services/replies/waiting";
import { inboxCheckFrom, loadInboxCheck } from "@/server/services/sending/inbox-check";
import { myOutageHold } from "@/server/services/sequences/holds";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Pager } from "@/components/activity/pager";
import { defaultReplyScope, notificationsHref, parseReplyScope, type NotificationsQuery } from "@/components/replies/format";
import { InboxCheckCard } from "@/components/replies/inbox-check-card";
import { OnHoldCard } from "@/components/replies/on-hold-card";
import { OtherMessages } from "@/components/replies/other-messages";
import { RepliesSection } from "@/components/replies/replies-section";
import { ReplyCard } from "@/components/replies/reply-card";
import { MarkAllReadButton, NotificationList, type NotificationRow } from "./notification-list";

export const metadata: Metadata = { title: "Notifications" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * The Notifications page (M4-DESIGN §4.3, §5.5, §9.1), top to bottom: the reply a notification pointed at
 * (`?reply=<id>`, pinned and highlighted, whatever page or view it is on), the On hold card when the viewer's
 * follow-ups wait after a long outage, "Replies waiting for an answer" (Everyone's / Yours), "All notifications" with
 * the filter chips, and for the Owner the collapsed "Messages we couldn't link". One column on a phone.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O33, §3.9): "Today's inbox check" goes first (`#inbox-check`, the link of the
 * bell notification and the dashboard item), also when the page would otherwise be empty (so "You're all caught up."
 * isn't shown), and the empty replies list says where replies go. App mode is unchanged.
 */
export default async function NotificationsPage({ searchParams }: PageProps<"/notifications">) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = parseNotificationFilter(first(sp.filter));
  const scopeParam = parseReplyScope(first(sp.scope));
  const scope = scopeParam ?? defaultReplyScope(user.role);
  const pinnedId = positiveInt(first(sp.reply));
  const now = new Date();

  const [data, allTotal, replies, hold, pinned, others, team] = await Promise.all([
    listNotifications(user.id, positiveInt(first(sp.page)) ?? 1, undefined, filter),
    filter === "all" ? Promise.resolve(null) : listNotifications(user.id, 1, 1, "all").then((r) => r.total),
    listWaitingReplies(user, { scope, page: positiveInt(first(sp.rpage)) ?? 1, now }),
    myOutageHold(user.id),
    pinnedId ? getWaitingReply(user, pinnedId, now) : Promise.resolve(null),
    listOtherMessages(user, now),
    loadTeamFrom(),
  ]);
  // Own-mailbox mode: the daily inbox check (the one flag, read through loadTeamFrom).
  const ownMailbox = team.replies === "own-mailbox";
  const inbox = ownMailbox ? await loadInboxCheck(now) : null;
  const inboxFrom = ownMailbox ? inboxCheckFrom(team) : null;

  const anyNotifications = (allTotal ?? data.total) > 0;
  const showHold = hold.held > 0 || hold.firstEmailsWaiting > 0;
  const everythingEmpty = !anyNotifications && replies.everyone === 0 && !showHold && pinnedId === null && inbox === null;
  const query: NotificationsQuery = { filter, page: data.page, scope: scopeParam, rpage: replies.page, reply: pinnedId };
  const rows: NotificationRow[] = data.items.map((n) => ({
    ...n,
    when: formatDateTime(n.createdAt, user.timeZone),
    ago: timeAgo(n.createdAt, now),
  }));

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={
          !anyNotifications
            ? undefined
            : data.unread > 0
              ? `${plural(data.unread, "unread notification", "unread notifications")}.`
              : "Everything is read."
        }
        actions={data.unread > 0 ? <MarkAllReadButton /> : null}
      />
      <div className="grid min-w-0 gap-8 px-4 pb-12 md:px-6">
        {everythingEmpty ? (
          <EmptyState
            icon={<BellOff className="size-6" aria-hidden />}
            title="You're all caught up."
            description="Replies to your campaigns, finished campaigns and anything that needs your attention will show up here."
            actions={
              <Button asChild variant="outline">
                <Link href="/contacts">Go to Contacts</Link>
              </Button>
            }
          />
        ) : (
          <>
            {inbox && inboxFrom ? (
              <InboxCheckCard
                from={inboxFrom}
                checkedToday={inbox.today}
                lastAtIso={inbox.at ? inbox.at.toISOString() : null}
                byName={inbox.byName}
                timeZone={user.timeZone}
                nowIso={now.toISOString()}
                waiting={inbox.waiting}
                more={Math.max(0, inbox.waitingCompanies - inbox.waiting.length)}
              />
            ) : null}

            {pinnedId !== null ? (
              // The reply notification's link ends in #replies: it lands here, on the reply it is about.
              <section id="replies" aria-labelledby="pinned-heading" className="grid scroll-mt-4 gap-2">
                <h2 id="pinned-heading" className="text-base font-semibold">
                  The reply you opened
                </h2>
                {pinned ? (
                  <ReplyCard reply={pinned} showAssignee highlighted />
                ) : (
                  <p role="status" className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                    This reply isn&apos;t on the list any more.
                  </p>
                )}
              </section>
            ) : null}

            {showHold ? (
              <OnHoldCard
                held={hold.held}
                firstEmailsWaiting={hold.firstEmailsWaiting}
                from={hold.from ? formatShortDate(hold.from, user.timeZone, now) : null}
                to={hold.to ? formatShortDate(hold.to, user.timeZone, now) : null}
              />
            ) : null}

            <RepliesSection
              rows={replies.rows}
              total={replies.total}
              mine={replies.mine}
              everyone={replies.everyone}
              page={replies.page}
              pageCount={replies.pageCount}
              scope={scope}
              skipId={pinned ? pinned.id : null}
              anchorId={pinnedId !== null ? null : "replies"}
              hrefFor={(q) => notificationsHref({ ...query, scope: q.scope, rpage: q.rpage }, "replies")}
              ownFrom={inboxFrom}
            />

            <section id="all-notifications" aria-labelledby="all-notifications-heading" className="grid scroll-mt-4 gap-3">
              <h2 id="all-notifications-heading" className="text-base font-semibold">
                All notifications
              </h2>
              <nav aria-label="Show notifications" className="flex flex-wrap gap-1">
                {NOTIFICATION_FILTERS.map((f) => (
                  <Button key={f} asChild size="sm" variant={f === filter ? "secondary" : "ghost"}>
                    <Link
                      href={notificationsHref({ ...query, filter: f, page: 1 }, "all-notifications")}
                      aria-current={f === filter ? "page" : undefined}
                      scroll={false}
                    >
                      {NOTIFICATION_FILTER_LABELS[f]}
                    </Link>
                  </Button>
                ))}
              </nav>
              {data.items.length === 0 ? (
                filter !== "all" ? (
                  <EmptyState
                    title="No notifications match this filter."
                    actions={
                      <Button asChild variant="outline">
                        <Link href={notificationsHref({ ...query, filter: "all", page: 1 }, "all-notifications")}>Show all</Link>
                      </Button>
                    }
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No notifications yet.</p>
                )
              ) : (
                <>
                  <NotificationList items={rows} />
                  <Pager
                    page={data.page}
                    pageCount={data.pageCount}
                    total={data.total}
                    noun={["notification", "notifications"]}
                    hrefFor={(p) => notificationsHref({ ...query, page: p }, "all-notifications")}
                  />
                </>
              )}
            </section>
          </>
        )}

        {user.role === "OWNER" && (!everythingEmpty || others.length > 0) ? <OtherMessages rows={others} /> : null}
      </div>
    </div>
  );
}
