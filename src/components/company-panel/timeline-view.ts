import { formatDateTime, timeAgo } from "@/core/time/format";

/**
 * Timeline rows as the browser sees them: plain strings already formatted in the
 * viewer's time zone (so server and browser always render the same text).
 */

export const TIMELINE_FILTERS = ["all", "emails", "replies", "changes"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

export const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
  all: "All",
  emails: "Emails",
  replies: "Replies",
  changes: "Changes",
};

export type TimelineCategory = "email" | "reply" | "change";

/** email.* → emails, reply.* → replies, everything else is a change. */
export function timelineCategory(type: string): TimelineCategory {
  if (type.startsWith("email.")) return "email";
  if (type.startsWith("reply.")) return "reply";
  return "change";
}

export function isTimelineFilter(v: unknown): v is TimelineFilter {
  return typeof v === "string" && (TIMELINE_FILTERS as readonly string[]).includes(v);
}

export type TimelineRow = {
  id: number;
  at: Date;
  type: string;
  summary: string;
  data: unknown;
  mode: "DRY_RUN" | "TEST" | "LIVE" | null;
  actorName: string | null;
};

export type TimelineItemView = {
  id: number;
  type: string;
  category: TimelineCategory;
  summary: string;
  /** Extra line such as a reply's first lines or the new note text. */
  detail: string | null;
  actor: string;
  /** ISO time for <time dateTime>. */
  iso: string;
  ago: string;
  exact: string;
  modeLabel: string | null;
};

export type TimelinePageView = {
  items: TimelineItemView[];
  nextCursor: string | null;
};

const DETAIL_MAX = 240;

function detailFrom(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const pick = [d.snippet, d.text, d.line].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (!pick) return null;
  const t = pick.trim().replace(/\s+/g, " ");
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1)}…` : t;
}

export function toTimelineItemView(row: TimelineRow, timeZone: string, now: Date = new Date()): TimelineItemView {
  return {
    id: row.id,
    type: row.type,
    category: timelineCategory(row.type),
    summary: row.summary,
    detail: detailFrom(row.data),
    actor: row.actorName ?? "System",
    iso: row.at.toISOString(),
    ago: timeAgo(row.at, now),
    exact: formatDateTime(row.at, timeZone),
    modeLabel: row.mode === "DRY_RUN" ? "Dry run" : row.mode === "TEST" ? "Test" : null,
  };
}

/** Empty-state text per filter (PLAN.md A6). */
export function timelineEmptyText(filter: TimelineFilter): string {
  return filter === "emails" ? "Not emailed yet." : "Nothing here yet.";
}
