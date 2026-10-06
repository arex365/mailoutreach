import { roundUsd } from "@/core/money";
import { monthBounds, type MonthBounds } from "@/core/time/month";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings";

/**
 * AI spend in the office month (docs/dev/M5-DESIGN.md §3.3, D16) for Settings › AI ("Spent in September: $3.10 of $20
 * (27 drafts).") and the start dialog. Counted from AiDraft rows every time (nothing is stored), by `draftedAt`: the
 * instant the draft's last Claude call ended, in the month of Setting "sending.capDayTimeZone" (Asia/Karachi). Jobs
 * are never read, since they are deleted after 30 days.
 */

/** This office month's AI spend in dollars, how many drafts it paid for, and the month's bounds and words. */
export async function aiSpendThisMonth(now: Date = new Date()): Promise<{ usd: number; drafts: number; bounds: MonthBounds }> {
  const s = await getSettings(["sending.capDayTimeZone"] as const);
  const bounds = monthBounds(now, s["sending.capDayTimeZone"]);
  const where = { draftedAt: { gte: bounds.start, lt: bounds.end } };
  const [sum, drafts] = await Promise.all([
    db.aiDraft.aggregate({ where, _sum: { costUsd: true } }),
    db.aiDraft.count({ where }),
  ]);
  return { usd: roundUsd(sum._sum.costUsd ?? 0), drafts, bounds };
}
