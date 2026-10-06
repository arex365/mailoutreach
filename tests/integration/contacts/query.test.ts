import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { filtersFrom, makeCompany, makeList, makeTag, makeUser } from "./seed";

const t = await createTestDb("contacts-query");
const { db, dbWrite } = await import("@/server/db");
const {
  countCompaniesByStatus,
  getCompanyCustomColumns,
  getCompanyFilterOptions,
  getContactsSidebar,
  listCompanies,
  listMatchingCompanyIds,
  searchCompaniesQuick,
} = await import("@/server/services/companies/query");

const DAY = 86_400_000;
const now = Date.now();
const ids: Record<string, number> = {};
let ali: { id: number; name: string };
let sara: { id: number; name: string };
let germanyList: number;

async function names(query: string): Promise<string[]> {
  const res = await listCompanies(await filtersFrom(query));
  return res.rows.map((r) => r.name);
}

beforeAll(async () => {
  ali = await makeUser("Ali", "OWNER");
  sara = await makeUser("Sara");
  germanyList = await makeList("Germany Q4");
  const tradeFair = await makeTag("trade fair");
  const resin = await makeTag("resin");

  ids.A = await makeCompany({
    name: "Acme 3D GmbH",
    website: "https://www.acme3d.de",
    country: "DE",
    niche: "miniatures",
    priority: "HIGH",
    status: "CONTACTED",
    lastEmailedAt: new Date(now - 12 * DAY),
    lastEmailedById: ali.id,
    firstContactedById: ali.id,
    createdAt: new Date(now - 50 * DAY),
    customFields: { members: "1200" },
    people: [
      { name: "Anna Schmidt", email: "anna@acme3d.de" },
      { name: "General inbox", email: "info@acme3d.de" },
    ],
    listIds: [germanyList],
    tagIds: [tradeFair],
  });
  ids.B = await makeCompany({
    name: "Nordic Prints AS",
    website: "nordicprints.no",
    country: "NO",
    niche: "busts",
    priority: "LOW",
    importedLastContactAt: new Date(now - 40 * DAY),
    createdAt: new Date(now - 40 * DAY),
    people: [{ name: "Ola Nordmann" }],
  });
  ids.C = await makeCompany({
    name: "Müller Figuren",
    country: "DE",
    niche: "miniatures",
    status: "CLIENT",
    createdAt: new Date(now - 30 * DAY),
    tagIds: [resin],
  });
  ids.D = await makeCompany({
    name: "Zeta Studio",
    website: "instagram.com/zeta_studio",
    country: "US",
    status: "REPLIED",
    lastEmailedAt: new Date(now - 2 * DAY),
    lastEmailedById: sara.id,
    firstContactedById: sara.id,
    createdAt: new Date(now - 20 * DAY),
    people: [{ name: "Zed", email: "zeta@gmail.com" }],
    listIds: [germanyList],
  });
  ids.E = await makeCompany({
    name: "Deleted Co",
    country: "FR",
    niche: "deleted niche",
    deletedAt: new Date(now - DAY),
    createdAt: new Date(now - 10 * DAY),
    people: [{ name: "Xavier", email: "x@deleted.fr" }],
    listIds: [germanyList],
    tagIds: [tradeFair],
  });
  ids.F = await makeCompany({
    name: "Omega Minis",
    country: "DE",
    niche: "miniatures",
    priority: "HIGH",
    status: "DO_NOT_CONTACT",
    createdAt: new Date(now - 5 * DAY),
    customFields: { members: "" },
    people: [{ name: "Bob", email: "bob@omega.de", deletedAt: new Date(now - DAY) }],
  });
  await dbWrite((c) =>
    c.customField.createMany({
      data: [
        { key: "members", label: "Members", entity: "COMPANY" },
        { key: "revenue", label: "Est. revenue", entity: "COMPANY" },
        { key: "linkedin", label: "LinkedIn", entity: "PERSON" },
      ],
    }),
  );
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("listCompanies", () => {
  it("shows every live company, sorted by name, never the deleted one", async () => {
    const res = await listCompanies(await filtersFrom(""), ali);
    expect(res.total).toBe(5);
    expect(res.page).toBe(1);
    expect(res.pageCount).toBe(1);
    expect(res.rows.map((r) => r.name)).toEqual(["Acme 3D GmbH", "Müller Figuren", "Nordic Prints AS", "Omega Minis", "Zeta Studio"]);
  });

  it("summarises people, tags, sender and custom fields per row", async () => {
    const res = await listCompanies(await filtersFrom(""), ali);
    const byName = new Map(res.rows.map((r) => [r.name, r]));
    const a = byName.get("Acme 3D GmbH")!;
    expect(a.peopleCount).toBe(2);
    expect(a.emailCount).toBe(2);
    expect(a.tags.map((tg) => tg.name)).toEqual(["trade fair"]);
    expect(a.lastEmailedByName).toBe("Ali");
    expect(a.lastEmailedByViewer).toBe(true);
    expect(a.customFields).toEqual({ members: "1200" });
    expect(a.domain).toBe("acme3d.de");
    const b = byName.get("Nordic Prints AS")!;
    expect([b.peopleCount, b.emailCount]).toEqual([1, 0]);
    expect(b.importedLastContactAt).toBeInstanceOf(Date);
    const d = byName.get("Zeta Studio")!;
    expect(d.lastEmailedByName).toBe("Sara");
    expect(d.lastEmailedByViewer).toBe(false);
    expect(d.profileKey).toBe("instagram.com/zeta_studio");
    const f = byName.get("Omega Minis")!;
    expect([f.peopleCount, f.emailCount]).toEqual([0, 0]); // the only person was deleted
    expect(f.customFields).toEqual({});
  });

  it("clamps a page number past the end to the last page", async () => {
    const res = await listCompanies(await filtersFrom("page=9"));
    expect(res.page).toBe(1);
    expect(res.rows).toHaveLength(5);
  });
});

describe("filters", () => {
  it("search looks through names, websites, profiles, people and emails", async () => {
    expect(await names("q=anna")).toEqual(["Acme 3D GmbH"]);
    expect(await names("q=acme3d.de")).toEqual(["Acme 3D GmbH"]);
    expect(await names("q=muller")).toEqual(["Müller Figuren"]);
    expect(await names("q=zeta_studio")).toEqual(["Zeta Studio"]);
    expect(await names("q=ola nordmann")).toEqual(["Nordic Prints AS"]);
    expect(await names("q=xavier")).toEqual([]); // deleted company
  });

  it("missing-email view and has-email filter", async () => {
    expect(await names("view=missing-email")).toEqual(["Müller Figuren", "Nordic Prints AS", "Omega Minis"]);
    expect(await names("hasEmail=no")).toEqual(["Müller Figuren", "Nordic Prints AS", "Omega Minis"]);
    expect(await names("hasEmail=yes")).toEqual(["Acme 3D GmbH", "Zeta Studio"]);
  });

  it("list, status and tag", async () => {
    expect(await names(`list=${germanyList}`)).toEqual(["Acme 3D GmbH", "Zeta Studio"]);
    expect(await names("status=CLIENT")).toEqual(["Müller Figuren"]);
    const tags = await db.tag.findMany({ orderBy: { name: "asc" } });
    const resin = tags.find((tg) => tg.name === "resin")!.id;
    const tradeFair = tags.find((tg) => tg.name === "trade fair")!.id;
    expect(await names(`tag=${tradeFair}`)).toEqual(["Acme 3D GmbH"]);
    expect(await names(`tag=${tradeFair},${resin}`)).toEqual(["Acme 3D GmbH", "Müller Figuren"]);
  });

  it("country, niche and priority (several values each)", async () => {
    expect(await names("country=DE")).toEqual(["Acme 3D GmbH", "Müller Figuren", "Omega Minis"]);
    expect(await names("country=de,no")).toEqual(["Acme 3D GmbH", "Müller Figuren", "Nordic Prints AS", "Omega Minis"]);
    expect(await names("niche=miniatures")).toEqual(["Acme 3D GmbH", "Müller Figuren", "Omega Minis"]);
    expect(await names("priority=HIGH")).toEqual(["Acme 3D GmbH", "Omega Minis"]);
    expect(await names("priority=HIGH,LOW")).toEqual(["Acme 3D GmbH", "Nordic Prints AS", "Omega Minis"]);
  });

  it("emailed / never emailed (old-tool dates count) and first contacted by", async () => {
    expect(await names("emailed=yes")).toEqual(["Acme 3D GmbH", "Nordic Prints AS", "Zeta Studio"]);
    expect(await names("emailed=no")).toEqual(["Müller Figuren", "Omega Minis"]);
    expect(await names(`by=${ali.id}`)).toEqual(["Acme 3D GmbH"]);
    expect(await names(`by=${sara.id}`)).toEqual(["Zeta Studio"]);
  });

  it("combines filters", async () => {
    expect(await names("country=DE&niche=miniatures&priority=HIGH")).toEqual(["Acme 3D GmbH", "Omega Minis"]);
    expect(await names("country=DE&status=CLIENT&q=figuren")).toEqual(["Müller Figuren"]);
  });
});

describe("sorting", () => {
  it("last emailed counts old-tool dates too: newest first, never-contacted last", async () => {
    // Zeta 2 days (app), Acme 12 days (app), Nordic 40 days (old tool only), then the never-contacted.
    expect(await names("sort=lastEmailed&dir=desc")).toEqual(["Zeta Studio", "Acme 3D GmbH", "Nordic Prints AS", "Müller Figuren", "Omega Minis"]);
    expect(await names("sort=lastEmailed")).toEqual(["Nordic Prints AS", "Acme 3D GmbH", "Zeta Studio", "Müller Figuren", "Omega Minis"]);
  });

  it("niche (empty last in both directions) and number of people", async () => {
    expect(await names("sort=niche")).toEqual(["Nordic Prints AS", "Acme 3D GmbH", "Müller Figuren", "Omega Minis", "Zeta Studio"]);
    expect(await names("sort=niche&dir=desc")).toEqual(["Acme 3D GmbH", "Müller Figuren", "Omega Minis", "Nordic Prints AS", "Zeta Studio"]);
    // Acme has 2 people, Müller none; ties go by name. (Omega's removed person still counts for sorting.)
    expect(await names("sort=people&dir=desc")).toEqual(["Acme 3D GmbH", "Nordic Prints AS", "Omega Minis", "Zeta Studio", "Müller Figuren"]);
    expect(await names("sort=people")).toEqual(["Müller Figuren", "Nordic Prints AS", "Omega Minis", "Zeta Studio", "Acme 3D GmbH"]);
  });

  it("status is not a sort (the status tabs do that): an old link falls back to name order", async () => {
    expect(await names("sort=status")).toEqual(await names(""));
  });

  it("priority, country, created and name descending", async () => {
    expect(await names("sort=priority")).toEqual(["Acme 3D GmbH", "Omega Minis", "Müller Figuren", "Zeta Studio", "Nordic Prints AS"]);
    expect(await names("sort=country")).toEqual(["Acme 3D GmbH", "Müller Figuren", "Omega Minis", "Nordic Prints AS", "Zeta Studio"]);
    expect(await names("sort=created&dir=desc")).toEqual(["Omega Minis", "Zeta Studio", "Müller Figuren", "Nordic Prints AS", "Acme 3D GmbH"]);
    expect(await names("dir=desc")).toEqual(["Zeta Studio", "Omega Minis", "Nordic Prints AS", "Müller Figuren", "Acme 3D GmbH"]);
  });
});

describe("tab counts, sidebar and filter choices", () => {
  it("counts each status tab with every other filter applied", async () => {
    const all = await countCompaniesByStatus(await filtersFrom(""));
    expect(all.all).toBe(5);
    expect(all.byStatus).toEqual({
      NOT_CONTACTED: 1,
      CONTACTED: 1,
      REPLIED: 1,
      CLIENT: 1,
      NOT_INTERESTED: 0,
      DO_NOT_CONTACT: 1,
    });
    // The status filter itself is ignored, so the tabs stay useful.
    const de = await countCompaniesByStatus(await filtersFrom("country=DE&status=CLIENT"));
    expect(de.all).toBe(3);
    expect(de.byStatus.CLIENT).toBe(1);
    expect(de.byStatus.CONTACTED).toBe(1);
    expect(de.byStatus.DO_NOT_CONTACT).toBe(1);
    expect(de.byStatus.REPLIED).toBe(0);
  });

  it("sidebar counts skip deleted companies", async () => {
    const s = await getContactsSidebar();
    expect(s.allCount).toBe(5);
    expect(s.missingEmailCount).toBe(3);
    expect(s.lists).toEqual([{ id: germanyList, name: "Germany Q4", count: 2 }]);
  });

  it("offers only values that live companies have", async () => {
    const o = await getCompanyFilterOptions();
    expect(o.countries.sort()).toEqual(["DE", "NO", "US"]);
    expect(o.niches).toEqual(["busts", "miniatures"]);
    expect(o.tags.map((tg) => tg.name)).toEqual(["resin", "trade fair"]);
    expect(o.users.map((u) => u.name)).toEqual(["Ali", "Sara"]);
  });

  it("custom columns appear only when some company has a value", async () => {
    expect(await getCompanyCustomColumns()).toEqual([{ key: "members", label: "Members" }]);
  });
});

describe("Ctrl+K search and select-all", () => {
  it("finds companies by name start, words anywhere, or C-number", async () => {
    expect((await searchCompaniesQuick("acme")).map((r) => r.name)).toEqual(["Acme 3D GmbH"]);
    expect((await searchCompaniesQuick("anna schmidt")).map((r) => r.name)).toEqual(["Acme 3D GmbH"]);
    expect((await searchCompaniesQuick(`C-${ids.D}`))[0]?.name).toBe("Zeta Studio");
    expect(await searchCompaniesQuick("deleted co")).toEqual([]);
    expect(await searchCompaniesQuick("   ")).toEqual([]);
    const r = (await searchCompaniesQuick("minis"))[0]!;
    expect(r).toEqual({ id: ids.F, name: "Omega Minis", country: "DE", status: "DO_NOT_CONTACT" });
  });

  it("limits results", async () => {
    expect((await searchCompaniesQuick("e", 2)).length).toBe(2);
  });

  it("lists matching ids up to a cap", async () => {
    const res = await listMatchingCompanyIds(await filtersFrom("country=DE"), 2);
    expect(res.total).toBe(3);
    expect(res.capped).toBe(true);
    expect(res.ids).toEqual([ids.A, ids.C]);
  });
});

describe("last contact: whichever date is newer", () => {
  it("sorts and filters by the old tool's date when it's newer than this app's email", async () => {
    const list = await makeList("Old tool check");
    await makeCompany({
      name: "Old Newer",
      lastEmailedAt: new Date(now - 30 * DAY),
      lastEmailedById: ali.id,
      importedLastContactAt: new Date(now - 1 * DAY),
      listIds: [list],
    });
    await makeCompany({ name: "App Only", lastEmailedAt: new Date(now - 10 * DAY), lastEmailedById: ali.id, listIds: [list] });
    await makeCompany({ name: "Never Touched", listIds: [list] });
    expect(await names(`list=${list}&sort=lastEmailed&dir=desc`)).toEqual(["Old Newer", "App Only", "Never Touched"]);
    expect(await names(`list=${list}&sort=lastEmailed`)).toEqual(["App Only", "Old Newer", "Never Touched"]);
    expect(await names(`list=${list}&emailed=yes`)).toEqual(["App Only", "Old Newer"]);
    expect(await names(`list=${list}&emailed=no`)).toEqual(["Never Touched"]);
    const row = (await listCompanies(await filtersFrom(`list=${list}&q=old newer`))).rows[0]!;
    const { lastEmailedLabel } = await import("@/components/contacts/format");
    expect(lastEmailedLabel(row, new Date(now))).toBe("Old tool · 1 day ago");
  });
});

describe("paging", () => {
  it("splits a long list into pages and clamps past the end", async () => {
    const big = await makeList("Big list");
    for (let i = 0; i < 55; i++) await makeCompany({ name: `Paging ${String(i).padStart(2, "0")}`, listIds: [big] });
    const p2 = await listCompanies(await filtersFrom(`list=${big}&page=2`));
    expect(p2.total).toBe(55);
    expect(p2.pageCount).toBe(2);
    expect(p2.page).toBe(2);
    expect(p2.rows.map((r) => r.name)).toEqual(["Paging 50", "Paging 51", "Paging 52", "Paging 53", "Paging 54"]);
    const past = await listCompanies(await filtersFrom(`list=${big}&page=7`));
    expect(past.page).toBe(2);
    expect(past.rows).toHaveLength(5);
  });
});
