import { capDayBounds, capDayOf, safeZone } from "@/core/sending/capday";
import { INBOX_CHECK_TEXTS } from "@/core/sending/own-mailbox";
import { STATE_KEYS, type InboxCheckState } from "@/core/system-state";
import { parseInboxCheckState } from "@/core/system-state-parse";
import { logActivity } from "@/server/activity";
import { db } from "@/server/db";
import { readTyped, updateTyped } from "@/server/state-typed";
import { ServiceError, type Actor } from "@/server/services/companies/mutations";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { INBOX_CHECK_CLOCK_SKEW_MS, inboxCheckTime } from "./gates";

/**
 * The daily inbox check (MAIN-DOMAIN-DESIGN O33, §2.9, §3.9). In own-mailbox mode replies land only in the own mailbox
 * (contact@polygonparadise.com), so LIVE follow-ups wait each cap day until someone has read it (inbox and Spam) and
 * clicked "I've read contact@polygonparadise.com". This file is the only writer of SystemState "sending.inboxCheck"
 * (`markInboxChecked`) and the Notifications page's card reads it through `loadInboxCheck`. The gate that holds the
 * follow-ups (`inboxCheckHeldIds`, gates.ts) reads the same key and the same cap day: checked today = `at` at or after
 * the start of today's cap day (Setting "sending.capDayTimeZone") and not more than a minute ahead of the clock
 * (`inboxCheckTime`, review SECURITY-02).
 */

/** Companies the card lists by name (§3.9); the rest are "and {n} more". */
export const INBOX_CHECK_LIST_MAX = 20;

const DAY_MS = 86_400_000;

/**
 * The mailbox the check is about, for the card, the button and the activity: the own From, or what is saved while it
 * doesn't fit the sending domain, or plain words when nothing is saved (the check still applies in own-mailbox mode).
 */
export function inboxCheckFrom(team: Pick<TeamFromState, "ownFrom" | "saved">): string {
  return team.ownFrom ?? team.saved ?? "your own mailbox";
}

/**
 * "I've read contact@polygonparadise.com" (O33): refused outside own-mailbox mode; otherwise records the click
 * (`{ at: now, byUserId }`, compare-and-set) and logs `sending.inboxChecked` ("Arslan read contact@polygonparadise.com
 * (inbox and Spam)", data `{ from }`). Open to everyone (the activity names who clicked). No transaction with anything
 * else, no Mailgun.
 *
 * The stored time is never later than this clock allows (review SECURITY-02): a click that lands a moment after another
 * one whose clock read a few seconds later keeps that later time, but a stored time more than a minute ahead of `now`
 * came from a clock that ran ahead (a reset BIOS clock, a wrong date corrected later) and is replaced by `now`, so
 * clicking again always repairs it. Until then the gate and the card treat it as "not read today" (`inboxCheckTime`).
 */
export async function markInboxChecked(actor: Actor, now: Date = new Date()): Promise<{ at: Date; from: string }> {
  const team = await loadTeamFrom();
  if (team.replies !== "own-mailbox") throw new ServiceError(INBOX_CHECK_TEXTS.notOwnMailbox);
  const from = inboxCheckFrom(team);
  const next: InboxCheckState = { at: now.toISOString(), byUserId: actor.id };
  await updateTyped(STATE_KEYS.inboxCheck, parseInboxCheckState, (cur) => {
    const last = cur.at ? Date.parse(cur.at) : Number.NaN;
    const laterByMoments = Number.isFinite(last) && last > now.getTime() && last - now.getTime() <= INBOX_CHECK_CLOCK_SKEW_MS;
    return laterByMoments ? null : next;
  });
  await logActivity({
    actorId: actor.id,
    type: "sending.inboxChecked",
    summary: INBOX_CHECK_TEXTS.activity(actor.name, from),
    data: { from },
  });
  return { at: now, from };
}

export type InboxCheckWaiting = { companyId: number; companyName: string; count: number };

export type InboxCheckView = {
  /**
   * The last click, or null when nobody has checked yet, or when the stored time is more than a minute ahead of the
   * clock (a click while the clock ran ahead counts as no check, review SECURITY-02).
   */
  at: Date | null;
  /** Who clicked last (null when nobody has, or the user can't be found). */
  byName: string | null;
  /** The last click lies in today's cap day: live follow-ups due today may go (the gate's own rule). */
  today: boolean;
  /** Companies with live follow-ups due within 24 hours, soonest first, at most `INBOX_CHECK_LIST_MAX`. */
  waiting: InboxCheckWaiting[];
  /** Every such follow-up (all companies). */
  waitingTotal: number;
  /** How many companies have one (so the card can say "and {n} more"). */
  waitingCompanies: number;
};

/**
 * The card's facts (§2.9): the last click and who made it, whether it is today's (cap day), and the LIVE follow-ups
 * (step 1 or later, still waiting to go, due now or within the next 24 hours, campaign running or paused) grouped by
 * company. Reads only.
 */
export async function loadInboxCheck(now: Date = new Date()): Promise<InboxCheckView> {
  const [state, zoneRow, groups] = await Promise.all([
    readTyped(STATE_KEYS.inboxCheck, parseInboxCheckState),
    db.setting.findUnique({ where: { key: "sending.capDayTimeZone" }, select: { value: true } }),
    db.outboundEmail.groupBy({
      by: ["companyId"],
      where: {
        mode: "LIVE",
        status: "QUEUED",
        step: { gte: 1 },
        dueAt: { lte: new Date(now.getTime() + DAY_MS) },
        campaign: { status: { in: ["RUNNING", "PAUSED"] } },
      },
      _count: { _all: true },
      _min: { dueAt: true },
    }),
  ]);
  const zone = safeZone(typeof zoneRow?.value === "string" ? zoneRow.value : null);
  const { start } = capDayBounds(capDayOf(now, zone), zone);
  // The gate's own rule (`inboxCheckedToday`): a time more than a minute in the future is no check at all.
  const atMs = inboxCheckTime(state.value.at, now);
  const at = Number.isFinite(atMs) ? new Date(atMs) : null;
  const today = at !== null && at.getTime() >= start.getTime();

  const byUserId = at ? state.value.byUserId : null;
  const byName = byUserId ? ((await db.user.findUnique({ where: { id: byUserId }, select: { name: true } }))?.name ?? null) : null;

  const waitingTotal = groups.reduce((sum, g) => sum + g._count._all, 0);
  const byCompany = groups
    .filter((g): g is typeof g & { companyId: number } => g.companyId !== null)
    .sort((a, b) => (a._min.dueAt?.getTime() ?? 0) - (b._min.dueAt?.getTime() ?? 0) || a.companyId - b.companyId);
  const shown = byCompany.slice(0, INBOX_CHECK_LIST_MAX);
  const names = new Map(
    (
      await db.company.findMany({ where: { id: { in: shown.map((g) => g.companyId) } }, select: { id: true, name: true } })
    ).map((c) => [c.id, c.name]),
  );
  return {
    at,
    byName,
    today,
    waiting: shown.map((g) => ({ companyId: g.companyId, companyName: names.get(g.companyId) ?? `Company ${g.companyId}`, count: g._count._all })),
    waitingTotal,
    waitingCompanies: byCompany.length,
  };
}
