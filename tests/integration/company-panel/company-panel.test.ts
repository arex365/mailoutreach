import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("company-panel");
const { db, dbTx } = await import("@/server/db");
const { refreshCompanySearchText } = await import("@/server/company-search");
const m = await import("@/server/services/companies/mutations");
const people = await import("@/server/services/people");
const detail = await import("@/server/services/companies/detail");

type Actor = { id: number; name: string };
let ali: Actor;
let sara: Actor;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeAll(async () => {
  const a = await dbTx((tx) => tx.user.create({ data: { email: "ali@pp.test", name: "Ali", role: "OWNER" } }));
  const s = await dbTx((tx) => tx.user.create({ data: { email: "sara@pp.test", name: "Sara" } }));
  ali = { id: a.id, name: a.name };
  sara = { id: s.id, name: s.name };
});

async function makeCompany(data: {
  name: string;
  domain?: string | null;
  website?: string | null;
  country?: string | null;
  timeZone?: string | null;
  deletedAt?: Date | null;
}) {
  return dbTx(async (tx) => {
    const c = await tx.company.create({
      data: {
        name: data.name,
        nameNorm: data.name.toLowerCase(),
        domain: data.domain ?? null,
        website: data.website ?? null,
        country: data.country ?? null,
        timeZone: data.timeZone ?? null,
        deletedAt: data.deletedAt ?? null,
        createdById: ali.id,
      },
    });
    await refreshCompanySearchText(tx, [c.id]);
    return c;
  });
}

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof m.ServiceError>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof m.ServiceError) return err;
    throw err;
  }
  throw new Error("Expected a ServiceError");
}

async function lastActivity(companyId: number) {
  return db.activityLog.findFirst({ where: { companyId }, orderBy: [{ at: "desc" }, { id: "desc" }] });
}

async function searchText(companyId: number) {
  return (await db.company.findUniqueOrThrow({ where: { id: companyId } })).searchText;
}

