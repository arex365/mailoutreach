import type { CampaignStatus, Prisma } from "@/generated/prisma/client";
import { db, dbTx, pauseForOtherWriters } from "@/server/db";
import { enqueueJob } from "@/server/jobs";
import { finishCheck } from "@/server/services/campaigns/control";
import { excludeUnsent } from "@/server/services/mail-events/stops";
import { RECHECK_LEFT_OUT_TEXT } from "./settle";
import { checkRunJobOptions } from "./start";
import { VERIFY_JOB_TYPE } from "./runs";

/**
 * The 24-hour re-check of "unknown" addresses (docs/dev/M5-DESIGN.md §2.7): every 15 minutes the periodic task
 * `verify.recheck` (wired by P11) calls `enqueueDueRechecks`, which
 *  1. leaves out, without a call, RECHECK recipients whose re-check is 72 hours overdue (checks were paused or had no
 *     key for three days): "Left out: address couldn't be checked", in chunks of 500 through `excludeUnsent`;
 *  2. enqueues one `recheck` run of the check job (dedupe `verify:recheck`, priority 30) when a RECHECK recipient's
 *     `recheckAt` has come. That run checks each due person once and the commit settles every RECHECK recipient of
 *     that person, in every campaign (released, or left out).
 * Only launched campaigns that can still send count (Scheduled, Running, Paused): a draft never waits for a re-check.
 */

/** The periodic task's name (SystemState "task.verify.recheck"); P11 registers it every 15 minutes. */
export const VERIFY_RECHECK_TASK = "verify.recheck";
/** A re-check this long overdue is given up without a call (checks were paused or had no key). */
export const STALE_RECHECK_MS = 72 * 3_600_000;
/** Campaign statuses whose RECHECK recipients are re-checked. */
export const RECHECK_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["SCHEDULED", "RUNNING", "PAUSED"];

const CHUNK = 500;

/** RECHECK recipients of campaigns that can still send whose re-check is due at `until`. */
function dueWhere(until: Date): Prisma.CampaignRecipientWhereInput {
  return {
    state: "RECHECK",
    recheckAt: { lte: until },
    campaign: { status: { in: [...RECHECK_CAMPAIGN_STATUSES] } },
  };
}

/** One person whose re-check is due: their latest due `recheckAt` (a person can wait in several campaigns). */
export type DueRecheckPerson = { personId: number; recheckAt: Date };

/**
 * The people whose re-check has come (`recheckAt ≤ now`), each once with the latest of their due `recheckAt`s, oldest
 * first. Read through the `(state, recheckAt)` index.
 */
export async function dueRecheckPeople(now: Date): Promise<DueRecheckPerson[]> {
  const rows = await db.campaignRecipient.findMany({
    where: dueWhere(now),
    select: { personId: true, recheckAt: true },
    orderBy: [{ recheckAt: "asc" }, { id: "asc" }],
  });
  const byPerson = new Map<number, Date>();
  for (const r of rows) {
    if (!r.recheckAt) continue;
    const seen = byPerson.get(r.personId);
    if (!seen || r.recheckAt > seen) byPerson.set(r.personId, r.recheckAt);
  }
  return [...byPerson.entries()].map(([personId, recheckAt]) => ({ personId, recheckAt }));
}

/**
 * Leaves out RECHECK recipients whose re-check is 72 hours overdue (§2.7 "stale" rule), without a call: "Address
 * couldn't be checked". Chunks of 500 recipients per transaction with a pause for the other process in between; the
 * campaigns touched get a finish check (the last open recipient may have gone). Returns how many were left out and
 * where.
 */
export async function settleStaleRechecks(now: Date): Promise<{ leftOut: number; campaignIds: number[] }> {
  const stale = await db.campaignRecipient.findMany({
    where: dueWhere(new Date(now.getTime() - STALE_RECHECK_MS)),
    select: { id: true, campaignId: true },
    orderBy: { id: "asc" },
  });
  let leftOut = 0;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const ids = stale.slice(i, i + CHUNK).map((r) => r.id);
    const started = Date.now();
    leftOut += await dbTx((tx) => excludeUnsent(tx, { recipientIds: ids, reason: RECHECK_LEFT_OUT_TEXT.couldntBeChecked, now }));
    if (i + CHUNK < stale.length) await pauseForOtherWriters(Date.now() - started);
  }
  const campaignIds = [...new Set(stale.map((r) => r.campaignId))].sort((a, b) => a - b);
  for (const campaignId of campaignIds) await finishCheck(campaignId, { now });
  return { leftOut, campaignIds };
}

/**
 * The sweep (every 15 minutes): gives up stale waits, then enqueues the `recheck` run when a re-check is due. Returns
 * true when a run is queued (a new one, or the one already waiting under its dedupe key), false when nothing is due.
 * The periodic task records its own success either way (P11).
 */
export async function enqueueDueRechecks(now: Date): Promise<boolean> {
  await settleStaleRechecks(now);
  const due = await db.campaignRecipient.findFirst({ where: dueWhere(now), select: { id: true } });
  if (!due) return false;
  const o = checkRunJobOptions({ source: "recheck" });
  await enqueueJob({
    type: VERIFY_JOB_TYPE,
    payload: { source: "recheck" },
    runAt: now,
    priority: o.priority,
    maxAttempts: o.maxAttempts,
    dedupeKey: o.dedupeKey,
    createdById: null,
  });
  return true;
}
