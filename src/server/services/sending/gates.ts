import type { Prisma, RecipientState, SendMode } from "@/generated/prisma/client";
import { checkMatchesMode } from "@/core/dns/check-state";
import { planRoom } from "@/core/mailgun/plan";
import { threadIds } from "@/core/replies/link-ids";
import { capDayBounds, capDayOf, safeZone } from "@/core/sending/capday";
import { senderCapacityLeft } from "@/core/sending/caps";
import { paceGapMs } from "@/core/sending/pacing";
import {
  isWindowOpen,
  nextWindowOpen,
  openSecondsBetween,
  parseWindow,
  resolveZone,
  windowCloseAfter,
  type SendingWindow,
} from "@/core/sending/window";
import {
  parseCatchUpState,
  parseDomainCheckState,
  parseInboxCheckState,
  parseOutageState,
  parsePacerState,
  parseRestoreState,
  parseUnsubscribeTest,
} from "@/core/system-state-parse";
import {
  STATE_KEYS,
  type CatchUpState,
  type ChecklistRow,
  type OutageState,
  type PacerState,
  type PauseState,
  type WaitReason,
} from "@/core/system-state";
import type { UnsubscribeSetup } from "@/core/setting-types";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings";
import { readTyped, updateTyped } from "@/server/state-typed";
import { getMailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { internalSenders } from "@/server/services/mail-events/internal-senders";
import { loadPlanLimits } from "@/server/services/mailgun/plan";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { holdReasonValuesWith, undecidedHolds } from "@/server/services/sequences/holds";
import { getPauseState } from "./pause";
import { restoreHoldActive } from "./restore";
import { countMailgunSendsSince, getTodayCap, type TodayCap } from "./usage";

/**
 * Sending hours, limits and pacing (PLAN B6.6, M3-DESIGN §4.3.2) and the "before every send" guard
 * (B6.4, M4-DESIGN §2.5.1). The sending loop asks here, once per tick, which emails may go:
 *
 *  - "ungated": dry runs with "Ignore sending hours" on, exactly as Milestone 2 (25 per tick, no
 *    window, no pacing, and no limits, except in the practice copy, where they count as real and
 *    so stay under today's limit and each sender's own limit);
 *  - "gated": every TEST and LIVE email, and dry runs with the switch off. At most ONE gated email
 *    goes out per tick, inside its recipient's sending hours, under today's limit and each sender's
 *    own limit, spaced out by the pacer, and never while something is waiting to be checked
 *    (a restore, the start-up check with Mailgun, an outage whose hold isn't applied yet or whose
 *    hold covers the company or sender, a Mailgun back-off, drifted live settings, a broken reply
 *    route, an unprocessed Mailgun report or reply that could concern the address or its company, a
 *    possible reply nobody has decided yet).
 *
 * Follow-ups (steps 1–3) go like first emails, ahead of them: every candidate list is ordered
 * follow-ups first, then High priority companies, then oldest due (B6.6). A HELD (on hold) or
 * RECHECK recipient's emails are never picked: they stay queued until the hold is released.
 *
 * Pacing is recomputed every tick: the gap after the last send of a class (counted or uncounted)
 * follows the emails of that class due NOW, so a campaign launched after a send shortens the wait
 * at once, and one class never waits for the other's gap. Two gated sends are never closer than
 * the smallest gap.
 *
 * The candidate queries never let closed time zones starve open ones: the due rows are first
 * counted per time zone, and only rows in zones whose window is open right now are picked. TEST/LIVE
 * rows and gated dry runs are picked by separate queries, so a big dry run can never crowd real
 * emails out of the candidates.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O9, O10, O23, O33, O36; `GateContext.ownMailbox`, from `loadTeamFrom().replies`):
 * nothing waits on a reply route (there is none); the sending domain's own from-mx row holds every LIVE email when it is
 * "bad", whether or not a From is saved; and a LIVE follow-up waits for today's inbox check ("inbox-check",
 * `inboxCheckHeldIds`), as does a LIVE first email to a company that got a live email before today (review SEND-1);
 * the candidate query reads past such rows (review SEND-3). In every mode, a Mailgun plan with a daily limit (a chosen
 * one, or Free assumed in own-mailbox mode) holds every TEST/LIVE email while the rolling 24 hours are used up
 * ("plan-limit", counted again in the final check, review SEND-2), and checklist rows stored for the other way of
 * sending say nothing about this one (`checkMatchesMode`).
 */

/** Highest step the loop sends: the first email (0) and up to three follow-ups (M4-DESIGN §2.10). */
export const MAX_SENDABLE_STEP = 3;
/** Ungated (dry-run) emails per tick, as Milestone 2. */
export const SEND_BATCH = 25;
/** TEST/LIVE candidates looked at per tick. */
export const GATED_CANDIDATE_LIMIT = 500;
/**
 * Review SEND-3 / REPLIES-07: pages of TEST/LIVE rows read at most in one tick to get past live emails that wait for
 * today's inbox check (own-mailbox mode), so they can't crowd first emails and test-mode emails out of the candidates.
 */
export const GATED_CANDIDATE_PAGES = 10;
/** Gated dry-run candidates looked at per tick (their own query, M4-DESIGN §2.10). */
export const GATED_DRY_RUN_LIMIT = 200;
/** The 15-minute fallback of the catch-up gate (§4.3.2, owner-visible §9.4). First emails only (M4-DESIGN D7). */
export const CATCH_UP_FALLBACK_MS = 15 * 60_000;
/** The pacer's "why it's waiting" is rewritten at least this often while it stays the same. */
export const WAITING_REFRESH_MS = 60_000;
/**
 * Recipients whose queued emails are never picked (M4-DESIGN §2.10): on hold (HELD), waiting for a new address check
 * (RECHECK), or not launched (PENDING). Emails of SCHEDULED and WAITING recipients are picked to be sent; a queued email
 * left behind for a finished, stopped or left-out recipient (e.g. put back by a restart after a skip) is still picked,
 * so the loop can mark it skipped as in Milestone 3 and the campaign can finish.
 */
export const WAITING_RECIPIENT_STATES: readonly RecipientState[] = ["HELD", "RECHECK", "PENDING"];
const IN_CHUNK = 400;

export type Candidate = {
  id: number;
  campaignId: number;
  recipientId: number;
  companyId: number | null;
  senderId: number | null;
  step: number;
  mode: SendMode;
  toNorm: string;
  dueAt: Date;
  priorityRank: number;
  /** The zone the recipient's sending hours follow (the company's, else the default zone). */
  zone: string;
  ignoreWindow: boolean;
  /**
   * The reply-route hold is keyed by the route address (SHARED-FROM-DESIGN §2.3): `Campaign.replyTo ??
   * Campaign.fromAddress`, bare and lowercase. Per-person mode: the From address, as before.
   */
  routeAddress: string;
  /**
   * Campaign.sendingDomainId: the domain row the campaign sends through. `SendingDomain.lastLiveSendAt` is written by
   * it after a LIVE send, never by an address (F6). Null for a campaign without one (a dry run's placeholder).
   */
  sendingDomainId: number | null;
  /** Campaign.launchedAt. Kept for callers; the M4 guard no longer looks at it (a reply from before the launch holds too). */
  campaignLaunchedAt: Date | null;
};

/** Due gated rows per zone (all of them, not just the candidates), for the pacing formula and "outside hours". */
export type DueStats = Array<{ zone: string; counted: boolean; senderId: number | null; count: number }>;

/**
 * The candidates the "before every send" guard holds this tick (M4-DESIGN §2.5.1): `pending` = an unprocessed Mailgun
 * report or reply could concern the address or its company (wait reason "pending-events"); `possibleReply` = the
 * company has a message nobody has decided yet (wait reason "possible-reply"); `outage` = a hold after the PC was off
 * still covers the company or the sender, although this person isn't held themselves, e.g. reopened by a Retry (wait
 * reason "outage-hold"); `inboxCheck` = own-mailbox mode, a LIVE follow-up and nobody has read the own mailbox today
 * after this person's last email, or a LIVE first email at a company emailed before today and nobody has read it today
 * (wait reason "inbox-check", MAIN-DOMAIN-DESIGN O33, review SEND-1).
 */
export type ProblemIds = { pending: Set<number>; possibleReply: Set<number>; outage?: Set<number>; inboxCheck?: Set<number> };

/** What the guard needs of a candidate (the final check builds one from its claimed email). */
export type GuardCandidate = Pick<Candidate, "id" | "campaignId" | "recipientId" | "companyId" | "toNorm" | "mode" | "step">;

/** No problem at all (a context built without candidates). */
export function noProblems(): ProblemIds {
  return { pending: new Set(), possibleReply: new Set(), outage: new Set(), inboxCheck: new Set() };
}

export type GateContext = {
  now: Date;
  pause: PauseState;
  today: TodayCap;
  window: SendingWindow;
  defaultZone: string;
  minGapSeconds: number;
  pacer: PacerState;
  mailgun: MailgunContextResult;
  /** The start-up check with Mailgun, for first emails (M3's rule, with its 15-minute fallback). */
  catchUpReady: boolean;
  /**
   * The start-up check with Mailgun, for TEST/LIVE follow-ups: a catch-up must have succeeded since the start, with no
   * fallback, because only a complete walk of Mailgun's logs can find an outage (M4-DESIGN §2.8.3 rule 2, D7).
   */
  followUpCatchUpReady: boolean;
  /** An outage was found and its hold isn't applied yet: TEST/LIVE follow-ups wait (M4-DESIGN §2.8.3 rule 1). */
  outageHoldPending: boolean;
  practiceCopy: boolean;
  goLive: boolean;
  /** User.dailyCap per user id (null = no limit of their own). */
  senderCaps: ReadonlyMap<number, number | null>;
  /** §4.3.7: a restore is being checked (or failed/unchecked and not acknowledged). Holds TEST/LIVE only. */
  restoreHold: boolean;
  /** Setup A and neither the "tracking-off" nor the "unsubscribe" checklist row is "bad" (spec: footer + unsubscribe). */
  liveReady: boolean;
  /**
   * SHARED-FROM-DESIGN F27: no checklist row (of today's domain) "from-mx" is "bad", i.e. the main domain's MX doesn't
   * point to Mailgun and isn't missing. False holds every LIVE email ("main-domain-mx"); a row that is "warn",
   * "unknown" or was never checked holds nothing, and per-person mode (no From address saved) is never held, even by a
   * row stored before the From address was cleared (review SECURITY-3). Own-mailbox mode (MAIN-DOMAIN-DESIGN O10): the
   * sending domain's own from-mx row, whether or not a From is saved.
   */
  mainDomainMxOk: boolean;
  /** SenderAddress.address → routeStatus === "ok" (the route address of a candidate is looked up here). */
  routeOk: ReadonlyMap<string, boolean>;
  /** pendingProblemIds(gated candidates), M4-DESIGN §2.5.1. */
  problems: ProblemIds;
  due: DueStats;
  /**
   * MAIN-DOMAIN-DESIGN O1, O9: own-mailbox mode (`loadTeamFrom().replies`). Nothing waits on a reply route then (there is
   * none); the inbox check holds LIVE follow-ups through `problems.inboxCheck`.
   */
  ownMailbox: boolean;
  /**
   * MAIN-DOMAIN-DESIGN O23: room left for campaign emails in the rolling 24 hours of the Mailgun plan's daily limit
   * (`planRoom(...).campaign`, keeping the test reserve); null = the plan has no daily limit (or none applies: app mode
   * without a chosen plan). At 0 every TEST/LIVE email waits "plan-limit".
   */
  planLeft: number | null;
  /** When room opens again (the oldest counted send of the last 24 hours + 24 hours); null = unknown or no limit. */
  planOpensAt: Date | null;
};

export type TickPlan = {
  /** ≤ 25, as Milestone 2. */
  ungated: Candidate[];
  /** At most ONE gated email this tick. */
  next: Candidate | null;
  nextCounted: boolean;
  waiting: { reason: WaitReason; until: Date | null } | null;
  capReached: boolean;
  /** Inputs of the gap after `next` is sent (only rows that can really go today). */
  pace: { counted: { dueCount: number; openSecondsLeft: number }; uncounted: { dueCount: number; openSecondsLeft: number } };
  /** The first LIVE candidate held because its sender's reply route isn't working (for the Owner's notice). */
  routeHeld: Candidate | null;
  /**
   * MAIN-DOMAIN-DESIGN O33: the first LIVE follow-up held for today's inbox check (own-mailbox mode), for the Owner's
   * once-a-day notice.
   */
  inboxHeld: Candidate | null;
};

// ───────────────────────── classes ─────────────────────────

/**
 * DRY_RUN with "Ignore sending hours" → ungated (Milestone 2's path); DRY_RUN without it → gated,
 * counted in the practice copy (it counts as real there), uncounted on real data (hours and pacing,
 * never limits or health); TEST → gated, uncounted; LIVE → gated, counted.
 */
export function gateClass(
  c: Pick<Candidate, "mode" | "ignoreWindow">,
  ctx: { practiceCopy: boolean },
): "ungated" | "gated-counted" | "gated-uncounted" {
  if (c.mode === "DRY_RUN") {
    if (c.ignoreWindow) return "ungated";
    return ctx.practiceCopy ? "gated-counted" : "gated-uncounted";
  }
  return c.mode === "TEST" ? "gated-uncounted" : "gated-counted";
}

function isMailgunMode(mode: SendMode): boolean {
  return mode === "TEST" || mode === "LIVE";
}

// ───────────────────────── candidates ─────────────────────────

/** SQLite's stored form of a DateTime (the Prisma adapter writes ISO 8601 with "+00:00"). */
function sqliteDate(d: Date): string {
  return d.toISOString().replace("Z", "+00:00");
}

const candidateSelect = {
  id: true,
  campaignId: true,
  recipientId: true,
  companyId: true,
  senderId: true,
  step: true,
  mode: true,
  toNorm: true,
  dueAt: true,
  campaign: { select: { ignoreWindow: true, fromAddress: true, replyTo: true, sendingDomainId: true, launchedAt: true } },
  recipient: { select: { companyId: true, company: { select: { priorityRank: true, timeZone: true } } } },
} satisfies Prisma.OutboundEmailSelect;

type CandidateRow = Prisma.OutboundEmailGetPayload<{ select: typeof candidateSelect }>;

function toCandidate(r: CandidateRow, defaultZone: string): Candidate {
  return {
    id: r.id,
    campaignId: r.campaignId,
    recipientId: r.recipientId,
    companyId: r.recipient.companyId ?? r.companyId,
    senderId: r.senderId,
    step: r.step,
    mode: r.mode,
    toNorm: r.toNorm,
    dueAt: r.dueAt,
    priorityRank: r.recipient.company.priorityRank,
    zone: resolveZone(r.recipient.company.timeZone, defaultZone),
    ignoreWindow: r.campaign.ignoreWindow,
    // The reply-route hold is keyed by the route address: the Reply-To in shared-From mode, else the From (§2.3).
    routeAddress: ((r.campaign.replyTo ?? "").trim() || (r.campaign.fromAddress ?? "")).trim().toLowerCase(),
    sendingDomainId: r.campaign.sendingDomainId,
    campaignLaunchedAt: r.campaign.launchedAt,
  };
}

type DueRow = { zone: string | null; mode: string; ignoreWindow: unknown; senderId: unknown; n: unknown };

/** B6.6: follow-ups first, then High priority companies, then the oldest due (the same order everywhere). */
const CANDIDATE_ORDER: Prisma.OutboundEmailOrderByWithRelationInput[] = [
  { step: "desc" },
  { recipient: { company: { priorityRank: "asc" } } },
  { dueAt: "asc" },
  { id: "asc" },
];

/** The candidate order in memory (merging the per-class lists). */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return b.step - a.step || a.priorityRank - b.priorityRank || a.dueAt.getTime() - b.dueAt.getTime() || a.id - b.id;
}

