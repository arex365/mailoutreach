"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { COMPANY_STATUSES, COMPANY_STATUS_LABELS, PRIORITIES, PRIORITY_LABELS } from "@/core/labels";
import { plural } from "@/core/text";
import { UserError, parseInput, runAction as runActionBase, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import {
  BULK_LIMIT,
  BulkLimitError,
  NotFoundError,
  bulkAddTag,
  bulkAddToList,
  bulkDelete,
  bulkRemoveFromList,
  bulkRemoveTag,
  bulkSetPriority,
  bulkSetStatus,
  type Actor,
  type BulkResult,
} from "@/server/services/companies/bulk";
import { createCompany, restoreCompany, type CreateCompanyResult } from "@/server/services/companies/create";
import { parseCompanyFilters } from "@/server/services/companies/filters";
import { listMatchingCompanyIds, searchCompaniesQuick, type QuickCompanyResult } from "@/server/services/companies/query";
import { createList, deleteList, renameList } from "@/server/services/lists";

/**
 * Server Actions for the Contacts screen: bulk actions on ticked companies, lists,
 * "Add company" and the Ctrl+K search. Every action checks the session first and
 * answers in plain words (docs/dev/CONVENTIONS.md).
 */

// ───────────────────────── helpers (not exported) ─────────────────────────

function actorOf(user: SessionUser): Actor {
  return { id: user.id, name: user.name };
}

/**
 * The standard runAction (@/lib/action), except the body returns its own success
 * message, because these messages carry counts ("Added 37 companies to Germany Q4.").
 */
async function runAction<T>(fn: () => Promise<{ data: T; message?: string }>): Promise<ActionResult<T>> {
  let message: string | undefined;
  const res = await runActionBase(async () => {
    try {
      const out = await fn();
      message = out.message;
      return out.data;
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof BulkLimitError) throw new UserError(err.message);
      throw err;
    }
  });
  return res.ok ? { ...res, message } : res;
}

const idListSchema = z.array(z.number().int().positive());

function parseIds(raw: unknown): number[] {
  const res = idListSchema.safeParse(raw);
  if (!res.success) {
    throw new UserError("Something about the ticked companies didn't look right. Reload the page and tick them again.");
  }
  const ids = [...new Set(res.data)];
  if (ids.length === 0) throw new UserError("Tick at least one company first.");
  if (ids.length > BULK_LIMIT) {
    throw new UserError(
      `You can change up to ${BULK_LIMIT.toLocaleString("en-US")} companies at a time (you ticked ${ids.length.toLocaleString("en-US")}). Tick fewer and try again.`,
    );
  }
  return ids;
}

