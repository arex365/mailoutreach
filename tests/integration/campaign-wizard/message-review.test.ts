import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-message");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { refreshCompanySearchText } = await import("@/server/company-search");
const draft = await import("@/server/services/campaigns/draft");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { getTemplate, createTemplate, saveSteps } = await import("@/server/services/templates");

let arslan: { id: number; name: string };
let ali: { id: number; name: string };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { signature: "Ali Khan\nPolygon Paradise" } }));
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const seq = (steps: Array<Partial<{ step: number; enabled: boolean; subject: string | null; body: string; delayDays: number }>>) =>
  steps.map((s, i) => ({
    step: s.step ?? i,
    enabled: s.enabled ?? true,
    subject: (s.step ?? i) === 0 ? (s.subject ?? "Hello {{company}}") : null,
    body: s.body ?? `Body ${i}`,
    delayDays: (s.step ?? i) === 0 ? 0 : (s.delayDays ?? 3),
  }));

describe("message and sequence", () => {
  it("autosaves text as typed; the check before Continue uses the templates' rules", async () => {
    const d = await draft.createDraft(ali, {});
    const saved = await draft.saveDraftSteps(ali, d.id, seq([{ subject: "" , body: "Hi\r\nthere  " }, { body: "", delayDays: 0 }]));
    expect(saved.steps).toEqual([
      { step: 0, enabled: true, subject: "", body: "Hi\nthere  ", delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: "", delayDays: 0 },
    ]);
    expect(await draft.getDraftSteps(d.id)).toHaveLength(2);
    const checked = await draft.checkDraftMessage(d.id);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.fieldErrors["step0.subject"]).toEqual(["Write a subject for the first email."]);
      expect(checked.fieldErrors["step1.body"]).toEqual(["Write follow-up 1, or remove it."]);
      expect(checked.fieldErrors["step1.delayDays"]).toBeDefined();
    }
    await expect(draft.saveDraftSteps(ali, d.id, seq([{}, {}]).map((s) => ({ ...s, step: s.step * 2 })))).rejects.toBeInstanceOf(CampaignError);
    await expect(draft.saveDraftSteps(ali, d.id, seq([{ body: "x".repeat(50_000) }]))).rejects.toThrow(/too long to save/);
  });

  it("moves per-person edits with their follow-up when an earlier one is removed", async () => {
    const co = await makeCompany({ name: "Renumber Co", people: [{ name: "Rena", email: "rena@renumber.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id] });
    await draft.saveDraftSteps(ali, d.id, seq([{}, { body: "F1" }, { body: "F2" }, { body: "F3" }]));
    const row = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id } });
    await dbWrite((c) =>
      c.recipientEdit.createMany({
        data: [
          { recipientId: row.id, step: 1, body: "Rena's F1" },
          { recipientId: row.id, step: 3, body: "Rena's F3" },
        ],
      }),
    );
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: row.id }, data: { hasEdits: true } }));

    // Follow-up 1 removed: 2 → 1, 3 → 2.
    const res = await draft.saveDraftSteps(ali, d.id, seq([{}, { body: "F2" }, { body: "F3" }]), new Map([[1, null], [2, 1], [3, 2]]));
    expect(res).toMatchObject({ movedEdits: 1, removedEdits: 1 });
    const edits = await db.recipientEdit.findMany({ where: { recipientId: row.id } });
    expect(edits.map((e) => [e.step, e.body])).toEqual([[2, "Rena's F3"]]);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: row.id } })).hasEdits).toBe(true);

    // The last follow-up removed without a map: its edit goes too.
    await draft.saveDraftSteps(ali, d.id, seq([{}, { body: "F2" }]));
    expect(await db.recipientEdit.count({ where: { recipientId: row.id } })).toBe(0);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: row.id } })).hasEdits).toBe(false);
  });

  it("uses another template (edits reset) and saves the campaign's text back to its template", async () => {
    const co = await makeCompany({ name: "Template Co", people: [{ name: "Tia", email: "tia@template.de" }] });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id] });
    const created = await createTemplate(ali, "Short one");
    if (!created.ok) throw new Error(created.error);
    await saveSteps(ali, created.template.id, seq([{ subject: "Quick question for {{company}}", body: "Hi {{first_name|there}}" }]));

    const row = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id } });
    await dbWrite((c) => c.recipientEdit.create({ data: { recipientId: row.id, step: 0, body: "Mine" } }));
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: row.id }, data: { hasEdits: true } }));

    const applied = await draft.applyTemplateToDraft(ali, d.id, created.template.id);
    expect(applied).toMatchObject({ templateName: "Short one", clearedEdits: 1 });
    expect(applied.steps).toEqual([{ step: 0, enabled: true, subject: "Quick question for {{company}}", body: "Hi {{first_name|there}}", delayDays: 0 }]);
    expect((await draft.getDraftInfo(d.id))?.sourceTemplateId).toBe(created.template.id);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: row.id } })).hasEdits).toBe(false);

    // Edit in the campaign, then save back.
    await draft.saveDraftSteps(ali, d.id, seq([{ subject: "Quick question for {{company}}", body: "Hi {{first_name|there}}, new text" }, { body: "Any thoughts?", delayDays: 5 }]));
    const back = await draft.saveDraftStepsToTemplate(ali, d.id);
    expect(back).toEqual({ ok: true, templateId: created.template.id, templateName: "Short one" });
    const tpl = await getTemplate(created.template.id);
    expect(tpl?.steps.map((s) => [s.step, s.body, s.delayDays])).toEqual([
      [0, "Hi {{first_name|there}}, new text", 0],
      [1, "Any thoughts?", 5],
    ]);

    // Invalid text is refused with the field problems.
    await draft.saveDraftSteps(ali, d.id, seq([{ subject: "", body: "x" }]));
    const bad = await draft.saveDraftStepsToTemplate(ali, d.id);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors?.["step0.subject"]).toEqual(["Write a subject for the first email."]);

    await refusal(draft.applyTemplateToDraft(ali, d.id, 999_999), "template-gone");
  });

  it("previews unsaved text for a campaign recipient, as the campaign's sender", async () => {
    const co = await makeCompany({ name: "Preview GmbH", people: [{ name: "Paula Pan", email: "paula@preview.de" }] });
    await dbTx((tx) => refreshCompanySearchText(tx, [co.company.id]));
    const d = await draft.createDraft(arslan, { companyIds: [co.company.id] });
    await draft.setDraftSender(arslan, d.id, ali.id);
    const email = await draft.previewDraftEmail(d.id, {
      personId: co.people[0]!.id,
      step: 1,
      subject: "Models for {{company}}",
      body: "Hi {{first_name}},\n\n{{sender_signature}}",
    });
    expect(email.subject).toBe("Re: Models for Preview GmbH");
    expect(email.text.startsWith("Hi Paula,\n\nAli Khan\nPolygon Paradise")).toBe(true);

    const options = await draft.searchDraftRecipients(d.id, "paula");
    expect(options).toEqual([expect.objectContaining({ personId: co.people[0]!.id, name: "Paula Pan", companyName: "Preview GmbH", ticked: true })]);
    expect(await draft.searchDraftRecipients(d.id, "nobody-matches")).toEqual([]);
    expect((await draft.defaultDraftRecipient(d.id))?.personId).toBe(co.people[0]!.id);
  });
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

