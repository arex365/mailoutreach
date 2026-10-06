import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

/**
 * The dashboard's "Recent team activity" tile (M6-DESIGN §4.3, critique R9). `email.sent` is logged for every email,
 * so per-email rows (`email.*`) are left out: otherwise one busy morning would fill the tile. Read-only (§0.2 rule 8):
 * bounded `findMany`s (a `take` each, at most `TEAM_ACTIVITY_SCAN_MAX` rows in all), ordered by the `at` index, one
 * batched company lookup, and never a count of the log.
 *
 * Bulk changes, imports and address checks log one row per company (review DASHBOARD-4), so rows are collapsed before
 * they are shown: a run of rows with the same actor, type, mode and sentence becomes one row with a count ("Ali set
 * status to Contacted · 12 companies"), and an import's per-company rows are left out when its "import.done" row is
 * among the rows read (that row already says what the import did). Each row names the company it is about, as the
 * Activity page does (review DASHBOARD-3): "Ali added this company" means nothing without it.
 */

export type TeamActivityRow = {
  /** The newest row's id (of a collapsed run: its first row). */
  id: number;
  /** ISO time of the newest row (the tile writes "12 min ago" with `timeAgo`). */
  at: string;
  summary: string;
  /** Who did it; null for the background sender and other automatic changes. */
  actorName: string | null;
  /** The send mode of a campaign-related row ("Dry run" badge for DRY_RUN); null for the rest. */
  mode: "DRY_RUN" | "TEST" | "LIVE" | null;
  /**
   * The one company the row is about (the Activity page's link: `/contacts?company=<id>`, or the name with "(deleted)"
   * as plain text once deleted); null when it is about no company, or a collapsed run spans several.
   */
  company: { id: number; name: string; deleted: boolean } | null;
  /**
   * A run of identical rows collapsed into this one: how many, whether each was about a different company ("12
   * companies", else "12 times"), and whether there may be more than counted (the run went past the rows read: "at
   * least 200 companies"). Null for a single change.
   */
  group: { count: number; companies: boolean; atLeast: boolean } | null;
};

/** The tile shows 8; a caller may ask for up to 10. */
export const TEAM_ACTIVITY_DEFAULT_TAKE = 8;
export const TEAM_ACTIVITY_MAX_TAKE = 10;
/** Only changes of the last 30 days. */
export const TEAM_ACTIVITY_DAYS = 30;
/** Rows read per query, and at most this many in all, before collapsing (a bulk change of 500 companies reads 200). */
export const TEAM_ACTIVITY_WINDOW = 50;
export const TEAM_ACTIVITY_SCAN_MAX = 200;
const DAY_MS = 86_400_000;

const ROW_SELECT = {
  id: true,
  at: true,
  type: true,
  summary: true,
  mode: true,
  actorId: true,
  companyId: true,
  data: true,
  actor: { select: { name: true } },
} as const;

/** One ActivityLog row as the tile reads it. */
export type TeamActivityLogRow = Prisma.ActivityLogGetPayload<{ select: typeof ROW_SELECT }>;
type LogRow = TeamActivityLogRow;

/** `data.importSessionId` of an import's rows (the per-company rows and its "import.done"), else null. */
function importSessionOf(data: unknown): string | number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).importSessionId;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** One run of identical rows, newest first. */
export type TeamActivityRun = { rows: TeamActivityLogRow[] };
type Run = TeamActivityRun;

const sameChange = (a: LogRow, b: LogRow) =>
  a.actorId === b.actorId && a.type === b.type && a.mode === b.mode && a.summary === b.summary;

/**
 * The rows to show, newest first: an import's per-company rows left out when its "import.done" is among `rows`, then
 * runs of identical changes collapsed. Pure.
 */
export function collapseActivity(rows: readonly LogRow[]): Run[] {
  const doneImports = new Set<string | number>();
  for (const r of rows) {
    const session = r.type === "import.done" ? importSessionOf(r.data) : null;
    if (session !== null) doneImports.add(session);
  }
  const runs: Run[] = [];
  for (const r of rows) {
    const session = r.type === "import.done" ? null : importSessionOf(r.data);
    if (session !== null && doneImports.has(session)) continue;
    const last = runs.at(-1);
    if (last && sameChange(last.rows[0]!, r)) last.rows.push(r);
    else runs.push({ rows: [r] });
  }
  return runs;
}

/**
 * The newest activity of the last 30 days, newest first, without per-email rows (`email.*`), bulk runs collapsed: at
 * most `take` rows (1–10, default 8). Reads `TEAM_ACTIVITY_WINDOW` rows at a time until it has more runs than it shows
 * (so every run shown is complete) or has read `TEAM_ACTIVITY_SCAN_MAX` rows.
 */
export async function recentTeamActivity(now: Date, take: number = TEAM_ACTIVITY_DEFAULT_TAKE): Promise<TeamActivityRow[]> {
  const limit = Number.isFinite(take) ? Math.min(TEAM_ACTIVITY_MAX_TAKE, Math.max(1, Math.floor(take))) : TEAM_ACTIVITY_DEFAULT_TAKE;
  const where: Prisma.ActivityLogWhereInput = {
    at: { gte: new Date(now.getTime() - TEAM_ACTIVITY_DAYS * DAY_MS) },
    NOT: { type: { startsWith: "email." } },
  };
  const rows: LogRow[] = [];
  const seen = new Set<number>();
  let runs: Run[] = [];
  let more = true;
  for (let skip = 0; skip < TEAM_ACTIVITY_SCAN_MAX; skip += TEAM_ACTIVITY_WINDOW) {
    const batch = await db.activityLog.findMany({
      where,
      orderBy: [{ at: "desc" }, { id: "desc" }],
      skip,
      take: TEAM_ACTIVITY_WINDOW,
      select: ROW_SELECT,
    });
    // A row logged meanwhile moves the rest down by one: a row read twice is only kept once.
    for (const r of batch) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
    runs = collapseActivity(rows);
    more = batch.length === TEAM_ACTIVITY_WINDOW;
    if (!more || runs.length > limit) break;
  }
  const shown = runs.slice(0, limit);
  // Stopped at the scan bound with every run shown: the last one may go on past the rows read.
  const openEnded = more && runs.length <= limit ? shown.at(-1) : undefined;

  // The one company of each row (a run about several names none): at most `limit` names, one batched read.
  const oneCompanyOf = (run: Run): number | null => {
    const ids = new Set(run.rows.map((r) => r.companyId));
    return ids.size === 1 ? run.rows[0]!.companyId : null;
  };
  const companyIds = [...new Set(shown.map(oneCompanyOf).filter((id): id is number => id !== null))];
  // Deliberately includes deleted companies: the log keeps their history, the tile just doesn't link to them.
  const companies = companyIds.length
    ? await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, deletedAt: true } })
    : [];
  const byId = new Map(companies.map((c) => [c.id, c]));

  return shown.map((run) => {
    const first = run.rows[0]!;
    const ids = new Set(run.rows.map((r) => r.companyId));
    const companyId = oneCompanyOf(run);
    const one = companyId !== null ? byId.get(companyId) : undefined;
    const count = run.rows.length;
    return {
      id: first.id,
      at: first.at.toISOString(),
      summary: first.summary,
      actorName: first.actor?.name ?? null,
      mode: first.mode,
      company: one ? { id: one.id, name: one.name, deleted: one.deletedAt !== null } : null,
      group: count > 1 ? { count, companies: !ids.has(null) && ids.size === count, atLeast: run === openEnded } : null,
    };
  });
}
