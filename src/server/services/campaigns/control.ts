import type { CampaignStatus, RecipientState, SendMode } from "@/generated/prisma/client";
import { db, dbTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { createNotification } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import {
  clearReservationExpiry,
  pausedExpiryFrom,
  releaseCampaignReservations,
  releaseCompanyIfDone,
  setReservationExpiry,
  takeReservations,
} from "@/server/services/reservations";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { countsAsEmailed } from "@/core/rules/mode";
import { domainOfAddress, messageIdDomainOf, senderHeaderProblem } from "@/core/sending/from-address";
import { ownMailboxRuleFrom } from "@/core/sending/own-mailbox";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { stepName } from "@/core/rules/wording";
import { firstSubjectProblem } from "@/core/templates/subject-rules";
import { plural } from "@/core/text";
import { applyPendingPossibleReplyHolds } from "@/server/services/sequences/holds";
import { inboxCheckHeldIds, outageHeldIds, type GuardCandidate } from "@/server/services/sending/gates";
import { CAMPAIGN_GONE, CampaignError, EMAIL_GONE, RECIPIENT_GONE, SENDING_NOW } from "./errors";
import { isLaunching, LAUNCHING_TEXT } from "./launch";

/**
 * Campaign controls (PLAN.md A6 campaign page, B6.7): pause, resume, cancel, skip a recipient,
 * retry an email, edit an email that hasn't been sent, and the "is it finished?" check.
 *
 * Every function takes the acting user's id, runs in short transactions, logs activity with that
 * person, and throws CampaignError (plain words) for anything the person can fix. Changes to a
 * single email use `updateMany where status = QUEUED`: when the worker has already claimed it,
 * nothing changes and the person is told "This email is being sent right now".
 *
 * Holds (M4-DESIGN §2.8.1): cancelling, skipping and retrying move recipients out of HELD, and always clear the hold
 * fields with it. A Retry of a company with a possible reply nobody has decided puts the reopened person on hold.
 *
 * Emails whose outcome isn't known (M3-DESIGN §4.3.5, §9.2 item 8): "Checking whether it was sent"
 * (UNKNOWN) can't be skipped or retried while the app checks with Mailgun; "Not sure it was sent"
 * (UNCONFIRMED) keeps the campaign running until someone chooses Retry (for live campaigns only
 * after confirming the duplicate risk) or Skip. An email Mailgun already has is never retried.
 */

/** Recipient states that still have emails to come. */
export const OPEN_RECIPIENT_STATES: readonly RecipientState[] = ["PENDING", "SCHEDULED", "WAITING", "HELD", "RECHECK"];
/** Stored as stopReason when an email failed for good (the company panel words it "the email couldn't be sent"). */
export const FAILED_STOP_REASON = "failed";

const CHANGED = "This campaign changed while you were doing this. Refresh the page and try again.";

export type ControlResult = { message: string };

async function actorName(actorId: number | null): Promise<string> {
  if (!actorId) return "Someone";
  const u = await db.user.findUnique({ where: { id: actorId }, select: { name: true } });
  return u?.name?.trim() || "Someone";
}

/** "Anna Berg" / the address for a General inbox or an unnamed person. */
export function recipientLabel(person: { name: string | null; email: string | null }, fallbackEmail?: string | null): string {
  const name = (person.name ?? "").trim();
  if (name && name !== GENERAL_INBOX_NAME) return name;
  return person.email || fallbackEmail || "this person";
}

function endedText(status: CampaignStatus): string {
  if (status === "FINISHED") return "This campaign has already finished.";
  if (status === "CANCELLED") return "This campaign was cancelled.";
  if (status === "DRAFT") return "This campaign hasn't been launched yet.";
  return CHANGED;
}

/**
 * Setting "practice.copy": with each campaign's own launch flag, what counts as "emailed" (countsAsEmailed, M3-DESIGN
 * §1.7, M6-DESIGN §2.2). Today's go-live never decides it.
 */
async function practiceCopyNow(): Promise<boolean> {
  const s = await getSettings(["practice.copy"] as const);
  return s["practice.copy"] === true;
}

// ───────────────────────── finish check ─────────────────────────

function finishedBody(mode: SendMode | null, sent: number, skipped: number, failed: number): string {
  let main: string;
  if (mode === "LIVE") main = sent === 1 ? "1 email was sent." : `${plural(sent, "email", "emails")} were sent.`;
  else if (mode === "TEST") main = sent === 1 ? "1 email was sent in test mode." : `${plural(sent, "email", "emails")} were sent in test mode.`;
  else main = sent === 1 ? "1 email went to the dry-run outbox." : `${plural(sent, "email", "emails")} went to the dry-run outbox.`;
  const extra: string[] = [];
  if (skipped > 0) extra.push(`${plural(skipped, "email was", "emails were")} skipped`);
  if (failed > 0) extra.push(`${plural(failed, "email", "emails")} didn't send`);
  return extra.length ? `${main} ${extra.join(" and ").replace(/^./, (c) => c.toUpperCase())}.` : main;
}

/**
 * Finishes a running campaign when nothing is left to send: no email waiting, being sent or of
 * unknown outcome (checking with Mailgun, or waiting for someone to choose Retry or Skip), and no
 * recipient still waiting. Releases its reservations, logs "campaign.finished" and notifies the
 * sender and the creator ("Germany Q4 finished" / "120 emails went to the dry-run outbox.").
 * Returns true when it finished the campaign now.
 *
 * Never throws: it always runs after the change that may have finished the campaign was saved (a
 * status change, a skip, a reply, a send), so a failure here (e.g. the database busy for too long)
 * must never turn that saved change into "nothing was saved". It is logged and answers false; the
 * sending loop's 5-minute maintenance runs the check again for every running campaign.
 */
export async function finishCheck(campaignId: number, opts: { now?: Date } = {}): Promise<boolean> {
  try {
    return await runFinishCheck(campaignId, opts.now ?? new Date());
  } catch (err) {
    console.error(`[campaigns] the finish check of campaign #${campaignId} failed; the sending maintenance tries again within 5 minutes`, err);
    return false;
  }
}

async function runFinishCheck(campaignId: number, now: Date): Promise<boolean> {
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, name: true, status: true, mode: true, senderId: true, createdById: true },
    });
    if (!c || c.status !== "RUNNING") return false;
    const openEmails = await tx.outboundEmail.count({
      where: { campaignId, status: { in: ["QUEUED", "SENDING", "UNKNOWN", "UNCONFIRMED"] } },
    });
    if (openEmails > 0) return false;
    const openRecipients = await tx.campaignRecipient.count({
      where: { campaignId, included: true, state: { in: ["SCHEDULED", "WAITING", "HELD", "RECHECK"] } },
    });
    if (openRecipients > 0) return false;
    const res = await tx.campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "FINISHED", finishedAt: now } });
    if (res.count !== 1) return false;

    const grouped = await tx.outboundEmail.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } });
    const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const sent = count("SENT");
    const skipped = count("SKIPPED");
    const failed = count("FAILED") + count("UNCONFIRMED");
    await releaseCampaignReservations(tx, campaignId, now);
    const body = finishedBody(c.mode, sent, skipped, failed);
    await logActivity(
      {
        actorId: null,
        type: "campaign.finished",
        summary: `${c.name} finished: ${body.charAt(0).toLowerCase()}${body.slice(1).replace(/\.$/, "")}`,
        campaignId,
        data: { sent, skipped, failed },
        mode: c.mode,
      },
      tx,
    );
    const notify = new Set<number>([c.createdById]);
    if (c.senderId) notify.add(c.senderId);
    for (const userId of notify) {
      await createNotification(
        { userId, type: "campaign.finished", title: `${c.name} finished`, body, link: `/campaigns/${campaignId}` },
        tx,
      );
    }
    return true;
  });
}

