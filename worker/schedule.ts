/**
 * When periodic tasks are due (pure, unit-tested). PLAN.md B6.14 / B8.
 * The database side (reading lastSuccessAt, enqueueing) is in ./periodic.ts.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Periodic tasks are checked at start-up and then this often. */
export const PERIODIC_CHECK_MS = 10 * MINUTE_MS;

/**
 * The fixed quiet window (local time in the cap-day time zone): 22:00–08:00. The daily backup uses it as its quiet
 * time only when the sending windows can't be read (backupQuietNow answered null, M6-DESIGN §3.5); its start is also
 * when the daily guarantee stops waiting for a quiet moment (quietSlotLeftToday).
 */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;
/** Never two daily backups closer together than this. */
export const BACKUP_MIN_GAP_MS = 12 * HOUR_MS;
/**
 * The daily guarantee (in the cap-day zone): from this hour on, a day without a backup gets one, quiet or not, as soon
 * as no quiet slot is left that day (quietSlotLeftToday).
 */
export const DAILY_BACKUP_BY_HOUR = 20;
/** After this long without a backup, the backup runs straight away, quiet or not (the 36-hour warning stays rare). */
export const BACKUP_OVERDUE_MS = 30 * HOUR_MS;

const FALLBACK_TIME_ZONE = "Asia/Karachi";

/** Hour of the day (0–23) at `now` in an IANA time zone. Unknown zones fall back to Pakistan time. */
export function hourInTimeZone(now: Date, timeZone: string): number {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(now);
  let text: string;
  try {
    text = format(timeZone);
  } catch {
    text = format(FALLBACK_TIME_ZONE);
  }
  const hour = Number.parseInt(text, 10);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

/** True between 22:00 and 08:00 local time (the window wraps past midnight). */
export function isQuietHour(
  now: Date,
  timeZone: string,
  startHour = QUIET_START_HOUR,
  endHour = QUIET_END_HOUR,
): boolean {
  const hour = hourInTimeZone(now, timeZone);
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

/** The calendar date ("2026-09-23") at `at` in an IANA time zone. Unknown zones fall back to Pakistan time. */
export function dateInTimeZone(at: Date, timeZone: string): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(at);
  try {
    return format(timeZone);
  } catch {
    return format(FALLBACK_TIME_ZONE);
  }
}

/**
 * Whether a quiet slot may still come later today (in `timeZone`), for the daily guarantee. The sending windows
 * can't be foreseen, so the office's own quiet hours decide: while they (from 22:00) are still ahead today, a day
 * without a backup waits for them; once they have started, nothing quiet is left to wait for. (Before this, a backup
 * made at 20:00 fell due at 20:00 the next day, before any quiet moment, and stayed at 20:00 for good.)
 */
export function quietSlotLeftToday(now: Date, timeZone: string, startHour = QUIET_START_HOUR): boolean {
  // Before the quiet hours start they are still ahead today; from then on the quiet check itself decides.
  return hourInTimeZone(now, timeZone) < startHour;
}

/**
 * The daily backup (M6-DESIGN §3.5; review BACKUPS-8), in this order:
 * - never backed up → now;
 * - last success "in the future" (the PC's clock went back, e.g. after a power cut) → now, so
 *   backups don't stop until the clock catches up (like mayEnqueueAgain);
 * - last success less than 12 h ago → not yet;
 * - 30 h or more → now, whatever the time;
 * - a quiet moment once the date has changed in `timeZone` (or 24 h have passed) → now. Quiet is `quiet` (no gated
 *   email due with its window open, backupQuietNow), or, when that is unknown (null or left out), the fixed quiet hours
 *   22:00–08:00. So a backup made at 20:00 moves back into quiet time the next day;
 * - no backup yet on today's date, it is 20:00 or later there and no quiet slot is left that day → now (the daily
 *   guarantee: with recipients all over the world the sending windows can cover a whole weekday, and a rhythm of 30
 *   hours alone would skip some days). With the default hours that is 22:00, when the office's quiet hours start;
 * - else not yet.
 * So there is at least one daily backup per calendar day while the PC is on (from 22:00 at the latest), backups are at
 * most 30 hours apart, and a calendar day gets at most two (one, except on a daylight-saving day or after the clock
 * went back).
 */
export function isBackupDue(now: Date, lastSuccess: Date | null, timeZone: string, quiet?: boolean | null): boolean {
  if (!lastSuccess) return true;
  const age = now.getTime() - lastSuccess.getTime();
  if (age < 0) return true;
  if (age < BACKUP_MIN_GAP_MS) return false;
  if (age >= BACKUP_OVERDUE_MS) return true;
  const newDate = dateInTimeZone(lastSuccess, timeZone) !== dateInTimeZone(now, timeZone);
  const quietNow = quiet ?? isQuietHour(now, timeZone);
  if (quietNow && (newDate || age >= DAY_MS)) return true;
  return newDate && hourInTimeZone(now, timeZone) >= DAILY_BACKUP_BY_HOUR && !quietSlotLeftToday(now, timeZone);
}

/**
 * A simple "once a day" task: due when it never succeeded, its last success is 24 h old, or the
 * last success looks like it's in the future (the clock went back).
 */
export function isDailyDue(now: Date, lastSuccess: Date | null): boolean {
  if (!lastSuccess) return true;
  const age = now.getTime() - lastSuccess.getTime();
  return age < 0 || age >= DAY_MS;
}

/**
 * A due task is enqueued again only after `retryAfterMs` since the last enqueue, so a task that keeps
 * failing (e.g. a full disk) doesn't start again at every 10-minute check.
 */
export function mayEnqueueAgain(now: Date, lastEnqueuedAt: Date | null, retryAfterMs: number): boolean {
  if (!lastEnqueuedAt) return true;
  const age = now.getTime() - lastEnqueuedAt.getTime();
  // A clock that jumped backwards shouldn't block the task for ever.
  return age < 0 || age >= retryAfterMs;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