describe("review", () => {
  let d: { id: number };
  let people: Record<string, number>;

  beforeAll(async () => {
    const named = await makeCompany({ name: "Review Named", people: [{ name: "Nina Neu", email: "nina@named.de" }] });
    const inbox = await makeCompany({ name: "Review Inbox", people: [{ name: "General inbox", email: "info@inbox.de", isGeneric: true }] });
    const two = await makeCompany({
      name: "Review Two",
      people: [
        { name: "Tom", email: "tom@two.de" },
        { name: "Una", email: "una@two.de", unsubscribedAt: new Date() },
        { name: "Tess", email: "tess@two.de" },
      ],
    });
    d = await draft.createDraft(ali, { companyIds: [named.company.id, inbox.company.id, two.company.id] });
    // {{first_name}} without a fallback: missing for the General inbox in both steps.
    await draft.saveDraftSteps(
      ali,
      d.id,
      seq([
        { subject: "Hi {{first_name}} at {{company}}", body: "Hello {{first_name}},\n\nText." },
        { body: "Following up, {{first_name|there}}." },
        { body: "Off one", enabled: false },
      ]),
    );
    people = {
      nina: named.people[0]!.id,
      inbox: inbox.people[0]!.id,
      tom: two.people[0]!.id,
      una: two.people[1]!.id,
      tess: two.people[2]!.id,
    };
  });

  it("lists everyone who'll get the email with missing-detail counts, and everyone left out with the reason", async () => {
    const page = await draft.loadReviewPage(d.id);
    expect(page.steps).toEqual([0, 1]);
    expect(page.counts).toEqual({ all: 3, missing: 1, text: 0, edited: 0, excluded: 2 });
    // {{first_name}} is a real variable: nothing wrong with the text itself.
    expect(page.textProblems).toEqual([]);
    expect(page.missingEmails).toBe(1);
    expect(page.items.map((i) => [i.name, i.missing])).toEqual([
      ["General inbox", 1],
      ["Nina Neu", 0],
      ["Tom", 0],
    ]);
    const missing = await draft.loadReviewPage(d.id, { filter: "missing" });
    expect(missing.items.map((i) => i.name)).toEqual(["General inbox"]);
    const excluded = await draft.loadReviewPage(d.id, { filter: "excluded" });
    expect(excluded.items.map((i) => [i.name, i.reason, i.canInclude])).toEqual([
      ["Una", "Unsubscribed", false],
      ["Tess", "Not ticked", true],
    ]);
    const search = await draft.loadReviewPage(d.id, { q: "nina" });
    expect(search.items.map((i) => i.name)).toEqual(["Nina Neu"]);
    expect((await draft.loadReviewPage(d.id, { filter: "edited" })).total).toBe(0);
  });

  it("shows every switched-on step exactly as rendered, and edits one person's email", async () => {
    const detail = await draft.loadReviewDetail(d.id, people.nina!);
    expect(detail).toMatchObject({ name: "Nina Neu", companyName: "Review Named", willGet: true, reason: null });
    expect(detail.emails.map((e) => [e.title, e.email.subject])).toEqual([
      ["First email", "Hi Nina at Review Named"],
      ["Follow-up 1", "Re: Hi Nina at Review Named"],
    ]);
    expect(detail.emails[0]!.email.text).toContain("[unsubscribe link]");
    expect(detail.emails[0]!.source).toEqual({ subject: "Hi {{first_name}} at {{company}}", body: "Hello {{first_name}},\n\nText." });

    const rid = detail.recipientId!;
    // Same text as the campaign's: nothing is stored.
    const same = await draft.editDraftRecipientEmail(ali, d.id, rid, 0, { subject: "Hi {{first_name}} at {{company}}", body: "Hello {{first_name}},\n\nText.  " });
    expect(same.edited).toBe(false);
    expect(await db.recipientEdit.count({ where: { recipientId: rid } })).toBe(0);

    const saved = await draft.editDraftRecipientEmail(ali, d.id, rid, 0, { subject: "A note for {{company}}", body: "Hello Nina,\n\nJust for you." });
    expect(saved.edited).toBe(true);
    const after = await draft.loadReviewDetail(d.id, people.nina!);
    expect(after.emails[0]).toMatchObject({ edited: true, editedBy: "Ali", source: { subject: "A note for {{company}}", body: "Hello Nina,\n\nJust for you." } });
    expect(after.emails[0]!.email.subject).toBe("A note for Review Named");
    // The follow-up follows this person's first subject.
    expect(after.emails[1]!.email.subject).toBe("Re: A note for Review Named");
    expect((await draft.loadReviewPage(d.id, { filter: "edited" })).items.map((i) => i.name)).toEqual(["Nina Neu"]);

    // Only the body changed on the follow-up: the subject isn't stored.
    await draft.editDraftRecipientEmail(ali, d.id, rid, 1, { body: "Following up, Nina." });
    const edit1 = await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: rid, step: 1 } } });
    expect(edit1.subject).toBeNull();

    await draft.resetDraftRecipientEmail(ali, d.id, rid, 0);
    await draft.resetDraftRecipientEmail(ali, d.id, rid, 1);
    const reset = await draft.loadReviewDetail(d.id, people.nina!);
    expect(reset.emails.every((e) => !e.edited)).toBe(true);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: rid } })).hasEdits).toBe(false);
  });

  it("explains why someone left out won't get it", async () => {
    const una = await draft.loadReviewDetail(d.id, people.una!);
    expect(una).toMatchObject({ willGet: false, canInclude: false, reason: "Unsubscribed" });
    const tess = await draft.loadReviewDetail(d.id, people.tess!);
    expect(tess).toMatchObject({ willGet: false, canInclude: true, reason: "Not ticked" });
    await refusal(draft.editDraftRecipientEmail(ali, d.id, 999_999, 0, { body: "x" }), "not-in-campaign");
  });
});