describe("company fields", () => {
  it("renames, logs the change with its author and refreshes search", async () => {
    const c = await makeCompany({ name: "Acme" });
    const r = await m.renameCompany(ali, c.id, "  Müller   3D  GmbH ");
    expect(r).toEqual({ changed: true, name: "Müller 3D GmbH" });
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.nameNorm).toBe("muller 3d");
    expect(row.searchText).toContain("muller 3d gmbh");
    const log = await lastActivity(c.id);
    expect(log).toMatchObject({ actorId: ali.id, type: "company.updated", summary: "Ali renamed Acme to Müller 3D GmbH" });
    expect(await m.renameCompany(ali, c.id, "Müller 3D GmbH")).toEqual({ changed: false, name: "Müller 3D GmbH" });
    expect((await caught(m.renameCompany(ali, c.id, "   "))).message).toBe("Enter the company name.");
  });

  it("changes status and priority", async () => {
    const c = await makeCompany({ name: "Status Co" });
    await m.setCompanyStatus(sara, c.id, "DO_NOT_CONTACT");
    await m.setCompanyPriority(sara, c.id, "HIGH");
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("DO_NOT_CONTACT");
    expect(row.priority).toBe("HIGH");
    expect(row.priorityRank).toBe(1);
    const logs = await db.activityLog.findMany({ where: { companyId: c.id }, orderBy: { id: "asc" } });
    expect(logs.map((l) => [l.type, l.summary, l.actorId])).toEqual([
      ["company.status", "Sara set status to Do not contact", sara.id],
      ["company.priority", "Sara set priority to High", sara.id],
    ]);
  });

  it("gives a social page no domain, so it's never used for duplicates", async () => {
    const c = await makeCompany({ name: "Sculpt by Anna" });
    const r = await m.setCompanyWebsite(ali, c.id, "https://www.instagram.com/Sculpt_By_Anna/");
    expect(r).toMatchObject({ changed: true, isShared: true });
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.domain).toBeNull();
    expect(row.profileKey).toBe("instagram.com/sculpt_by_anna");
    expect(row.website).toBe("https://www.instagram.com/Sculpt_By_Anna");
  });

  it("refuses a domain that belongs to another live company, with a link to it", async () => {
    const owner = await makeCompany({ name: "Acme GmbH", domain: "acme.de", website: "https://acme.de" });
    const ghost = await makeCompany({ name: "Old Printing", domain: "oldprint.de", deletedAt: new Date() });
    const c = await makeCompany({ name: "Newcomer" });
    const err = await caught(m.setCompanyWebsite(ali, c.id, "www.acme.de/about"));
    expect(err.message).toBe(`acme.de already belongs to C-${owner.id} Acme GmbH.`);
    expect(err.link).toEqual({ href: `/contacts?company=${owner.id}`, label: `C-${owner.id} Acme GmbH` });
    // A deleted company doesn't block the domain.
    const ok = await m.setCompanyWebsite(ali, c.id, "oldprint.de");
    expect(ok).toMatchObject({ changed: true, isShared: false, host: "oldprint.de" });
    expect((await db.company.findUniqueOrThrow({ where: { id: c.id } })).domain).toBe("oldprint.de");
    expect(ghost.id).toBeGreaterThan(0);
    expect(await searchText(c.id)).toContain("oldprint.de");
    // Invalid input and clearing.
    expect((await caught(m.setCompanyWebsite(ali, c.id, "not a site"))).message).toMatch(/doesn't look like a web address/);
    await m.setCompanyWebsite(ali, c.id, "");
    const cleared = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect([cleared.website, cleared.domain, cleared.profileKey]).toEqual([null, null, null]);
  });

  it("moves the time zone with the country unless someone picked their own", async () => {
    const c = await makeCompany({ name: "Nordic Prints" });
    const first = await m.setCompanyCountry(ali, c.id, "Norge");
    expect(first).toMatchObject({ country: "NO", timeZone: "Europe/Oslo", timeZoneChanged: true, suggestedTimeZone: null });
    expect(await searchText(c.id)).toContain("norway");
    const second = await m.setCompanyCountry(ali, c.id, "Germany");
    expect(second).toMatchObject({ country: "DE", timeZone: "Europe/Berlin", timeZoneChanged: true });

    await m.setCompanyTimeZone(ali, c.id, "America/New_York");
    const third = await m.setCompanyCountry(ali, c.id, "NO");
    expect(third).toMatchObject({ timeZone: "America/New_York", timeZoneChanged: false, suggestedTimeZone: "Europe/Oslo" });

    const reset = await m.setCompanyTimeZone(ali, c.id, null);
    expect(reset).toEqual({ changed: true, timeZone: "Europe/Oslo" });
    expect((await caught(m.setCompanyTimeZone(ali, c.id, "Mars/Olympus"))).message).toMatch(/isn't valid/);
    expect((await caught(m.setCompanyCountry(ali, c.id, "Atlantis"))).message).toMatch(/don't recognise that country/);
    const log = await lastActivity(c.id);
    expect(log?.summary).toBe("Ali reset the time zone to Europe/Oslo (Norway's default)");
  });

  it("stores Instagram handles and niches and makes them searchable", async () => {
    const c = await makeCompany({ name: "Mini Makers" });
    await m.setCompanyInstagram(ali, c.id, "https://instagram.com/Mini.Makers?igsh=abc");
    await m.setCompanyNiche(ali, c.id, "  Tabletop   miniatures ");
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.instagram).toBe("mini.makers");
    expect(row.niche).toBe("Tabletop miniatures");
    expect(row.searchText).toContain("mini.makers");
    expect(row.searchText).toContain("tabletop miniatures");
    expect((await caught(m.setCompanyInstagram(ali, c.id, "https://instagram.com/p/Cxyz"))).message).toMatch(/Instagram profile/);
  });

  it("sets and clears custom fields", async () => {
    await dbTx((tx) => tx.customField.create({ data: { key: "members", label: "Members", entity: "COMPANY" } }));
    const c = await makeCompany({ name: "Custom Co" });
    expect(await m.setCompanyCustomField(ali, c.id, "members", " 12k ")).toEqual({ changed: true, label: "Members" });
    let d = await detail.getCompanyDetail(c.id);
    expect(d?.customFields).toEqual([{ key: "members", label: "Members", value: "12k" }]);
    await m.setCompanyCustomField(ali, c.id, "members", "");
    d = await detail.getCompanyDetail(c.id);
    expect(d?.customFields).toEqual([]);
    expect((await db.company.findUniqueOrThrow({ where: { id: c.id } })).customFields).toBeNull();
    expect((await caught(m.setCompanyCustomField(ali, c.id, "nope", "x"))).message).toMatch(/doesn't exist any more/);
  });
});

describe("notes and personal line", () => {
  it("saves notes and logs the new text", async () => {
    const c = await makeCompany({ name: "Notes Co" });
    await m.setCompanyNotes(sara, c.id, "Met at Formnext.\r\nAsk for Jonas.  ");
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.notes).toBe("Met at Formnext.\nAsk for Jonas.");
    const log = await lastActivity(c.id);
    expect(log).toMatchObject({ type: "company.notes", actorId: sara.id, summary: "Sara updated the notes" });
    expect(log?.data).toEqual({ text: "Met at Formnext.\nAsk for Jonas." });
  });

  it("saves a hand-written personal line with its author", async () => {
    const c = await makeCompany({ name: "Line Co" });
    await m.setCompanyPersonalLine(ali, c.id, "Your hand-painted\n dragon busts caught my eye.");
    const row = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.personalLine).toBe("Your hand-painted dragon busts caught my eye.");
    expect(row.personalLineSource).toBe("manual");
    expect(row.personalLineUpdatedById).toBe(ali.id);
    expect(row.personalLineUpdatedAt).toBeInstanceOf(Date);
    expect((await lastActivity(c.id))?.type).toBe("company.personalLine");
    const d = await detail.getCompanyDetail(c.id);
    expect(d?.personalLineUpdatedBy).toEqual({ id: ali.id, name: "Ali" });

    const err = await caught(m.setCompanyPersonalLine(ali, c.id, "x".repeat(301)));
    expect(err.message).toMatch(/under 300 characters/);

    await m.setCompanyPersonalLine(ali, c.id, "  ");
    const cleared = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect([cleared.personalLine, cleared.personalLineSource]).toEqual([null, null]);
  });
});

