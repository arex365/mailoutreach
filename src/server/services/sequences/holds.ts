import type { CampaignStatus, Prisma, RecipientState, SendMode } from "@/generated/prisma/client";
import { OUTAGE_HOLD_NOTIFICATION } from "@/core/notification-types";
import type { HoldReason } from "@/core/replies/types";
import { safeZone } from "@/core/sending/capday";
import { formatHoldReasons, heldReasonsOf, HOLD_REASONS, outageGapCovered, parseHoldReasons, withHoldReason } from "@/core/sequences/hold-reasons";
import { STATE_KEYS, type OutageState } from "@/core/system-state";
import { parseOutageState } from "@/core/system-state-parse";
import { plural } from "@/core/text";
import { formatShortDate } from "@/core/time/format";
import { logActivity, type ActivityInput } from "@/server/activity";
import { db, dbTx, dbWrite, pauseForOtherWriters, type DbOrTx, type Tx } from "@/server/db";
import { activeOwnerId, createNotification } from "@/server/notifications";
import { CampaignError } from "@/server/services/campaigns/errors";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { readTyped, updateTyped } from "@/server/state-typed";

/**
 * Holds (M4-DESIGN §2.8): a held recipient (`CampaignRecipient.state = HELD`) gets nothing until released; unlike a
 * stop, a hold is reversible. `holdReason` lists why, sorted and comma-joined ("outage", "possible-reply" or
 * "outage,possible-reply", helpers in @/core/sequences/hold-reasons), and `heldAt` is when the first reason arrived;
 * both mean something only while the state is HELD. Two reasons:
 *  - "possible-reply" (§2.8.2): a message may be a reply (or an unknown address on the company's domain wrote, or
 *    processing a message failed for good). The company's open recipients wait until someone decides; a decision
 *    releases only recipients that no remaining undecided message still affects (`releaseCompanyHold`).
 *  - "outage" (§2.8.3): the PC was off longer than Mailgun keeps its logs, so replies may have been missed. The
 *    follow-ups whose last email went out before the end of the unchecked window, and everyone else open at those
 *    companies, wait until each sender has checked their inbox (`releaseOutageHold`, the Owner for anyone).
 * Holding keeps the recipients' QUEUED emails QUEUED (the candidate query skips HELD recipients) and keeps the
 * campaign's reservation. Recipients are held only through this module (M4-DESIGN §0.2 rule 7); every write is a
 * compare-and-set on the current state and hold reason, in transactions of at most 500 rows.
 */

/** Recipients a hold can reach: waiting for their first email or a follow-up, or already held for another reason. */
const OPEN_STATES: readonly RecipientState[] = ["SCHEDULED", "WAITING", "HELD"];
/** Open but not held yet: a hold moves these to HELD. */
const UNHELD_STATES: readonly RecipientState[] = ["SCHEDULED", "WAITING"];
/** Rows per transaction for chunked holds and releases (PLAN B5, M4-DESIGN §2.8.1). */
const TX_ROWS = 500;
/** Ids per `IN` list in reads. */
const IN_CHUNK = 400;
/** Companies per transaction when holds are applied in bulk (their open recipients stay well under TX_ROWS). */
const COMPANIES_PER_TX = 50;
/** Only real sending is held after an outage: dry runs never leave the PC, so no reply to them can be missed. */
const OUTAGE_MODES: readonly SendMode[] = ["TEST", "LIVE"];
/** Campaigns whose recipients may still get emails. */
const ACTIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["SCHEDULED", "RUNNING", "PAUSED"];
/** The name used for campaigns whose sender account is gone (`Campaign.senderId` null). */
export const UNKNOWN_SENDER_NAME = "Unknown sender";

/** Between two chunk transactions: lets the other process (web app or worker) take the write lock too. */
const yieldToEventLoop = pauseForOtherWriters;

