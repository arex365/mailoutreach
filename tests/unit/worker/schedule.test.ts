import { describe, expect, it } from "vitest";
import {
  BACKUP_MIN_GAP_MS,
  BACKUP_OVERDUE_MS,
  DAILY_BACKUP_BY_HOUR,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  dateInTimeZone,
  hourInTimeZone,
  isBackupDue,
  isDailyDue,
  isQuietHour,
  mayEnqueueAgain,
  parseDate,
  QUIET_START_HOUR,
  quietSlotLeftToday,
} from "../../../worker/schedule";

// Asia/Karachi is UTC+5 all year (no daylight saving), which keeps these examples simple.
const PKT = "Asia/Karachi";
const at = (iso: string) => new Date(iso);

describe("quiet hours (22:00–08:00 local time)", () => {
  it("reads the hour in the given time zone", () => {
    expect(hourInTimeZone(at("2026-09-23T17:30:00Z"), PKT)).toBe(22);
    expect(hourInTimeZone(at("2026-09-23T19:00:00Z"), PKT)).toBe(0);
    expect(hourInTimeZone(at("2026-09-23T17:30:00Z"), "Europe/Berlin")).toBe(19);
  });

  it("falls back to Pakistan time for an unknown zone", () => {
    expect(hourInTimeZone(at("2026-09-23T17:30:00Z"), "Not/AZone")).toBe(22);
  });

  it("is quiet from 22:00 until just before 08:00, across midnight", () => {
    expect(isQuietHour(at("2026-09-23T16:59:00Z"), PKT)).toBe(false); // 21:59
    expect(isQuietHour(at("2026-09-23T17:00:00Z"), PKT)).toBe(true); // 22:00
    expect(isQuietHour(at("2026-09-23T20:00:00Z"), PKT)).toBe(true); // 01:00
    expect(isQuietHour(at("2026-09-24T02:59:00Z"), PKT)).toBe(true); // 07:59
    expect(isQuietHour(at("2026-09-24T03:00:00Z"), PKT)).toBe(false); // 08:00
    expect(isQuietHour(at("2026-09-24T07:00:00Z"), PKT)).toBe(false); // 12:00
  });
});

