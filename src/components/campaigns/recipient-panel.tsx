import Link from "next/link";
import { ExternalLink, MessageSquareReply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmailPreview } from "@/components/templates/email-preview";
import type { RenderedEmail } from "@/core/templates/types";
import { cn } from "@/lib/utils";
import { RenderError, renderCampaignEmails } from "@/server/services/render";
import { getRecipientDetail, type RecipientDetail } from "@/server/services/campaigns/queries";
import { loadMarkRepliedFacts } from "@/server/services/companies/replied-by-hand";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { templateVariables } from "@/server/services/templates";
import { markRepliedAction } from "@/components/company-panel/actions";
import { EmailStatusBadge } from "./badges";
import {
  OPEN_RECIPIENT_STATES,
  buildRecipientTimeline,
  outboxHref,
  recipientStateText,
  recipientStepViews,
  type CampaignStatusValue,
  type SendModeValue,
  type StepView,
} from "./format";
import { EditEmailButton, MarkRepliedButton, RetryEmailButton, RetryOrSkipButton, SkipRecipientButton } from "./recipient-actions";
import { SentEmail } from "./sent-email";

/**
 * The side panel for one person in a campaign (PLAN.md A6 "Campaign page", M3-DESIGN §5.8, M4-DESIGN
 * §9.3): where they are (with why they're on hold, or why they stopped: "Stopped: they replied"),
 * each email of their sequence (what was sent, and what's to come rendered exactly as it will go,
 * with "Edit this email"), Skip, Try again, "Retry or Skip?" for an email we couldn't confirm with
 * Mailgun, Mailgun's own words behind "Details" for a refused one, for dry runs a link to simulate a
 * reply to their latest email in the dry-run outbox, and their timeline (replies included).
 * Rendered on the server inside UrlSheet.
 *
 * Replies by hand (MAIN-DOMAIN-DESIGN O17, §3.7, §3.8): "They replied" for this person, shown under the company panel's
 * rule (own-mailbox mode, shared-From mode or the practice copy; the company not deleted or Do not contact) for test and
 * live campaigns, and for dry runs in the practice copy. In own-mailbox mode replies never pass through the app, so the
 * simulate link is hidden there.
 */

export type PanelCampaign = {
  id: number;
  name: string;
  status: CampaignStatusValue;
  mode: SendModeValue | null;
  daysAsMinutes: boolean;
};

const PREVIEW_PROBLEM = "Couldn't show this email right now. Refresh the page to try again.";