// ───────────────────────── pause / resume / cancel ─────────────────────────

export type PauseResult = ControlResult & { status: "PAUSED" };

/** Pauses a running or scheduled campaign. Its reservations expire after the paused-expiry setting. */
export async function pauseCampaign(
  campaignId: number,
  actorId: number,
  opts: { reason?: string | null; now?: Date } = {},
): Promise<PauseResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  const expiresAt = await pausedExpiryFrom(now);
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, status: true, mode: true } });
    if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
    if (c.status === "PAUSED") throw new CampaignError("This campaign is already paused.", "already-paused");
    if (c.status !== "RUNNING" && c.status !== "SCHEDULED") throw new CampaignError(endedText(c.status), "not-active");
    const reason = opts.reason?.trim() || `Paused by ${name}`;
    const res = await tx.campaign.updateMany({
      where: { id: campaignId, status: { in: ["RUNNING", "SCHEDULED"] } },
      data: { status: "PAUSED", pausedAt: now, pauseReason: reason },
    });
    if (res.count !== 1) throw new CampaignError(CHANGED, "changed");
    await setReservationExpiry(tx, campaignId, expiresAt);
    await logActivity(
      { actorId, type: "campaign.paused", summary: `${name} paused ${c.name}`, campaignId, data: { reason }, mode: c.mode },
      tx,
    );
    return { status: "PAUSED", message: `Paused ${c.name}. Nothing more is sent until you resume it.` };
  });
}

export type ResumeResult = ControlResult & {
  status: "RUNNING" | "SCHEDULED" | "FINISHED";
  /** Companies another campaign took while this one was paused (their next email will be skipped). */
  lostCompanies: number;
};

/**
 * Resumes a paused campaign (scheduled again when its start is still ahead). Campaigns that hold
 * reservations (their sends count as "emailed") take back the ones that expired meanwhile, where no
 * other campaign has them.
 */
