import type { RecipientState, SendMode } from "@/generated/prisma/client";
import { db, dbTx, dbWrite, withWriteLock } from "@/server/db";
import { logActivity } from "@/server/activity";
import { describeJobError, enqueueJob } from "@/server/jobs";
import { notifyOwner } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import { loadSendGuard, mailgunSecrets, type MailgunContextResult } from "@/server/mailgun/context";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { finishCheck, FAILED_STOP_REASON } from "@/server/services/campaigns/control";
import { launchExclusionReason } from "@/server/services/campaigns/launch";
import { loadEligibilitySettings, recheckRecipient, type EligibilitySettings } from "@/server/services/eligibility";
import { excludeUnsent } from "@/server/services/mail-events/stops";
import { moveToRecheck } from "@/server/services/verification/settle";
import { renderCampaignEmail } from "@/server/services/render";
import { ensureReservation, expirePausedReservations, releaseCompanyIfDone } from "@/server/services/reservations";
import type { RenderedEmail } from "@/core/templates/types";
import { REPLY_NOTIFICATION } from "@/core/notification-types";
import { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { notOnTestListText, stopReasonFor, type EligibilityCode, type EligibilityReason } from "@/core/rules/eligibility";
import { UNKNOWN_RECHECK_AFTER_MS } from "@/core/verification/types";
import { countsAsEmailed, testListOnly } from "@/core/rules/mode";
import { stepTitle } from "@/core/rules/wording";
import { safeZone } from "@/core/sending/capday";
import { jitterFactor, paceGapMs } from "@/core/sending/pacing";
import { parseWindow, resolveZone } from "@/core/sending/window";
import { RECENT_REJECTS_MAX, parseOutageState, parsePacerState, parseSendingDayState } from "@/core/system-state-parse";
import { STATE_KEYS, type PacerState } from "@/core/system-state";
import { formatTime } from "@/core/time/format";
import {
  applyOutageHold,
  applyPendingPossibleReplyHolds,
  releaseOrphanedOutageHolds,
  type OutageHoldResult,
} from "@/server/services/sequences/holds";
import { cancelEmailsOfCancelledCampaigns, claimEmail, endedCampaignMessage, releaseClaim, resetStuckDryRunSends, type ReleaseResult } from "./claim";
import {
  WAITING_RECIPIENT_STATES,
  loadGateContext,
  outageHoldPending,
  pendingProblemIds,
  pickCandidates,
  planTick,
  saveWaiting,
  savePacer,
  startGatesClosed,
  type Candidate,
  type GateContext,
  type TickPlan,
} from "./gates";
import { isOwnMailboxBlock } from "./mailgun-transport";
import { markSent, sweepFollowUps, type SweepResult } from "./mark-sent";
import { pauseSending, getPauseState } from "./pause";
import {
  DryRunTransport,
  SENDABLE_MODES,
  isTransportError,
  makeTransportFactory,
  transportFor as defaultTransportFor,
  type EmailTransport,
  type OutgoingMessage,
  type TransportFailure,
} from "./transport";

export { MAX_SENDABLE_STEP, SEND_BATCH } from "./gates";

/**
 * The sending loop's work (PLAN.md B6.4, B6.6, B6.7, B8, M3-DESIGN §4.3.3, M4-DESIGN §2). The worker
 * (worker/sending.ts) calls sendingTick() every 5 seconds while it holds the lease, and
 * runSendingMaintenance() every 5 minutes. First emails and follow-ups (steps 1–3) go the same way;
 * a follow-up's row is created when the email before it is recorded as sent (markSent), due after
 * its delay in calendar days, in the same thread.
 *
 * A tick: global pause → nothing at all (dry runs included); scheduled campaigns whose start has
 * come begin; the due emails are picked and planned by the gates (./gates): dry runs with "Ignore
 * sending hours" go out as in Milestone 2 (25 per tick), and at most ONE gated email (TEST, LIVE,
 * or a dry run with the switch off) goes out, inside sending hours, under the limits and paced.
 * Emails of recipients on hold (HELD) or waiting for a new address check (RECHECK) are never picked.
 *
 * Per email: confirm the lease → claim it (committed before anything else) → its campaign has
 * ended → Cancelled; its recipient is finished, stopped or left out → Skipped; its recipient is on
 * hold (or not open yet) → back in the queue; a Mailgun email the gates didn't pick → back in the
 * queue → re-check the recipient on fresh data for the step being sent (not eligible any more → Skipped, the
 * recipient stops with the reason; before a first email an address-check or policy reason leaves them out instead,
 * and a first "no answer" puts them in RECHECK until the second check, M5-DESIGN §2.8) → make sure a campaign that
 * counts as "emailed" still holds the company →
 * render it → store the text → for Mailgun emails, the final check (pause, suppression, recipient,
 * test list, the "before every send" guard once more, still ours) → hand it to the transport →
 * record the outcome. A dry-run failure puts it back in the queue with the error, trying again after
 * 1, 5, 15 and 60 minutes; after 5 tries it becomes "Didn't send". A Mailgun outcome follows the
 * state machine of §4.3.5: Mailgun's id is saved before markSent, an unclear answer becomes
 * "Checking whether it was sent" for the reconciler, and nothing is ever sent twice.
 *
 * Every write that moves a recipient out of HELD also clears its hold fields (M4-DESIGN §2.8.1).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O33, O35): the final check also puts back a live follow-up whose inbox check
 * isn't done today after that person's last email, and the Owner hears once a day while live follow-ups wait for it
 * (notice "inbox-check"); an email the own-mailbox sender check blocks pauses sending once and goes back to the queue
 * uncounted, and blocked again straight after it fails for good instead of pausing again.
 */

export const MAX_SEND_ATTEMPTS = 5;
export const SEND_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** Back-off after uncertain Mailgun outcomes in a row: 5, 15, then 60 minutes. */
export const AMBIGUOUS_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** Back-off after a 404 on a send (the domain check decides whether to pause). */
export const NOT_FOUND_BACKOFF_MS = 5 * 60_000;
/** The rejection circuit breaker: this many refusals of different addresses within this time pause sending. */
export const REJECT_BREAKER_COUNT = 3;
export const REJECT_BREAKER_MS = 30 * 60_000;
/** The Owner hears about live emails waiting for a reply route after this long. */
export const ROUTE_WAIT_NOTICE_MS = 3_600_000;

export const MAILGUN_REFUSED_MESSAGE = "Mailgun refused this email.";
export const SENT_NOT_RECORDED_MESSAGE = "Sent, but not recorded yet. The app will record it within 10 minutes.";
export const CHECKING_SENT_MESSAGE = "Mailgun didn't answer in time; checking whether it was sent";

export function sendRetryDelayMs(attemptsMade: number): number {
  const i = Math.min(Math.max(attemptsMade, 1), SEND_RETRY_DELAYS_MS.length) - 1;
  return SEND_RETRY_DELAYS_MS[i]!;
}

export type RenderFn = (args: { recipientId: number; step: number; purpose: "send" }) => Promise<RenderedEmail>;

export type SendingLogger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, err?: unknown) => void;
};

