import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeList, makeUser } from "./seed";

const t = await createTestDb("contacts-create");
const { db, dbTx } = await import("@/server/db");
const { createCompany, restoreCompany } = await import("@/server/services/companies/create");
const { bulkDelete } = await import("@/server/services/companies/bulk");

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", "OWNER");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("add company", () => {
  it("derives every field like the importer and logs who added it", async () => {
    const list = await makeList("Germany Q4");
    const res = await createCompany(
      {
        name: "  Müller 3D-Druck GmbH ",
        website: "WWW.Mueller3D.de/shop/",
        country: "DE",
        niche: "Miniatures",
        priority: "HIGH",
        status: "CONTACTED",
        listId: list,
        person: { name: "Dr. Anna Schmidt", email: "Anna.Schmidt@Mueller3D.DE", role: "Product lead" },
      },
      ali,
    );
    expect(res.kind).toBe("created");
    if (res.kind !== "created") return;
    const c = await db.company.findUniqueOrThrow({ where: { id: res.companyId }, include: { people: true, lists: true } });
    expect(c.name).toBe("Müller 3D-Druck GmbH");
    expect(c.nameNorm).toBe("muller 3d druck");
    expect(c.website).toBe("https://www.mueller3d.de/shop");
    expect(c.domain).toBe("mueller3d.de");
    expect(c.country).toBe("DE");
    expect(c.timeZone).toBe("Europe/Berlin");
    expect(c.priority).toBe("HIGH");
    expect(c.priorityRank).toBe(1);
    expect(c.status).toBe("CONTACTED");
    expect(c.createdById).toBe(ali.id);
    expect(c.searchText).toContain("anna schmidt");
    expect(c.searchText).toContain("mueller3d.de");
    expect(c.lists.map((l) => l.listId)).toEqual([list]);
    const p = c.people[0]!;
    expect(p.email).toBe("Anna.Schmidt@mueller3d.de");
    expect(p.emailNorm).toBe("anna.schmidt@mueller3d.de");
    expect(p.firstName).toBe("Anna");
    expect(p.isGeneric).toBe(false);
    const logs = await db.activityLog.findMany({ where: { companyId: c.id }, orderBy: { id: "asc" } });
    expect(logs.map((l) => l.type)).toEqual(["company.created", "person.created"]);
    expect(logs.every((l) => l.actorId === ali.id)).toBe(true);
    expect(logs[0]!.summary).toBe("Ali added this company as Contacted");
    expect(logs[1]!.summary).toBe("Ali added Dr. Anna Schmidt");
  });

  it("turns a nameless info@ address into the General inbox", async () => {
    const res = await createCompany({ name: "Nordic Prints AS", country: "NO", person: { email: "post@nordicprints.no" } }, ali);
    if (res.kind !== "created") throw new Error(`expected created, got ${res.kind}`);
    const p = await db.person.findFirstOrThrow({ where: { companyId: res.companyId } });
    expect(p.name).toBe("General inbox");
    expect(p.isGeneric).toBe(true);
    expect(p.firstName).toBeNull();
    const c = await db.company.findUniqueOrThrow({ where: { id: res.companyId } });
    expect(c.timeZone).toBe("Europe/Oslo");
    expect(c.domain).toBeNull(); // no website given
  });

  it("keeps shared hosts out of the domain but remembers the profile", async () => {
    const res = await createCompany({ name: "Sculpt by Anna", website: "https://www.instagram.com/Sculpt_By_Anna/" }, ali);
    if (res.kind !== "created") throw new Error(`expected created, got ${res.kind}`);
    const c = await db.company.findUniqueOrThrow({ where: { id: res.companyId } });
    expect(c.domain).toBeNull();
    expect(c.profileKey).toBe("instagram.com/sculpt_by_anna");
    expect(c.instagram).toBe("sculpt_by_anna");
    expect(c.country).toBeNull();
    expect(c.timeZone).toBeNull();
  });

  it("explains bad input per field", async () => {
    const res = await createCompany({ name: " ", website: "not a site", country: "Atlantis", person: { email: "anna@@x" } }, ali);
    expect(res.kind).toBe("invalid");
    if (res.kind !== "invalid") return;
    expect(Object.keys(res.fieldErrors).sort()).toEqual(["country", "name", "personEmail", "website"]);
    expect(res.fieldErrors.personEmail![0]).toMatch(/isn't a valid email address/);
  });

  it("refuses a list that no longer exists", async () => {
    const res = await createCompany({ name: "Listless", listId: 999_999 }, ali);
    expect(res.kind).toBe("invalid");
  });
});