export async function resumeCampaign(campaignId: number, actorId: number, opts: { now?: Date } = {}): Promise<ResumeResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  const practiceCopy = await practiceCopyNow();
  const resumed = await dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, name: true, status: true, mode: true, startAt: true, launchedGoLive: true },
    });
    if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
    if (c.status !== "PAUSED") {
      throw new CampaignError(c.status === "RUNNING" || c.status === "SCHEDULED" ? "This campaign isn't paused." : endedText(c.status), "not-paused");
    }
    const status = c.startAt && c.startAt.getTime() > now.getTime() ? ("SCHEDULED" as const) : ("RUNNING" as const);
    const res = await tx.campaign.updateMany({
      where: { id: campaignId, status: "PAUSED" },
      data: { status, pausedAt: null, pauseReason: null },
    });
    if (res.count !== 1) throw new CampaignError(CHANGED, "changed");
    await clearReservationExpiry(tx, campaignId, now);
    let lost = 0;
    if (countsAsEmailed(c.mode, { practiceCopy, launchedGoLive: c.launchedGoLive })) {
      const open = await tx.campaignRecipient.findMany({
        where: { campaignId, included: true, state: { in: [...OPEN_RECIPIENT_STATES] } },
        select: { companyId: true },
        distinct: ["companyId"],
      });
      const taken = await takeReservations(tx, campaignId, open.map((r) => r.companyId), now);
      lost = taken.lost.length;
    }
    await logActivity({ actorId, type: "campaign.resumed", summary: `${name} resumed ${c.name}`, campaignId, mode: c.mode }, tx);
    return { name: c.name, status, lost };
  });
  const finished = resumed.status === "RUNNING" && (await finishCheck(campaignId, { now }));
  const lostText =
    resumed.lost > 0
      ? ` ${plural(resumed.lost, "company is", "companies are")} now in other campaigns, so ${resumed.lost === 1 ? "its" : "their"} next email will be skipped.`
      : "";
  return {
    status: finished ? "FINISHED" : resumed.status,
    lostCompanies: resumed.lost,
    message: finished
      ? `Resumed ${resumed.name}. Nothing was left to send, so it has finished.`
      : `Resumed ${resumed.name}.${lostText}`,
  };
}

export type CancelResult = ControlResult & { cancelledEmails: number; stoppedRecipients: number };

/**
 * Cancels a launched campaign: emails waiting to send are cancelled, every recipient still in
 * progress is stopped, and its reservations are released. An email being sent right now finishes.
 */
export async function cancelCampaign(campaignId: number, actorId: number, opts: { now?: Date } = {}): Promise<CancelResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, status: true, mode: true } });
    if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
    if (c.status === "DRAFT") throw new CampaignError("This campaign hasn't been launched yet. Delete the draft instead.", "draft");
    if (c.status === "FINISHED" || c.status === "CANCELLED") throw new CampaignError(endedText(c.status), "ended");
    const res = await tx.campaign.updateMany({
      where: { id: campaignId, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
      data: { status: "CANCELLED", finishedAt: now },
    });
    if (res.count !== 1) throw new CampaignError(CHANGED, "changed");
    const emails = await tx.outboundEmail.updateMany({
      where: { campaignId, status: "QUEUED" },
      data: { status: "CANCELLED", lastError: `Cancelled by ${name}` },
    });
    const recipients = await tx.campaignRecipient.updateMany({
      where: { campaignId, included: true, state: { in: [...OPEN_RECIPIENT_STATES] } },
      data: { state: "STOPPED", stopReason: "campaign_cancelled", nextDueAt: null, holdReason: null, heldAt: null },
    });
    await releaseCampaignReservations(tx, campaignId, now);
    await logActivity(
      {
        actorId,
        type: "campaign.cancelled",
        summary: `${name} cancelled ${c.name}`,
        campaignId,
        data: { cancelledEmails: emails.count, stoppedRecipients: recipients.count },
        mode: c.mode,
      },
      tx,
    );
    return {
      cancelledEmails: emails.count,
      stoppedRecipients: recipients.count,
      message: `Cancelled ${c.name}. ${plural(emails.count, "email that was", "emails that were")} waiting won't be sent.`,
    };
  });
}

// ───────────────────────── one recipient / one email ─────────────────────────

export type SkipResult = ControlResult & {
  skippedEmails: number;
  /** An email to this person was being sent at that moment; it still goes out. */
  sendingNow: boolean;
};

/**
 * Skips one recipient: their waiting emails are skipped (and a "Not sure it was sent" email is
 * settled as skipped), and they get nothing more from this campaign. Refused while the app is still
 * checking with Mailgun whether one of their emails went out.
 */
