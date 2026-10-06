import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Inbox } from "lucide-react";
import { getUserOrNull, requireUser } from "@/lib/auth/dal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageHeader } from "@/components/page-header";
import { CampaignStatusBadge, ModeBadge } from "@/components/campaigns/badges";
import { CampaignControls } from "@/components/campaigns/campaign-controls";
import { CampaignProgressCard, CampaignResultsGrid, type StepLineView } from "@/components/campaigns/campaign-progress";
import {
  campaignDateParts,
  campaignPageHref,
  campaignsHref,
  delayText,
  outageHoldNotice,
  outboxHref,
  parseRecipientFilter,
  pausedText,
  percentDone,
  possibleReplyNotice,
  progressDoneText,
  recipientEmptyText,
  resultsNote,
  stepProgressText,
  tabForStatus,
  toRecipientRowView,
  waitingText,
  wizardHref,
  WAITING_REPLIES_HREF,
} from "@/components/campaigns/format";
import { LiveRefresh } from "@/components/campaigns/live-refresh";
import { Notice } from "@/components/campaigns/notice";
import { ListPager } from "@/components/campaigns/pager";
import { RecipientPanel } from "@/components/campaigns/recipient-panel";
import { RecipientFilters, RecipientTable } from "@/components/campaigns/recipient-table";
import { UrlSheet } from "@/components/campaigns/url-sheet";
import { TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { pausedWithReason } from "@/core/sending/label";
import { formatDateTime } from "@/core/time/format";
import { plural } from "@/core/text";
import { getCampaignName, getCampaignOverview, listCampaignRecipients } from "@/server/services/campaigns/queries";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { explainCampaignWaiting } from "@/server/services/sending/gates";
import { getPauseState } from "@/server/services/sending/pause";
import { getWorkerStatus } from "@/server/worker-status";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/** The campaign's name in the browser tab (only for someone signed in). */
export async function generateMetadata({ params }: PageProps<"/campaigns/[id]">): Promise<Metadata> {
  const user = await getUserOrNull();
  const { id } = await params;
  const campaignId = positiveInt(id);
  const name = user && campaignId ? await getCampaignName(campaignId) : null;
  return { title: name ?? "Campaign" };
}

/**
 * One campaign (PLAN.md A6 "Campaign page", SPEC §7, M3-DESIGN §5.8, M4-DESIGN §9.3): status, mode,
 * sender and start; Pause / Resume / Cancel; the global pause banner; why its emails are waiting
 * right now (sending hours, today's limit, the pacer, a check with Mailgun, a possible reply…);
 * who is on hold and why (a possible reply someone must check, or the PC being off too long);
 * progress per step (people on hold apart); the counts; and every person with their state,
 * opening in a side panel with their emails and timeline. Drafts continue in the wizard instead.
 * While the campaign runs, the page refreshes itself every 10 seconds.
 *
 * Own-mailbox campaigns (MAIN-DOMAIN-DESIGN §3.7, O19: a test or live campaign whose From is today's own From, with no
 * Reply-To) name no reply address and, while follow-ups are to come, remind that replies land only in the own mailbox,
 * with a link to the inbox check (live follow-ups wait for it each day).
 */
export default async function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const campaignId = positiveInt(id);
  if (!campaignId || String(campaignId) !== id) notFound();
  const sp = await searchParams;

  const overview = await getCampaignOverview(campaignId);
  if (!overview) notFound();
  if (overview.status === "DRAFT") redirect(wizardHref(overview.id, overview.wizardStep));

  const filter = parseRecipientFilter(first(sp.filter));
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const recipientId = positiveInt(first(sp.recipient));
  const now = new Date();
  const [recipients, worker, pause, waiting, team] = await Promise.all([
    listCampaignRecipients(campaignId, { filter, q, page: positiveInt(first(sp.page)) }),
    getWorkerStatus(),
    getPauseState(),
    explainCampaignWaiting(campaignId, now).catch((err: unknown) => {
      console.error("[campaign] couldn't explain the waiting emails", err);
      return null;
    }),
    loadTeamFrom(),
  ]);

  const tz = user.timeZone;
  const query = { filter, q, page: recipients.page };
  const rows = recipients.rows.map((r) => toRecipientRowView(r, { campaignId, campaignStatus: overview.status, query }, tz, now));
  const active = overview.status === "RUNNING" || overview.status === "SCHEDULED";
  const isDryRun = overview.mode === "DRY_RUN" || !overview.mode;

  const enabledSteps = overview.steps.filter((s) => s.enabled);
  const stepLines: StepLineView[] = overview.steps.map((s) => {
    const idx = enabledSteps.findIndex((e) => e.step === s.step);
    const prev = idx > 0 ? enabledSteps[idx - 1]!.step : null;
    return {
      step: s.step,
      title: s.step === 0 ? "First email" : `Follow-up ${s.step}`,
      text: stepProgressText(s, tz, now),
      timing: s.step === 0 ? null : s.enabled ? `Sent ${delayText(s.delayDays, prev, overview.daysAsMinutes)}` : "Switched off",
    };
  });
  const percent = percentDone(overview.progress);
  const doneText = progressDoneText(overview.progress);

  // Shared-From campaigns (SHARED-FROM-DESIGN §3.7) also name where replies go: the sender's own address (Reply-To).
  const repliesTo = overview.replyTo ? `, replies to ${overview.replyTo}` : "";
  const senderText = overview.sender
    ? `Sent by ${overview.sender.name}${overview.fromName && overview.fromAddress ? ` as ${overview.fromName} <${overview.fromAddress}>${repliesTo}` : ""}`
    : "The sender's account was removed";
  const dates = campaignDateParts(overview, tz, now);
  const closeHref = campaignPageHref(campaignId, query);
  const waitingLine =
    waiting && waiting.reason !== "paused"
      ? waitingText(waiting, { timeZone: tz, now, senderName: overview.sender?.name ?? null, ownMailbox: team.replies === "own-mailbox" })
      : null;
  const ended = overview.status === "FINISHED" || overview.status === "CANCELLED";
  // F17: a shared-From campaign with follow-ups still to come reminds that replies written straight to the shared
  // address don't reach the app.
  const followUpsToCome = !ended && overview.recipientCounts.active > 0 && overview.steps.some((s) => s.step > 0 && s.enabled);
  const teamFromReminder =
    overview.replyTo && overview.fromAddress && followUpsToCome ? TEAM_FROM_TEXTS.followUpReminder(overview.fromAddress) : null;
  // MAIN-DOMAIN-DESIGN §3.7, O19: an own-mailbox campaign (today's own From, no Reply-To, test or live) reminds that
  // replies land only in the own mailbox and that live follow-ups wait for the day's inbox check.
  const ownFrom = team.ownFrom;
  const ownMailboxCampaign =
    ownFrom !== null &&
    !overview.replyTo &&
    (overview.mode === "TEST" || overview.mode === "LIVE") &&
    (overview.fromAddress ?? "").trim().toLowerCase() === ownFrom;
  const ownMailboxReminder = ownMailboxCampaign && followUpsToCome ? OWN_MAILBOX_TEXTS.followUpReminder(ownFrom) : null;
  const possibleLine = ended ? null : possibleReplyNotice(overview.holds.possibleReplyCompanies);
  const outageLine = ended
    ? null
    : outageHoldNotice(overview.holds, {
        senderName: overview.sender?.name ?? null,
        // A switched-off sender can't sign in to continue them; only the Owner can.
        senderActive: overview.sender?.active ?? false,
        viewerIsSender: overview.sender?.id === user.id,
        viewerIsOwner: user.role === "OWNER",
        timeZone: tz,
        now,
      });

  return (
    <div>
      <div className="px-4 pt-4 md:px-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={campaignsHref(tabForStatus(overview.status))}>
            <ChevronLeft aria-hidden />
            Campaigns
          </Link>
        </Button>
      </div>
      <PageHeader
        className="pt-2"
        title={overview.name}
        description={
          <span className="grid gap-1.5">
            <span className="flex flex-wrap items-center gap-2">
              <CampaignStatusBadge status={overview.status} />
              <ModeBadge mode={overview.mode} />
              <span className="tabular">{plural(overview.audience, "person", "people")}</span>
            </span>
            <span className="break-words">{senderText}</span>
            {dates.length ? <span>{dates.join(" · ")}</span> : null}
          </span>
        }
        actions={
          <>
            <CampaignControls campaignId={overview.id} name={overview.name} status={overview.status} />
            {isDryRun ? (
              <Button asChild variant="outline">
                <Link href={outboxHref({ campaignId: overview.id })}>
                  <Inbox aria-hidden />
                  Dry-run outbox
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 px-4 pb-12 md:px-6">
        <div className="grid gap-2">
          {pause.paused && overview.status !== "FINISHED" && overview.status !== "CANCELLED" ? (
            <Notice tone="danger">
              <p>
                {pausedWithReason("Sending is paused for everyone", pause.reason)}. {pause.fixText}
                {user.role === "OWNER" ? (
                  <>
                    {" "}
                    <Link href="/settings/sending" className="underline underline-offset-4 hover:no-underline">
                      Open Settings › Sending &amp; Mailgun
                    </Link>
                  </>
                ) : null}
              </p>
            </Notice>
          ) : null}
          {waitingLine && overview.status === "RUNNING" ? (
            <Notice>
              <p>{waitingLine}</p>
            </Notice>
          ) : null}
          {overview.status === "PAUSED" ? (
            <Notice tone="warning">
              <p>{pausedText(overview.pausedAt, overview.pauseReason, tz)}</p>
            </Notice>
          ) : null}
          {overview.status === "SCHEDULED" && overview.startAt ? (
            <Notice>
              <p>Starts {formatDateTime(overview.startAt, tz)}. Nothing is sent before then.</p>
            </Notice>
          ) : null}
          {active && !worker.running ? (
            <Notice tone="danger">
              <p>
                The background sender isn&apos;t running, so nothing is being sent. Double-click start.bat on the office PC, or
                restart the PC if the background services are installed.
              </p>
            </Notice>
          ) : null}
          {isDryRun ? (
            <Notice>
              <p>
                Dry run: nothing leaves this PC. Every email this campaign sends goes to the{" "}
                <Link href={outboxHref({ campaignId: overview.id })} className="underline underline-offset-4 hover:no-underline">
                  dry-run outbox
                </Link>
                , where you can read it.{" "}
                {overview.countsAsReal
                  ? "This is the practice copy, so here it counts as real contact: statuses, “Last emailed” and the 30-day rule change as if it were live."
                  : "It doesn't change company statuses or “Last emailed”, and doesn't count for the 30-day rule."}
                {overview.ignoreWindow
                  ? " It ignores sending hours, so its emails go out straight away."
                  : " It waits for each recipient's sending hours and takes turns with real emails, as a live campaign would."}
              </p>
            </Notice>
          ) : null}
          {outageLine ? (
            <Notice tone="warning">
              <p>{outageLine}</p>
            </Notice>
          ) : null}
          {possibleLine ? (
            <Notice>
              <p>
                {possibleLine}{" "}
                <Link href={WAITING_REPLIES_HREF} className="underline underline-offset-4 hover:no-underline">
                  Open Replies waiting for an answer
                </Link>
              </p>
            </Notice>
          ) : null}
        </div>

        {teamFromReminder ? (
          <div className="grid gap-2">
            <CampaignProgressCard percent={percent} doneText={doneText} steps={stepLines} />
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{teamFromReminder}</p>
          </div>
        ) : ownMailboxReminder ? (
          <div className="grid gap-2">
            <CampaignProgressCard percent={percent} doneText={doneText} steps={stepLines} />
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {ownMailboxReminder}{" "}
              <Link href="/notifications#inbox-check" className="underline underline-offset-4 hover:no-underline">
                {OWN_MAILBOX_TEXTS.openInboxCheck}
              </Link>
            </p>
          </div>
        ) : (
          <CampaignProgressCard percent={percent} doneText={doneText} steps={stepLines} />
        )}
        <CampaignResultsGrid results={overview.results} note={resultsNote(overview.mode)} />

        <section aria-labelledby="campaign-people" className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="campaign-people" className="text-base font-semibold">
              People
            </h2>
            {active ? <span className="text-xs text-muted-foreground">Updates every 10 seconds</span> : null}
          </div>
          <RecipientFilters campaignId={campaignId} active={filter} counts={overview.recipientCounts} q={q} />
          {rows.length === 0 ? (
            <EmptyState
              title={recipientEmptyText(filter, q)}
              actions={
                filter !== "all" || q ? (
                  <Button asChild variant="outline">
                    <Link href={campaignPageHref(campaignId)} scroll={false}>
                      Show everyone
                    </Link>
                  </Button>
                ) : (
                  <Button asChild variant="outline">
                    <Link href="/campaigns">Back to Campaigns</Link>
                  </Button>
                )
              }
            />
          ) : (
            <RecipientTable rows={rows} selectedId={recipientId} />
          )}
          <ListPager
            page={recipients.page}
            pageCount={recipients.pageCount}
            total={recipients.total}
            noun={["person", "people"]}
            hrefFor={(p) => campaignPageHref(campaignId, { filter, q, page: p })}
          />
        </section>
      </div>

      <UrlSheet
        openKey={recipientId ? String(recipientId) : null}
        closeHref={closeHref}
        title="Person in this campaign"
        description="Their emails in this campaign, what's still to come, and their timeline."
      >
        {recipientId ? (
          <Suspense key={recipientId} fallback={<PanelSkeleton />}>
            <RecipientPanel
              campaign={{
                id: overview.id,
                name: overview.name,
                status: overview.status,
                mode: overview.mode,
                daysAsMinutes: overview.daysAsMinutes,
              }}
              recipientId={recipientId}
              timeZone={tz}
            />
          </Suspense>
        ) : null}
      </UrlSheet>
      <LiveRefresh active={active} />
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="grid gap-5 p-5" aria-busy="true" aria-label="Loading">
      <div className="grid gap-2 pr-10">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
