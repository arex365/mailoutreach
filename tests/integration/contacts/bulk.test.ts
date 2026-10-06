import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { filtersFrom, makeCompany, makeList, makeUser } from "./seed";

const t = await createTestDb("contacts-bulk");
const { db, dbWrite } = await import("@/server/db");
const bulk = await import("@/server/services/companies/bulk");
const { listCompanies, getContactsSidebar } = await import("@/server/services/companies/query");

let ali: { id: number; name: string };
const ids: number[] = [];

async function activity(type: string, companyIds: number[]) {
  return db.activityLog.findMany({
    where: { type, companyId: { in: companyIds } },
    orderBy: { id: "asc" },
  });
}

beforeAll(async () => {
  ali = await makeUser("Ali", "OWNER");
  for (const name of ["Alpha Prints", "Beta Models", "Gamma Studio", "Delta Figures"]) {
    ids.push(await makeCompany({ name, country: "DE" }));
  }
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("id handling", () => {
  it("dedupes, drops junk and splits into chunks", () => {
    expect(bulk.cleanIds([3, 1, 3, -2, 0, 1.5, Number.NaN, 7])).toEqual([3, 1, 7]);
    expect(bulk.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(bulk.chunk([], 500)).toEqual([]);
  });

  it("refuses more than 10,000 ids with a plain message", () => {
    const tooMany = Array.from({ length: bulk.BULK_LIMIT + 1 }, (_, i) => i + 1);
    expect(() => bulk.cleanIds(tooMany)).toThrow(/up to 10,000 companies at a time/);
  });
});

describe("status and priority", () => {
  it("sets status, skips unchanged and deleted companies, and logs who did it", async () => {
    const [a, b, c] = ids;
    await dbWrite((cl) => cl.company.update({ where: { id: c! }, data: { status: "CLIENT" } }));
    const r = await bulk.bulkSetStatus([a!, b!, c!, 999_999], "CLIENT", ali);
    expect(r).toEqual({ requested: 4, changed: 2, unchanged: 1, missing: 1 });
    const rows = await db.company.findMany({ where: { id: { in: [a!, b!, c!] } }, select: { status: true } });
    expect(rows.every((x) => x.status === "CLIENT")).toBe(true);
    const logs = await activity("company.status", [a!, b!, c!]);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.actorId).toBe(ali.id);
    expect(logs[0]!.summary).toBe("Ali set status to Client");
    expect(logs[0]!.data).toMatchObject({ from: "NOT_CONTACTED", to: "CLIENT" });
  });

  it("sets priority and its sort rank", async () => {
    const r = await bulk.bulkSetPriority(ids, "HIGH", ali);
    expect(r.changed).toBe(4);
    const rows = await db.company.findMany({ where: { id: { in: ids } }, select: { priority: true, priorityRank: true } });
    expect(rows.every((x) => x.priority === "HIGH" && x.priorityRank === 1)).toBe(true);
    const logs = await activity("company.priority", ids);
    expect(logs).toHaveLength(4);
    expect(logs.every((l) => l.actorId === ali.id && l.summary === "Ali set priority to High")).toBe(true);
    const again = await bulk.bulkSetPriority(ids, "HIGH", ali);
    expect(again).toMatchObject({ changed: 0, unchanged: 4 });
  });
});

describe("lists and tags", () => {
  it("adds to a list once, then removes", async () => {
    const list = await makeList("Germany Q4");
    const first = await bulk.bulkAddToList(ids.slice(0, 2), list, ali);
    expect(first).toMatchObject({ changed: 2, unchanged: 0, listName: "Germany Q4" });
    const second = await bulk.bulkAddToList(ids, list, ali);
    expect(second).toMatchObject({ changed: 2, unchanged: 2 });
    expect(await db.companyList.count({ where: { listId: list } })).toBe(4);
    const added = await activity("company.lists", ids);
    expect(added).toHaveLength(4);
    expect(added[0]!.summary).toBe('Ali added this company to the list "Germany Q4"');

    const removed = await bulk.bulkRemoveFromList([ids[0]!], list, ali);
    expect(removed).toMatchObject({ changed: 1, listName: "Germany Q4" });
    expect(await db.companyList.count({ where: { listId: list } })).toBe(3);
    const noop = await bulk.bulkRemoveFromList([ids[0]!], list, ali);
    expect(noop).toMatchObject({ changed: 0, unchanged: 1 });
  });

  it("refuses a list or tag that doesn't exist, and says what to do", async () => {
    await expect(bulk.bulkAddToList(ids, 424242, ali)).rejects.toThrow(/doesn't exist any more.*Refresh the page/);
    await expect(bulk.bulkRemoveFromList(ids, 424242, ali)).rejects.toThrow(/Refresh the page to see the current lists/);
    await expect(bulk.bulkRemoveTag(ids, 424242, ali)).rejects.toThrow(/Refresh the page to see the current tags/);
  });

  it("creates a tag when needed, matches it ignoring case, and removes it", async () => {
    const res = await bulk.bulkAddTag(ids.slice(0, 3), "  Trade   Fair ", ali);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({ changed: 3, tagCreated: true });
    expect(res.result.tag.name).toBe("Trade Fair");
    const again = await bulk.bulkAddTag(ids, "trade fair", ali);
    expect(again.ok && again.result).toMatchObject({ changed: 1, unchanged: 3, tagCreated: false });
    expect(await db.tag.count()).toBe(1);
    const tagId = res.result.tag.id;
    expect(await db.companyTag.count({ where: { tagId } })).toBe(4);
    const logs = await activity("company.tags", ids);
    expect(logs[0]!.summary).toBe('Ali added the tag "Trade Fair"');

    const removed = await bulk.bulkRemoveTag(ids.slice(0, 2), tagId, ali);
    expect(removed).toMatchObject({ changed: 2, tagName: "Trade Fair" });
    expect(await db.companyTag.count({ where: { tagId } })).toBe(2);
    expect(await db.tag.count({ where: { id: tagId } })).toBe(1);
  });

  it("rejects empty or comma tags in plain words", async () => {
    const empty = await bulk.bulkAddTag(ids, "   ", ali);
    expect(empty).toEqual({ ok: false, error: "Type a tag name." });
    const comma = await bulk.bulkAddTag(ids, "a, b", ali);
    expect(comma.ok).toBe(false);
  });
});

describe("delete", () => {
  it("soft-deletes: hidden everywhere, history and people kept", async () => {
    const victim = await makeCompany({ name: "Victim Ltd", people: [{ name: "Vic", email: "vic@victim.co.uk" }] });
    const list = await makeList("Victims");
    await bulk.bulkAddToList([victim], list, ali);
    const before = (await getContactsSidebar()).allCount;

    const r = await bulk.bulkDelete([victim, 555_555], ali);
    expect(r).toMatchObject({ changed: 1, missing: 1 });

    const row = await db.company.findUnique({ where: { id: victim } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await db.person.count({ where: { companyId: victim } })).toBe(1);
    const listed = await listCompanies(await filtersFrom(""));
    expect(listed.rows.some((x) => x.id === victim)).toBe(false);
    const inList = await listCompanies(await filtersFrom(`list=${list}`));
    expect(inList.total).toBe(0);
    const sidebar = await getContactsSidebar();
    expect(sidebar.allCount).toBe(before - 1);
    expect(sidebar.lists.find((l) => l.id === list)?.count).toBe(0);

    const logs = await activity("company.deleted", [victim]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorId).toBe(ali.id);
    expect(logs[0]!.summary).toBe("Ali deleted this company");

    const again = await bulk.bulkDelete([victim], ali);
    expect(again).toMatchObject({ changed: 0, missing: 1 });
  });
});

describe("big selections", () => {
  it("writes more than 500 companies in chunks and logs each one", async () => {
    const { dbTx } = await import("@/server/db");
    const created = await dbTx(async (tx) => {
      await tx.company.createMany({
        data: Array.from({ length: 1_203 }, (_, i) => ({ name: `Chunk ${i}`, nameNorm: `chunk ${i}` })),
      });
      return tx.company.findMany({ where: { nameNorm: { startsWith: "chunk " } }, select: { id: true } });
    });
    const chunkIds = created.map((c) => c.id);
    const r = await bulk.bulkSetStatus(chunkIds, "NOT_INTERESTED", ali);
    expect(r.changed).toBe(1_203);
    // (Checked without a 1,203-id IN list: SQLite limits the number of query parameters.)
    expect(await db.company.count({ where: { nameNorm: { startsWith: "chunk " }, status: "NOT_INTERESTED" } })).toBe(1_203);
    expect(
      await db.activityLog.count({
        where: { type: "company.status", actorId: ali.id, companyId: { gte: Math.min(...chunkIds), lte: Math.max(...chunkIds) } },
      }),
    ).toBe(1_203);
  });
});