export async function RecipientPanel({
  campaign,
  recipientId,
  timeZone,
}: {
  campaign: PanelCampaign;
  recipientId: number;
  timeZone: string;
}) {
  const [detail, team] = await Promise.all([getRecipientDetail(campaign.id, recipientId), loadTeamFrom()]);
  if (!detail) {
    return (
      <div className="grid gap-2 p-4 pr-12 md:p-6">
        <h2 className="text-lg font-semibold">This person isn&apos;t in the campaign any more.</h2>
        <p className="text-sm text-muted-foreground">The link may be old. Close this panel and pick someone from the list.</p>
      </div>
    );
  }
  const now = new Date();
  const views = recipientStepViews(
    {
      campaignStatus: campaign.status,
      daysAsMinutes: campaign.daysAsMinutes,
      recipient: {
        state: detail.state,
        included: detail.included,
        stopReason: detail.stopReason,
        holdReason: detail.holdReason,
        // RECHECK: the waiting first email says when the second address check is due (M5-DESIGN §2.7).
        recheckAt: detail.recheckAt,
      },
      steps: detail.steps,
      emails: detail.emails,
    },
    timeZone,
    now,
  );

  const previewSteps = views.filter((v) => v.kind === "waiting" || v.kind === "planned").map((v) => v.step);
  const previews = new Map<number, RenderedEmail>();
  let previewError: string | null = null;
  if (previewSteps.length > 0) {
    try {
      const rendered = await renderCampaignEmails({
        campaignId: campaign.id,
        recipientIds: [detail.id],
        steps: previewSteps,
        purpose: "preview",
      });
      for (const r of rendered) previews.set(r.step, r.email);
    } catch (err) {
      previewError = err instanceof RenderError ? err.message : PREVIEW_PROBLEM;
      if (!(err instanceof RenderError)) console.error("[campaign] preview failed", err);
    }
  }
  const variables = views.some((v) => v.canEdit) ? await templateVariables() : [];

  const current = detail.emails.find((e) => e.step === detail.currentStep) ?? null;
  const stateText = recipientStateText(
    {
      state: detail.state,
      included: detail.included,
      currentStep: detail.currentStep,
      nextDueAt: detail.nextDueAt,
      stopReason: detail.stopReason,
      holdReason: detail.holdReason,
      recheckAt: detail.recheckAt,
      exclusionReason: detail.exclusionReason,
      campaignStatus: campaign.status,
      email: current,
    },
    timeZone,
    now,
  );
  // Dry runs: replies can be tried out on the latest email this person "got" (§7.1). Not in own-mailbox mode, where a
  // reply never reaches the app (MAIN-DOMAIN-DESIGN O19): They replied is the way there.
  const latestSent =
    team.replies === "own-mailbox"
      ? null
      : ([...detail.emails].filter((e) => e.status === "SENT" && e.mode === "DRY_RUN").sort((a, b) => b.step - a.step)[0] ?? null);
  const replied = detail.company.deleted ? null : await loadMarkRepliedFacts(detail.company.id);
  const showReplied =
    replied !== null && (campaign.mode === "TEST" || campaign.mode === "LIVE" || (campaign.mode === "DRY_RUN" && replied.practiceCopy));
  const canSkip =
    detail.included &&
    (OPEN_RECIPIENT_STATES as readonly string[]).includes(detail.state) &&
    (campaign.status === "RUNNING" || campaign.status === "SCHEDULED" || campaign.status === "PAUSED");
  // A held person's waiting email reads "on hold", not "waiting to send" (review NOTIFY-04).
  const timeline = buildRecipientTimeline(
    { emails: detail.emails, activity: detail.activity, recipient: { state: detail.state, recheckAt: detail.recheckAt } },
    timeZone,
    now,
  );
  const who = detail.person.displayName;

  return (
    <div className="grid min-w-0 gap-6 p-4 md:p-6" data-recipient-id={detail.id}>
      <header className="grid gap-2 pr-10">
        <div className="grid gap-0.5">
          <h2 className="text-lg font-semibold break-words">{who}</h2>
          <p className="text-sm break-words text-muted-foreground">
            {detail.person.email}
            {" · "}
            {detail.company.deleted ? (
              <span>{detail.company.name} (deleted)</span>
            ) : (
              <Link href={`/contacts?company=${detail.company.id}`} className="underline-offset-4 hover:text-foreground hover:underline">
                {detail.company.name}
              </Link>
            )}
            {detail.person.deleted ? " · removed from the company" : ""}
          </p>
        </div>
        <p className="text-sm font-medium">{stateText}</p>
        {canSkip || latestSent || showReplied ? (
          <div className="flex flex-wrap gap-2">
            {canSkip ? <SkipRecipientButton campaignId={campaign.id} recipientId={detail.id} who={who} /> : null}
            {showReplied && replied ? (
              <MarkRepliedButton
                companyId={detail.company.id}
                companyName={detail.company.name}
                personId={detail.person.deleted ? null : detail.person.id}
                personName={who}
                status={replied.status}
                countsAsReply={replied.countsAsReply}
                markReplied={markRepliedAction}
              />
            ) : null}
            {latestSent ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={outboxHref({ campaignId: campaign.id, open: latestSent.id })}>
                  <MessageSquareReply aria-hidden />
                  Simulate a reply in the dry-run outbox
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <section aria-labelledby="recipient-emails" className="grid gap-3">
        <h3 id="recipient-emails" className="text-sm font-semibold">
          Emails
        </h3>
        {views.length === 0 ? <p className="text-sm text-muted-foreground">This campaign has no emails for this person.</p> : null}
        {views.map((v) => (
          <StepCard
            key={v.step}
            view={v}
            detail={detail}
            campaign={campaign}
            preview={previews.get(v.step) ?? null}
            previewError={previewSteps.includes(v.step) ? previewError : null}
            variables={variables}
            who={who}
          />
        ))}
      </section>

      <section aria-labelledby="recipient-timeline" className="grid gap-3">
        <h3 id="recipient-timeline" className="text-sm font-semibold">
          Timeline
        </h3>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <ol className="grid gap-3">
            {timeline.map((t) => (
              <li key={t.key} className={cn("grid gap-0.5 border-l-2 pl-3 text-sm", t.upcoming ? "border-dashed border-border" : "border-border")}>
                <span className="break-words">
                  {t.text}
                  {t.modeLabel ? (
                    <span className="ml-2 inline-flex h-5 items-center rounded-full border border-border px-1.5 align-middle text-[11px] font-medium text-muted-foreground">
                      {t.modeLabel}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  <time dateTime={t.iso} title={t.exact}>
                    {t.upcoming && !t.ago ? t.exact : `${t.ago} · ${t.exact}`}
                  </time>
                  {t.actor ? ` · ${t.actor}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function StepCard({
  view,
  detail,
  campaign,
  preview,
  previewError,
  variables,
  who,
}: {
  view: StepView;
  detail: RecipientDetail;
  campaign: PanelCampaign;
  preview: RenderedEmail | null;
  previewError: string | null;
  variables: Awaited<ReturnType<typeof templateVariables>>;
  who: string;
}) {
  const email = detail.emails.find((e) => e.step === view.step) ?? null;
  const step = detail.steps.find((s) => s.step === view.step) ?? null;
  const first = detail.steps.find((s) => s.step === 0) ?? null;
  const edit = step?.edit ?? null;
  const showsPreview = view.kind === "waiting" || view.kind === "planned";
  const shownStatus = view.kind === "planned" ? null : view.status;

  return (
    <article className="grid gap-3 rounded-lg border border-border p-3" aria-label={view.title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium">{view.title}</h4>
          <EmailStatusBadge status={shownStatus} />
          {edit ? (
            <span
              className="inline-flex h-5 items-center rounded-full border border-border px-1.5 text-[11px] font-medium text-muted-foreground"
              title={edit.editedByName ? `Edited by ${edit.editedByName}` : undefined}
            >
              Edited for {who}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {view.canEdit && step ? (
            <EditEmailButton
              campaignId={campaign.id}
              recipientId={detail.id}
              step={view.step}
              who={who}
              initial={{
                subject: view.step === 0 ? (edit?.subject ?? step.subject ?? "") : null,
                body: edit?.body ?? step.body,
              }}
              campaignText={{ subject: view.step === 0 ? step.subject : (first?.subject ?? null), body: step.body }}
              hasEdit={Boolean(edit)}
              variables={variables}
            />
          ) : null}
          {view.canRetry && view.emailId && view.status === "UNCONFIRMED" ? (
            <RetryOrSkipButton
              campaignId={campaign.id}
              emailId={view.emailId}
              recipientId={detail.id}
              who={who}
              address={email?.toEmail ?? detail.person.email}
              mode={campaign.mode}
            />
          ) : view.canRetry && view.emailId ? (
            <RetryEmailButton campaignId={campaign.id} emailId={view.emailId} />
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{view.note}</p>
      {view.detail ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
          <p className="mt-1 break-words text-muted-foreground">Mailgun said: {view.detail}</p>
        </details>
      ) : null}
      {view.kind === "sent" && email ? (
        <>
          <SentEmail subject={email.subject} text={email.text} />
          {email.mode === "DRY_RUN" ? (
            <Button asChild variant="ghost" size="sm" className="justify-self-start">
              <Link href={outboxHref({ campaignId: campaign.id, open: email.id })}>
                <ExternalLink aria-hidden />
                Open in the dry-run outbox
              </Link>
            </Button>
          ) : null}
        </>
      ) : null}
      {view.kind === "sending" && email && email.subject ? <SentEmail subject={email.subject} text={email.text} /> : null}
      {showsPreview ? (
        <EmailPreview
          email={preview}
          error={previewError}
          emptyText="This email can't be shown yet."
        />
      ) : null}
    </article>
  );
}
