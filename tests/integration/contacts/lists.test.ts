import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser } from "./seed";

const t = await createTestDb("contacts-lists");
const { db } = await import("@/server/db");
const lists = await import("@/server/services/lists");
const tags = await import("@/server/services/tags");

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", "OWNER");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("lists", () => {
  it("creates a list with a tidy name and logs it", async () => {
    const res = await lists.createList("  Germany   Q4 ", ali);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.list.name).toBe("Germany Q4");
    const log = await db.activityLog.findFirst({ where: { type: "list.created" } });
    expect(log?.actorId).toBe(ali.id);
    expect(log?.summary).toBe('Ali created the list "Germany Q4"');
  });

  it("refuses a name that's taken (ignoring case) or empty, in plain words", async () => {
    expect(await lists.createList("germany q4", ali)).toEqual({
      ok: false,
      error: 'There\'s already a list called "Germany Q4". Pick another name.',
    });
    expect(await lists.createList("   ", ali)).toEqual({ ok: false, error: "Give the list a name." });
    const long = await lists.createList("x".repeat(81), ali);
    expect(long.ok).toBe(false);
  });

  it("renames, but not onto another list's name", async () => {
    const a = await lists.createList("Norway", ali);
    const b = await lists.createList("Sweden", ali);
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const renamed = await lists.renameList(a.list.id, "Norway autumn", ali);
    expect(renamed).toEqual({ ok: true, list: { id: a.list.id, name: "Norway autumn" } });
    const clash = await lists.renameList(b.list.id, "NORWAY AUTUMN", ali);
    expect(clash.ok).toBe(false);
    const caseOnly = await lists.renameList(b.list.id, "sweden", ali);
    expect(caseOnly).toEqual({ ok: true, list: { id: b.list.id, name: "sweden" } });
    const missing = await lists.renameList(987_654, "Nope", ali);
    expect(missing.ok).toBe(false);
    const log = await db.activityLog.findFirst({ where: { type: "list.renamed" }, orderBy: { id: "asc" } });
    expect(log?.summary).toBe('Ali renamed the list "Norway" to "Norway autumn"');
  });

  it("adds and removes companies and counts only live ones", async () => {
    const res = await lists.createList("Resin people", ali);
    if (!res.ok) throw new Error("setup failed");
    const listId = res.list.id;
    const a = await makeCompany({ name: "Alpha" });
    const b = await makeCompany({ name: "Beta" });
    const c = await makeCompany({ name: "Gamma", deletedAt: new Date() });
    const added = await lists.addCompaniesToList([a, b, c], listId, ali);
    expect(added).toMatchObject({ changed: 2, missing: 1 });
    let counts = await lists.listListsWithCounts();
    expect(counts.find((l) => l.id === listId)?.count).toBe(2);
    await lists.removeCompaniesFromList([a], listId, ali);
    counts = await lists.listListsWithCounts();
    expect(counts.find((l) => l.id === listId)?.count).toBe(1);
    expect(counts.map((l) => l.name)).toEqual([...counts.map((l) => l.name)].sort((x, y) => x.localeCompare(y, "en", { sensitivity: "base" })));
  });

  it("deleting a list removes only its memberships; the companies stay", async () => {
    const res = await lists.createList("To delete", ali);
    if (!res.ok) throw new Error("setup failed");
    const a = await makeCompany({ name: "Stays Around" });
    await lists.addCompaniesToList([a], res.list.id, ali);
    const del = await lists.deleteList(res.list.id, ali);
    expect(del).toEqual({ ok: true, name: "To delete", removed: 1 });
    expect(await db.list.count({ where: { id: res.list.id } })).toBe(0);
    expect(await db.companyList.count({ where: { listId: res.list.id } })).toBe(0);
    const company = await db.company.findUnique({ where: { id: a } });
    expect(company?.deletedAt).toBeNull();
    const again = await lists.deleteList(res.list.id, ali);
    expect(again.ok).toBe(false);
    const log = await db.activityLog.findFirst({ where: { type: "list.deleted" } });
    expect(log?.actorId).toBe(ali.id);
  });

  it("name checks", () => {
    expect(lists.cleanListName("  a   b ")).toBe("a b");
    expect(lists.listNameProblem("")).toBe("Give the list a name.");
    expect(lists.listNameProblem("ok")).toBeNull();
  });
});

describe("tags", () => {
  it("finds or creates a tag by trimmed name, ignoring case", async () => {
    const first = await tags.findOrCreateTag("  Resin ");
    expect(first).toMatchObject({ ok: true, created: true, tag: { name: "Resin" } });
    const second = await tags.findOrCreateTag("resin");
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) expect(second.tag.id).toBe(first.tag.id);
    expect((await tags.findTagByName("RESIN"))?.name).toBe("Resin");
    expect(await tags.findTagByName("nothing")).toBeNull();
  });

  it("explains bad tag names", async () => {
    expect(await tags.findOrCreateTag("")).toEqual({ ok: false, error: "Type a tag name." });
    expect(tags.tagNameProblem("x".repeat(51))).toMatch(/under 50/);
    expect(tags.tagNameProblem("a,b")).toMatch(/comma/);
  });

  it("counts companies per tag, skipping deleted ones", async () => {
    const tag = await tags.findOrCreateTag("Busts");
    if (!tag.ok) throw new Error("setup failed");
    await makeCompany({ name: "Live bust co", tagIds: [tag.tag.id] });
    await makeCompany({ name: "Gone bust co", tagIds: [tag.tag.id], deletedAt: new Date() });
    const all = await tags.listTagsWithCounts();
    expect(all.find((x) => x.name === "Busts")?.count).toBe(1);
  });
});