function chunks<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function groupBy<T, K>(list: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of list) {
    const k = key(item);
    const group = out.get(k);
    if (group) group.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Every stored `holdReason` value that contains `reason` ("outage" → "outage", "outage,possible-reply"). */
export function holdReasonValuesWith(reason: HoldReason): string[] {
  const out = new Set<string>();
  for (let mask = 1; mask < 1 << HOLD_REASONS.length; mask++) {
    const subset = HOLD_REASONS.filter((_, i) => (mask & (1 << i)) !== 0);
    const value = subset.includes(reason) ? formatHoldReasons(subset) : null;
    if (value) out.add(value);
  }
  return [...out];
}

const OUTAGE_VALUES = holdReasonValuesWith("outage");

type HoldRow = { id: number; state: RecipientState; holdReason: string | null };
type ReleaseRow = { id: number; currentStep: number; holdReason: string | null };

/**
 * Adds `reason` to these open recipients inside `tx` (M4-DESIGN §2.8.1): SCHEDULED/WAITING ones become HELD with
 * `heldAt = now`; HELD ones gain the reason (`heldAt` kept, set when missing). One `updateMany` per group of rows with
 * the same current `holdReason`, each a compare-and-set on it, so a row that changed meanwhile is left alone. Returns
 * how many rows gained the reason.
 */
async function holdRows(tx: Tx, rows: readonly HoldRow[], reason: HoldReason, now: Date): Promise<number> {
  let changed = 0;
  const unheld = rows.filter((r) => r.state !== "HELD");
  for (const part of chunks(unheld.map((r) => r.id))) {
    const res = await tx.campaignRecipient.updateMany({
      where: { id: { in: part }, included: true, state: { in: [...UNHELD_STATES] } },
      data: { state: "HELD", holdReason: formatHoldReasons([reason]), heldAt: now },
    });
    changed += res.count;
  }
  const held = rows.filter((r) => r.state === "HELD" && !heldReasonsOf(r).includes(reason));
  for (const [current, group] of groupBy(held, (r) => r.holdReason)) {
    const next = withHoldReason(current, reason, true);
    for (const part of chunks(group.map((r) => r.id))) {
      const res = await tx.campaignRecipient.updateMany({
        where: { id: { in: part }, state: "HELD", holdReason: current },
        data: { holdReason: next },
      });
      changed += res.count;
      await tx.campaignRecipient.updateMany({ where: { id: { in: part }, state: "HELD", heldAt: null }, data: { heldAt: now } });
    }
  }
  return changed;
}

/**
 * Removes `reason` from these HELD recipients inside `tx` (M4-DESIGN §2.8.1): a row left with another reason stays
 * HELD; a row left with none goes back to WAITING (a follow-up is next) or SCHEDULED (its first email is next), with
 * the hold fields cleared, and its overdue email goes at the next open slot. Compare-and-set on `state = HELD` and the
 * current `holdReason`. Returns how many rows lost the reason.
 */
async function releaseRows(tx: Tx, rows: readonly ReleaseRow[], reason: HoldReason): Promise<number> {
  let changed = 0;
  const holding = rows.filter((r) => parseHoldReasons(r.holdReason).includes(reason));
  for (const [current, group] of groupBy(holding, (r) => r.holdReason)) {
    const next = withHoldReason(current, reason, false);
    if (next !== null) {
      for (const part of chunks(group.map((r) => r.id))) {
        const res = await tx.campaignRecipient.updateMany({ where: { id: { in: part }, state: "HELD", holdReason: current }, data: { holdReason: next } });
        changed += res.count;
      }
      continue;
    }
    const byState: Array<[RecipientState, ReleaseRow[]]> = [
      ["WAITING", group.filter((r) => r.currentStep > 0)],
      ["SCHEDULED", group.filter((r) => r.currentStep <= 0)],
    ];
    for (const [state, list] of byState) {
      for (const part of chunks(list.map((r) => r.id))) {
        const res = await tx.campaignRecipient.updateMany({
          where: { id: { in: part }, state: "HELD", holdReason: current },
          data: { state, holdReason: null, heldAt: null },
        });
        changed += res.count;
      }
    }
  }
  return changed;
}

// ───────────────────────── possible replies (§2.8.2) ─────────────────────────

/**
 * Holds a company's open recipients (SCHEDULED, WAITING, HELD; included) for a possible reply, inside `tx`: every
 * campaign in real scope, only `campaignId` in campaign scope (M4-DESIGN §3.6). Used by reply processing for a
 * POSSIBLE_REPLY, a domain hold (§3.3.4) and the fail-safe after processing failed for good (§3.8), and by the Undo of
 * a decision. Recipients already held for it are left alone. Returns how many gained the hold and their campaigns.
 */
export async function holdCompany(
  tx: Tx,
  input: { companyId: number; reason: "possible-reply"; campaignId?: number | null; now: Date },
): Promise<{ held: number; campaignIds: number[] }> {
  const rows = await tx.campaignRecipient.findMany({
    where: { companyId: input.companyId, included: true, state: { in: [...OPEN_STATES] }, ...(input.campaignId ? { campaignId: input.campaignId } : {}) },
    select: { id: true, campaignId: true, state: true, holdReason: true },
  });
  const need = rows.filter((r) => !heldReasonsOf(r).includes(input.reason));
  const held = await holdRows(tx, need, input.reason, input.now);
  return { held, campaignIds: [...new Set(need.map((r) => r.campaignId))].sort((a, b) => a - b) };
}

/**
 * Removes "possible-reply" from the company's held recipients (in scope: every campaign, or only `campaignId`) that no
 * remaining undecided message still affects (M4-DESIGN §2.8.2), inside `tx`. The caller updates the decided message
 * first, so it no longer counts: a real-scope undecided message of the company keeps everyone held; a campaign-scope
 * one keeps its own campaign held. Two open possible replies never release each other's hold. Returns how many
 * recipients lost the reason.
 */
export async function releaseCompanyHold(
  tx: Tx,
  input: { companyId: number; reason: "possible-reply"; campaignId?: number | null; now: Date },
): Promise<{ released: number }> {
  const remaining = await undecidedHolds(tx, [input.companyId]);
  if (remaining.some((u) => u.campaignId === null)) return { released: 0 };
  const stillHeld = new Set(remaining.map((u) => u.campaignId));
  const rows = await tx.campaignRecipient.findMany({
    where: { companyId: input.companyId, state: "HELD", ...(input.campaignId ? { campaignId: input.campaignId } : {}) },
    select: { id: true, campaignId: true, currentStep: true, holdReason: true },
  });
  const free = rows.filter((r) => !stillHeld.has(r.campaignId));
  return { released: await releaseRows(tx, free, input.reason) };
}

/** One undecided message's reach: its company, and its campaign when it is in campaign scope (null = every campaign). */
export type UndecidedHold = { companyId: number; campaignId: number | null };

/** The `where` of undecided messages (M4-DESIGN §0.3), of these companies or of any. */
function undecidedWhere(companyIds: readonly number[] | null): Prisma.InboundMessageWhereInput {
  return {
    processedAt: { not: null },
    answerOutcome: null,
    OR: [
      { kind: "POSSIBLE_REPLY", companyId: companyIds ? { in: [...companyIds] } : { not: null } },
      { kind: "UNLINKED", answeredAt: null, heldCompanyId: companyIds ? { in: [...companyIds] } : { not: null } },
    ],
  };
}

const UNDECIDED_SELECT = { kind: true, companyId: true, heldCompanyId: true, campaignId: true, replyScope: true } as const;

type UndecidedRow = { kind: string | null; companyId: number | null; heldCompanyId: number | null; campaignId: number | null; replyScope: string | null };

/** A row's reach: a POSSIBLE_REPLY by its stored scope (campaign scope → its campaign), a domain-held UNLINKED row in real scope. */
function reachOf(row: UndecidedRow): UndecidedHold | null {
  if (row.kind === "POSSIBLE_REPLY" && row.companyId !== null) {
    return { companyId: row.companyId, campaignId: row.replyScope === "campaign" ? row.campaignId : null };
  }
  if (row.kind === "UNLINKED" && row.heldCompanyId !== null) return { companyId: row.heldCompanyId, campaignId: null };
  return null;
}

function distinctHolds(rows: readonly UndecidedRow[]): UndecidedHold[] {
  const out = new Map<string, UndecidedHold>();
  for (const row of rows) {
    const reach = reachOf(row);
    if (reach) out.set(`${reach.companyId}:${reach.campaignId ?? "*"}`, reach);
  }
  return [...out.values()];
}

/**
 * The undecided messages (M4-DESIGN §0.3, §2.8.2) of these companies, as (company, campaign) pairs: processed,
 * `answerOutcome` null (twins and spam never count), and either kind POSSIBLE_REPLY (real scope → campaignId null;
 * campaign scope → its campaign) or kind UNLINKED, not answered, with a domain hold (`heldCompanyId`, real scope).
 * One query per 400 companies. Used by the sending guard (§2.5.1 step 3) and by every release.
 */
export async function undecidedHolds(reader: DbOrTx, companyIds: readonly number[]): Promise<UndecidedHold[]> {
  const ids = [...new Set(companyIds)];
  const rows: UndecidedRow[] = [];
  for (const part of chunks(ids)) {
    rows.push(...(await reader.inboundMessage.findMany({ where: undecidedWhere(part), select: UNDECIDED_SELECT })));
  }
  return distinctHolds(rows);
}

/** The recipients of these companies an undecided message should hold but doesn't yet, held inside `tx`. */
async function holdPendingIn(tx: Tx, companyIds: readonly number[], campaignId: number | undefined, now: Date): Promise<number> {
  // Re-read inside the transaction: a message decided meanwhile must never leave a hold nobody releases.
  const reach = await undecidedHolds(tx, companyIds);
  if (reach.length === 0) return 0;
  const real = new Set(reach.filter((r) => r.campaignId === null).map((r) => r.companyId));
  const scoped = new Set(reach.filter((r) => r.campaignId !== null).map((r) => `${r.companyId}:${r.campaignId}`));
  const companies = [...new Set(reach.map((r) => r.companyId))];
  const rows = await tx.campaignRecipient.findMany({
    where: { companyId: { in: companies }, included: true, state: { in: [...OPEN_STATES] }, ...(campaignId ? { campaignId } : {}) },
    select: { id: true, companyId: true, campaignId: true, state: true, holdReason: true },
  });
  const need = rows.filter(
    (r) => (real.has(r.companyId) || scoped.has(`${r.companyId}:${r.campaignId}`)) && !heldReasonsOf(r).includes("possible-reply"),
  );
  return holdRows(tx, need, "possible-reply", now);
}

/**
 * Holds open recipients that an undecided message should hold but doesn't yet (M4-DESIGN §2.8.2): recipients created or
 * reopened after the message was processed (a launch, a Retry) or missed by a race. `companyIds` limits it to those
 * companies (launch: the campaign's companies; Retry: the reopened recipient's company), `campaignId` to one campaign;
 * neither = every undecided message (the 5-minute maintenance). With `tx` it runs inside that transaction (launch,
 * Retry); otherwise in transactions of 50 companies, yielding between them. Returns how many recipients were held.
 */
export async function applyPendingPossibleReplyHolds(opts: {
  companyIds?: readonly number[];
  campaignId?: number;
  now: Date;
  tx?: Tx;
}): Promise<{ held: number }> {
  const reader: DbOrTx = opts.tx ?? db;
  const reach = opts.companyIds
    ? await undecidedHolds(reader, opts.companyIds)
    : distinctHolds(await reader.inboundMessage.findMany({ where: undecidedWhere(null), select: UNDECIDED_SELECT }));
  const companies = [...new Set(reach.map((r) => r.companyId))].sort((a, b) => a - b);
  if (companies.length === 0) return { held: 0 };
  if (opts.tx) {
    let held = 0;
    for (const part of chunks(companies)) held += await holdPendingIn(opts.tx, part, opts.campaignId, opts.now);
    return { held };
  }
  let held = 0;
  for (const part of chunks(companies, COMPANIES_PER_TX)) {
    held += await dbTx((tx) => holdPendingIn(tx, part, opts.campaignId, opts.now));
    await yieldToEventLoop();
  }
  return { held };
}

// ───────────────────────── outage hold (§2.8.3) ─────────────────────────

export type OutageHoldResult = {
  /** This call marked the outage handled (the hold was applied, or none was needed). */
  applied: boolean;
  /** Recipients held for this outage (people emailed and colleagues). */
  held: number;
  /** The senders (user ids) of the held recipients' campaigns. */
  senderIds: number[];
};

type SenderCounts = Map<number | null, { followUps: number; firstEmails: number }>;

/** Recipients held for the outage, per campaign sender: people emailed (`currentStep ≥ 1`) and first emails waiting. */
async function outageHeldBySender(where: Prisma.CampaignRecipientWhereInput): Promise<SenderCounts> {
  const rows = await db.campaignRecipient.findMany({
    where: { ...where, state: "HELD", holdReason: { in: OUTAGE_VALUES } },
    select: { currentStep: true, campaign: { select: { senderId: true } } },
  });
  const out: SenderCounts = new Map();
  for (const r of rows) {
    const c = out.get(r.campaign.senderId) ?? { followUps: 0, firstEmails: 0 };
    if (r.currentStep >= 1) c.followUps += 1;
    else c.firstEmails += 1;
    out.set(r.campaign.senderId, c);
  }
  return out;
}

function totals(counts: SenderCounts): { followUps: number; firstEmails: number } {
  let followUps = 0;
  let firstEmails = 0;
  for (const c of counts.values()) {
    followUps += c.followUps;
    firstEmails += c.firstEmails;
  }
  return { followUps, firstEmails };
}

/**
 * Who an outage holds (M4-DESIGN §2.8.3 steps 4–5), as recipient ids: (a) the follow-ups (`currentStep ≥ 1`, WAITING or
 * already HELD, e.g. for a possible reply) of TEST/LIVE campaigns that may still send, whose newest SENT email went out
 * before `to` (a reply to it may have arrived unseen); (b) everyone else open at those companies (SCHEDULED, WAITING,
 * HELD) in any TEST/LIVE campaign that may still send, any sender, first emails to colleagues included. Dry runs never.
 */
async function outageTargets(to: Date): Promise<number[]> {
  const campaign: Prisma.CampaignWhereInput = { mode: { in: [...OUTAGE_MODES] }, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } };
  const followUps = await db.campaignRecipient.findMany({
    where: { included: true, state: { in: ["WAITING", "HELD"] }, currentStep: { gte: 1 }, campaign },
    select: { id: true, companyId: true },
  });
  const kept: Array<{ id: number; companyId: number }> = [];
  for (const part of chunks(followUps)) {
    const last = await db.outboundEmail.groupBy({
      by: ["recipientId"],
      where: { recipientId: { in: part.map((r) => r.id) }, status: "SENT" },
      _max: { sentAt: true },
    });
    const lastSent = new Map(last.map((l) => [l.recipientId, l._max.sentAt]));
    for (const r of part) {
      const at = lastSent.get(r.id);
      if (at && at.getTime() < to.getTime()) kept.push(r);
    }
  }
  const ids = new Set(kept.map((r) => r.id));
  for (const part of chunks([...new Set(kept.map((r) => r.companyId))])) {
    const others = await db.campaignRecipient.findMany({
      where: { companyId: { in: part }, included: true, state: { in: [...OPEN_STATES] }, campaign },
      select: { id: true },
    });
    for (const o of others) ids.add(o.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** What one user's `outage.hold` notification says: the window (ISO) and counts, in that user's zone. */
export type OutageHoldCopyInput =
  | { audience: "sender"; from: string; to: string; zone: string | null; now: Date; followUps: number; firstEmails: number }
  | { audience: "owner"; from: string; to: string; zone: string | null; now: Date; followUps: number; bySender: ReadonlyArray<{ name: string; count: number }> };

/**
 * The `outage.hold` notification (M4-DESIGN §5.1), built for one user with the dates in that user's own time zone:
 * the sender version ("Check your inbox … then click I've checked my inbox"), linking to their On hold card, or the
 * Owner version with the count per sender, linking to Settings › Sending & Mailgun.
 * `from`/`to` is the unchecked window (catch-up.ts: from the last point checked to the oldest part of Mailgun's logs):
 * the days whose replies may have been missed, not the time the PC was off (it came back days after `to`), so the title
 * names it that way: "Follow-ups are on hold: replies from 24 Sept to 26 Sept may have been missed".
 */
export function outageHoldCopy(input: OutageHoldCopyInput): { type: string; title: string; body: string; link: string } {
  const zone = safeZone(input.zone);
  const title = `Follow-ups are on hold: replies from ${formatShortDate(input.from, zone, input.now)} to ${formatShortDate(input.to, zone, input.now)} may have been missed`;
  if (input.audience === "sender") {
    const colleagues =
      input.firstEmails > 0 ? ` First emails to ${plural(input.firstEmails, "other person", "other people")} at those companies wait too.` : "";
    return {
      type: OUTAGE_HOLD_NOTIFICATION,
      title,
      body:
        "The PC was off too long for the app to see every reply. Check your inbox for replies to your campaigns from those days, " +
        `then click I've checked my inbox. Follow-ups of ${plural(input.followUps, "person", "people")} are waiting.${colleagues}`,
      link: "/notifications#on-hold",
    };
  }
  const list = input.bySender.map((s) => `${s.name} ${s.count.toLocaleString("en-US")}`).join(", ");
  return {
    type: OUTAGE_HOLD_NOTIFICATION,
    title,
    body:
      `Follow-ups of ${plural(input.followUps, "person", "people")} wait until their senders have checked their inbox${list ? ` (${list})` : ""}. ` +
      "You can continue them for anyone in Settings › Sending & Mailgun.",
    link: "/settings/sending",
  };
}

/**
 * After an applied hold (M4-DESIGN §2.8.3 step 8): one `outage.hold` per active sender with people held (not the
 * Owner, who gets the Owner version even when also a sender), one for the Owner (switched-off senders and campaigns
 * without a sender are counted there), and one date-free `followups.held` activity, all in one transaction.
 */
async function announceOutageHold(counts: SenderCounts, window: { from: string; to: string }, now: Date): Promise<void> {
  const { followUps, firstEmails } = totals(counts);
  const ownerId = await activeOwnerId();
  const ids = [...counts.keys()].filter((id): id is number => id !== null);
  if (ownerId !== null) ids.push(ownerId);
  const users = new Map(
    (await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true, timeZone: true } })).map((u) => [u.id, u]),
  );
  const nameOf = (id: number | null) => (id === null ? UNKNOWN_SENDER_NAME : (users.get(id)?.name ?? UNKNOWN_SENDER_NAME));
  const bySender = [...counts]
    .filter(([, c]) => c.followUps > 0)
    .map(([id, c]) => ({ name: nameOf(id), count: c.followUps }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const colleagues = firstEmails > 0 ? ` First emails to ${plural(firstEmails, "other person", "other people")} at those companies wait too.` : "";
  await dbTx(async (tx) => {
    for (const [senderId, c] of counts) {
      const user = senderId === null ? undefined : users.get(senderId);
      if (!user || !user.active || user.id === ownerId || c.followUps === 0) continue;
      const copy = outageHoldCopy({ audience: "sender", ...window, zone: user.timeZone, now, followUps: c.followUps, firstEmails: c.firstEmails });
      await createNotification({ userId: user.id, ...copy }, tx);
    }
    if (ownerId !== null) {
      const copy = outageHoldCopy({ audience: "owner", ...window, zone: users.get(ownerId)?.timeZone ?? null, now, followUps, bySender });
      await createNotification({ userId: ownerId, ...copy }, tx);
    }
    await logActivity(
      {
        actorId: null,
        type: "followups.held",
        summary: `Follow-ups of ${plural(followUps, "person", "people")} were put on hold because the PC was off too long to check for replies.${colleagues}`,
        data: { from: window.from, to: window.to, count: followUps + firstEmails, followUps, firstEmails },
      },
      tx,
    );
  });
}

let outageRun: Promise<OutageHoldResult> | null = null;

/**
 * Applies the outage hold (M4-DESIGN §2.8.3 step 3), called by the catch-up job's onSuccess, at worker start-up and by
 * the 5-minute maintenance as a retry. Single-flight: a second call while one runs gets that run's result.
 *  1. Nothing found, or already handled → `{applied: false}`.
 *  2. Only Mailgun's message retention was passed (no log gap) → marked handled, nobody held.
 *  3. The gap lies inside the window already held (defence) → marked handled, nobody re-held.
 *  4–6. The follow-ups sent before the end of the unchecked window and everyone else open at those companies (TEST/LIVE
 *     only) gain the reason "outage", in transactions of 500 rows that each re-read the record and stop when it was
 *     handled or its gap changed meanwhile.
 *  7. A final compare-and-set marks it handled (`heldFor`, `heldTo`, `heldCount`); only then
 *  8. `outage.hold` notifications (per user, dates in their own zone) and the `followups.held` activity, when follow-ups
 *     were held.
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O27, `loadTeamFrom().replies`): replies never pass through Mailgun, so a gap in
 * its logs says nothing about them; the found gap is marked handled with nobody held (`heldCount: 0`, the window kept
 * for "Details") and `[outage] own-mailbox mode: no hold` is logged once. The daily inbox check holds the follow-ups.
 */
export async function applyOutageHold(opts: { now?: Date } = {}): Promise<OutageHoldResult> {
  if (outageRun) return outageRun;
  const run = runOutageHold(opts.now ?? new Date());
  outageRun = run;
  try {
    return await run;
  } finally {
    if (outageRun === run) outageRun = null;
  }
}

async function runOutageHold(now: Date): Promise<OutageHoldResult> {
  const none: OutageHoldResult = { applied: false, held: 0, senderIds: [] };
  const state = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
  if (state.handledAt !== null) return none;
  const handledNow = (cur: OutageState) => ({ ...cur, handledAt: now.toISOString() });

  if (state.from === null) {
    if (!state.beyondMessageRetention) return none;
    const res = await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) =>
      cur.handledAt === null && cur.from === null ? handledNow(cur) : null,
    );
    return { ...none, applied: res.written };
  }

  const heldFrom = state.from;
  const heldTo = state.to ?? now.toISOString();
  const sameGap = (cur: OutageState) => cur.handledAt === null && cur.from === heldFrom && (cur.to ?? heldTo) === heldTo;
  if ((await loadTeamFrom()).replies === "own-mailbox") {
    const res = await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) =>
      sameGap(cur) ? { ...handledNow(cur), heldFor: heldFrom, heldTo, heldCount: 0 } : null,
    );
    if (res.written) console.log("[outage] own-mailbox mode: no hold");
    return { ...none, applied: res.written };
  }
  if (outageGapCovered(state, { from: heldFrom })) {
    const res = await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) => (sameGap(cur) ? handledNow(cur) : null));
    return { ...none, applied: res.written };
  }

  const targets = await outageTargets(new Date(heldTo));
  for (const part of chunks(targets, TX_ROWS)) {
    const go = await dbTx(async (tx) => {
      const row = await tx.systemState.findUnique({ where: { key: STATE_KEYS.outage }, select: { value: true } });
      if (!sameGap(parseOutageState(row?.value ?? null))) return false;
      const rows = await tx.campaignRecipient.findMany({
        where: { id: { in: part }, included: true, state: { in: [...OPEN_STATES] } },
        select: { id: true, state: true, holdReason: true },
      });
      await holdRows(tx, rows.filter((r) => !heldReasonsOf(r).includes("outage")), "outage", now);
      return true;
    });
    // Handled elsewhere, or a bigger gap was merged in: the next run holds for the record as it is now.
    if (!go) return none;
    await yieldToEventLoop();
  }

  const counts: SenderCounts = new Map();
  for (const part of chunks(targets)) {
    for (const [senderId, c] of await outageHeldBySender({ id: { in: part } })) {
      const cur = counts.get(senderId) ?? { followUps: 0, firstEmails: 0 };
      counts.set(senderId, { followUps: cur.followUps + c.followUps, firstEmails: cur.firstEmails + c.firstEmails });
    }
  }
  const { followUps, firstEmails } = totals(counts);
  const held = followUps + firstEmails;
  const senderIds = [...counts.keys()].filter((id): id is number => id !== null).sort((a, b) => a - b);
  const cas = await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) =>
    sameGap(cur) ? { ...handledNow(cur), heldFor: heldFrom, heldTo, heldCount: held } : null,
  );
  if (!cas.written) return { applied: false, held, senderIds };
  if (followUps > 0) await announceOutageHold(counts, { from: heldFrom, to: heldTo }, now);
  return { applied: true, held, senderIds };
}

