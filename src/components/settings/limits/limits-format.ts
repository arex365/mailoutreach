import { emailsCountedText } from "@/core/sending/health";
import { warmupLine, type WarmupRiseRule } from "@/core/sending/warmup-line";
import { validateWindow, type SendingWindow } from "@/core/sending/window";
import type { WarmupDay } from "@/core/system-state";
import { formatShortDate } from "@/core/time/format";

/**
 * Settings › Limits & warm-up (M3-DESIGN §5.4): the rules for the form and the page's sentences.
 * Pure and browser-safe (the Server Actions use the same checks); unit-tested in tests/unit/sending.
 */

export const MAX_DAILY_CAP_RANGE = { min: 50, max: 10_000 } as const;
export const MIN_GAP_RANGE = { min: 20, max: 3_600 } as const;
export const WARMUP_START_RANGE = { min: 10, max: 500 } as const;
export const WARMUP_STEPS_RANGE = { min: 5, max: 60 } as const;
export const MIN_USE_RANGE = { min: 10, max: 100 } as const;

export type LimitsValues = {
  window: SendingWindow;
  /** Setting "defaultTimeZone": for companies without a time zone of their own. */
  defaultTimeZone: string;
  maxDailyCap: number;
  minGapSeconds: number;
  capDayTimeZone: string;
  warmupStartCap: number;
  warmupSteps: number;
  warmupMinUsePercent: number;
};

export type LimitsFieldErrors = Partial<Record<"window" | keyof Omit<LimitsValues, "window">, string>>;

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function wholeIn(v: unknown, min: number, max: number): number | null {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : null;
}

/** A zone both Intl and the browser accept (the server also checks it against its own list). */
export function isUsableTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the "Save limits" form (§2.1 validation): the sending window (days, quarter-hour times, end
 * after start), the maximum daily limit 50–10,000, the smallest gap 20–3,600 s, two valid time zones,
 * the warm-up start 10–500 and not above the maximum, 5–60 steps, and 10–100 % use.
 */
export function validateLimits(input: {
  window: unknown;
  defaultTimeZone: unknown;
  maxDailyCap: unknown;
  minGapSeconds: unknown;
  capDayTimeZone: unknown;
  warmupStartCap: unknown;
  warmupSteps: unknown;
  warmupMinUsePercent: unknown;
}): { ok: true; value: LimitsValues } | { ok: false; errors: LimitsFieldErrors } {
  const errors: LimitsFieldErrors = {};
  const window = validateWindow(input.window);
  if (!window.ok) errors.window = window.error;
  const maxDailyCap = wholeIn(input.maxDailyCap, MAX_DAILY_CAP_RANGE.min, MAX_DAILY_CAP_RANGE.max);
  if (maxDailyCap === null) errors.maxDailyCap = "The maximum daily limit must be a whole number from 50 to 10,000.";
  const minGapSeconds = wholeIn(input.minGapSeconds, MIN_GAP_RANGE.min, MIN_GAP_RANGE.max);
  if (minGapSeconds === null) errors.minGapSeconds = "The smallest gap must be a whole number of seconds from 20 to 3,600.";
  if (!isUsableTimeZone(input.capDayTimeZone)) errors.capDayTimeZone = "Pick a time zone from the list, for example Asia/Karachi.";
  if (!isUsableTimeZone(input.defaultTimeZone)) errors.defaultTimeZone = "Pick a time zone from the list, for example Europe/Berlin.";
  const warmupStartCap = wholeIn(input.warmupStartCap, WARMUP_START_RANGE.min, WARMUP_START_RANGE.max);
  if (warmupStartCap === null || (maxDailyCap !== null && warmupStartCap > maxDailyCap)) {
    errors.warmupStartCap = "The warm-up starts at a whole number from 10 to 500, and no higher than the maximum daily limit.";
  }
  const warmupSteps = wholeIn(input.warmupSteps, WARMUP_STEPS_RANGE.min, WARMUP_STEPS_RANGE.max);
  if (warmupSteps === null) errors.warmupSteps = "The warm-up needs a whole number of steps from 5 to 60.";
  const warmupMinUsePercent = wholeIn(input.warmupMinUsePercent, MIN_USE_RANGE.min, MIN_USE_RANGE.max);
  if (warmupMinUsePercent === null) errors.warmupMinUsePercent = "Use a whole percentage from 10 to 100.";
  if (Object.keys(errors).length > 0 || !window.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      window: window.value,
      defaultTimeZone: String(input.defaultTimeZone).trim(),
      maxDailyCap: maxDailyCap!,
      minGapSeconds: minGapSeconds!,
      capDayTimeZone: String(input.capDayTimeZone).trim(),
      warmupStartCap: warmupStartCap!,
      warmupSteps: warmupSteps!,
      warmupMinUsePercent: warmupMinUsePercent!,
    },
  };
}