describe("daily backup due logic (M6-DESIGN §3.5)", () => {
  const morning = at("2026-09-24T05:00:00Z"); // 10:00 in Pakistan: not quiet
  const night = at("2026-09-24T18:00:00Z"); // 23:00 in Pakistan: quiet
  const ago = (from: Date, ms: number) => new Date(from.getTime() - ms);

  it("has a 12-hour minimum, a guarantee from 20:00 once no quiet slot is left, and a 30-hour limit", () => {
    expect(BACKUP_MIN_GAP_MS).toBe(12 * HOUR_MS);
    expect(DAILY_BACKUP_BY_HOUR).toBe(20);
    expect(QUIET_START_HOUR).toBe(22);
    expect(BACKUP_OVERDUE_MS).toBe(30 * HOUR_MS);
    // The office's quiet hours (from 22:00) are still ahead until they start.
    expect(quietSlotLeftToday(at("2026-09-24T15:00:00Z"), PKT)).toBe(true); // 20:00
    expect(quietSlotLeftToday(at("2026-09-24T16:59:00Z"), PKT)).toBe(true); // 21:59
    expect(quietSlotLeftToday(at("2026-09-24T17:00:00Z"), PKT)).toBe(false); // 22:00
    expect(quietSlotLeftToday(at("2026-09-24T18:30:00Z"), PKT)).toBe(false); // 23:30
  });

  it("runs straight away when there has never been a backup", () => {
    expect(isBackupDue(morning, null, PKT)).toBe(true);
    expect(isBackupDue(morning, null, PKT, false)).toBe(true);
  });

  it("never runs again within 12 hours, even at a quiet time", () => {
    expect(isBackupDue(night, ago(night, 11 * HOUR_MS), PKT, true)).toBe(false);
    expect(isBackupDue(night, ago(night, BACKUP_MIN_GAP_MS - 1), PKT, true)).toBe(false);
  });

  it("a day without a backup gets one once no quiet slot is left (from 22:00, its date in the office's zone), quiet or not", () => {
    // Yesterday 23:00 in Pakistan. Today 20:00 and 21:59 (not quiet): the quiet hours are still ahead, so it waits;
    // 22:00 is due even when the sending windows still say busy.
    const last = at("2026-09-23T18:00:00Z");
    expect(isBackupDue(at("2026-09-24T14:59:00Z"), last, PKT, false)).toBe(false);
    expect(isBackupDue(at("2026-09-24T15:00:00Z"), last, PKT, false)).toBe(false);
    expect(isBackupDue(at("2026-09-24T16:59:00Z"), last, PKT, false)).toBe(false);
    expect(isBackupDue(at("2026-09-24T17:00:00Z"), last, PKT, false)).toBe(true);
    // A quiet moment after 20:00 runs it straight away.
    expect(isBackupDue(at("2026-09-24T15:30:00Z"), last, PKT, true)).toBe(true);
    // Already one today (00:30): the evening doesn't add another.
    expect(isBackupDue(at("2026-09-24T17:00:00Z"), at("2026-09-23T19:30:00Z"), PKT, false)).toBe(false);
  });

  it("before 24 hours, a quiet moment runs it once the date has changed (and 12 hours have passed)", () => {
    // Yesterday 11:00 in Pakistan, now 10:00: a new date, 23 hours later, quiet.
    expect(isBackupDue(morning, ago(morning, 23 * HOUR_MS), PKT, true)).toBe(true);
    expect(isBackupDue(morning, ago(morning, 23 * HOUR_MS), PKT, false)).toBe(false);
    // Yesterday 20:00, now 08:00: exactly 12 hours and a new date.
    const eight = at("2026-09-24T03:00:00Z");
    expect(isBackupDue(eight, ago(eight, 12 * HOUR_MS), PKT, true)).toBe(true);
    // The same date (00:30 → 23:00) waits for the next date, however quiet.
    expect(isBackupDue(night, at("2026-09-23T19:30:00Z"), PKT, true)).toBe(false);
  });

  it("between 24 and 30 hours, waits for a quiet time: no emails due in an open window", () => {
    expect(isBackupDue(morning, ago(morning, 25 * HOUR_MS), PKT, false)).toBe(false);
    expect(isBackupDue(morning, ago(morning, 25 * HOUR_MS), PKT, true)).toBe(true);
    expect(isBackupDue(night, ago(night, DAY_MS), PKT, true)).toBe(true);
    // 19:00 in Pakistan, emails due in an open window: not quiet (and 20:00 hasn't come yet).
    const evening = at("2026-09-24T14:00:00Z");
    expect(isBackupDue(evening, ago(evening, 25 * HOUR_MS), PKT, false)).toBe(false);
    expect(isBackupDue(evening, ago(evening, 25 * HOUR_MS), PKT, true)).toBe(true);
  });

  it("falls back to the fixed 22:00–08:00 window when quiet time is unknown", () => {
    expect(isBackupDue(morning, ago(morning, 25 * HOUR_MS), PKT, null)).toBe(false);
    expect(isBackupDue(morning, ago(morning, 25 * HOUR_MS), PKT)).toBe(false);
    expect(isBackupDue(night, ago(night, 25 * HOUR_MS), PKT, null)).toBe(true);
    expect(isBackupDue(night, ago(night, 25 * HOUR_MS), PKT)).toBe(true);
  });

  it("after 30 hours, runs whatever the time", () => {
    expect(isBackupDue(morning, ago(morning, 30 * HOUR_MS), PKT, false)).toBe(true);
    expect(isBackupDue(morning, ago(morning, 29 * HOUR_MS), PKT, false)).toBe(false);
    expect(isBackupDue(morning, ago(morning, 5 * DAY_MS), PKT, false)).toBe(true);
  });

  it("runs when the last success is in the future (the PC's clock went back)", () => {
    // After a power cut the clock says 2025 while the last backup was recorded in 2026.
    expect(isBackupDue(morning, new Date(morning.getTime() + 300 * DAY_MS), PKT)).toBe(true);
    expect(isBackupDue(morning, new Date(morning.getTime() + 60_000), PKT)).toBe(true);
    expect(isDailyDue(morning, new Date(morning.getTime() + 5 * HOUR_MS))).toBe(true);
  });

  it("uses the office time zone, not the server's", () => {
    // 22:00 in Pakistan is 19:00 in Berlin (summer time): past 20:00 in one, not in the other.
    const now = at("2026-09-24T17:00:00Z");
    const last = new Date(now.getTime() - 26 * HOUR_MS);
    expect(isBackupDue(now, last, PKT)).toBe(true);
    expect(isBackupDue(now, last, "Europe/Berlin")).toBe(false);
    expect(dateInTimeZone(at("2026-09-23T19:30:00Z"), PKT)).toBe("2026-09-24");
    expect(dateInTimeZone(at("2026-09-23T19:30:00Z"), "Europe/Berlin")).toBe("2026-09-23");
    expect(dateInTimeZone(at("2026-09-23T19:30:00Z"), "Not/AZone")).toBe("2026-09-24");
  });

  /**
   * The periodic check runs every 10 minutes. `quiet` answers like backupQuietNow; returning undefined stands for "the
   * sending windows couldn't be read" (the fixed 22:00–08:00 hours decide).
   */
  function simulate(start: Date, days: number, quiet: (t: Date) => boolean | undefined, lastSuccess: Date): Date[] {
    const runs: Date[] = [];
    let last = lastSuccess;
    for (let t = start.getTime(); t < start.getTime() + days * DAY_MS; t += 10 * MINUTE_MS) {
      const now = new Date(t);
      if (isBackupDue(now, last, PKT, quiet(now))) {
        runs.push(now);
        last = now;
      }
    }
    return runs;
  }
  const pkHour = (t: Date) => hourInTimeZone(t, PKT);
  /** One backup per calendar day in Pakistan, 12 to 30 hours apart. */
  function expectDaily(runs: Date[], days: number) {
    const perDay = new Map<string, number>();
    for (const r of runs) perDay.set(dateInTimeZone(r, PKT), (perDay.get(dateInTimeZone(r, PKT)) ?? 0) + 1);
    expect([...perDay.keys()]).toHaveLength(days);
    for (const [day, n] of perDay) expect(n, day).toBe(1);
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i]!.getTime() - runs[i - 1]!.getTime();
      expect(gap).toBeGreaterThanOrEqual(BACKUP_MIN_GAP_MS);
      expect(gap).toBeLessThanOrEqual(BACKUP_OVERDUE_MS);
    }
  }

  it("a weekday with no quiet moment still gets exactly one backup, at 22:00 once no quiet slot is left", () => {
    // Monday 28 Sep 2026 00:00 in Pakistan; the last backup Sunday 23:00.
    const runs = simulate(at("2026-09-27T19:00:00Z"), 1, () => false, at("2026-09-27T18:00:00Z"));
    expect(runs.map((r) => r.toISOString())).toEqual(["2026-09-28T17:00:00.000Z"]);
  });

  it("after a 20:00 backup, the following days use quiet time again (review BACKUPS-8), fixed window or sending windows", () => {
    // The last backup Sunday 27 Sep at 20:00 in Pakistan; five days from Monday 00:00.
    const start = at("2026-09-27T19:00:00Z");
    const last = at("2026-09-27T15:00:00Z");
    // The sending windows can't be read: the fixed 22:00–08:00 hours. Every backup lands at 22:00, none at 20:00.
    const fixed = simulate(start, 5, () => undefined, last);
    expect(fixed.map(pkHour)).toEqual([22, 22, 22, 22, 22]);
    expectDaily(fixed, 5);
    // The sending windows say quiet from 22:00 to 08:00 (the same pattern, known): the same.
    const nights = simulate(start, 5, (t) => pkHour(t) >= 22 || pkHour(t) < 8, last);
    expect(nights.map(pkHour)).toEqual([22, 22, 22, 22, 22]);
    // Europe and the US keep the windows open from 12:00 to 05:00 (quiet 05:00–12:00): the backup moves into the quiet
    // morning the next day (08:00, as soon as 12 hours have passed) and then settles at 05:00.
    const mornings = simulate(start, 5, (t) => pkHour(t) >= 5 && pkHour(t) < 12, last);
    expect(mornings.map(pkHour)).toEqual([8, 5, 5, 5, 5]);
    expectDaily(mornings, 5);
    for (const r of [...fixed, ...nights, ...mornings]) expect(pkHour(r)).not.toBe(20);
  });

  it("over a week of mixed days: at least one backup per calendar day, at most two", () => {
    // Quiet from 01:00 to 06:00 in Pakistan, busy the rest of the time.
    const quiet = (t: Date) => {
      const h = hourInTimeZone(t, PKT);
      return h >= 1 && h < 6;
    };
    const runs = simulate(at("2026-09-27T19:00:00Z"), 7, quiet, at("2026-09-27T15:00:00Z"));
    const perDay = new Map<string, number>();
    for (const r of runs) perDay.set(dateInTimeZone(r, PKT), (perDay.get(dateInTimeZone(r, PKT)) ?? 0) + 1);
    expect([...perDay.keys()]).toHaveLength(7);
    for (const [day, n] of perDay) {
      expect(n, day).toBeGreaterThanOrEqual(1);
      expect(n, day).toBeLessThanOrEqual(2);
    }
    for (let i = 1; i < runs.length; i++) expect(runs[i]!.getTime() - runs[i - 1]!.getTime()).toBeGreaterThanOrEqual(BACKUP_MIN_GAP_MS);
  });
});

describe("daily tasks and re-enqueueing", () => {
  const now = at("2026-09-24T12:00:00Z");

  it("is due when never run or 24 hours after the last success", () => {
    expect(isDailyDue(now, null)).toBe(true);
    expect(isDailyDue(now, new Date(now.getTime() - DAY_MS))).toBe(true);
    expect(isDailyDue(now, new Date(now.getTime() - DAY_MS + 60_000))).toBe(false);
  });

  it("doesn't enqueue a failing task again at every check", () => {
    expect(mayEnqueueAgain(now, null, HOUR_MS)).toBe(true);
    expect(mayEnqueueAgain(now, new Date(now.getTime() - 10 * 60_000), HOUR_MS)).toBe(false);
    expect(mayEnqueueAgain(now, new Date(now.getTime() - HOUR_MS), HOUR_MS)).toBe(true);
  });

  it("isn't blocked for ever by a clock that jumped back", () => {
    expect(mayEnqueueAgain(now, new Date(now.getTime() + 5 * HOUR_MS), HOUR_MS)).toBe(true);
  });

  it("parses stored dates defensively", () => {
    expect(parseDate("2026-09-24T12:00:00.000Z")?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
    expect(parseDate("nonsense")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(42)).toBeNull();
  });
});