export type SendingDeps = {
  now?: () => Date;
  transportFor?: (mode: SendMode) => EmailTransport;
  render?: RenderFn;
  /** Checked before every claim; nothing is claimed once it returns false. */
  ownsLease?: () => Promise<boolean>;
  /** Stops the tick between emails (shutdown, lease lost). Never aborts a Mailgun request in flight. */
  signal?: AbortSignal;
  /** Loaded once per tick when not given. */
  settings?: EligibilitySettings;
  logger?: SendingLogger;
  /**
   * When the worker started: Mailgun emails wait for a check with Mailgun after it (the catch-up gate). Read at every
   * use: the worker moves it forward after time it couldn't account for (the PC asleep, the lease lost).
   */
  startedAt?: Date | null;
  /** The pacing jitter's random source (tests fix it). */
  random?: () => number;
  /** The Mailgun context (tests inject one with fast retries). */
  mailgun?: () => Promise<MailgunContextResult>;
  /** Tests: the gates' context instead of loading it. */
  gateContext?: GateContext;
  /** The one gated email the gates picked this tick: a TEST/LIVE email is only sent when it is this one. */
  gatedEmailId?: number;
  /** Ids between claim and outcome (the reconciler leaves them alone). */
  inFlight?: Set<number>;
};

export type SendOutcome =
  | "sent"
  | "skipped"
  | "retry"
  | "failed"
  /** Someone else changed the email first (nothing done). */
  | "lost"
  /** The campaign was paused (put back) or has ended (cancelled) between picking and sending. */
  | "not-running"
  /** This worker no longer holds the lease (nothing claimed). */
  | "no-lease"
  /** Mailgun may have it: "Checking whether it was sent" (the reconciler settles it). */
  | "unknown"
  /** Put back in the queue without counting a try (Mailgun asked to wait, a pause, nothing left the PC). */
  | "held";

/** The outcome of one email with what the tick needs for the pacer. */
export type SendDetail = {
  outcome: SendOutcome;
  failure: TransportFailure | null;
  mode: SendMode | null;
  toNorm: string | null;
  /** The From line. */
  fromAddress: string | null;
};

const clock = (deps: SendingDeps) => (deps.now ? deps.now() : new Date());

function detail(outcome: SendOutcome, row?: Pick<ClaimedRow, "mode" | "toNorm" | "fromAddress"> | null, failure: TransportFailure | null = null): SendDetail {
  return { outcome, failure, mode: row?.mode ?? null, toNorm: row?.toNorm ?? null, fromAddress: row?.fromAddress ?? null };
}

/** Scheduled campaigns whose start has come become Running. Returns how many. */
export async function promoteScheduledCampaigns(now: Date = new Date()): Promise<number> {
  const res = await dbWrite((c) =>
    c.campaign.updateMany({
      where: { status: "SCHEDULED", OR: [{ startAt: null }, { startAt: { lte: now } }] },
      data: { status: "RUNNING" },
    }),
  );
  return res.count;
}

type ClaimedRow = NonNullable<Awaited<ReturnType<typeof loadClaimed>>>;

function loadClaimed(emailId: number) {
  return db.outboundEmail.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      campaignId: true,
      recipientId: true,
      personId: true,
      companyId: true,
      step: true,
      mode: true,
      status: true,
      attempts: true,
      claimedAt: true,
      toEmail: true,
      toNorm: true,
      fromAddress: true,
      // Shared-From mode (SHARED-FROM-DESIGN §2.3): sent as h:Reply-To; null in per-person mode.
      replyTo: true,
      messageId: true,
      inReplyTo: true,
      references: true,
      sendId: true,
      // MAIN-DOMAIN-DESIGN O35: the claim-time error (the final check clears it before the hand-over), so a second
      // own-mailbox sender block of the same row is recognised.
      lastError: true,
      // `launchedGoLive`: "emailed" and "test-list only" are judged by the campaign's launch flag (M6-DESIGN §2.2, §2.3).
      campaign: { select: { id: true, name: true, status: true, launchedGoLive: true } },
      recipient: { select: { companyId: true, state: true, stopReason: true } },
    },
  });
}

/** The claimed email may only reach the test list (M6-DESIGN §2.3): test mode for good, live of a campaign launched before go-live. */
function claimedTestListOnly(row: Pick<ClaimedRow, "mode" | "campaign">): boolean {
  return testListOnly(row.mode, row.campaign.launchedGoLive === true);
}

/** Recipients who get nothing more from their campaign. */
const CLOSED_RECIPIENT_STATES: ReadonlySet<RecipientState> = new Set(["FINISHED", "STOPPED", "EXCLUDED"]);
/**
 * Recipients whose email must wait, not go: on hold (a possible reply, an outage), waiting for a new address check, or
 * not launched yet (the gates never pick these). A claimed email of theirs, e.g. put on hold after it was picked, goes
 * back in the queue without counting a try (M4-DESIGN §2.10).
 */
const HOLDING_RECIPIENT_STATES: ReadonlySet<RecipientState> = new Set(WAITING_RECIPIENT_STATES);

/**
 * Why a claimed email of a finished, stopped or left-out recipient isn't sent (stored as its
 * lastError; the campaign page shows "Skipped: …"). A stop reason written as a sentence ("Skipped
 * by Sara") is used as it is; stored codes ("replied", "failed") get a plain sentence.
 */
export function closedRecipientMessage(state: RecipientState, stopReason: string | null): string {
  if (state === "EXCLUDED") return "This person was left out of the campaign";
  if (state === "FINISHED") return "All of this person's emails were already sent";
  const why = (stopReason ?? "").trim();
  return /\s/.test(why) ? why.replace(/\.$/, "") : "This person's emails were stopped";
}

/**
 * Claimed email whose campaign has ended (cancelled, or finished): Cancelled, with why. The
 * recipients were already stopped when the campaign was cancelled.
 */
async function cancelClaimed(row: ClaimedRow, message: string): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { status: "CANCELLED", claimedAt: null, lastError: message },
    }),
  );
  return res.count === 1;
}

/**
 * Claimed email of a recipient who gets nothing more (finished, stopped, left out), e.g. skipped
 * by hand while the email was claimed and then put back in the queue by a restart: Skipped, with
 * why. The recipient's own state stays as it is; the company is let go when nobody there is left.
 */
async function skipForClosedRecipient(
  row: ClaimedRow,
  now: Date,
  recipient: { state: RecipientState; stopReason: string | null } = row.recipient,
): Promise<boolean> {
  const message = closedRecipientMessage(recipient.state, recipient.stopReason);
  return dbTx(async (tx) => {
    const res = await tx.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { status: "SKIPPED", claimedAt: null, lastError: message },
    });
    if (res.count !== 1) return false;
    await tx.outboundEmail.updateMany({
      where: { campaignId: row.campaignId, recipientId: row.recipientId, status: "QUEUED" },
      data: { status: "SKIPPED", lastError: message },
    });
    await releaseCompanyIfDone(tx, row.campaignId, row.recipient.companyId, now);
    await logActivity(
      {
        actorId: null,
        type: "email.skipped",
        // "First email to anna@… skipped by Sara" / "… skipped: this person's emails were stopped"
        summary: /^skipped\b/i.test(message)
          ? `${stepTitle(row.step)} to ${row.toEmail} ${lowerFirst(message)}`
          : `${stepTitle(row.step)} to ${row.toEmail} skipped: ${lowerFirst(message)}`,
        companyId: row.companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { emailId: row.id, step: row.step, code: "recipient-closed", state: recipient.state },
        mode: row.mode,
      },
      tx,
    );
    return true;
  });
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Claimed email that may not be sent any more: Skipped, and the recipient stops with the reason. */
async function skipClaimed(row: ClaimedRow, reason: EligibilityReason, now: Date): Promise<boolean> {
  return dbTx(async (tx) => {
    const res = await tx.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { status: "SKIPPED", lastError: reason.text },
    });
    if (res.count !== 1) return false;
    await tx.outboundEmail.updateMany({
      where: { campaignId: row.campaignId, recipientId: row.recipientId, status: "QUEUED" },
      data: { status: "SKIPPED", lastError: reason.text },
    });
    await tx.campaignRecipient.updateMany({
      where: { id: row.recipientId, state: { notIn: ["FINISHED", "STOPPED", "EXCLUDED"] } },
      data: { state: "STOPPED", stopReason: stopReasonFor(reason), nextDueAt: null, holdReason: null, heldAt: null },
    });
    await releaseCompanyIfDone(tx, row.campaignId, row.recipient.companyId, now);
    await logActivity(
      {
        actorId: null,
        type: "email.skipped",
        summary: `${stepTitle(row.step)} to ${row.toEmail} skipped: ${reason.text}`,
        companyId: row.companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { emailId: row.id, step: row.step, code: reason.code },
        mode: row.mode,
      },
      tx,
    );
    return true;
  });
}