function wasWere(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "was" : "were"}`;
}

/** Main sentence + what didn't need changing + what had been deleted meanwhile. */
function describe(main: string, r: BulkResult, sameText: (n: number) => string): string {
  const parts = [r.changed > 0 ? main : "Nothing needed changing."];
  if (r.unchanged > 0) parts.push(sameText(r.unchanged));
  if (r.missing > 0) parts.push(`${wasWere(r.missing)} skipped because ${r.missing === 1 ? "it has" : "they have"} been deleted.`);
  return parts.join(" ");
}

function companies(n: number): string {
  return plural(n, "company", "companies");
}

function done() {
  revalidatePath("/contacts");
}

// ───────────────────────── bulk actions ─────────────────────────

const statusSchema = z.enum(COMPANY_STATUSES, { error: "Pick a status." });
const prioritySchema = z.enum(PRIORITIES, { error: "Pick a priority." });

export async function bulkSetStatusAction(input: { ids: number[]; status: string }): Promise<ActionResult<BulkResult>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const status = parseInput(statusSchema, input?.status);
    const r = await bulkSetStatus(ids, status, actorOf(user));
    done();
    const label = COMPANY_STATUS_LABELS[status];
    return {
      data: r,
      message: describe(`Set ${companies(r.changed)} to ${label}.`, r, (n) => `${n.toLocaleString("en-US")} already had that status.`),
    };
  });
}

export async function bulkSetPriorityAction(input: { ids: number[]; priority: string }): Promise<ActionResult<BulkResult>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const priority = parseInput(prioritySchema, input?.priority);
    const r = await bulkSetPriority(ids, priority, actorOf(user));
    done();
    const label = PRIORITY_LABELS[priority];
    return {
      data: r,
      message: describe(`Set priority to ${label} for ${companies(r.changed)}.`, r, (n) => `${n.toLocaleString("en-US")} already had that priority.`),
    };
  });
}

const addToListSchema = z
  .object({
    listId: z.number().int().positive().optional().nullable(),
    newListName: z.string().max(200).optional().nullable(),
  })
  .refine((v) => Boolean(v.listId) || Boolean(v.newListName?.trim()), {
    error: "Pick a list, or type a name for a new one.",
    path: ["listId"],
  });

export async function bulkAddToListAction(input: {
  ids: number[];
  listId?: number | null;
  newListName?: string | null;
}): Promise<ActionResult<BulkResult & { listId: number; listName: string; listCreated: boolean }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const target = parseInput(addToListSchema, { listId: input?.listId, newListName: input?.newListName });
    const actor = actorOf(user);
    let listId = target.listId ?? 0;
    let listCreated = false;
    if (!listId) {
      const created = await createList(target.newListName ?? "", actor);
      if (!created.ok) throw new UserError(created.error, { newListName: [created.error] });
      listId = created.list.id;
      listCreated = true;
    }
    const r = await bulkAddToList(ids, listId, actor);
    done();
    const main = listCreated
      ? `Created the list "${r.listName}" and added ${companies(r.changed)} to it.`
      : `Added ${companies(r.changed)} to ${r.listName}.`;
    return {
      data: { ...r, listId, listCreated },
      message: describe(main, r, (n) => `${wasWere(n)} already in it.`),
    };
  });
}

export async function bulkRemoveFromListAction(input: { ids: number[]; listId: number }): Promise<ActionResult<BulkResult>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const listId = parseInput(z.number().int().positive({ error: "Pick a list." }), input?.listId);
    const r = await bulkRemoveFromList(ids, listId, actorOf(user));
    done();
    return {
      data: r,
      message: describe(`Removed ${companies(r.changed)} from ${r.listName}.`, r, (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "wasn't" : "weren't"} in it.`),
    };
  });
}

export async function bulkAddTagAction(input: { ids: number[]; tagName: string }): Promise<ActionResult<BulkResult & { tagId: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const tagName = parseInput(z.string({ error: "Type a tag name." }).max(200), input?.tagName);
    const res = await bulkAddTag(ids, tagName, actorOf(user));
    if (!res.ok) throw new UserError(res.error, { tagName: [res.error] });
    done();
    const r = res.result;
    return {
      data: { ...r, tagId: r.tag.id },
      message: describe(`Tagged ${companies(r.changed)} "${r.tag.name}".`, r, (n) => `${n.toLocaleString("en-US")} already had that tag.`),
    };
  });
}

export async function bulkRemoveTagAction(input: { ids: number[]; tagId: number }): Promise<ActionResult<BulkResult>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const tagId = parseInput(z.number().int().positive({ error: "Pick a tag." }), input?.tagId);
    const r = await bulkRemoveTag(ids, tagId, actorOf(user));
    done();
    return {
      data: r,
      message: describe(`Removed the tag "${r.tagName}" from ${companies(r.changed)}.`, r, (n) => `${n.toLocaleString("en-US")} didn't have it.`),
    };
  });
}

export async function bulkDeleteAction(input: { ids: number[] }): Promise<ActionResult<BulkResult>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const ids = parseIds(input?.ids);
    const r = await bulkDelete(ids, actorOf(user));
    done();
    return {
      data: r,
      message: describe(`Deleted ${companies(r.changed)}.`, r, () => ""),
    };
  });
}

