"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import type { DraftDialogFacts, StartDraftLinesInput } from "@/components/ai/draft-lines-text";
import { db } from "@/server/db";
import { BULK_LIMIT } from "@/server/services/companies/bulk";
import { ServiceError } from "@/server/services/companies/mutations";
import type { AiActor } from "@/server/services/ai/review";
import { draftStartView, startDraftRun } from "@/server/services/ai/start";

/**
 * "Draft personal lines" (docs/dev/M5-DESIGN.md §6.8, §6.11): the dialog's estimate and the start, for ticked companies
 * (Contacts bulk bar), a list (its menu) or one company (the company panel's "Draft with AI"). Members may start
 * drafting (SPEC §1). The start re-selects and re-estimates on the server: the job's payload always carries the server's
 * own estimate, and the "at most" the person confirmed is only used to refuse a start whose cost grew by more than
 * 10 % ("The estimate changed. Open the dialog again to see the new cost.").
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

const REFRESH = "Something about this page is out of date. Refresh it and try again.";
const id = z.number({ error: REFRESH }).int({ error: REFRESH }).positive({ error: REFRESH });
const ids = z
  .array(id, { error: REFRESH })
  .min(1, { error: "Tick at least one company first." })
  .max(BULK_LIMIT, { error: `Draft lines for at most ${BULK_LIMIT.toLocaleString("en-US")} ticked companies at a time.` });
/** The "at most" the dialog showed (dollars): required for Contacts and list starts (§6.11). */
const confirmed = z
  .number({ error: "The estimate changed. Open the dialog again to see the new cost." })
  .finite()
  .nonnegative()
  .max(10_000);

const targetSchema = z.union([z.object({ companyIds: ids }), z.object({ listId: id }), z.object({ companyId: id })]);
const estimateOptsSchema = z.object({ redraft: z.boolean({ error: REFRESH }) });

type Target = z.infer<typeof targetSchema>;

/** The target part of a start's input (exactly one of companyIds, listId, companyId). */
function pickTarget(input: unknown): unknown {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if ("companyIds" in o) return { companyIds: o.companyIds };
  if ("listId" in o) return { listId: o.listId };
  return { companyId: o.companyId };
}

/** The service's input for a target (the panel's one company keeps its own shape: priority 25, its own dedupe key). */
function runInput(t: Target): { companyIds: number[] } | { listId: number } | { companyId: number } {
  if ("companyIds" in t) return { companyIds: t.companyIds };
  if ("listId" in t) return { listId: t.listId };
  return { companyId: t.companyId };
}

/**
 * The dialog's facts: who would be drafted and who is skipped, the estimate, this month's spend and why a start would
 * be refused (paused, no key in the Owner's or a Member's words, no price, over the monthly limit, too many, nothing to
 * draft). The panel always drafts a new line, also for a company that already has one.
 */
export async function estimateDraftLinesAction(
  input: z.infer<typeof targetSchema>,
  opts: z.infer<typeof estimateOptsSchema>,
): Promise<ActionResult<DraftDialogFacts>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const target = parseInput(targetSchema, input);
    const single = "companyId" in target;
    const { redraft } = parseInput(estimateOptsSchema, opts);
    const view = await service(() => draftStartView(actorOf(user), runInput(target), { redraft: single ? true : redraft }));
    const companyName = single
      ? ((await db.company.findUnique({ where: { id: target.companyId }, select: { name: true } }))?.name ?? null)
      : null;
    const e = view.estimate;
    return {
      single,
      companyName,
      companies: view.selection.companies,
      toDraft: view.selection.toDraft.length,
      skipped: { ...view.selection.skipped },
      redraftable: view.selection.redraftable.length,
      redraft: single ? true : redraft,
      estimate: {
        aboutUsd: e.aboutUsd,
        atMostUsd: e.atMostUsd,
        modelLabel: e.modelLabel,
        practiceCopy: e.practiceCopy,
        priceMissing: e.priceMissing,
        overLimit: e.overLimit,
        mayReachLimit: e.mayReachLimit,
        monthly: {
          limitUsd: e.monthly.limitUsd,
          spentUsd: e.monthly.spentUsd,
          monthLabel: e.monthly.monthLabel,
          resetLabel: e.monthly.resetLabel,
        },
      },
      blocker: view.blocker,
      isOwner: user.role === "OWNER",
      hasKey: view.readiness.hasKey,
    };
  });
}

const startOptsSchema = z.object({ redraft: z.boolean({ error: REFRESH }).optional(), confirmedAtMostUsd: confirmed.optional() });

/**
 * Starts drafting: one QUEUED draft per company and one run, after the same checks as the estimate. Toast: "Drafting
 * 30 lines. You'll get a notification when they're ready." (panel: "Drafting a line for Firma GmbH.").
 */
export async function startDraftLinesAction(input: StartDraftLinesInput): Promise<ActionResult<{ jobId: number; count: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const target = parseInput(targetSchema, pickTarget(input));
    const opts = parseInput(startOptsSchema, { redraft: input?.redraft, confirmedAtMostUsd: input?.confirmedAtMostUsd });
    const single = "companyId" in target;
    // Contacts and list starts must say which "at most" the person saw, so a cost that grew can be refused.
    if (!single && opts.confirmedAtMostUsd === undefined) throw new UserError("The estimate changed. Open the dialog again to see the new cost.");
    const source = "companyIds" in target ? "contacts" : "listId" in target ? "list" : "panel";
    const out = await service(() =>
      startDraftRun(actorOf(user), runInput(target), {
        redraft: single ? true : opts.redraft === true,
        confirmedAtMostUsd: opts.confirmedAtMostUsd,
        source,
      }),
    );
    message = out.message;
    revalidatePath("/ai-lines");
    revalidatePath("/contacts");
    return { jobId: out.jobId, count: out.count };
  });
  return res.ok ? { ...res, message } : res;
}