export async function skipRecipient(recipientId: number, actorId: number, opts: { now?: Date } = {}): Promise<SkipResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  const result = await dbTx(async (tx) => {
    const r = await tx.campaignRecipient.findUnique({
      where: { id: recipientId },
      select: {
        id: true,
        included: true,
        state: true,
        companyId: true,
        personId: true,
        emailNorm: true,
        campaign: { select: { id: true, name: true, status: true, mode: true } },
        person: { select: { name: true, email: true } },
      },
    });
    if (!r) throw new CampaignError(RECIPIENT_GONE, "not-found");
    const who = recipientLabel(r.person, r.emailNorm);
    if (r.campaign.status === "DRAFT") {
      throw new CampaignError("This campaign hasn't been launched yet. Untick this person in the Audience step instead.", "draft");
    }
    if (!r.included || r.state === "EXCLUDED") throw new CampaignError(`${who} isn't included in this campaign.`, "not-included");
    if (r.state === "FINISHED") throw new CampaignError(`All of ${who}'s emails have already been sent.`, "finished");
    if (r.state === "STOPPED") throw new CampaignError(`${who}'s emails have already stopped.`, "stopped");
    const checking = await tx.outboundEmail.count({ where: { campaignId: r.campaign.id, recipientId, status: "UNKNOWN" } });
    if (checking > 0) {
      throw new CampaignError(
        `We're still checking with Mailgun whether the email to ${who} went out. You can choose Retry or Skip once it's marked 'Not sure it was sent', at most 2 hours after it was sent.`,
        "checking",
      );
    }

    const skipped = await tx.outboundEmail.updateMany({
      where: { campaignId: r.campaign.id, recipientId, status: "QUEUED" },
      data: { status: "SKIPPED", lastError: `Skipped by ${name}` },
    });
    const unsure = await tx.outboundEmail.updateMany({
      where: { campaignId: r.campaign.id, recipientId, status: "UNCONFIRMED" },
      data: { status: "SKIPPED", lastError: `Skipped by ${name} (we couldn't confirm it was sent)` },
    });
    const sendingNow = (await tx.outboundEmail.count({ where: { campaignId: r.campaign.id, recipientId, status: "SENDING" } })) > 0;
    const stopped = await tx.campaignRecipient.updateMany({
      where: { id: recipientId, state: { in: [...OPEN_RECIPIENT_STATES] } },
      data: { state: "STOPPED", stopReason: `Skipped by ${name}`, nextDueAt: null, holdReason: null, heldAt: null },
    });
    if (stopped.count !== 1) throw new CampaignError(CHANGED, "changed");
    await releaseCompanyIfDone(tx, r.campaign.id, r.companyId, now);
    await logActivity(
      {
        actorId,
        type: "campaign.recipientSkipped",
        summary: `${name} skipped ${who} in ${r.campaign.name}`,
        companyId: r.companyId,
        personId: r.personId,
        campaignId: r.campaign.id,
        data: { recipientId, skippedEmails: skipped.count + unsure.count, unconfirmedSkipped: unsure.count },
        mode: r.campaign.mode,
      },
      tx,
    );
    return {
      campaignId: r.campaign.id,
      skippedEmails: skipped.count + unsure.count,
      sendingNow,
      message: sendingNow
        ? `Skipped ${who}. The email being sent right now will still go out; nothing after it will.`
        : `Skipped ${who}. They won't get any more emails from this campaign.`,
    };
  });
  if (!result.sendingNow) await finishCheck(result.campaignId, { now });
  return { skippedEmails: result.skippedEmails, sendingNow: result.sendingNow, message: result.message };
}

export type RetryResult = ControlResult & { status: "QUEUED" };

/** The Retry refusals when a campaign's From line no longer matches today's settings (review SEND-1). */
export const RETRY_FROM_TEXTS = {
  /** A shared-From campaign after the From address was changed or cleared. */
  fromChanged: (from: string): string =>
    `This campaign was launched with the From address ${from}, which has changed since. Start a new campaign to email this person again.`,
  /** A per-person campaign after a shared From address was saved. */
  nowShared: (from: string): string =>
    `This campaign was launched when emails came from each person's own address, and they now come from ${from}. Start a new campaign to email this person again.`,
  /** A shared-From campaign whose reply address is on a sending domain that was replaced since. */
  domainChanged: (domain: string): string =>
    `This campaign was launched on the sending domain ${domain}, which has changed since. Start a new campaign to email this person again.`,
  /** A shared-From campaign without a readable From address (never written by a launch). */
  unknown: "This campaign's From address has changed since it was launched. Start a new campaign to email this person again.",
  /**
   * MAIN-DOMAIN-DESIGN O16, §2.3: own-mailbox mode, a test or live campaign launched with another From address, with a
   * reply address, or before replies went to the own mailbox.
   */
  nowOwnMailbox:
    "This campaign was launched with another From address or before replies went to your own mailbox. Start a new campaign to email this person again.",
  /**
   * Review SEND-6 (MAIN-DOMAIN-DESIGN O35): own-mailbox mode, the email itself would still be stopped by the sender check
   * (its From line, a reply address, or its Message-ID made for another domain), e.g. one that didn't send after being
   * stopped twice. Trying it again would only pause all sending once more.
   */
  emailDoesntFit: (from: string): string =>
    `This email was prepared for another sending setup, so it can't go out from ${from}. Start a new campaign to email this person again.`,
} as const;

