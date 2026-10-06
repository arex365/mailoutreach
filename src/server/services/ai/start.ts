import type { Prisma } from "@/generated/prisma/client";
import { DRAFT_PROMPT_VERSION, monthlyLimitText, runCostUsd } from "@/core/ai/estimate";
import { MAX_COMPANIES_PER_RUN, type AiRunPayload } from "@/core/ai/types";
import type { AiPauseState } from "@/core/system-state";
import { aboutUsd } from "@/core/money";
import { plural } from "@/core/text";
import { logActivity } from "@/server/activity";
import { db, dbTx, type Tx } from "@/server/db";
import { enqueueJob, requestJobCancel } from "@/server/jobs";
import { ServiceError } from "@/server/services/companies/mutations";
import { secretInfo } from "@/server/secrets";
import { getSetting } from "@/server/settings";
import { deleteQueuedDrafts, resetStuckDrafts } from "./drafts";
import { estimateDraftRun, type AiRunEstimate } from "./estimate";
import { getAiPause } from "./pause";
import type { AiActor } from "./review";
import {
  NOTHING_TO_DRAFT_TEXT,
  OPEN_DRAFT_STATUSES,
  selectForDrafting,
  singleSkipReason,
  singleSkipText,
  tooManyText,
  type DraftSelection,
} from "./select";

/**
 * Starting AI drafting runs (docs/dev/M5-DESIGN.md §3.1 step 1, §3.2, §3.3, §3.9, §3.9.1): "Draft personal lines"
 * (Contacts, a list's menu), "Draft with AI" (the company panel), Regenerate, Try again, and Stop.
 *
 * A start re-selects and re-estimates on the server, then creates, in ONE short transaction, the `ai.draftLines` job and
 * one QUEUED AiDraft per company (the run's queue; at most MAX_COMPANIES_PER_RUN rows, so the queue appears together with
 * its job and the orphan sweep can never see half of it). The job's payload always carries the server's own estimate;
 * the maximum the browser confirmed is only used to refuse a start whose cost grew by more than 10 %.
 *
 * Refused (ServiceError with the sentence to show) while the AI queue is paused, without a saved Anthropic key, without
 * a price for the model, and once this office month's spend reached the limit, except in the practice copy, which
 * drafts made-up lines for free (§3.12).
 *
 * | Source            | Priority | Dedupe key               | maxAttempts |
 * |-------------------|----------|--------------------------|-------------|
 * | contacts, list    | 10       | none (each start a run)  | 4           |
 * | panel             | 25       | ai:company:<companyId>   | 4           |
 * | regenerate, retry | 25       | ai:draft:<new draft id>  | 4           |
 */

export const AI_RUN_PRIORITY_BULK = 10;
export const AI_RUN_PRIORITY_SINGLE = 25;
export const AI_RUN_MAX_ATTEMPTS = 4;
/** A start is refused when the server's "at most" exceeds the one the person confirmed by more than this (§6.11). */
export const ESTIMATE_GROWTH_ALLOWED = 1.1;

export const ESTIMATE_CHANGED_TEXT = "The estimate changed. Open the dialog again to see the new cost.";
export const NO_KEY_OWNER_TEXT = "Add your Anthropic API key in Settings › AI first.";
export const NO_KEY_MEMBER_TEXT = "Ask the Owner to add an Anthropic API key in Settings › AI.";
export const NOT_AI_RUN_TEXT = "This isn't an AI drafting run.";
export const PAUSED_FALLBACK_TEXT = "AI drafting is paused. The Owner can resume it in Settings › AI.";
export const ALREADY_RETRIED_TEXT = "This draft was already tried again. Refresh the page.";

/** "No price is saved for the model “claude-x”. Enter its prices in Settings › AI." */
export function noPriceText(model: string): string {
  return `No price is saved for the model “${model}”. Enter its prices in Settings › AI.`;
}

type RunInput = { companyIds: number[] } | { listId: number } | { companyId: number };

/** What is known before a start: the practice copy, the pause and whether an Anthropic key is saved. */
export type AiReadiness = { practiceCopy: boolean; pause: AiPauseState; hasKey: boolean };

export async function aiReadiness(now: Date = new Date()): Promise<AiReadiness> {
  const [practice, pause, key] = await Promise.all([getSetting("practice.copy"), getAiPause(now), secretInfo("anthropic.apiKey")]);
  return { practiceCopy: practice === true, pause, hasKey: key.set };
}