/** Queued, due, and a step the loop sends. */
function dueWhere(now: Date): Prisma.OutboundEmailWhereInput {
  return { status: "QUEUED", step: { lte: MAX_SENDABLE_STEP }, dueAt: { lte: now } };
}

/**
 * The emails due now (§4.3.2 pickCandidates, M4-DESIGN §2.10). Emails of recipients on hold, waiting for an address
 * check or not launched never count (WAITING_RECIPIENT_STATES):
 *  1. ungated: emails of running dry-run campaigns with "Ignore sending hours" on, limited like Milestone 2 (25),
 *     follow-ups first, then High priority companies, then oldest due;
 *  2. due stats: every due gated row counted per time zone, mode, switch and sender (one query);
 *  3. the zones whose sending window is open right now;
 *  4. gated candidates in those zones only, picked per class (TEST/LIVE up to `limit`, 500; gated dry runs up to 200)
 *     and merged in the same order, so a large dry run's overdue follow-ups never keep a real email out. Own-mailbox
 *     mode (review SEND-3): a full TEST/LIVE page with live emails that wait for today's inbox check is read past them
 *     (`pickRealRows`), so they never keep a first email or a test-mode email out either.
 */
export async function pickCandidates(
  now: Date,
  opts: { window: SendingWindow; defaultZone: string; limit?: number; dryRunLimit?: number; practiceCopy?: boolean },
): Promise<{ ungated: Candidate[]; gated: Candidate[]; due: DueStats }> {
  const practiceCopy =
    opts.practiceCopy ?? (await getSettings(["practice.copy"] as const))["practice.copy"] === true;
  const base = dueWhere(now);
  const sendable: Prisma.CampaignRecipientWhereInput = { state: { notIn: [...WAITING_RECIPIENT_STATES] } };

  const ungatedRows = await db.outboundEmail.findMany({
    where: { ...base, mode: "DRY_RUN", campaign: { status: "RUNNING", ignoreWindow: true }, recipient: sendable },
    orderBy: CANDIDATE_ORDER,
    take: SEND_BATCH,
    select: candidateSelect,
  });
  const ungated = ungatedRows.map((r) => toCandidate(r, opts.defaultZone));

  const { due, resolvedByRaw } = await dueStatsWithZones(now, { defaultZone: opts.defaultZone, practiceCopy });

  const openRaw: string[] = [];
  let nullOpen = false;
  for (const [raw, zone] of resolvedByRaw) {
    if (!isWindowOpen(now, zone, opts.window)) continue;
    if (raw === null) nullOpen = true;
    else openRaw.push(raw);
  }
  if (openRaw.length === 0 && !nullOpen) return { ungated, gated: [], due };

  const zoneFilter: Prisma.CompanyWhereInput[] = [];
  if (openRaw.length) zoneFilter.push({ timeZone: { in: openRaw } });
  if (nullOpen) zoneFilter.push({ timeZone: null });
  const inOpenZone: Prisma.CampaignRecipientWhereInput = { ...sendable, company: { OR: zoneFilter } };
  const [realRows, dryRows] = await Promise.all([
    pickRealRows(
      { ...base, mode: { in: ["TEST", "LIVE"] }, campaign: { status: "RUNNING" }, recipient: inOpenZone },
      opts.limit ?? GATED_CANDIDATE_LIMIT,
      now,
    ),
    db.outboundEmail.findMany({
      where: { ...base, mode: "DRY_RUN", campaign: { status: "RUNNING", ignoreWindow: false }, recipient: inOpenZone },
      orderBy: CANDIDATE_ORDER,
      take: opts.dryRunLimit ?? GATED_DRY_RUN_LIMIT,
      select: candidateSelect,
    }),
  ]);
  const gated = [...realRows, ...dryRows].map((r) => toCandidate(r, opts.defaultZone)).sort(compareCandidates);
  return { ungated, gated, due };
}

