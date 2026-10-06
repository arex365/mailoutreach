import { Prisma } from "@/generated/prisma/client";
import {
  AI_QUEUE_TABS,
  AI_TAB_STATUS,
  NO_LINE_TEXT,
  UNDO_SECONDS,
  type AiDraftStatusValue,
  type AiQueueTab,
  type DraftFlag,
  type NoLineCode,
} from "@/core/ai/types";
import { smallUsd } from "@/core/money";
import { parseWebsite } from "@/core/shared-domains";
import { formatShortDate } from "@/core/time/format";
import { personalLineSourceText, wordCount } from "@/components/company-panel/emailed-text";
import { db } from "@/server/db";
import { parseDraftFlags, runSpendUsd } from "./drafts";
import { cleanApprovedLine } from "./review";
import { evidenceSnippet, type EvidenceSnippet } from "./snippet";

/**
 * The review queue's data (docs/dev/M5-DESIGN.md §3.9 "Lists", §6.7): the AI lines page's tabs and cards, the runs in
 * progress, the company panel's draft state and the sidebar count. Read-only.
 *
 * Tabs: Waiting = READY (oldest first), Approved / Rejected (newest review first), No line / Failed (newest first);
 * 20 cards per page. Drafts that were tried again (`reviewAction` "retried") are left out of every tab (their new
 * draft stands for them), and so are drafts of deleted companies (nothing can be done with them). Dates in words are in
 * the viewer's zone; instants (`readAt`, `canUndoUntil`) are ISO strings for the browser.
 */

export const DRAFTS_PER_PAGE = 20;

export type DraftCardView = {
  id: number;
  status: AiDraftStatusValue;
  company: { id: number; name: string; website: string | null; host: string | null };
  line: string | null;
  finalLine: string | null;
  /** Words in the line shown (the final line once approved). */
  words: number;
  /** The quote in its place on the saved page, or null (see `snippetNote`). */
  snippet: EvidenceSnippet | null;
  /** Why there is no snippet for a quote: "The exact words weren't found on the saved page." / "The saved page text was cleared; …". */
  snippetNote: string | null;
  quote: string | null;
  evidenceUrl: string | null;
  evidenceHost: string | null;
  /** "de", "nb", "en" or null: the page the quote came from ("German website"). */
  pageLang: string | null;
  /** When the website was read (ISO; "read 3 Oct", "Checked 3 Oct"), else when the draft finished. */
  readAt: string | null;
  flags: DraftFlag[];
  /** NO_LINE: the reason in words (NO_LINE_TEXT). */
  noLineText: string | null;
  /** FAILED: the plain sentence. */
  error: string | null;
  /** Anthropic's request id of the last call, for the Failed card's "Details". */
  requestId: string | null;
  /** READY / REJECTED: the company's current line, which Approve replaces ("written by Ali on 3 Mar"). */
  currentLine: { line: string; sourceText: string } | null;
  /** "Approved by Ali on 3 Oct" (+ " · edited"), "Rejected by Ali on 3 Oct". */
  reviewedText: string | null;
  /** The reviewer only: until when (ISO) the Undo button shows (reviewedAt + 10 s); null otherwise or when past. */
  canUndoUntil: string | null;
  /** "$0.006". */
  costText: string;
};

export const SNIPPET_NOT_FOUND_TEXT = "The exact words weren't found on the saved page.";
export const SNIPPET_CLEARED_TEXT = "The saved page text was cleared; open the page to check the quote.";

const ORDER_BY: Readonly<Record<AiQueueTab, Prisma.Sql>> = {
  waiting: Prisma.sql`d."createdAt" ASC, d."id" ASC`,
  approved: Prisma.sql`d."reviewedAt" DESC, d."id" DESC`,
  rejected: Prisma.sql`d."reviewedAt" DESC, d."id" DESC`,
  "no-line": Prisma.sql`d."updatedAt" DESC, d."id" DESC`,
  failed: Prisma.sql`d."updatedAt" DESC, d."id" DESC`,
};