/**
 * The sentence that refuses a paid start, or null: paused (the pause's own text), no key (Owner / Member wording), no
 * price for the model, the office month's limit reached (the A6 text). Nothing applies in the practice copy.
 */
export function startBlocker(actor: Pick<AiActor, "role">, ready: AiReadiness, estimate: AiRunEstimate): string | null {
  if (ready.practiceCopy || estimate.practiceCopy) return null;
  if (ready.pause.paused) return ready.pause.text.trim() || PAUSED_FALLBACK_TEXT;
  if (!ready.hasKey) return actor.role === "OWNER" ? NO_KEY_OWNER_TEXT : NO_KEY_MEMBER_TEXT;
  if (estimate.priceMissing) return noPriceText(estimate.model);
  if (estimate.overLimit) return monthlyLimitText(estimate.monthly.limitUsd, estimate.monthly.resetLabel);
  return null;
}

/** Everything the start dialog shows (§6.8), from the same rules as the start itself. */
export type DraftStartView = {
  selection: DraftSelection;
  estimate: AiRunEstimate;
  readiness: AiReadiness;
  /** More than MAX_COMPANIES_PER_RUN to draft ("That's 1,240 companies…"). */
  tooMany: boolean;
  /** Why the start would be refused right now (pause, key, price, monthly limit, too many, nothing to draft), or null. */
  blocker: string | null;
};

/** The dialog's view: who is drafted and skipped, the estimate for those, the month, and what would refuse the start. */
export async function draftStartView(
  actor: AiActor,
  input: RunInput,
  opts: { redraft: boolean; now?: Date },
): Promise<DraftStartView> {
  const now = opts.now ?? new Date();
  const selection = await selectForDrafting(selectionInput(input), { redraft: opts.redraft });
  const [estimate, readiness] = await Promise.all([estimateDraftRun(selection.toDraft.length, now), aiReadiness(now)]);
  const tooMany = selection.toDraft.length > MAX_COMPANIES_PER_RUN;
  const blocker =
    (await nothingToDraftText(input, selection)) ??
    (tooMany ? tooManyText(selection.toDraft.length) : null) ??
    startBlocker(actor, readiness, estimate);
  return { selection, estimate, readiness, tooMany, blocker };
}

function selectionInput(input: RunInput): { companyIds: number[] } | { listId: number } {
  return "companyId" in input ? { companyIds: [input.companyId] } : input;
}

async function companyName(companyId: number): Promise<string> {
  return (await db.company.findUnique({ where: { id: companyId }, select: { name: true } }))?.name ?? "This company";
}

async function isBeingDrafted(companyId: number, reader: Pick<Tx, "aiDraft"> = db): Promise<boolean> {
  const row = await reader.aiDraft.findFirst({
    where: { companyId, status: { in: ["QUEUED", "FETCHING", "DRAFTING"] } },
    select: { id: true },
  });
  return row !== null;
}

/** The refusal when the selection drafts nobody (the panel's own sentences for one company), else null. */
async function nothingToDraftText(input: RunInput, sel: DraftSelection): Promise<string | null> {
  if (sel.toDraft.length > 0) return null;
  const single =
    "companyId" in input
      ? input.companyId
      : "companyIds" in input
        ? input.companyIds.find((id) => Number.isInteger(id) && id > 0)
        : undefined;
  if (single === undefined || sel.companies !== 1) return NOTHING_TO_DRAFT_TEXT;
  const reason = singleSkipReason(sel) ?? "deleted";
  return singleSkipText(reason, await companyName(single), { drafting: reason === "waiting" && (await isBeingDrafted(single)) });
}

/** "Ali asked Claude to draft lines for 30 companies (about $0.17)." */
function runActivitySummary(actor: AiActor, count: number, usd: number, opts: { practiceCopy: boolean; name?: string; again?: boolean }): string {
  const cost = opts.practiceCopy ? "practice copy, free" : aboutUsd(usd);
  const what = opts.name ? `a ${opts.again ? "new " : ""}line for ${opts.name}` : `lines for ${plural(count, "company", "companies")}`;
  return `${actor.name} asked Claude to draft ${what} (${cost}).`;
}

