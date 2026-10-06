import { Temporal } from "temporal-polyfill";

/**
 * Sending hours (PLAN B6.6, M3-DESIGN §4.1.1). A gated email goes out only while its recipient's own sending window
 * is open: the local day of the week is one of `days` (ISO, 1 = Monday … 7 = Sunday) and the local wall time is in
 * `[start, end)`. Pure and browser-safe.
 *
 * The window's edges are turned into instants with Temporal's "compatible" rule (`PlainDate.toZonedDateTime`), so a
 * daylight-saving gap moves an edge forward (02:30 on a spring-forward night becomes 03:30) and an overlap takes the
 * earlier of the two instants. Every function works on instants, so DST days of 23 or 25 hours need no special code.
 */

/** Setting "sending.window": the days and local hours during which gated emails may go out. */
export type SendingWindow = {
  /** ISO days of the week, 1 = Monday … 7 = Sunday; sorted, no duplicates, at least one. */
  days: number[];
  /** "HH:MM", 24-hour clock, on 15-minute steps. */
  start: string;
  /** "HH:MM", after `start`. */
  end: string;
};

/** Monday to Friday, 09:00–17:00 (Setting "sending.window" default). */
export const DEFAULT_WINDOW: SendingWindow = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

/** The zone used when neither the company's nor the Owner's default zone is valid (Setting "defaultTimeZone"). */
export const DEFAULT_COMPANY_ZONE = "Europe/Berlin";

/** How far ahead `nextWindowOpen` looks: today plus a full week, so every weekday comes round at least once. */
const SEARCH_DAYS = 8;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Copy of the default, so a caller changing the result can't change the default. */
function defaultWindow(): SendingWindow {
  return { days: [...DEFAULT_WINDOW.days], start: DEFAULT_WINDOW.start, end: DEFAULT_WINDOW.end };
}

/** Minutes after midnight for a valid "HH:MM" on a 15-minute step, else null. */
function quarterMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = TIME_RE.exec(v);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes % 15 === 0 ? minutes : null;
}

/**
 * Checks a sending window typed by the Owner (Settings › Limits & warm-up): at least one day out of 1–7, both times
 * "HH:MM" on the quarter hour, and the end after the start. The days come back sorted and without duplicates.
 */
export function validateWindow(v: unknown): { ok: true; value: SendingWindow } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "Choose the sending days and hours." };
  const raw = v as { days?: unknown; start?: unknown; end?: unknown };
  if (!Array.isArray(raw.days)) return { ok: false, error: "Pick at least one sending day." };
  const days = new Set<number>();
  for (const d of raw.days) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7) {
      return { ok: false, error: "Sending days must be days of the week, Monday to Sunday." };
    }
    days.add(d);
  }
  if (days.size === 0) return { ok: false, error: "Pick at least one sending day." };
  const start = quarterMinutes(raw.start);
  const end = quarterMinutes(raw.end);
  if (start === null || end === null) {
    return { ok: false, error: "Pick times on the quarter hour, such as 09:00 or 17:30." };
  }
  if (start >= end) return { ok: false, error: "The end time must be after the start time." };
  return {
    ok: true,
    value: { days: [...days].sort((a, b) => a - b), start: raw.start as string, end: raw.end as string },
  };
}

/** Reads the stored Setting "sending.window". Anything invalid gives the default (Monday to Friday, 09:00–17:00). */
export function parseWindow(v: unknown): SendingWindow {
  const r = validateWindow(v);
  return r.ok ? r.value : defaultWindow();
}

const zoneCache = new Map<string, boolean>();

/** True for a zone that both Intl and Temporal accept. Cached: the sending loop asks for the same few zones. */
function isUsableZone(zone: string): boolean {
  const cached = zoneCache.get(zone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    ok = true;
  } catch {
    ok = false;
  }
  if (zoneCache.size > 500) zoneCache.clear();
  zoneCache.set(zone, ok);
  return ok;
}

/**
 * The zone a company's emails follow: its own zone when valid, else the Owner's default zone (Setting
 * "defaultTimeZone"), else Europe/Berlin.
 */
export function resolveZone(companyZone: string | null | undefined, defaultZone: string): string {
  const own = companyZone?.trim();
  if (own && isUsableZone(own)) return own;
  const fallback = defaultZone?.trim();
  if (fallback && isUsableZone(fallback)) return fallback;
  return DEFAULT_COMPANY_ZONE;
}

/** A zone that is safe to hand to Temporal (invalid → Europe/Berlin). */
function usableZone(zone: string): string {
  return resolveZone(zone, DEFAULT_COMPANY_ZONE);
}

function localDate(ms: number, zone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate();
}

