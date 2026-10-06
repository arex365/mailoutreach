import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { WaitingReplyView } from "@/server/services/replies/waiting";
import type { ReplyListScope } from "./format";
import { ReplyCard } from "./reply-card";

/**
 * "Replies waiting for an answer" on the Notifications page (M4-DESIGN §4, §9.1): the heading with the count, the
 * Everyone's / Yours toggle, the help line, the cards (oldest first) and a pager. The app can't see inboxes, so a
 * reply stays here until someone marks it Answered or No answer needed.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O19, §3.9): replies never pass through the app, so an empty list would read as
 * "nobody replied"; with `ownFrom` the empty state says where replies go instead.
 */
export function RepliesSection({
  rows,
  total,
  mine,
  everyone,
  page,
  pageCount,
  scope,
  hrefFor,
  skipId = null,
  anchorId = "replies",
  ownFrom = null,
}: {
  rows: readonly WaitingReplyView[];
  total: number;
  mine: number;
  everyone: number;
  page: number;
  pageCount: number;
  scope: ReplyListScope;
  /** The page link for a view and page of the list. */
  hrefFor: (q: { scope: ReplyListScope; rpage: number }) => string;
  /** A reply already pinned above the section (not shown twice). */
  skipId?: number | null;
  /**
   * The section's anchor (`/notifications#replies`, the bell's link). The page moves it to the pinned reply when there
   * is one, so a reply notification's `?reply=<id>#replies` lands on that reply.
   */
  anchorId?: string | null;
  /** Own-mailbox mode: the own mailbox, named by the empty state (`OWN_MAILBOX_TEXTS.repliesEmpty`); null = app mode. */
  ownFrom?: string | null;
}) {
  const shown = rows.filter((r) => r.id !== skipId);
  const toggle: Array<{ scope: ReplyListScope; label: string }> = [
    { scope: "everyone", label: `Everyone's (${everyone.toLocaleString("en-US")})` },
    { scope: "mine", label: `Yours (${mine.toLocaleString("en-US")})` },
  ];
  return (
    <section id={anchorId ?? undefined} aria-labelledby="replies-heading" className="grid scroll-mt-4 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="replies-heading" className="flex items-center gap-2 text-base font-semibold">
          Replies waiting for an answer
          <Badge variant="secondary" className="tabular">
            {total.toLocaleString("en-US")}
          </Badge>
        </h2>
        <nav aria-label="Whose replies" className="flex flex-wrap gap-1">
          {toggle.map((t) => (
            <Button key={t.scope} asChild size="sm" variant={t.scope === scope ? "secondary" : "ghost"}>
              <Link href={hrefFor({ scope: t.scope, rpage: 1 })} aria-current={t.scope === scope ? "page" : undefined} scroll={false}>
                {t.label}
              </Link>
            </Button>
          ))}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        The app can&apos;t see your inbox. Answer in your own email program, then mark the reply here.
      </p>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {ownFrom
            ? OWN_MAILBOX_TEXTS.repliesEmpty(ownFrom)
            : scope === "everyone"
              ? "Nobody's replies are waiting for an answer."
              : "No replies are waiting for an answer."}
        </p>
      ) : (
        <ul className="grid gap-3">
          {shown.map((r) => (
            <li key={r.id}>
              <ReplyCard reply={r} showAssignee={scope === "everyone"} />
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 ? (
        <nav aria-label="Pages of replies" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular">
            Page {page} of {pageCount} · {total.toLocaleString("en-US")} {total === 1 ? "reply" : "replies"}
          </p>
          <div className="flex gap-2">
            <PageLink href={page > 1 ? hrefFor({ scope, rpage: page - 1 }) : null} rel="prev">
              <ChevronLeft aria-hidden /> Previous
            </PageLink>
            <PageLink href={page < pageCount ? hrefFor({ scope, rpage: page + 1 }) : null} rel="next">
              Next <ChevronRight aria-hidden />
            </PageLink>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function PageLink({ href, rel, children }: { href: string | null; rel: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} rel={rel}>
        {children}
      </Link>
    </Button>
  );
}
