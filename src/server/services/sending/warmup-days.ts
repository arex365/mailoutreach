import {
  addCapDays,
  capDayBounds,
  capDayOf,
  capDayOfWeek,
  closedCapDaysAfter,
  safeZone,
  type CapDay,
} from "@/core/sending/capday";
import { warmupCapFor, warmupTable } from "@/core/sending/caps";
import { healthCountingSince, healthGoLiveAt } from "@/core/sending/health-since";
import { evaluateWarmupDay, isHealthyForWarmup } from "@/core/sending/warmup";
import { isWeekdaysOnly, type WarmupToday } from "@/core/sending/warmup-line";
import { parseWindow } from "@/core/sending/window";
import { WARMUP_HISTORY_MAX, parseCatchUpState, parseHealthBaseline, parseWarmupState } from "@/core/system-state-parse";
import { STATE_KEYS, type WarmupDay, type WarmupState } from "@/core/system-state";
import { db } from "@/server/db";
import { logActivity } from "@/server/activity";
import { getSettings, type SettingValue } from "@/server/settings";
import { casState } from "@/server/state";
import { readTyped, updateTyped } from "@/server/state-typed";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { loadEffectiveMaxDailyCap } from "@/server/services/mailgun/plan";
import { safeMailgunContext } from "./gates";
import { countedCampaignSends, loadHealthCounts } from "./usage";

/**
 * Warm-up days (PLAN A5.13, B6.6, M3-DESIGN §4.3.8): after each closed cap day the daily limit may
 * move one step up the warm-up table (the rules are pure, @/core/sending/warmup). The ramp belongs to
 * one sending domain: a different domain starts again at step 0.
 *
 * A closed day is judged only once its bounces and complaints are in: a catch-up must have succeeded
 * at least an hour after the day ended (B1: catch up, then evaluate closed days), unless this is the
 * practice copy or nothing went through Mailgun that day (closedDayReady); days are evaluated oldest
 * first and the run stops at the first day that isn't ready.
 * One compare-and-set at the end; only after it succeeded is a rise logged ("sending.warmup").
 * Runs after every successful catch-up (wired by P6) and from the hourly "warmup.evaluate" job; never
 * at start-up before the catch-up.
 *
 * Go live (M6-DESIGN §2.6): the ramp starts again at go-live (startWarmupAtGoLive), and evaluation repairs a restart
 * that didn't happen. Bounces and complaints count from go-live on real data (healthCountingSince, G12), the first
 * go-live on this sending domain (healthGoLiveAt, review REPLIES-02). Before
 * go-live nothing changes: test-list days are judged as before.
 */

/** A closed day is judged only after a catch-up that succeeded this long after its end. */
export const WARMUP_READY_AFTER_MS = 3_600_000;
const CAS_TRIES = 5;

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Counted sends of one cap day (the rules of getTodayCap): counted campaign sends plus test sends. The campaign sends
 * come from `countedCampaignSends`, which reads the day through the `sentAt` index (review DASHBOARD-2).
 */
export async function countedSendsBetween(start: Date, end: Date, practiceCopy: boolean): Promise<number> {
  const campaign = (await countedCampaignSends(start, end, practiceCopy)).total;
  const tests = await db.testSend.count({ where: { status: { not: "FAILED" }, sentAt: { gte: start, lt: end } } });
  return campaign + tests;
}

/**
 * Whether anything went through Mailgun during [start, end): a TEST/LIVE email sent or claimed then, or a test send
 * that didn't fail. Such a day's bounces and complaints only arrive through Mailgun, so it waits for a catch-up.
 */
export async function hadMailgunSends(start: Date, end: Date): Promise<boolean> {
  const email = await db.outboundEmail.findFirst({
    where: {
      mode: { in: ["TEST", "LIVE"] },
      OR: [{ sentAt: { gte: start, lt: end } }, { claimedAt: { gte: start, lt: end } }],
    },
    select: { id: true },
  });
  if (email) return true;
  const test = await db.testSend.findFirst({ where: { status: { not: "FAILED" }, sentAt: { gte: start, lt: end } }, select: { id: true } });
  return test !== null;
}

/**
 * A closed day may be judged once its bounces and complaints are in (B1: catch up, then evaluate closed days): a
 * catch-up succeeded at least an hour after the day ended. Only the practice copy (it never talks to Mailgun), or a
 * day on which nothing went through Mailgun, needs none. "Not connected" right now is no reason to skip the wait: a
 * key that can't be read after an update, or keys removed and not yet pasted again, says nothing about the emails
 * that day sent through Mailgun.
 */
