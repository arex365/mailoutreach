import type { Prisma } from "@/generated/prisma/client";
import type { ReplyRate } from "@/core/dashboard/pipeline";
import { db } from "@/server/db";
import { countCompaniesByStatus, type StatusCounts } from "@/server/services/companies/query";

/**
 * The dashboard's Companies tile (M6-DESIGN §4.3, D8): the status counts (the Contacts status tabs' numbers) and the
 * reply rate. Read-only (§0.2 rule 8): one `groupBy` on the status index and four counts over Company.
 */

export type PipelineView = { counts: StatusCounts; replyRate: ReplyRate };

/** The reply rate's "last 30 days" (companies first emailed in that time). */
export const REPLY_RATE_RECENT_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Status counts of every company that isn't deleted, and the reply rate: emailed = companies (not deleted) with
 * `firstContactedAt`; replied = those of them with `repliedAt`; last 30 days = the same for companies whose
 * `firstContactedAt` is at most 30 days before `now`. A company only ever contacted outside the app
 * (`importedLastContactAt`) was never emailed by it, so it counts in neither number, even when it replied.
 */
export async function loadPipeline(now: Date): Promise<PipelineView> {
  const since = new Date(now.getTime() - REPLY_RATE_RECENT_DAYS * DAY_MS);
  const emailed: Prisma.CompanyWhereInput = { deletedAt: null, firstContactedAt: { not: null } };
  const recent: Prisma.CompanyWhereInput = { deletedAt: null, firstContactedAt: { gte: since } };
  const [counts, emailedAll, repliedAll, emailed30, replied30] = await Promise.all([
    countCompaniesByStatus({}),
    db.company.count({ where: emailed }),
    db.company.count({ where: { ...emailed, repliedAt: { not: null } } }),
    db.company.count({ where: recent }),
    db.company.count({ where: { ...recent, repliedAt: { not: null } } }),
  ]);
  return {
    counts,
    replyRate: { replied: repliedAll, emailed: emailedAll, last30: { replied: replied30, emailed: emailed30 } },
  };
}
