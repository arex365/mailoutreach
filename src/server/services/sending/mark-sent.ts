import type { CampaignStatus, CampaignStep, OutboundEmail, RecipientState, SendMode, SendStatus } from "@/generated/prisma/client";
import { db, dbTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { getSettings } from "@/server/settings";
import { lastContactAt } from "@/server/services/companies/filters";
import { releaseCompanyIfDone } from "@/server/services/reservations";
import { countsAsEmailed } from "@/core/rules/mode";
import { stepName, stepTitle } from "@/core/rules/wording";
import { followUpDueAt, threadHeaders, type FollowUpTiming } from "@/core/sending/follow-up";
import { DEFAULT_COMPANY_ZONE, parseWindow, resolveZone, type SendingWindow } from "@/core/sending/window";
import { messageIdDomainOf, newMessageId, newSendId } from "./addresses";

/**
 * markSent() (PLAN.md B6.1, B6.4, M4-DESIGN §2.1, §2.2, §2.8.1): the ONE function that records an email as sent, used by
 * the sending loop, the reconciler, the restore check and every proof of sending (a Mailgun event for the email, a
 * reply to it). In one short transaction it:
 *  - marks the row SENT (sentAt = when the provider accepted it, providerId: the one given, else the
 *    one already saved), whatever its status was (a proof of sending beats "Not sure"), or only from the statuses in
 *    `onlyFrom` when given (a reply proving an email arrived never touches a SENDING or FAILED row);
 *  - when the send counts as "emailed" (countsAsEmailed: live of a campaign launched after go-live, judged by its
 *    `launchedGoLive` and never by today's switch (M6-DESIGN §2.2), or a dry run in the practice copy; M3-DESIGN §1.7
 *    leaves out live sends to the test list before go-live): updates
 *    the company's and person's "last emailed" fields (only ever forwards in time) and
 *    Company.lastContactAt, sets "first contacted" if nobody has yet, and moves the company Not
 *    contacted → Contacted (both compare-and-set);
 *  - moves the recipient on from the highest step already sent to them (an earlier step proven sent late, e.g. by
 *    the restore check, never moves them back): WAITING for the next enabled step, whose email row is created here
 *    (due after its delay in calendar days in the recipient's time zone, moved into the next sending window when the
 *    campaign follows sending hours: `followUpDueAt`), in the same thread (`threadHeaders`: In-Reply-To is the email
 *    as the person received it, Mailgun's id when it rewrote ours); or FINISHED, releasing the company's reservation
 *    once all its recipients in the campaign are done. A recipient put on hold meanwhile stays on hold (its next row
 *    is still created); a finished one loses its hold fields;
 *  - logs "email.sent" with the campaign's mode.
 * Calling it again for a row that is already SENT changes nothing.
 */

export type MarkSentOptions = {
  /** Mailgun's (or the dry run's) id. Omitted: the id already saved on the row is kept. */
  providerId?: string | null;
  /** Setting "practice.copy" (read when not given). "Emailed" is otherwise judged by the campaign's launch flag. */
  practiceCopy?: boolean;
  /**
   * Only these statuses may become SENT (M4-DESIGN §3.7, D12: a reply proves an UNKNOWN, UNCONFIRMED or
   * reconciler-requeued QUEUED email arrived). The compare-and-set is then `status IN onlyFrom` instead of
   * `status ≠ SENT`, so a row the loop has claimed (SENDING) or that Mailgun refused (FAILED) is never touched: such a
   * row is left alone and the result says `alreadySent: false, counted: false, next: null`.
   */
  onlyFrom?: readonly SendStatus[];
};

export type MarkSentResult = {
  emailId: number;
  campaignId: number;
  alreadySent: boolean;
  /** The send counted as "emailed" (company/person fields were updated). */
  counted: boolean;
  /** The next step's email, when one was created (or already existed). */
  next: { emailId: number; step: number; dueAt: Date } | null;
  /** The recipient has no more steps. */
  finished: boolean;
};

type PrevRow = Pick<
  OutboundEmail,
  | "id"
  | "campaignId"
  | "recipientId"
  | "personId"
  | "companyId"
  | "senderId"
  | "step"
  | "mode"
  | "toEmail"
  | "toNorm"
  | "companyDomain"
  | "companyName"
  | "fromAddress"
  | "replyTo"
  | "messageId"
  | "providerId"
  | "references"
>;

const prevSelect = {
  id: true,
  campaignId: true,
  recipientId: true,
  personId: true,
  companyId: true,
  senderId: true,
  step: true,
  mode: true,
  toEmail: true,
  toNorm: true,
  companyDomain: true,
  companyName: true,
  fromAddress: true,
  // Shared-From mode (SHARED-FROM-DESIGN §2.3): a follow-up keeps its thread's Reply-To, so replies still reach the app.
  replyTo: true,
  messageId: true,
  providerId: true,
  references: true,
} as const;

/** The settings follow-up timing needs, read once outside the transaction (Settings "sending.window", "defaultTimeZone"). */
export type TimingSettings = { window: SendingWindow; defaultZone: string };

/** Reads the sending window and the default time zone. */
export async function loadTimingSettings(): Promise<TimingSettings> {
  const s = await getSettings(["sending.window", "defaultTimeZone"] as const);
  return { window: parseWindow(s["sending.window"]), defaultZone: resolveZone(s["defaultTimeZone"], DEFAULT_COMPANY_ZONE) };
}

/**
 * The timing of a recipient's next follow-up (M4-DESIGN §2.1), inside `tx`: the company's own time zone (the email's
 * company, else the recipient's; else the default zone), the sending window, whether the campaign follows sending
 * hours (gateClass: everything but a dry run with "Ignore sending hours" on), "treat days as minutes" and the mode.
 */
export async function followUpTimingFor(
  tx: Tx,
  input: {
    companyId: number | null;
    mode: SendMode;
    campaign: { ignoreWindow: boolean; daysAsMinutes: boolean };
    settings: TimingSettings;
  },
): Promise<FollowUpTiming> {
  const company = input.companyId !== null ? await tx.company.findUnique({ where: { id: input.companyId }, select: { timeZone: true } }) : null;
  return {
    zone: resolveZone(company?.timeZone, input.settings.defaultZone),
    window: input.settings.window,
    gated: !(input.mode === "DRY_RUN" && input.campaign.ignoreWindow),
    daysAsMinutes: input.campaign.daysAsMinutes,
    mode: input.mode,
  };
}

/** The first enabled campaign step after `step`, or null. */
export async function nextEnabledStep(tx: Tx, campaignId: number, step: number): Promise<CampaignStep | null> {
  return tx.campaignStep.findFirst({
    where: { campaignId, enabled: true, step: { gt: step } },
    orderBy: { step: "asc" },
  });
}

/**
 * Creates the email row for the next step in the same thread (subject/text/html stay empty until
 * the sending loop renders it), due `followUpDueAt(sentAt, delay, timing)` (M4-DESIGN §2.1) and threaded by
 * `threadHeaders(prev)` (§2.2: In-Reply-To = the previous email as the person received it, References = the chain).
 * The From line and the Reply-To are the previous email's (SHARED-FROM-DESIGN §2.3), and so is the Message-ID domain.
 * Returns the existing row if there already is one.
 */
export async function createNextStepRow(
  tx: Tx,
  prev: PrevRow,
  next: Pick<CampaignStep, "step" | "delayDays">,
  opts: { sentAt: Date; timing: FollowUpTiming },
): Promise<{ id: number; step: number; dueAt: Date }> {
  const existing = await tx.outboundEmail.findFirst({
    where: { campaignId: prev.campaignId, step: next.step, toNorm: prev.toNorm },
    select: { id: true, step: true, dueAt: true },
  });
  if (existing) return existing;
  const dueAt = followUpDueAt(opts.sentAt, next.delayDays, opts.timing);
  const thread = threadHeaders(prev);
  return tx.outboundEmail.create({
    data: {
      campaignId: prev.campaignId,
      recipientId: prev.recipientId,
      personId: prev.personId,
      companyId: prev.companyId,
      senderId: prev.senderId,
      step: next.step,
      mode: prev.mode,
      toEmail: prev.toEmail,
      toNorm: prev.toNorm,
      companyDomain: prev.companyDomain,
      companyName: prev.companyName,
      fromAddress: prev.fromAddress,
      replyTo: prev.replyTo,
      subject: "",
      text: "",
      html: "",
      messageId: newMessageId(messageIdDomainOf(prev.messageId)),
      sendId: newSendId(),
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      dueAt,
      status: "QUEUED",
    },
    select: { id: true, step: true, dueAt: true },
  });
}

const TERMINAL_RECIPIENT_STATES = new Set(["FINISHED", "STOPPED", "EXCLUDED"]);

/** Company and person fields for a real send (inside markSent's transaction). */
async function recordRealContact(tx: Tx, row: PrevRow, campaign: { id: number; name: string }, sentAt: Date): Promise<void> {
  const senderId = row.senderId;
  if (row.companyId !== null) {
    const company = await tx.company.findUnique({
      where: { id: row.companyId },
      select: { id: true, lastEmailedAt: true, importedLastContactAt: true },
    });
    if (company) {
      if (!company.lastEmailedAt || company.lastEmailedAt.getTime() <= sentAt.getTime()) {
        await tx.company.update({
          where: { id: company.id },
          data: {
            lastEmailedAt: sentAt,
            lastEmailedById: senderId,
            lastEmailedCampaignId: campaign.id,
            lastEmailedStep: row.step,
            lastContactAt: lastContactAt(sentAt, company.importedLastContactAt),
          },
        });
      }
      if (senderId !== null) {
        await tx.company.updateMany({
          where: { id: company.id, firstContactedById: null },
          data: { firstContactedById: senderId, firstContactedAt: sentAt },
        });
      }
      const status = await tx.company.updateMany({
        where: { id: company.id, status: "NOT_CONTACTED" },
        data: { status: "CONTACTED" },
      });
      if (status.count === 1) {
        await logActivity(
          {
            actorId: null,
            type: "company.status",
            summary: `Status changed to Contacted: the ${stepName(row.step)} went to ${row.toEmail}`,
            companyId: company.id,
            personId: row.personId,
            campaignId: campaign.id,
            data: { field: "status", from: "NOT_CONTACTED", to: "CONTACTED", automatic: true },
            mode: row.mode,
          },
          tx,
        );
      }
    }
  }
  if (row.personId !== null) {
    const person = await tx.person.findUnique({ where: { id: row.personId }, select: { id: true, lastEmailedAt: true } });
    if (person && (!person.lastEmailedAt || person.lastEmailedAt.getTime() <= sentAt.getTime())) {
      await tx.person.update({
        where: { id: person.id },
        data: { lastEmailedAt: sentAt, lastEmailedById: senderId, lastEmailedCampaignId: campaign.id, lastEmailedStep: row.step },
      });
    }
  }
}

/**
 * Moves a recipient on after one of its emails was sent, from the highest step already sent to them (M4-DESIGN §2.11:
 * a step-0 email proven sent after step 1, e.g. by the restore check, never moves them back or creates step 1 again):
 * the next enabled step (its row created, threaded to that highest sent email) or FINISHED. A HELD recipient (put on
 * hold while this email was on its way) stays HELD: only its current step and due time move on (§2.8.1); a finished
 * one loses its hold fields. Stopped, finished and excluded recipients, and recipients of cancelled campaigns, are
 * left alone.
 */
async function advanceRecipient(
  tx: Tx,
  row: PrevRow,
  campaign: { status: string; daysAsMinutes: boolean; ignoreWindow: boolean },
  sentAt: Date,
  settings: TimingSettings,
): Promise<{ next: MarkSentResult["next"]; finished: boolean }> {
  const recipient = await tx.campaignRecipient.findUnique({
    where: { id: row.recipientId },
    select: { id: true, state: true, companyId: true },
  });
  if (!recipient || TERMINAL_RECIPIENT_STATES.has(recipient.state) || campaign.status === "CANCELLED") {
    return { next: null, finished: false };
  }
  // The highest step sent to this person in this campaign (this email is SENT already, inside this transaction).
  const highest = await tx.outboundEmail.findFirst({
    where: { campaignId: row.campaignId, recipientId: row.recipientId, status: "SENT" },
    orderBy: [{ step: "desc" }, { id: "desc" }],
    select: { ...prevSelect, sentAt: true },
  });
  const last = highest && highest.step >= row.step ? highest : { ...row, sentAt };
  const nextStep = await nextEnabledStep(tx, row.campaignId, last.step);
  if (nextStep) {
    const timing = await followUpTimingFor(tx, { companyId: last.companyId ?? recipient.companyId, mode: last.mode, campaign, settings });
    const created = await createNextStepRow(tx, last, nextStep, { sentAt: last.sentAt ?? sentAt, timing });
    const move = { currentStep: nextStep.step, nextDueAt: created.dueAt };
    await tx.campaignRecipient.update({
      where: { id: recipient.id },
      data: recipient.state === "HELD" ? move : { ...move, state: "WAITING", stopReason: null },
    });
    return { next: { emailId: created.id, step: created.step, dueAt: created.dueAt }, finished: false };
  }
  await tx.campaignRecipient.update({
    where: { id: recipient.id },
    data: { state: "FINISHED", currentStep: last.step, nextDueAt: null, holdReason: null, heldAt: null },
  });
  await releaseCompanyIfDone(tx, row.campaignId, recipient.companyId, sentAt);
  return { next: null, finished: true };
}

export async function markSent(emailId: number, acceptedAt: Date, opts: MarkSentOptions = {}): Promise<MarkSentResult> {
  const s = await getSettings(["practice.copy", "sending.window", "defaultTimeZone"] as const);
  const practiceCopy = opts.practiceCopy ?? s["practice.copy"] === true;
  const timingSettings: TimingSettings = {
    window: parseWindow(s["sending.window"]),
    defaultZone: resolveZone(s["defaultTimeZone"], DEFAULT_COMPANY_ZONE),
  };
  return dbTx(async (tx) => {
    const row = await tx.outboundEmail.findUnique({ where: { id: emailId }, select: { ...prevSelect, status: true, providerId: true } });
    if (!row) throw new Error(`Email #${emailId} doesn't exist.`);
    const base = { emailId, campaignId: row.campaignId, next: null, finished: false };
    if (row.status === "SENT") return { ...base, alreadySent: true, counted: false };
    const onlyFrom = opts.onlyFrom ? opts.onlyFrom.filter((s) => s !== "SENT") : null;
    if (onlyFrom && !onlyFrom.includes(row.status)) return { ...base, alreadySent: false, counted: false };
    const providerId = opts.providerId !== undefined ? opts.providerId : row.providerId;
    const updated = await tx.outboundEmail.updateMany({
      where: { id: emailId, status: onlyFrom ? { in: [...onlyFrom] } : { not: "SENT" } },
      data: { status: "SENT", sentAt: acceptedAt, providerId: providerId ?? null, lastError: null },
    });
    if (updated.count !== 1) return { ...base, alreadySent: true, counted: false };

    const campaign = await tx.campaign.findUnique({
      where: { id: row.campaignId },
      select: { id: true, name: true, status: true, daysAsMinutes: true, ignoreWindow: true, launchedGoLive: true },
    });
    if (!campaign) throw new Error(`Campaign #${row.campaignId} doesn't exist.`);

    // Judged by the campaign's launch flag (M6-DESIGN §2.2): a test campaign still running after go-live stays "not emailed".
    const counted = countsAsEmailed(row.mode, { practiceCopy, launchedGoLive: campaign.launchedGoLive });
    if (counted) await recordRealContact(tx, row, campaign, acceptedAt);
    // Threading uses the id Mailgun gave this send (its own when it rewrote ours, M4-DESIGN §2.2).
    const { next, finished } = await advanceRecipient(tx, { ...row, providerId: providerId ?? null }, campaign, acceptedAt, timingSettings);

    await logActivity(
      {
        actorId: row.senderId,
        type: "email.sent",
        summary: `${stepTitle(row.step)} sent to ${row.toEmail} (${campaign.name})`,
        companyId: row.companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { emailId: row.id, step: row.step, messageId: row.messageId },
        mode: row.mode,
      },
      tx,
    );
    return { ...base, alreadySent: false, counted, next, finished };
  });
}

// ───────────────────────── follow-up sweeper ─────────────────────────

export type SweepResult = { checked: number; created: number; finished: number };

const SWEEP_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["SCHEDULED", "RUNNING", "PAUSED"];
const SWEEP_RECIPIENT_STATES: readonly RecipientState[] = ["SCHEDULED", "WAITING"];
/** Emails still on their way, or that may have gone: their recipient isn't stuck. */
const IN_FLIGHT: ReadonlySet<SendStatus> = new Set<SendStatus>(["QUEUED", "SENDING", "UNKNOWN", "UNCONFIRMED"]);
const IN_CHUNK = 400;

/** Lets the worker's other loops (heartbeat, tasks) run between two pieces of work. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The recipients of one campaign that the sweeper should look at (ids, ascending): included,
 * scheduled or waiting, whose last email (by step) was sent, with nothing waiting, being sent or
 * of unknown outcome, and no later email. Reads the campaign's emails through its campaignId index
 * (never a per-recipient search over the whole table) and works out the rest in memory.
 */
export async function findStuckRecipients(campaignId: number): Promise<number[]> {
  const rows = await db.outboundEmail.findMany({
    where: { campaignId },
    select: { recipientId: true, step: true, status: true },
  });
  const byRecipient = new Map<number, { lastStep: number; lastSentStep: number; inFlight: boolean }>();
  for (const r of rows) {
    let s = byRecipient.get(r.recipientId);
    if (!s) {
      s = { lastStep: -1, lastSentStep: -1, inFlight: false };
      byRecipient.set(r.recipientId, s);
    }
    if (r.step > s.lastStep) s.lastStep = r.step;
    if (r.status === "SENT" && r.step > s.lastSentStep) s.lastSentStep = r.step;
    if (IN_FLIGHT.has(r.status)) s.inFlight = true;
  }
  // A later email that exists but won't be sent (skipped, cancelled, failed) is not ours to repair.
  const possible = [...byRecipient]
    .filter(([, s]) => !s.inFlight && s.lastSentStep >= 0 && s.lastStep === s.lastSentStep)
    .map(([id]) => id)
    .sort((a, b) => a - b);
  if (possible.length === 0) return [];
  const open = new Set<number>();
  for (let i = 0; i < possible.length; i += IN_CHUNK) {
    const recipients = await db.campaignRecipient.findMany({
      where: { id: { in: possible.slice(i, i + IN_CHUNK) }, campaignId, included: true, state: { in: [...SWEEP_RECIPIENT_STATES] } },
      select: { id: true },
    });
    for (const r of recipients) open.add(r.id);
  }
  return possible.filter((id) => open.has(id));
}

/**
 * One stuck recipient, in one short transaction: creates its next email (with the same timing and threading as
 * markSent, from the last sent email's time), or finishes it. Held recipients are never repaired while held.
 */
async function repairRecipient(campaignId: number, recipientId: number, now: Date, settings: TimingSettings): Promise<"created" | "finished" | "none"> {
  return dbTx(async (tx) => {
    const recipient = await tx.campaignRecipient.findFirst({
      where: { id: recipientId, campaignId },
      select: {
        id: true,
        state: true,
        included: true,
        companyId: true,
        campaign: { select: { id: true, status: true, daysAsMinutes: true, ignoreWindow: true } },
      },
    });
    if (!recipient || !recipient.included || !SWEEP_RECIPIENT_STATES.includes(recipient.state)) return "none";
    if (!SWEEP_CAMPAIGN_STATUSES.includes(recipient.campaign.status)) return "none";
    const rows = await tx.outboundEmail.findMany({
      where: { campaignId, recipientId },
      orderBy: { step: "desc" },
      select: { ...prevSelect, status: true, sentAt: true },
    });
    if (rows.some((r) => IN_FLIGHT.has(r.status))) return "none";
    const lastSent = rows.find((r) => r.status === "SENT");
    if (!lastSent) return "none";
    // A later row that exists but won't be sent (skipped, cancelled, failed) is not ours to repair.
    if (rows.some((r) => r.step > lastSent.step)) return "none";
    const nextStep = await nextEnabledStep(tx, campaignId, lastSent.step);
    const sentAt = lastSent.sentAt ?? now;
    if (nextStep) {
      const timing = await followUpTimingFor(tx, {
        companyId: lastSent.companyId ?? recipient.companyId,
        mode: lastSent.mode,
        campaign: recipient.campaign,
        settings,
      });
      const created = await createNextStepRow(tx, lastSent, nextStep, { sentAt, timing });
      await tx.campaignRecipient.update({
        where: { id: recipientId },
        data: { state: "WAITING", currentStep: nextStep.step, nextDueAt: created.dueAt },
      });
      return "created";
    }
    await tx.campaignRecipient.update({
      where: { id: recipientId },
      data: { state: "FINISHED", currentStep: lastSent.step, nextDueAt: null, holdReason: null, heldAt: null },
    });
    await releaseCompanyIfDone(tx, campaignId, recipient.companyId, now);
    return "finished";
  });
}

/**
 * B6.4 sweeper (every 5 minutes): repairs recipients whose last email went out but who have no
 * email waiting for the next step (e.g. a step was switched on later, or an older version stopped
 * half-way). Creates the missing row, or finishes the recipient when there are no more steps.
 * Works campaign by campaign (scheduled, running and paused ones), repairs at most `limit`
 * recipients per run, and lets the worker's other loops run between campaigns.
 */
export async function sweepFollowUps(now: Date = new Date(), limit = 200): Promise<SweepResult> {
  const campaigns = await db.campaign.findMany({
    where: { status: { in: [...SWEEP_CAMPAIGN_STATUSES] } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const result: SweepResult = { checked: 0, created: 0, finished: 0 };
  let settings: TimingSettings | null = null;
  for (const { id: campaignId } of campaigns) {
    if (result.checked >= limit) break;
    const candidates = (await findStuckRecipients(campaignId)).slice(0, limit - result.checked);
    result.checked += candidates.length;
    if (candidates.length > 0) settings ??= await loadTimingSettings();
    for (const recipientId of candidates) {
      const outcome = await repairRecipient(campaignId, recipientId, now, settings!);
      if (outcome === "created") result.created += 1;
      else if (outcome === "finished") result.finished += 1;
    }
    await yieldToEventLoop();
  }
  return result;
}
