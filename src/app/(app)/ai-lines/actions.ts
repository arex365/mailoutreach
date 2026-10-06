"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction, requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { ServiceError } from "@/server/services/companies/mutations";
import { resumeAi } from "@/server/services/ai/pause";
import { approveDraft, rejectDraft, undoDraft, type AiActor } from "@/server/services/ai/review";
import { regenerateDraft, retryDraft, stopDraftRun } from "@/server/services/ai/start";

/**
 * The AI lines page (docs/dev/M5-DESIGN.md §6.7, §6.11): review decisions, Regenerate, Try again, Stop and Resume.
 * Everyone signed in reviews and starts drafting (SPEC §1); resuming the AI queue is the Owner's. Stop acts on AI
 * drafting runs only (the service refuses any other job type, §0.2 rule 14). The services' sentences are shown as they
 * are.
 */

function actorOf(user: SessionUser): AiActor {
  return { id: user.id, name: user.name, role: user.role };
}

/** Runs a service call, turning its ServiceError (a sentence for the person) into a UserError for runAction. */
async function service<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw new UserError(err.message, err.fieldErrors);
    throw err;
  }
}

/** The review queue, and the Contacts page whose company panel shows the line (approve and undo change it). */
function revalidateQueue(opts: { contacts?: boolean } = {}): void {
  revalidatePath("/ai-lines");
  if (opts.contacts) revalidatePath("/contacts");
}

const REFRESH = "Something about this page is out of date. Refresh it and try again.";
const id = z.number({ error: REFRESH }).int({ error: REFRESH }).positive({ error: REFRESH });

const approveSchema = z.object({
  draftId: id,
  /** The edited line ("Edit then approve"); missing = Claude's line as it is. */
  line: z.string({ error: "Write the line before you approve it." }).max(5_000).optional(),
});

/** Approve (or "Edit then approve"): the company's emails use this line from now on. */
export async function approveDraftAction(input: z.infer<typeof approveSchema>): Promise<ActionResult<{ companyName: string }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { draftId, line } = parseInput(approveSchema, input);
    const out = await service(() => approveDraft(actorOf(user), draftId, { line }));
    message = out.message;
    revalidateQueue({ contacts: true });
    return { companyName: out.companyName };
  });
  return res.ok ? { ...res, message } : res;
}

const draftSchema = z.object({ draftId: id });

/** Reject: the line isn't used; Undo is offered for 10 seconds. */
export async function rejectDraftAction(input: z.infer<typeof draftSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { draftId } = parseInput(draftSchema, input);
    message = (await service(() => rejectDraft(actorOf(user), draftId))).message;
    revalidateQueue();
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

/** Undo an Approve or a Reject (only the reviewer, right after; the server allows 60 seconds). */
export async function undoDraftAction(input: z.infer<typeof draftSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { draftId } = parseInput(draftSchema, input);
    message = (await service(() => undoDraft(actorOf(user), draftId))).message;
    revalidateQueue({ contacts: true });
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const regenerateSchema = z.object({ draftId: id, refetch: z.boolean({ error: REFRESH }) });

/** Regenerate: "Write a new line" (refetch false) or "Read the website again and write a new line" (refetch true). */
export async function regenerateDraftAction(input: z.infer<typeof regenerateSchema>): Promise<ActionResult<{ jobId: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { draftId, refetch } = parseInput(regenerateSchema, input);
    const out = await service(() => regenerateDraft(actorOf(user), draftId, { refetch }));
    message = out.message;
    revalidateQueue();
    return { jobId: out.jobId };
  });
  return res.ok ? { ...res, message } : res;
}

/** Try again on a No line or Failed card: a new draft (the website is read again); the old card leaves its tab. */
export async function retryDraftAction(input: z.infer<typeof draftSchema>): Promise<ActionResult<{ jobId: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { draftId } = parseInput(draftSchema, input);
    const out = await service(() => retryDraft(actorOf(user), draftId));
    message = out.message;
    revalidateQueue();
    return { jobId: out.jobId };
  });
  return res.ok ? { ...res, message } : res;
}

const stopSchema = z.object({ jobId: id });

/** Stop a drafting run (only an AI drafting run: any other job id is refused and left alone). */
export async function stopDraftRunAction(input: z.infer<typeof stopSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { jobId } = parseInput(stopSchema, input);
    message = (await service(() => stopDraftRun(actorOf(user), jobId))).message;
    revalidateQueue();
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

/** "Resume drafting" (the Owner): lifts the AI queue's pause and lets waiting runs go on at once. */
export async function resumeAiAction(): Promise<ActionResult<{ resumed: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const out = await service(() => resumeAi(actorOf(user)));
    message = out.message;
    revalidateQueue();
    revalidatePath("/settings/ai");
    return { resumed: out.resumed };
  });
  return res.ok ? { ...res, message } : res;
}
