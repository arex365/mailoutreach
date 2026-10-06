import { companyFiltersToParams, type CompanyFilters } from "@/server/services/companies/filters";
import type { EmptyKind } from "./types";

/**
 * URL helpers for the Contacts screen. The URL is the single source of truth for the
 * view (filters, sort, page, open company), so views can be bookmarked and shared.
 * Pure functions: usable on the server and in the browser.
 */

/** Parameters that narrow the companies shown (the list/view choice is not a "filter"). */
export const FILTER_PARAM_KEYS = ["q", "status", "tag", "country", "niche", "priority", "emailed", "hasEmail", "by"] as const;

/** Display preferences that survive switching lists. */
const DISPLAY_PARAM_KEYS = ["sort", "dir", "size"] as const;

export function hasActiveFilters(f: Partial<CompanyFilters>): boolean {
  return Boolean(
    f.q ||
      f.status ||
      f.tagIds?.length ||
      f.countries?.length ||
      f.niches?.length ||
      f.priorities?.length ||
      f.emailed ||
      f.hasEmail ||
      f.firstContactedById,
  );
}

/** "/contacts?…" (or plain "/contacts"). */
export function contactsHref(params: URLSearchParams | string): string {
  const s = typeof params === "string" ? params.replace(/^\?/, "") : params.toString();
  return s ? `/contacts?${s}` : "/contacts";
}

/** Copies a query string, applies a change, returns the new query string. */
export function mutateParams(base: string, change: (p: URLSearchParams) => void): string {
  const p = new URLSearchParams(base.replace(/^\?/, ""));
  change(p);
  return p.toString();
}

function csv(p: URLSearchParams, key: string): string[] {
  return (p.get(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Adds or removes one value of a comma-separated parameter (tag=1,2 / country=DE,NO …). */
export function toggleCsvValue(p: URLSearchParams, key: string, value: string, on?: boolean): void {
  const values = csv(p, key);
  const has = values.includes(value);
  const want = on ?? !has;
  const next = want ? (has ? values : [...values, value]) : values.filter((v) => v !== value);
  if (next.length) p.set(key, next.join(","));
  else p.delete(key);
}

/** Any change to what's shown starts again at page 1 and closes nothing else. */
export function resetPage(p: URLSearchParams): void {
  p.delete("page");
}

/** Removes every filter (search, status tab, tags, …) but keeps the list/view and display settings. */
export function clearFilterParams(p: URLSearchParams): void {
  for (const k of FILTER_PARAM_KEYS) p.delete(k);
  p.delete("page");
}

/** Link for the list sidebar: switches view/list, keeps only sort, direction and page size. */
export function viewHref(currentSearch: string, target: { view?: "all" | "missing-email"; listId?: number }): string {
  const current = new URLSearchParams(currentSearch.replace(/^\?/, ""));
  const p = new URLSearchParams();
  for (const k of DISPLAY_PARAM_KEYS) {
    const v = current.get(k);
    if (v) p.set(k, v);
  }
  if (target.view === "missing-email") p.set("view", "missing-email");
  if (target.listId) p.set("list", String(target.listId));
  return contactsHref(p);
}

/** Link to the same view with a different status tab (undefined = All). */
export function statusHref(filters: CompanyFilters, status: CompanyFilters["status"]): string {
  return contactsHref(companyFiltersToParams({ ...filters, status, page: 1 }));
}

/** Link with every filter removed (for "Clear filters"). */
export function clearFiltersHref(filters: CompanyFilters): string {
  return contactsHref(
    companyFiltersToParams({
      view: filters.view,
      listId: filters.listId,
      sort: filters.sort,
      dir: filters.dir,
      pageSize: filters.pageSize,
    }),
  );
}

/**
 * Which PLAN.md A6 empty state applies when nothing matches. `listExists` is false when the URL
 * points at a list that was deleted (an old bookmark, or a teammate deleted it meanwhile).
 */
export function emptyKindFor(filters: CompanyFilters, total: number, allCompanies: number, listExists = true): EmptyKind {
  if (total > 0) return "none";
  if (filters.listId && !listExists) return "deleted-list";
  const filtered = hasActiveFilters(filters);
  if (allCompanies === 0 && !filtered) return "no-companies";
  if (!filtered && filters.listId) return "empty-list";
  if (!filtered && filters.view === "missing-email") return "no-missing";
  if (!filtered && !filters.listId && filters.view !== "missing-email") return "no-companies";
  return "no-match";
}

export type ExportFormat = "csv" | "xlsx";

/** CSV/Excel of everything matching the current view (the export route ignores page/size). */
export function exportViewHref(filters: CompanyFilters, format: ExportFormat): string {
  const p = companyFiltersToParams({ ...filters, page: 1, pageSize: 50 });
  p.set("format", format);
  return `/api/export/companies?${p.toString()}`;
}

/**
 * Selections above this size can't travel in a link: Node caps request headers
 * (including the URL) at 16 KB, and each id takes up to 6 characters.
 */
export const SELECTION_EXPORT_MAX = 1_500;

export function exportSelectionHref(ids: readonly number[], format: ExportFormat): string {
  return `/api/export/companies?ids=${ids.join(",")}&format=${format}`;
}

/** The "Export for Claude" download on the Missing email view. */
export function missingEmailsExportHref(filters: CompanyFilters): string {
  const p = companyFiltersToParams({ ...filters, page: 1, pageSize: 50 });
  p.delete("view");
  const s = p.toString();
  return s ? `/api/export/missing-emails?${s}` : "/api/export/missing-emails";
}

/** Adds ?company=<id> to the current view (the company panel opens over the table). */
export function withCompany(currentSearch: string, companyId: number | null): string {
  return mutateParams(currentSearch, (p) => {
    if (companyId) p.set("company", String(companyId));
    else p.delete("company");
  });
}
