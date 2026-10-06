import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/** Contacts "Last emailed" tooltip gains the reply (M4-DESIGN §6 row 6): the list query carries Company.repliedAt. */

const t = await createTestDb("contacts-replied");
const { db, dbWrite } = await import("@/server/db");
const { listCompanies } = await import("@/server/services/companies/query");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { toContactRow } = await import("@/components/contacts/format");

const DAY = 86_400_000;
let viewerId = 0;

beforeAll(async () => {
  const ali = await dbWrite((c) => c.user.create({ data: { name: "Ali", email: "ali@pp.test", role: "OWNER" } }));
  viewerId = ali.id;
  const now = Date.now();
  await dbWrite((c) =>
    c.company.create({
      data: {
        name: "Firma GmbH",
        nameNorm: "firma",
        status: "REPLIED",
        lastEmailedAt: new Date(now - 5 * DAY),
        lastEmailedById: ali.id,
        lastContactAt: new Date(now - 5 * DAY),
        repliedAt: new Date(now - 2 * DAY),
      },
    }),
  );
  await dbWrite((c) => c.company.create({ data: { name: "Quiet Studio", nameNorm: "quiet studio" } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("Contacts list and replies", () => {
  it("returns repliedAt with each row and adds the replied line to the Last emailed tooltip", async () => {
    const res = await listCompanies(parseCompanyFilters({ sort: "name", dir: "asc" }), { id: viewerId });
    const firma = res.rows.find((r) => r.name === "Firma GmbH")!;
    const quiet = res.rows.find((r) => r.name === "Quiet Studio")!;
    expect(firma.repliedAt).toBeInstanceOf(Date);
    expect(quiet.repliedAt).toBeNull();

    const row = toContactRow(firma, { timeZone: "Europe/Berlin" });
    expect(row.lastEmailedLabel).toBe("You · 5 days ago");
    expect(row.lastEmailedTitle).toMatch(/^Emailed by you on .+\nReplied 2 days ago$/);
    expect(toContactRow(quiet, { timeZone: "Europe/Berlin" }).lastEmailedTitle).toBeNull();
  });
});
