import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-text-problems");
const { db, dbWrite } = await import("@/server/db");
const draft = await import("@/server/services/campaigns/draft");

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

type Step = { step: number; enabled: boolean; subject: string | null; body: string; delayDays: number };
const step = (n: number, body: string, over: Partial<Step> = {}): Step => ({
  step: n,
  enabled: true,
  subject: n === 0 ? "Hi {{first_name|there}}" : null,
  body,
  delayDays: n === 0 ? 0 : 3,
  ...over,
});

async function recipientOf(campaignId: number, personId: number): Promise<number> {
  return (await db.campaignRecipient.findUniqueOrThrow({ where: { campaignId_personId: { campaignId, personId } } })).id;
}

describe("unknown variables and broken braces are counted, apart from missing details (SPEC-5, TPL-2)", () => {
  it("counts the campaign's text once per step, and edited emails with their own problems", async () => {
    const nina = await makeCompany({ name: "Text Nina", people: [{ name: "Nina Neu", email: "nina@text-nina.de" }] });
    const tom = await makeCompany({ name: "Text Tom", people: [{ name: "Tom Tal", email: "tom@text-tom.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [nina.company.id, tom.company.id] });
    await draft.saveDraftSteps(ali, d.id, [
      step(0, "Hello {{frist_name|there}},\n\nText."),
      step(1, "Following up about {{company}"),
      step(2, "Off: {{nope}}", { enabled: false }),
    ]);

    let page = await draft.loadReviewPage(d.id);
    expect(page.textProblems).toEqual([
      { step: 0, unknown: ["frist_name"], syntax: false },
      { step: 1, unknown: [], syntax: true },
    ]);
    expect(page.editedTextProblems).toBe(0);
    // Not folded into missing details.
    expect(page.missingEmails).toBe(0);
    expect(page.counts).toMatchObject({ all: 2, missing: 0, text: 0 });

    // Nina's own follow-up has a new unknown name; Tom's first email only repeats the campaign's.
    const ninaRow = await recipientOf(d.id, nina.people[0]!.id);
    const tomRow = await recipientOf(d.id, tom.people[0]!.id);
    await draft.editDraftRecipientEmail(ali, d.id, ninaRow, 1, { body: "Hi Nina, about {{compnay}}." });
    await draft.editDraftRecipientEmail(ali, d.id, tomRow, 0, { subject: "Hi {{first_name|there}}", body: "Hello {{frist_name|there}}, just for you." });

    page = await draft.loadReviewPage(d.id);
    expect(page.editedTextProblems).toBe(1);
    expect(page.counts).toMatchObject({ text: 1, edited: 2 });
    expect(page.items.map((i) => [i.name, i.textProblems])).toEqual([
      ["Nina Neu", 1],
      ["Tom Tal", 0],
    ]);
    const filtered = await draft.loadReviewPage(d.id, { filter: "text" });
    expect(filtered.filter).toBe("text");
    expect(filtered.items.map((i) => i.name)).toEqual(["Nina Neu"]);

    const summary = await draft.loadLaunchSummary(d.id);
    expect(summary).toMatchObject({
      missingEmails: 0,
      textProblems: [
        { step: 0, unknown: ["frist_name"], syntax: false },
        { step: 1, unknown: [], syntax: true },
      ],
      editedTextProblems: 1,
      problems: [],
    });

    // Fixing the campaign's text: Tom's own copy still has the typo, so it now counts as his own.
    await draft.saveDraftSteps(ali, d.id, [step(0, "Hello {{first_name|there}},\n\nText."), step(1, "Following up about {{company}}.")]);
    page = await draft.loadReviewPage(d.id);
    expect(page.textProblems).toEqual([]);
    expect(page.editedTextProblems).toBe(2);
    expect((await draft.loadLaunchSummary(d.id)).textProblems).toEqual([]);
  });

  it("knows the custom fields from imports", async () => {
    await dbWrite((c) => c.customField.create({ data: { key: "est_revenue", label: "Est. revenue", entity: "COMPANY" } }));
    const co = await makeCompany({ name: "Text Custom", people: [{ name: "Cleo", email: "cleo@text-custom.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id] });
    await draft.saveDraftSteps(ali, d.id, [step(0, "Your revenue: {{est_revenue|unknown}}")]);
    expect((await draft.loadReviewPage(d.id)).textProblems).toEqual([]);
  });
});

describe("a person's own version follows later fixes to the campaign's body (TPL-6)", () => {
  it("updates edits that kept the old body (subject-only edits), and leaves rewritten ones alone", async () => {
    const a = await makeCompany({ name: "Follow Anna", people: [{ name: "Anna", email: "anna@follow-anna.de" }] });
    const b = await makeCompany({ name: "Follow Ben", people: [{ name: "Ben", email: "ben@follow-ben.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [a.company.id, b.company.id] });
    await draft.saveDraftSteps(ali, d.id, [step(0, "We do 3D modeling."), step(1, "F1"), step(2, "F2")]);
    const anna = await recipientOf(d.id, a.people[0]!.id);
    const ben = await recipientOf(d.id, b.people[0]!.id);

    // Anna: only the subject changed. Ben: his own body.
    await draft.editDraftRecipientEmail(ali, d.id, anna, 0, { subject: "A question for {{company}}", body: "We do 3D modeling.  " });
    await draft.editDraftRecipientEmail(ali, d.id, ben, 0, { subject: "Hi {{first_name|there}}", body: "Ben, we do 3D modeling for you." });

    const res = await draft.saveDraftSteps(ali, d.id, [step(0, "We do 3D modelling."), step(1, "F1"), step(2, "F2")]);
    expect(res.followedEdits).toBe(1);
    const annaEdit = await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: anna, step: 0 } } });
    expect(annaEdit).toMatchObject({ subject: "A question for {{company}}", body: "We do 3D modelling." });
    const benEdit = await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: ben, step: 0 } } });
    expect(benEdit.body).toBe("Ben, we do 3D modeling for you.");

    const detail = await draft.loadReviewDetail(d.id, a.people[0]!.id);
    expect(detail.emails[0]!.email.text.startsWith("We do 3D modelling.")).toBe(true);
    expect(detail.emails[0]!.email.subject).toBe("A question for Follow Anna");

    // A follow-up that moves (follow-up 1 removed) and changes at the same time: the edit that
    // kept its old text moves with it and follows the new text.
    await dbWrite((c) => c.recipientEdit.create({ data: { recipientId: anna, step: 2, body: "F2" } }));
    const moved = await draft.saveDraftSteps(ali, d.id, [step(0, "We do 3D modelling."), step(1, "F2, fixed")], new Map([[1, null], [2, 1]]));
    expect(moved).toMatchObject({ movedEdits: 1, followedEdits: 1 });
    const annaF = await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: anna, step: 1 } } });
    expect(annaF.body).toBe("F2, fixed");
  });
});