/** What the guard needs of a candidate row (the inbox check reads the mode, step, person and company). */
function guardOf(r: CandidateRow): GuardCandidate {
  return {
    id: r.id,
    campaignId: r.campaignId,
    recipientId: r.recipientId,
    companyId: r.recipient.companyId ?? r.companyId,
    toNorm: r.toNorm.toLowerCase(),
    mode: r.mode,
    step: r.step,
  };
}

/**
 * The TEST/LIVE candidate rows: the first `limit` due rows in the candidate order. Review SEND-3 / REPLIES-07: in
 * own-mailbox mode, when that page is full and today's inbox check holds some of it, the held rows are left out, all but
 * the first one (so the waiting line and the Owner's notice still say why they wait), and the next pages are read until
 * `limit` rows that may go are found, at most `GATED_CANDIDATE_PAGES` pages. So live follow-ups (or first emails at an
 * already-emailed company) that wait for the check never crowd first emails and test-mode emails out. A page that isn't
 * full, or that nothing on it waits for the check (always so in app mode), is used exactly as before.
 */
async function pickRealRows(where: Prisma.OutboundEmailWhereInput, limit: number, now: Date): Promise<CandidateRow[]> {
  const read = (skip: number) =>
    db.outboundEmail.findMany({ where, orderBy: CANDIDATE_ORDER, ...(skip > 0 ? { skip } : {}), take: limit, select: candidateSelect });
  const first = await read(0);
  if (limit <= 0 || first.length < limit) return first;
  const facts = await loadInboxCheckFacts(now);
  if (!facts) return first;
  const kept: CandidateRow[] = [];
  let firstHeld: CandidateRow | null = null;
  let page = first;
  for (let pages = 1; ; pages++) {
    const held = await heldForInboxCheck(page.map(guardOf), facts);
    if (pages === 1 && held.size === 0) return first;
    for (const r of page) {
      if (!held.has(r.id)) kept.push(r);
      else firstHeld ??= r;
    }
    if (kept.length >= limit || page.length < limit || pages >= GATED_CANDIDATE_PAGES) break;
    page = await read(pages * limit);
    if (page.length === 0) break;
  }
  const out = kept.slice(0, limit);
  if (firstHeld) out.push(firstHeld);
  return out;
}

/**
 * Every due gated row counted per time zone, mode, switch and sender (one query), for the pacing
 * formula and "outside hours". The campaign page uses it too, so its "Next email in about …" follows
 * the same numbers as the sending loop.
 */
export async function loadDueStats(now: Date, opts: { defaultZone: string; practiceCopy: boolean }): Promise<DueStats> {
  return (await dueStatsWithZones(now, opts)).due;
}

async function dueStatsWithZones(
  now: Date,
  opts: { defaultZone: string; practiceCopy: boolean },
): Promise<{ due: DueStats; resolvedByRaw: Map<string | null, string> }> {
  const rows = await db.$queryRaw<DueRow[]>`
    SELECT co.\`timeZone\` AS zone, o.\`mode\` AS mode, c.\`ignoreWindow\` AS ignoreWindow, o.\`senderId\` AS senderId, COUNT(*) AS n
    FROM \`main\`.\`OutboundEmail\` AS \`o\`
    JOIN \`main\`.\`Campaign\` AS c ON c.\`id\` = o.\`campaignId\`
    JOIN \`main\`.\`CampaignRecipient\` AS r ON r.\`id\` = o.\`recipientId\`
    JOIN \`main\`.\`Company\` AS co ON co.\`id\` = r.\`companyId\`
    WHERE o.\`status\` = 'QUEUED' AND o.\`dueAt\` <= ${sqliteDate(now)} AND o.\`step\` <= ${MAX_SENDABLE_STEP}
      AND r.\`state\` NOT IN ('HELD', 'RECHECK', 'PENDING')
      AND c.\`status\` = 'RUNNING' AND (o.\`mode\` <> 'DRY_RUN' OR c.\`ignoreWindow\` = 0)
    GROUP BY co.\`timeZone\`, o.\`mode\`, c.\`ignoreWindow\`, o.\`senderId\``;

  const due: DueStats = [];
  const resolvedByRaw = new Map<string | null, string>();
  for (const r of rows) {
    const zone = resolveZone(r.zone, opts.defaultZone);
    resolvedByRaw.set(r.zone, zone);
    const ignoreWindow = r.ignoreWindow === true || Number(r.ignoreWindow) === 1;
    const counted = gateClass({ mode: r.mode as SendMode, ignoreWindow }, { practiceCopy: opts.practiceCopy }) === "gated-counted";
    const senderId = r.senderId === null || r.senderId === undefined ? null : Number(r.senderId);
    due.push({ zone, counted, senderId, count: Number(r.n) });
  }
  return { due, resolvedByRaw };
}

// ───────────────────────── before every send (M4-DESIGN §2.5.1) ─────────────────────────

function chunked<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Where one stored reply's thread ids point: our emails (their company and address) and the test emails it hits. */
type ThreadTargets = {
  /** OutboundEmail rows whose messageId or providerId is one of the thread ids. */
  emails: Array<{ companyId: number | null; toNorm: string }>;
  /** The `to` of every TestSend (reply test, "Send me a test") whose messageId or providerId is one of the ids. */
  testTos: string[];
};

/**
 * Thread targets of unprocessed replies, by InboundMessage id. A stored reply's thread ids never change before it is
 * processed, so each row's lookups are done once, not every 5 seconds (a large catch-up backlog costs its lookups
 * once). Pruned to the ids still unprocessed on every call. Module-level: one per process (the worker's loop, or the
 * web app's campaign page).
 */
const threadTargetCache = new Map<number, ThreadTargets>();

/** Looks up the thread targets of the given rows (ids in In-Reply-To/References order, at most 50 per row). */
async function loadThreadTargets(rows: ReadonlyArray<{ id: number; inReplyTo: string | null; references: string | null }>): Promise<void> {
  const idsByRow = new Map(rows.map((r) => [r.id, threadIds({ inReplyTo: r.inReplyTo, references: r.references })]));
  const all = [...new Set([...idsByRow.values()].flat())];
  const emailByKey = new Map<string, { companyId: number | null; toNorm: string }[]>();
  const testByKey = new Map<string, string[]>();
  const add = <T>(map: Map<string, T[]>, key: string | null, value: T) => {
    if (!key) return;
    const k = key.toLowerCase();
    const list = map.get(k);
    if (list) list.push(value);
    else map.set(k, [value]);
  };
  for (const part of chunked(all)) {
    const [byMessageId, byProviderId, tests] = await Promise.all([
      db.outboundEmail.findMany({ where: { messageId: { in: part } }, select: { messageId: true, companyId: true, toNorm: true } }),
      db.outboundEmail.findMany({ where: { providerId: { in: part } }, select: { providerId: true, companyId: true, toNorm: true } }),
      db.testSend.findMany({
        where: { OR: [{ messageId: { in: part } }, { providerId: { in: part } }] },
        select: { messageId: true, providerId: true, to: true },
      }),
    ]);
    for (const e of byMessageId) add(emailByKey, e.messageId, { companyId: e.companyId, toNorm: e.toNorm.toLowerCase() });
    for (const e of byProviderId) add(emailByKey, e.providerId, { companyId: e.companyId, toNorm: e.toNorm.toLowerCase() });
    for (const t of tests) {
      add(testByKey, t.messageId, t.to);
      add(testByKey, t.providerId, t.to);
    }
  }
  for (const [rowId, ids] of idsByRow) {
    threadTargetCache.set(rowId, {
      emails: ids.flatMap((id) => emailByKey.get(id) ?? []),
      testTos: ids.flatMap((id) => testByKey.get(id) ?? []),
    });
  }
}

/** What unprocessed replies hold: addresses and companies. */
type HeldBy = { addresses: Set<string>; companies: Set<number> };

function heldBy(): HeldBy {
  return { addresses: new Set(), companies: new Set() };
}

function holds(h: HeldBy, c: GuardCandidate): boolean {
  return h.addresses.has(c.toNorm) || (c.companyId !== null && h.companies.has(c.companyId));
}

/**
 * The candidates the "before every send" guard holds (B6.4, M4-DESIGN §2.5.1), batched for all candidates at once
 * (chunks of 400). Runs for the gated candidates when they are picked, and again for the one email just before the
 * hand-over (the final check), because a reply may be stored in between.
 *  1. Mailgun reports: an unprocessed MailEvent for the address holds that address.
 *  2. Replies: every unprocessed InboundMessage, whatever its date (the event lane keeps this near zero). A reply
 *     that will be filed as a test reply holds nothing: the sender is one of ours (a user's address, a sending
 *     address, anything on our sending domains) and not the address one of our emails in its thread went to (that is
 *     a reply to the email, REPLY-01), or its thread hits only test emails (reply test, "Send me a test")
 *     and it comes from that test's mailbox, a user or the test list. Any other reply holds its sender's address, the
 *     company of every known person with that address (removed people included), and the company and address of
 *     every email of ours its thread ids point at (our Message-ID or Mailgun's). Simulated replies (dry-run outbox)
 *     never hold a TEST or LIVE email. All of these go into `pending` (wait reason "pending-events").
 *  3. Undecided messages (a possible reply, or an unlinked message holding its company's domain): a candidate whose
 *     company has one in real scope, or in campaign scope for the candidate's own campaign, goes into `possibleReply`.
 *     This covers recipients created or reopened after the message was processed, until the maintenance holds them.
 *  4. After the PC was off (`outageHeldIds`): a TEST/LIVE candidate that the outage hold would hold, although its
 *     person isn't held (reopened by a Retry, or in a campaign launched after the hold), goes into `outage`.
 *  5. Own-mailbox mode (`inboxCheckHeldIds`, MAIN-DOMAIN-DESIGN O33): a LIVE follow-up whose person was emailed after
 *     the last "I've read …" click, or with no click in today's cap day, goes into `inboxCheck`; so does a LIVE first
 *     email to a company that got a live email before today, while nobody has read the own mailbox today (review SEND-1).
 * A candidate in any set is skipped this tick; the next one is tried. `now` (the tick's or the final check's clock)
 * decides today's cap day for step 5.
 */
