import type { Prisma } from "@/generated/prisma/client";
import { COMPANY_STATUSES, type CompanyStatusValue, type PriorityValue } from "@/core/labels";
import { normalizeText } from "@/core/text";
import type { CompanySequence } from "@/components/campaigns/format";
import { db } from "@/server/db";
import { companySequences } from "@/server/services/campaigns/queries";
import { buildCompanyOrderBy, buildCompanyWhere, type CompanyFilters } from "./filters";

/**
 * Read-side queries for the Contacts screen (PLAN.md A6 "Contacts in detail").
 * Everything goes through the shared filters (buildCompanyWhere / buildCompanyOrderBy),
 * selects only what the table shows, and stays quick with 10,000+ companies:
 * one count + one page query + one grouped people query + one sequence query per page.
 */

const ROW_SELECT = {
  id: true,
  name: true,
  website: true,
  domain: true,
  profileKey: true,
  country: true,
  niche: true,
  priority: true,
  status: true,
  customFields: true,
  createdAt: true,
  lastEmailedAt: true,
  lastEmailedById: true,
  lastEmailedBy: { select: { name: true } },
  importedLastContactAt: true,
  repliedAt: true,
  tags: { select: { tag: { select: { id: true, name: true } } } },
} satisfies Prisma.CompanySelect;

export type CompanyListRow = {
  id: number;
  name: string;
  website: string | null;
  domain: string | null;
  profileKey: string | null;
  country: string | null;
  niche: string | null;
  priority: PriorityValue;
  status: CompanyStatusValue;
  createdAt: Date;
  lastEmailedAt: Date | null;
  lastEmailedById: number | null;
  lastEmailedByName: string | null;
  /** True when the viewer passed to listCompanies() sent the last email. */
  lastEmailedByViewer: boolean;
  importedLastContactAt: Date | null;
  /** When the company last replied (written by reply processing, M4-DESIGN §2.7): the "Last emailed" tooltip says so. */
  repliedAt?: Date | null;
  peopleCount: number;
  emailCount: number;
  tags: Array<{ id: number; name: string }>;
  /** Custom field values as display strings (empty values left out). */
  customFields: Record<string, string>;
  /**
   * This company's campaign sequences (launched campaigns only) for the "Sequence" column; worded by
   * companySequenceLabel() in @/components/campaigns/format. Absent = not loaded.
   */
  sequences?: CompanySequence[];
};

export type CompanyListResult = {
  rows: CompanyListRow[];
  total: number;
  /** The page actually shown (clamped to the last page when the URL asks for too much). */
  page: number;
  pageCount: number;
  pageSize: number;
};

/** Turns a Json custom-fields blob into display strings, skipping empty values. */
export function customFieldStrings(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    let text: string;
    if (Array.isArray(raw)) text = raw.filter((v) => v !== null && v !== "").map(String).join(", ");
    else if (typeof raw === "object") text = JSON.stringify(raw);
    else text = String(raw);
    text = text.trim();
    if (text) out[key] = text;
  }
  return out;
}

/** One page of companies for the table, plus the total that matches the filters. */
export async function listCompanies(filters: CompanyFilters, viewer?: { id: number }): Promise<CompanyListResult> {
  const where = buildCompanyWhere(filters);
  const pageSize = filters.pageSize;
  const total = await db.company.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, filters.page), pageCount);
  if (total === 0) return { rows: [], total, page: 1, pageCount: 1, pageSize };

  const companies = await db.company.findMany({
    where,
    orderBy: buildCompanyOrderBy(filters),
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: ROW_SELECT,
  });
  const ids = companies.map((c) => c.id);
  const [people, sequences] = await Promise.all([
    ids.length
      ? db.person.groupBy({
          by: ["companyId"],
          where: { companyId: { in: ids }, deletedAt: null },
          _count: { _all: true, emailNorm: true },
        })
      : Promise.resolve([]),
    companySequences(ids),
  ]);
  const peopleByCompany = new Map(people.map((p) => [p.companyId, p._count]));

  const rows: CompanyListRow[] = companies.map((c) => {
    const counts = peopleByCompany.get(c.id);
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      domain: c.domain,
      profileKey: c.profileKey,
      country: c.country,
      niche: c.niche,
      priority: c.priority,
      status: c.status,
      createdAt: c.createdAt,
      lastEmailedAt: c.lastEmailedAt,
      lastEmailedById: c.lastEmailedById,
      lastEmailedByName: c.lastEmailedBy?.name ?? null,
      lastEmailedByViewer: Boolean(viewer && c.lastEmailedById === viewer.id),
      importedLastContactAt: c.importedLastContactAt,
      repliedAt: c.repliedAt,
      peopleCount: counts?._all ?? 0,
      emailCount: counts?.emailNorm ?? 0,
      tags: c.tags.map((t) => t.tag).sort((a, b) => a.name.localeCompare(b.name)),
      customFields: customFieldStrings(c.customFields),
      sequences: sequences.get(c.id) ?? [],
    };
  });
  return { rows, total, page, pageCount, pageSize };
}

export type StatusCounts = { all: number; byStatus: Record<CompanyStatusValue, number> };