/**
 * Retry's answer when the email it put back waits for today's inbox check (own-mailbox mode, MAIN-DOMAIN-DESIGN O33):
 * the waiting line's words, so the person knows it goes once someone has read the own mailbox today.
 */
export function retryInboxCheckText(what: string): string {
  return `${what} will be tried again once today's inbox check is done (Notifications › Inbox check).`;
}

const lowerOrNull = (v: string | null | undefined): string | null => (v ?? "").trim().toLowerCase() || null;

/**
 * Why a test or live campaign's email can't be tried again with its launch snapshot (review SEND-1), or null. Retry
 * brings a finished campaign back to Running, while a From address change and a sending-domain change are refused only
 * while a test or live campaign is scheduled, running or paused. So an email goes back to the queue only while the
 * campaign's From line is what a launch would use today:
 *  - shared-From snapshot (a Reply-To): today's From address, and the Reply-To on today's sending domain;
 *  - per-person snapshot (no Reply-To): no From address saved. In per-person mode nothing is saved, so this is never
 *    refused there (per-person mode is unchanged, SHARED-FROM-DESIGN §0.2 rule 4).
 * A saved From address that doesn't fit the sending domain answers with its own sentence (`team.problem`) where it
 * decides the refusal.
 * Dry runs never reach Mailgun and are never refused here.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O16, §2.3; `team.replies`, absent = app mode): a test or live snapshot fits only
 * with no Reply-To and today's own From as its From address; anything else (a shared-From or per-person snapshot, or
 * another From) answers `team.problem` (no fitting own From) or `RETRY_FROM_TEXTS.nowOwnMailbox`. App mode unchanged.
 */
export function retrySnapshotProblem(
  campaign: { mode: SendMode | null; fromAddress: string | null; replyTo: string | null },
  team: Pick<TeamFromState, "address" | "saved" | "domain" | "problem"> & Partial<Pick<TeamFromState, "replies" | "ownFrom">>,
): string | null {
  if (campaign.mode !== "TEST" && campaign.mode !== "LIVE") return null;
  if (team.replies === "own-mailbox") {
    const own = lowerOrNull(team.ownFrom);
    if (lowerOrNull(campaign.replyTo) === null && own !== null && lowerOrNull(campaign.fromAddress) === own) return null;
    return team.problem ?? RETRY_FROM_TEXTS.nowOwnMailbox;
  }
  const replyTo = lowerOrNull(campaign.replyTo);
  if (replyTo === null) {
    if (team.saved === null) return null;
    return team.problem ?? RETRY_FROM_TEXTS.nowShared(team.saved);
  }
  const from = lowerOrNull(campaign.fromAddress);
  if (from === null) return RETRY_FROM_TEXTS.unknown;
  if (team.address === from) {
    const domain = domainOfAddress(replyTo);
    return domain !== null && domain === team.domain ? null : RETRY_FROM_TEXTS.domainChanged(domain ?? replyTo);
  }
  if (team.saved === from && team.problem) return team.problem;
  return RETRY_FROM_TEXTS.fromChanged(from);
}

/**
 * Review SEND-6 (MAIN-DOMAIN-DESIGN O6, O35): in own-mailbox mode, why this test or live email itself can't pass the
 * sender check the transport runs before every send (`senderHeaderProblem` with today's own From: its From line is the
 * own From on the sending domain with no reply address, and its Message-ID is on the sending domain), or null. An email
 * that failed after two sender blocks ("Didn't send", `senderBlockedTwice`) would otherwise go back to the queue with
 * its block forgotten and pause all sending again. Checked after `retrySnapshotProblem`, so a fitting own From exists.
 * App mode and dry runs: always null (unchanged).
 */
export function retryEmailProblem(
  email: { mode: SendMode; fromAddress: string; replyTo: string | null; messageId: string },
  team: Pick<TeamFromState, "domain"> & Partial<Pick<TeamFromState, "replies" | "ownFrom">>,
): string | null {
  if (team.replies !== "own-mailbox" || (email.mode !== "TEST" && email.mode !== "LIVE")) return null;
  const domain = (team.domain ?? "").trim().toLowerCase();
  const own = ownMailboxRuleFrom("own-mailbox", team.ownFrom ?? null) ?? "";
  const fits =
    domain !== "" &&
    senderHeaderProblem(domain, email.fromAddress, email.replyTo, { ownMailboxFrom: own }) === null &&
    messageIdDomainOf(email.messageId) === domain;
  return fits ? null : RETRY_FROM_TEXTS.emailDoesntFit(own || domain || "your From address");
}

/** Campaigns whose company reservations a retry takes back (a finished one runs again for it). */
const RETRY_RESERVES: readonly CampaignStatus[] = ["RUNNING", "SCHEDULED", "FINISHED"];