/**
 * The check and policy codes that leave a recipient out before their first email (M5-DESIGN §2.8 rule 6, D24): they
 * never got anything, so they are "Left out: …" (EXCLUDED), not stopped. `check-waiting` is here for dry runs (no
 * re-checks there) and for a recipient that already waited once.
 */
const FIRST_EMAIL_CHECK_CODES: ReadonlySet<EligibilityCode> = new Set<EligibilityCode>([
  "not-checked",
  "test-checker",
  "check-too-old",
  "check-waiting",
  "check-unknown",
  "check-undeliverable",
  "check-do-not-send",
  "policy-blocked",
]);

/**
 * A claimed first email whose recipient's address check says no (§2.8 rule 6): the row is Skipped with the reason and
 * the recipient left out through `excludeUnsent` (the one door, "Left out: address not checked"), its other waiting
 * rows cancelled and the company let go. Should the recipient have got an email after all (never at step 0), it is
 * stopped with the reason instead, as before.
 */
async function excludeClaimed(row: ClaimedRow, check: EligibilityReason, now: Date): Promise<boolean> {
  const reason = launchExclusionReason(check);
  return dbTx(async (tx) => {
    const res = await tx.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { status: "SKIPPED", lastError: reason.text },
    });
    if (res.count !== 1) return false;
    const left = await excludeUnsent(tx, { recipientIds: [row.recipientId], reason: reason.text, now });
    if (left === 0) {
      await tx.outboundEmail.updateMany({
        where: { campaignId: row.campaignId, recipientId: row.recipientId, status: "QUEUED" },
        data: { status: "SKIPPED", lastError: reason.text },
      });
      await tx.campaignRecipient.updateMany({
        where: { id: row.recipientId, state: { notIn: ["FINISHED", "STOPPED", "EXCLUDED"] } },
        data: { state: "STOPPED", stopReason: stopReasonFor(check), nextDueAt: null, holdReason: null, heldAt: null },
      });
      await releaseCompanyIfDone(tx, row.campaignId, row.recipient.companyId, now);
    }
    await logActivity(
      {
        actorId: null,
        type: "email.skipped",
        summary: `${stepTitle(row.step)} to ${row.toEmail} skipped: ${lowerFirst(reason.text)}`,
        companyId: row.companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { emailId: row.id, step: row.step, code: check.code, leftOut: left > 0 },
        mode: row.mode,
      },
      tx,
    );
    return true;
  });
}

/** Thrown inside `recheckClaimed`'s transaction to undo the move when the claim was no longer ours. */
class ClaimLost extends Error {}

/**
 * A claimed first email whose recipient's address got a first "no answer" since the launch (§2.8 rule 6): the
 * recipient moves to RECHECK (`moveToRecheck`, second check at max(now, checked + 24 h)) and the claim goes back to the
 * queue without counting a try; the gates skip it until the re-check releases the recipient. "not-moved" when the
 * recipient isn't a scheduled one waiting for the first time (it already waited once: it is left out instead).
 */
async function recheckClaimed(row: ClaimedRow, recheckAt: Date, now: Date): Promise<"held" | "lost" | "not-moved"> {
  try {
    return await dbTx(async (tx) => {
      if (!(await moveToRecheck(tx, { recipientId: row.recipientId, recheckAt, now }))) return "not-moved" as const;
      const res = await tx.outboundEmail.updateMany({
        where: { id: row.id, status: "SENDING" },
        data: { status: "QUEUED", claimedAt: null, attempts: { decrement: 1 } },
      });
      if (res.count !== 1) throw new ClaimLost();
      return "held" as const;
    });
  } catch (err) {
    if (err instanceof ClaimLost) return "lost";
    throw err;
  }
}

/**
 * What a first email does when the send-time check says no (§2.8 rules 5–6): a first "no answer" in test or live
 * waits for the re-check; every other check or policy code leaves the recipient out; anything else stops them (M3/M4).
 * Follow-ups (step ≥ 1) never see the check codes, only the policy and do-not-email ones, and are stopped as before.
 */
async function refuseClaimed(row: ClaimedRow, reason: EligibilityReason, verifiedAt: Date | null, now: Date): Promise<SendOutcome> {
  if (row.step === 0 && FIRST_EMAIL_CHECK_CODES.has(reason.code)) {
    if (reason.code === "check-waiting" && row.mode !== "DRY_RUN") {
      const due = verifiedAt ? verifiedAt.getTime() + UNKNOWN_RECHECK_AFTER_MS : now.getTime();
      const moved = await recheckClaimed(row, new Date(Math.max(now.getTime(), due)), now);
      if (moved === "held") return "held";
      if (moved === "lost") return "lost";
      // It waited for a re-check once already: a second "no answer" leaves it out.
      const couldnt: EligibilityReason = { ...reason, code: "check-unknown", text: reason.text };
      return (await excludeClaimed(row, couldnt, now)) ? "skipped" : "lost";
    }
    return (await excludeClaimed(row, reason, now)) ? "skipped" : "lost";
  }
  return (await skipClaimed(row, reason, now)) ? "skipped" : "lost";
}

/** The row became "Didn't send" for good: the recipient stops ("failed"), the company is let go, logged. */
async function failForGood(row: ClaimedRow, now: Date, lastError: string, summary: string, data: Record<string, string | number>): Promise<boolean> {
  return dbTx(async (tx) => {
    const res = await tx.outboundEmail.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "FAILED", lastError } });
    if (res.count !== 1) return false;
    await tx.campaignRecipient.updateMany({
      where: { id: row.recipientId, state: { notIn: ["FINISHED", "STOPPED", "EXCLUDED"] } },
      data: { state: "STOPPED", stopReason: FAILED_STOP_REASON, nextDueAt: null, holdReason: null, heldAt: null },
    });
    await releaseCompanyIfDone(tx, row.campaignId, row.recipient.companyId, now);
    await logActivity(
      {
        actorId: null,
        type: "email.failed",
        summary,
        companyId: row.companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { emailId: row.id, step: row.step, ...data },
        mode: row.mode,
      },
      tx,
    );
    return true;
  });
}

/**
 * A failed attempt: back to the queue with the error (and a growing wait), or "Didn't send" after
 * the last try. When the campaign ended meanwhile, the email is cancelled instead ("not-running").
 */
async function failAttempt(row: ClaimedRow, message: string, now: Date): Promise<"retry" | "failed" | "lost" | "not-running"> {
  if (row.attempts < MAX_SEND_ATTEMPTS) {
    const res = await releaseClaim(row.id, { error: message, dueAt: new Date(now.getTime() + sendRetryDelayMs(row.attempts)) });
    return res === "queued" ? "retry" : res === "cancelled" ? "not-running" : "lost";
  }
  const failed = await failForGood(
    row,
    now,
    message,
    `${stepTitle(row.step)} to ${row.toEmail} didn't send after ${MAX_SEND_ATTEMPTS} tries: ${message}`,
    {},
  );
  return failed ? "failed" : "lost";
}