/** Counts for the status tabs: every filter except the status itself. */
export async function countCompaniesByStatus(filters: Partial<CompanyFilters>): Promise<StatusCounts> {
  const groups = await db.company.groupBy({
    by: ["status"],
    where: buildCompanyWhere(filters, { status: true }),
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(COMPANY_STATUSES.map((s) => [s, 0])) as Record<CompanyStatusValue, number>;
  let all = 0;
  for (const g of groups) {
    byStatus[g.status] = g._count._all;
    all += g._count._all;
  }
  return { all, byStatus };
}

export type ListWithCount = { id: number; name: string; count: number };

export type ContactsSidebarData = {
  allCount: number;
  missingEmailCount: number;
  lists: ListWithCount[];
};

/** The list sidebar: All companies, Missing email, then every list with its size. */
export async function getContactsSidebar(): Promise<ContactsSidebarData> {
  const [allCount, missingEmailCount, lists] = await Promise.all([
    db.company.count({ where: { deletedAt: null } }),
    db.company.count({ where: buildCompanyWhere({ view: "missing-email" }) }),
    db.list.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        _count: { select: { companies: { where: { company: { deletedAt: null } } } } },
      },
    }),
  ]);
  return {
    allCount,
    missingEmailCount,
    lists: lists
      .map((l) => ({ id: l.id, name: l.name, count: l._count.companies }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
  };
}

export type CompanyFilterOptions = {
  tags: Array<{ id: number; name: string }>;
  /** ISO codes of countries that at least one company has. */
  countries: string[];
  /** Niches that at least one company has (exact values). */
  niches: string[];
  /** Everyone who can appear as "first contacted by" (inactive users too: history stays). */
  users: Array<{ id: number; name: string }>;
};

/** Choices for the Filters popover — only values that actually exist. */
export async function getCompanyFilterOptions(): Promise<CompanyFilterOptions> {
  const [tags, countries, niches, users] = await Promise.all([
    db.tag.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.company.groupBy({ by: ["country"], where: { deletedAt: null, country: { not: null } } }),
    db.company.groupBy({ by: ["niche"], where: { deletedAt: null, niche: { not: null } } }),
    db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    tags: tags.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    countries: countries.map((c) => c.country).filter((c): c is string => Boolean(c)),
    niches: niches
      .map((n) => n.niche?.trim() ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    users,
  };
}

/**
 * Company custom fields that at least one (non-deleted) company has a value for.
 * Only these can be switched on in the Columns chooser (SPEC §2: shown only when filled in).
 */
export async function getCompanyCustomColumns(): Promise<Array<{ key: string; label: string }>> {
  const fields = await db.customField.findMany({
    where: { entity: "COMPANY" },
    select: { key: true, label: true },
    orderBy: { createdAt: "asc" },
  });
  if (fields.length === 0) return [];
  let filled: Set<string>;
  try {
    const rows = await db.$queryRaw<Array<{ key: string }>>`
      SELECT DISTINCT j.key AS key
      FROM Company AS c, json_each(c.customFields) AS j
      WHERE c.deletedAt IS NULL
        AND c.customFields IS NOT NULL
        AND j.type NOT IN ('null', 'object', 'array')
        AND trim(CAST(j.value AS TEXT)) <> ''`;
    filled = new Set(rows.map((r) => String(r.key)));
  } catch {
    // Fallback if the stored JSON can't be read by SQLite's json functions.
    const rows = await db.company.findMany({ where: { deletedAt: null }, select: { customFields: true } });
    filled = new Set(rows.flatMap((r) => Object.keys(customFieldStrings(r.customFields))));
  }
  return fields.filter((f) => filled.has(f.key)).map((f) => ({ key: f.key, label: f.label || f.key }));
}

export type QuickCompanyResult = {
  id: number;
  name: string;
  country: string | null;
  status: CompanyStatusValue;
};

const QUICK_SELECT = { id: true, name: true, country: true, status: true } satisfies Prisma.CompanySelect;

/**
 * Ctrl+K search: names that start with the text first, then any company whose
 * search text contains every word. "C-1042" or "1042" also finds that company.
 */
export async function searchCompaniesQuick(q: string, limit = 8): Promise<QuickCompanyResult[]> {
  const text = q.trim();
  if (!text) return [];
  const out: QuickCompanyResult[] = [];
  const seen = new Set<number>();
  const push = (rows: QuickCompanyResult[]) => {
    for (const r of rows) {
      if (out.length >= limit) return;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  };

  const idMatch = text.match(/^c?-?\s*(\d{1,9})$/i);
  if (idMatch) {
    const byId = await db.company.findFirst({
      where: { id: Number(idMatch[1]), deletedAt: null },
      select: QUICK_SELECT,
    });
    if (byId) push([byId]);
  }

  const norm = normalizeText(text);
  if (norm) {
    push(
      await db.company.findMany({
        where: { deletedAt: null, nameNorm: { startsWith: norm } },
        orderBy: [{ nameNorm: "asc" }, { id: "asc" }],
        take: limit,
        select: QUICK_SELECT,
      }),
    );
  }
  if (out.length < limit) {
    push(
      await db.company.findMany({
        where: buildCompanyWhere({ q: text }),
        orderBy: [{ nameNorm: "asc" }, { id: "asc" }],
        take: limit + out.length,
        select: QUICK_SELECT,
      }),
    );
  }
  return out;
}

/** Ids of every company matching the filters (for "select all that match"), capped. */
export async function listMatchingCompanyIds(
  filters: CompanyFilters,
  cap: number,
): Promise<{ ids: number[]; total: number; capped: boolean }> {
  const where = buildCompanyWhere(filters);
  const total = await db.company.count({ where });
  const rows = await db.company.findMany({
    where,
    orderBy: buildCompanyOrderBy(filters),
    take: cap,
    select: { id: true },
  });
  return { ids: rows.map((r) => r.id), total, capped: total > cap };
}

/** Name of one list (for headings), or null if it no longer exists. */
export async function getListName(listId: number): Promise<string | null> {
  const list = await db.list.findUnique({ where: { id: listId }, select: { name: true } });
  return list?.name ?? null;
}
