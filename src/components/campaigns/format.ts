import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { modeLabel, type SendModeValue } from "@/core/rules/mode";
import { stepName, stepTitle } from "@/core/rules/wording";
import { heldReasonsOf } from "@/core/sequences/hold-reasons";
import { holdStateText, recheckStateText, sequenceSuffix, stopStateText } from "@/core/sequences/wording";
import { plural } from "@/core/text";
import { formatDateTime, formatShortDate, formatTime, timeAgo } from "@/core/time/format";
import { pickSequence } from "@/components/company-panel/emailed-text";
import { WIZARD_STEP_COUNT, stepKeyFor, wizardHref as wizardStepHref } from "@/components/campaign-wizard/steps";

/**
 * Shared definitions and pure display helpers for the campaign screens (the Campaigns list, the
 * campaign page with its recipient panel, the dry-run outbox) and the Contacts "Sequence" column.
 * No React and no I/O: browser-safe, used by the read models in
 * @/server/services/campaigns/queries, and unit-tested (tests/unit/campaigns).
 *
 * Wording follows PLAN.md A6: "Waiting to send / Sending / Sent / Didn't send / Not sure it was
 * sent", sentence case, dates in the viewer's own time zone. Held and reply-stopped people use the
 * words of M4-DESIGN §2.12 ("On hold: a possible reply needs checking", "Stopped: they replied"),
 * shared with the company panel through @/core/sequences/wording.
 */

export type CampaignStatusValue = "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "FINISHED" | "CANCELLED";
export type RecipientStateValue = "PENDING" | "SCHEDULED" | "WAITING" | "HELD" | "RECHECK" | "FINISHED" | "STOPPED" | "EXCLUDED";
export type SendStatusValue = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED" | "SKIPPED" | "UNKNOWN" | "UNCONFIRMED";
export type { SendModeValue };

type DateLike = Date | string | null | undefined;

function toTime(d: DateLike): number {
  if (!d) return Number.NaN;
  return (typeof d === "string" ? new Date(d) : d).getTime();
}

function n(v: number): string {
  return v.toLocaleString("en-US");
}

/** "the first email" / "follow-up 2" (a numbered follow-up reads better without "the"). */
export function theStep(step: number): string {
  return step <= 0 ? "the first email" : stepName(step);
}

/** "Emailed by Ali" → "emailed by Ali" (keeps "OK", "IBAN"… as they are). */
export function lowerFirst(text: string): string {
  const t = text.trim();
  if (t.length < 2) return t.toLowerCase();
  const [a, b] = [t.charAt(0), t.charAt(1)];
  if (a !== a.toUpperCase() || a === a.toLowerCase()) return t;
  if (b !== b.toLowerCase()) return t;
  return a.toLowerCase() + t.slice(1);
}

// ───────────────────────── statuses and tabs ─────────────────────────

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatusValue, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  RUNNING: "Running",
  PAUSED: "Paused",
  FINISHED: "Finished",
  CANCELLED: "Cancelled",
};

/** The Campaigns screen's tabs, in the order shown (PLAN.md A6). */
export const CAMPAIGN_TABS = ["drafts", "scheduled", "running", "paused", "finished", "cancelled"] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number];
export type CampaignTabCounts = Record<CampaignTab, number>;

export const CAMPAIGN_TAB_LABELS: Record<CampaignTab, string> = {
  drafts: "Drafts",
  scheduled: "Scheduled",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
  cancelled: "Cancelled",
};

export const CAMPAIGN_TAB_STATUS: Record<CampaignTab, CampaignStatusValue> = {
  drafts: "DRAFT",
  scheduled: "SCHEDULED",
  running: "RUNNING",
  paused: "PAUSED",
  finished: "FINISHED",
  cancelled: "CANCELLED",
};

export function tabForStatus(status: CampaignStatusValue): CampaignTab {
  return CAMPAIGN_TABS.find((t) => CAMPAIGN_TAB_STATUS[t] === status) ?? "drafts";
}

export function parseCampaignTab(v: unknown): CampaignTab | null {
  return typeof v === "string" && (CAMPAIGN_TABS as readonly string[]).includes(v) ? (v as CampaignTab) : null;
}

export function emptyTabCounts(): CampaignTabCounts {
  return { drafts: 0, scheduled: 0, running: 0, paused: 0, finished: 0, cancelled: 0 };
}

/** Which tab opens when the URL names none: the most useful one that has campaigns. */
export function defaultCampaignTab(counts: CampaignTabCounts): CampaignTab | null {
  const order: CampaignTab[] = ["running", "paused", "scheduled", "drafts", "finished", "cancelled"];
  return order.find((t) => counts[t] > 0) ?? null;
}

/** Empty state of one tab (the whole screen has its own, from PLAN.md A6). */
export function tabEmptyText(tab: CampaignTab): string {
  switch (tab) {
    case "drafts":
      return "No drafts. A campaign stays here while you set it up; it saves by itself.";
    case "scheduled":
      return "Nothing scheduled. Campaigns you set to start later show here.";
    case "running":
      return "No campaigns are running right now.";
    case "paused":
      return "No paused campaigns.";
    case "finished":
      return "No finished campaigns yet.";
    case "cancelled":
      return "No cancelled campaigns.";
  }
}

// ───────────────────────── links ─────────────────────────

export { WIZARD_STEP_COUNT };

/**
 * The wizard step a draft continues at, from the stored Campaign.wizardStep (1–6, clamped):
 * /campaigns/<id>/setup/audience … /schedule. The route names come from the wizard's own step
 * list, so the two packages can't drift apart.
 */
export function wizardHref(campaignId: number, wizardStep: number | null | undefined): string {
  return wizardStepHref(campaignId, stepKeyFor(wizardStep));
}

/** Drafts open in the wizard, everything else on the campaign page. */
export function campaignHref(c: { id: number; status: CampaignStatusValue; wizardStep?: number | null }): string {
  return c.status === "DRAFT" ? wizardHref(c.id, c.wizardStep) : `/campaigns/${c.id}`;
}

export function campaignsHref(tab?: CampaignTab | null, page?: number): string {
  const p = new URLSearchParams();
  if (tab) p.set("tab", tab);
  if (page && page > 1) p.set("page", String(page));
  const qs = p.toString();
  return qs ? `/campaigns?${qs}` : "/campaigns";
}

export type CampaignPageQuery = {
  filter?: RecipientFilter | null;
  q?: string | null;
  page?: number | null;
  recipient?: number | null;
};

