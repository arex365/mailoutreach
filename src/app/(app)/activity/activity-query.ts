import { Temporal } from "temporal-polyfill";
import type { Prisma, SendMode } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { ACTIVITY_KIND_PREFIXES, type ActivityFilters } from "@/components/activity/activity-filters";

/**
 * The Activity page query: ActivityLog newest first, 50 per page, filtered by person,
 * kind and a date range in the viewer's own time zone. No request APIs here, so tests can call it.
 */

export const ACTIVITY_PAGE_SIZE = 50;

/** The UTC instant at which a calendar date (YYYY-MM-DD) starts in a time zone. */
export function startOfDayUtc(date: string, timeZone: string): Date {
  const plain = Temporal.PlainDate.from(date);
  let zoned: Temporal.ZonedDateTime;
  try {
    zoned = plain.toZonedDateTime({ timeZone });
  } catch {
    zoned = plain.toZonedDateTime({ timeZone: "UTC" });
  }
  return new Date(zoned.epochMilliseconds);
}

function nextDay(date: string): string {
  return Temporal.PlainDate.from(date).add({ days: 1 }).toString();
}

export function buildActivityWhere(f: ActivityFilters, timeZone: string): Prisma.ActivityLogWhereInput {
  const and: Prisma.ActivityLogWhereInput[] = [];
  if (f.person === "system") and.push({ actorId: null });
  else if (typeof f.person === "number") and.push({ actorId: f.person });

  const prefixes = ACTIVITY_KIND_PREFIXES[f.kind];
  if (prefixes.length > 0) and.push({ OR: prefixes.map((p) => ({ type: { startsWith: p } })) });

  if (f.from || f.to) {
    and.push({
      at: {
        ...(f.from ? { gte: startOfDayUtc(f.from, timeZone) } : {}),
        ...(f.to ? { lt: startOfDayUtc(nextDay(f.to), timeZone) } : {}),
      },
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

export type ActivityRow = {
  id: number;
  at: Date;
  type: string;
  summary: string;
  /** null = the app itself ("System"). */
  actorName: string | null;
  companyId: number | null;
  companyName: string | null;
  companyDeleted: boolean;
  mode: SendMode | null;
};

export type ActivityPage = { rows: ActivityRow[]; total: number; page: number; pageCount: number };

export async function queryActivity(
  f: ActivityFilters,
  timeZone: string,
  pageSize = ACTIVITY_PAGE_SIZE,
): Promise<ActivityPage> {
  const where = buildActivityWhere(f, timeZone);
  const total = await db.activityLog.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, f.page), pageCount);
  const logs = await db.activityLog.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { actor: { select: { name: true } } },
  });

  const companyIds = [...new Set(logs.map((l) => l.companyId).filter((id): id is number => id !== null))];
  // Deliberately includes deleted companies: the log keeps their history, we just don't link to them.
  const companies = companyIds.length
    ? await db.company.findMany({
        where: { id: { in: companyIds } },
        select: { id: true, name: true, deletedAt: true },
      })
    : [];
  const byId = new Map(companies.map((c) => [c.id, c]));

  const rows: ActivityRow[] = logs.map((l) => {
    const company = l.companyId !== null ? byId.get(l.companyId) : undefined;
    return {
      id: l.id,
      at: l.at,
      type: l.type,
      summary: l.summary,
      actorName: l.actor?.name ?? null,
      companyId: company ? company.id : null,
      companyName: company?.name ?? null,
      companyDeleted: Boolean(company?.deletedAt),
      mode: l.mode,
    };
  });
  return { rows, total, page, pageCount };
}

/** Everyone who can appear as "who", for the person filter. */
export async function activityPeople(): Promise<Array<{ id: number; name: string; active: boolean }>> {
  return db.user.findMany({ select: { id: true, name: true, active: true }, orderBy: { name: "asc" } });
}
