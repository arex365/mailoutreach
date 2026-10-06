import { logActivity } from "@/server/activity";
import { dbTx, type Tx } from "@/server/db";
import { cleanPersonalLine, personalLineProblem, ServiceError } from "@/server/services/companies/mutations";

/**
 * The review decisions on AI lines (docs/dev/M5-DESIGN.md §3.9, A6): Approve, Edit then approve, Reject and Undo.
 * Everyone signed in may review (SPEC §1). Each decision is one short transaction with a compare-and-set on the draft,
 * so two reviewers racing get "This line was already reviewed by Sara. Refresh the page." instead of a second write.
 *
 * `approveDraft` and `undoDraft` are the only writers of a company's personal line from AI (§0.2 rule 7): Approve sets
 * `personalLine` with source "ai" and keeps the company's previous line fields on the draft (`prevLine*`), so Undo can
 * put them back. Other READY drafts of the same company stay READY (the newest approval wins). Problems the person can
 * fix throw a ServiceError with the sentence to show (the actions turn it into a UserError).
 */

/** Who reviews or starts drafting. */
export type AiActor = { id: number; name: string; role: "OWNER" | "MEMBER" };

/** The server allows Undo this long after the decision (the screen offers it for UNDO_SECONDS, D20). */
export const UNDO_SERVER_MS = 60_000;

export const DRAFT_GONE_TEXT = "This line isn't on the list any more. Refresh the page.";
export const NOT_REVIEWABLE_TEXT = "This line isn't waiting for review any more. Refresh the page.";
export const COMPANY_DELETED_TEXT = "This company was deleted.";
export const UNDO_TOO_LATE_TEXT = "Undo is only possible right after you approve or reject.";
export const LINE_CHANGED_TEXT = "The line was changed since; undo isn't possible.";
export const EMPTY_LINE_TEXT = "Write the line before you approve it.";

/** "This line was already reviewed by Sara. Refresh the page." */
export function alreadyReviewedText(name: string | null): string {
  return name ? `This line was already reviewed by ${name}. Refresh the page.` : NOT_REVIEWABLE_TEXT;
}

/** Removes invisible format characters (zero-width spaces and joiners, bidi controls: `\p{Cf}`), then cleans the line. */
export function cleanApprovedLine(line: string | null | undefined): string {
  return cleanPersonalLine((line ?? "").replace(/\p{Cf}/gu, ""));
}

const REVIEW_SELECT = {
  id: true,
  companyId: true,
  status: true,
  line: true,
  finalLine: true,
  reviewAction: true,
  reviewedById: true,
  reviewedAt: true,
  prevLine: true,
  prevLineSource: true,
  prevLineUpdatedAt: true,
  prevLineUpdatedById: true,
} as const;

async function userName(tx: Tx, id: number | null): Promise<string | null> {
  if (id === null) return null;
  return (await tx.user.findUnique({ where: { id }, select: { name: true } }))?.name?.trim() || null;
}

async function loadDraft(tx: Tx, draftId: number) {
  const draft = await tx.aiDraft.findUnique({ where: { id: draftId }, select: REVIEW_SELECT });
  if (!draft) throw new ServiceError(DRAFT_GONE_TEXT);
  return draft;
}

/** Throws the right sentence for a draft that isn't in one of `allowed` (someone else reviewed it, or it moved on). */
async function requireStatus(
  tx: Tx,
  draft: { status: string; reviewedById: number | null },
  allowed: readonly string[],
): Promise<void> {
  if (allowed.includes(draft.status)) return;
  if (draft.status === "APPROVED" || draft.status === "REJECTED") {
    throw new ServiceError(alreadyReviewedText(await userName(tx, draft.reviewedById)));
  }
  throw new ServiceError(NOT_REVIEWABLE_TEXT);
}

/**
 * Approve (READY or REJECTED), optionally with an edited line: the line is cleaned (`\p{Cf}` removed, whitespace
 * collapsed) and checked against the 300-character rule; the draft becomes APPROVED (`reviewAction` "approved", or
 * "edited" when the line differs from Claude's), keeping the company's current line fields in `prevLine*`; the company
 * gets the line with source "ai"; activity `company.personalLine` "Ali approved an AI line".
 */
