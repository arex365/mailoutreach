import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makePerson, makeUser } from "../stops-holds/world";

/**
 * A new address needs its own check (M5-DESIGN §2.6): `updatePerson` clears all six check fields together
 * (`CLEARED_CHECK_FIELDS`), and a name or role change leaves them alone.
 */

const t = await createTestDb("verification-people-clear");
const { db, dbWrite } = await import("@/server/db");
const { updatePerson } = await import("@/server/services/people");
const { CLEARED_CHECK_FIELDS } = await import("@/core/verification/types");

let actor: { id: number; name: string };

beforeAll(async () => {
  const u = await makeUser("Ali", { role: "OWNER" });
  actor = { id: u.id, name: u.name };
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const checkFields = (id: number) =>
  db.person.findUniqueOrThrow({
    where: { id },
    select: {
      verificationStatus: true,
      verificationRisk: true,
      verifiedAt: true,
      verificationProvider: true,
      verificationDisposable: true,
      verificationUnknowns: true,
    },
  });

async function checkedPerson(fields: Record<string, unknown>) {
  const n = Math.random().toString(36).slice(2, 7);
  const company = await makeCompany(`Firma ${n}`);
  const person = await makePerson(company.id, `anna.${n}@firma.test`, "Anna Berg");
  await dbWrite((c) => c.person.update({ where: { id: person.id }, data: fields }));
  return { company, person, n };
}

describe("updatePerson and the check fields", () => {
  it("an address change clears all six fields and says so", async () => {
    const { person, n } = await checkedPerson({
      verificationStatus: "UNKNOWN",
      verificationRisk: "HIGH",
      verifiedAt: new Date("2026-09-20T10:00:00Z"),
      verificationProvider: "mailgun",
      verificationDisposable: true,
      verificationUnknowns: 2,
    });
    const res = await updatePerson(actor, person.id, { name: "Anna Berg", email: `anna.berg.${n}@firma.test` });
    expect(res).toMatchObject({ changed: true, checkCleared: true });
    expect(await checkFields(person.id)).toEqual(CLEARED_CHECK_FIELDS);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "person.updated", personId: person.id } });
    expect(log.summary).toMatch(/and cleared the address check$/);
  });

  it("an unknowns count alone also counts as a check to clear", async () => {
    const { person, n } = await checkedPerson({ verificationUnknowns: 1 });
    const res = await updatePerson(actor, person.id, { name: "Anna Berg", email: `a.${n}@firma.test` });
    expect(res.checkCleared).toBe(true);
    expect((await checkFields(person.id)).verificationUnknowns).toBe(0);
  });

  it("a name or role change keeps the check", async () => {
    const checked = {
      verificationStatus: "VALID",
      verificationRisk: "LOW",
      verifiedAt: new Date("2026-09-20T10:00:00Z"),
      verificationProvider: "mailgun",
      verificationDisposable: true,
      verificationUnknowns: 0,
    };
    const { person } = await checkedPerson(checked);
    const res = await updatePerson(actor, person.id, { name: "Anna B.", email: person.email, role: "Buyer" });
    expect(res).toMatchObject({ changed: true, checkCleared: false });
    expect(await checkFields(person.id)).toEqual(checked);
  });
});