/** The window of one local date as epoch milliseconds, or null when that date isn't a sending day. */
function windowOn(date: Temporal.PlainDate, zone: string, w: SendingWindow): { start: number; end: number } | null {
  if (!w.days.includes(date.dayOfWeek)) return null;
  const start = date.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(w.start) }).epochMilliseconds;
  const end = date.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(w.end) }).epochMilliseconds;
  // A window squeezed to nothing by a DST gap (both edges inside it) is closed that day.
  return start < end ? { start, end } : null;
}

/** The window (as epoch ms) that contains `ms`, or null when the window is closed at that instant. */
function containingWindow(ms: number, zone: string, w: SendingWindow): { start: number; end: number } | null {
  const win = windowOn(localDate(ms, zone), zone, w);
  return win && win.start <= ms && ms < win.end ? win : null;
}

/** True while the sending window is open at `at` in `zone`: a sending day, and the local time in `[start, end)`. */
export function isWindowOpen(at: Date, zone: string, w: SendingWindow): boolean {
  return containingWindow(at.getTime(), usableZone(zone), w) !== null;
}

/**
 * When the window next opens: `at` itself while it is open, else the start of the next window. Searches today and
 * the next 8 days; if nothing opens in that time (only possible when DST removes the single weekly window), it
 * returns `at` plus 8 days so the caller simply looks again later.
 */
export function nextWindowOpen(at: Date, zone: string, w: SendingWindow): Date {
  const z = usableZone(zone);
  const ms = at.getTime();
  if (containingWindow(ms, z, w)) return new Date(ms);
  let date = localDate(ms, z);
  for (let i = 0; i <= SEARCH_DAYS; i++, date = date.add({ days: 1 })) {
    const win = windowOn(date, z, w);
    if (win && win.start > ms) return new Date(win.start);
  }
  return new Date(ms + SEARCH_DAYS * 86_400_000);
}

/** The end of the window that contains `at` (exclusive), or null when the window is closed at `at`. */
export function windowCloseAfter(at: Date, zone: string, w: SendingWindow): Date | null {
  const win = containingWindow(at.getTime(), usableZone(zone), w);
  return win ? new Date(win.end) : null;
}

/** The open parts of `[from, to)` in `zone`, oldest first, each clipped to `[from, to)`. */
export function openIntervals(from: Date, to: Date, zone: string, w: SendingWindow): Array<{ start: Date; end: Date }> {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!(toMs > fromMs)) return [];
  const z = usableZone(zone);
  const out: Array<{ start: Date; end: Date }> = [];
  const last = localDate(toMs, z);
  for (let date = localDate(fromMs, z); Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 })) {
    const win = windowOn(date, z, w);
    if (!win) continue;
    const start = Math.max(win.start, fromMs);
    const end = Math.min(win.end, toMs);
    if (start < end) out.push({ start: new Date(start), end: new Date(end) });
  }
  return out;
}

/**
 * Seconds in `[from, to)` during which the window is open in at least one of `zones` (the union, so overlapping
 * windows of Berlin and New York are counted once). Used for the pacing formula (B6.6).
 */
export function openSecondsBetween(from: Date, to: Date, zones: readonly string[], w: SendingWindow): number {
  const parts: Array<[number, number]> = [];
  for (const zone of new Set(zones)) {
    for (const i of openIntervals(from, to, zone, w)) parts.push([i.start.getTime(), i.end.getTime()]);
  }
  parts.sort((a, b) => a[0] - b[0]);
  let totalMs = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [s, e] of parts) {
    if (Number.isNaN(curStart) || s > curEnd) {
      if (!Number.isNaN(curStart)) totalMs += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (!Number.isNaN(curStart)) totalMs += curEnd - curStart;
  return totalMs / 1000;
}

/** "09:30" → "9:30", "17:00" → "17:00". */
function shortTime(hhmm: string): string {
  return hhmm.replace(/^0(\d):/, "$1:");
}

/** "Mon, Wed and Fri". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The window in plain words, for the Limits page and the wizard: "Monday to Friday, 9:00–17:00",
 * "Mon, Wed and Fri, 9:30–16:00", "Every day, 8:00–20:00", "Saturday, 10:00–14:00".
 */
export function windowSentence(w: SendingWindow): string {
  const days = [...new Set(w.days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const hours = `${shortTime(w.start)}–${shortTime(w.end)}`;
  let dayText: string;
  if (days.length === 0) return "No sending days";
  if (days.length === 7) dayText = "Every day";
  else if (days.length === 1) dayText = DAY_NAMES[days[0]! - 1]!;
  else if (days.length >= 3 && days[days.length - 1]! - days[0]! === days.length - 1) {
    dayText = `${DAY_NAMES[days[0]! - 1]} to ${DAY_NAMES[days[days.length - 1]! - 1]}`;
  } else dayText = joinWords(days.map((d) => DAY_SHORT[d - 1]!));
  return `${dayText}, ${hours}`;
}