/** /campaigns/<id> with the recipient list's filter, search, page and the open person. */
export function campaignPageHref(campaignId: number, query: CampaignPageQuery = {}): string {
  const p = new URLSearchParams();
  if (query.filter && query.filter !== "all") p.set("filter", query.filter);
  const q = query.q?.trim();
  if (q) p.set("q", q);
  if (query.page && query.page > 1) p.set("page", String(query.page));
  if (query.recipient) p.set("recipient", String(query.recipient));
  const qs = p.toString();
  return qs ? `/campaigns/${campaignId}?${qs}` : `/campaigns/${campaignId}`;
}

export type OutboxQuery = { campaignId?: number | null; page?: number | null; open?: number | null };

/** /campaigns/outbox with the campaign filter, page and the open email. */
export function outboxHref(query: OutboxQuery = {}): string {
  const p = new URLSearchParams();
  if (query.campaignId) p.set("campaign", String(query.campaignId));
  if (query.page && query.page > 1) p.set("page", String(query.page));
  if (query.open) p.set("open", String(query.open));
  const qs = p.toString();
  return qs ? `/campaigns/outbox?${qs}` : "/campaigns/outbox";
}

// ───────────────────────── dates ─────────────────────────

export type CampaignDatesInput = {
  status: CampaignStatusValue;
  startAt: DateLike;
  launchedAt: DateLike;
  finishedAt: DateLike;
  pausedAt: DateLike;
  updatedAt: DateLike;
};

/** "Started 3 Oct 2026, 14:05", "Finished …", "Starts …", "Last changed 2 hours ago" (viewer's zone). */
export function campaignDateParts(c: CampaignDatesInput, timeZone: string, now: Date = new Date()): string[] {
  const startedAt = c.startAt ?? c.launchedAt;
  const started = startedAt ? `Started ${formatDateTime(startedAt, timeZone)}` : null;
  const parts: Array<string | null> = [];
  switch (c.status) {
    case "DRAFT":
      parts.push(c.updatedAt ? `Last changed ${timeAgo(c.updatedAt, now)}` : null);
      break;
    case "SCHEDULED":
      parts.push(c.startAt ? `Starts ${formatDateTime(c.startAt, timeZone)}` : "Starts soon");
      break;
    case "RUNNING":
      parts.push(started);
      break;
    case "PAUSED":
      parts.push(started, c.pausedAt ? `Paused ${formatDateTime(c.pausedAt, timeZone)}` : null);
      break;
    case "FINISHED":
      parts.push(started, c.finishedAt ? `Finished ${formatDateTime(c.finishedAt, timeZone)}` : null);
      break;
    case "CANCELLED":
      parts.push(started, c.finishedAt ? `Cancelled ${formatDateTime(c.finishedAt, timeZone)}` : null);
      break;
  }
  return parts.filter((p): p is string => Boolean(p));
}

/** "Paused by Ali on 4 Oct 2026, 09:00. Nothing is sent until you resume it." */
export function pausedText(pausedAt: DateLike, reason: string | null | undefined, timeZone: string): string {
  const when = pausedAt ? ` on ${formatDateTime(pausedAt, timeZone)}` : "";
  const r = (reason ?? "").trim().replace(/\.$/, "");
  const tail = "Nothing is sent until you resume it.";
  if (/^paused by /i.test(r)) return `${r}${when}. ${tail}`;
  if (r) return `Paused${when}: ${lowerFirst(r)}. ${tail}`;
  return `Paused${when}. ${tail}`;
}

// ───────────────────────── progress ─────────────────────────

/** Recipient states that still have emails to come (mirrors control.ts OPEN_RECIPIENT_STATES). */
export const OPEN_RECIPIENT_STATES: readonly RecipientStateValue[] = ["PENDING", "SCHEDULED", "WAITING", "HELD", "RECHECK"];
/** Recipients who get nothing more from the campaign. */
export const CLOSED_RECIPIENT_STATES: readonly RecipientStateValue[] = ["FINISHED", "STOPPED"];
/** Emails that are dealt with: sent, or will never be sent. */
export const RESOLVED_EMAIL_STATUSES: readonly SendStatusValue[] = ["SENT", "SKIPPED", "FAILED", "CANCELLED"];
/** Emails that need someone to look at them (retry or skip). */
export const PROBLEM_EMAIL_STATUSES: readonly SendStatusValue[] = ["FAILED", "UNCONFIRMED", "UNKNOWN"];

export type ProgressInput = {
  /** Included recipients still in progress. */
  openRecipients: number;
  /** Steps switched on (first email + follow-ups). */
  enabledSteps: number;
  /** Every SENT email of the campaign. */
  sentAll: number;
  /** SENT emails of recipients who are finished or stopped. */
  sentClosed: number;
  /** Sent, skipped, failed or cancelled emails of recipients who are finished or stopped. */
  resolvedClosed: number;
};

export type Progress = { done: number; total: number };

/**
 * Overall progress in emails. A person still in progress counts every step that's switched on; a
 * person who finished or stopped counts only the emails that were really dealt with (so a stop
 * doesn't leave the bar stuck below 100%). Done = sent emails + emails that won't be sent.
 */
export function campaignProgress(p: ProgressInput): Progress {
  const steps = Math.max(1, Math.floor(p.enabledSteps) || 1);
  const sentOpen = Math.max(0, p.sentAll - p.sentClosed);
  const total = Math.max(0, p.openRecipients) * steps + Math.max(0, p.resolvedClosed);
  const done = Math.min(total, sentOpen + Math.max(0, p.resolvedClosed));
  return { done, total };
}

/** "26% · 120 of 450 emails done" (sent, or settled: skipped, didn't send, cancelled). */
export function progressDoneText(p: Progress): string {
  return `${percentDone(p)}% · ${n(p.done)} of ${plural(p.total, "email", "emails")} done`;
}

/** Whole percent; only 100 when everything is done (never rounds up to a false "100%"). */
export function percentDone(p: Progress): number {
  if (p.total <= 0) return 0;
  if (p.done >= p.total) return 100;
  return Math.min(99, Math.floor((p.done / p.total) * 100));
}

export type StepProgress = {
  step: number;
  delayDays: number;
  /** Step 0: everyone in the campaign (the audience). Unused for follow-ups. */
  planned: number;
  sent: number;
  /** Waiting to send (QUEUED). */
  waiting: number;
  sending: number;
  skipped: number;
  failed: number;
  cancelled: number;
  /** Not sure it was sent (UNKNOWN or UNCONFIRMED). */
  unsure: number;
  /** Emails waiting while their person is on hold (M4-DESIGN §2.11); not in `waiting` or `nextDueAt`. */
  held?: number;
  /** The earliest due time of the emails waiting to send (people on hold left out). */
  nextDueAt: DateLike;
};

