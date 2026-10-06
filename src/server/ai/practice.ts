import type { DraftFlag, DraftOutcome } from "@/core/ai/types";
import { db } from "@/server/db";
import { claimQueuedDrafts, companySite, extraSharedDomains, finishDraft } from "@/server/services/ai";
import { COMPANY_DELETED_TEXT } from "@/server/services/ai/review";

/**
 * The practice drafter (docs/dev/M5-DESIGN.md §3.12, D19): what the drafting job does in the practice copy. No reader,
 * no network, no Claude, cost $0, model "practice". Every company with a website gets a READY draft with a made-up line
 * and the "practice" flag; every 7th company (by id) gets NO_LINE `thin`, so every tab of the AI lines page has
 * something. The job always uses it when Setting "practice.copy" is true, whatever deps were injected.
 */

/** The model written on practice drafts (and in the practice run's payload). */
export const PRACTICE_MODEL = "practice";
/** The quote of a practice draft. */
export const PRACTICE_QUOTE = "(Practice copy: no website was read.)";
/** The flag every practice line carries. */
export const PRACTICE_FLAG: DraftFlag = { code: "practice", text: "Practice copy: made up, not from the website." };
/** Every company whose id is a multiple of this gets "No line" in the practice copy. */
export const PRACTICE_NO_LINE_EVERY = 7;

/** Drafts claimed per round (nothing is read, so rounds are quick). */
const PRACTICE_BATCH = 25;

/** "(Practice) A sentence about Firma GmbH's own work would appear here." */
export function practiceLine(companyName: string): string {
  return `(Practice) A sentence about ${companyName}'s own work would appear here.`;
}

/** The company as the practice drafter needs it (null = it doesn't exist any more). */
export type PracticeCompany = {
  id: number;
  name: string;
  website: string | null;
  instagram: string | null;
  deletedAt: Date | null;
} | null;

/** How one practice draft ends (pure; the same skip rules as a real run, §3.2). */
export function practiceOutcome(company: PracticeCompany, extraShared?: ReadonlySet<string>): DraftOutcome {
  if (!company || company.deletedAt) return { status: "FAILED", error: COMPANY_DELETED_TEXT, flags: [] };
  const site = companySite(company, extraShared);
  if (site.kind === "none") return { status: "NO_LINE", reasonIfNull: "no_website", flags: [], homeSnapshotId: null, pageSnapshotId: null };
  if (site.kind === "social") return { status: "NO_LINE", reasonIfNull: "social_only", flags: [], homeSnapshotId: null, pageSnapshotId: null };
  if (company.id % PRACTICE_NO_LINE_EVERY === 0) {
    return { status: "NO_LINE", reasonIfNull: "thin", flags: [PRACTICE_FLAG], homeSnapshotId: null, pageSnapshotId: null };
  }
  return {
    status: "READY",
    line: practiceLine(company.name),
    evidenceQuote: PRACTICE_QUOTE,
    evidenceSource: "homepage",
    evidenceUrl: null,
    flags: [PRACTICE_FLAG],
    homeSnapshotId: null,
    pageSnapshotId: null,
  };
}

export type PracticeRunResult = {
  /** True when someone clicked Stop: the drafts not written yet are left for the caller's deleteQueuedDrafts. */
  cancelled: boolean;
  /** True when the worker is shutting down: the rest waits in the queue. */
  interrupted: boolean;
};

/**
 * Writes the run's practice drafts: claims them (QUEUED → FETCHING, model "practice") and finishes each at once.
 * `onFinished` runs after every draft that was written (progress); Stop and shutdown are looked at between rounds.
 */
export async function runPracticeDrafts(
  jobId: number,
  opts: {
    cancelRequested: () => Promise<boolean>;
    onFinished: (status: DraftOutcome["status"]) => Promise<void> | void;
    signal?: AbortSignal;
  },
): Promise<PracticeRunResult> {
  const extra = await extraSharedDomains();
  let emptyRounds = 0;
  for (;;) {
    if (await opts.cancelRequested()) return { cancelled: true, interrupted: false };
    if (opts.signal?.aborted) return { cancelled: false, interrupted: true };
    const claimed = await claimQueuedDrafts(jobId, PRACTICE_BATCH, new Set(), PRACTICE_MODEL);
    if (claimed.length === 0) {
      const left = await db.aiDraft.count({ where: { jobId, status: "QUEUED" } });
      // Another claimer can only take a draft for a moment; give up after a few empty rounds.
      if (left === 0 || ++emptyRounds >= 3) return { cancelled: false, interrupted: false };
      continue;
    }
    emptyRounds = 0;
    const companies = new Map(
      (
        await db.company.findMany({
          where: { id: { in: claimed.map((d) => d.companyId) } },
          select: { id: true, name: true, website: true, instagram: true, deletedAt: true },
        })
      ).map((c) => [c.id, c]),
    );
    for (const d of claimed) {
      const outcome = practiceOutcome(companies.get(d.companyId) ?? null, extra);
      if (await finishDraft(d.id, jobId, outcome)) await opts.onFinished(outcome.status);
    }
  }
}