export async function pendingProblemIds(cands: readonly GuardCandidate[], now: Date = new Date()): Promise<ProblemIds> {
  const out = noProblems();
  if (cands.length === 0) return out;

  // 1. Unprocessed Mailgun reports for the address.
  const norms = [...new Set(cands.map((c) => c.toNorm))];
  const pendingAddresses = new Set<string>();
  for (const part of chunked(norms)) {
    const rows = await db.mailEvent.findMany({ where: { processedAt: null, recipient: { in: part } }, select: { recipient: true } });
    for (const r of rows) if (r.recipient) pendingAddresses.add(r.recipient.toLowerCase());
  }
  for (const c of cands) if (pendingAddresses.has(c.toNorm)) out.pending.add(c.id);

  // 2. Unprocessed replies.
  const replies = await db.inboundMessage.findMany({
    where: { processedAt: null },
    select: { id: true, fromEmail: true, inReplyTo: true, references: true, source: true },
  });
  const unprocessed = new Set(replies.map((r) => r.id));
  for (const id of threadTargetCache.keys()) if (!unprocessed.has(id)) threadTargetCache.delete(id);
  if (replies.length > 0) {
    await loadThreadTargets(replies.filter((r) => !threadTargetCache.has(r.id)));
    const senders = await internalSenders(db);
    // Replies that concern real emails, and simulated ones (these only ever hold dry runs).
    const real = heldBy();
    const simulated = heldBy();
    const froms = new Map<string, HeldBy[]>();
    for (const r of replies) {
      const from = r.fromEmail.trim().toLowerCase();
      const targets = threadTargetCache.get(r.id) ?? { emails: [], testTos: [] };
      // One of our addresses answering an email that went to it (a test-list mailbox that is also a user's login) is a
      // reply like any other, as in the processor (REPLY-01); the guard passes every thread target, so it holds more, never less.
      if (senders.isInternal(from, targets.emails.map((e) => e.toNorm))) continue;
      if (targets.emails.length === 0 && targets.testTos.some((to) => senders.isTestSender(from, to))) continue;
      const into = r.source === "SIMULATED" ? simulated : real;
      if (from) {
        into.addresses.add(from);
        const list = froms.get(from) ?? [];
        list.push(into);
        froms.set(from, list);
      }
      for (const e of targets.emails) {
        into.addresses.add(e.toNorm);
        if (e.companyId !== null) into.companies.add(e.companyId);
      }
    }
    // Anyone at the company: the sender's company through Person.emailNorm (removed people included).
    for (const part of chunked([...froms.keys()])) {
      const people = await db.person.findMany({ where: { emailNorm: { in: part } }, select: { emailNorm: true, companyId: true } });
      for (const p of people) for (const into of froms.get(p.emailNorm ?? "") ?? []) into.companies.add(p.companyId);
    }
    for (const c of cands) {
      const mailgun = c.mode === "TEST" || c.mode === "LIVE";
      if (holds(real, c) || (!mailgun && holds(simulated, c))) out.pending.add(c.id);
    }
  }

  // 3. Undecided messages of the candidates' companies.
  const companyIds = [...new Set(cands.map((c) => c.companyId).filter((id): id is number => id !== null))];
  if (companyIds.length > 0) {
    const undecided = await undecidedHolds(db, companyIds);
    const everyCampaign = new Set(undecided.filter((u) => u.campaignId === null).map((u) => u.companyId));
    const oneCampaign = new Set(undecided.filter((u) => u.campaignId !== null).map((u) => `${u.companyId}:${u.campaignId}`));
    for (const c of cands) {
      if (c.companyId === null) continue;
      if (everyCampaign.has(c.companyId) || oneCampaign.has(`${c.companyId}:${c.campaignId}`)) out.possibleReply.add(c.id);
    }
  }

  // 4. A hold after the PC was off that should cover people it doesn't hold.
  out.outage = await outageHeldIds(cands);

  // 5. Own-mailbox mode: live follow-ups wait for today's inbox check.
  out.inboxCheck = await inboxCheckHeldIds(cands, now);
  return out;
}

/** Recipients per `groupBy` of the inbox check's "last email" read. */
const INBOX_CHECK_CHUNK = 500;

/**
 * A stored "I've read …" time more than this far ahead of the clock came from a clock that was wrong (review
 * SECURITY-02); the same allowance the Owner's notices give (`shouldSendNotice`).
 */
export const INBOX_CHECK_CLOCK_SKEW_MS = 60_000;

/**
 * The stored inbox check's time (epoch ms), or NaN when there is none, it can't be read, or it lies more than
 * `INBOX_CHECK_CLOCK_SKEW_MS` ahead of `now` (review SECURITY-02: a click made while the PC clock ran ahead never counts
 * as done, today or any later day; the next click replaces it, `markInboxChecked`).
 */
export function inboxCheckTime(at: string | null | undefined, now: Date): number {
  const t = isoMs(at);
  return Number.isFinite(t) && t <= now.getTime() + INBOX_CHECK_CLOCK_SKEW_MS ? t : Number.NaN;
}

/**
 * The stored check counts as today's (MAIN-DOMAIN-DESIGN O33): an `inboxCheckTime` at or after the start of today's cap
 * day in `zone` (Setting "sending.capDayTimeZone"). The gate, the Notifications card and the dashboard share this rule.
 */
export function inboxCheckedToday(at: string | null | undefined, now: Date, zone: string): boolean {
  const t = inboxCheckTime(at, now);
  return Number.isFinite(t) && t >= capDayBounds(capDayOf(now, zone), zone).start.getTime();
}

/** What the inbox check decides with, for one clock reading (own-mailbox mode only). */
type InboxCheckFacts = {
  /** The start of today's cap day (epoch ms). */
  dayStart: number;
  /** The last check's time when it counts for today (`inboxCheckedToday`), else NaN. */
  checkedAt: number;
};

/** The inbox check's facts at `now`, or null outside own-mailbox mode (one Settings read then). */
async function loadInboxCheckFacts(now: Date): Promise<InboxCheckFacts | null> {
  if ((await loadTeamFrom()).replies !== "own-mailbox") return null;
  const [check, zoneRow] = await Promise.all([
    readTyped(STATE_KEYS.inboxCheck, parseInboxCheckState),
    db.setting.findUnique({ where: { key: "sending.capDayTimeZone" }, select: { value: true } }),
  ]);
  const zone = safeZone(typeof zoneRow?.value === "string" ? zoneRow.value : null);
  const dayStart = capDayBounds(capDayOf(now, zone), zone).start.getTime();
  const at = inboxCheckTime(check.value.at, now);
  return { dayStart, checkedAt: Number.isFinite(at) && at >= dayStart ? at : Number.NaN };
}

/**
 * The inbox check (MAIN-DOMAIN-DESIGN O33, §2.9): in own-mailbox mode replies land only in the own mailbox, where the
 * app can't see them, so a LIVE follow-up (step ≥ 1) goes only once someone has clicked "I've read …" (SystemState
 * "sending.inboxCheck", written only by `markInboxChecked`) inside today's cap day (Setting "sending.capDayTimeZone", as
 * `countUserTestSends` reads it) AND after that person's newest SENT email, so the check covers the whole time since
 * they were last emailed. Held: no check at all, a check before today's cap day, a check more than a minute in the future
 * (a clock that ran ahead, review SECURITY-02), or a check at or before the person's newest SENT email.
 *
 * Review SEND-1 / REPLIES-04: a LIVE first email waits too while nobody has read the own mailbox today, when its company
 * already got a live email before today (any person, any campaign: someone there may have answered it, and in app mode
 * that reply would have stopped the company). First emails to a company nobody emailed before today still go, and so
 * does a colleague's first email on the same day as the company's earlier ones (app mode couldn't stop that either).
 * TEST (Mailgun's test mode never delivers) and DRY_RUN never wait; app mode never holds anything. Empty when nothing
 * applies (one Settings read in app mode, and only with live emails among the candidates).
 */
export async function inboxCheckHeldIds(cands: readonly GuardCandidate[], now: Date): Promise<Set<number>> {
  if (!cands.some((c) => c.mode === "LIVE")) return new Set();
  const facts = await loadInboxCheckFacts(now);
  return facts ? heldForInboxCheck(cands, facts) : new Set();
}

