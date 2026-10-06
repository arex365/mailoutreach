import { Temporal } from "temporal-polyfill";

/**
 * The cap day (PLAN A5.12, B6.6): midnight to midnight in Setting "sending.capDayTimeZone". A cap day is written
 * "YYYY-MM-DD". Pure; DST-safe (start of day via Temporal, "compatible" disambiguation).
 */
export type CapDay = string;
export const FALLBACK_CAP_ZONE = "Asia/Karachi";

/** The zone if it is a valid IANA zone, otherwise `fallback`. */
export function safeZone(zone: string | null | undefined, fallback: string = FALLBACK_CAP_ZONE): string {
  if (!zone) return fallback;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

/**
 * "YYYY-MM-DD" and a date that exists: an impossible day such as "2026-02-30" (a damaged stored value) is refused
 * here, because every other function in this file would throw on it.
 */
export function isCapDay(v: unknown): v is CapDay {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  try {
    return Temporal.PlainDate.from(v).toString() === v;
  } catch {
    return false;
  }
}

export function capDayOf(at: Date, capZone: string): CapDay {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(safeZone(capZone)).toPlainDate().toString();
}

/** [start, end) of a cap day as instants. */
export function capDayBounds(day: CapDay, capZone: string): { start: Date; end: Date } {
  const zone = safeZone(capZone);
  const date = Temporal.PlainDate.from(day);
  return {
    start: new Date(date.toZonedDateTime(zone).epochMilliseconds),
    end: new Date(date.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds),
  };
}

export function addCapDays(day: CapDay, days: number): CapDay {
  return Temporal.PlainDate.from(day).add({ days }).toString();
}

export function compareCapDays(a: CapDay, b: CapDay): number {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}

/** ISO day of the week: 1 = Monday … 7 = Sunday. */
export function capDayOfWeek(day: CapDay): number {
  return Temporal.PlainDate.from(day).dayOfWeek;
}

/** Cap days after `lastEvaluated` (exclusive) that ended before `now`'s cap day, oldest first, at most `max`. */
export function closedCapDaysAfter(lastEvaluated: CapDay, now: Date, capZone: string, max = 60): CapDay[] {
  const today = capDayOf(now, capZone);
  const out: CapDay[] = [];
  for (let d = addCapDays(lastEvaluated, 1); compareCapDays(d, today) < 0 && out.length < max; d = addCapDays(d, 1)) {
    out.push(d);
  }
  return out;
}
