import type { CampaignStatus } from "@/generated/prisma/client";
import { db, dbTx, dbWrite } from "@/server/db";

/**
 * Claiming an email for sending (PLAN.md B5.5, B6.7): one autocommit conditional update
 * (QUEUED → SENDING) under the process write lock, committed BEFORE the transport is called.
 * Never call these inside dbTx(): Prisma shares one SQLite connection per process, so a statement
 * issued while a transaction is open would become part of it (and could be rolled back with it).
 *
 * Putting a claimed email back never revives a campaign that has ended: when the campaign was
 * cancelled (or has finished) meanwhile, the email is cancelled instead of going back in the queue.
 */

/**
 * Claims a queued email. True when this caller got it (exactly one caller ever does). The claim is
 * committed at once, so a transaction rolled back elsewhere can never take it back.
 */
export async function claimEmail(emailId: number, now: Date = new Date()): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.outboundEmail.updateMany({
      where: { id: emailId, status: "QUEUED" },
      data: { status: "SENDING", claimedAt: now, attempts: { increment: 1 } },
    }),
  );
  return res.count === 1;
}

/** Stored as lastError when an email of a cancelled campaign is cancelled after the fact. */
export const CAMPAIGN_CANCELLED_MESSAGE = "This campaign was cancelled";
/** Stored as lastError when an email of a finished campaign is cancelled after the fact. */
export const CAMPAIGN_FINISHED_MESSAGE = "This campaign has already finished";

/** Why an email of a campaign with this status may never be sent any more, or null while it may. */
export function endedCampaignMessage(status: CampaignStatus): string | null {
  if (status === "CANCELLED") return CAMPAIGN_CANCELLED_MESSAGE;
  if (status === "FINISHED") return CAMPAIGN_FINISHED_MESSAGE;
  return null;
}

export type ReleaseOptions = {
  /** Shown on the campaign page ("Couldn't prepare this email: …"). null clears it. */
  error?: string | null;
  /** When to try again (default: keep the current due time). */
  dueAt?: Date;
  /** False when nothing was really attempted (e.g. the campaign was paused meanwhile). */
  countAttempt?: boolean;
};

/**
 * What happened to a claimed email that was put back: "queued" (waiting to send again),
 * "cancelled" (its campaign was cancelled or has finished meanwhile), or "lost" (it wasn't
 * claimed any more, so nothing changed).
 */
export type ReleaseResult = "queued" | "cancelled" | "lost";

/** Puts a claimed email back in the queue (SENDING → QUEUED), or cancels it when its campaign has ended. */
export async function releaseClaim(emailId: number, opts: ReleaseOptions = {}): Promise<ReleaseResult> {
  return dbTx(async (tx) => {
    const row = await tx.outboundEmail.findUnique({
      where: { id: emailId },
      select: { status: true, campaign: { select: { status: true } } },
    });
    if (!row || row.status !== "SENDING") return "lost";
    const ended = endedCampaignMessage(row.campaign.status);
    const res = await tx.outboundEmail.updateMany({
      where: { id: emailId, status: "SENDING" },
      data: ended
        ? { status: "CANCELLED", claimedAt: null, lastError: ended }
        : {
            status: "QUEUED",
            claimedAt: null,
            ...(opts.error !== undefined ? { lastError: opts.error } : {}),
            ...(opts.dueAt ? { dueAt: opts.dueAt } : {}),
            ...(opts.countAttempt === false ? { attempts: { decrement: 1 } } : {}),
          },
    });
    if (res.count !== 1) return "lost";
    return ended ? "cancelled" : "queued";
  });
}

/** Dry-run emails still "Sending" after this long were interrupted (the worker stopped mid-send). */
export const STUCK_DRY_RUN_MS = 2 * 60_000;

/** Shown on the campaign page: "The last try didn't work (the background sender stopped…); it will be tried again". */
export const STUCK_DRY_RUN_MESSAGE = "The background sender stopped while preparing this email";

/**
 * Worker start-up (and every few minutes): dry-run emails claimed more than 2 minutes ago go back
 * to the queue. Nothing left the PC for them, so there is nothing to check first. Emails of a
 * campaign that was cancelled (or has finished) meanwhile are cancelled instead. Live and test
 * emails are never reset: Mailgun may have them, so the reconciler checks with Mailgun
 * (./reconcile). Returns how many went back to the queue.
 */
export async function resetStuckDryRunSends(now: Date = new Date(), olderThanMs: number = STUCK_DRY_RUN_MS): Promise<number> {
  const stuck = { status: "SENDING" as const, mode: "DRY_RUN" as const, claimedAt: { lt: new Date(now.getTime() - olderThanMs) } };
  return dbTx(async (tx) => {
    for (const status of ["CANCELLED", "FINISHED"] as const) {
      await tx.outboundEmail.updateMany({
        where: { ...stuck, campaign: { status } },
        data: { status: "CANCELLED", claimedAt: null, lastError: endedCampaignMessage(status) },
      });
    }
    const res = await tx.outboundEmail.updateMany({
      where: stuck,
      data: { status: "QUEUED", claimedAt: null, lastError: STUCK_DRY_RUN_MESSAGE },
    });
    return res.count;
  });
}

const LEFTOVER_BATCH = 500;

/**
 * Maintenance: emails still waiting to send in a cancelled campaign are cancelled (they can never
 * be sent, and would show as "waiting" for good). Cancelling a campaign already cancels its waiting
 * emails; this tidies up any that were put back in the queue afterwards. Returns how many.
 */
export async function cancelEmailsOfCancelledCampaigns(): Promise<number> {
  let total = 0;
  for (;;) {
    // Read first (reads never block the web app), then write only what was found.
    const found = await db.outboundEmail.findMany({
      where: { status: "QUEUED", campaign: { status: "CANCELLED" } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: LEFTOVER_BATCH,
    });
    if (found.length === 0) return total;
    const res = await dbWrite((c) =>
      c.outboundEmail.updateMany({
        where: { id: { in: found.map((f) => f.id) }, status: "QUEUED" },
        data: { status: "CANCELLED", lastError: CAMPAIGN_CANCELLED_MESSAGE },
      }),
    );
    total += res.count;
    if (found.length < LEFTOVER_BATCH || res.count === 0) return total;
  }
}
