"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { COMPANY_STATUSES } from "@/core/labels";
import { ensureUniqueCustomKeys, mappingProblem } from "@/core/import/column-matching";
import {
  LIST_NAME_MAX,
  readMapping,
  TAG_NAME_MAX,
  type CheckView,
  type GroupChoice,
  type ImportOptions,
} from "@/core/import/types";
import { runAction, UserError, parseInput, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { db, dbTx, dbWrite } from "@/server/db";
import { enqueueJob, getJob, toPublicJob, type PublicJob } from "@/server/jobs";
import { getWorkerStatus } from "@/server/worker-status";
import { analyzeImport, buildCheckView, forgetImportCheck } from "@/server/services/imports/check";
import { discardImportSession, loadStoredSession, type StoredSession } from "@/server/services/imports/sessions";

/**
 * Server actions behind the import screens (steps 2–5). Uploads themselves go through the
 * POST /api/imports route handler (files can be larger than a Server Action body).
 */

const GONE = "This import doesn't exist any more. Start again from the Import page.";
const STARTED = "This import has already started, so it can't be changed any more.";

async function editableSession(sessionId: number): Promise<StoredSession> {
  const session = await loadStoredSession(sessionId);
  if (!session) throw new UserError(GONE);
  if (session.status !== "UPLOADED" && session.status !== "MAPPED" && session.status !== "FAILED") throw new UserError(STARTED);
  return session;
}

const sessionIdSchema = z.number().int().positive();

// ───────────────────────── step 2: columns ─────────────────────────

export async function saveImportMappingAction(input: { sessionId: number; mapping: unknown }): Promise<ActionResult<null>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await editableSession(sessionId);
    const read = readMapping(input.mapping, session.headers.length);
    if (!read) throw new UserError("The column choices didn't come through. Reload the page and try again.");
    const mapping = ensureUniqueCustomKeys(read);
    const problem = mappingProblem(mapping);
    if (problem) throw new UserError(problem);
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { mapping, status: "MAPPED" } }));
    forgetImportCheck(sessionId);
    return null;
  });
}

// ───────────────────────── step 3: options ─────────────────────────

const optionsSchema = z.object({
  list: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }),
    z.object({ mode: z.literal("existing"), listId: z.number({ error: "Pick a list." }).int().positive({ error: "Pick a list." }) }),
    z.object({
      mode: z.literal("new"),
      name: z
        .string()
        .trim()
        .min(1, { error: "Give the new list a name." })
        .max(LIST_NAME_MAX, { error: `Keep the list name under ${LIST_NAME_MAX} characters.` }),
    }),
  ]),
  startStatus: z.enum(COMPANY_STATUSES, { error: "Pick a starting status." }),
  tag: z
    .string()
    .trim()
    .max(TAG_NAME_MAX, { error: `Keep the tag under ${TAG_NAME_MAX} characters.` })
    .refine((v) => !v.includes(","), { error: "A tag can't contain a comma. Use one tag for the whole import." })
    .nullable(),
  duplicates: z.enum(["skip", "update"]),
  grouping: z.enum(["website-and-name", "name", "website"]),
});

export async function saveImportOptionsAction(input: {
  sessionId: number;
  options: Omit<ImportOptions, "choices" | "possibleDuplicates" | "deletedMatches">;
}): Promise<ActionResult<null>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await editableSession(sessionId);
    if (!session.mapping) throw new UserError("Match the columns first.");
    const parsed = parseInput(optionsSchema, input.options);
    if (parsed.list.mode === "existing") {
      const list = await db.list.findUnique({ where: { id: parsed.list.listId }, select: { id: true } });
      if (!list) throw new UserError("That list doesn't exist any more. Pick another list or create a new one.");
    }
    const groupingChanged = parsed.grouping !== session.options.grouping;
    const options: ImportOptions = {
      ...session.options,
      list: parsed.list,
      startStatus: parsed.startStatus,
      tag: parsed.tag ? parsed.tag.replace(/\s+/g, " ") : null,
      duplicates: parsed.duplicates,
      grouping: parsed.grouping,
      // Answers belong to groups; other grouping → other groups.
      choices: groupingChanged ? {} : session.options.choices,
    };
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { options } }));
    return null;
  });
}

// ───────────────────────── step 4: check ─────────────────────────

async function checkView(session: StoredSession, onlyProblems: boolean): Promise<CheckView> {
  if (!session.mapping) throw new UserError("Match the columns first.");
  const analysis = await analyzeImport(session.id, session.mapping, session.options);
  return buildCheckView(analysis, session.options, onlyProblems);
}