function stepExtras(p: StepProgress): string[] {
  const extras: string[] = [];
  if (p.sending > 0) extras.push(`${n(p.sending)} sending now`);
  if (p.skipped > 0) extras.push(`${n(p.skipped)} skipped`);
  if (p.failed > 0) extras.push(`${n(p.failed)} didn't send`);
  if (p.unsure > 0) extras.push(`${n(p.unsure)} not sure ${p.unsure === 1 ? "it was" : "they were"} sent`);
  if (p.cancelled > 0) extras.push(`${n(p.cancelled)} cancelled`);
  return extras;
}

/**
 * "First email 120 of 150 sent" / "Follow-up 1: 40 waiting, next on 14 Oct" (PLAN.md A6), plus
 * "2 skipped", "1 didn't send"… when there are any, and the emails of people on hold apart
 * (M4-DESIGN §2.11): "Follow-up 1: 12 waiting, next on 14 Oct · 5 on hold".
 */
export function stepProgressText(p: StepProgress, timeZone: string, now: Date = new Date()): string {
  const extras = stepExtras(p);
  const held = Math.max(0, p.held ?? 0);
  const onHold = held > 0 ? ` · ${n(held)} on hold` : "";
  if (p.step <= 0) {
    return [`First email ${n(p.sent)} of ${n(p.planned)} sent`, ...extras].join(", ") + onHold;
  }
  const parts: string[] = [];
  if (p.sent > 0) parts.push(`${n(p.sent)} sent`);
  if (p.waiting > 0) {
    const due = toTime(p.nextDueAt);
    const on = p.nextDueAt ? formatShortDate(p.nextDueAt, timeZone, now) : "";
    if (!on) parts.push(`${n(p.waiting)} waiting`);
    else if (due > now.getTime()) parts.push(`${n(p.waiting)} waiting, next on ${on}`);
    else parts.push(`${n(p.waiting)} waiting, due ${on}`);
  }
  parts.push(...extras);
  if (parts.length === 0 && held > 0) return `${stepTitle(p.step)}: ${n(held)} on hold`;
  return `${stepTitle(p.step)}: ${parts.length ? parts.join(", ") : "nothing yet"}${onHold}`;
}

/** Every step on one line: "First email 120 of 150 sent · Follow-up 1: 40 waiting, next on 14 Oct". */
export function stepsSummary(steps: readonly StepProgress[], timeZone: string, now: Date = new Date()): string {
  return steps.map((s) => stepProgressText(s, timeZone, now)).join(" · ");
}

/** "3 days after the first email if there's no reply" (or minutes, for a practice dry run). */
export function delayText(delayDays: number, previousStep: number | null, daysAsMinutes = false): string {
  const d = Math.max(0, Math.floor(Number(delayDays) || 0));
  const unit = daysAsMinutes ? plural(d, "minute", "minutes") : plural(d, "day", "days");
  const after = previousStep === null ? "the previous email" : theStep(previousStep);
  return `${unit} after ${after} if there's no reply`;
}

// ───────────────────────── results ─────────────────────────

export type CampaignResults = {
  sent: number;
  delivered: number;
  bounced: number;
  replied: number;
  unsubscribed: number;
  complained: number;
};

export const RESULT_LABELS: Array<{ key: keyof CampaignResults; label: string }> = [
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "bounced", label: "Bounced" },
  { key: "replied", label: "Replied" },
  { key: "unsubscribed", label: "Unsubscribed" },
  { key: "complained", label: "Complained" },
];

/** The note under the counts (M3-DESIGN §4.3.9). Live campaigns need none. */
export function resultsNote(mode: SendModeValue | null | undefined): string | null {
  if (mode === "DRY_RUN" || !mode) return "Dry run: delivery results appear only when you simulate them in the dry-run outbox.";
  if (mode === "TEST") return "Test mode: Mailgun reports every email as delivered without delivering it.";
  return null;
}

// ───────────────────────── why emails wait (the pacer) ─────────────────────────

/** Why gated emails wait right now (SystemState "sending.pacer" `waiting.reason`, M3-DESIGN §2.3). */
export type WaitReasonValue =
  | "paused"
  | "restore-check"
  | "mailgun-not-connected"
  | "catch-up"
  | "rate-limited"
  | "mailgun-unreachable"
  | "live-not-ready"
  | "reply-route"
  | "main-domain-mx"
  | "pending-events"
  | "outage-hold"
  | "possible-reply"
  | "plan-limit"
  | "inbox-check"
  | "outside-hours"
  | "cap-reached"
  | "sender-cap"
  | "pacing"
  | "nothing-due";

/** The main-domain-mx waiting line in own-mailbox mode (review SCREENS-11, DOMAIN-8). */
export const OWN_MX_WAITING_TEXT =
  "Waiting: mail for your domain doesn't go to your mail provider (it points to Mailgun or Cloudflare Email Routing, or is missing), so your everyday email and replies to your campaigns can be lost. The Owner can see how to fix it in Settings › Domain checklist.";

/**
 * The campaign page's waiting line for every reason (§5.8): "Waiting for the check with Mailgun.",
 * "Waiting: replies to Ali can't reach Ali yet.", "Next email in about 4 minutes."… `until` is shown
 * in the viewer's time zone. Null for "nothing-due" (nothing is waiting).
 */