function heldOutcome(res: ReleaseResult): SendOutcome {
  return res === "queued" ? "held" : res === "cancelled" ? "not-running" : "lost";
}

/** "14:05" in the cap-day zone (the Owner's own day). */
async function capZoneTime(at: Date): Promise<string> {
  const s = await getSettings(["sending.capDayTimeZone"] as const);
  return formatTime(at, safeZone(s["sending.capDayTimeZone"]));
}

/** Why a test-list-only email to an address off the test list is skipped (the eligibility rule's own sentence). */
function notOnTestList(row: Pick<ClaimedRow, "mode">): EligibilityReason {
  return { code: "not-on-test-list", text: notOnTestListText(row.mode), overridable: false };
}

/** Recipient states whose email may go: the only ones the final check lets through ("touched" requires one of them). */
const SENDABLE_RECIPIENT_STATES: readonly RecipientState[] = ["SCHEDULED", "WAITING"];

/**
 * The final check just before a Mailgun email is handed over (§4.3.3, M4-DESIGN §2.5.1), a few reads then one
 * compare-and-set: not paused; the address isn't on the do-not-email list and the person has no
 * unsubscribe/bounce/complaint; the recipient is still open and not on hold (a hold that landed after the pick puts
 * the email back); for a test-list-only email (test mode, or a live campaign launched before go-live, judged by its
 * launch flag: M6-DESIGN §2.3), the address is on the test list (read fresh); an outage found meanwhile (a
 * follow-up), or a new start or failed check with Mailgun meanwhile, puts it back (`startGatesClosed`); the "before
 * every send" guard once more for this one email (a reply the webhook stored after the pick, a possible reply decided
 * meanwhile, or a hold after the PC was off that covers it, puts it back without counting a try; in own-mailbox mode a
 * live follow-up whose inbox check isn't done today after the person's last email goes back too, MAIN-DOMAIN-DESIGN
 * O33); and the row is still ours and its person still open ("touched" with our claim). Returns an outcome when the
 * email must not go, or null when it may.
 *
 * All of it runs under this process's write lock (re-entrant, so the put-backs and skips inside still write): the worker
 * shares one database connection, and a read outside the lock would see another flow's open transaction, e.g. the
 * event lane's reply marked processed a moment before it stops the company. Holding the lock, no transaction of this
 * process is half-done while the checks read, so they see the reply either unprocessed (the guard holds the email) or
 * with its stop written (the person is stopped). A stop the web app commits between the reads and "touched" fails
 * "touched" (it requires the person to be open), and the email is skipped or put back.
 */
async function finalCheck(row: ClaimedRow, now: Date, deps: SendingDeps): Promise<SendOutcome | null> {
  return withWriteLock(() => finalCheckLocked(row, now, deps));
}

async function finalCheckLocked(row: ClaimedRow, now: Date, deps: SendingDeps): Promise<SendOutcome | null> {
  const [pause, suppression, person, recipient, guard, gateClosed] = await Promise.all([
    getPauseState(),
    db.suppression.findUnique({ where: { emailNorm: row.toNorm }, select: { reason: true } }),
    db.person.findUnique({ where: { emailNorm: row.toNorm }, select: { unsubscribedAt: true, bouncedAt: true, complainedAt: true } }),
    db.campaignRecipient.findUnique({ where: { id: row.recipientId }, select: { state: true, stopReason: true } }),
    loadSendGuard(),
    startGatesClosed(row, { now, startedAt: deps.startedAt }),
  ]);
  if (pause.paused) return (await releaseClaim(row.id, { countAttempt: false })) === "lost" ? "lost" : "not-running";

  let stop: EligibilityReason | null = null;
  if (person?.unsubscribedAt || suppression?.reason === "UNSUBSCRIBED") stop = { code: "unsubscribed", text: "Unsubscribed", overridable: false };
  else if (person?.bouncedAt || suppression?.reason === "BOUNCED") {
    stop = { code: "bounced", text: "An earlier email to this address bounced", overridable: false };
  } else if (person?.complainedAt || suppression?.reason === "COMPLAINED") {
    stop = { code: "complained", text: "Marked an earlier email as spam", overridable: false };
  } else if (suppression) stop = { code: "suppressed", text: "On the do-not-email list", overridable: false };
  if (stop) return (await skipClaimed(row, stop, now)) ? "skipped" : "lost";

  if (!recipient) return (await skipClaimed(row, { code: "person-removed", text: "This person is no longer in the campaign", overridable: false }, now)) ? "skipped" : "lost";
  if (CLOSED_RECIPIENT_STATES.has(recipient.state)) return (await skipForClosedRecipient(row, now, recipient)) ? "skipped" : "lost";
  if (HOLDING_RECIPIENT_STATES.has(recipient.state)) return heldOutcome(await releaseClaim(row.id, { countAttempt: false }));
  if (claimedTestListOnly(row) && !guard.testList.has(row.toNorm)) return (await skipClaimed(row, notOnTestList(row), now)) ? "skipped" : "lost";
  if (gateClosed) return heldOutcome(await releaseClaim(row.id, { countAttempt: false }));

  // §2.5.1: the guard again for this one email; a reply may have been stored since the pick. MAIN-DOMAIN-DESIGN O33: and
  // the inbox check, which may have been withdrawn or gone stale (a new cap day) since the pick.
  const problems = await pendingProblemIds(
    [
      {
        id: row.id,
        campaignId: row.campaignId,
        recipientId: row.recipientId,
        companyId: row.recipient.companyId,
        toNorm: row.toNorm.toLowerCase(),
        mode: row.mode,
        step: row.step,
      },
    ],
    now,
  );
  if (problems.pending.has(row.id) || problems.possibleReply.has(row.id) || problems.outage?.has(row.id) || problems.inboxCheck?.has(row.id)) {
    return heldOutcome(await releaseClaim(row.id, { countAttempt: false }));
  }

  const touched = await dbWrite((c) =>
    c.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING", claimedAt: row.claimedAt, recipient: { state: { in: [...SENDABLE_RECIPIENT_STATES] } } },
      data: { lastError: null },
    }),
  );
  if (touched.count === 1) return null;
  // Still ours, so its person was stopped or held meanwhile (by the web app): skip it or put it back.
  const again = await db.outboundEmail.findUnique({
    where: { id: row.id },
    select: { status: true, claimedAt: true, recipient: { select: { state: true, stopReason: true } } },
  });
  if (!again || again.status !== "SENDING" || again.claimedAt?.getTime() !== row.claimedAt?.getTime()) return "lost";
  if (CLOSED_RECIPIENT_STATES.has(again.recipient.state)) return (await skipForClosedRecipient(row, now, again.recipient)) ? "skipped" : "lost";
  return heldOutcome(await releaseClaim(row.id, { countAttempt: false }));
}

/** Notices at most once a day per key (§2.3). Never throws. */
async function notice(key: string, now: Date, input: { type: string; title: string; body: string; link: string }): Promise<void> {
  try {
    if (await shouldSendNotice(key, now)) await notifyOwner(input);
  } catch (err) {
    console.error(`[sending] couldn't send the notice ${key}`, err);
  }
}