/** Throws when the company already has a run with this dedupe key queued or running. */
async function refuseActiveDedupe(tx: Tx, dedupeKey: string, text: string): Promise<void> {
  const active = await tx.job.findUnique({ where: { activeDedupeKey: dedupeKey }, select: { id: true } });
  if (active) throw new ServiceError(text);
}

/**
 * Starts a drafting run for ticked companies, a list, or one company (the panel). Re-selects and re-estimates on the
 * server; refuses (see startBlocker) and refuses when the estimate grew more than 10 % over `confirmedAtMostUsd` (pass
 * it for Contacts and list starts). Creates the job and its QUEUED drafts in one transaction and logs `ai.run`.
 */
export async function startDraftRun(
  actor: AiActor,
  input: RunInput,
  opts: { redraft: boolean; confirmedAtMostUsd?: number; source: AiRunPayload["source"]; now?: Date },
): Promise<{ jobId: number; count: number; message: string }> {
  const now = opts.now ?? new Date();
  const selection = await selectForDrafting(selectionInput(input), { redraft: opts.redraft });
  const nothing = await nothingToDraftText(input, selection);
  if (nothing) throw new ServiceError(nothing);
  if (selection.toDraft.length > MAX_COMPANIES_PER_RUN) throw new ServiceError(tooManyText(selection.toDraft.length));
  const [estimate, readiness] = await Promise.all([estimateDraftRun(selection.toDraft.length, now), aiReadiness(now)]);
  const blocker = startBlocker(actor, readiness, estimate);
  if (blocker) throw new ServiceError(blocker);
  const confirmed = opts.confirmedAtMostUsd;
  if (confirmed !== undefined && (!Number.isFinite(confirmed) || estimate.atMostUsd > confirmed * ESTIMATE_GROWTH_ALLOWED + 1e-9)) {
    throw new ServiceError(ESTIMATE_CHANGED_TEXT);
  }

  const practiceCopy = readiness.practiceCopy;
  const model = practiceCopy ? "practice" : estimate.model;
  const single = selection.toDraft.length === 1 && ("companyId" in input || opts.source === "panel");
  const singleName = single ? await companyName(selection.toDraft[0]!) : null;
  const bulk = opts.source === "contacts" || opts.source === "list";
  const dedupeKey = opts.source === "panel" && selection.toDraft.length === 1 ? `ai:company:${selection.toDraft[0]}` : undefined;
  const listId = "listId" in input ? input.listId : null;

  const created = await dbTx(async (tx) => {
    if (dedupeKey) await refuseActiveDedupe(tx, dedupeKey, `A line for ${singleName ?? "this company"} is already being drafted.`);
    // Another start may have queued some of these companies meanwhile: leave those out.
    const busy = new Set<number>();
    for (let i = 0; i < selection.toDraft.length; i += 500) {
      const part = selection.toDraft.slice(i, i + 500);
      const rows = await tx.aiDraft.findMany({
        where: { companyId: { in: part }, status: { in: [...OPEN_DRAFT_STATUSES] } },
        select: { companyId: true },
      });
      for (const r of rows) busy.add(r.companyId);
    }
    const ids = selection.toDraft.filter((id) => !busy.has(id));
    if (ids.length === 0) {
      throw new ServiceError(single && singleName ? `A line for ${singleName} is already being drafted.` : NOTHING_TO_DRAFT_TEXT);
    }
    const cost = runCostUsd(ids.length, estimate.perCompany);
    const payload: AiRunPayload = {
      source: opts.source,
      companyCount: ids.length,
      aboutUsd: cost.aboutUsd,
      atMostUsd: cost.atMostUsd,
      model,
      ...(listId !== null ? { listId } : {}),
    };
    const job = await enqueueJob(
      {
        type: "ai.draftLines",
        payload: payload as unknown as Prisma.InputJsonValue,
        priority: bulk ? AI_RUN_PRIORITY_BULK : AI_RUN_PRIORITY_SINGLE,
        maxAttempts: AI_RUN_MAX_ATTEMPTS,
        dedupeKey,
        createdById: actor.id,
      },
      tx,
    );
    for (let i = 0; i < ids.length; i += 500) {
      await tx.aiDraft.createMany({
        data: ids.slice(i, i + 500).map((companyId) => ({
          companyId,
          jobId: job.id,
          createdById: actor.id,
          model,
          promptVersion: DRAFT_PROMPT_VERSION,
          status: "QUEUED" as const,
        })),
      });
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "ai.run",
        summary: runActivitySummary(actor, ids.length, cost.aboutUsd, { practiceCopy, name: singleName ?? undefined }),
        companyId: ids.length === 1 ? ids[0] : null,
        data: { jobId: job.id, source: opts.source, companyCount: ids.length, aboutUsd: cost.aboutUsd, atMostUsd: cost.atMostUsd, model, listId },
      },
      tx,
    );
    return { jobId: job.id, count: ids.length };
  });

  const message = singleName
    ? `Drafting a line for ${singleName}.`
    : `Drafting ${plural(created.count, "line", "lines")}. You'll get a notification when ${created.count === 1 ? "it's" : "they're"} ready.`;
  return { ...created, message };
}