export function waitingText(
  w: { reason: WaitReasonValue; until: DateLike },
  ctx: {
    timeZone: string;
    now?: Date;
    senderName?: string | null;
    /** Own-mailbox mode (review SCREENS-11, DOMAIN-8): the main-domain-mx line's words. Absent = app mode, unchanged. */
    ownMailbox?: boolean;
  },
): string | null {
  const now = ctx.now ?? new Date();
  const until = w.until ? formatTimeOrDate(w.until, ctx.timeZone, now) : null;
  const who = ctx.senderName?.trim() || "the sender";
  switch (w.reason) {
    case "paused":
      return "Waiting: sending is paused for everyone.";
    case "restore-check":
      return "Waiting for the restore check with Mailgun.";
    case "mailgun-not-connected":
      return "Waiting: Mailgun isn't connected. The Owner can connect it in Settings › Sending & Mailgun.";
    case "catch-up":
      return "Waiting for the check with Mailgun.";
    case "rate-limited":
      return until ? `Waiting: Mailgun asked us to slow down; trying again at ${until}.` : "Waiting: Mailgun asked us to slow down.";
    case "mailgun-unreachable":
      return until ? `Waiting: Mailgun didn't answer; trying again at ${until}.` : "Waiting: Mailgun didn't answer; trying again soon.";
    case "live-not-ready":
      return "Waiting: Mailgun's unsubscribe handling or tracking settings changed. The Owner can fix them in Settings › Domain checklist.";
    case "reply-route":
      return `Waiting: replies to ${who} can't reach ${who} yet.`;
    case "main-domain-mx":
      // Shared-From mode (SHARED-FROM-DESIGN §3.7, F27): LIVE emails wait while the from-mx row is "bad", which is
      // either a Mailgun MX or no MX at all (review SCREENS-07: the line names both, like the notice and the gate); the
      // row itself says which and what to change at the DNS host. Own-mailbox mode (review SCREENS-11, DOMAIN-8): nothing
      // is forwarded there, and Cloudflare Email Routing is red too (`ownMxCause`), so the line names all three causes.
      if (ctx.ownMailbox) return OWN_MX_WAITING_TEXT;
      return "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist.";
    case "pending-events":
      return "Waiting: a reply or a Mailgun report for one address hasn't been processed yet.";
    case "outage-hold":
      // Both while the app puts the hold in place and while it covers someone it doesn't hold (e.g. after a Retry).
      return "Waiting: replies may have been missed while the PC was off. These emails go once that has been checked.";
    case "possible-reply":
      return "Waiting: someone needs to decide whether a message from this company is a real reply (Notifications page).";
    case "plan-limit":
      // MAIN-DOMAIN-DESIGN O23: the rolling 24 hours of the Mailgun plan's daily limit are used up.
      return until
        ? `Waiting: your Mailgun plan's daily limit is used up. The next email can go at ${until}.`
        : "Waiting: your Mailgun plan's daily limit is used up.";
    case "inbox-check":
      // MAIN-DOMAIN-DESIGN O33: own-mailbox mode, live follow-ups wait for today's "I've read contact@…" click.
      return "Waiting for today's inbox check (Notifications › Inbox check).";
    case "outside-hours":
      return until ? `Waiting for sending hours: the next window opens at ${until}.` : "Waiting for sending hours.";
    case "cap-reached":
      return "Today's limit is reached. Sending continues tomorrow.";
    case "sender-cap":
      return `${who.charAt(0).toUpperCase()}${who.slice(1)} reached their own daily limit. Sending continues tomorrow.`;
    case "pacing": {
      if (!w.until) return "Next email in a moment.";
      const minutes = Math.round((toTime(w.until) - now.getTime()) / 60_000);
      if (minutes <= 1) return "Next email in about a minute.";
      return `Next email in about ${minutes} minutes.`;
    }
    case "nothing-due":
      return null;
  }
}

/** "14:05" today, else "3 Oct, 09:00" (viewer's zone). */
function formatTimeOrDate(d: Date | string, timeZone: string, now: Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  return day(date) === day(now) ? time : `${formatShortDate(date, timeZone, now)}, ${time}`;
}

export function modeBadgeText(mode: SendModeValue | null | undefined): string {
  return modeLabel(mode);
}

// ───────────────────────── people on hold (M4-DESIGN §9.3) ─────────────────────────

/** Who in one campaign is on hold, and why (CampaignOverview.holds). */
export type CampaignHolds = {
  /** Companies with people on hold for a possible reply nobody has decided yet. */
  possibleReplyCompanies: number;
  /** People on hold because the PC was off too long: emailed already (their follow-ups wait) and not yet (first emails). */
  outage: { followUps: number; firstEmails: number };
  /** The window of the outage hold (ISO), when one was applied. */
  outageFrom: string | null;
  outageTo: string | null;
};

/** Where "Open Replies waiting for an answer" leads. */
export const WAITING_REPLIES_HREF = "/notifications#replies";

/** "Follow-ups to 2 companies are on hold until someone checks a possible reply." (null when none). */
export function possibleReplyNotice(companies: number): string | null {
  if (companies <= 0) return null;
  return `Follow-ups to ${plural(companies, "company", "companies")} are on hold until someone checks a possible reply.`;
}

/**
 * The campaign page's outage notice (M4-DESIGN §9.3): "Follow-ups of 5 people are on hold because replies from 3 Oct to
 * 9 Oct may have been missed. Ali can continue them from Notifications after checking their inbox." The dates are the
 * window the app couldn't check, not the PC's off-time (review SPEC-03). The Owner reads " You can also
 * continue them in Settings › Sending & Mailgun."; the sender reads "You can continue them…" instead of their name.
 * A switched-off sender (`senderActive` false) can't sign in, so only the Owner can continue them: "Ali is switched off,
 * so only the Owner can continue them in Settings › Sending & Mailgun." Colleagues' first emails are named too. Dates in
 * the viewer's zone. Null when nobody is held for an outage.
 */
export function outageHoldNotice(
  h: Pick<CampaignHolds, "outage" | "outageFrom" | "outageTo">,
  ctx: { senderName: string | null; senderActive?: boolean; viewerIsSender: boolean; viewerIsOwner: boolean; timeZone: string; now?: Date },
): string | null {
  const { followUps, firstEmails } = h.outage;
  if (followUps <= 0 && firstEmails <= 0) return null;
  const now = ctx.now ?? new Date();
  const why =
    h.outageFrom && h.outageTo
      ? `because replies from ${formatShortDate(h.outageFrom, ctx.timeZone, now)} to ${formatShortDate(h.outageTo, ctx.timeZone, now)} may have been missed`
      : "because the PC was off too long to check for replies";
  const owner = ctx.viewerIsOwner ? " You can also continue them in Settings › Sending & Mailgun." : "";
  if (followUps <= 0) {
    return (
      `First emails to ${plural(firstEmails, "person", "people")} are on hold ${why}. ` +
      "They go once everyone who emailed their company has checked their inbox."
    );
  }
  const colleagues = firstEmails > 0 ? ` First emails to ${plural(firstEmails, "other person", "other people")} at those companies wait too.` : "";
  let who: string;
  if (ctx.senderName && ctx.senderActive === false) {
    // A switched-off sender can't sign in to check their inbox.
    who = ctx.viewerIsOwner
      ? `${ctx.senderName} is switched off. You can continue them in Settings › Sending & Mailgun.`
      : `${ctx.senderName} is switched off, so only the Owner can continue them in Settings › Sending & Mailgun.`;
  } else if (ctx.viewerIsSender) who = `You can continue them from Notifications after checking your inbox.${owner}`;
  else if (ctx.senderName) who = `${ctx.senderName} can continue them from Notifications after checking their inbox.${owner}`;
  // The sender's account is gone: only the Owner can continue them.
  else who = ctx.viewerIsOwner ? "You can continue them in Settings › Sending & Mailgun." : "The Owner can continue them in Settings › Sending & Mailgun.";
  return `Follow-ups of ${plural(followUps, "person", "people")} are on hold ${why}. ${who}${colleagues}`;
}