/** What a Mailgun transport failure does to the claimed row (the table of §4.3.5). */
async function applyFailure(row: ClaimedRow, failure: TransportFailure, now: Date, logger?: SendingLogger): Promise<SendDetail> {
  switch (failure.kind) {
    case "rejected": {
      const ok = await failForGood(
        row,
        now,
        MAILGUN_REFUSED_MESSAGE,
        `${stepTitle(row.step)} to ${row.toEmail} didn't send: Mailgun refused it`,
        { mailgunMessage: failure.message.slice(0, 500) },
      );
      return detail(ok ? "failed" : "lost", row, failure);
    }
    case "rate-limited": {
      const time = await capZoneTime(failure.retryAt);
      const res = await releaseClaim(row.id, {
        countAttempt: false,
        dueAt: failure.retryAt,
        error: `Mailgun asked us to slow down; trying again at ${time}`,
      });
      return detail(heldOutcome(res), row, failure);
    }
    case "pause": {
      const res = await releaseClaim(row.id, { countAttempt: false });
      await pauseSending({
        kind: failure.pause,
        reason: failure.reason,
        fixText: failure.fixText,
        detail: failure.mailgunMessage ? { mailgunMessage: failure.mailgunMessage.slice(0, 500) } : null,
        now,
      });
      return detail(heldOutcome(res), row, failure);
    }
    case "not-found": {
      const time = await capZoneTime(new Date(now.getTime() + NOT_FOUND_BACKOFF_MS));
      const res = await releaseClaim(row.id, {
        countAttempt: false,
        error: `Mailgun couldn't find the sending domain for a moment; trying again at ${time}`,
      });
      try {
        await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: "mailgun:domain-check", priority: 20 });
      } catch (err) {
        logger?.error("Couldn't queue the domain check", err);
      }
      return detail(heldOutcome(res), row, failure);
    }
    case "ambiguous": {
      const res = await dbWrite((c) =>
        c.outboundEmail.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "UNKNOWN", lastError: CHECKING_SENT_MESSAGE } }),
      );
      logger?.warn(`Email #${row.id} (${row.toEmail}): Mailgun's answer was unclear (${failure.message}); the reconciler checks it`);
      return detail(res.count === 1 ? "unknown" : "lost", row, failure);
    }
    case "blocked": {
      if (failure.guard) return detail((await skipClaimed(row, notOnTestList(row), now)) ? "skipped" : "lost", row, failure);
      if (isOwnMailboxBlock(failure)) {
        // MAIN-DOMAIN-DESIGN O35: the own-mailbox sender check refused this row. The first time it goes back to the queue
        // uncounted with `senderBlocked` and sending pauses; blocked again straight after (its claim-time error still
        // says so) it can never go with its From line or Message-ID, so it fails for good instead of pausing again.
        if (row.lastError === OWN_MAILBOX_TEXTS.senderBlocked) {
          const ok = await failForGood(
            row,
            now,
            OWN_MAILBOX_TEXTS.senderBlockedTwice,
            `${stepTitle(row.step)} to ${row.toEmail} didn't send: it doesn't fit the From address any more`,
            { reason: "sender-blocked-twice" },
          );
          return detail(ok ? "failed" : "lost", row, failure);
        }
        const res = await releaseClaim(row.id, { countAttempt: false, error: OWN_MAILBOX_TEXTS.senderBlocked });
        if (failure.pause) await pauseSending({ ...failure.pause, now });
        return detail(heldOutcome(res), row, failure);
      }
      const res = await releaseClaim(row.id, { countAttempt: false });
      if (failure.pause) await pauseSending({ ...failure.pause, now });
      return detail(heldOutcome(res), row, failure);
    }
  }
}

/** Claims, checks, renders, sends and records one email. */
export async function sendOneEmail(emailId: number, deps: SendingDeps = {}): Promise<SendOutcome> {
  return (await sendOneEmailDetailed(emailId, deps)).outcome;
}

/** sendOneEmail with the details the tick needs for the pacer (the transport failure, the address). */
export async function sendOneEmailDetailed(emailId: number, deps: SendingDeps = {}): Promise<SendDetail> {
  if (deps.ownsLease && !(await deps.ownsLease())) return detail("no-lease");
  deps.inFlight?.add(emailId);
  try {
    if (!(await claimEmail(emailId, clock(deps)))) return detail("lost");
    return await processClaimed(emailId, deps);
  } finally {
    deps.inFlight?.delete(emailId);
  }
}

/** A claimed email that passed every check before the hand-over, ready for the transport. */
type Prepared = {
  row: ClaimedRow;
  settings: EligibilitySettings;
  message: OutgoingMessage;
  transport: EmailTransport;
  viaMailgun: boolean;
};

/**
 * Everything after the claim: the checks and preparation, then the hand-over. A problem while preparing (the
 * database busy for too long, a read that fails) can't have sent anything, because nothing has left the PC yet: the
 * email goes back to the queue as a failed try (after the last try, "Didn't send"), never "Checking whether it was
 * sent". Only a problem from the hand-over onwards can hide an accepted email.
 */
async function processClaimed(emailId: number, deps: SendingDeps): Promise<SendDetail> {
  let ready: Prepared | SendDetail;
  try {
    ready = await prepareClaimed(emailId, deps);
  } catch (err) {
    return notPrepared(emailId, err, deps);
  }
  if (!("message" in ready)) return ready;
  return handOver(ready, deps);
}

/** The preparation after the claim threw: nothing was sent, so the email goes back to the queue as a failed try. */
async function notPrepared(emailId: number, err: unknown, deps: SendingDeps): Promise<SendDetail> {
  const { error, detail: technical } = describeJobError(err, await mailgunSecrets().catch(() => []));
  deps.logger?.error(`Couldn't prepare email #${emailId}${technical ? `: ${technical}` : ""}; nothing was sent, it goes back in the queue`);
  const row = await loadClaimed(emailId);
  if (!row || row.status !== "SENDING") return detail("lost", row);
  return detail(await failAttempt(row, `Couldn't prepare this email: ${error}`, clock(deps)), row);
}