/**
 * A recipient just released from RECHECK (M5-DESIGN §2.7 settle table): when its company already has a recipient held
 * for the outage (any campaign), this one gets the outage hold too, inside `tx`, like everyone else open at that
 * company when the hold was applied (§2.8.3 step 5). Only an included, open recipient of a TEST/LIVE campaign, not held
 * for the outage yet. Returns true when it was held.
 */
export async function holdForOutageIfCompanyHeld(tx: Tx, recipientId: number, now: Date): Promise<boolean> {
  const r = await tx.campaignRecipient.findUnique({
    where: { id: recipientId },
    select: { id: true, companyId: true, state: true, holdReason: true, included: true, campaign: { select: { mode: true } } },
  });
  if (!r || !r.included || !OPEN_STATES.includes(r.state) || heldReasonsOf(r).includes("outage")) return false;
  if (!r.campaign.mode || !OUTAGE_MODES.includes(r.campaign.mode)) return false;
  const held = await tx.campaignRecipient.findFirst({
    where: { companyId: r.companyId, id: { not: r.id }, state: "HELD", holdReason: { in: OUTAGE_VALUES } },
    select: { id: true },
  });
  if (!held) return false;
  return (await holdRows(tx, [r], "outage", now)) > 0;
}

/** "Ali's". */
function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * Releases the outage hold of colleagues (`currentStep = 0`) at every company where no recipient that was already
 * emailed (`currentStep ≥ 1`) is still held for the outage (M4-DESIGN §2.8.3 release step 2): a colleague's first
 * email waits until every sender who emailed that company has checked their inbox, and no longer once nobody there
 * is left to check (e.g. the emailed person bounced, or their campaign was cancelled). Transactions of 50 companies,
 * each re-checking inside. Returns how many recipients were released.
 */