/** Ids of every company matching a Contacts URL (for "Select all that match"), capped at 10,000. */
export async function selectAllMatchingAction(input: {
  query: string;
}): Promise<ActionResult<{ ids: number[]; total: number; capped: boolean }>> {
  return runAction(async () => {
    await requireUserAction();
    const query = parseInput(z.string().max(4000), input?.query ?? "");
    const filters = parseCompanyFilters(new URLSearchParams(query.replace(/^\?/, "")));
    const res = await listMatchingCompanyIds(filters, BULK_LIMIT);
    const message = res.capped
      ? `Ticked the first ${res.ids.length.toLocaleString("en-US")} of ${companies(res.total)}. You can change up to ${BULK_LIMIT.toLocaleString("en-US")} at a time.`
      : `Ticked all ${companies(res.total)} that match.`;
    return { data: res, message };
  });
}

// ───────────────────────── lists ─────────────────────────

const listNameSchema = z.string({ error: "Give the list a name." }).max(200, { error: "Keep the list name under 80 characters." });

export async function createListAction(input: { name: string }): Promise<ActionResult<{ id: number; name: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const name = parseInput(listNameSchema, input?.name);
    const res = await createList(name, actorOf(user));
    if (!res.ok) throw new UserError(res.error, { name: [res.error] });
    done();
    return { data: res.list, message: `Created the list "${res.list.name}".` };
  });
}

export async function renameListAction(input: { id: number; name: string }): Promise<ActionResult<{ id: number; name: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const id = parseInput(z.number().int().positive(), input?.id);
    const name = parseInput(listNameSchema, input?.name);
    const res = await renameList(id, name, actorOf(user));
    if (!res.ok) throw new UserError(res.error, { name: [res.error] });
    done();
    return { data: res.list, message: `Renamed the list to "${res.list.name}".` };
  });
}

export async function deleteListAction(input: { id: number }): Promise<ActionResult<{ name: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const id = parseInput(z.number().int().positive(), input?.id);
    const res = await deleteList(id, actorOf(user));
    if (!res.ok) throw new UserError(res.error);
    done();
    return {
      data: { name: res.name },
      message: `Deleted the list "${res.name}". The companies that were in it are still in Contacts.`,
    };
  });
}

// ───────────────────────── add company ─────────────────────────

const optionalText = (max: number) => z.string().max(max, { error: `Keep this under ${max} characters.` }).optional().nullable();

const createCompanySchema = z.object({
  name: z.string({ error: "Type the company's name." }).max(300, { error: "Keep the name under 200 characters." }),
  website: optionalText(500),
  country: optionalText(100),
  niche: optionalText(200),
  priority: prioritySchema.optional(),
  status: statusSchema.optional(),
  listId: z.number().int().positive().optional().nullable(),
  person: z
    .object({ name: optionalText(300), email: optionalText(320), role: optionalText(200) })
    .optional()
    .nullable(),
  force: z.boolean().optional(),
});

type CreateCompanyOutcome = Exclude<CreateCompanyResult, { kind: "invalid" }>;

export async function createCompanyAction(input: z.input<typeof createCompanySchema>): Promise<ActionResult<CreateCompanyOutcome>> {
  return runAction<CreateCompanyOutcome>(async () => {
    const user = await requireUserAction();
    const data = parseInput(createCompanySchema, input);
    const res = await createCompany(
      {
        name: data.name,
        website: data.website,
        country: data.country,
        niche: data.niche,
        priority: data.priority,
        status: data.status,
        listId: data.listId,
        person: data.person,
      },
      actorOf(user),
      { force: data.force },
    );
    if (res.kind === "invalid") throw new UserError(res.message, res.fieldErrors);
    if (res.kind === "created") {
      done();
      return { data: res, message: `Added ${res.companyName}.` };
    }
    return { data: res };
  });
}

export async function restoreCompanyAction(input: { id: number }): Promise<ActionResult<{ id: number; name: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const id = parseInput(z.number().int().positive(), input?.id);
    const res = await restoreCompany(id, actorOf(user));
    if (!res.ok) throw new UserError(res.error);
    done();
    return { data: { id, name: res.companyName }, message: `Restored C-${id} ${res.companyName}.` };
  });
}

// ───────────────────────── Ctrl+K search ─────────────────────────

export async function searchCompaniesAction(input: { q: string }): Promise<ActionResult<QuickCompanyResult[]>> {
  return runAction(async () => {
    await requireUserAction();
    const q = parseInput(z.string().max(200), input?.q ?? "");
    return { data: await searchCompaniesQuick(q, 8) };
  });
}