/** The checks and preparation between the claim and the hand-over (anything thrown here sent nothing). */
async function prepareClaimed(emailId: number, deps: SendingDeps): Promise<Prepared | SendDetail> {
  const logger = deps.logger;
  const row = await loadClaimed(emailId);
  if (!row || row.status !== "SENDING") return detail("lost", row);
  // A campaign that has ended never sends again, and nothing may bring the email back later.
  const ended = endedCampaignMessage(row.campaign.status);
  if (ended) return detail((await cancelClaimed(row, ended)) ? "not-running" : "lost", row);
  // Whatever put this email back in the queue (a restart, a failed try, a pause), a recipient who
  // was stopped, finished or left out meanwhile doesn't get it.
  if (CLOSED_RECIPIENT_STATES.has(row.recipient.state)) {
    return detail((await skipForClosedRecipient(row, clock(deps))) ? "skipped" : "lost", row);
  }
  // Put on hold (or not open) after it was picked: back in the queue, the hold's release lets it go (§2.10).
  if (HOLDING_RECIPIENT_STATES.has(row.recipient.state)) {
    return detail(heldOutcome(await releaseClaim(emailId, { countAttempt: false })), row);
  }
  const viaMailgun = row.mode === "TEST" || row.mode === "LIVE";
  // Mailgun emails only go out when the gates picked this one (sending hours, limits, pacing).
  if (row.campaign.status !== "RUNNING" || !SENDABLE_MODES.includes(row.mode) || (viaMailgun && deps.gatedEmailId !== row.id)) {
    const res = await releaseClaim(emailId, { countAttempt: false });
    return detail(res === "lost" ? "lost" : "not-running", row);
  }

  const settings = deps.settings ?? (await loadEligibilitySettings());
  // Judged for the step being sent (M5-DESIGN §2.8 rules 5–6): the first email measures check freshness at the launch.
  const check = await recheckRecipient(row.recipientId, { now: clock(deps), toNorm: row.toNorm, settings, step: row.step });
  if (!check.eligible) {
    const reason = check.reason ?? { code: "excluded-by-hand" as const, text: "Excluded by hand", overridable: false };
    return detail(await refuseClaimed(row, reason, check.verifiedAt, clock(deps)), row);
  }
  if (countsAsEmailed(row.mode, { practiceCopy: settings.practiceCopy, launchedGoLive: row.campaign.launchedGoLive })) {
    const held = await ensureReservation(row.campaignId, row.recipient.companyId, clock(deps));
    if (!held.ok) {
      const reason: EligibilityReason = { code: "reserved", text: held.holder.text, overridable: false };
      return detail((await skipClaimed(row, reason, clock(deps))) ? "skipped" : "lost", row);
    }
  }

  let rendered: RenderedEmail;
  try {
    rendered = await (deps.render ?? renderCampaignEmail)({ recipientId: row.recipientId, step: row.step, purpose: "send" });
  } catch (err) {
    const { error, detail: technical } = describeJobError(err);
    logger?.error(`Couldn't prepare email #${row.id} (${row.toEmail})${technical ? `: ${technical}` : ""}`);
    return detail(await failAttempt(row, `Couldn't prepare this email: ${error}`, clock(deps)), row);
  }

  const saved = await dbWrite((c) =>
    c.outboundEmail.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { subject: rendered.subject, text: rendered.text, html: rendered.html },
    }),
  );
  if (saved.count !== 1) return detail("lost", row);

  if (viaMailgun) {
    const stop = await finalCheck(row, clock(deps), deps);
    if (stop) return detail(stop, row);
  }

  const message: OutgoingMessage = {
    emailId: row.id,
    campaignId: row.campaignId,
    step: row.step,
    from: row.fromAddress,
    to: row.toEmail,
    toNorm: row.toNorm,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    references: row.references,
    sendId: row.sendId,
    // The launch snapshot's Reply-To (SHARED-FROM-DESIGN §2.3); the transport checks it fits the domain (§2.4).
    replyTo: row.replyTo,
    // The Mailgun client's guard judges it again from this flag (M6-DESIGN §2.3).
    testListOnly: claimedTestListOnly(row),
  };
  // A dry run is "accepted" at the loop's own clock (tests fix it; it decides the sent time and so the cap day).
  const transport = (deps.transportFor ?? ((mode: SendMode) => (mode === "DRY_RUN" ? new DryRunTransport(deps.now) : defaultTransportFor(mode))))(row.mode);
  return { row, settings, message, transport, viaMailgun };
}

/** Hands the prepared email to its transport and records the outcome (the state machine of §4.3.5). */
async function handOver(ready: Prepared, deps: SendingDeps): Promise<SendDetail> {
  const { row, settings, message, transport, viaMailgun } = ready;
  const logger = deps.logger;
  let accepted: { providerId: string; acceptedAt: Date };
  try {
    const res = await transport.send(message);
    accepted = { providerId: res.providerId, acceptedAt: res.acceptedAt ?? clock(deps) };
  } catch (err) {
    if (isTransportError(err)) return applyFailure(row, err.failure, clock(deps), logger);
    if (viaMailgun) {
      // Anything else after the hand-over started may hide an accepted email.
      const { detail: technical } = describeJobError(err, await mailgunSecrets().catch(() => []));
      return applyFailure(row, { kind: "ambiguous", message: technical ?? "Unexpected problem" }, clock(deps), logger);
    }
    // Dry run can't be ambiguous: nothing left the PC, so it simply goes back to the queue.
    const { error, detail: technical } = describeJobError(err);
    logger?.error(`Couldn't send email #${row.id} (${row.toEmail})${technical ? `: ${technical}` : ""}`);
    return detail(await failAttempt(row, `Couldn't send this email: ${error}`, clock(deps)), row);
  }

  if (viaMailgun) {
    // The proof first, in its own write: whatever happens next, this email is never sent again.
    await dbWrite((c) =>
      c.outboundEmail.updateMany({ where: { id: row.id, status: "SENDING" }, data: { providerId: accepted.providerId } }),
    );
    if (accepted.providerId !== row.messageId) {
      await notice("message-id-rewritten", clock(deps), {
        type: "system.mailgun",
        title: "Mailgun changes the app's message IDs",
        body: "Replies and follow-ups may not thread as planned. Tell us so we can check it.",
        link: "/settings/sending",
      });
    }
    try {
      await markSent(row.id, accepted.acceptedAt, { providerId: accepted.providerId, practiceCopy: settings.practiceCopy });
    } catch (err) {
      logger?.error(`Email #${row.id} was accepted by Mailgun but couldn't be recorded as sent; the reconciler finishes it`, err);
      await dbWrite((c) =>
        c.outboundEmail.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "UNKNOWN", lastError: SENT_NOT_RECORDED_MESSAGE } }),
      );
      await notice("sent-not-recorded", clock(deps), {
        type: "system.mailgun",
        title: "An email was sent but not recorded yet",
        body: "Mailgun accepted it, but the app couldn't save that. It is recorded automatically within 10 minutes and is never sent twice.",
        link: "/settings/sending",
      });
      return detail("unknown", row);
    }
    return detail("sent", row);
  }

  try {
    await markSent(row.id, accepted.acceptedAt, { providerId: accepted.providerId, practiceCopy: settings.practiceCopy });
  } catch (err) {
    // Left as "Sending": the start-up/maintenance reset puts a dry-run email back after 2 minutes.
    logger?.error(`Email #${row.id} was handed over but couldn't be recorded as sent`, err);
    return detail("lost", row);
  }
  return detail("sent", row);
}

// ───────────────────────── the tick ─────────────────────────

export type TickResult = {
  promoted: number;
  picked: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  lost: number;
  /** Mailgun may have them: the reconciler settles them. */
  unknown: number;
  /** Put back without counting a try (Mailgun asked to wait, a pause, nothing left the PC). */
  held: number;
  /** The tick stopped early (shutdown or lease lost). */
  stopped: boolean;
  /** Sending is paused (Pause all sending, or an automatic pause): nothing was claimed. */
  paused: boolean;
  /** Why gated emails wait right now (null when one went out or nothing waits). */
  waiting: TickPlan["waiting"];
  /** Campaigns that finished during this tick. */
  finished: number[];
};

function count(result: TickResult, outcome: SendOutcome): void {
  if (outcome === "sent") result.sent += 1;
  else if (outcome === "skipped") result.skipped += 1;
  else if (outcome === "retry") result.retried += 1;
  else if (outcome === "failed") result.failed += 1;
  else if (outcome === "unknown") result.unknown += 1;
  else if (outcome === "held") result.held += 1;
  else result.lost += 1;
}

/**
 * The pacer after the gated email's outcome (§4.3.3 step 6, §4.3.5). A sent email records when it went and draws
 * the random factor for the gap after it (per class); the gates recompute that gap every tick from what is due then.
 * `nextSendAt` is the time planned now, for display only.
 */