export async function releaseOrphanedOutageHolds(): Promise<{ released: number }> {
  const res = await sweepOrphanedOutageHolds();
  if (res.failure) throw res.failure.error;
  return { released: res.released };
}

/** How many recipients a release has let go so far: the sender's people, and colleagues' first emails. */
type ReleaseCounts = { released: number; firstEmails: number };
/** The `followups.released` entry a release wrote, and the counts written in it. */
type ReleaseEntry = { id: number; counts: ReleaseCounts };
/**
 * Called inside a chunk transaction that has released `released` recipients so far (this chunk's included, at least
 * one): writes the release's audit entry in that same transaction, unless an earlier one already did (then null).
 */
type ReleaseRecorder = (tx: Tx, released: number) => Promise<ReleaseEntry | null>;

/**
 * `releaseOrphanedOutageHolds` without throwing: a failure after some chunks committed still reports what they released
 * (`failure` holds the error), and `record` (a release's audit entry) runs inside the chunk transactions that release
 * anyone.
 */
async function sweepOrphanedOutageHolds(
  record?: ReleaseRecorder,
): Promise<{ released: number; entry: ReleaseEntry | null; failure: { error: unknown } | null }> {
  let released = 0;
  let entry: ReleaseEntry | null = null;
  try {
    const firsts = await db.campaignRecipient.findMany({
      where: { state: "HELD", holdReason: { in: OUTAGE_VALUES }, currentStep: 0 },
      select: { companyId: true },
      distinct: ["companyId"],
    });
    const companies = firsts.map((r) => r.companyId).sort((a, b) => a - b);
    for (const part of chunks(companies, COMPANIES_PER_TX)) {
      const res = await dbTx(async (tx) => {
        const busy = new Set(
          (
            await tx.campaignRecipient.findMany({
              where: { companyId: { in: part }, state: "HELD", holdReason: { in: OUTAGE_VALUES }, currentStep: { gte: 1 } },
              select: { companyId: true },
              distinct: ["companyId"],
            })
          ).map((r) => r.companyId),
        );
        const free = part.filter((c) => !busy.has(c));
        if (free.length === 0) return { n: 0, entry: null };
        const rows = await tx.campaignRecipient.findMany({
          where: { companyId: { in: free }, state: "HELD", holdReason: { in: OUTAGE_VALUES }, currentStep: 0 },
          select: { id: true, currentStep: true, holdReason: true },
        });
        const n = await releaseRows(tx, rows, "outage");
        return { n, entry: n > 0 && record ? await record(tx, released + n) : null };
      });
      // Counted only once the chunk committed (a retried chunk starts again from the same count).
      released += res.n;
      entry ??= res.entry;
      await yieldToEventLoop();
    }
    return { released, entry, failure: null };
  } catch (error) {
    return { released, entry, failure: { error } };
  }
}

