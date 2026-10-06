import { roundUsd } from "@/core/money";
import { monthBounds, type MonthBounds } from "@/core/time/month";
import { db } from "@/server/db";
import { realCheckProviders } from "@/server/services/eligibility";
import { getSetting, getSettings } from "@/server/settings";

/**
 * What address checks cost this office month (M5-DESIGN §2.4, §2.10). Nothing is stored: the numbers are counted from
 * the `VerificationCheck` rows every time (their `costUsd` is the price at the time, 0 inside the plan's included
 * checks), never from jobs, which are deleted after 30 days. Only real providers count (the fake Mailgun's rows only
 * while the app talks to it), so the test checker never uses up the limit or the included checks.
 */

/** The office month (Setting "sending.capDayTimeZone", Asia/Karachi by default) containing `now`. */
export async function checkMonth(now: Date = new Date()): Promise<MonthBounds> {
  return monthBounds(now, await getSetting("sending.capDayTimeZone"));
}

/** Real checks this office month: how many, and what they cost in dollars. */
export async function checksThisMonth(now: Date = new Date()): Promise<{ count: number; costUsd: number }> {
  const month = await checkMonth(now);
  const res = await db.verificationCheck.aggregate({
    where: { checkedAt: { gte: month.start, lt: month.end }, provider: { in: [...realCheckProviders()] } },
    _count: { _all: true },
    _sum: { costUsd: true },
  });
  return { count: res._count._all, costUsd: roundUsd(res._sum.costUsd ?? 0) };
}

export type MonthlyCheckLimit = {
  /** Setting "verification.monthlyLimitUsd". */
  limitUsd: number;
  /** This office month's check spend so far. */
  spentUsd: number;
  /** Spending `aboutUsd` more would pass the limit (free runs never do). */
  wouldPass: boolean;
};

/** Setting "verification.monthlyLimitUsd" as a usable number (the default $100 when broken). */
export function limitFromSetting(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/**
 * The monthly check limit against a run that would cost `aboutUsd` more (M5-DESIGN D28). `spentUsd` may be passed when
 * the caller already counted this month's checks.
 */
export async function monthlyCheckLimit(aboutUsd: number, opts: { now?: Date; spentUsd?: number } = {}): Promise<MonthlyCheckLimit> {
  const s = await getSettings(["verification.monthlyLimitUsd"] as const);
  const limitUsd = limitFromSetting(s["verification.monthlyLimitUsd"]);
  const spentUsd = opts.spentUsd ?? (await checksThisMonth(opts.now ?? new Date())).costUsd;
  const extra = Number.isFinite(aboutUsd) && aboutUsd > 0 ? aboutUsd : 0;
  return { limitUsd, spentUsd, wouldPass: extra > 0 && roundUsd(spentUsd + extra) > limitUsd };
}