describe("duplicates", () => {
  it("same website domain is a hard stop, naming the existing company", async () => {
    const id = await makeCompany({ name: "Acme 3D GmbH", website: "acme3d.de", country: "DE" });
    const res = await createCompany({ name: "Acme Three D", website: "https://shop.acme3d.de" }, ali);
    expect(res.kind).toBe("duplicate");
    if (res.kind !== "duplicate") return;
    expect(res.match).toMatchObject({ companyId: id, reason: "domain", deleted: false });
    expect(res.message).toBe(`Already in your contacts as C-${id} Acme 3D GmbH.`);
  });

  it("an email's company domain also counts when no website is given", async () => {
    const id = await makeCompany({ name: "Beta Models", website: "betamodels.com" });
    const res = await createCompany({ name: "Beta Models Ltd", person: { email: "sales@betamodels.com" } }, ali);
    expect(res.kind).toBe("duplicate");
    if (res.kind === "duplicate") expect(res.match.companyId).toBe(id);
    // Free-mail domains never match anything.
    await makeCompany({ name: "Gmail User Co", website: "gmail.com" });
    const free = await createCompany({ name: "Another Gmail Studio", person: { email: "someone.new@gmail.com" } }, ali);
    expect(free.kind).toBe("created");
  });

  it("same person email is a hard stop", async () => {
    const id = await makeCompany({ name: "Gamma Studio", people: [{ name: "Gus", email: "gus@gamma-studio.io" }] });
    const res = await createCompany({ name: "Totally Different", person: { email: "GUS@gamma-studio.io" } }, ali);
    expect(res.kind).toBe("duplicate");
    if (res.kind !== "duplicate") return;
    expect(res.match).toMatchObject({ companyId: id, reason: "email" });
    expect(res.message).toBe(`GUS@gamma-studio.io is already in your contacts, at C-${id} Gamma Studio.`);
  });

  it("the same profile URL is a hard stop", async () => {
    const id = await makeCompany({ name: "Tiny Busts", website: "instagram.com/tinybusts" });
    const res = await createCompany({ name: "Tiny Busts Shop", website: "https://instagram.com/TinyBusts" }, ali);
    expect(res.kind === "duplicate" && res.match.companyId).toBe(id);
  });

  it("two shops on the same platform are two companies; the same shop is a hard stop (DATA-1)", async () => {
    const foo = await createCompany({ name: "Foo Minis", website: "https://www.etsy.com/shop/FooMinis", country: "DE" }, ali);
    expect(foo.kind).toBe("created");
    const bar = await createCompany({ name: "Bar Busts", website: "https://www.etsy.com/shop/BarBusts", country: "NO" }, ali);
    expect(bar.kind).toBe("created");
    if (foo.kind !== "created" || bar.kind !== "created") return;
    expect((await db.company.findUniqueOrThrow({ where: { id: bar.companyId } })).profileKey).toBe("etsy.com/shop/barbusts");
    const again = await createCompany({ name: "Foo Minis Shop", website: "etsy.com/shop/foominis?ref=shop_sugg" }, ali);
    expect(again.kind === "duplicate" && again.match).toMatchObject({ companyId: foo.companyId, reason: "profile" });

    // Facebook profile.php links keep their id, so two profiles don't collide either.
    const one = await createCompany({ name: "FB One", website: "https://www.facebook.com/profile.php?id=111111" }, ali);
    const two = await createCompany({ name: "FB Two", website: "https://www.facebook.com/profile.php?id=222222" }, ali);
    expect([one.kind, two.kind]).toEqual(["created", "created"]);
    if (one.kind !== "created") return;
    const fb = await db.company.findUniqueOrThrow({ where: { id: one.companyId } });
    expect(fb.website).toBe("https://www.facebook.com/profile.php?id=111111");
    expect(fb.profileKey).toBe("facebook.com/profile.php?id=111111");

    // A link to an Instagram post is no profile: no Instagram handle "p", no profile key.
    const post = await createCompany({ name: "Post Link Studio", website: "https://www.instagram.com/p/CxYz123/" }, ali);
    if (post.kind !== "created") throw new Error(`expected created, got ${post.kind}`);
    expect(await db.company.findUniqueOrThrow({ where: { id: post.companyId } })).toMatchObject({ instagram: null, profileKey: null });
  });

  it("checks for duplicates inside its own transaction, so another request's undone insert never counts (DATA-14)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedNow = new Promise<void>((r) => (inserted = r));
    // Another request inserts a company, then fails and rolls back.
    const other = dbTx(async (tx) => {
      await tx.company.create({ data: { name: "Dirty Co", nameNorm: "dirty", website: "https://dirty-co.de", domain: "dirty-co.de" } });
      inserted();
      await gate;
      throw new Error("the other request failed");
    }).catch((err: Error) => err.message);
    await insertedNow;
    const creating = createCompany({ name: "Clean Studio", website: "https://dirty-co.de" }, ali);
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect(await other).toBe("the other request failed");
    const res = await creating;
    expect(res.kind).toBe("created");
    expect(await db.company.count({ where: { domain: "dirty-co.de" } })).toBe(1);
  });

  it("soft-deleted companies still count, and can be restored", async () => {
    const id = await makeCompany({ name: "Delta Figures", website: "deltafigures.de", people: [{ email: "hi@deltafigures.de" }] });
    await bulkDelete([id], ali);
    const byDomain = await createCompany({ name: "Delta Figures", website: "deltafigures.de" }, ali);
    expect(byDomain.kind).toBe("duplicate");
    if (byDomain.kind !== "duplicate") return;
    expect(byDomain.match.deleted).toBe(true);
    expect(byDomain.message).toMatch(/which was deleted.*restore it/);
    const byEmail = await createCompany({ name: "Some New Name", person: { email: "hi@deltafigures.de" } }, ali);
    expect(byEmail.kind === "duplicate" && byEmail.match).toMatchObject({ companyId: id, deleted: true, reason: "email" });

    const restored = await restoreCompany(id, ali);
    expect(restored).toEqual({ ok: true, companyName: "Delta Figures" });
    expect((await db.company.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    const log = await db.activityLog.findFirst({ where: { companyId: id, type: "company.restored" } });
    expect(log?.actorId).toBe(ali.id);
    expect(await restoreCompany(12_345_678, ali)).toMatchObject({ ok: false });
  });

  it("same name in the same country is a warning you can override", async () => {
    const id = await makeCompany({ name: "Epsilon Prints GmbH", country: "AT" });
    const warn = await createCompany({ name: "Epsilon Prints", country: "AT" }, ali);
    expect(warn.kind).toBe("possible-duplicate");
    if (warn.kind !== "possible-duplicate") return;
    expect(warn.match).toMatchObject({ companyId: id, reason: "name" });
    expect(warn.message).toContain(`C-${id}`);
    expect(warn.message).toContain("Create anyway");

    const otherCountry = await createCompany({ name: "Epsilon Prints", country: "CH" }, ali);
    expect(otherCountry.kind).toBe("created");

    const forced = await createCompany({ name: "Epsilon Prints", country: "AT" }, ali, { force: true });
    expect(forced.kind).toBe("created");
  });

  it("a deleted company with the same name and country is still mentioned", async () => {
    const id = await makeCompany({ name: "Zeta Resin", country: "NL", deletedAt: new Date() });
    const warn = await createCompany({ name: "Zeta Resin", country: "NL" }, ali);
    expect(warn.kind === "possible-duplicate" && warn.match).toMatchObject({ companyId: id, deleted: true });
  });
});