/** The `followups.released` summary (M4-DESIGN §2.8.3 release step 3): "Ali checked their inbox: follow-ups of 8 people continue". */
function releaseSummary(actorName: string, who: { own: boolean; senderName: string | null }, counts: ReleaseCounts): string {
  const { released, firstEmails } = counts;
  const people = plural(released, "person", "people");
  const colleagues = plural(firstEmails, released > 0 ? "other person" : "person", released > 0 ? "other people" : "people");
  if (released === 0) return `${actorName} continued first emails to ${colleagues} after the PC was off`;
  if (who.own) return `${actorName} checked their inbox: follow-ups of ${people} continue${firstEmails > 0 ? `, and first emails to ${colleagues}` : ""}`;
  const whose = who.senderName === null ? "the follow-ups of campaigns whose sender account is gone" : `${possessive(who.senderName)} follow-ups`;
  return `${actorName} continued ${whose} after the PC was off (${people})${firstEmails > 0 ? `; first emails to ${colleagues} continue too` : ""}`;
}

/** Writes one activity entry inside `tx` and returns its id (the newest of its type by that actor: `tx` holds the write lock). */
async function writeEntry(tx: Tx, a: ActivityInput): Promise<number> {
  await logActivity(a, tx);
  const row = await tx.activityLog.findFirst({ where: { type: a.type, actorId: a.actorId }, orderBy: { id: "desc" }, select: { id: true } });
  if (!row) throw new Error(`The ${a.type} entry just written wasn't found.`);
  return row.id;
}

