import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("sanity");
const { db, dbTx } = await import("@/server/db");
const { refreshCompanySearchText } = await import("@/server/company-search");
const { buildCompanyWhere, parseCompanyFilters } = await import("@/server/services/companies/filters");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("test database + shared services", () => {
  it("creates companies and finds them through the shared filters", async () => {
    await dbTx(async (tx) => {
      const c = await tx.company.create({ data: { name: "Müller 3D Druck", nameNorm: "muller 3d druck", country: "DE" } });
      await tx.person.create({ data: { companyId: c.id, name: "Anna Schmidt", email: "anna@mueller3d.de", emailNorm: "anna@mueller3d.de" } });
      await tx.company.create({ data: { name: "Nordic Prints", nameNorm: "nordic prints", country: "NO" } });
      await refreshCompanySearchText(tx, [c.id]);
    });
    const f = parseCompanyFilters(new URLSearchParams("q=muller anna"));
    const found = await db.company.findMany({ where: buildCompanyWhere(f) });
    expect(found.map((c) => c.name)).toEqual(["Müller 3D Druck"]);
    const missing = await db.company.findMany({ where: buildCompanyWhere(parseCompanyFilters(new URLSearchParams("view=missing-email"))) });
    expect(missing.map((c) => c.name)).toEqual(["Nordic Prints"]);
  });
});
