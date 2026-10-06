import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-draft");
const { db, dbWrite } = await import("@/server/db");
const draft = await import("@/server/services/campaigns/draft");
const audience = await import("@/server/services/campaigns/audience");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { getMasterTemplate } = await import("@/server/services/templates");

let arslan: { id: number; name: string };
let ali: { id: number; name: string };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali", { email: "ali.khan@polygonparadise.test" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function refusal(p: Promise<unknown>, code: string): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  expect((err as InstanceType<typeof CampaignError>).code).toBe(code);
  return err as Error;
}

describe("creating a draft", () => {
  it("starts blank from the master template, sent by the creator", async () => {
    const now = new Date("2026-09-23T10:00:00Z");
    const res = await draft.createDraft(ali, { timeZone: "Asia/Karachi", now });
    expect(res.reused).toBe(false);
    expect(res.name).toBe("Campaign · 23 Sep");
    expect(res.added).toBeNull();

    const c = await db.campaign.findUniqueOrThrow({ where: { id: res.id }, include: { steps: { orderBy: { step: "asc" } } } });
    const master = await getMasterTemplate();
    expect(c.status).toBe("DRAFT");
    expect(c.wizardStep).toBe(1);
    expect(c.senderId).toBe(ali.id);
    expect(c.createdById).toBe(ali.id);
    expect(c.sourceTemplateId).toBe(master.id);
    // Every template step is copied with its switch: the master's follow-up 3 is off but can be switched on.
    expect(c.steps.map((s) => [s.step, s.enabled, s.delayDays])).toEqual(master.steps.map((s) => [s.step, s.enabled, s.delayDays]));
    expect(c.steps[0]!.subject).toBe(master.steps[0]!.subject);
    expect(c.steps.slice(1).every((s) => s.subject === null)).toBe(true);
    expect(audience.readAudienceJson(c.audience)).toMatchObject({ companyIds: [], origin: "blank" });

    const log = await db.activityLog.findFirst({ where: { campaignId: res.id, type: "campaign.created" } });
    expect(log?.summary).toBe(`Ali started the campaign ${res.name}`);
  });

  it("uses the creator's own time zone for the default name", () => {
    const late = new Date("2026-09-23T21:30:00Z");
    expect(draft.defaultDraftName(late, "Asia/Karachi")).toBe("Campaign · 24 Sep");
    expect(draft.defaultDraftName(late, "Europe/Berlin")).toBe("Campaign · 23 Sep");
  });

  it("starts from companies ticked on Contacts: default people ticked, the rest left out", async () => {
    const a = await makeCompany({
      name: "Tick Alpha",
      people: [
        { name: "Nora", email: "nora@alpha.de" },
        { name: "Anna", email: "anna@alpha.de", verificationStatus: "VALID", verifiedAt: new Date() },
      ],
    });
    const b = await makeCompany({
      name: "Tick Beta",
      people: [
        { name: "General inbox", email: "info@beta.de", isGeneric: true },
        { name: "Bob", email: "bob@beta.de" },
      ],
    });
    const client = await makeCompany({ name: "Tick Client", status: "CLIENT", people: [{ name: "Carl", email: "carl@client.de" }] });
    const nobody = await makeCompany({ name: "Tick No email", people: [{ name: "Dora", email: null }] });
    const gone = await makeCompany({ name: "Tick Deleted", deletedAt: new Date(), people: [{ name: "Eve", email: "eve@deleted.de" }] });
    const unsub = await makeCompany({
      name: "Tick Unsub",
      people: [
        { name: "Uma", email: "uma@unsub.de", unsubscribedAt: new Date() },
        { name: "Vic", email: "vic@unsub.de" },
      ],
    });

    const ids = [a.company.id, b.company.id, client.company.id, nobody.company.id, gone.company.id, unsub.company.id, a.company.id];
    const res = await draft.createDraft(arslan, { companyIds: ids, timeZone: "UTC" });
    expect(res.added).toMatchObject({ added: 5, alreadyIn: 0, notFound: 1, capped: 0 });

    const rows = await db.campaignRecipient.findMany({ where: { campaignId: res.id }, include: { person: true } });
    const ticked = rows.filter((r) => r.included).map((r) => r.person.name).sort();
    // Alpha: the checked address first. Beta: the named person before the General inbox. Unsub: Vic, not Uma.
    // The Client company is excluded, so nobody there is ticked; people without email get no row.
    expect(ticked).toEqual(["Anna", "Bob", "Vic"]);
    expect(rows.map((r) => r.person.name).sort()).toEqual(["Anna", "Bob", "Carl", "General inbox", "Nora", "Uma", "Vic"]);
    expect(res.added?.ticked).toBe(3);

    const json = audience.readAudienceJson((await db.campaign.findUniqueOrThrow({ where: { id: res.id } })).audience);
    expect(json.companyIds).toEqual([a.company.id, b.company.id, client.company.id, nobody.company.id, unsub.company.id]);
    expect(json.sources).toEqual([expect.objectContaining({ kind: "selection", label: "6 companies ticked on Contacts", added: 5 })]);
  });

  it("reuses a draft started the same way moments ago (double click), but not a different start", async () => {
    const x = await makeCompany({ name: "Twin X", people: [{ name: "Xena", email: "xena@twin.de" }] });
    const y = await makeCompany({ name: "Twin Y", people: [{ name: "Yan", email: "yan@twin.de" }] });
    const first = await draft.createDraft(ali, { companyIds: [x.company.id, y.company.id], reuseWithinMs: 10_000 });
    const again = await draft.createDraft(ali, { companyIds: [y.company.id, x.company.id], reuseWithinMs: 10_000 });
    expect(again).toMatchObject({ id: first.id, reused: true });
    const other = await draft.createDraft(ali, { companyIds: [x.company.id], reuseWithinMs: 10_000 });
    expect(other.id).not.toBe(first.id);
    const someoneElse = await draft.createDraft(arslan, { companyIds: [x.company.id, y.company.id], reuseWithinMs: 10_000 });
    expect(someoneElse.id).not.toBe(first.id);
  });

  it("starts from a list, named after it; a missing list starts empty", async () => {
    const list = await dbWrite((c) => c.list.create({ data: { name: "Germany Q4" } }));
    const one = await makeCompany({ name: "List One", people: [{ name: "Lia", email: "lia@one.de" }] });
    const two = await makeCompany({ name: "List Two", people: [{ name: "Leo", email: "leo@two.de" }] });
    const deleted = await makeCompany({ name: "List Gone", deletedAt: new Date(), people: [{ name: "Lou", email: "lou@gone.de" }] });
    await dbWrite((c) =>
      c.companyList.createMany({
        data: [one, two, deleted].map((x) => ({ companyId: x.company.id, listId: list.id })),
      }),
    );
    const res = await draft.createDraft(ali, { listId: list.id });
    expect(res.name).toBe("Germany Q4");
    expect(res.added).toMatchObject({ added: 2, notFound: 0 });
    const json = audience.readAudienceJson((await db.campaign.findUniqueOrThrow({ where: { id: res.id } })).audience);
    expect(json.sources[0]).toMatchObject({ kind: "list", label: "List: Germany Q4" });

    const missing = await draft.createDraft(ali, { listId: 999_999, timeZone: "UTC" });
    expect(missing.listMissing).toBe(true);
    expect(missing.added).toBeNull();
    expect(missing.name.startsWith("Campaign · ")).toBe(true);
  });
});