/** Said when a release stopped half-way because the database stayed busy: what was released stays released. */
export function unfinishedReleaseText(released: number): string {
  return `Follow-ups of ${plural(released, "person", "people")} continue, but the app was too busy to finish. Try again in a moment for the rest.`;
}

/**
 * "I've checked my inbox" / "Continue Ali's follow-ups" (M4-DESIGN §2.8.3 "Release", §9.1, §9.9): the sender for their
 * own campaigns, or the Owner for any sender (`senderId` null = campaigns whose sender account is gone). Removes
 * "outage" from the sender's held people who were already emailed (`currentStep ≥ 1`), in transactions of 500 rows
 * (compare-and-set on HELD), then releases colleagues' first emails at every company where nobody emailed is still held
 * (`releaseOrphanedOutageHolds`), and logs `followups.released`. Throws a CampaignError with the plain sentence when a
 * Member acts for someone else ("Only Ali or the Owner can continue Ali's follow-ups.", code "not-allowed") or when
 * nothing is held ("Nothing of yours is on hold." / "Nothing is on hold for Ali.", code "nothing-held").
 * `released` = the sender's people whose follow-ups continue; `firstEmails` = colleagues' first emails released too.
 *
 * The audit entry (who confirmed they checked their inbox, and when) is written inside the first transaction that
 * releases anyone, so it exists as soon as anything was released; its counts are brought up to date at the end when more
 * followed (further chunks, colleagues). When a later chunk fails because the database stayed busy, what was released
 * stays released and recorded, and a CampaignError (code "unfinished", `unfinishedReleaseText`) asks the person to try
 * again for the rest; when only the colleagues' release fails, it is logged and the 5-minute maintenance releases them.
 */
