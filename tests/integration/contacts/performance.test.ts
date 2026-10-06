import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { filtersFrom, makeUser } from "./seed";

/**
 * SPEC §2: the Contacts screen must stay fast with 10,000+ companies.
 * Seeds 10,000 companies (+ ~9,000 people) and times the queries the page runs.
 */

const t = await createTestDb("contacts-perf");
const { db, dbTx } = await import("@/server/db");
const { buildSearchText, normalizeCompanyName } = await import("@/core/text");
const { lastContactAt } = await import("@/server/services/companies/filters");
const { countCompaniesByStatus, getCompanyCustomColumns, getCompanyFilterOptions, getContactsSidebar, listCompanies } = await import(
  "@/server/services/companies/query"
);

const COMPANIES = 10_000;
const LIMIT_MS = 600;
const DAY = 86_400_000;

const ADJ = ["Nordic", "Alpine", "Urban", "Tiny", "Epic", "Resin", "Pixel", "Golden", "Crystal", "Iron"];
const NOUN = ["Prints", "Models", "Figures", "Studio", "Miniatures", "Busts", "Forge", "Works", "Lab", "Crafts"];
const COUNTRIES = ["DE", "NO", "US", "GB", "SE", "DK", "NL", "AT"];
const NICHES = ["miniatures", "busts", "tabletop", "cosplay", "statues", null];
const STATUSES = ["NOT_CONTACTED", "NOT_CONTACTED", "CONTACTED", "REPLIED", "CLIENT", "NOT_INTERESTED", "DO_NOT_CONTACT"] as const;
const PRIORITIES = ["HIGH", "NORMAL", "NORMAL", "LOW"] as const;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

beforeAll(async () => {
  const ali = await makeUser("Ali", "OWNER");
  const now = Date.now();
  const list = await dbTx((tx) => tx.list.create({ data: { name: "Germany Q4" }, select: { id: true } }));
  for (let start = 0; start < COMPANIES; start += 500) {
    const rows = Array.from({ length: Math.min(500, COMPANIES - start) }, (_, k) => {
      const i = start + k;
      const name = `${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / 10) % NOUN.length]} ${i}`;
      const domain = `company${i}.example`;
      const country = COUNTRIES[i % COUNTRIES.length]!;
      const niche = NICHES[i % NICHES.length] ?? null;
      const priority = PRIORITIES[i % PRIORITIES.length]!;
      const lastEmailedAt = i % 3 === 0 ? new Date(now - (i % 90) * DAY) : null;
      const importedLastContactAt = i % 7 === 0 ? new Date(now - 200 * DAY) : null;
      return {
        name,
        nameNorm: normalizeCompanyName(name),
        website: `https://${domain}`,
        domain,
        country,
        niche,
        priority,
        priorityRank: priority === "HIGH" ? 1 : priority === "LOW" ? 3 : 2,
        status: STATUSES[i % STATUSES.length]!,
        lastEmailedAt,
        lastEmailedById: i % 3 === 0 ? ali.id : null,
        importedLastContactAt,
        lastContactAt: lastContactAt(lastEmailedAt, importedLastContactAt),
        searchText: buildSearchText([name, domain, country, niche, i % 10 < 6 ? `person ${i} person${i}@${domain}` : null]),
        customFields: i % 4 === 0 ? { members: String(i * 3) } : undefined,
      };
    });
    await dbTx((tx) => tx.company.createMany({ data: rows }));
  }
  const all = await db.company.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const people: Array<{ companyId: number; name: string; email: string; emailNorm: string }> = [];
  all.forEach((c, i) => {
    if (i % 10 < 6) people.push({ companyId: c.id, name: `Person ${i}`, email: `person${i}@company${i}.example`, emailNorm: `person${i}@company${i}.example` });
    if (i % 10 < 3) people.push({ companyId: c.id, name: `Info ${i}`, email: `info@company${i}.example`, emailNorm: `info@company${i}.example` });
  });
  for (let s = 0; s < people.length; s += 500) {
    const part = people.slice(s, s + 500);
    await dbTx((tx) => tx.person.createMany({ data: part }));
  }
  const members = all.filter((_, i) => i % 5 === 0).map((c) => ({ companyId: c.id, listId: list.id }));
  for (let s = 0; s < members.length; s += 500) {
    const part = members.slice(s, s + 500);
    await dbTx((tx) => tx.companyList.createMany({ data: part }));
  }
  // Warm up the connection and query engine (the real app is always warm).
  await db.company.findFirst({ select: { id: true } });
  await db.person.findFirst({ select: { id: true } });
}, 240_000);

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe(`Contacts with ${COMPANIES.toLocaleString("en-US")} companies`, () => {
  it(`page 1, default sort, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(async () => listCompanies(await filtersFrom("")));
    expect(value.total).toBe(COMPANIES);
    expect(value.rows).toHaveLength(50);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`page 1 sorted by last emailed, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(async () => listCompanies(await filtersFrom("sort=lastEmailed&dir=desc&size=200")));
    expect(value.rows).toHaveLength(200);
    expect(value.rows[0]!.lastEmailedAt).not.toBeNull();
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`page 1 sorted by niche and by number of people, in under ${LIMIT_MS} ms each`, async () => {
    const niche = await timed(async () => listCompanies(await filtersFrom("sort=niche&size=200")));
    expect(niche.value.rows[0]!.niche).toBe("busts");
    expect(niche.ms).toBeLessThan(LIMIT_MS);
    const people = await timed(async () => listCompanies(await filtersFrom("sort=people&dir=desc&size=200")));
    expect(people.value.rows[0]!.peopleCount).toBe(2);
    expect(people.ms).toBeLessThan(LIMIT_MS);
  });

  it(`a search, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(async () => listCompanies(await filtersFrom("q=nordic prints")));
    expect(value.total).toBeGreaterThan(0);
    expect(value.rows.every((r) => r.name.startsWith("Nordic Prints"))).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`a deep page of the missing-email view, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(async () => listCompanies(await filtersFrom("view=missing-email&page=20")));
    expect(value.total).toBe(4_000);
    expect(value.rows.every((r) => r.emailCount === 0)).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`status tab counts, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(async () => countCompaniesByStatus(await filtersFrom("country=DE,NO&emailed=yes")));
    expect(value.all).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LIMIT_MS);
    const everything = await timed(async () => countCompaniesByStatus(await filtersFrom("")));
    expect(everything.value.all).toBe(COMPANIES);
    expect(everything.ms).toBeLessThan(LIMIT_MS);
  });

  it(`sidebar counts, in under ${LIMIT_MS} ms`, async () => {
    const { ms, value } = await timed(() => getContactsSidebar());
    expect(value.allCount).toBe(COMPANIES);
    expect(value.lists[0]!.count).toBe(COMPANIES / 5);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`filter choices and custom columns, in under ${LIMIT_MS} ms`, async () => {
    await dbTx((tx) =>
      tx.customField.createMany({
        data: [
          { key: "members", label: "Members", entity: "COMPANY" },
          { key: "revenue", label: "Est. revenue", entity: "COMPANY" },
        ],
      }),
    );
    const options = await timed(() => getCompanyFilterOptions());
    expect(options.value.countries).toHaveLength(COUNTRIES.length);
    expect(options.ms).toBeLessThan(LIMIT_MS);
    const custom = await timed(() => getCompanyCustomColumns());
    expect(custom.value).toEqual([{ key: "members", label: "Members" }]);
    expect(custom.ms).toBeLessThan(LIMIT_MS);
  });
});