// ───────────────────────── recipients ─────────────────────────

export const RECIPIENT_FILTERS = ["all", "active", "finished", "stopped", "problems", "excluded", "edited"] as const;
export type RecipientFilter = (typeof RECIPIENT_FILTERS)[number];
export type RecipientCounts = Record<RecipientFilter, number>;

export const RECIPIENT_FILTER_LABELS: Record<RecipientFilter, string> = {
  all: "All",
  active: "In progress",
  finished: "Finished",
  stopped: "Stopped",
  problems: "Didn't send",
  excluded: "Left out",
  edited: "Edited",
};

export function parseRecipientFilter(v: unknown): RecipientFilter {
  return typeof v === "string" && (RECIPIENT_FILTERS as readonly string[]).includes(v) ? (v as RecipientFilter) : "all";
}

export function emptyRecipientCounts(): RecipientCounts {
  return { all: 0, active: 0, finished: 0, stopped: 0, problems: 0, excluded: 0, edited: 0 };
}

/** Empty state of the recipient table. */
export function recipientEmptyText(filter: RecipientFilter, q?: string | null): string {
  if (q?.trim()) return "Nobody in this campaign matches your search.";
  switch (filter) {
    case "active":
      return "Nobody is waiting for an email from this campaign.";
    case "finished":
      return "Nobody has finished yet.";
    case "stopped":
      return "Nobody has been stopped.";
    case "problems":
      return "Every email so far went out as planned.";
    case "excluded":
      return "Nobody was left out.";
    case "edited":
      return "Nobody has an email of their own. Open a person to edit an email that hasn't been sent.";
    default:
      return "Nobody is in this campaign.";
  }
}

/** "Anna Berg", "General inbox", or the address when the person has no name. */
export function recipientName(person: { name: string | null; email: string | null; isGeneric?: boolean }, fallbackEmail?: string | null): string {
  const name = (person.name ?? "").trim();
  if (person.isGeneric || name === GENERAL_INBOX_NAME) return GENERAL_INBOX_NAME;
  if (name) return name;
  return person.email || fallbackEmail || "No name";
}

const SHORT_STOP_REASONS: Record<string, string> = {
  replied: "replied",
  reply: "replied",
  company_replied: "someone at the company replied",
  "company-replied": "someone at the company replied",
  companyreplied: "someone at the company replied",
  unsubscribed: "unsubscribed",
  unsubscribe: "unsubscribed",
  bounced: "bounced",
  bounce: "bounced",
  complained: "marked as spam",
  complaint: "marked as spam",
  status: "the company's status changed",
  status_changed: "the company's status changed",
  manual: "stopped by hand",
  stopped: "stopped by hand",
  skipped: "skipped",
  deleted: "company deleted",
  company_deleted: "company deleted",
  person_deleted: "person removed",
  person_removed: "person removed",
  suppressed: "on the do-not-email list",
  suppression: "on the do-not-email list",
  invalid: "the address check said not to email it",
  verification: "the address check said not to email it",
  campaign_cancelled: "campaign cancelled",
  cancelled: "campaign cancelled",
  failed: "didn't send",
};

const STATUS_WORDS: Record<string, string> = {
  REPLIED: "Replied",
  CLIENT: "Client",
  NOT_INTERESTED: "Not interested",
  DO_NOT_CONTACT: "Do not contact",
  CONTACTED: "Contacted",
  NOT_CONTACTED: "Not contacted",
};

/** A stored stop reason in a few words: "replied", "skipped by Ali", "marked Client", "didn't send". */
export function shortStopReason(reason: string | null | undefined): string {
  const raw = (reason ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[.\s]+/g, "_");
  if (SHORT_STOP_REASONS[key]) return SHORT_STOP_REASONS[key]!;
  const status = raw.match(/^status[:=_\s-]+([A-Z_]+)$/i);
  if (status) {
    const word = STATUS_WORDS[status[1]!.toUpperCase()];
    if (word) return `marked ${word}`;
  }
  if (/\s/.test(raw)) return lowerFirst(raw).replace(/\.$/, "");
  return raw.replace(/[_-]+/g, " ").toLowerCase();
}

export type RecipientStateInput = {
  state: RecipientStateValue;
  included?: boolean;
  currentStep: number;
  nextDueAt: DateLike;
  stopReason: string | null;
  /** While HELD: why ("outage", "possible-reply", or both; M4-DESIGN §2.8). Ignored in any other state. */
  holdReason?: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7). Ignored in any other state. */
  recheckAt?: DateLike;
  exclusionReason?: string | null;
  campaignStatus?: CampaignStatusValue | null;
  /** The email for the current step, when the caller has it (the campaign page does). */
  email?: { status: SendStatusValue; dueAt: DateLike; lastError?: string | null } | null;
};

/** "27 Sep at 14:05" in the viewer's zone: when a RECHECK recipient's second address check is due. */
export function recheckWhenText(recheckAt: DateLike, timeZone: string, now: Date = new Date()): string | null {
  if (!recheckAt || Number.isNaN(toTime(recheckAt))) return null;
  return `${formatShortDate(recheckAt, timeZone, now)} at ${formatTime(recheckAt, timeZone)}`;
}

/**
 * A person's place in a campaign, in words (M4-DESIGN §2.12): "Scheduled for 3 Oct", "Waiting for
 * follow-up 1 on 14 Oct", "On hold: a possible reply needs checking", "Waiting for re-check on 27 Sep at 14:05",
 * "Finished", "Stopped: they replied", "Stopped: skipped by Ali", "Left out: unsubscribed"…
 */
export function recipientStateText(r: RecipientStateInput, timeZone: string, now: Date = new Date()): string {
  if (r.state === "EXCLUDED" || r.included === false) {
    const why = r.exclusionReason?.trim();
    return why ? `Left out: ${lowerFirst(why).replace(/\.$/, "")}` : "Left out";
  }
  switch (r.state) {
    case "STOPPED": {
      const m4 = stopStateText(r.stopReason, "campaign");
      if (m4) return m4;
      const why = shortStopReason(r.stopReason);
      return why ? `Stopped: ${why}` : "Stopped";
    }
    case "FINISHED":
      return "Finished";
    case "HELD":
      return holdStateText(heldReasonsOf({ state: r.state, holdReason: r.holdReason }), "campaign");
    case "RECHECK":
      return recheckStateText(recheckWhenText(r.recheckAt, timeZone, now), "campaign");
    case "PENDING":
      if (!r.campaignStatus || r.campaignStatus === "DRAFT") return "Not launched yet";
      break;
    default:
      break;
  }
  if (r.campaignStatus === "CANCELLED") return "Stopped: campaign cancelled";

  const step = Math.max(0, Math.floor(r.currentStep) || 0);
  const name = stepName(step);
  const the = theStep(step);
  const email = r.email ?? null;
  if (email?.status === "SENDING") return `Sending ${the} now`;
  if (email?.status === "UNKNOWN") return `Checking whether ${the} was sent`;
  if (email?.status === "UNCONFIRMED") return `Not sure ${the} was sent`;
  if (email?.status === "FAILED") return `${stepTitle(step)} didn't send`;
  if (r.campaignStatus === "PAUSED") return `Paused before ${the}`;
  if (email?.status === "QUEUED" && email.lastError) return `Trying ${the} again soon`;

  const due = email?.dueAt ?? r.nextDueAt;
  if (!due) return step === 0 ? "First email waiting to send" : `Waiting for ${name}`;
  const on = formatShortDate(due, timeZone, now);
  if (toTime(due) > now.getTime()) return step === 0 ? `Scheduled for ${on}` : `Waiting for ${name} on ${on}`;
  return step === 0 ? "First email waiting to send" : `${stepTitle(step)} waiting to send since ${on}`;
}