async function afterGatedSend(sent: SendDetail, next: Candidate, plan: TickPlan, ctx: GateContext, now: Date, deps: SendingDeps): Promise<void> {
  const viaMailgun = next.mode === "TEST" || next.mode === "LIVE";
  if (sent.outcome === "sent") {
    const cls = plan.nextCounted ? "counted" : "uncounted";
    const pace = plan.pace[cls];
    const jitter = jitterFactor(deps.random ?? Math.random);
    const gapMs =
      paceGapMs({
        openSecondsLeft: pace.openSecondsLeft,
        capacityLeft: plan.nextCounted ? ctx.today.left - 1 : Number.POSITIVE_INFINITY,
        dueCount: pace.dueCount - 1,
        minGapSeconds: ctx.minGapSeconds,
        jitter,
      }) ?? ctx.minGapSeconds * 1000;
    const at = now.toISOString();
    const update: Partial<PacerState> = {
      nextSendAt: new Date(now.getTime() + gapMs).toISOString(),
      lastSentAt: at,
      lastGapSeconds: Math.round(gapMs / 1000),
    };
    if (viaMailgun) Object.assign(update, { ambiguousStreak: 0, backoffUntil: null, backoffReason: null, recentRejects: [] });
    await updateTyped(STATE_KEYS.pacer, parsePacerState, (cur): PacerState => ({
      ...cur,
      ...update,
      lastByClass: { ...cur.lastByClass, [cls]: { at, jitter } },
    }));
    // Per-domain bookkeeping by the campaign's domain row, never by an address (SHARED-FROM-DESIGN F6): a shared From
    // line names the main domain, which has no SendingDomain row. The catch-up and the restore scan read it.
    if (next.mode === "LIVE" && next.sendingDomainId !== null) {
      const id = next.sendingDomainId;
      await dbWrite((c) => c.sendingDomain.updateMany({ where: { id }, data: { lastLiveSendAt: now } }));
    }
    return;
  }
  const failure = sent.failure;
  if (!failure || !viaMailgun) return;
  if (failure.kind === "rate-limited") {
    await savePacer(now, { backoffUntil: failure.retryAt.toISOString(), backoffReason: "rate-limited" });
  } else if (failure.kind === "not-found") {
    await savePacer(now, { backoffUntil: new Date(now.getTime() + NOT_FOUND_BACKOFF_MS).toISOString(), backoffReason: "mailgun-unreachable" });
  } else if (failure.kind === "ambiguous") {
    const res = await updateTyped(STATE_KEYS.pacer, parsePacerState, (cur): PacerState => {
      const streak = cur.ambiguousStreak + 1;
      const wait = AMBIGUOUS_BACKOFF_MS[Math.min(streak, AMBIGUOUS_BACKOFF_MS.length) - 1]!;
      return { ...cur, ambiguousStreak: streak, backoffUntil: new Date(now.getTime() + wait).toISOString(), backoffReason: "mailgun-unreachable" };
    });
    if (res.value.ambiguousStreak >= 3) {
      await notice("mailgun-unreachable", now, {
        type: "system.mailgun",
        title: "Mailgun isn't answering",
        body: "The app will keep trying and checks every email it wasn't sure about.",
        link: "/settings/sending",
      });
    }
  } else if (failure.kind === "rejected") {
    await rejectBreaker(now, sent.toNorm ?? next.toNorm, failure.message);
  }
}

/**
 * The rejection circuit breaker (§4.3.5): three refusals for three different addresses within 30
 * minutes pause sending, so an account-level refusal whose text we don't know fails at most 3 emails.
 */
async function rejectBreaker(now: Date, toNorm: string, message: string): Promise<void> {
  let trip = false;
  await updateTyped(STATE_KEYS.pacer, parsePacerState, (cur) => {
    const recentRejects = [...cur.recentRejects, { at: now.toISOString(), toNorm, message: message.slice(0, 300) }].slice(-RECENT_REJECTS_MAX);
    const recent = recentRejects.filter((r) => now.getTime() - Date.parse(r.at) <= REJECT_BREAKER_MS);
    trip = recent.length >= REJECT_BREAKER_COUNT && new Set(recent.map((r) => r.toNorm)).size >= REJECT_BREAKER_COUNT;
    return { ...cur, recentRejects: trip ? [] : recentRejects };
  });
  if (!trip) return;
  const said = message.trim().replace(/\.$/, "") || "no reason given";
  await pauseSending({
    kind: "mailgun-settings",
    reason: "Mailgun refused 3 emails in a row",
    fixText: `Mailgun refused the last 3 emails (${said}). Check the banner in Mailgun, then click Resume.`,
    detail: { mailgunMessage: message.slice(0, 500) },
    now,
  });
}

/** Today's limit reached: the Owner hears once per cap day (§4.3.3 step 7). */
async function notifyCapReached(ctx: GateContext, now: Date): Promise<void> {
  const res = await updateTyped(STATE_KEYS.sendingDay, parseSendingDayState, (cur) =>
    cur.capDay === ctx.today.capDay && cur.capReachedNotifiedAt ? null : { capDay: ctx.today.capDay, capReachedNotifiedAt: now.toISOString() },
  );
  if (!res.written) return;
  await notifyOwner({
    type: "sending.capReached",
    title: `Today's limit of ${ctx.today.cap.toLocaleString("en-US")} ${ctx.today.cap === 1 ? "email" : "emails"} is reached`,
    body: "The rest go out from the start of tomorrow's sending hours in each recipient's time zone. To send more today, change today's limit in Settings › Limits & warm-up.",
    link: "/settings/limits",
  });
}

/** Live emails have waited for a reply route for an hour: the Owner hears (notice "reply-route-down"). */
async function notifyRouteWait(held: Candidate, pacer: PacerState, now: Date): Promise<void> {
  const since = pacer.routeWaitSince ? Date.parse(pacer.routeWaitSince) : Number.NaN;
  if (!Number.isFinite(since) || now.getTime() - since < ROUTE_WAIT_NOTICE_MS) return;
  const sender = held.senderId ? await db.user.findUnique({ where: { id: held.senderId }, select: { name: true } }) : null;
  const name = sender?.name?.trim() || "the sender";
  await notice("reply-route-down", now, {
    type: "system.replyRoute",
    title: "Live emails are waiting: a reply route isn't working",
    body: `Replies to ${name} couldn't reach them, so their live emails wait. Click Apply recommended settings in Settings › Domain checklist.`,
    link: "/settings/domain",
  });
}

/**
 * Live emails wait for today's inbox check (own-mailbox mode, MAIN-DOMAIN-DESIGN O33; first emails too since review
 * SEND-1): the Owner hears at most once
 * per 24 hours (notice "inbox-check", type `reply.inboxCheck` in the Replies pop-up group), with a link to the card
 * that lists the companies. Needs the own From for its words (the context's, else the saved one); without one nothing
 * is said (the From address card and the launch say what is missing).
 */
async function notifyInboxCheckWait(ctx: GateContext, now: Date): Promise<void> {
  let from = ctx.mailgun.connected ? ctx.mailgun.ownFrom : null;
  if (!from) {
    const team = await loadTeamFrom();
    from = team.ownFrom ?? team.saved;
  }
  if (!from) return;
  await notice("inbox-check", now, {
    type: REPLY_NOTIFICATION.inboxCheck,
    title: INBOX_CHECK_TEXTS.notificationTitle,
    body: INBOX_CHECK_TEXTS.notificationBody(from),
    link: "/notifications#inbox-check",
  });
}