export async function releaseOutageHold(
  actor: { id: number; name: string; role: "OWNER" | "MEMBER" },
  input: { senderId: number | null; now?: Date },
): Promise<{ released: number; firstEmails: number }> {
  const senderId = input.senderId;
  const own = senderId !== null && senderId === actor.id;
  const senderName =
    senderId === null ? null : ((await db.user.findUnique({ where: { id: senderId }, select: { name: true } }))?.name ?? UNKNOWN_SENDER_NAME);
  if (!own && actor.role !== "OWNER") {
    throw new CampaignError(
      senderName === null
        ? "Only the Owner can continue these follow-ups."
        : `Only ${senderName} or the Owner can continue ${possessive(senderName)} follow-ups.`,
      "not-allowed",
    );
  }

  // Everything the entry needs is read before the first write: once anything is released, nothing may keep it unwritten.
  const window = heldWindow((await readTyped(STATE_KEYS.outage, parseOutageState)).value);
  const entryFor = (counts: ReleaseCounts): ActivityInput => ({
    actorId: actor.id,
    type: "followups.released",
    summary: releaseSummary(actor.name, { own, senderName }, counts),
    data: { count: counts.released, senderId, firstEmails: counts.firstEmails, from: window.from, to: window.to },
  });
  let entry: ReleaseEntry | null = null;
  // Runs inside a chunk transaction; `entry` is only set once that transaction committed, so a retried chunk writes again.
  const record = async (tx: Tx, counts: ReleaseCounts): Promise<ReleaseEntry | null> =>
    entry === null ? { id: await writeEntry(tx, entryFor(counts)), counts } : null;

  const emailed = await db.campaignRecipient.findMany({
    where: { state: "HELD", holdReason: { in: OUTAGE_VALUES }, currentStep: { gte: 1 }, campaign: { senderId } },
    select: { id: true },
  });
  let released = 0;
  let unfinished = false;
  for (const part of chunks(emailed.map((r) => r.id), TX_ROWS)) {
    try {
      const res = await dbTx(async (tx) => {
        const rows = await tx.campaignRecipient.findMany({
          where: { id: { in: part }, state: "HELD" },
          select: { id: true, currentStep: true, holdReason: true },
        });
        const n = await releaseRows(tx, rows, "outage");
        return { n, entry: n > 0 ? await record(tx, { released: released + n, firstEmails: 0 }) : null };
      });
      released += res.n;
      entry ??= res.entry;
    } catch (err) {
      // Nothing released yet: nothing was saved, and the person is told so as usual.
      if (entry === null) throw err;
      console.error("[holds] couldn't release the rest of an outage hold; the person can try again", err);
      unfinished = true;
      break;
    }
    await yieldToEventLoop();
  }

  let firstEmails = 0;
  if (!unfinished) {
    const sweep = await sweepOrphanedOutageHolds((tx, n) => record(tx, { released, firstEmails: n }));
    firstEmails = sweep.released;
    entry ??= sweep.entry;
    if (sweep.failure) {
      if (entry === null) throw sweep.failure.error;
      console.error("[holds] couldn't release colleagues' first emails after an outage hold; the 5-minute maintenance does", sweep.failure.error);
    }
  }
  if (entry === null) {
    throw new CampaignError(
      own
        ? "Nothing of yours is on hold."
        : senderName === null
          ? "Nothing is on hold for campaigns whose sender account is gone."
          : `Nothing is on hold for ${senderName}.`,
      "nothing-held",
    );
  }

  if (entry.counts.released !== released || entry.counts.firstEmails !== firstEmails) {
    const final = entryFor({ released, firstEmails });
    const id = entry.id;
    try {
      await dbWrite((c) => c.activityLog.update({ where: { id }, data: { summary: final.summary, data: final.data } }));
    } catch (err) {
      // The entry stays, with the counts of the first release.
      console.error("[holds] couldn't bring the followups.released entry up to date", err);
    }
  }
  if (unfinished) throw new CampaignError(unfinishedReleaseText(released), "unfinished");
  return { released, firstEmails };
}