describe("renaming, deleting and progress", () => {
  it("renames with checks and logs it", async () => {
    const d = await draft.createDraft(ali, {});
    await refusal(draft.renameDraft(ali, d.id, "   "), "bad-name");
    await refusal(draft.renameDraft(ali, d.id, "x".repeat(121)), "bad-name");
    expect(await draft.renameDraft(ali, d.id, "  Norway   prints ")).toEqual({ name: "Norway prints", changed: true });
    expect(await draft.renameDraft(ali, d.id, "Norway prints")).toEqual({ name: "Norway prints", changed: false });
    const log = await db.activityLog.findFirst({ where: { campaignId: d.id, type: "campaign.renamed" } });
    expect(log?.summary).toMatch(/renamed the campaign .* to Norway prints$/);
  });

  it("remembers the furthest step, never going back", async () => {
    const d = await draft.createDraft(ali, {});
    await draft.setWizardStep(d.id, 3);
    await draft.setWizardStep(d.id, 2);
    expect((await draft.getDraftInfo(d.id))?.wizardStep).toBe(3);
    await draft.setWizardStep(d.id, 99);
    expect((await draft.getDraftInfo(d.id))?.wizardStep).toBe(6);
  });

  it("deletes a draft with everything in it, but never a launched campaign", async () => {
    const co = await makeCompany({ name: "Delete Me", people: [{ name: "Dee", email: "dee@deleteme.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id] });
    expect(await db.campaignRecipient.count({ where: { campaignId: d.id } })).toBe(1);
    expect(await draft.deleteDraft(arslan, d.id)).toEqual({ name: d.name });
    expect(await db.campaign.findUnique({ where: { id: d.id } })).toBeNull();
    expect(await db.campaignRecipient.count({ where: { campaignId: d.id } })).toBe(0);
    expect(await db.campaignStep.count({ where: { campaignId: d.id } })).toBe(0);
    const log = await db.activityLog.findFirst({ where: { campaignId: d.id, type: "campaign.deleted" } });
    expect(log?.summary).toBe(`Arslan deleted the draft campaign ${d.name}`);

    const running = await dbWrite((c) => c.campaign.create({ data: { name: "Running one", status: "RUNNING", createdById: ali.id } }));
    const err = await refusal(draft.deleteDraft(ali, running.id), "not-draft");
    expect(err.message).toMatch(/already been launched/);
    await refusal(draft.deleteDraft(ali, 987_654), "not-found");
  });
});

describe("sender", () => {
  it("lists active teammates with their dry-run From line and saves the choice", async () => {
    const sara = await makeUser("Sara", { email: "Sara.B@polygonparadise.test", senderDisplayName: "Sara from Polygon Paradise" });
    const off = await makeUser("Olli", { email: "olli@polygonparadise.test" });
    await dbWrite((c) => c.user.update({ where: { id: off.id }, data: { active: false } }));

    const choices = await draft.listSenderChoices();
    expect(choices.map((c) => c.name)).toEqual(expect.arrayContaining(["Ali", "Arslan", "Sara"]));
    expect(choices.some((c) => c.name === "Olli")).toBe(false);
    const s = choices.find((c) => c.id === sara.id)!;
    expect(s).toMatchObject({
      fromName: "Sara from Polygon Paradise",
      fromLine: "Sara from Polygon Paradise <sara.b@your-sending-domain>",
      placeholderAddress: true,
    });

    const d = await draft.createDraft(ali, {});
    expect(await draft.setDraftSender(ali, d.id, sara.id)).toEqual({ senderName: "Sara", changed: true });
    expect((await draft.getDraftInfo(d.id))?.senderId).toBe(sara.id);
    await refusal(draft.setDraftSender(ali, d.id, off.id), "sender-off");
    const log = await db.activityLog.findFirst({ where: { campaignId: d.id, type: "campaign.sender" } });
    expect(log?.summary).toBe(`Ali chose Sara to send ${d.name}`);
  });
});