/** One round of the sending loop (§4.3.3). */
export async function sendingTick(deps: SendingDeps = {}): Promise<TickResult> {
  const result: TickResult = {
    promoted: 0,
    picked: 0,
    sent: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
    lost: 0,
    unknown: 0,
    held: 0,
    stopped: false,
    paused: false,
    waiting: null,
    finished: [],
  };
  if (deps.signal?.aborted) return { ...result, stopped: true };
  if (deps.ownsLease && !(await deps.ownsLease())) return { ...result, stopped: true };
  const now = clock(deps);

  // Pause all sending means everything, dry runs included.
  const pause = deps.gateContext?.pause ?? (await getPauseState());
  if (pause.paused) {
    result.paused = true;
    result.waiting = { reason: "paused", until: null };
    await saveWaiting(now, result.waiting, { routeHeld: false }).catch(() => undefined);
    return result;
  }

  result.promoted = await promoteScheduledCampaigns(now);
  const s = await getSettings(["sending.window", "defaultTimeZone", "practice.copy"] as const);
  const window = deps.gateContext?.window ?? parseWindow(s["sending.window"]);
  const defaultZone = deps.gateContext?.defaultZone ?? resolveZone(s["defaultTimeZone"], "Europe/Berlin");
  const practiceCopy = deps.gateContext?.practiceCopy ?? s["practice.copy"] === true;
  const { ungated, gated, due } = await pickCandidates(now, { window, defaultZone, practiceCopy });

  let ctx: GateContext | null = deps.gateContext ?? null;
  let plan: TickPlan;
  if (!ctx && gated.length === 0 && due.length === 0 && (!practiceCopy || ungated.length === 0)) {
    // Nothing gated is due anywhere (and, in the practice copy, no dry run that counts toward today's
    // limit): no need to load the gates' context.
    plan = {
      ungated,
      next: null,
      nextCounted: false,
      waiting: { reason: "nothing-due", until: null },
      capReached: false,
      pace: { counted: { dueCount: 0, openSecondsLeft: 0 }, uncounted: { dueCount: 0, openSecondsLeft: 0 } },
      routeHeld: null,
      inboxHeld: null,
    };
  } else {
    if (!ctx) {
      const problems = await pendingProblemIds(gated, now);
      ctx = await loadGateContext(now, {
        startedAt: deps.startedAt,
        mailgun: deps.mailgun,
        due,
        problems,
        needMailgun: gated.some((c) => c.mode === "TEST" || c.mode === "LIVE"),
      });
    }
    plan = planTick(ungated, gated, ctx);
  }
  result.picked = plan.ungated.length + (plan.next ? 1 : 0);
  result.waiting = plan.waiting;

  const touched = new Set<number>();
  if (result.picked > 0) {
    const settings = deps.settings ?? (await loadEligibilitySettings());
    for (const e of plan.ungated) {
      if (deps.signal?.aborted) {
        result.stopped = true;
        break;
      }
      const outcome = await sendOneEmail(e.id, { ...deps, settings, gatedEmailId: undefined });
      if (outcome === "no-lease") {
        result.stopped = true;
        break;
      }
      count(result, outcome);
      touched.add(e.campaignId);
    }
    if (plan.next && ctx && !result.stopped && !deps.signal?.aborted) {
      const next = plan.next;
      const factory =
        deps.transportFor ??
        makeTransportFactory(ctx.mailgun, { guard: await loadSendGuard(), practiceCopy: ctx.practiceCopy, now: deps.now });
      const sent = await sendOneEmailDetailed(next.id, { ...deps, settings, gatedEmailId: next.id, transportFor: factory });
      if (sent.outcome === "no-lease") result.stopped = true;
      else {
        count(result, sent.outcome);
        touched.add(next.campaignId);
        try {
          await afterGatedSend(sent, next, plan, ctx, now, deps);
        } catch (err) {
          deps.logger?.error("Couldn't update the pacer after a send", err);
        }
      }
    }
  }

  try {
    const pacer = await saveWaiting(now, result.waiting, { routeHeld: Boolean(plan.routeHeld) });
    if (plan.capReached && ctx) await notifyCapReached(ctx, now);
    if (plan.routeHeld) await notifyRouteWait(plan.routeHeld, pacer, now);
    if (plan.inboxHeld && ctx) await notifyInboxCheckWait(ctx, now);
  } catch (err) {
    deps.logger?.error("Couldn't record why emails are waiting", err);
  }

  for (const campaignId of touched) {
    if (await finishCheck(campaignId, { now })) result.finished.push(campaignId);
  }
  return result;
}

export type MaintenanceResult = {
  /** Dry-run emails stuck in "Sending" that went back to the queue. */
  reset: number;
  /** Emails still waiting in cancelled campaigns that were cancelled. */
  cancelled: number;
  sweep: SweepResult;
  /** Reservations released because their campaign was paused too long. */
  expiredReservations: number;
  /** The outage hold, when one was found and not applied yet (a retry of the catch-up's own call); null otherwise. */
  outageHold: OutageHoldResult | null;
  /** Recipients held for a possible reply nobody has decided (created or reopened after the message was processed). */
  possibleReplyHeld: number;
  /** Colleagues' first emails released because nobody emailed at their company is still held for an outage. */
  outageReleased: number;
  /** Campaigns that turned out to be finished. */
  finished: number[];
};

/** Where the maintenance reports a step that failed (it never throws for one). */
export type MaintenanceLogger = { error: (message: string, err?: unknown) => void };

const consoleMaintenanceLogger: MaintenanceLogger = { error: (m, err) => console.error(`[sending] ${m}`, err ?? "") };

/** Runs one maintenance step; a failure is logged and gives `fallback`, so the other steps still run. */
async function safely<T>(logger: MaintenanceLogger, what: string, fallback: T, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    logger.error(`Couldn't ${what}`, err);
    return fallback;
  }
}

/**
 * Every 5 minutes: stuck dry-run sends, emails left waiting in cancelled campaigns, the follow-up
 * sweeper, reservation expiry, then the holds (M4-DESIGN §2.8), then finish checks. Stuck Mailgun
 * sends are the reconciler's (never reset). The holds:
 *  - an outage found but not held yet: `applyOutageHold` again (the catch-up's own call may have
 *    failed; single-flight, so it never runs twice at once);
 *  - possible replies nobody has decided: recipients created or reopened since (a launch, a Retry,
 *    a race) are held too, so the campaign page says why they wait (`applyPendingPossibleReplyHolds`);
 *  - once no outage hold is pending: colleagues' first emails at companies where nobody emailed is
 *    still held for the outage go on (their sender's hold ended some other way, e.g. a bounce).
 * Each of these is logged and skipped when it fails; it never stops the rest.
 */
export async function runSendingMaintenance(now: Date = new Date(), opts: { logger?: MaintenanceLogger } = {}): Promise<MaintenanceResult> {
  const logger = opts.logger ?? consoleMaintenanceLogger;
  const reset = await resetStuckDryRunSends(now);
  const cancelled = await cancelEmailsOfCancelledCampaigns();
  const sweep = await sweepFollowUps(now);
  const expiry = await expirePausedReservations(now);
  const pendingOutage = async () => outageHoldPending((await readTyped(STATE_KEYS.outage, parseOutageState)).value);
  const outageHold = await safely(logger, "apply the hold after the PC was off", null, async () =>
    (await pendingOutage()) ? applyOutageHold({ now }) : null,
  );
  const possible = await safely(logger, "hold follow-ups for possible replies", { held: 0 }, () => applyPendingPossibleReplyHolds({ now }));
  const released = await safely(logger, "release first emails held after the PC was off", { released: 0 }, async () =>
    (await pendingOutage()) ? { released: 0 } : releaseOrphanedOutageHolds(),
  );
  const running = await db.campaign.findMany({ where: { status: "RUNNING" }, select: { id: true }, orderBy: { id: "asc" }, take: 200 });
  const finished: number[] = [];
  for (const c of running) if (await finishCheck(c.id, { now })) finished.push(c.id);
  return {
    reset,
    cancelled,
    sweep,
    expiredReservations: expiry.released,
    outageHold,
    possibleReplyHeld: possible.held,
    outageReleased: released.released,
    finished,
  };
}