export async function approveDraft(
  actor: AiActor,
  draftId: number,
  opts: { line?: string; now?: Date } = {},
): Promise<{ message: string; companyName: string }> {
  const now = opts.now ?? new Date();
  return dbTx(async (tx) => {
    const draft = await loadDraft(tx, draftId);
    await requireStatus(tx, draft, ["READY", "REJECTED"]);
    const company = await tx.company.findUnique({
      where: { id: draft.companyId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        personalLine: true,
        personalLineSource: true,
        personalLineUpdatedAt: true,
        personalLineUpdatedById: true,
      },
    });
    if (!company || company.deletedAt) throw new ServiceError(COMPANY_DELETED_TEXT);

    const original = cleanApprovedLine(draft.line);
    const finalLine = cleanApprovedLine(opts.line ?? draft.line);
    if (!finalLine) throw new ServiceError(EMPTY_LINE_TEXT, { fieldErrors: { line: [EMPTY_LINE_TEXT] } });
    const problem = personalLineProblem(finalLine);
    if (problem) throw new ServiceError(problem, { fieldErrors: { line: [problem] } });
    const edited = opts.line !== undefined && finalLine !== original;

    const res = await tx.aiDraft.updateMany({
      where: { id: draft.id, status: draft.status },
      data: {
        status: "APPROVED",
        finalLine,
        reviewAction: edited ? "edited" : "approved",
        reviewedById: actor.id,
        reviewedAt: now,
        prevLine: company.personalLine,
        prevLineSource: company.personalLineSource,
        prevLineUpdatedAt: company.personalLineUpdatedAt,
        prevLineUpdatedById: company.personalLineUpdatedById,
      },
    });
    if (res.count !== 1) throw new ServiceError(alreadyReviewedText(await userName(tx, draft.reviewedById)));
    await tx.company.update({
      where: { id: company.id },
      data: { personalLine: finalLine, personalLineSource: "ai", personalLineUpdatedAt: now, personalLineUpdatedById: actor.id },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.personalLine",
        summary: `${actor.name} approved an AI line`,
        companyId: company.id,
        data: { line: finalLine, source: "ai", draftId: draft.id, edited },
      },
      tx,
    );
    return { message: `Approved. ${company.name}'s emails now use this line.`, companyName: company.name };
  });
}

/** Reject (READY): the draft becomes REJECTED (`reviewAction` "rejected"); activity `ai.rejected` "Ali rejected an AI line". */
export async function rejectDraft(actor: AiActor, draftId: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  return dbTx(async (tx) => {
    const draft = await loadDraft(tx, draftId);
    await requireStatus(tx, draft, ["READY"]);
    const res = await tx.aiDraft.updateMany({
      where: { id: draft.id, status: "READY" },
      data: { status: "REJECTED", reviewAction: "rejected", reviewedById: actor.id, reviewedAt: now },
    });
    if (res.count !== 1) throw new ServiceError(NOT_REVIEWABLE_TEXT);
    await logActivity(
      {
        actorId: actor.id,
        type: "ai.rejected",
        summary: `${actor.name} rejected an AI line`,
        companyId: draft.companyId,
        data: { draftId: draft.id, line: draft.line },
      },
      tx,
    );
    return { message: "Rejected." };
  });
}

/**
 * Undo an Approve or a Reject: only by the person who made it, within 60 seconds on the server (the screen offers it for
 * 10). An approval goes back to READY and the company's previous line fields come back, but only while the company's
 * line is still the approved one ("The line was changed since; undo isn't possible."); activity `company.personalLine`
 * "Ali undid the AI line". A rejection goes back to READY without activity.
 */
export async function undoDraft(actor: AiActor, draftId: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  return dbTx(async (tx) => {
    const draft = await loadDraft(tx, draftId);
    const undoable =
      (draft.status === "APPROVED" && (draft.reviewAction === "approved" || draft.reviewAction === "edited")) ||
      (draft.status === "REJECTED" && draft.reviewAction === "rejected");
    const inTime =
      draft.reviewedAt !== null &&
      now.getTime() - draft.reviewedAt.getTime() <= UNDO_SERVER_MS &&
      now.getTime() >= draft.reviewedAt.getTime() - 5_000;
    if (!undoable || draft.reviewedById !== actor.id || !inTime) throw new ServiceError(UNDO_TOO_LATE_TEXT);

    const back = {
      status: "READY" as const,
      reviewAction: "undone",
      reviewedById: null,
      reviewedAt: null,
      finalLine: null,
      prevLine: null,
      prevLineSource: null,
      prevLineUpdatedAt: null,
      prevLineUpdatedById: null,
    };
    if (draft.status === "REJECTED") {
      const res = await tx.aiDraft.updateMany({ where: { id: draft.id, status: "REJECTED", reviewAction: "rejected" }, data: back });
      if (res.count !== 1) throw new ServiceError(UNDO_TOO_LATE_TEXT);
      return { message: "Undone." };
    }

    const company = await tx.company.findUnique({
      where: { id: draft.companyId },
      select: { id: true, name: true, deletedAt: true, personalLine: true },
    });
    if (!company || company.deletedAt) throw new ServiceError(COMPANY_DELETED_TEXT);
    if (company.personalLine !== draft.finalLine) throw new ServiceError(LINE_CHANGED_TEXT);
    const res = await tx.aiDraft.updateMany({ where: { id: draft.id, status: "APPROVED", reviewedById: actor.id }, data: back });
    if (res.count !== 1) throw new ServiceError(UNDO_TOO_LATE_TEXT);
    await tx.company.update({
      where: { id: company.id },
      data: {
        personalLine: draft.prevLine,
        personalLineSource: draft.prevLineSource,
        personalLineUpdatedAt: draft.prevLineUpdatedAt,
        personalLineUpdatedById: draft.prevLineUpdatedById,
      },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.personalLine",
        summary: `${actor.name} undid the AI line`,
        companyId: company.id,
        data: { line: draft.prevLine, source: draft.prevLineSource, draftId: draft.id, undone: true },
      },
      tx,
    );
    return { message: `Undone. ${company.name}'s line is back to what it was.` };
  });
}