/**
 * A6's email status words. "Not sure it was sent" has a short first stage (M3-DESIGN §9.4 item 7):
 * for up to 2 hours the app checks with Mailgun ("Checking whether it was sent"); only then is it
 * "Not sure it was sent", with Retry or Skip.
 */
export const EMAIL_STATUS_LABELS: Record<SendStatusValue, string> = {
  QUEUED: "Waiting to send",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Didn't send",
  CANCELLED: "Cancelled",
  SKIPPED: "Skipped",
  UNKNOWN: "Checking whether it was sent",
  UNCONFIRMED: "Not sure it was sent",
};

export type RecipientRowInput = {
  id: number;
  name: string;
  email: string;
  companyId: number;
  companyName: string;
  companyDeleted: boolean;
  state: RecipientStateValue;
  included: boolean;
  currentStep: number;
  nextDueAt: DateLike;
  stopReason: string | null;
  /** While HELD: why (M4-DESIGN §2.8). */
  holdReason?: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7). */
  recheckAt?: Date | string | null;
  exclusionReason: string | null;
  hasEdits: boolean;
  emails: ReadonlyArray<{ step: number; status: SendStatusValue; dueAt: Date | string; sentAt: Date | string | null; lastError: string | null }>;
};

/** One row of the campaign page's people table, every label ready. */
export type RecipientRowView = {
  id: number;
  /** Opens this person's panel over the page (keeps the filter, search and page). */
  href: string;
  name: string;
  email: string;
  companyName: string;
  /** Null when the company was deleted (its panel can't open from here). */
  companyHref: string | null;
  stateText: string;
  /** "First email sent 3 Oct" (the latest one), or null. */
  lastSent: string | null;
  edited: boolean;
  /** An email didn't send (or we're not sure): show it apart. */
  problem: boolean;
  leftOut: boolean;
};

export function toRecipientRowView(
  r: RecipientRowInput,
  ctx: { campaignId: number; campaignStatus: CampaignStatusValue; query: CampaignPageQuery },
  timeZone: string,
  now: Date = new Date(),
): RecipientRowView {
  const current = r.emails.find((e) => e.step === r.currentStep) ?? null;
  const lastSent = [...r.emails].filter((e) => e.status === "SENT" && e.sentAt).sort((a, b) => b.step - a.step)[0] ?? null;
  return {
    id: r.id,
    href: campaignPageHref(ctx.campaignId, { ...ctx.query, recipient: r.id }),
    name: r.name,
    email: r.email,
    companyName: r.companyDeleted ? `${r.companyName} (deleted)` : r.companyName,
    companyHref: r.companyDeleted ? null : `/contacts?company=${r.companyId}`,
    stateText: recipientStateText(
      {
        state: r.state,
        included: r.included,
        currentStep: r.currentStep,
        nextDueAt: r.nextDueAt,
        stopReason: r.stopReason,
        holdReason: r.holdReason,
        recheckAt: r.recheckAt,
        exclusionReason: r.exclusionReason,
        campaignStatus: ctx.campaignStatus,
        email: current,
      },
      timeZone,
      now,
    ),
    lastSent: lastSent ? `${stepTitle(lastSent.step)} sent ${formatShortDate(lastSent.sentAt, timeZone, now)}` : null,
    edited: r.hasEdits,
    problem: r.emails.some((e) => (PROBLEM_EMAIL_STATUSES as readonly string[]).includes(e.status)),
    leftOut: r.state === "EXCLUDED" || !r.included,
  };
}

// ───────────────────────── the Contacts "Sequence" column ─────────────────────────

/** One CampaignRecipient row of a company, as the Contacts query returns it. */
export type CompanySequence = {
  id: number;
  companyId: number;
  campaignId: number;
  campaignName: string;
  campaignStatus: CampaignStatusValue;
  campaignMode: SendModeValue | null;
  /**
   * This campaign's sends count as "emailed" (countsAsEmailed by its own launch flag, M6-DESIGN §2.2: live of a
   * campaign launched after go-live, or a dry run in the practice copy). Decides the suffix (M4-DESIGN §2.12): a live
   * email of a campaign launched before go-live reads "(test list)", also after go-live.
   */
  countsAsEmailed: boolean;
  personId: number;
  state: RecipientStateValue;
  currentStep: number;
  nextDueAt: Date | string | null;
  stopReason: string | null;
  /** While HELD: why (M4-DESIGN §2.8). */
  holdReason?: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7). */
  recheckAt?: Date | string | null;
  updatedAt: Date | string;
};

/** The Sequence cell's tooltip note for each suffix. */
const SUFFIX_NOTES: Readonly<Record<string, string>> = {
  " (dry run)": " · a dry run: nothing was really sent",
  " (test)": " · Mailgun test mode: nothing was delivered",
  " (test list)": " · sent to your test list before going live",
};

/**
 * The Sequence cell: the company's current sequence (one still in progress first, real campaigns
 * before dry runs, otherwise the latest; the same pick as the company panel) in words (M4-DESIGN
 * §2.12), with the suffix of `sequenceSuffix`: " (dry run)" for a dry run that doesn't count as
 * emailed, " (test)" for Mailgun's test mode, " (test list)" for a live email of a campaign launched
 * before go-live.
 */
