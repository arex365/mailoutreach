import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Inbox } from "lucide-react";
import { requireUser } from "@/lib/auth/dal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Pager } from "@/components/activity/pager";
import { outboxHref } from "@/components/campaigns/format";
import { OutboxEmailView } from "@/components/campaigns/outbox-email";
import { OutboxFilter } from "@/components/campaigns/outbox-filter";
import { OutboxList, type OutboxRowView } from "@/components/campaigns/outbox-list";
import { SimulateButtons } from "@/components/campaigns/simulate-buttons";
import { UrlSheet } from "@/components/campaigns/url-sheet";
import { stepTitle } from "@/core/rules/wording";
import { formatDateTime, timeAgo } from "@/core/time/format";
import { getOutboxEmail, listOutbox, listOutboxCampaigns } from "@/server/services/campaigns/queries";
import { loadSimulation } from "@/server/services/mail-events/simulate";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";

export const metadata: Metadata = { title: "Dry-run outbox" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * The dry-run outbox (PLAN.md A6, M2): every email a dry-run campaign "sent", newest first, for
 * everyone to read. Nothing here left this PC. Filter by campaign; open one to read From, To,
 * Subject, the plain text and the HTML version, and simulate Mailgun's reports (Milestone 3) or the
 * person's answer: a reply, an out-of-office or an unclear reply (Milestone 4). In own-mailbox mode replies never pass
 * through the app, so the answer buttons are hidden (MAIN-DOMAIN-DESIGN O19, §3.7).
 */
export default async function OutboxPage({ searchParams }: PageProps<"/campaigns/outbox">) {
  const user = await requireUser();
  const sp = await searchParams;
  const campaignId = positiveInt(first(sp.campaign));
  const openId = positiveInt(first(sp.open));
  const [page, campaigns] = await Promise.all([
    listOutbox({ campaignId, page: positiveInt(first(sp.page)) }),
    listOutboxCampaigns(),
  ]);
  const now = new Date();
  const rows: OutboxRowView[] = page.rows.map((r) => ({
    id: r.id,
    href: outboxHref({ campaignId, page: page.page, open: r.id }),
    subject: r.subject,
    to: r.toEmail,
    companyName: r.companyName,
    campaignName: r.campaignName,
    stepTitle: stepTitle(r.step),
    sentAt: formatDateTime(r.sentAt, user.timeZone),
    sentAtIso: r.sentAt.toISOString(),
    sentAgo: timeAgo(r.sentAt, now),
  }));
  const anyEmails = campaigns.length > 0;

  return (
    <div>
      <div className="px-4 pt-4 md:px-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/campaigns">
            <ChevronLeft aria-hidden />
            Campaigns
          </Link>
        </Button>
      </div>
      <PageHeader
        className="pt-2"
        title="Dry-run outbox"
        description="Every email a dry-run campaign would have sent, newest first. Nothing here left this PC."
      />
      <div className="grid gap-4 px-4 pb-12 md:px-6">
        {anyEmails ? <OutboxFilter campaigns={campaigns} campaignId={campaignId} /> : null}
        {rows.length === 0 ? (
          anyEmails && campaignId ? (
            <EmptyState
              title="No dry-run emails from this campaign yet."
              description="They show here as soon as the background sender works through them."
              actions={
                <Button asChild variant="outline">
                  <Link href={outboxHref()}>Show every campaign</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Inbox className="size-6" aria-hidden />}
              title="Nothing here yet. Launch a campaign in dry run to see the emails it would send."
              actions={
                <Button asChild variant="outline">
                  <Link href="/campaigns">Go to Campaigns</Link>
                </Button>
              }
            />
          )
        ) : (
          <>
            <OutboxList rows={rows} openId={openId} />
            <Pager
              page={page.page}
              pageCount={page.pageCount}
              total={page.total}
              noun={["email", "emails"]}
              hrefFor={(p) => outboxHref({ campaignId, page: p })}
            />
          </>
        )}
      </div>

      <UrlSheet
        openKey={openId ? String(openId) : null}
        closeHref={outboxHref({ campaignId, page: page.page })}
        title="Dry-run email"
        description="From, To, Subject, the plain text and the HTML version of this email."
      >
        {openId ? (
          <Suspense key={openId} fallback={<EmailSkeleton />}>
            <OpenEmail emailId={openId} timeZone={user.timeZone} />
          </Suspense>
        ) : null}
      </UrlSheet>
    </div>
  );
}

async function OpenEmail({ emailId, timeZone }: { emailId: number; timeZone: string }) {
  const [email, simulation, team] = await Promise.all([getOutboxEmail(emailId), loadSimulation(emailId), loadTeamFrom()]);
  if (!email) {
    return (
      <div className="grid gap-2 p-4 pr-12 md:p-6">
        <h2 className="text-lg font-semibold">This email isn&apos;t in the outbox.</h2>
        <p className="text-sm text-muted-foreground">The link may be old, or the email hasn&apos;t gone out yet. Close this panel and pick one from the list.</p>
      </div>
    );
  }
  return (
    <OutboxEmailView
      email={email}
      timeZone={timeZone}
      simulate={
        simulation ? (
          <SimulateButtons
            emailId={simulation.emailId}
            done={simulation.done}
            repliesDone={simulation.repliesDone}
            resultLine={simulation.resultLine}
            practiceCopy={simulation.practiceCopy}
            replies={team.replies !== "own-mailbox"}
          />
        ) : null
      }
    />
  );
}

function EmailSkeleton() {
  return (
    <div className="grid gap-4 p-5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