/**
 * Tries an email again that didn't send (FAILED) or that we're not sure was sent (UNCONFIRMED): it
 * goes back to the queue with the same Message-ID, due now, with a fresh set of tries (so the usual
 * 1/5/15/60-minute retries apply again). A finished campaign runs again for it. A paused campaign
 * takes no reservation here (its reservations keep their expiry): resuming takes them back, and so
 * does the sending loop just before the email goes.
 *
 * Refused for an email Mailgun already has (its id is saved: it is never sent twice), and, for a
 * live campaign's "Not sure it was sent" email, unless the person confirmed the duplicate risk
 * (`confirmDuplicateRisk`; CampaignError code "confirm-duplicate" otherwise). The test-list guard
 * still applies when it goes out. A test or live email whose campaign was launched with a From line today's settings
 * no longer use (the From address changed or was cleared, a From address was saved since a per-person launch, or the
 * reply address's sending domain was replaced) is refused with code "from-changed" (`retrySnapshotProblem`, review
 * SEND-1): starting a new campaign is how to email that person again. In own-mailbox mode so is an email that itself
 * wouldn't pass the sender check, e.g. one that didn't send after two sender blocks (`retryEmailProblem`, review SEND-6):
 * Retry never pauses all sending again for it.
 *
 * Holds reach a reopened person too (M4-DESIGN §2.8): a possible reply of the company nobody has
 * decided yet holds them at once; a hold after the PC was off that still covers their company or
 * their sender keeps their email waiting in the sending guard until the senders have checked their
 * inbox (`outageHeldIds`), and the message says so. In own-mailbox mode a live follow-up put back waits for today's
 * inbox check (`inboxCheckHeldIds`, MAIN-DOMAIN-DESIGN O33) and the message says that instead.
 */
export async function retryEmail(
  emailId: number,
  actorId: number,
  opts: { now?: Date; confirmDuplicateRisk?: boolean } = {},
): Promise<RetryResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  const practiceCopy = await practiceCopyNow();
  const done = await dbTx(async (tx) => {
    const e = await tx.outboundEmail.findUnique({
      where: { id: emailId },
      select: {
        id: true,
        status: true,
        step: true,
        mode: true,
        toEmail: true,
        toNorm: true,
        companyId: true,
        personId: true,
        recipientId: true,
        providerId: true,
        fromAddress: true,
        replyTo: true,
        messageId: true,
        campaign: { select: { id: true, name: true, status: true, mode: true, launchedGoLive: true, fromAddress: true, replyTo: true } },
        recipient: {
          select: { id: true, state: true, stopReason: true, companyId: true, person: { select: { name: true, email: true } } },
        },
      },
    });
    if (!e) throw new CampaignError(EMAIL_GONE, "not-found");
    if (e.campaign.status === "CANCELLED") {
      throw new CampaignError("This campaign was cancelled, so its emails can't be sent any more.", "cancelled");
    }
    if (e.status === "SENT") throw new CampaignError("This email has already been sent.", "sent");
    if (e.status === "QUEUED" || e.status === "SENDING") throw new CampaignError("This email is already waiting to send.", "queued");
    if (e.status === "UNKNOWN") {
      throw new CampaignError(
        "We're still checking with Mailgun whether this email went out. You can choose Retry or Skip once it's marked 'Not sure it was sent', at most 2 hours after it was sent.",
        "checking",
      );
    }
    if (e.status !== "FAILED" && e.status !== "UNCONFIRMED") {
      throw new CampaignError("Only emails that didn't send, or that we're not sure were sent, can be tried again.", "not-retryable");
    }
    if (e.providerId && e.campaign.mode !== "DRY_RUN") {
      throw new CampaignError("Mailgun already has this email, so it won't be sent again.", "provider-has-it");
    }
    // Review SEND-1: never send with a From line the settings have left behind (read in this transaction).
    const team = await loadTeamFrom(tx);
    const snapshotProblem = retrySnapshotProblem(e.campaign, team);
    if (snapshotProblem) throw new CampaignError(snapshotProblem, "from-changed");
    // Review SEND-6: in own-mailbox mode the email itself must pass the sender check, or Retry would pause all sending.
    const emailProblem = retryEmailProblem(e, team);
    if (emailProblem) throw new CampaignError(emailProblem, "from-changed");
    if (e.status === "UNCONFIRMED" && e.campaign.mode === "LIVE" && !opts.confirmDuplicateRisk) {
      const who = recipientLabel(e.recipient.person, e.toEmail);
      throw new CampaignError(
        `We couldn't confirm with Mailgun whether this email reached ${e.toEmail}. Retry sends it again. If the first one did arrive, ${who} gets it twice.`,
        "confirm-duplicate",
      );
    }
    const rec = e.recipient;
    if (rec.state === "STOPPED" && rec.stopReason !== FAILED_STOP_REASON) {
      throw new CampaignError("This person's emails were stopped, so this email can't be sent again.", "stopped");
    }
    const res = await tx.outboundEmail.updateMany({
      where: { id: emailId, status: { in: ["FAILED", "UNCONFIRMED"] }, ...(e.campaign.mode === "DRY_RUN" ? {} : { providerId: null }) },
      data: { status: "QUEUED", dueAt: now, lastError: null, claimedAt: null, attempts: 0 },
    });
    if (res.count !== 1) throw new CampaignError(CHANGED, "changed");
    if (rec.state === "STOPPED" || rec.state === "FINISHED") {
      await tx.campaignRecipient.update({
        where: { id: rec.id },
        data: {
          state: e.step === 0 ? "SCHEDULED" : "WAITING",
          stopReason: null,
          currentStep: e.step,
          nextDueAt: now,
          holdReason: null,
          heldAt: null,
        },
      });
      // A possible reply of the company that nobody has decided yet holds the reopened person at once (§2.8.2).
      await applyPendingPossibleReplyHolds({ companyIds: [rec.companyId], campaignId: e.campaign.id, now, tx });
    }
    if (e.campaign.status === "FINISHED") {
      await tx.campaign.updateMany({ where: { id: e.campaign.id, status: "FINISHED" }, data: { status: "RUNNING", finishedAt: null } });
    }
    if (RETRY_RESERVES.includes(e.campaign.status) && countsAsEmailed(e.campaign.mode, { practiceCopy, launchedGoLive: e.campaign.launchedGoLive })) {
      await takeReservations(tx, e.campaign.id, [rec.companyId], now);
    }
    await logActivity(
      {
        actorId,
        type: "campaign.emailRetried",
        summary: `${name} tried the ${stepName(e.step)} to ${e.toEmail} again (${e.campaign.name})`,
        companyId: e.companyId,
        personId: e.personId,
        campaignId: e.campaign.id,
        data: { emailId },
        mode: e.campaign.mode,
      },
      tx,
    );
    const guard: GuardCandidate = {
      id: e.id,
      campaignId: e.campaign.id,
      recipientId: rec.id,
      companyId: rec.companyId,
      toNorm: e.toNorm.toLowerCase(),
      mode: e.mode,
      step: e.step,
    };
    return { what: `The ${stepName(e.step)} to ${e.toEmail}`, guard };
  });
  // After the commit: a hold after the PC was off may still cover this person, and in own-mailbox mode a live follow-up
  // waits for today's inbox check (MAIN-DOMAIN-DESIGN O33); the sending gates keep it waiting, only the words depend on it.
  let outageHeld = false;
  let inboxHeld = false;
  try {
    outageHeld = (await outageHeldIds([done.guard])).has(emailId);
    inboxHeld = !outageHeld && (await inboxCheckHeldIds([done.guard], now)).has(emailId);
  } catch (err) {
    console.error(`[campaigns] couldn't check the holds for email #${emailId}`, err);
  }
  return {
    status: "QUEUED",
    message: outageHeld
      ? `${done.what} will be tried again once the senders have checked their inbox after the PC was off.`
      : inboxHeld
        ? retryInboxCheckText(done.what)
        : `${done.what} will be tried again in a moment.`,
  };
}