/** `inboxCheckHeldIds` with the facts already read (the candidate query reads them once for every page). */
async function heldForInboxCheck(cands: readonly GuardCandidate[], facts: InboxCheckFacts): Promise<Set<number>> {
  const out = new Set<number>();
  const live = cands.filter((c) => c.mode === "LIVE");
  const followUps = live.filter((c) => c.step >= 1);
  const at = facts.checkedAt;
  if (!Number.isFinite(at)) {
    for (const c of followUps) out.add(c.id);
    const firsts = live.filter((c) => c.step < 1 && c.companyId !== null);
    if (firsts.length > 0) {
      const emailed = await companiesEmailedBefore([...new Set(firsts.map((c) => c.companyId!))], new Date(facts.dayStart));
      for (const c of firsts) if (emailed.has(c.companyId!)) out.add(c.id);
    }
    return out;
  }
  // Checked today, so after every email sent before today: first emails go; a follow-up waits only when its person was
  // emailed at or after the check.
  for (const part of chunked([...new Set(followUps.map((c) => c.recipientId))], INBOX_CHECK_CHUNK)) {
    const last = await db.outboundEmail.groupBy({ by: ["recipientId"], where: { recipientId: { in: part }, status: "SENT" }, _max: { sentAt: true } });
    const lastSent = new Map(last.map((l) => [l.recipientId, l._max.sentAt]));
    // Only this part's recipients are in the map; the others are looked at with their own part.
    for (const c of followUps) {
      const sent = lastSent.get(c.recipientId);
      if (sent && at <= sent.getTime()) out.add(c.id);
    }
  }
  return out;
}

/** OutboundEmail states that may have reached the person, counted from their claim (as `usage.ts` counts them). */
const MAYBE_SENT_STATES = ["SENDING", "UNKNOWN", "UNCONFIRMED"] as const;

/**
 * The companies (of `companyIds`) that got a live email before `before` (review SEND-1): a SENT LIVE email, a LIVE one
 * that may have gone (claimed before then, not decided yet), or a live send found in Mailgun's logs without a row of ours
 * (`ExternalSend`, after a restore). Chunks of 400. The `sentAt` ranges are read through the (companyId, sentAt) indexes,
 * with the SENT and LIVE checks done here (a `status` condition next to a `sentAt` range picks the wrong index, review
 * DASHBOARD-2).
 */
async function companiesEmailedBefore(companyIds: readonly number[], before: Date): Promise<Set<number>> {
  const out = new Set<number>();
  for (const part of chunked(companyIds)) {
    const [sent, maybe, external] = await Promise.all([
      db.outboundEmail.groupBy({ by: ["companyId", "mode", "status"], where: { companyId: { in: part }, sentAt: { lt: before } } }),
      db.outboundEmail.groupBy({
        by: ["companyId"],
        where: { companyId: { in: part }, mode: "LIVE", status: { in: [...MAYBE_SENT_STATES] }, claimedAt: { lt: before } },
      }),
      db.externalSend.groupBy({ by: ["companyId"], where: { companyId: { in: part }, sentAt: { lt: before } } }),
    ]);
    for (const g of sent) if (g.companyId !== null && g.mode === "LIVE" && g.status === "SENT") out.add(g.companyId);
    for (const g of maybe) if (g.companyId !== null) out.add(g.companyId);
    for (const g of external) if (g.companyId !== null) out.add(g.companyId);
  }
  return out;
}

/** Every stored `holdReason` value that contains "outage". */
const OUTAGE_HOLD_VALUES = holdReasonValuesWith("outage");

/**
 * The TEST/LIVE candidates the outage hold (M4-DESIGN §2.8.3) would hold but doesn't, because their person wasn't open
 * when it was applied: reopened by a Retry after "Didn't send", or in a campaign launched after the hold. They follow
 * the hold's own release rules, read from the people it still holds:
 *  - a first email waits while someone who was already emailed at its company is still held for the outage (a
 *    colleague's first email waits until every sender who emailed that company has checked their inbox);
 *  - a follow-up waits while its campaign's sender still has emailed people held for the outage (they haven't checked
 *    their inbox yet), when its company is one of those companies or its last email went out before the end of the
 *    unchecked window (`heldTo`), so a reply to it may have been missed.
 * Dry runs are never held. Nothing to read when nobody is held for an outage (almost always).
 */