describe("people", () => {
  it("turns a role address with no name into General inbox", async () => {
    const c = await makeCompany({ name: "Inbox Co" });
    const r = await people.addPerson(ali, c.id, { email: "Info@InboxCo.DE" });
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p).toMatchObject({
      name: "General inbox",
      isGeneric: true,
      firstName: null,
      email: "Info@inboxco.de",
      emailNorm: "info@inboxco.de",
    });
    expect(r.label).toBe("General inbox (Info@inboxco.de)");
    expect(await searchText(c.id)).toContain("info@inboxco.de");
    const log = await lastActivity(c.id);
    expect(log).toMatchObject({ type: "person.created", actorId: ali.id, personId: p.id });
  });

  it("adds a named person with a first name, and checks the address", async () => {
    const c = await makeCompany({ name: "Named Co" });
    const r = await people.addPerson(ali, c.id, { name: "Dr. Jonas Berg", email: "jonas@named.no", role: "Owner" });
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p).toMatchObject({ name: "Dr. Jonas Berg", firstName: "Jonas", isGeneric: false, role: "Owner" });
    const bad = await caught(people.addPerson(ali, c.id, { name: "Anna", email: "anna@@named.no" }));
    expect(bad.message).toBe("That doesn't look like an email address: check for typos like a missing @.");
    expect(bad.fieldErrors?.email).toBeDefined();
    expect((await caught(people.addPerson(ali, c.id, { name: " ", email: "" }))).message).toBe(
      "Enter a name or an email address.",
    );
    const dup = await caught(people.addPerson(ali, c.id, { email: "JONAS@named.no" }));
    expect(dup.message).toBe("JONAS@named.no is already on this company.");
  });

  it("refuses an address that belongs to another company, even a removed person", async () => {
    const acme = await makeCompany({ name: "Acme GmbH" });
    const other = await makeCompany({ name: "Other Co" });
    await people.addPerson(ali, acme.id, { name: "Anna", email: "anna@x.de" });
    const err = await caught(people.addPerson(sara, other.id, { name: "Anna", email: "anna@x.de" }));
    expect(err.message).toBe(`anna@x.de already belongs to C-${acme.id} Acme GmbH.`);
    expect(err.link?.href).toBe(`/contacts?company=${acme.id}`);

    const removed = await people.addPerson(ali, acme.id, { name: "Bert", email: "bert@x.de" });
    await people.removePerson(ali, removed.personId);
    const err2 = await caught(people.addPerson(sara, other.id, { email: "bert@x.de" }));
    expect(err2.message).toMatch(new RegExp(`^bert@x.de already belongs to C-${acme.id} Acme GmbH\\. It was removed there`));
  });

  it("brings back a removed person when the same address is added to the same company", async () => {
    const c = await makeCompany({ name: "Comeback Co" });
    const r = await people.addPerson(ali, c.id, { name: "Carla", email: "carla@comeback.de" });
    await people.removePerson(ali, r.personId);
    const again = await people.addPerson(sara, c.id, { email: "carla@comeback.de", role: "Buyer" });
    expect(again).toMatchObject({ personId: r.personId, restored: true });
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p).toMatchObject({ deletedAt: null, name: "Carla", role: "Buyer" });
    expect(await searchText(c.id)).toContain("carla");
  });

  it("clears the check result when the email changes, and logs it", async () => {
    const c = await makeCompany({ name: "Verify Co" });
    const r = await people.addPerson(ali, c.id, { name: "Dana", email: "dana@verify.de" });
    await dbTx((tx) =>
      tx.person.update({
        where: { id: r.personId },
        data: {
          verificationStatus: "VALID",
          verificationRisk: "LOW",
          verifiedAt: new Date(),
          verificationProvider: "mailgun",
          bouncedAt: new Date(),
        },
      }),
    );
    // Same name and role, only the address's case: nothing is cleared.
    const same = await people.updatePerson(ali, r.personId, { name: "Dana", email: "dana@verify.de", role: "" });
    expect(same.changed).toBe(false);

    const res = await people.updatePerson(sara, r.personId, { name: "Dana Fox", email: "dana.fox@verify.de", role: "CEO" });
    expect(res).toMatchObject({ changed: true, checkCleared: true });
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p).toMatchObject({
      name: "Dana Fox",
      firstName: "Dana",
      role: "CEO",
      email: "dana.fox@verify.de",
      emailNorm: "dana.fox@verify.de",
      verificationStatus: null,
      verificationRisk: null,
      verifiedAt: null,
      verificationProvider: null,
      bouncedAt: null,
    });
    const log = await lastActivity(c.id);
    expect(log).toMatchObject({ type: "person.updated", actorId: sara.id, personId: p.id });
    expect(log?.summary).toBe(
      "Sara changed Dana's name to Dana Fox, email to dana.fox@verify.de, role to CEO and cleared the address check",
    );
    const st = await searchText(c.id);
    expect(st).toContain("dana.fox@verify.de");
    expect(st).not.toContain("dana@verify.de");
  });

  it("hides a removed person and takes them out of search", async () => {
    const c = await makeCompany({ name: "Remove Co" });
    const r = await people.addPerson(ali, c.id, { name: "Egon Zeller", email: "egon@remove.de" });
    expect(await searchText(c.id)).toContain("zeller");
    await people.removePerson(sara, r.personId);
    const d = await detail.getCompanyDetail(c.id);
    expect(d?.people).toEqual([]);
    expect(await searchText(c.id)).not.toContain("zeller");
    expect((await db.person.findUniqueOrThrow({ where: { id: r.personId } })).deletedAt).toBeInstanceOf(Date);
    expect((await lastActivity(c.id))?.summary).toBe("Sara removed Egon Zeller");
    expect((await caught(people.removePerson(sara, r.personId))).message).toMatch(/was removed/);
  });

  it("marks someone unsubscribed and puts the address on the do-not-email list", async () => {
    const c = await makeCompany({ name: "Unsub Co" });
    const r = await people.addPerson(ali, c.id, { name: "Finn", email: "Finn@Unsub.no" });
    const res = await people.markPersonUnsubscribed(sara, r.personId);
    expect(res).toEqual({ changed: true, email: "Finn@unsub.no" });
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p.unsubscribedAt).toBeInstanceOf(Date);
    const s = await db.suppression.findUniqueOrThrow({ where: { emailNorm: "finn@unsub.no" } });
    expect(s).toMatchObject({ reason: "UNSUBSCRIBED", source: "manual" });
    expect((await lastActivity(c.id))).toMatchObject({ type: "person.unsubscribed", actorId: sara.id });
    expect(await people.markPersonUnsubscribed(sara, r.personId)).toEqual({ changed: false, email: "Finn@unsub.no" });
    const d = await detail.getCompanyDetail(c.id);
    expect(d?.people[0]?.suppressed).toBe(true);

    // An address already suppressed for another reason becomes an unsubscribe.
    const r2 = await people.addPerson(ali, c.id, { name: "Gro", email: "gro@unsub.no" });
    await dbTx((tx) => tx.suppression.create({ data: { emailNorm: "gro@unsub.no", reason: "BOUNCED", source: "webhook", pushedToMailgunAt: new Date() } }));
    await people.markPersonUnsubscribed(ali, r2.personId);
    const s2 = await db.suppression.findUniqueOrThrow({ where: { emailNorm: "gro@unsub.no" } });
    expect(s2).toMatchObject({ reason: "UNSUBSCRIBED", source: "manual", pushedToMailgunAt: null });

    const noEmail = await people.addPerson(ali, c.id, { name: "Hanne" });
    expect((await caught(people.markPersonUnsubscribed(ali, noEmail.personId))).message).toMatch(/no email address/);
  });

  it("saves a person's own personal line and notes", async () => {
    const c = await makeCompany({ name: "Person Line Co" });
    const r = await people.addPerson(ali, c.id, { name: "Ivo", email: "ivo@line.de" });
    await people.setPersonPersonalLine(ali, r.personId, "Loved your  resin dioramas.");
    await people.setPersonNotes(sara, r.personId, "Prefers English.");
    const p = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    expect(p.personalLineOverride).toBe("Loved your resin dioramas.");
    expect(p.notes).toBe("Prefers English.");
    const logs = await db.activityLog.findMany({ where: { personId: p.id }, orderBy: { id: "asc" } });
    expect(logs.map((l) => l.summary)).toEqual([
      "Ali added Ivo",
      "Ali wrote a personal line for Ivo",
      "Sara updated the notes for Ivo",
    ]);
    expect((await caught(people.setPersonPersonalLine(ali, r.personId, "y".repeat(320)))).message).toMatch(/300/);
  });
});