export function companySequenceLabel(
  rows: readonly CompanySequence[],
  timeZone: string,
  now: Date = new Date(),
): { text: string; title: string } | null {
  if (rows.length === 0) return null;
  const pick = pickSequence(rows);
  if (!pick) return null;
  const text = recipientStateText(
    {
      state: pick.state,
      currentStep: pick.currentStep,
      nextDueAt: pick.nextDueAt,
      stopReason: pick.stopReason,
      holdReason: pick.holdReason,
      recheckAt: pick.recheckAt,
      campaignStatus: pick.campaignStatus,
    },
    timeZone,
    now,
  );
  const suffix = sequenceSuffix({ mode: pick.campaignMode, countsAsEmailed: pick.countsAsEmailed });
  return { text: text + suffix, title: `${pick.campaignName}${SUFFIX_NOTES[suffix] ?? ""}` };
}

/**
 * True when the company's current sequence (the same pick as `companySequenceLabel`) is a test-list send: a live email
 * of a campaign launched before go-live, which doesn't count as emailed (M6-DESIGN §2.2). The Contacts "Last emailed"
 * cell explains its "Never" with it (L18).
 */
export function isTestListSequence(rows: readonly CompanySequence[]): boolean {
  const pick = pickSequence(rows);
  return pick !== null && sequenceSuffix({ mode: pick.campaignMode, countsAsEmailed: pick.countsAsEmailed }) === " (test list)";
}

// ───────────────────────── the recipient panel ─────────────────────────

export type PanelEmail = {
  id: number;
  step: number;
  status: SendStatusValue;
  dueAt: Date | string;
  sentAt: Date | string | null;
  lastError: string | null;
  /** Mailgun's id: Mailgun has this email, so it can never be retried. */
  providerId?: string | null;
  /** Mailgun's own words when it refused the email (shown behind "Details"). */
  failureDetail?: string | null;
};

export type StepViewInput = {
  campaignStatus: CampaignStatusValue;
  daysAsMinutes?: boolean;
  /**
   * `holdReason`: while HELD, why (M4-DESIGN §2.8); an email waiting for a held person says so instead of a due date.
   * `recheckAt`: while RECHECK, when the second address check is due (M5-DESIGN §2.7); the waiting first email says so.
   */
  recipient: { state: RecipientStateValue; included: boolean; stopReason: string | null; holdReason?: string | null; recheckAt?: DateLike };
  steps: ReadonlyArray<{ step: number; enabled: boolean; delayDays: number }>;
  emails: readonly PanelEmail[];
};

export type StepViewKind = "sent" | "sending" | "waiting" | "planned" | "problem" | "skipped" | "cancelled" | "not-sent";

export type StepView = {
  step: number;
  title: string;
  kind: StepViewKind;
  emailId: number | null;
  status: SendStatusValue | null;
  /** "Edit this email" is offered (the engine still has the final word). */
  canEdit: boolean;
  /** "Try again" is offered (didn't send, or not sure it was sent, and Mailgun doesn't have it). */
  canRetry: boolean;
  /** The plain line under the step's title. */
  note: string;
  /** Technical text behind "Details" (Mailgun's own words for a refused email), or null. */
  detail: string | null;
};

const ENDED: ReadonlySet<CampaignStatusValue> = new Set(["FINISHED", "CANCELLED"]);

/**
 * One card per email of a person's sequence: every step that's switched on, plus any step that
 * already has an email (even if it was switched off later), in order.
 */
export function recipientStepViews(input: StepViewInput, timeZone: string, now: Date = new Date()): StepView[] {
  const byStep = new Map(input.emails.map((e) => [e.step, e]));
  const steps = new Set<number>([...input.steps.filter((s) => s.enabled).map((s) => s.step), ...input.emails.map((e) => e.step)]);
  const enabled = input.steps.filter((s) => s.enabled).sort((a, b) => a.step - b.step);
  const r = input.recipient;
  const recipientOpen = r.included && (OPEN_RECIPIENT_STATES as readonly string[]).includes(r.state);
  const campaignOpen = !ENDED.has(input.campaignStatus);
  const editable = campaignOpen && r.included && r.state !== "EXCLUDED";

  return [...steps]
    .sort((a, b) => a - b)
    .map((step): StepView => {
      const title = stepTitle(step);
      const e = byStep.get(step);
      const base = { step, title, emailId: e?.id ?? null, status: e?.status ?? null, canEdit: false, canRetry: false, detail: null };
      if (!e) {
        if (!recipientOpen || !campaignOpen) return { ...base, kind: "not-sent", note: "Won't be sent" };
        const idx = enabled.findIndex((s) => s.step === step);
        const prev = idx > 0 ? enabled[idx - 1]!.step : null;
        const delay = enabled[idx]?.delayDays ?? 0;
        const note = step === 0 ? "Goes when the campaign starts" : `Goes ${delayText(delay, prev, input.daysAsMinutes)}`;
        return { ...base, kind: "planned", canEdit: editable, note };
      }
      switch (e.status) {
        case "SENT":
          return { ...base, kind: "sent", note: e.sentAt ? `Sent ${formatDateTime(e.sentAt, timeZone)}` : "Sent" };
        case "SENDING":
          return { ...base, kind: "sending", note: "Being sent right now, so it can't be changed" };
        case "QUEUED": {
          // A held person's email stays queued (M4-DESIGN §2.11) but doesn't go until the hold ends: say why, no due date.
          if (r.state === "HELD") {
            return { ...base, kind: "waiting", canEdit: editable, note: holdStateText(heldReasonsOf({ state: r.state, holdReason: r.holdReason }), "campaign") };
          }
          // Waiting for the second address check (M5-DESIGN §2.7): it goes only once the check passes.
          if (r.state === "RECHECK") {
            return { ...base, kind: "waiting", canEdit: editable, note: recheckStateText(recheckWhenText(r.recheckAt, timeZone, now), "campaign") };
          }
          const future = toTime(e.dueAt) > now.getTime();
          let note = future ? `Waiting to send, due ${formatDateTime(e.dueAt, timeZone)}` : "Waiting to send";
          if (e.lastError) note += `. The last try didn't work (${lowerFirst(e.lastError).replace(/\.$/, "")}); it will be tried again`;
          return { ...base, kind: "waiting", canEdit: editable, note };
        }
        case "UNKNOWN":
          // The app is still checking with Mailgun (up to 2 hours): no buttons yet.
          return { ...base, kind: "problem", note: "Checking with Mailgun whether it was sent…" };
        case "FAILED":
        case "UNCONFIRMED": {
          const label = EMAIL_STATUS_LABELS[e.status];
          const retryable =
            !e.providerId &&
            input.campaignStatus !== "CANCELLED" &&
            !(r.state === "STOPPED" && r.stopReason !== "failed") &&
            r.state !== "EXCLUDED";
          const why = (e.lastError ?? "").trim();
          // A reason that already starts with the label (OWN_MAILBOX_TEXTS.senderBlockedTwice, "Didn't send: …") is shown
          // as it is, never "Didn't send: didn't send: …" (MAIN-DOMAIN-DESIGN O35), as Skipped and Cancelled below do.
          const labelled = why.toLowerCase().startsWith(`${label.toLowerCase()}:`);
          const note = !why ? label : /^mailgun refused/i.test(why) || labelled ? why : `${label}: ${lowerFirst(why)}`;
          return { ...base, kind: "problem", canRetry: retryable, note, detail: e.failureDetail?.trim() || null };
        }
        case "SKIPPED": {
          const why = (e.lastError ?? "").trim();
          const note = !why ? "Skipped" : /^skipped\b/i.test(why) ? why : `Skipped: ${lowerFirst(why)}`;
          return { ...base, kind: "skipped", note };
        }
        case "CANCELLED": {
          const why = (e.lastError ?? "").trim();
          const note = !why ? "Cancelled" : /^cancelled\b/i.test(why) ? why : `Cancelled: ${lowerFirst(why)}`;
          return { ...base, kind: "cancelled", note };
        }
      }
    });
}