// ───────────────────────── editing an email that hasn't been sent ─────────────────────────

export const EDIT_LIMITS = { subject: 300, body: 20_000 } as const;

export type EditUnsentInput = {
  /** First email only: this person's subject. Omit (or null) to keep the campaign's subject. */
  subject?: string | null;
  body: string;
};

export type EditUnsentResult = ControlResult & { recipientId: number; step: number };

function cleanBody(v: string): string {
  return v.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/**
 * Checks that one step's email for a recipient can still be changed, inside a transaction. A step
 * whose row exists must still be waiting to send: the conditional update (QUEUED only) is what
 * keeps a web edit and the worker's claim from overlapping.
 */
async function assertEditable(
  tx: Tx,
  recipientId: number,
  step: number,
  now: Date,
): Promise<{ who: string; campaign: { id: number; name: string; mode: SendMode | null }; companyId: number; personId: number; toEmail: string | null }> {
  if (!Number.isInteger(step) || step < 0 || step > 3) throw new CampaignError("That step doesn't exist.", "bad-step");
  const r = await tx.campaignRecipient.findUnique({
    where: { id: recipientId },
    select: {
      id: true,
      included: true,
      state: true,
      companyId: true,
      personId: true,
      emailNorm: true,
      campaign: { select: { id: true, name: true, status: true, mode: true } },
      person: { select: { name: true, email: true } },
    },
  });
  if (!r) throw new CampaignError(RECIPIENT_GONE, "not-found");
  const who = recipientLabel(r.person, r.emailNorm);
  if (r.campaign.status === "FINISHED" || r.campaign.status === "CANCELLED") {
    throw new CampaignError("This campaign has ended, so its emails can't be changed.", "ended");
  }
  if (r.campaign.status === "DRAFT" && isLaunching(r.campaign.id)) throw new CampaignError(LAUNCHING_TEXT, "launching");
  if (!r.included || r.state === "EXCLUDED") {
    throw new CampaignError(`${who} isn't included in this campaign, so there's nothing to edit.`, "not-included");
  }
  const campaignStep = await tx.campaignStep.findUnique({
    where: { campaignId_step: { campaignId: r.campaign.id, step } },
    select: { enabled: true },
  });
  if (!campaignStep || !campaignStep.enabled) {
    throw new CampaignError(`This campaign has no ${stepName(step)}.`, "no-step");
  }
  const row = await tx.outboundEmail.findFirst({ where: { campaignId: r.campaign.id, recipientId, step }, select: { id: true, status: true } });
  if (row) {
    const touched = await tx.outboundEmail.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { updatedAt: now } });
    if (touched.count !== 1) {
      const current = await tx.outboundEmail.findUnique({ where: { id: row.id }, select: { status: true } });
      if (current?.status === "SENDING") throw new CampaignError(SENDING_NOW, "sending-now");
      if (current?.status === "SENT") throw new CampaignError("This email has already been sent, so it can't be changed.", "sent");
      throw new CampaignError("This email won't be sent (it was skipped or cancelled), so there's nothing to edit.", "not-queued");
    }
  } else if (r.state === "FINISHED" || r.state === "STOPPED") {
    throw new CampaignError(`${who}'s emails have stopped, so there's nothing left to edit.`, "stopped");
  }
  return { who, campaign: r.campaign, companyId: r.companyId, personId: r.personId, toEmail: r.person.email };
}