/** The last drafted lines of a company (newest first), which a new line is asked not to repeat (§3.9 Regenerate). */
async function lastDraftedLines(tx: Tx, companyId: number, max = 5): Promise<string[]> {
  const rows = await tx.aiDraft.findMany({
    where: { companyId, line: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { line: true },
    take: max,
  });
  return rows.map((r) => r.line!).filter(Boolean);
}

/**
 * Regenerate (READY, REJECTED or APPROVED) and Try again (NO_LINE or FAILED): a NEW QUEUED draft for the company in a
 * one-company run (priority 25, dedupe `ai:draft:<new id>`, "at most" = one company's). The old draft keeps its cost:
 * Regenerate marks it `regenerated` (a READY one becomes REJECTED), Try again marks it `retried` (it keeps its status
 * and leaves its tab).
 */
async function redraft(
  actor: AiActor,
  draftId: number,
  kind: "regenerate" | "retry",
  opts: { refetch: boolean; now?: Date },
): Promise<{ jobId: number; message: string }> {
  const now = opts.now ?? new Date();
  const old = await db.aiDraft.findUnique({ where: { id: draftId }, select: { id: true, companyId: true, status: true, reviewAction: true } });
  if (!old) throw new ServiceError("This line isn't on the list any more. Refresh the page.");
  const allowed = kind === "regenerate" ? ["READY", "REJECTED", "APPROVED"] : ["NO_LINE", "FAILED"];
  if (!allowed.includes(old.status)) {
    throw new ServiceError(
      kind === "retry" ? "This draft can't be tried again any more. Refresh the page." : "This line can't be regenerated any more. Refresh the page.",
    );
  }
  if (kind === "retry" && old.reviewAction === "retried") throw new ServiceError(ALREADY_RETRIED_TEXT);
  const selection = await selectForDrafting({ companyIds: [old.companyId] }, { redraft: true });
  const name = await companyName(old.companyId);
  if (selection.toDraft.length === 0) {
    const reason = singleSkipReason(selection) ?? "deleted";
    // Only this company's own open draft makes it "waiting"; a READY draft being regenerated is that draft itself.
    if (reason !== "waiting" || (await isBeingDrafted(old.companyId))) {
      throw new ServiceError(singleSkipText(reason, name, { drafting: reason === "waiting" }));
    }
  }
  const [estimate, readiness] = await Promise.all([estimateDraftRun(1, now), aiReadiness(now)]);
  const blocker = startBlocker(actor, readiness, estimate);
  if (blocker) throw new ServiceError(blocker);
  const practiceCopy = readiness.practiceCopy;
  const model = practiceCopy ? "practice" : estimate.model;
  const cost = runCostUsd(1, estimate.perCompany);

  const jobId = await dbTx(async (tx) => {
    if (await isBeingDrafted(old.companyId, tx)) throw new ServiceError(`A new line for ${name} is already being drafted.`);
    const marked =
      kind === "retry"
        ? await tx.aiDraft.updateMany({
            where: { id: old.id, status: old.status, OR: [{ reviewAction: null }, { reviewAction: { not: "retried" } }] },
            data: { reviewAction: "retried" },
          })
        : old.status === "READY"
          ? await tx.aiDraft.updateMany({
              where: { id: old.id, status: "READY" },
              data: { status: "REJECTED", reviewAction: "regenerated", reviewedById: actor.id, reviewedAt: now },
            })
          : await tx.aiDraft.updateMany({ where: { id: old.id, status: old.status }, data: { reviewAction: "regenerated" } });
    if (marked.count !== 1) {
      throw new ServiceError(kind === "retry" ? ALREADY_RETRIED_TEXT : "This line was changed meanwhile. Refresh the page.");
    }
    const avoid = kind === "regenerate" ? await lastDraftedLines(tx, old.companyId) : [];
    const draft = await tx.aiDraft.create({
      data: {
        companyId: old.companyId,
        createdById: actor.id,
        model,
        promptVersion: DRAFT_PROMPT_VERSION,
        status: "QUEUED",
        avoidLines: avoid.length ? avoid : undefined,
        refetch: opts.refetch,
      },
      select: { id: true },
    });
    const payload: AiRunPayload = { source: kind, companyCount: 1, aboutUsd: cost.aboutUsd, atMostUsd: cost.atMostUsd, model };
    const job = await enqueueJob(
      {
        type: "ai.draftLines",
        payload: payload as unknown as Prisma.InputJsonValue,
        priority: AI_RUN_PRIORITY_SINGLE,
        maxAttempts: AI_RUN_MAX_ATTEMPTS,
        dedupeKey: `ai:draft:${draft.id}`,
        createdById: actor.id,
      },
      tx,
    );
    await tx.aiDraft.update({ where: { id: draft.id }, data: { jobId: job.id } });
    await logActivity(
      {
        actorId: actor.id,
        type: "ai.run",
        summary: runActivitySummary(actor, 1, cost.aboutUsd, { practiceCopy, name, again: true }),
        companyId: old.companyId,
        data: { jobId: job.id, source: kind, companyCount: 1, aboutUsd: cost.aboutUsd, atMostUsd: cost.atMostUsd, model, fromDraftId: old.id },
      },
      tx,
    );
    return job.id;
  });
  return { jobId, message: `Drafting a new line for ${name}.` };
}

/**
 * Regenerate: the old draft gets `reviewAction` "regenerated" (READY → REJECTED); a new QUEUED draft asks Claude not to
 * repeat the company's last 5 drafted lines and, with `refetch`, reads the website again ("Read the website again and
 * write a new line").
 */
export async function regenerateDraft(
  actor: AiActor,
  draftId: number,
  opts: { refetch: boolean; now?: Date },
): Promise<{ jobId: number; message: string }> {
  return redraft(actor, draftId, "regenerate", opts);
}

/**
 * Try again on a No line or Failed card: a new draft (the website is read again, so a site that was down gets another
 * chance); the old draft keeps its status and cost, gets `reviewAction` "retried" and leaves its tab.
 */
export async function retryDraft(actor: AiActor, draftId: number, opts: { now?: Date } = {}): Promise<{ jobId: number; message: string }> {
  return redraft(actor, draftId, "retry", { refetch: true, now: opts.now });
}

/**
 * Stop a drafting run (Members too). Refuses any other job type ("This isn't an AI drafting run."), so no other job can
 * be cancelled by guessing its id. A queued or deferred run is cancelled at once and its not-yet-drafted rows go through
 * deleteQueuedDrafts (paid ones become FAILED); a running one is asked to stop: it finishes the companies in flight,
 * then does the same.
 */
export async function stopDraftRun(_actor: AiActor, jobId: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, type: true } });
  if (!job || job.type !== "ai.draftLines") throw new ServiceError(NOT_AI_RUN_TEXT);
  const outcome = await requestJobCancel(jobId, { type: "ai.draftLines", now });
  if (outcome === "not-found") throw new ServiceError(NOT_AI_RUN_TEXT);
  if (outcome === "finished") return { message: "This drafting run has already finished." };
  if (outcome === "requested") return { message: "Stopping. The companies being drafted right now are finished first." };
  const [total, done] = await Promise.all([
    db.aiDraft.count({ where: { jobId } }),
    db.aiDraft.count({ where: { jobId, status: { notIn: ["QUEUED", "FETCHING", "DRAFTING"] } } }),
  ]);
  // Drafts a stopped worker left in the middle go back to the queue first (a possibly billed call is charged), so the
  // clean-up below deletes only drafts that never made a call.
  await resetStuckDrafts(jobId, now);
  await deleteQueuedDrafts(jobId);
  return { message: done > 0 ? `Stopped after ${done} of ${plural(total, "company", "companies")}.` : "Drafting stopped before it started." };
}