describe("lists and tags", () => {
  it("adds and removes lists, creating new ones on the spot", async () => {
    const c = await makeCompany({ name: "List Co" });
    const existing = await dbTx((tx) => tx.list.create({ data: { name: "Germany Q4" } }));
    const a = await m.addCompanyToList(ali, c.id, { id: existing.id });
    expect(a).toMatchObject({ changed: true, created: false, name: "Germany Q4" });
    const again = await m.addCompanyToList(ali, c.id, { name: " germany   q4 " });
    expect(again).toMatchObject({ changed: false, created: false, id: existing.id });
    const fresh = await m.addCompanyToList(sara, c.id, { name: "Trade fair leads" });
    expect(fresh).toMatchObject({ changed: true, created: true });
    const newList = await db.list.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(newList.createdById).toBe(sara.id);
    let d = await detail.getCompanyDetail(c.id);
    expect(d?.lists.map((l) => l.name)).toEqual(["Germany Q4", "Trade fair leads"]);

    const removed = await m.removeCompanyFromList(ali, c.id, existing.id);
    expect(removed).toMatchObject({ changed: true, name: "Germany Q4" });
    d = await detail.getCompanyDetail(c.id);
    expect(d?.lists.map((l) => l.name)).toEqual(["Trade fair leads"]);
    const logs = await db.activityLog.findMany({ where: { companyId: c.id, type: "company.lists" }, orderBy: { id: "asc" } });
    expect(logs.map((l) => l.summary)).toEqual([
      "Ali added List Co to Germany Q4",
      "Sara added List Co to Trade fair leads",
      "Ali removed List Co from Germany Q4",
    ]);
    expect(await db.activityLog.count({ where: { type: "list.created" } })).toBe(1);
    expect((await caught(m.addCompanyToList(ali, c.id, { name: "  " }))).message).toBe("Type a name for the list.");
  });

  it("adds and removes tags", async () => {
    const c = await makeCompany({ name: "Tag Co" });
    const t1 = await m.addCompanyTag(ali, c.id, { name: "Resin" });
    expect(t1).toMatchObject({ changed: true, created: true, name: "Resin" });
    const t2 = await m.addCompanyTag(ali, c.id, { name: "resin" });
    expect(t2).toMatchObject({ changed: false, id: t1.id });
    await m.addCompanyTag(ali, c.id, { name: "Figurines" });
    let d = await detail.getCompanyDetail(c.id);
    expect(d?.tags.map((x) => x.name)).toEqual(["Figurines", "Resin"]);
    await m.removeCompanyTag(sara, c.id, t1.id);
    d = await detail.getCompanyDetail(c.id);
    expect(d?.tags.map((x) => x.name)).toEqual(["Figurines"]);
    expect((await lastActivity(c.id))?.summary).toBe("Sara removed the tag Resin from Tag Co");
    expect(await m.removeCompanyTag(sara, c.id, t1.id)).toMatchObject({ changed: false });
    expect(await db.tag.count({ where: { id: t1.id } })).toBe(1);
  });
});