export async function closedDayReady(
  bounds: { start: Date; end: Date },
  mailgun: MailgunContextResult,
  lastSuccessMs: number,
): Promise<boolean> {
  if (!mailgun.connected && mailgun.reason === "practice-copy") return true;
  if (Number.isFinite(lastSuccessMs) && lastSuccessMs >= bounds.end.getTime() + WARMUP_READY_AFTER_MS) return true;
  if (mailgun.connected) return false;
  return !(await hadMailgunSends(bounds.start, bounds.end));
}

/**
 * "The daily limit rises to 59 (warm-up step 2 of 20)": the ramp's step, as every screen says it (M6-DESIGN §2.6),
 * never "day N" (a step can last several days; review DASHBOARD-8). Rows logged before keep their "day" text.
 */
export function warmupRiseText(stepAfter: number, table: readonly number[]): string {
  const i = Math.min(Math.max(0, stepAfter), table.length - 1);
  return `The daily limit rises to ${num(table[i] ?? 0)} (warm-up step ${i + 1} of ${table.length})`;
}

/**
 * The settings the warm-up reads (evaluation, go-live's restart and today's progress share them). The maximum daily
 * limit comes from `loadEffectiveMaxDailyCap()` instead (MAIN-DOMAIN-DESIGN O23: never above the Mailgun plan's limit
 * minus the test reserve), so the table here is the one today's cap uses.
 */
const WARMUP_SETTING_KEYS = [
  "mailgun.domain",
  "sending.capDayTimeZone",
  "sending.window",
  "warmup.startCap",
  "warmup.steps",
  "warmup.minUsePercent",
  "warmup.healthyBouncePercent",
  "warmup.healthyComplaintPercent",
  "health.bounceWindow",
  "health.complaintWindow",
  "practice.copy",
  "sending.goLive",
  "sending.goLiveAt",
  "sending.healthSinceGoLiveAt",
] as const;

type WarmupSettings = { [K in (typeof WARMUP_SETTING_KEYS)[number]]: SettingValue<K> };

/** The warm-up's inputs, read once: the settings and the effective maximum daily limit (O23). */
async function loadWarmupInputs() {
  const [s, { maxCap }] = await Promise.all([getSettings(WARMUP_SETTING_KEYS), loadEffectiveMaxDailyCap()]);
  return warmupInputs(s, maxCap);
}

/** The warm-up's inputs in one shape: the ramp's domain, the cap-day zone, the table and the health windows. */
function warmupInputs(s: WarmupSettings, maxCap: number) {
  return {
    domain: (s["mailgun.domain"] ?? "").trim().toLowerCase(),
    capZone: safeZone(s["sending.capDayTimeZone"]),
    table: warmupTable(Number(s["warmup.startCap"]), maxCap, Number(s["warmup.steps"])),
    window: parseWindow(s["sending.window"]),
    practiceCopy: s["practice.copy"] === true,
    bounceWindow: Number(s["health.bounceWindow"]) || 200,
    complaintWindow: Number(s["health.complaintWindow"]) || 1000,
    minUsePercent: Number(s["warmup.minUsePercent"]),
    healthyBouncePercent: Number(s["warmup.healthyBouncePercent"]),
    healthyComplaintPercent: Number(s["warmup.healthyComplaintPercent"]),
    /**
     * The go-live health counts from (G12), also after a domain change ended go-live: the first go-live on this sending
     * domain (`healthGoLiveAt`, review REPLIES-02), so a new go-live after a From change keeps the earlier bounces and
     * complaints. The ramp's own restart follows `liveSince` (every go-live).
     */
    healthGoLiveAt: healthGoLiveAt(s["sending.goLiveAt"], s["sending.healthSinceGoLiveAt"]),
    /** The go-live moment while live: the ramp must have started on or after its cap day (§2.6 self-healing). */
    liveSince: s["sending.goLive"] === true && typeof s["sending.goLiveAt"] === "string" ? s["sending.goLiveAt"] : null,
  };
}

/**
 * The ramp as go-live starts it (§2.6): step 0 on `day`, closed days before it never judged, history cleared, and the
 * go-live it was started for (review GOLIVE-02).
 */
function rampStartedOn(domain: string, day: CapDay, goLiveAt: string): WarmupState {
  return { domain, step: 0, lastEvaluatedCapDay: addCapDays(day, -1), startedCapDay: day, history: [], startedForGoLiveAt: goLiveAt };
}