describe("the recipients' time zones for the Schedule step (SPEC-9)", () => {
  it("groups the people who'll get it by their company's zone; companies with none use the default zone", async () => {
    await setSettingValue("defaultTimeZone", "Europe/Paris");
    const oslo = await makeCompany({
      name: "Zone Oslo",
      people: [
        { name: "Ola", email: "ola@zone-oslo.no" },
        { name: "Kari", email: "kari@zone-oslo.no" },
      ],
    });
    const none1 = await makeCompany({ name: "Zone None One", people: [{ name: "Nils", email: "nils@zone-none1.de" }] });
    const none2 = await makeCompany({ name: "Zone None Two", people: [{ name: "Nora", email: "nora@zone-none2.de" }] });
    const paris = await makeCompany({ name: "Zone Paris", people: [{ name: "Paul", email: "paul@zone-paris.fr" }] });
    await dbWrite((c) => c.company.update({ where: { id: oslo.company.id }, data: { timeZone: "Europe/Oslo" } }));
    await dbWrite((c) => c.company.update({ where: { id: paris.company.id }, data: { timeZone: "Europe/Paris" } }));
    const d = await draft.createDraft(ali, { companyIds: [oslo.company.id, none1.company.id, none2.company.id, paris.company.id] });
    // Both Oslo people get it.
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: d.id, companyId: oslo.company.id }, data: { included: true } }));

    const s = await draft.loadLaunchSummary(d.id);
    expect(s.defaultTimeZone).toBe("Europe/Paris");
    expect(s.recipientZones).toEqual([
      { timeZone: "Europe/Paris", people: 3, defaulted: 2 },
      { timeZone: "Europe/Oslo", people: 2, defaulted: 0 },
    ]);
    await setSettingValue("defaultTimeZone", "Europe/Berlin");
  });
});

describe("Review for a company that replied (SPEC-12)", () => {
  it("says when putting the company back in would include the person", async () => {
    const co = await makeCompany({
      name: "Replied Studio",
      status: "REPLIED",
      people: [
        { name: "Rita", email: "rita@replied-studio.de" },
        { name: "Uli", email: "uli@replied-studio.de", unsubscribedAt: new Date() },
      ],
    });
    const other = await makeCompany({ name: "Plain Studio", people: [{ name: "Pia", email: "pia@plain-studio.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id, other.company.id] });

    const rita = await draft.loadReviewDetail(d.id, co.people[0]!.id);
    expect(rita).toMatchObject({ willGet: false, ticked: false, canInclude: false, companyCanPutBack: true });
    expect(rita.reason).toMatch(/Replied/);
    // Uli is unsubscribed: putting the company back wouldn't help him.
    expect((await draft.loadReviewDetail(d.id, co.people[1]!.id)).companyCanPutBack).toBe(false);
    expect((await draft.loadReviewDetail(d.id, other.people[0]!.id)).companyCanPutBack).toBe(false);
  });
});