describe("delete and restore", () => {
  it("soft-deletes, blocks edits while deleted, and restores", async () => {
    const c = await makeCompany({ name: "Gone GmbH", domain: "gone.de", website: "https://gone.de" });
    await m.deleteCompany(sara, c.id);
    let d = await detail.getCompanyDetail(c.id);
    expect(d?.deletedAt).toBeInstanceOf(Date);
    expect(d?.deletedBy).toEqual({ id: sara.id, name: "Sara" });
    expect((await caught(m.setCompanyStatus(ali, c.id, "CLIENT"))).message).toBe(
      "This company was deleted. Restore it first to make changes.",
    );
    expect((await caught(people.addPerson(ali, c.id, { email: "x@gone.de" }))).message).toMatch(/was deleted/);
    expect(await m.deleteCompany(sara, c.id)).toMatchObject({ changed: false });

    // Someone re-adds the same website while it's deleted: restore warns about the duplicate.
    const twin = await makeCompany({ name: "Gone Again", domain: "gone.de" });
    const r = await m.restoreCompany(ali, c.id);
    expect(r.changed).toBe(true);
    expect(r.domainAlsoUsedBy).toEqual({ href: `/contacts?company=${twin.id}`, label: `C-${twin.id} Gone Again` });
    d = await detail.getCompanyDetail(c.id);
    expect(d?.deletedAt).toBeNull();
    const types = (await db.activityLog.findMany({ where: { companyId: c.id }, orderBy: { id: "asc" } })).map((l) => l.type);
    expect(types).toEqual(["company.deleted", "company.restored"]);
  });

  it("returns null for an id that doesn't exist", async () => {
    expect(await detail.getCompanyDetail(999_999)).toBeNull();
    expect(await detail.getCompanyDetail(0)).toBeNull();
    expect((await caught(m.renameCompany(ali, 999_999, "X"))).message).toBe(
      "This company doesn't exist any more. Refresh the page to see the latest.",
    );
  });
});