/** The drafts a tab may show: a company that isn't deleted, and not replaced by a Try again. */
const LISTED = Prisma.sql`c."deletedAt" IS NULL AND (d."reviewAction" IS NULL OR d."reviewAction" <> 'retried')`;

/** Cards per tab (the tab labels' counts). */
export async function tabCounts(): Promise<Record<AiQueueTab, number>> {
  const rows = await db.$queryRaw<Array<{ status: string; n: number | bigint }>>`
    SELECT d."status" AS status, COUNT(*) AS n
    FROM "AiDraft" AS d JOIN "Company" AS c ON c."id" = d."companyId"
    WHERE ${LISTED} AND d."status" IN ('READY', 'APPROVED', 'REJECTED', 'NO_LINE', 'FAILED')
    GROUP BY d."status"`;
  const byStatus = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const out = {} as Record<AiQueueTab, number>;
  for (const tab of AI_QUEUE_TABS) out[tab] = byStatus.get(AI_TAB_STATUS[tab]) ?? 0;
  return out;
}

/** The sidebar's "AI lines" badge (and M6's dashboard tile): lines waiting for review. */
export async function aiQueueCounts(): Promise<{ waiting: number }> {
  return { waiting: (await tabCounts()).waiting };
}

/** The company panel's personal line section: "drafting" (a draft is queued or being drafted), "waiting" (READY), or null. */
export async function companyDraftState(companyId: number): Promise<"drafting" | "waiting" | null> {
  const rows = await db.aiDraft.findMany({
    where: { companyId, status: { in: ["QUEUED", "FETCHING", "DRAFTING", "READY"] } },
    select: { status: true },
  });
  if (rows.some((r) => r.status !== "READY")) return "drafting";
  return rows.length > 0 ? "waiting" : null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** One page of a tab, with every tab's count. `page` is clamped to 1..pageCount. */
export async function listDrafts(
  viewer: { id: number; timeZone: string },
  opts: { tab: AiQueueTab; page?: number; now?: Date },
): Promise<{ rows: DraftCardView[]; counts: Record<AiQueueTab, number>; page: number; pageCount: number }> {
  const now = opts.now ?? new Date();
  const tab: AiQueueTab = (AI_QUEUE_TABS as readonly string[]).includes(opts.tab) ? opts.tab : "waiting";
  const counts = await tabCounts();
  const pageCount = Math.max(1, Math.ceil(counts[tab] / DRAFTS_PER_PAGE));
  const page = Math.min(Math.max(1, Math.floor(Number(opts.page) || 1)), pageCount);
  const idRows = await db.$queryRaw<Array<{ id: number | bigint }>>`
    SELECT d."id" AS id
    FROM "AiDraft" AS d JOIN "Company" AS c ON c."id" = d."companyId"
    WHERE ${LISTED} AND d."status" = ${AI_TAB_STATUS[tab]}
    ORDER BY ${ORDER_BY[tab]}
    LIMIT ${DRAFTS_PER_PAGE} OFFSET ${(page - 1) * DRAFTS_PER_PAGE}`;
  const ids = idRows.map((r) => Number(r.id));
  return { rows: await draftCards(viewer, ids, now), counts, page, pageCount };
}

/** Cards for these draft ids, in the same order (used by listDrafts; the panel and tests may use it for one draft). */
export async function draftCards(viewer: { id: number; timeZone: string }, ids: readonly number[], now: Date = new Date()): Promise<DraftCardView[]> {
  if (ids.length === 0) return [];
  const drafts = await db.aiDraft.findMany({ where: { id: { in: [...ids] } } });
  const companyIds = [...new Set(drafts.map((d) => d.companyId))];
  const snapshotIds = [
    ...new Set(drafts.flatMap((d) => [d.homeSnapshotId, d.pageSnapshotId]).filter((x): x is number => x !== null)),
  ];
  const [companies, snapshots] = await Promise.all([
    db.company.findMany({
      where: { id: { in: companyIds } },
      select: {
        id: true,
        name: true,
        website: true,
        personalLine: true,
        personalLineSource: true,
        personalLineUpdatedAt: true,
        personalLineUpdatedById: true,
      },
    }),
    snapshotIds.length
      ? db.websiteSnapshot.findMany({
          where: { id: { in: snapshotIds } },
          select: { id: true, title: true, text: true, lang: true, fetchedAt: true, skipReason: true },
        })
      : Promise.resolve([]),
  ]);
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
  const userIds = [
    ...new Set(
      [...drafts.map((d) => d.reviewedById), ...companies.map((c) => c.personalLineUpdatedById)].filter((x): x is number => x !== null),
    ),
  ];
  const names = new Map(
    (userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []).map((u) => [
      u.id,
      u.name.trim() || null,
    ]),
  );
  const byId = new Map(drafts.map((d) => [d.id, d]));

  const out: DraftCardView[] = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) continue;
    const c = companyById.get(d.companyId);
    const home = d.homeSnapshotId !== null ? (snapshotById.get(d.homeSnapshotId) ?? null) : null;
    const second = d.pageSnapshotId !== null ? (snapshotById.get(d.pageSnapshotId) ?? null) : null;
    const named = d.evidenceSource === "second_page" ? second : home;
    const other = d.evidenceSource === "second_page" ? home : second;
    const snapshotWanted = d.evidenceSource === "second_page" ? d.pageSnapshotId : d.homeSnapshotId;

    let snippet: EvidenceSnippet | null = null;
    let snippetNote: string | null = null;
    if (d.evidenceQuote && (d.status === "READY" || d.status === "APPROVED" || d.status === "REJECTED")) {
      for (const page of [named, other]) {
        if (!page || page.skipReason) continue;
        snippet = evidenceSnippet(page, d.evidenceQuote);
        if (snippet) break;
      }
      if (!snippet) snippetNote = named || snapshotWanted === null ? SNIPPET_NOT_FOUND_TEXT : SNIPPET_CLEARED_TEXT;
    }

    const status = d.status as AiDraftStatusValue;
    const reviewer = d.reviewedById !== null ? (names.get(d.reviewedById) ?? null) : null;
    // "edited" is the review action; after a Regenerate replaced it, the approved line is compared with Claude's (cleaned).
    const edited =
      status === "APPROVED" &&
      (d.reviewAction === "edited" || (d.reviewAction !== "approved" && d.finalLine !== null && d.finalLine !== cleanApprovedLine(d.line)));
    const on = d.reviewedAt ? ` on ${formatShortDate(d.reviewedAt, viewer.timeZone, now)}` : "";
    const reviewedText =
      status === "APPROVED"
        ? `Approved by ${reviewer ?? "a teammate"}${on}${edited ? " · edited" : ""}`
        : status === "REJECTED"
          ? `Rejected by ${reviewer ?? "a teammate"}${on}`
          : null;
    const undoUntil = d.reviewedAt ? new Date(d.reviewedAt.getTime() + UNDO_SECONDS * 1000) : null;
    const canUndo =
      undoUntil !== null &&
      d.reviewedById === viewer.id &&
      ((status === "APPROVED" && (d.reviewAction === "approved" || d.reviewAction === "edited")) ||
        (status === "REJECTED" && d.reviewAction === "rejected")) &&
      now < undoUntil;

    const currentLine =
      c?.personalLine && (status === "READY" || status === "REJECTED")
        ? {
            line: c.personalLine,
            sourceText: personalLineSourceText(
              c.personalLineSource,
              c.personalLineUpdatedById !== null ? names.get(c.personalLineUpdatedById) : null,
              c.personalLineUpdatedAt,
              viewer.timeZone,
              now,
            ),
          }
        : null;
    const readSnapshot = named ?? home ?? second;
    const shown = status === "APPROVED" ? (d.finalLine ?? d.line) : d.line;

    out.push({
      id: d.id,
      status,
      company: {
        id: d.companyId,
        name: c?.name ?? "",
        website: c?.website ?? null,
        host: c?.website ? (parseWebsite(c.website)?.host ?? null) : null,
      },
      line: d.line,
      finalLine: d.finalLine,
      words: wordCount(shown ?? ""),
      snippet,
      snippetNote,
      quote: d.evidenceQuote,
      evidenceUrl: d.evidenceUrl,
      evidenceHost: hostOf(d.evidenceUrl),
      pageLang: named?.lang ?? home?.lang ?? null,
      readAt: (readSnapshot?.fetchedAt ?? d.draftedAt ?? (status === "NO_LINE" || status === "FAILED" ? d.updatedAt : null))?.toISOString() ?? null,
      flags: parseDraftFlags(d.flags),
      noLineText: status === "NO_LINE" && d.reasonIfNull ? (NO_LINE_TEXT[d.reasonIfNull as NoLineCode] ?? null) : null,
      error: status === "FAILED" ? d.error : null,
      requestId: d.requestId,
      currentLine,
      reviewedText,
      canUndoUntil: canUndo && undoUntil ? undoUntil.toISOString() : null,
      costText: smallUsd(d.costUsd ?? 0),
    });
  }
  return out;
}

