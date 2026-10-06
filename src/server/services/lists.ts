import { Prisma } from "@/generated/prisma/client";
import { normalizeText } from "@/core/text";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx } from "@/server/db";
import { LIST_GONE, type Actor } from "./companies/bulk";

export { bulkAddToList as addCompaniesToList, bulkRemoveFromList as removeCompaniesFromList } from "./companies/bulk";

/**
 * Lists replace the old tool's tabs (SPEC §2). A company can be in several lists.
 * Deleting a list only removes the memberships: the companies stay in Contacts.
 */

export const LIST_NAME_MAX = 80;

export type ListResult = { ok: true; list: { id: number; name: string } } | { ok: false; error: string };

export function cleanListName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function listNameProblem(name: string): string | null {
  const clean = cleanListName(name);
  if (!clean) return "Give the list a name.";
  if (clean.length > LIST_NAME_MAX) return `Keep the list name under ${LIST_NAME_MAX} characters.`;
  return null;
}

function takenMessage(name: string): string {
  return `There's already a list called "${name}". Pick another name.`;
}

/** A list with the same name, ignoring upper/lower case and extra spaces. */
async function findListByName(name: string, client: DbOrTx, exceptId?: number) {
  const key = normalizeText(cleanListName(name));
  const lists = await client.list.findMany({ select: { id: true, name: true } });
  return lists.find((l) => l.id !== exceptId && normalizeText(l.name) === key) ?? null;
}

export async function createList(name: string, actor: Actor): Promise<ListResult> {
  const problem = listNameProblem(name);
  if (problem) return { ok: false, error: problem };
  const clean = cleanListName(name);
  try {
    return await dbTx(async (tx) => {
      const taken = await findListByName(clean, tx);
      if (taken) return { ok: false as const, error: takenMessage(taken.name) };
      const list = await tx.list.create({ data: { name: clean, createdById: actor.id }, select: { id: true, name: true } });
      await logActivity(
        { actorId: actor.id, type: "list.created", summary: `${actor.name} created the list "${list.name}"`, data: { listId: list.id } },
        tx,
      );
      return { ok: true as const, list };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: takenMessage(clean) };
    }
    throw err;
  }
}

export async function renameList(id: number, name: string, actor: Actor): Promise<ListResult> {
  const problem = listNameProblem(name);
  if (problem) return { ok: false, error: problem };
  const clean = cleanListName(name);
  try {
    return await dbTx(async (tx) => {
      const list = await tx.list.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!list) return { ok: false as const, error: LIST_GONE };
      if (list.name === clean) return { ok: true as const, list };
      const taken = await findListByName(clean, tx, id);
      if (taken) return { ok: false as const, error: takenMessage(taken.name) };
      const updated = await tx.list.update({ where: { id }, data: { name: clean }, select: { id: true, name: true } });
      await logActivity(
        {
          actorId: actor.id,
          type: "list.renamed",
          summary: `${actor.name} renamed the list "${list.name}" to "${updated.name}"`,
          data: { listId: id, from: list.name, to: updated.name },
        },
        tx,
      );
      return { ok: true as const, list: updated };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: takenMessage(clean) };
    }
    throw err;
  }
}

/** Deletes a list and its memberships. The companies themselves are not touched. */
export async function deleteList(
  id: number,
  actor: Actor,
): Promise<{ ok: true; name: string; removed: number } | { ok: false; error: string }> {
  return dbTx(async (tx) => {
    const list = await tx.list.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!list) return { ok: false as const, error: LIST_GONE };
    const removed = await tx.companyList.deleteMany({ where: { listId: id } });
    await tx.list.delete({ where: { id } });
    await logActivity(
      {
        actorId: actor.id,
        type: "list.deleted",
        summary: `${actor.name} deleted the list "${list.name}" (the ${removed.count === 1 ? "company in it stays" : "companies in it stay"} in Contacts)`,
        data: { listId: id, name: list.name, memberships: removed.count },
      },
      tx,
    );
    return { ok: true as const, name: list.name, removed: removed.count };
  });
}

/** Every list with the number of (non-deleted) companies in it, sorted by name. */
export async function listListsWithCounts(): Promise<Array<{ id: number; name: string; count: number }>> {
  const lists = await db.list.findMany({
    select: {
      id: true,
      name: true,
      _count: { select: { companies: { where: { company: { deletedAt: null } } } } },
    },
  });
  return lists
    .map((l) => ({ id: l.id, name: l.name, count: l._count.companies }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export async function getList(id: number): Promise<{ id: number; name: string } | null> {
  return db.list.findUnique({ where: { id }, select: { id: true, name: true } });
}