export async function checkImportAction(input: { sessionId: number; onlyProblems?: boolean }): Promise<ActionResult<CheckView>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await editableSession(sessionId);
    return checkView(session, Boolean(input.onlyProblems));
  });
}

const choiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("new") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("merge"), companyId: z.number().int().positive() }),
]);

export async function setImportChoiceAction(input: {
  sessionId: number;
  groupKey: string;
  choice: GroupChoice;
  onlyProblems?: boolean;
}): Promise<ActionResult<CheckView>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const groupKey = parseInput(z.string().regex(/^r\d+$/), input.groupKey);
    const choice = parseInput(choiceSchema, input.choice);
    const session = await editableSession(sessionId);
    const options: ImportOptions = { ...session.options, choices: { ...session.options.choices, [groupKey]: choice } };
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { options } }));
    return checkView({ ...session, options }, Boolean(input.onlyProblems));
  });
}

export async function setImportDefaultsAction(input: {
  sessionId: number;
  possibleDuplicates?: "new" | "merge";
  deletedMatches?: "restore" | "new";
  onlyProblems?: boolean;
}): Promise<ActionResult<CheckView>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await editableSession(sessionId);
    if (!session.mapping) throw new UserError("Match the columns first.");
    // A new answer for "all of them" replaces the single answers of that kind.
    const analysis = await analyzeImport(sessionId, session.mapping, session.options);
    const choices = { ...session.options.choices };
    for (const p of analysis.plans) {
      if (input.possibleDuplicates && p.decision?.kind === "possible-duplicate") delete choices[p.group.key];
      if (input.deletedMatches && p.decision?.kind === "restore") delete choices[p.group.key];
    }
    const options: ImportOptions = {
      ...session.options,
      possibleDuplicates: input.possibleDuplicates === "merge" ? "merge" : input.possibleDuplicates === "new" ? "new" : session.options.possibleDuplicates,
      deletedMatches: input.deletedMatches === "new" ? "new" : input.deletedMatches === "restore" ? "restore" : session.options.deletedMatches,
      choices,
    };
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { options } }));
    return checkView({ ...session, options }, Boolean(input.onlyProblems));
  });
}

// ───────────────────────── step 5: import ─────────────────────────

export async function startImportAction(input: { sessionId: number }): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await loadStoredSession(sessionId);
    if (!session) throw new UserError(GONE);
    if (session.status === "DONE") throw new UserError("This import has already finished.");
    if (session.status === "CANCELLED") throw new UserError("This import was cancelled. Upload the file again to import it.");
    if (session.status === "COMMITTING" && session.jobId) {
      const job = await getJob(session.jobId);
      if (job && (job.status === "QUEUED" || job.status === "RUNNING")) return { jobId: job.id };
    }
    if (!session.mapping) throw new UserError("Match the columns first.");
    const problem = mappingProblem(session.mapping);
    if (problem) throw new UserError(problem);
    const job = await dbTx(async (tx) => {
      const j = await enqueueJob(
        { type: "import.commit", payload: { sessionId }, dedupeKey: `import:${sessionId}`, createdById: user.id, maxAttempts: 3 },
        tx,
      );
      await tx.importSession.update({ where: { id: sessionId }, data: { status: "COMMITTING", jobId: j.id } });
      return j;
    });
    forgetImportCheck(sessionId);
    revalidatePath("/import");
    return { jobId: job.id };
  });
}

/** Progress of this import's task (the screen also polls GET /api/jobs/:id). */
export async function importJobAction(input: { sessionId: number }): Promise<ActionResult<PublicJob | null>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const session = await loadStoredSession(sessionId);
    if (!session) throw new UserError(GONE);
    if (!session.jobId) return null;
    const job = await getJob(session.jobId);
    return job ? toPublicJob(job) : null;
  });
}

/** Whether the background sender (which runs imports) is running. */
export async function workerRunningAction(): Promise<ActionResult<{ running: boolean }>> {
  return runAction(async () => {
    await requireUserAction();
    const status = await getWorkerStatus();
    return { running: status.running };
  });
}

export async function discardImportAction(input: { sessionId: number }): Promise<ActionResult<null>> {
  return runAction(async () => {
    await requireUserAction();
    const sessionId = parseInput(sessionIdSchema, input.sessionId);
    const ok = await discardImportSession(sessionId);
    if (!ok) {
      const session = await loadStoredSession(sessionId);
      if (session) throw new UserError(STARTED);
    }
    forgetImportCheck(sessionId);
    revalidatePath("/import");
    return null;
  }, "Import discarded.");
}