/** A drafting run in progress, for the AI lines page's run cards. */
export type ActiveRun = {
  jobId: number;
  /** Companies in the run (its drafts). */
  total: number;
  /** Drafts finished (READY, NO_LINE, FAILED, or already reviewed). */
  done: number;
  spentUsd: number;
  status: "QUEUED" | "RUNNING";
  /** A queued run that waits until this instant (deferred: rate limit, pause, yield), else null. */
  waitingUntil: string | null;
  requestedByName: string | null;
  /** Why a deferred run waits (the runner's `result.deferred`), else null. */
  deferred: "yield" | "paused" | "rate-limited" | "retry-later" | null;
};

const DEFERRED_REASONS = ["yield", "paused", "rate-limited", "retry-later"] as const;

/** Drafting runs queued or running: running first, then in the order the worker takes them. */
export async function activeRuns(now: Date = new Date()): Promise<ActiveRun[]> {
  const jobs = await db.job.findMany({
    where: { type: "ai.draftLines", status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: [{ priority: "desc" }, { runAt: "asc" }, { id: "asc" }],
    select: { id: true, status: true, runAt: true, createdById: true, result: true },
  });
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const groups = await db.aiDraft.groupBy({ by: ["jobId", "status"], where: { jobId: { in: ids } }, _count: { _all: true } });
  const userIds = [...new Set(jobs.map((j) => j.createdById).filter((x): x is number => x !== null))];
  const names = new Map(
    (userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []).map((u) => [
      u.id,
      u.name.trim() || null,
    ]),
  );
  const out: ActiveRun[] = [];
  for (const j of jobs) {
    let total = 0;
    let done = 0;
    for (const g of groups) {
      if (g.jobId !== j.id) continue;
      total += g._count._all;
      if (g.status !== "QUEUED" && g.status !== "FETCHING" && g.status !== "DRAFTING") done += g._count._all;
    }
    const result = (j.result ?? null) as { deferred?: unknown } | null;
    const deferred =
      j.status === "QUEUED" && typeof result?.deferred === "string" && (DEFERRED_REASONS as readonly string[]).includes(result.deferred)
        ? (result.deferred as ActiveRun["deferred"])
        : null;
    out.push({
      jobId: j.id,
      total,
      done,
      spentUsd: await runSpendUsd(j.id),
      status: j.status as "QUEUED" | "RUNNING",
      waitingUntil: j.status === "QUEUED" && j.runAt > now ? j.runAt.toISOString() : null,
      requestedByName: j.createdById !== null ? (names.get(j.createdById) ?? null) : null,
      deferred,
    });
  }
  return out.sort((a, b) => (a.status === b.status ? 0 : a.status === "RUNNING" ? -1 : 1));
}