/**
 * Go-live (M6-DESIGN §2.6, G5): the ramp starts today at step 0 (50 a day by default) for the current sending domain;
 * closed days before today are never judged again and the history is cleared. Called by goLive() after its commit
 * (today's hand-set limit was already removed there); `evaluateWarmupDays` repairs it when this didn't happen. It
 * records the go-live it restarted for (Setting "sending.goLiveAt", `now` without one), so the repair never runs again
 * for the same go-live (review GOLIVE-02).
 */
export async function startWarmupAtGoLive(now: Date): Promise<WarmupState> {
  const s = await getSettings(["mailgun.domain", "sending.capDayTimeZone", "sending.goLiveAt"] as const);
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase();
  const setting = s["sending.goLiveAt"];
  const goLiveAt = typeof setting === "string" && Number.isFinite(Date.parse(setting)) ? setting : now.toISOString();
  const next = rampStartedOn(domain, capDayOf(now, safeZone(s["sending.capDayTimeZone"])), goLiveAt);
  return (await updateTyped(STATE_KEYS.warmup, parseWarmupState, () => next)).value;
}

/**
 * The self-healing at go-live (§2.6), on real data while live:
 *  - `restart` (that go-live's cap day): go-live's own restart didn't happen (a crash or a lost compare-and-set). The
 *    ramp records the go-live it was restarted for (`startedForGoLiveAt`), so it restarts only for a go-live it
 *    wasn't restarted for — never because the Owner changed the cap-day zone, which moves the go-live's cap day
 *    (review GOLIVE-02). A state without that record (written before it) compares the cap days as before: started
 *    before the go-live cap day, or never;
 *  - `adopt`: such an older state already started on or after that day, so this go-live's restart did happen: the
 *    go-live is recorded without touching the ramp;
 *  - null: nothing to do.
 */
function goLiveRestartOf(
  state: WarmupState,
  goLiveAt: string | null,
  practiceCopy: boolean,
  capZone: string,
): { kind: "restart" | "adopt"; day: CapDay; goLiveAt: string } | null {
  if (practiceCopy || !goLiveAt || !Number.isFinite(Date.parse(goLiveAt))) return null;
  const day = capDayOf(new Date(goLiveAt), capZone);
  if (state.startedForGoLiveAt !== undefined) {
    return Date.parse(state.startedForGoLiveAt) === Date.parse(goLiveAt) ? null : { kind: "restart", day, goLiveAt };
  }
  const restart = state.startedCapDay === null || state.startedCapDay < day;
  return { kind: restart ? "restart" : "adopt", day, goLiveAt };
}

/**
 * Since when the warm-up's health counts (G12): the later of the health baseline and the first go-live on this sending
 * domain on real data (review REPLIES-02), like the health check and Domain health (`healthCountingSince`).
 */
