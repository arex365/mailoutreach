import { Prisma } from "@/generated/prisma/client";
import { normalizeText } from "@/core/text";
import { db, dbTx, type DbOrTx } from "@/server/db";

/**
 * Tags: short labels on companies ("trade fair", "resin"). A tag name is matched
 * after trimming, ignoring upper/lower case, so "Resin" and "resin " are the same tag.
 */

export const TAG_NAME_MAX = 50;

export type TagResult =
  | { ok: true; tag: { id: number; name: string }; created: boolean }
  | { ok: false; error: string };

/** Trims and collapses spaces. */
export function cleanTagName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function tagNameProblem(name: string): string | null {
  const clean = cleanTagName(name);
  if (!clean) return "Type a tag name.";
  if (clean.length > TAG_NAME_MAX) return `Keep the tag under ${TAG_NAME_MAX} characters.`;
  if (clean.includes(",")) return "A tag can't contain a comma. Add one tag at a time.";
  return null;
}

/** Finds a tag by name, ignoring case and extra spaces. */
export async function findTagByName(name: string, client: DbOrTx = db): Promise<{ id: number; name: string } | null> {
  const clean = cleanTagName(name);
  if (!clean) return null;
  const exact = await client.tag.findUnique({ where: { name: clean }, select: { id: true, name: true } });
  if (exact) return exact;
  // Tag lists are short (tens to a few hundred), so a case-insensitive scan is cheap.
  const key = normalizeText(clean);
  const all = await client.tag.findMany({ select: { id: true, name: true } });
  return all.find((t) => normalizeText(t.name) === key) ?? null;
}

/** Returns the existing tag with that name, or creates it. */
export async function findOrCreateTag(name: string): Promise<TagResult> {
  const problem = tagNameProblem(name);
  if (problem) return { ok: false, error: problem };
  const clean = cleanTagName(name);
  try {
    return await dbTx(async (tx) => {
      const existing = await findTagByName(clean, tx);
      if (existing) return { ok: true as const, tag: existing, created: false };
      const tag = await tx.tag.create({ data: { name: clean }, select: { id: true, name: true } });
      return { ok: true as const, tag, created: true };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findTagByName(clean);
      if (existing) return { ok: true, tag: existing, created: false };
    }
    throw err;
  }
}

/** Every tag with the number of (non-deleted) companies that have it. */
export async function listTagsWithCounts(): Promise<Array<{ id: number; name: string; count: number }>> {
  const tags = await db.tag.findMany({
    select: {
      id: true,
      name: true,
      _count: { select: { companies: { where: { company: { deletedAt: null } } } } },
    },
  });
  return tags
    .map((t) => ({ id: t.id, name: t.name, count: t._count.companies }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export async function getTag(id: number): Promise<{ id: number; name: string } | null> {
  return db.tag.findUnique({ where: { id }, select: { id: true, name: true } });
}
