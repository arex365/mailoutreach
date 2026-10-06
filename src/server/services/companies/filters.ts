import type { Prisma } from "@/generated/prisma/client";
import { normalizeText } from "@/core/text";
import { COMPANY_STATUSES, PRIORITIES, type CompanyStatusValue, type PriorityValue } from "@/core/labels";

/**
 * The one definition of "which companies does this view show?", shared by the Contacts
 * screen, CSV/Excel export and (later) the campaign audience step. URL parameters:
 *   q, view (all|missing-email), list, status, tag (comma ids), country (comma ISO2),
 *   niche (comma, exact), priority (comma), emailed (yes|no), hasEmail (yes|no),
 *   by (first contacted by user id), sort, dir, page, size.
 */

/**
 * Columns the Contacts table can sort by. Status is deliberately not one of them: the status tabs
 * already split companies by status, and an A–Z order of status codes means nothing to people.
 */
export const SORT_KEYS = ["name", "country", "niche", "priority", "people", "lastEmailed", "created"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const PAGE_SIZES = [50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export type CompanyFilters = {
  q?: string;
  view?: "all" | "missing-email";
  listId?: number;
  status?: CompanyStatusValue;
  tagIds?: number[];
  countries?: string[];
  niches?: string[];
  priorities?: PriorityValue[];
  emailed?: "yes" | "no";
  hasEmail?: "yes" | "no";
  firstContactedById?: number;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
  pageSize: PageSize;
};

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function get(src: ParamSource, key: string): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

function list(src: ParamSource, key: string): string[] {
  const v = get(src, key);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function int(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseCompanyFilters(src: ParamSource): CompanyFilters {
  const status = get(src, "status");
  const sort = get(src, "sort");
  const size = int(get(src, "size"));
  const tagIds = list(src, "tag").map((t) => int(t)).filter((n): n is number => n !== undefined);
  return {
    q: get(src, "q")?.trim() || undefined,
    view: get(src, "view") === "missing-email" ? "missing-email" : "all",
    listId: int(get(src, "list")),
    status: COMPANY_STATUSES.includes(status as CompanyStatusValue) ? (status as CompanyStatusValue) : undefined,
    tagIds: tagIds.length ? tagIds : undefined,
    countries: list(src, "country").map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    niches: list(src, "niche"),
    priorities: list(src, "priority").filter((p): p is PriorityValue => PRIORITIES.includes(p as PriorityValue)),
    emailed: get(src, "emailed") === "yes" ? "yes" : get(src, "emailed") === "no" ? "no" : undefined,
    hasEmail: get(src, "hasEmail") === "yes" ? "yes" : get(src, "hasEmail") === "no" ? "no" : undefined,
    firstContactedById: int(get(src, "by")),
    sort: SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : "name",
    dir: get(src, "dir") === "desc" ? "desc" : "asc",
    page: int(get(src, "page")) ?? 1,
    pageSize: PAGE_SIZES.includes(size as PageSize) ? (size as PageSize) : 50,
  };
}

/** Back to URL parameters (only non-default values), e.g. for links and exports. */
export function companyFiltersToParams(f: Partial<CompanyFilters>): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.view && f.view !== "all") p.set("view", f.view);
  if (f.listId) p.set("list", String(f.listId));
  if (f.status) p.set("status", f.status);
  if (f.tagIds?.length) p.set("tag", f.tagIds.join(","));
  if (f.countries?.length) p.set("country", f.countries.join(","));
  if (f.niches?.length) p.set("niche", f.niches.join(","));
  if (f.priorities?.length) p.set("priority", f.priorities.join(","));
  if (f.emailed) p.set("emailed", f.emailed);
  if (f.hasEmail) p.set("hasEmail", f.hasEmail);
  if (f.firstContactedById) p.set("by", String(f.firstContactedById));
  if (f.sort && f.sort !== "name") p.set("sort", f.sort);
  if (f.dir && f.dir !== "asc") p.set("dir", f.dir);
  if (f.page && f.page > 1) p.set("page", String(f.page));
  if (f.pageSize && f.pageSize !== 50) p.set("size", String(f.pageSize));
  return p;
}

const HAS_EMAIL: Prisma.CompanyWhereInput = {
  people: { some: { deletedAt: null, emailNorm: { not: null } } },
};

/**
 * Prisma where-clause for the filters. `omit` lets the status tabs count "everything
 * except the status filter". Soft-deleted companies are always excluded.
 */
export function buildCompanyWhere(
  f: Partial<CompanyFilters>,
  omit: { status?: boolean } = {},
): Prisma.CompanyWhereInput {
  const and: Prisma.CompanyWhereInput[] = [{ deletedAt: null }];
  if (f.q) {
    for (const word of normalizeText(f.q).split(" ").filter(Boolean).slice(0, 8)) {
      and.push({ searchText: { contains: word } });
    }
  }
  if (f.view === "missing-email" || f.hasEmail === "no") and.push({ NOT: HAS_EMAIL });
  if (f.hasEmail === "yes") and.push(HAS_EMAIL);
  if (f.listId) and.push({ lists: { some: { listId: f.listId } } });
  if (f.status && !omit.status) and.push({ status: f.status });
  if (f.tagIds?.length) and.push({ tags: { some: { tagId: { in: f.tagIds } } } });
  if (f.countries?.length) and.push({ country: { in: f.countries } });
  if (f.niches?.length) and.push({ niche: { in: f.niches } });
  if (f.priorities?.length) and.push({ priority: { in: f.priorities } });
  // lastContactAt = the newer of "emailed from this app" and "contacted in the old tool".
  if (f.emailed === "yes") and.push({ lastContactAt: { not: null } });
  if (f.emailed === "no") and.push({ lastContactAt: null });
  if (f.firstContactedById) and.push({ firstContactedById: f.firstContactedById });
  return { AND: and };
}

export function buildCompanyOrderBy(f: Pick<CompanyFilters, "sort" | "dir">): Prisma.CompanyOrderByWithRelationInput[] {
  const dir = f.dir;
  switch (f.sort) {
    case "country":
      return [{ country: { sort: dir, nulls: "last" } }, { nameNorm: "asc" }, { id: "asc" }];
    case "niche":
      return [{ niche: { sort: dir, nulls: "last" } }, { nameNorm: "asc" }, { id: "asc" }];
    case "priority":
      return [{ priorityRank: dir }, { nameNorm: "asc" }, { id: "asc" }];
    case "people":
      // Counts every person row of the company. Removed people are rare, and Prisma can't filter
      // a relation count in ORDER BY, so they are counted too.
      return [{ people: { _count: dir } }, { nameNorm: "asc" }, { id: "asc" }];
    case "lastEmailed":
      // Same value the column shows: the newer of this app's last email and the old tool's date.
      return [{ lastContactAt: { sort: dir, nulls: "last" } }, { nameNorm: "asc" }, { id: "asc" }];
    case "created":
      return [{ createdAt: dir }, { id: dir }];
    case "name":
    default:
      return [{ nameNorm: dir }, { id: "asc" }];
  }
}

export function priorityRank(p: PriorityValue): number {
  return p === "HIGH" ? 1 : p === "LOW" ? 3 : 2;
}

/**
 * Company.lastContactAt, derived on write: the newer of the last email sent from this app
 * (lastEmailedAt) and the old tool's last-contacted date (importedLastContactAt), or null.
 * Whoever writes either date also writes this, so sorting and filtering stay a plain indexed column.
 */
export function lastContactAt(lastEmailedAt: Date | null | undefined, importedLastContactAt: Date | null | undefined): Date | null {
  const a = lastEmailedAt ?? null;
  const b = importedLastContactAt ?? null;
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