describe("detail and timeline", () => {
  it("loads who emailed the company, the campaign name and the sequence rows", async () => {
    const c = await makeCompany({ name: "Emailed Co" });
    const p = await people.addPerson(ali, c.id, { name: "Jo", email: "jo@emailed.de" });
    const campaign = await dbTx((tx) =>
      tx.campaign.create({ data: { name: "Germany Q4", status: "RUNNING", mode: "LIVE", createdById: ali.id } }),
    );
    const draft = await dbTx((tx) => tx.campaign.create({ data: { name: "Draft", status: "DRAFT", createdById: ali.id } }));
    const sentAt = new Date(Date.now() - 12 * 86_400_000);
    const due = new Date(Date.now() + 5 * 86_400_000);
    await dbTx(async (tx) => {
      await tx.company.update({
        where: { id: c.id },
        data: { lastEmailedAt: sentAt, lastContactAt: sentAt, lastEmailedById: ali.id, lastEmailedCampaignId: campaign.id, lastEmailedStep: 1 },
      });
      await tx.person.update({
        where: { id: p.personId },
        data: { lastEmailedAt: sentAt, lastEmailedById: ali.id, lastEmailedCampaignId: campaign.id, lastEmailedStep: 1 },
      });
      await tx.campaignRecipient.create({
        data: { campaignId: campaign.id, companyId: c.id, personId: p.personId, emailNorm: "jo@emailed.de", state: "WAITING", currentStep: 2, nextDueAt: due },
      });
      await tx.campaignRecipient.create({
        data: { campaignId: draft.id, companyId: c.id, personId: p.personId, emailNorm: "jo@emailed.de", state: "PENDING" },
      });
    });
    const d = await detail.getCompanyDetail(c.id);
    expect(d?.lastEmailedBy?.name).toBe("Ali");
    expect(d?.lastEmailedCampaignName).toBe("Germany Q4");
    expect(d?.sequences).toHaveLength(1);
    expect(d?.sequences[0]).toMatchObject({ campaignName: "Germany Q4", state: "WAITING", currentStep: 2, campaignMode: "LIVE" });
    expect(d?.people[0]?.sequences).toHaveLength(1);
    expect(d?.people[0]?.lastEmailedCampaignName).toBe("Germany Q4");
  });

  it("pages the timeline 30 at a time and filters by kind", async () => {
    const c = await makeCompany({ name: "Busy Co" });
    const base = Date.now() - 100 * 60_000;
    await dbTx(async (tx) => {
      for (let i = 0; i < 34; i++) {
        await tx.activityLog.create({
          data: {
            at: new Date(base + i * 60_000),
            companyId: c.id,
            actorId: i % 2 ? ali.id : null,
            type: i % 3 === 0 ? "email.sent" : i % 3 === 1 ? "reply.received" : "company.updated",
            summary: `Event ${i}`,
          },
        });
      }
      // Two rows at the very same moment: the id breaks the tie, nothing is skipped.
      const same = new Date(base + 50 * 60_000);
      await tx.activityLog.create({ data: { at: same, companyId: c.id, type: "company.notes", summary: "Tie A" } });
      await tx.activityLog.create({ data: { at: same, companyId: c.id, type: "company.notes", summary: "Tie B" } });
    });
    const p1 = await detail.getCompanyTimeline(c.id, { filter: "all" });
    expect(p1.entries).toHaveLength(30);
    expect(p1.entries[0]?.summary).toBe("Tie B");
    expect(p1.entries[1]?.summary).toBe("Tie A");
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await detail.getCompanyTimeline(c.id, { filter: "all", cursor: p1.nextCursor });
    expect(p2.entries).toHaveLength(6);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.entries, ...p2.entries].map((e) => e.id);
    expect(new Set(all).size).toBe(36);
    expect(p1.entries.find((e) => e.summary === "Event 1")?.actorName ?? p2.entries.find((e) => e.summary === "Event 1")?.actorName).toBe("Ali");

    const emails = await detail.getCompanyTimeline(c.id, { filter: "emails" });
    expect(emails.entries.every((e) => e.type.startsWith("email."))).toBe(true);
    expect(emails.entries).toHaveLength(12);
    const replies = await detail.getCompanyTimeline(c.id, { filter: "replies" });
    expect(replies.entries.every((e) => e.type.startsWith("reply."))).toBe(true);
    const changes = await detail.getCompanyTimeline(c.id, { filter: "changes" });
    expect(changes.entries.every((e) => !e.type.startsWith("email.") && !e.type.startsWith("reply."))).toBe(true);
    expect(changes.entries).toHaveLength(13);
    expect(detail.decodeTimelineCursor("garbage")).toBeNull();
  });

  it("lists the pickers' options", async () => {
    const o = await detail.getPanelOptions();
    expect(o.lists.map((l) => l.name)).toContain("Germany Q4");
    expect(o.tags.map((x) => x.name)).toContain("Figurines");
    expect(o.niches).toContain("Tabletop miniatures");
    expect(o.customFields).toEqual([{ key: "members", label: "Members" }]);
  });
});
