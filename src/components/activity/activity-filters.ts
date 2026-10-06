import { formatShortDate } from "@/core/time/format";

/**
 * Activity page filters (browser-safe: shared by the filter bar and the server query).
 * The URL is the source of truth: /activity?person=3&kind=team&from=2026-09-01&to=2026-09-30&page=2
 */

export const ACTIVITY_KINDS = ["all", "companies", "imports", "team", "emails", "templates"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  all: "Everything",
  companies: "Companies & people",
  imports: "Imports",
  team: "Team",
  emails: "Emails & replies",
  templates: "Templates",
};

/**
 * Which ActivityLog types belong to each kind (by type prefix; see src/server/activity.ts). Follow-ups put on hold
 * after the PC was off, and continued again (`followups.held` / `followups.released`, M4-DESIGN §6 row 11), sit
 * with emails and replies. Address checks and AI lines (`verify.run`, `ai.run`, `ai.rejected`, M5-DESIGN §8 P11) sit
 * with companies and people, next to `person.checked` and `company.personalLine`.
 */
export const ACTIVITY_KIND_PREFIXES: Record<ActivityKind, string[]> = {
  all: [],
  companies: ["company.", "person.", "list.", "verify.", "ai."],
  imports: ["import."],
  team: ["user.", "auth."],
  emails: ["email.", "reply.", "campaign.", "followups."],
  templates: ["template."],
};

/**
 * The Activity page's second line for an outage-hold entry (`followups.*`, M4-DESIGN §3.11): "Replies from 3 Oct to
 * 9 Oct may have been missed." (the window the app couldn't check, not the PC's off-time) with both dates in the viewer's
 * own time zone (the stored summary has no dates, because every viewer may be in another zone). Null for any other
 * entry, or when `data.from`/`data.to` are missing or not dates.
 */
export function followUpsDatesLine(type: string, data: unknown, timeZone: string, now: Date = new Date()): string | null {
  if (!type.startsWith("followups.") || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const from = typeof d.from === "string" ? new Date(d.from) : null;
  const to = typeof d.to === "string" ? new Date(d.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  try {
    return `Replies from ${formatShortDate(from, timeZone, now)} to ${formatShortDate(to, timeZone, now)} may have been missed.`;
  } catch {
    return null; // an unknown time zone
  }
}

export type ActivityFilters = {
  /** A user id, "system" (changes made by the app itself), or null for everyone. */
  person: number | "system" | null;
  kind: ActivityKind;
  /** Calendar dates (YYYY-MM-DD) in the viewer's time zone, inclusive. */
  from: string | null;
  to: string | null;
  page: number;
};

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = { person: null, kind: "all", from: null, to: null, page: 1 };

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function first(src: ParamSource, key: string): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseActivityFilters(src: ParamSource): ActivityFilters {
  const personRaw = (first(src, "person") ?? "").trim();
  let person: ActivityFilters["person"] = null;
  if (personRaw === "system") person = "system";
  else if (/^\d{1,9}$/.test(personRaw) && Number(personRaw) > 0) person = Number(personRaw);

  const kindRaw = first(src, "kind") ?? "all";
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as ActivityKind) : "all";

  let from = first(src, "from") ?? null;
  let to = first(src, "to") ?? null;
  if (!isIsoDate(from)) from = null;
  if (!isIsoDate(to)) to = null;
  if (from && to && from > to) [from, to] = [to, from];

  const pageRaw = Number(first(src, "page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(Math.floor(pageRaw), 100_000) : 1;

  return { person, kind, from, to, page };
}

export function activityFiltersToParams(f: Partial<ActivityFilters>): URLSearchParams {
  const p = new URLSearchParams();
  if (f.person !== null && f.person !== undefined) p.set("person", String(f.person));
  if (f.kind && f.kind !== "all") p.set("kind", f.kind);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.page && f.page > 1) p.set("page", String(f.page));
  return p;
}

export function hasActivityFilters(f: ActivityFilters): boolean {
  return f.person !== null || f.kind !== "all" || Boolean(f.from) || Boolean(f.to);
}