async function warmupHealthSince(w: ReturnType<typeof warmupInputs>): Promise<Date | null> {
  const baseline = (await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value;
  return healthCountingSince(baseline.since, w.healthGoLiveAt, w.practiceCopy);
}

/** Health counts over the fixed windows, counted after `since`, up to `before` when given. */
function warmupHealth(w: ReturnType<typeof warmupInputs>, since: Date | null, before: Date | null) {
  return loadHealthCounts({ since, before, bounceWindow: w.bounceWindow, complaintWindow: w.complaintWindow, practiceCopy: w.practiceCopy });
}

/**
 * The warm-up's place and the open cap day so far (M6-DESIGN §2.6), for the warm-up line on the go-live card and the
 * dashboard: the step as today's limit uses it (step 0 for a ramp of another domain), the table, and today's facts —
 * a sending day?, the counted sends so far against the scheduled cap of that step, and whether the numbers are healthy
 * over the counts `evaluateWarmupDays` would use. `today` is null when there is no table.
 */
export async function loadWarmupProgress(now: Date): Promise<{ step: number; table: number[]; today: WarmupToday | null }> {
  const w = await loadWarmupInputs();
  const state = (await readTyped(STATE_KEYS.warmup, parseWarmupState)).value;
  const last = Math.max(0, w.table.length - 1);
  const step = state.domain === w.domain ? Math.min(Math.max(0, Math.floor(state.step) || 0), last) : 0;
  if (w.table.length === 0) return { step, table: w.table, today: null };
  const day = capDayOf(now, w.capZone);
  const bounds = capDayBounds(day, w.capZone);
  const used = await countedSendsBetween(bounds.start, bounds.end, w.practiceCopy);
  const health = await warmupHealth(w, await warmupHealthSince(w), null);
  const today: WarmupToday = {
    sendingDay: w.window.days.includes(capDayOfWeek(day)),
    used,
    cap: warmupCapFor(step, w.table),
    minUsePercent: w.minUsePercent,
    // The warm-up line words the rise with the Owner's sending days (review SCREENS-10).
    weekdaysOnly: isWeekdaysOnly(w.window.days),
    healthy: isHealthyForWarmup({
      bounces: health.bounces,
      bounceWindow: w.bounceWindow,
      healthyBouncePercent: w.healthyBouncePercent,
      complaints: health.complaints,
      complaintWindow: w.complaintWindow,
      healthyComplaintPercent: w.healthyComplaintPercent,
    }),
  };
  return { step, table: w.table, today };
}

/** Today's warm-up facts (§2.6, `warmupLine(step, table, today)`): null when there is no warm-up table. */
export async function loadWarmupToday(now: Date): Promise<WarmupToday | null> {
  return (await loadWarmupProgress(now)).today;
}

export async function evaluateWarmupDays(
  opts: { now?: Date; mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<{ evaluated: WarmupDay[]; state: WarmupState }> {
  const now = opts.now ?? new Date();
  const w = await loadWarmupInputs();
  const { domain, capZone, table, window, practiceCopy, bounceWindow, complaintWindow } = w;
  const today: CapDay = capDayOf(now, capZone);
  const yesterday = addCapDays(today, -1);
  const mailgun = await safeMailgunContext(opts.mailgun);
  const catchUp = (await readTyped(STATE_KEYS.catchUp, parseCatchUpState)).value;
  const lastSuccess = catchUp.lastSuccessAt ? Date.parse(catchUp.lastSuccessAt) : Number.NaN;
  const healthSince = await warmupHealthSince(w);

  for (let attempt = 0; attempt < CAS_TRIES; attempt++) {
    const stored = await readTyped(STATE_KEYS.warmup, parseWarmupState);
    let state: WarmupState = stored.value;
    let changed = false;
    if (state.domain !== domain) {
      state = { domain, step: 0, lastEvaluatedCapDay: yesterday, startedCapDay: today, history: [] };
      changed = true;
    } else if (!state.lastEvaluatedCapDay) {
      state = { ...state, lastEvaluatedCapDay: yesterday };
      changed = true;
    }
    // Go-live's restart didn't happen (§2.6): do it now, exactly as startWarmupAtGoLive(goLiveAt) would have. A ramp
    // written before `startedForGoLiveAt` that did restart gets the record, once.
    const heal = goLiveRestartOf(state, w.liveSince, practiceCopy, capZone);
    if (heal) {
      state = heal.kind === "restart" ? rampStartedOn(domain, heal.day, heal.goLiveAt) : { ...state, startedForGoLiveAt: heal.goLiveAt };
      changed = true;
    }

    const evaluated: WarmupDay[] = [];
    const history = [...state.history];
    let step = state.step;
    let last = state.lastEvaluatedCapDay!;
    for (const day of closedCapDaysAfter(last, now, capZone)) {
      const bounds = capDayBounds(day, capZone);
      if (!(await closedDayReady(bounds, mailgun, lastSuccess))) break;
      const used = await countedSendsBetween(bounds.start, bounds.end, practiceCopy);
      const health = await warmupHealth(w, healthSince, bounds.end);
      const result = evaluateWarmupDay({
        day,
        isSendingDay: window.days.includes(capDayOfWeek(day)),
        step,
        table,
        used,
        minUsePercent: w.minUsePercent,
        bounces: health.bounces,
        bounceSample: health.bounceSample,
        bounceWindow,
        healthyBouncePercent: w.healthyBouncePercent,
        complaints: health.complaints,
        complaintSample: health.complaintSample,
        complaintWindow,
        healthyComplaintPercent: w.healthyComplaintPercent,
      });
      evaluated.push(result);
      history.push(result);
      step = result.stepAfter;
      last = day;
    }
    if (evaluated.length === 0 && !changed) return { evaluated, state };

    const next: WarmupState = {
      ...state,
      step,
      lastEvaluatedCapDay: last,
      history: history.slice(-WARMUP_HISTORY_MAX),
    };
    if (!(await casState(STATE_KEYS.warmup, stored.version, next))) continue;
    for (const d of evaluated) {
      if (d.result !== "up") continue;
      try {
        await logActivity({
          actorId: null,
          type: "sending.warmup",
          summary: warmupRiseText(d.stepAfter, table),
          data: { day: d.day, cap: table[Math.min(d.stepAfter, table.length - 1)] ?? 0, used: d.used, stepAfter: d.stepAfter },
        });
      } catch (err) {
        console.error("[warmup] couldn't log the rise", err);
      }
    }
    return { evaluated, state: next };
  }
  throw new Error("The warm-up state kept changing while it was being updated. It will be checked again within the hour.");
}