export async function outageHeldIds(cands: readonly GuardCandidate[]): Promise<Set<number>> {
  const out = new Set<number>();
  const real = cands.filter((c) => isMailgunMode(c.mode));
  if (real.length === 0) return out;
  const emailedHeld: Prisma.CampaignRecipientWhereInput = {
    state: "HELD",
    holdReason: { in: OUTAGE_HOLD_VALUES },
    currentStep: { gte: 1 },
    campaign: { status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
  };
  const heldCampaigns = (await db.campaignRecipient.groupBy({ by: ["campaignId"], where: emailedHeld })).map((g) => g.campaignId);
  if (heldCampaigns.length === 0) return out;

  // Each campaign's sender (null = the sender's account is gone): the held ones', and the candidates'.
  const senderOf = new Map<number, number | null>();
  for (const part of chunked([...new Set([...heldCampaigns, ...real.map((c) => c.campaignId)])])) {
    const rows = await db.campaign.findMany({ where: { id: { in: part } }, select: { id: true, senderId: true } });
    for (const r of rows) senderOf.set(r.id, r.senderId);
  }
  const heldSenders = new Set(heldCampaigns.filter((id) => senderOf.has(id)).map((id) => senderOf.get(id) ?? null));

  // The candidates' companies where someone already emailed is held for the outage.
  const affected = new Set<number>();
  const companyIds = [...new Set(real.map((c) => c.companyId).filter((id): id is number => id !== null))];
  for (const part of chunked(companyIds)) {
    const rows = await db.campaignRecipient.groupBy({ by: ["companyId"], where: { companyId: { in: part }, ...emailedHeld } });
    for (const r of rows) affected.add(r.companyId);
  }

  const heldTo = isoMs((await readTyped(STATE_KEYS.outage, parseOutageState)).value.heldTo);
  const needLastSent: GuardCandidate[] = [];
  for (const c of real) {
    const atAffected = c.companyId !== null && affected.has(c.companyId);
    if (c.step <= 0) {
      if (atAffected) out.add(c.id);
      continue;
    }
    if (!senderOf.has(c.campaignId) || !heldSenders.has(senderOf.get(c.campaignId) ?? null)) continue;
    if (atAffected) out.add(c.id);
    else if (Number.isFinite(heldTo)) needLastSent.push(c);
  }
  for (const part of chunked([...new Set(needLastSent.map((c) => c.recipientId))])) {
    const last = await db.outboundEmail.groupBy({ by: ["recipientId"], where: { recipientId: { in: part }, status: "SENT" }, _max: { sentAt: true } });
    const lastSent = new Map(last.map((l) => [l.recipientId, l._max.sentAt]));
    for (const c of needLastSent) {
      const at = lastSent.get(c.recipientId);
      if (at && at.getTime() < heldTo) out.add(c.id);
    }
  }
  return out;
}

/** Tests: forgets the cached thread targets (a test that rewrites stored replies by hand). */
export function clearThreadTargetCache(): void {
  threadTargetCache.clear();
}

// ───────────────────────── context ─────────────────────────

/**
 * B1 / SPEC "first catches up … then resumes sending": Mailgun emails wait after start-up until a
 * check with Mailgun has succeeded since then. After 15 minutes a catch-up that finished with a
 * network or server failure opens the gate anyway (a Mailgun hiccup can't stop a whole day); an
 * "auth" failure never does, and a catch-up that hasn't run yet keeps it closed. Mailgun not
 * connected, or no start time given (tests): open.
 */
export function isCatchUpReady(input: {
  connected: boolean;
  startedAt: Date | null | undefined;
  now: Date;
  catchUp: CatchUpState;
}): boolean {
  if (!input.connected || !input.startedAt) return true;
  const started = input.startedAt.getTime();
  const success = input.catchUp.lastSuccessAt ? Date.parse(input.catchUp.lastSuccessAt) : Number.NaN;
  if (Number.isFinite(success) && success >= started) return true;
  if (input.now.getTime() - started < CATCH_UP_FALLBACK_MS) return false;
  const finished = input.catchUp.lastFinishedAt ? Date.parse(input.catchUp.lastFinishedAt) : Number.NaN;
  if (!Number.isFinite(finished) || finished < started) return false;
  return input.catchUp.lastErrorKind === "network" || input.catchUp.lastErrorKind === "server";
}

/**
 * The start-up check for TEST/LIVE follow-ups (M4-DESIGN §2.8.3 rule 2, D7): a catch-up must have succeeded since the
 * start, with no 15-minute fallback, because only a complete walk of Mailgun's logs finds an outage (and so the
 * follow-ups whose replies may have been missed). The worker moves its start time after time it couldn't account for
 * (the PC asleep or hibernating, the lease lost), so a wake-up counts as a start. And while the latest check failed
 * after the last success (Mailgun or the network unreachable while the PC stayed on), replies from that time may not
 * be stored yet: follow-ups wait for the next successful check too. Mailgun not connected, or no start time given
 * (tests): open.
 */
export function isFollowUpCatchUpReady(input: { connected: boolean; startedAt: Date | null | undefined; catchUp: CatchUpState }): boolean {
  if (!input.connected || !input.startedAt) return true;
  const success = input.catchUp.lastSuccessAt ? Date.parse(input.catchUp.lastSuccessAt) : Number.NaN;
  if (!Number.isFinite(success) || success < input.startedAt.getTime()) return false;
  const finished = isoMs(input.catchUp.lastFinishedAt);
  return !(input.catchUp.lastErrorKind !== null && Number.isFinite(finished) && finished > success);
}

/**
 * The final check's second look at the gates that can close between the pick and the hand-over (a TEST/LIVE email,
 * M4-DESIGN §2.8.3): an outage found meanwhile holds a follow-up ("outage-hold"); a new start, e.g. the PC waking up
 * mid-tick, or a check with Mailgun that failed meanwhile closes the check-with-Mailgun gate ("catch-up"). Two small
 * state reads. Null when the email may still go.
 *
 * Review SEND-2 (MAIN-DOMAIN-DESIGN O23): with a Mailgun plan that has a daily limit, the rolling 24 hours are counted
 * once more, without this email (it is already claimed, so every test send admitted from now on counts it): when test
 * emails sent since the tick used the campaign room up, it waits "plan-limit". The claim is committed before this count
 * and a test send counts and records in one lock-first transaction, so neither can miss the other. No plan limit (app
 * mode without a chosen plan): one Settings read, nothing counted.
 */
export async function startGatesClosed(
  c: { id: number; step: number; mode: SendMode },
  opts: { now: Date; startedAt?: Date | null },
): Promise<WaitReason | null> {
  const [outage, catchUp] = await Promise.all([
    readTyped(STATE_KEYS.outage, parseOutageState),
    opts.startedAt ? readTyped(STATE_KEYS.catchUp, parseCatchUpState) : Promise.resolve(null),
  ]);
  if (c.step >= 1 && outageHoldPending(outage.value)) return "outage-hold";
  if (catchUp) {
    const input = { connected: true, startedAt: opts.startedAt, catchUp: catchUp.value };
    const ready = c.step >= 1 ? isFollowUpCatchUpReady(input) : isCatchUpReady({ ...input, now: opts.now });
    if (!ready) return "catch-up";
  }
  if (isMailgunMode(c.mode) && (await planFullWithout(c.id, opts.now))) return "plan-limit";
  return null;
}

/** The plan's campaign room in the last 24 hours is used up, counting everything but email `emailId` (review SEND-2). */
async function planFullWithout(emailId: number, now: Date): Promise<boolean> {
  const limits = await loadPlanLimits();
  if (!limits || limits.dailyLimit === null) return false;
  const used = await countMailgunSendsSince(new Date(now.getTime() - PLAN_WINDOW_MS), db, { exceptEmailId: emailId });
  return (planRoom(limits, used.total)?.campaign ?? 1) <= 0;
}

/**
 * An outage was found (a gap in Mailgun's logs the app couldn't check) and its hold isn't applied yet (M4-DESIGN
 * §2.8.3 rule 1): TEST/LIVE follow-ups wait until `applyOutageHold` has run; first emails go.
 */
export function outageHoldPending(state: Pick<OutageState, "from" | "handledAt">): boolean {
  return state.from !== null && state.handledAt === null;
}

/**
 * Live emails may go while Setup A is chosen and neither the "tracking-off" nor the "unsubscribe"
 * checklist row is "bad" (PLAN: our footer's unsubscribe link needs Mailgun's handling). A row that
 * couldn't be checked ("unknown") or was never checked never holds anything here.
 */
export function isLiveReady(setup: UnsubscribeSetup, rows: readonly ChecklistRow[]): boolean {
  if (setup !== "A") return false;
  return !rows.some((r) => (r.key === "tracking-off" || r.key === "unsubscribe") && r.status === "bad");
}

/**
 * SHARED-FROM-DESIGN F27: live emails may go unless the checklist's "from-mx" row (shared-From mode only) is "bad": the
 * main domain's MX points to Mailgun or is missing, so everyday email and the replies Mailgun forwards there are lost.
 * "warn", "unknown", no row (never checked, or per-person mode) hold nothing. `rows` are today's domain's.
 *
 * Review SECURITY-3: `teamFromSaved` is `loadTeamFrom().saved`. Per-person mode (`null`: nothing saved) is never held,
 * not even by a "bad" from-mx row a check stored before the From address was cleared (the next check drops the row).
 * A saved From address that doesn't fit still lets a "bad" row hold (fail closed). Absent: the rows alone decide.
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O10) passes the saved From or, with none, the sending domain, so its from-mx row
 * (the sending domain's own MX) holds whether or not a From is saved.
 */
export function isMainDomainMxOk(rows: readonly ChecklistRow[], teamFromSaved?: string | null): boolean {
  if (teamFromSaved === null) return true;
  return !rows.some((r) => r.key === "from-mx" && r.status === "bad");
}

/** Mailgun "not connected" without asking (no candidate needs Mailgun this tick). */
const MAILGUN_NOT_NEEDED: MailgunContextResult = { connected: false, reason: "no-domain", text: "" };

/** The rolling window of a plan's daily limit (MAIN-DOMAIN-DESIGN O23): 24 hours. */
const PLAN_WINDOW_MS = 24 * 3_600_000;

/** The Mailgun context, or "not connected" with the reason when loading it fails. */
export async function safeMailgunContext(
  loader?: () => Promise<MailgunContextResult>,
): Promise<MailgunContextResult> {
  try {
    return await (loader ?? (() => getMailgunContext()))();
  } catch (err) {
    return { connected: false, reason: "no-key", text: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Everything the gates look at, for one tick (§4.3.2, M4-DESIGN §2.10): the settings, the pause, today's limit, the
 * pacer, the start-up check with Mailgun (first emails and follow-ups apart), the outage record, the restore check,
 * the live-readiness and reply routes, and the guard's `problems` (from `pendingProblemIds`, computed by the caller for
 * its candidates; none when not given). All local reads; the Mailgun context builds clients, no request.
 *
 * MAIN-DOMAIN-DESIGN: the way of sending (`loadTeamFrom().replies`, O1); checklist rows stored for the other way are
 * ignored like another domain's (`checkMatchesMode`, O36); the plan's rolling daily limit (`loadPlanLimits`,
 * `countMailgunSendsSince(now − 24 h)`, `planRoom`, O23; counted only when the plan has a daily limit).
 */
export async function loadGateContext(
  now: Date,
  deps: {
    startedAt?: Date | null;
    mailgun?: () => Promise<MailgunContextResult>;
    due: DueStats;
    /** pendingProblemIds(the gated candidates). Default: nothing held. */
    problems?: ProblemIds;
    /** False when no candidate needs Mailgun: the context isn't loaded. Default true. */
    needMailgun?: boolean;
    /** Overrides the catch-up gate (the campaign page reads it from the pacer instead). Also used for follow-ups unless `followUpCatchUpReady` is given. */
    catchUpReady?: boolean;
    /** Overrides the follow-ups' catch-up gate. */
    followUpCatchUpReady?: boolean;
  },
): Promise<GateContext> {
  const s = await getSettings([
    "sending.window",
    "defaultTimeZone",
    "sending.minGapSeconds",
    "practice.copy",
    "sending.goLive",
    "mailgun.unsubscribeTest",
    "mailgun.domain",
  ] as const);
  const practiceCopy = s["practice.copy"] === true;
  const [pause, today, pacer, catchUp, restore, domainCheck, outage] = await Promise.all([
    getPauseState(),
    getTodayCap(now, { practiceCopy }),
    readTyped(STATE_KEYS.pacer, parsePacerState),
    readTyped(STATE_KEYS.catchUp, parseCatchUpState),
    readTyped(STATE_KEYS.restore, parseRestoreState),
    readTyped(STATE_KEYS.domainCheck, parseDomainCheckState),
    readTyped(STATE_KEYS.outage, parseOutageState),
  ]);
  const mailgun = deps.needMailgun === false ? MAILGUN_NOT_NEEDED : await safeMailgunContext(deps.mailgun);
  // Review SECURITY-3: the main-domain MX hold applies only while a From address is saved (per-person mode never waits).
  const team = await loadTeamFrom();
  const ownMailbox = team.replies === "own-mailbox";
  const users = await db.user.findMany({ select: { id: true, dailyCap: true } });
  const addresses = await db.senderAddress.findMany({ select: { address: true, routeStatus: true } });
  const setup = parseUnsubscribeTest(s["mailgun.unsubscribeTest"]).setup;
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase();
  // Checklist rows of another (older) domain, or of the other way of sending (O36), say nothing about this one.
  const otherDomain = Boolean(domainCheck.value.domain && domain && domainCheck.value.domain !== domain);
  const rows = otherDomain || !checkMatchesMode(domainCheck.value, team.replies) ? [] : domainCheck.value.rows;
  // O23: the plan's rolling daily limit (only counted when the plan has one).
  const limits = await loadPlanLimits();
  let planLeft: number | null = null;
  let planOpensAt: Date | null = null;
  if (limits && limits.dailyLimit !== null) {
    const used = await countMailgunSendsSince(new Date(now.getTime() - PLAN_WINDOW_MS));
    planLeft = planRoom(limits, used.total)?.campaign ?? null;
    planOpensAt = used.oldestAt ? new Date(used.oldestAt.getTime() + PLAN_WINDOW_MS) : null;
  }
  const minGap = Number(s["sending.minGapSeconds"]);
  return {
    now,
    pause,
    today,
    window: parseWindow(s["sending.window"]),
    defaultZone: resolveZone(s["defaultTimeZone"], "Europe/Berlin"),
    minGapSeconds: Number.isFinite(minGap) && minGap > 0 ? minGap : 20,
    pacer: pacer.value,
    mailgun,
    catchUpReady:
      deps.catchUpReady ??
      isCatchUpReady({ connected: mailgun.connected, startedAt: deps.startedAt, now, catchUp: catchUp.value }),
    followUpCatchUpReady:
      deps.followUpCatchUpReady ??
      deps.catchUpReady ??
      isFollowUpCatchUpReady({ connected: mailgun.connected, startedAt: deps.startedAt, catchUp: catchUp.value }),
    outageHoldPending: outageHoldPending(outage.value),
    practiceCopy,
    goLive: s["sending.goLive"] === true,
    senderCaps: new Map(users.map((u) => [u.id, u.dailyCap])),
    restoreHold: restoreHoldActive(restore.value),
    liveReady: isLiveReady(setup, rows),
    // O10: in own-mailbox mode the from-mx row is the sending domain's own and holds whether or not a From is saved.
    mainDomainMxOk: isMainDomainMxOk(rows, ownMailbox ? (team.saved ?? domain) : team.saved),
    routeOk: new Map(addresses.map((a) => [a.address.toLowerCase(), a.routeStatus === "ok"])),
    problems: deps.problems ?? noProblems(),
    due: deps.due,
    ownMailbox,
    planLeft,
    planOpensAt,
  };
}

// ───────────────────────── the plan ─────────────────────────

/** How many more emails a sender may send today (Infinity without a limit of their own). `extra`: already planned this tick. */
function senderLeft(senderId: number | null, ctx: Pick<GateContext, "senderCaps" | "today">, extra = 0): number {
  if (senderId === null) return Number.POSITIVE_INFINITY;
  return senderCapacityLeft(ctx.senderCaps.get(senderId), (ctx.today.bySender.get(senderId) ?? 0) + extra);
}

type PaceClass = "counted" | "uncounted";

/** One class's pacing inputs: how many of its due emails can really go today, and the zones they are in. */
type ClassInputs = { dueCount: number; zones: string[] };

/**
 * Pacing inputs (§4.3.2), from the due rows (not the candidates): only rows that can really go today. A zone counts
 * while its window still opens before the cap day ends. A counted sender adds at most what their own daily limit
 * still allows: a sender with 10 left and 500 due adds 10, so those 10 spread over the day instead of going out in
 * the first minutes and then waiting for the rest of the day.
 */
function paceClasses(ctx: GateContext): Record<PaceClass, ClassInputs> {
  const openToday = new Map<string, boolean>();
  const hasOpenTime = (zone: string) => {
    let v = openToday.get(zone);
    if (v === undefined) {
      v = openSecondsBetween(ctx.now, ctx.today.dayEnd, [zone], ctx.window) > 0;
      openToday.set(zone, v);
    }
    return v;
  };
  const countedBySender = new Map<number | null, number>();
  const countedZones = new Set<string>();
  const uncounted = { dueCount: 0, zones: new Set<string>() };
  for (const d of ctx.due) {
    if (d.count <= 0 || !hasOpenTime(d.zone)) continue;
    if (d.counted) {
      if (senderLeft(d.senderId, ctx) <= 0) continue;
      countedBySender.set(d.senderId, (countedBySender.get(d.senderId) ?? 0) + d.count);
      countedZones.add(d.zone);
    } else {
      uncounted.dueCount += d.count;
      uncounted.zones.add(d.zone);
    }
  }
  let countedDue = 0;
  for (const [senderId, n] of countedBySender) countedDue += Math.min(n, senderLeft(senderId, ctx));
  return {
    counted: { dueCount: countedDue, zones: [...countedZones] },
    uncounted: { dueCount: uncounted.dueCount, zones: [...uncounted.zones] },
  };
}

function isoMs(v: string | null | undefined): number {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * The pacer, recomputed every tick (PLAN B6.6 "every 5 s the sending loop computes"): returns, for a candidate of a
 * class in a zone, the earliest time (epoch ms) it may go.
 *  - The gap after the class's last send follows the class's CURRENT inputs: its due emails that can go today (N)
 *    over N + 1 intervals of the open time from that send to the end of the cap day, times the random factor drawn
 *    at that send, never below the smallest gap (paceGapMs). A campaign launched after a send, a resumed campaign or
 *    a schedule that starts shortens the wait at once; the other class never waits for this one's gap.
 *  - Last chance today: when the candidate's own window closes before that time, it gets its turn just before the
 *    close (one smallest gap before it), instead of slipping to the next sending day.
 *  - No two gated sends are closer than the smallest gap, whatever their class.
 */
function makePacer(
  ctx: GateContext,
  classes: Record<PaceClass, ClassInputs>,
  capacityLeft: () => number,
): (cls: PaceClass, zone: string) => number {
  const now = ctx.now.getTime();
  const minGapMs = ctx.minGapSeconds * 1000;
  const lastAny = isoMs(ctx.pacer.lastSentAt);
  const floor = Number.isFinite(lastAny) ? lastAny + minGapMs : Number.NEGATIVE_INFINITY;
  const planned = new Map<PaceClass, number>();
  const plannedFor = (cls: PaceClass): number => {
    const cached = planned.get(cls);
    if (cached !== undefined) return cached;
    let v = Number.NaN;
    const last = ctx.pacer.lastByClass[cls];
    const at = isoMs(last?.at);
    const inputs = classes[cls];
    if (last && Number.isFinite(at) && inputs.zones.length > 0) {
      const open = openSecondsBetween(new Date(Math.min(at, now)), ctx.today.dayEnd, inputs.zones, ctx.window);
      const gap = paceGapMs({
        openSecondsLeft: open,
        capacityLeft: cls === "counted" ? capacityLeft() : Number.POSITIVE_INFINITY,
        dueCount: inputs.dueCount,
        minGapSeconds: ctx.minGapSeconds,
        jitter: last.jitter,
      });
      if (gap !== null) v = at + gap;
    }
    planned.set(cls, v);
    return v;
  };
  const closes = new Map<string, number>();
  const closeOf = (zone: string): number => {
    let v = closes.get(zone);
    if (v === undefined) {
      v = windowCloseAfter(ctx.now, zone, ctx.window)?.getTime() ?? Number.NaN;
      closes.set(zone, v);
    }
    return v;
  };
  return (cls, zone) => {
    let p = plannedFor(cls);
    if (!Number.isFinite(p)) return floor;
    const close = closeOf(zone);
    if (Number.isFinite(close) && p > close - minGapMs) p = close - minGapMs;
    return Math.max(floor, p);
  };
}

/**
 * Pure given the context (§4.3.2 planTick, M4-DESIGN §2.10). For the gated candidates in order (follow-ups
 * first), each check holds only the rows it names; the first row left is `next`. `waiting` is why the first
 * candidate was held (null when it is the one going out), "outside-hours" when every due row is in a zone whose
 * window is closed, or "nothing-due":
 *   paused → restore check (TEST/LIVE) → Mailgun not connected (TEST/LIVE) → the start-up check with
 *   Mailgun (TEST/LIVE; first emails with M3's 15-minute fallback, follow-ups only after a successful
 *   check) → an outage found but not held yet (TEST/LIVE follow-ups), or a hold after one that covers
 *   the company or sender of someone it doesn't hold (TEST/LIVE) → a Mailgun back-off (TEST/LIVE)
 *   → the plan's rolling daily limit (TEST/LIVE, MAIN-DOMAIN-DESIGN O23: `planLeft` ≤ 0 waits until `planOpensAt`)
 *   → live settings drifted (LIVE) → the main domain's MX points to Mailgun or is missing (LIVE, shared-From mode's
 *   from-mx row "bad", SHARED-FROM-DESIGN F27; own-mailbox mode's own from-mx row, O10) → reply route (LIVE, keyed by
 *   the route address; never in own-mailbox mode, O9) → an unprocessed report or reply that could
 *   concern the address or its company (skipped; the next one is tried) → a possible reply of the
 *   company nobody has decided (skipped too) → today's inbox check (own-mailbox, LIVE follow-ups and first emails at a
 *   company emailed before today, O33 and review SEND-1: skipped too, the first one kept in `inboxHeld`) → today's
 *   limit (counted) → the sender's own limit
 *   (counted) → the pacer (per class, see makePacer; a paced row doesn't stop a row of the other
 *   class, or one on its last chance today).
 * A pacing wait reports the earliest time any held row may go.
 *
 * In the practice copy, dry runs with "Ignore sending hours" count as real, so the ungated batch
 * stays within today's limit and each sender's own limit (hours and gaps are still ignored), and the
 * gated rows after it get what is left.
 */
export function planTick(ungated: Candidate[], gated: Candidate[], ctx: GateContext): TickPlan {
  const classes = paceClasses(ctx);
  const seconds = (zones: string[]) => (zones.length ? openSecondsBetween(ctx.now, ctx.today.dayEnd, zones, ctx.window) : 0);
  const plan: TickPlan = {
    ungated: ungated.slice(0, SEND_BATCH),
    next: null,
    nextCounted: false,
    waiting: null,
    capReached: false,
    pace: {
      counted: { dueCount: classes.counted.dueCount, openSecondsLeft: seconds(classes.counted.zones) },
      uncounted: { dueCount: classes.uncounted.dueCount, openSecondsLeft: seconds(classes.uncounted.zones) },
    },
    routeHeld: null,
    inboxHeld: null,
  };
  if (ctx.pause.paused) return { ...plan, ungated: [], waiting: { reason: "paused", until: null } };

  // What is left of today's limits as this tick fills up (the ungated batch goes first).
  const budget = { left: ctx.today.left, bySender: new Map<number, number>() };
  const spend = (senderId: number | null) => {
    budget.left -= 1;
    if (senderId !== null) budget.bySender.set(senderId, (budget.bySender.get(senderId) ?? 0) + 1);
  };
  let ungatedHeld: { reason: WaitReason; until: Date | null } | null = null;
  if (ctx.practiceCopy && plan.ungated.length > 0) {
    const kept: Candidate[] = [];
    for (const c of plan.ungated) {
      if (budget.left <= 0) {
        plan.capReached = true;
        ungatedHeld ??= { reason: "cap-reached", until: ctx.today.dayEnd };
        continue;
      }
      if (senderLeft(c.senderId, ctx, c.senderId === null ? 0 : (budget.bySender.get(c.senderId) ?? 0)) <= 0) {
        ungatedHeld ??= { reason: "sender-cap", until: ctx.today.dayEnd };
        continue;
      }
      spend(c.senderId);
      kept.push(c);
    }
    plan.ungated = kept;
  }

  const now = ctx.now.getTime();
  const mailgunOk = ctx.mailgun.connected && !ctx.practiceCopy;
  const backoffUntil = isoMs(ctx.pacer.backoffUntil);
  const backoff = Number.isFinite(backoffUntil) && backoffUntil > now;
  const pacer = makePacer(ctx, classes, () => budget.left);
  let pacedUntil = Number.POSITIVE_INFINITY;

  const held: { first: { reason: WaitReason; until: Date | null } | null } = { first: null };
  const hold = (reason: WaitReason, until: Date | null = null) => {
    held.first ??= { reason, until };
  };
  for (const c of gated) {
    const cls = gateClass(c, ctx);
    if (cls === "ungated") continue;
    const viaMailgun = isMailgunMode(c.mode);
    if (viaMailgun && ctx.restoreHold) {
      hold("restore-check");
      continue;
    }
    if (viaMailgun && !mailgunOk) {
      hold("mailgun-not-connected");
      continue;
    }
    const followUp = c.step >= 1;
    if (viaMailgun && !(followUp ? ctx.followUpCatchUpReady : ctx.catchUpReady)) {
      hold("catch-up");
      continue;
    }
    if (viaMailgun && followUp && ctx.outageHoldPending) {
      hold("outage-hold");
      continue;
    }
    // Not held themselves, but the hold after the PC was off covers them (a Retry, a later launch).
    if (viaMailgun && ctx.problems.outage?.has(c.id)) {
      hold("outage-hold");
      continue;
    }
    if (viaMailgun && backoff) {
      hold(ctx.pacer.backoffReason ?? "mailgun-unreachable", new Date(backoffUntil));
      continue;
    }
    // O23: the Mailgun plan's rolling daily limit is used up (campaign emails keep the test reserve).
    if (viaMailgun && ctx.planLeft !== null && ctx.planLeft <= 0) {
      hold("plan-limit", ctx.planOpensAt);
      continue;
    }
    if (c.mode === "LIVE" && !ctx.liveReady) {
      hold("live-not-ready");
      continue;
    }
    // F27: the main domain's MX points to Mailgun or is missing (the from-mx row is "bad").
    if (c.mode === "LIVE" && !ctx.mainDomainMxOk) {
      hold("main-domain-mx");
      continue;
    }
    // O9: own-mailbox mode has no reply route, so nothing waits for one.
    if (c.mode === "LIVE" && !ctx.ownMailbox && ctx.routeOk.get(c.routeAddress) !== true) {
      plan.routeHeld ??= c;
      hold("reply-route");
      continue;
    }
    if (ctx.problems.pending.has(c.id)) {
      hold("pending-events");
      continue;
    }
    if (ctx.problems.possibleReply.has(c.id)) {
      hold("possible-reply");
      continue;
    }
    // O33: own-mailbox mode, a LIVE follow-up (or a first email at a company emailed before today, review SEND-1) waits
    // for today's inbox check (`inboxCheckHeldIds`).
    if (ctx.problems.inboxCheck?.has(c.id)) {
      plan.inboxHeld ??= c;
      hold("inbox-check");
      continue;
    }
    const counted = cls === "gated-counted";
    if (counted && budget.left <= 0) {
      plan.capReached = true;
      hold("cap-reached", ctx.today.dayEnd);
      continue;
    }
    if (counted && senderLeft(c.senderId, ctx, c.senderId === null ? 0 : (budget.bySender.get(c.senderId) ?? 0)) <= 0) {
      hold("sender-cap", ctx.today.dayEnd);
      continue;
    }
    const until = pacer(counted ? "counted" : "uncounted", c.zone);
    if (until > now) {
      pacedUntil = Math.min(pacedUntil, until);
      hold("pacing", new Date(until));
      continue;
    }
    plan.next = c;
    plan.nextCounted = counted;
    break;
  }
  // "Next email in about …": the earliest time any paced row may go.
  if (held.first?.reason === "pacing" && Number.isFinite(pacedUntil)) held.first = { reason: "pacing", until: new Date(pacedUntil) };

  if (gated.length === 0) {
    const zones = [...new Set(ctx.due.filter((d) => d.count > 0).map((d) => d.zone))];
    if (ungatedHeld) {
      plan.waiting = ungatedHeld;
    } else if (zones.length > 0) {
      const opens = zones.map((z) => nextWindowOpen(ctx.now, z, ctx.window).getTime());
      plan.waiting = { reason: "outside-hours", until: new Date(Math.min(...opens)) };
    } else {
      plan.waiting = { reason: "nothing-due", until: null };
    }
    return plan;
  }
  const first = gated[0]!;
  plan.waiting = plan.next && plan.next.id === first.id ? null : (held.first ?? { reason: "nothing-due", until: null });
  return plan;
}

// ───────────────────────── the pacer ─────────────────────────

/** Merges fields into SystemState "sending.pacer" (compare-and-set). */
export async function savePacer(now: Date, update: Partial<PacerState>): Promise<void> {
  void now;
  await updateTyped(STATE_KEYS.pacer, parsePacerState, (cur) => ({ ...cur, ...update }));
}

/**
 * Records why gated emails are waiting (the Limits page and the campaign page read it). Written only
 * when the reason or its time changes, or once a minute. Also keeps `routeWaitSince` (since when
 * live emails wait for a reply route; the Owner is told after an hour). Returns the stored state.
 */
export async function saveWaiting(
  now: Date,
  waiting: { reason: WaitReason; until: Date | null } | null,
  opts: { routeHeld: boolean },
): Promise<PacerState> {
  const res = await updateTyped(STATE_KEYS.pacer, parsePacerState, (cur) => {
    const routeWaitSince = opts.routeHeld ? (cur.routeWaitSince ?? now.toISOString()) : null;
    const nextWaiting = waiting
      ? { reason: waiting.reason, until: waiting.until ? waiting.until.toISOString() : null, at: now.toISOString() }
      : null;
    const same =
      (cur.waiting === null && nextWaiting === null) ||
      (cur.waiting !== null &&
        nextWaiting !== null &&
        cur.waiting.reason === nextWaiting.reason &&
        cur.waiting.until === nextWaiting.until &&
        now.getTime() - isoMs(cur.waiting.at) < WAITING_REFRESH_MS);
    if (same && cur.routeWaitSince === routeWaitSince) return null;
    return { ...cur, waiting: same ? cur.waiting : nextWaiting, routeWaitSince };
  });
  return res.value;
}

// ───────────────────────── one campaign's waiting line ─────────────────────────

/**
 * Why one campaign's due emails are waiting right now (the campaign page's waiting line), by running
 * the same gates over that campaign's own due rows (paced with every due row, as the sending loop
 * does). Null when it has nothing gated due, or its next email is about to go. The start-up check
 * with Mailgun is read from the pacer (the web process doesn't know when the worker started). In the
 * practice copy, a dry run with "Ignore sending hours" on can still wait for today's limit.
 */
export async function explainCampaignWaiting(
  campaignId: number,
  now: Date = new Date(),
  deps: { mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<{ reason: WaitReason; until: Date | null } | null> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, mode: true, ignoreWindow: true } });
  if (!c || !c.mode || (c.status !== "RUNNING" && c.status !== "SCHEDULED")) return null;
  const s = await getSettings(["practice.copy", "sending.window", "defaultTimeZone"] as const);
  const practiceCopy = s["practice.copy"] === true;
  const cls = gateClass({ mode: c.mode, ignoreWindow: c.ignoreWindow }, { practiceCopy });
  if (cls === "ungated" && !practiceCopy) return null;
  const pause = await getPauseState();
  if (pause.paused) return { reason: "paused", until: null };
  if (c.status !== "RUNNING") return null;

  const window = parseWindow(s["sending.window"]);
  const defaultZone = resolveZone(s["defaultTimeZone"], "Europe/Berlin");
  const rows = await db.outboundEmail.findMany({
    where: { ...dueWhere(now), campaignId, recipient: { state: { notIn: [...WAITING_RECIPIENT_STATES] } } },
    orderBy: CANDIDATE_ORDER,
    take: 50,
    select: candidateSelect,
  });
  if (rows.length === 0) return null;
  const all = rows.map((r) => toCandidate(r, defaultZone));
  if (cls === "ungated") {
    // Practice copy, "Ignore sending hours" on: only today's limit and the senders' own limits hold these.
    const limits = await loadGateContext(now, { due: [], needMailgun: false, catchUpReady: true });
    const plan = planTick(all, [], limits);
    return plan.ungated.length === 0 && plan.waiting && plan.waiting.reason !== "nothing-due" ? plan.waiting : null;
  }
  const open = all.filter((x) => isWindowOpen(now, x.zone, window));
  if (open.length === 0) {
    const opens = [...new Set(all.map((x) => x.zone))].map((z) => nextWindowOpen(now, z, window).getTime());
    return { reason: "outside-hours", until: new Date(Math.min(...opens)) };
  }
  const due = await loadDueStats(now, { defaultZone, practiceCopy });
  const pacer = (await readTyped(STATE_KEYS.pacer, parsePacerState)).value;
  // The web app doesn't know when the worker started: the worker's own "waiting for the check with Mailgun" decides.
  const catchUpWaiting =
    pacer.waiting?.reason === "catch-up" && now.getTime() - isoMs(pacer.waiting.at) < 2 * WAITING_REFRESH_MS;
  const ctx = await loadGateContext(now, {
    mailgun: deps.mailgun,
    due,
    problems: await pendingProblemIds(open, now),
    needMailgun: isMailgunMode(c.mode),
    catchUpReady: !catchUpWaiting,
  });
  const plan = planTick([], open, ctx);
  if (plan.next) return null;
  return plan.waiting && plan.waiting.reason !== "nothing-due" ? plan.waiting : null;
}