export type TimelineActivity = {
  id: number;
  at: Date | string;
  summary: string;
  actorName: string | null;
  mode: SendModeValue | null;
};

export type RecipientTimelineItem = {
  key: string;
  iso: string;
  exact: string;
  ago: string;
  text: string;
  actor: string | null;
  /** An email still to come (shown first, soonest first). */
  upcoming: boolean;
  modeLabel: string | null;
};

function isoOf(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString();
}

/**
 * A person's timeline in one campaign: emails still to come first (soonest first), then everything
 * that happened, newest first (sent, skipped, edited, status changes… from the activity log). While
 * the person is on hold (`recipient.state` HELD), an email to come reads "Follow-up 1 is on hold",
 * never "is due" or "is waiting to send" (it doesn't go until the hold ends).
 */
export function buildRecipientTimeline(
  input: {
    emails: readonly PanelEmail[];
    activity: readonly TimelineActivity[];
    /** `recheckAt`: while RECHECK, when the second address check is due (its waiting first email says so, M5-DESIGN §2.7). */
    recipient?: { state: RecipientStateValue; recheckAt?: DateLike };
  },
  timeZone: string,
  now: Date = new Date(),
): RecipientTimelineItem[] {
  const held = input.recipient?.state === "HELD";
  const rechecking = input.recipient?.state === "RECHECK";
  const upcoming = input.emails
    .filter((e) => e.status === "QUEUED")
    .sort((a, b) => toTime(a.dueAt) - toTime(b.dueAt))
    .map((e): RecipientTimelineItem => {
      const future = toTime(e.dueAt) > now.getTime();
      return {
        key: `email-${e.id}`,
        iso: isoOf(e.dueAt),
        exact: formatDateTime(e.dueAt, timeZone),
        ago: future || held || rechecking ? "" : timeAgo(e.dueAt, now),
        text: rechecking
          ? recheckStateText(recheckWhenText(input.recipient?.recheckAt, timeZone, now), "campaign")
          : held
            ? `${stepTitle(e.step)} is on hold`
            : future
              ? `${stepTitle(e.step)} is due`
              : `${stepTitle(e.step)} is waiting to send`,
        actor: null,
        upcoming: true,
        modeLabel: null,
      };
    });
  const past = [...input.activity]
    .sort((a, b) => toTime(b.at) - toTime(a.at) || b.id - a.id)
    .map(
      (a): RecipientTimelineItem => ({
        key: `activity-${a.id}`,
        iso: isoOf(a.at),
        exact: formatDateTime(a.at, timeZone),
        ago: timeAgo(a.at, now),
        text: a.summary,
        actor: a.actorName,
        upcoming: false,
        modeLabel: a.mode === "DRY_RUN" ? "Dry run" : a.mode === "TEST" ? "Test" : null,
      }),
    );
  return [...upcoming, ...past];
}

// ───────────────────────── the Campaigns list ─────────────────────────

export type CampaignListInput = {
  id: number;
  name: string;
  status: CampaignStatusValue;
  mode: SendModeValue | null;
  wizardStep: number;
  senderName: string | null;
  audience: number;
  firstEmail: { sent: number; planned: number };
  enabledSteps: number;
  progress: Progress;
  startAt: DateLike;
  launchedAt: DateLike;
  finishedAt: DateLike;
  pausedAt: DateLike;
  pauseReason: string | null;
  updatedAt: DateLike;
};

/** A campaign row with every label ready (plain data, for server or client components). */
export type CampaignListView = {
  id: number;
  name: string;
  href: string;
  status: CampaignStatusValue;
  statusLabel: string;
  /** Null for drafts: the mode is fixed at launch. */
  mode: SendModeValue | null;
  modeLabel: string | null;
  isDraft: boolean;
  sender: string;
  audience: string;
  /** Null for drafts and scheduled campaigns (nothing to show yet). */
  percent: number | null;
  progressText: string | null;
  progressTitle: string | null;
  dates: string[];
  pauseReason: string | null;
};

export function toCampaignListView(c: CampaignListInput, timeZone: string, now: Date = new Date()): CampaignListView {
  const isDraft = c.status === "DRAFT";
  const followUps = Math.max(0, c.enabledSteps - 1);
  const showProgress = c.status === "RUNNING" || c.status === "PAUSED" || c.status === "FINISHED" || c.status === "CANCELLED";
  const firstText = `First email ${n(c.firstEmail.sent)} of ${n(c.firstEmail.planned)} sent`;
  const followText = followUps > 0 ? ` · ${plural(followUps, "follow-up", "follow-ups")}` : "";
  return {
    id: c.id,
    name: c.name,
    href: campaignHref(c),
    status: c.status,
    statusLabel: CAMPAIGN_STATUS_LABELS[c.status],
    mode: isDraft ? null : (c.mode ?? "DRY_RUN"),
    modeLabel: isDraft ? null : modeLabel(c.mode),
    isDraft,
    sender: c.senderName ? `Sent by ${c.senderName}` : isDraft ? "No sender chosen yet" : "Sender removed",
    audience: isDraft ? `${plural(c.audience, "person", "people")} ticked` : plural(c.audience, "person", "people"),
    percent: showProgress ? percentDone(c.progress) : null,
    progressText: showProgress ? `${firstText}${followText}` : c.status === "SCHEDULED" ? `${plural(c.audience, "first email", "first emails")} waiting for the start` : null,
    progressTitle: showProgress ? `${progressDoneText(c.progress)} (sent, skipped, or won't be sent)` : null,
    dates: campaignDateParts(c, timeZone, now),
    pauseReason: c.status === "PAUSED" ? c.pauseReason : null,
  };
}
