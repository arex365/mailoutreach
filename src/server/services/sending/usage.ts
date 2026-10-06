import type { SendMode, SendStatus } from "@/generated/prisma/client";
import { capDayBounds, capDayOf, safeZone, type CapDay } from "@/core/sending/capday";
import { capacityLeft, domainCapFor, warmupCapFor, warmupTable } from "@/core/sending/caps";
import type { HealthCounts } from "@/core/sending/health";
import type { CapOverride } from "@/core/setting-types";
import { parseCapOverride, parseWarmupState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { realModes } from "@/core/rules/mode";
import { loadEffectiveMaxDailyCap } from "@/server/services/mailgun/plan";
import { db, type DbOrTx } from "../../db";
import { getSettings } from "../../settings";
import { readTyped } from "../../state-typed";

/**
 * Today's limit and how much of it is used (M3-DESIGN §4.2.5, PLAN B6.6), plus the counts behind the health check.
 * Nothing here is stored: the counters are counted from OutboundEmail and TestSend rows every time, so a crash can
 * never leave them wrong.
 */

export type TodayCap = {
  capDay: CapDay;
  capZone: string;
  dayStart: Date;
  dayEnd: Date;
  cap: number;
  source: "warmup" | "override";
  aboveSchedule: boolean;
  override: CapOverride | null;
  warmupCap: number;
  /** 0-based index into the warm-up table. */
  warmupStep: number;
  warmupSteps: number;
  maxCap: number;
  /** Counted campaign sends + test sends this cap day. */
  used: number;
  testSends: number;
  left: number;
  /** Counted campaign sends per senderId (test sends not included). */
  bySender: ReadonlyMap<number, number>;
};

/** Sends that may already have gone out count from their claim time until they are decided. */
const MAYBE_SENT: SendStatus[] = ["SENDING", "UNKNOWN", "UNCONFIRMED"];
const IN_CHUNK = 400;

/**
 * Counted campaign sends in [start, end), per sender: OutboundEmail in a counted mode (`realModes`) that is SENT with
 * `sentAt` in the range, or SENDING/UNKNOWN/UNCONFIRMED with `claimedAt` in it. Test sends are not included.
 *
 * The SENT rows are found by `sentAt` alone and kept when SENT here (only markSent writes `sentAt`, together with SENT;
 * any other row with a `sentAt` is simply not counted). A `status` condition next to the `sentAt` range makes SQLite
 * read every SENT email ever sent through the (status, dueAt) index instead of the range through the `sentAt` one
 * (review DASHBOARD-2; `tests/integration/sending/query-plans.test.ts`; eligibility.ts's history does the same). The
 * maybe-sent rows are few, so their own query may use the status index.
 */
export async function countedCampaignSends(
  start: Date,
  end: Date,
  practiceCopy: boolean,
): Promise<{ total: number; bySender: Map<number, number> }> {
  const modes = realModes(practiceCopy);
  const sent = await db.outboundEmail.groupBy({
    by: ["senderId", "status"],
    where: { mode: { in: modes }, sentAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const maybe = await db.outboundEmail.groupBy({
    by: ["senderId"],
    where: { mode: { in: modes }, status: { in: MAYBE_SENT }, claimedAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const bySender = new Map<number, number>();
  let total = 0;
  const add = (senderId: number | null, count: number) => {
    total += count;
    if (senderId !== null) bySender.set(senderId, (bySender.get(senderId) ?? 0) + count);
  };
  for (const g of sent) if (g.status === "SENT") add(g.senderId, g._count._all);
  for (const g of maybe) add(g.senderId, g._count._all);
  return { total, bySender };
}

/**
 * The cap day's limit (warm-up step or the Owner's override for today, never above the maximum) and its usage:
 *  - campaign sends: OutboundEmail in a counted mode (LIVE; DRY_RUN too in the practice copy; TEST never) that is SENT
 *    with sentAt in the cap day, or SENDING/UNKNOWN/UNCONFIRMED with claimedAt in the cap day;
 *  - test sends ("Send me a test", reply tests): TestSend with status ≠ FAILED and sentAt in the cap day.
 * The warm-up step counts only for the domain it belongs to: a different sending domain starts again at step 0.
 *
 * The maximum daily limit (and so the warm-up table) is `loadEffectiveMaxDailyCap()` (MAIN-DOMAIN-DESIGN O23): the saved
 * maximum, never above the Mailgun plan's daily limit minus the test reserve (90 on Free). Without a chosen plan in app
 * mode it is the saved number, exactly as before.
 */
export async function getTodayCap(now: Date, opts: { practiceCopy?: boolean } = {}): Promise<TodayCap> {
  const s = await getSettings([
    "sending.capDayTimeZone",
    "sending.capOverride",
    "warmup.startCap",
    "warmup.steps",
    "mailgun.domain",
    "practice.copy",
  ] as const);
  const practiceCopy = opts.practiceCopy ?? s["practice.copy"] === true;
  const capZone = safeZone(s["sending.capDayTimeZone"]);
  const capDay = capDayOf(now, capZone);
  const { start: dayStart, end: dayEnd } = capDayBounds(capDay, capZone);

  const { maxCap } = await loadEffectiveMaxDailyCap();
  const table = warmupTable(Number(s["warmup.startCap"]), maxCap, Number(s["warmup.steps"]));
  const warmup = (await readTyped(STATE_KEYS.warmup, parseWarmupState)).value;
  const currentDomain = s["mailgun.domain"] ?? "";
  const warmupStep = warmup.domain === currentDomain ? Math.min(warmup.step, table.length - 1) : 0;
  const override = parseCapOverride(s["sending.capOverride"]);
  const dc = domainCapFor({ capDay, warmupCap: warmupCapFor(warmupStep, table), maxCap, override });

  const { total: campaignSends, bySender } = await countedCampaignSends(dayStart, dayEnd, practiceCopy);
  const testSends = await db.testSend.count({
    where: { status: { not: "FAILED" }, sentAt: { gte: dayStart, lt: dayEnd } },
  });
  const used = campaignSends + testSends;

  return {
    capDay,
    capZone,
    dayStart,
    dayEnd,
    cap: dc.cap,
    source: dc.source,
    aboveSchedule: dc.aboveSchedule,
    override: dc.source === "override" ? override : null,
    warmupCap: dc.warmupCap,
    warmupStep,
    warmupSteps: table.length,
    maxCap: dc.maxCap,
    used,
    testSends,
    left: capacityLeft(dc.cap, used),
    bySender,
  };
}

/**
 * Emails handed to Mailgun since `since` (MAIN-DOMAIN-DESIGN O23, §2.8, the rolling guard of a plan with a daily limit):
 * the larger of
 *  (a) what the app counts itself: OutboundEmail rows with mode TEST or LIVE that are SENT with `sentAt ≥ since`, or
 *      SENDING/UNKNOWN/UNCONFIRMED with `claimedAt ≥ since` (test-mode emails count: Mailgun charged for them), plus
 *      TestSend rows ("Send me a test", reply-test emails) with status ≠ FAILED and `sentAt ≥ since`;
 *  (b) what Mailgun reported: the distinct non-empty `messageId`s of MailEvent rows with `type = "accepted"` and
 *      `occurredAt ≥ since`, on every domain (the limit is the account's, so other senders and test sends lost to a
 *      restore count too).
 * `oldestAt` is the oldest counted time of whichever count won (a tie: the app's own), so the caller knows when room
 * opens again (`oldestAt + 24 h`); null when nothing was counted.
 *
 * The SENT rows are found by `sentAt` alone and kept when SENT here, as `countedCampaignSends` does (review DASHBOARD-2).
 * Settings and rows only; no Mailgun. Pass `tx` to count inside an open transaction. `opts.exceptEmailId` leaves one
 * campaign email out of the app's own count: the loop's final check counts everything but the email it has claimed
 * (review SEND-2).
 */
export async function countMailgunSendsSince(
  since: Date,
  reader: DbOrTx = db,
  opts: { exceptEmailId?: number } = {},
): Promise<{ total: number; oldestAt: Date | null }> {
  const MAILGUN_MODES: SendMode[] = ["TEST", "LIVE"];
  const oldest = (a: Date | null, b: Date | null): Date | null => (a && b ? (a.getTime() <= b.getTime() ? a : b) : (a ?? b));
  const except = opts.exceptEmailId;

  const sentRows = await reader.outboundEmail.findMany({
    where: { mode: { in: MAILGUN_MODES }, sentAt: { gte: since } },
    select: { id: true, status: true, sentAt: true },
  });
  let local = 0;
  let localOldest: Date | null = null;
  for (const r of sentRows) {
    if (r.status !== "SENT" || !r.sentAt || r.id === except) continue;
    local++;
    localOldest = oldest(localOldest, r.sentAt);
  }
  const maybe = await reader.outboundEmail.aggregate({
    where: {
      mode: { in: MAILGUN_MODES },
      status: { in: MAYBE_SENT },
      claimedAt: { gte: since },
      ...(except !== undefined ? { id: { not: except } } : {}),
    },
    _count: { _all: true },
    _min: { claimedAt: true },
  });
  local += maybe._count._all;
  localOldest = oldest(localOldest, maybe._min.claimedAt);
  const tests = await reader.testSend.aggregate({
    where: { status: { not: "FAILED" }, sentAt: { gte: since } },
    _count: { _all: true },
    _min: { sentAt: true },
  });
  local += tests._count._all;
  localOldest = oldest(localOldest, tests._min.sentAt);

  const accepted = await reader.mailEvent.findMany({
    where: { type: "accepted", occurredAt: { gte: since }, messageId: { not: null } },
    select: { messageId: true, occurredAt: true },
  });
  const firstById = new Map<string, Date>();
  for (const e of accepted) {
    const id = (e.messageId ?? "").trim().toLowerCase();
    if (!id) continue;
    const seen = firstById.get(id);
    if (!seen || e.occurredAt.getTime() < seen.getTime()) firstById.set(id, e.occurredAt);
  }
  let mailgunOldest: Date | null = null;
  for (const at of firstById.values()) mailgunOldest = oldest(mailgunOldest, at);

  if (firstById.size > local) return { total: firstById.size, oldestAt: mailgunOldest };
  return { total: local, oldestAt: local > 0 ? localOldest : null };
}

/**
 * The user's "Send me a test" emails this cap day, any status except FAILED (B10 allows 20 a day). Only purpose SELF
 * counts: the reply test's emails (REPLY_TEST, sent in the Owner's name) never use up that allowance, though they
 * still count toward today's domain limit (getTodayCap). Pass `tx` to count inside the same write that inserts the
 * next one, so two clicks at once can't both pass the limit.
 */
export async function countUserTestSends(userId: number, now: Date, tx?: DbOrTx): Promise<number> {
  const reader = tx ?? db;
  const zoneRow = await reader.setting.findUnique({ where: { key: "sending.capDayTimeZone" }, select: { value: true } });
  const zone = safeZone(typeof zoneRow?.value === "string" ? zoneRow.value : null);
  const { start, end } = capDayBounds(capDayOf(now, zone), zone);
  return reader.testSend.count({ where: { userId, purpose: "SELF", status: { not: "FAILED" }, sentAt: { gte: start, lt: end } } });
}

/** Health counts over fixed windows: the pure rules' own type (@/core/sending/health), re-exported for callers here. */
export type { HealthCounts };
/** The counts plus the emails behind them (newest first), for the Deliverability page's "counted now" tables. */
export type HealthCountsWithIds = HealthCounts & { bounceEmailIds: number[]; complaintEmailIds: number[] };

/**
 * The bounce and complaint counts behind the health check and the Deliverability page (§4.2.5, §9.2 item 6):
 *  - the sample: the newest `window` OutboundEmail rows in a counted mode, SENT, with sentAt after `since` (and
 *    before `before` when given);
 *  - bounces: those with a permanent `failed` event that isn't test mode and isn't a `suppress-*` drop;
 *  - complaints: those with a `complained` event that isn't test mode (a `suppress-complaint` drop never counts).
 * Each email counts once however many events it has. The ids (newest first) feed the "counted now" tables.
 *
 * The sample is read newest first through the `sentAt` index with the SENT check done here, not in the SQL: a `status`
 * condition makes SQLite read and sort every SENT email ever sent through the (status, dueAt) index (review
 * DASHBOARD-2). Only markSent writes `sentAt` (with SENT), so one read normally fills the sample; another row with a
 * `sentAt` is skipped and the next ones are read, so the sample is exactly the newest `window` SENT emails.
 */
export async function loadHealthCounts(opts: {
  since: Date | null;
  before?: Date | null;
  bounceWindow: number;
  complaintWindow: number;
  practiceCopy: boolean;
}): Promise<HealthCountsWithIds> {
  const sentAt: { gt?: Date; lt?: Date; not: null } = { not: null };
  if (opts.since) sentAt.gt = opts.since;
  if (opts.before) sentAt.lt = opts.before;
  const where = { mode: { in: realModes(opts.practiceCopy) }, sentAt };
  const sampleOf = async (window: number): Promise<number[]> => {
    const take = Math.max(0, Math.floor(window));
    const ids: number[] = [];
    let skip = 0;
    while (ids.length < take) {
      const want = take - ids.length;
      const rows = await db.outboundEmail.findMany({
        where,
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        skip,
        take: want,
        select: { id: true, status: true },
      });
      for (const r of rows) if (r.status === "SENT") ids.push(r.id);
      if (rows.length < want) break;
      skip += rows.length;
    }
    return ids;
  };

  const withEvent = async (ids: number[], kind: "bounce" | "complaint"): Promise<Set<number>> => {
    const hit = new Set<number>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const rows = await db.mailEvent.findMany({
        where:
          kind === "bounce"
            ? {
                outboundEmailId: { in: chunk },
                type: "failed",
                severity: "permanent",
                isTestMode: false,
                OR: [{ reason: null }, { NOT: { reason: { startsWith: "suppress-" } } }],
              }
            : { outboundEmailId: { in: chunk }, type: "complained", isTestMode: false },
        select: { outboundEmailId: true },
      });
      for (const r of rows) if (r.outboundEmailId !== null) hit.add(r.outboundEmailId);
    }
    return hit;
  };

  const bounceSample = await sampleOf(opts.bounceWindow);
  const complaintSample = await sampleOf(opts.complaintWindow);
  const bounced = await withEvent(bounceSample, "bounce");
  const complained = await withEvent(complaintSample, "complaint");
  const bounceEmailIds = bounceSample.filter((id) => bounced.has(id));
  const complaintEmailIds = complaintSample.filter((id) => complained.has(id));
  return {
    bounces: bounceEmailIds.length,
    bounceSample: bounceSample.length,
    complaints: complaintEmailIds.length,
    complaintSample: complaintSample.length,
    bounceEmailIds,
    complaintEmailIds,
  };
}