/** "Change today's limit": a whole number from 0 to the maximum daily limit. */
export function validateTodayCap(v: unknown, maxCap: number): { ok: true; value: number } | { ok: false; error: string } {
  const cap = wholeIn(v, 0, Math.max(0, Math.floor(maxCap)));
  return cap === null ? { ok: false, error: `Today's limit must be a whole number from 0 to ${n(Math.max(0, Math.floor(maxCap)))}.` } : { ok: true, value: cap };
}

/**
 * The confirmation for "Change today's limit" (§5.4): above the warm-up schedule it warns about the
 * new domain's reputation; below it just confirms "for today only".
 */
export function todayCapQuestion(cap: number, warmupCap: number): { title: string; body: string; aboveSchedule: boolean } {
  if (cap > warmupCap) {
    return {
      title: `Change today's limit to ${n(cap)}?`,
      body: `Today's limit becomes ${n(cap)}, above the warm-up schedule (${n(warmupCap)}). Sending more than the schedule can hurt how inbox providers see your new domain. Change today's limit to ${n(cap)}?`,
      aboveSchedule: true,
    };
  }
  return {
    title: `Change today's limit to ${n(cap)}?`,
    body: `Today's limit becomes ${n(cap)} for today only. Change it?`,
    aboveSchedule: false,
  };
}

/**
 * "Today's limit: 129 (warm-up step 7 of 20)" / "(warm-up finished)" / "(changed for today)" (M6-DESIGN §2.6: the
 * ramp's step, which holds on a day that doesn't qualify, so it is never called a day).
 */
export function todayCapLine(t: { cap: number; source: "warmup" | "override"; warmupStep: number; warmupSteps: number }): string {
  if (t.source === "override") return `Today's limit: ${n(t.cap)} (changed for today)`;
  const last = t.warmupStep >= t.warmupSteps - 1;
  return last ? `Today's limit: ${n(t.cap)} (warm-up finished)` : `Today's limit: ${n(t.cap)} (warm-up step ${t.warmupStep + 1} of ${t.warmupSteps})`;
}

/**
 * The lines under "Warm-up schedule" (M6-DESIGN §2.6). Real data before go-live: the ramp starts at go-live and test-list
 * sends rarely raise it. After go-live: when it started, then the warm-up line. The practice copy: the warm-up line (its
 * ramp runs like live). The line is the "otherwise" form (`warmupLine(step, table, null, rule)`), which is always
 * true; `rule` words it after the Owner's own settings, as the card's description does (review SCREENS-10).
 */
export function warmupScheduleLines(s: {
  practiceCopy: boolean;
  goLive: boolean;
  /** Setting "sending.goLiveAt" (ISO), or null. */
  goLiveAt: string | null;
  /** 0-based step of the warm-up table (TodayCap.warmupStep). */
  step: number;
  table: readonly number[];
  timeZone: string;
  now: Date;
  /** How a step is earned: Setting "warmup.minUsePercent" and whether the sending days are Monday to Friday. */
  rule?: WarmupRiseRule | null;
}): string[] {
  const line = warmupLine(s.step, s.table, null, s.rule);
  if (s.practiceCopy) return [line];
  if (!s.goLive) {
    return [
      `Warm-up starts when you go live. Until then only emails to your test list count, so the limit usually stays at ${n(s.table[0] ?? 50)}.`,
    ];
  }
  const at = s.goLiveAt && !Number.isNaN(Date.parse(s.goLiveAt)) ? formatShortDate(s.goLiveAt, s.timeZone, s.now) : null;
  return at ? [`Warm-up started when you went live on ${at}.`, line] : [line];
}

/** "Used 37 · 92 left". */
export function usedLine(t: { used: number; left: number }): string {
  return `Used ${n(t.used)} · ${n(t.left)} left`;
}

/** "Pakistan time" / "Central European time" for a zone, from the browser's own names; else the city. */
export function zoneWords(zone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(0))
      .find((p) => p.type === "timeZoneName")?.value;
    if (name && !/^GMT[+-]?/.test(name)) return name.replace(/ Standard Time$/, " time").replace(/ Time$/, " time");
  } catch {
    // unknown zone: use the city below
  }
  return `${(zone.split("/").pop() ?? zone).replace(/_/g, " ")} time`;
}