/**
 * Saves this person's own version of one step (RecipientEdit), used when the email is rendered.
 * Refused once the email has left the queue: "This email is being sent right now…", and for a first
 * subject that starts with "Re:" or "Fwd:" (M4-DESIGN §2.13, code "re-subject").
 */
export async function editUnsentEmail(
  recipientId: number,
  step: number,
  input: EditUnsentInput,
  actorId: number,
  opts: { now?: Date } = {},
): Promise<EditUnsentResult> {
  const now = opts.now ?? new Date();
  const body = cleanBody(input.body ?? "");
  if (!body) throw new CampaignError("Write the email text before saving.", "empty-body");
  if (body.length > EDIT_LIMITS.body) {
    throw new CampaignError(`Keep the email under ${EDIT_LIMITS.body.toLocaleString("en-US")} characters.`, "too-long");
  }
  let subject: string | null = null;
  if (step === 0 && input.subject !== undefined && input.subject !== null) {
    subject = input.subject.replace(/\s+/g, " ").trim();
    if (!subject) throw new CampaignError("Write a subject for the first email.", "empty-subject");
    if (subject.length > EDIT_LIMITS.subject) throw new CampaignError(`Keep the subject under ${EDIT_LIMITS.subject} characters.`, "too-long");
    const problem = firstSubjectProblem(subject);
    if (problem?.level === "error") throw new CampaignError(problem.text, "re-subject");
  }
  const name = await actorName(actorId);
  return dbTx(async (tx) => {
    const info = await assertEditable(tx, recipientId, step, now);
    await tx.recipientEdit.upsert({
      where: { recipientId_step: { recipientId, step } },
      create: { recipientId, step, subject, body, editedById: actorId, editedAt: now },
      update: { subject, body, editedById: actorId, editedAt: now },
    });
    await tx.campaignRecipient.update({ where: { id: recipientId }, data: { hasEdits: true } });
    await logActivity(
      {
        actorId,
        type: "campaign.emailEdited",
        summary: `${name} edited the ${stepName(step)} to ${info.who} (${info.campaign.name})`,
        companyId: info.companyId,
        personId: info.personId,
        campaignId: info.campaign.id,
        data: { recipientId, step },
        mode: info.campaign.mode,
      },
      tx,
    );
    return { recipientId, step, message: `Saved. ${info.who} gets this version of the ${stepName(step)}.` };
  });
}

/** Removes this person's own version of one step, so they get the campaign's text again. */
export async function discardUnsentEdit(
  recipientId: number,
  step: number,
  actorId: number,
  opts: { now?: Date } = {},
): Promise<EditUnsentResult> {
  const now = opts.now ?? new Date();
  const name = await actorName(actorId);
  return dbTx(async (tx) => {
    const info = await assertEditable(tx, recipientId, step, now);
    const removed = await tx.recipientEdit.deleteMany({ where: { recipientId, step } });
    const left = await tx.recipientEdit.count({ where: { recipientId } });
    await tx.campaignRecipient.update({ where: { id: recipientId }, data: { hasEdits: left > 0 } });
    if (removed.count > 0) {
      await logActivity(
        {
          actorId,
          type: "campaign.emailEdited",
          summary: `${name} went back to the campaign's ${stepName(step)} for ${info.who} (${info.campaign.name})`,
          companyId: info.companyId,
          personId: info.personId,
          campaignId: info.campaign.id,
          data: { recipientId, step, discarded: true },
          mode: info.campaign.mode,
        },
        tx,
      );
    }
    return { recipientId, step, message: `${info.who} gets the campaign's ${stepName(step)} again.` };
  });
}