// ───────────────────────── outage summaries ─────────────────────────

/** The outage and its hold as Settings › Sending & Mailgun shows them (`outageHoldSummary`). */
export type OutageHoldSummary = {
  /** A log gap was found, or replies came back without their text. */
  detected: boolean;
  /** The hold was applied (or found unnecessary): `handledAt` is set. */
  applied: boolean;
  /** The window (ISO): the gap found; once handled, the window that was held. Null without a log gap. */
  from: string | null;
  to: string | null;
  /** Every recipient still held for the outage: people emailed and colleagues' first emails (split in `bySender`). */
  total: number;
  /** Only Mailgun's stored-message retention was passed (replies recovered without text), no log gap. */
  textOnly: boolean;
  bySender: Array<{ userId: number | null; name: string; active: boolean; held: number; firstEmailsWaiting: number }>;
};

/** The window of the hold that holds people now: the last applied hold's, else the gap found. */
function heldWindow(s: OutageState): { from: string | null; to: string | null } {
  return s.heldFor !== null ? { from: s.heldFor, to: s.heldTo } : { from: s.from, to: s.to };
}

/**
 * Settings › Sending & Mailgun's outage lines (M4-DESIGN §9.9): whether an outage was found and its hold applied, the
 * window (the gap found; once handled, the window that was held), the people still held per sender (`held` = people
 * the sender emailed, `firstEmailsWaiting` = first emails to colleagues in their campaigns; switched-off senders and
 * campaigns without a sender included), most held first.
 */
export async function outageHoldSummary(): Promise<OutageHoldSummary> {
  const state = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
  const counts = await outageHeldBySender({});
  const ids = [...counts.keys()].filter((id): id is number => id !== null);
  const users = new Map(
    (ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true } }) : []).map((u) => [u.id, u]),
  );
  const bySender = [...counts]
    .map(([userId, c]) => {
      const user = userId === null ? undefined : users.get(userId);
      return {
        userId,
        name: user?.name ?? UNKNOWN_SENDER_NAME,
        active: user?.active ?? false,
        held: c.followUps,
        firstEmailsWaiting: c.firstEmails,
      };
    })
    .sort((a, b) => b.held - a.held || b.firstEmailsWaiting - a.firstEmailsWaiting || a.name.localeCompare(b.name));
  const { followUps, firstEmails } = totals(counts);
  const window = state.from === null ? { from: null, to: null } : state.handledAt !== null ? heldWindow(state) : { from: state.from, to: state.to };
  return {
    detected: state.from !== null || state.beyondMessageRetention,
    applied: state.handledAt !== null,
    from: window.from,
    to: window.to,
    total: followUps + firstEmails,
    textOnly: state.beyondMessageRetention && state.from === null,
    bySender,
  };
}

/**
 * One sender's "On hold" card on the Notifications page (M4-DESIGN §9.1): the people they emailed who are held for the
 * outage, their first emails waiting for other senders to check, and the window of the hold (null when none).
 */
export async function myOutageHold(userId: number): Promise<{ held: number; firstEmailsWaiting: number; from: string | null; to: string | null }> {
  const state = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
  const mine = (await outageHeldBySender({ campaign: { senderId: userId } })).get(userId) ?? { followUps: 0, firstEmails: 0 };
  const window = heldWindow(state);
  return { held: mine.followUps, firstEmailsWaiting: mine.firstEmails, from: window.from, to: window.to };
}