/** "The day runs midnight to midnight Pakistan time (Asia/Karachi)." */
export function capDaySentence(capZone: string): string {
  return `The day runs midnight to midnight ${zoneWords(capZone)} (${capZone}).`;
}

/** "Changed by Arslan at 14:02 to 300 (above the warm-up schedule)." */
export function overrideLine(o: { byName: string; atText: string; cap: number; aboveSchedule: boolean }): string {
  return `Changed by ${o.byName} at ${o.atText} to ${n(o.cap)}${o.aboveSchedule ? " (above the warm-up schedule)" : ""}.`;
}

/**
 * The warm-up schedule's explanation, from the Owner's own settings (§5.4): "The limit rises about 17% after each
 * sending day on which at least half of it was used, while bounces and complaints stay low." The rise is the
 * table's average step (the same geometric curve warmupTable draws), the use rule the "minimum use" setting.
 */
export function warmupExplanation(table: readonly number[], minUsePercent: number): string {
  const first = table[0] ?? 0;
  const last = table[table.length - 1] ?? 0;
  if (table.length < 2 || !(first > 0) || last <= first) {
    return `The limit stays at ${n(last)} a day: the warm-up starts at the maximum daily limit.`;
  }
  const rise = Math.max(1, Math.round((Math.pow(last / first, 1 / (table.length - 1)) - 1) * 100));
  const typed = Math.round(Number(minUsePercent));
  const p = Number.isFinite(typed) && typed > 0 ? Math.min(typed, 100) : 50;
  const use = p === 100 ? "all of it" : p === 50 ? "at least half of it" : `at least ${p}% of it`;
  return `The limit rises about ${rise}% after each sending day on which ${use} was used, while bounces and complaints stay low.`;
}

export type WarmupRow = { day: number; cap: number; state: "done" | "today" | "next" | null };

/** The warm-up table with where today is: days before today's step are Done, today's step Today, the one after Next. */
export function warmupRows(table: readonly number[], step: number): WarmupRow[] {
  const current = Math.min(Math.max(0, Math.floor(step)), Math.max(0, table.length - 1));
  return table.map((cap, i) => ({
    day: i + 1,
    cap,
    state: i < current ? "done" : i === current ? "today" : i === current + 1 ? "next" : null,
  }));
}

/** "Tue 22 Sep" for a cap day ("2026-09-22"). */
export function capDayText(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
}

/**
 * One evaluated day in words (§5.4): "Tue 22 Sep: 48 of 50 used, healthy → the limit rose to 59",
 * "Sat 26 Sep: not a sending day, the limit stays", "Wed 23 Sep: only 12 of 50 used, the limit stays",
 * "…: 4 bounces in the last 200 emails, the limit stays".
 */
export function warmupHistoryLine(d: WarmupDay, table: readonly number[]): string {
  const day = capDayText(d.day);
  switch (d.result) {
    case "up":
      return `${day}: ${n(d.used)} of ${n(d.cap)} used, healthy → the limit rose to ${n(table[Math.min(d.stepAfter, table.length - 1)] ?? d.cap)}`;
    case "hold-not-sending-day":
      return `${day}: not a sending day, the limit stays`;
    case "hold-low-use":
      return `${day}: only ${n(d.used)} of ${n(d.cap)} used, the limit stays`;
    case "hold-at-max":
      return `${day}: the warm-up is finished, the limit stays at ${n(d.cap)}`;
    case "hold-unhealthy": {
      if (d.complaints > 0) {
        return `${day}: ${d.complaints === 1 ? "1 spam complaint" : `${n(d.complaints)} spam complaints`} in ${emailsCountedText(d.complaintSample)}, the limit stays`;
      }
      return `${day}: ${d.bounces === 1 ? "1 bounce" : `${n(d.bounces)} bounces`} in ${emailsCountedText(d.bounceSample)}, the limit stays`;
    }
  }
}

/** The 96 quarter-hours of a day ("00:00" … "23:45") for the From/To selects. */
export function quarterHours(): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 15) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

export const WEEKDAY_CHOICES: ReadonlyArray<{ day: number; short: string; long: string }> = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 7, short: "Sun", long: "Sunday" },
];

/** One sender's limit as typed ("" = no limit of their own) → null or the number; undefined when invalid. */
export function parseSenderCap(v: string): number | null | undefined {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const x = Number(t);
  return x >= 1 && x <= 10_000 ? x : undefined;
}
