import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-preview-own");
const { db } = await import("@/server/db");
const draft = await import("@/server/services/campaigns/draft");
const { notDraftText } = await import("@/server/services/campaigns/audience");
const { LAUNCHING_TEXT } = await import("@/server/services/campaigns/launch");
const { isNotDraftError } = await import("@/components/campaign-wizard/save-queue");

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const steps = [
  { step: 0, enabled: true, subject: "3D models for {{company}}", body: "Hi {{first_name|there}}", delayDays: 0 },
  { step: 1, enabled: true, subject: null, body: "Any thoughts?", delayDays: 3 },
];

describe("the Message step's preview for someone edited in Review", () => {
  it("says when the person has their own version, and uses their own first subject for a follow-up's Re: line", async () => {
    const co = await makeCompany({
      name: "Printwerk",
      people: [
        { name: "Anna Berg", email: "anna@printwerk.de" },
        { name: "Ben Kurz", email: "ben@printwerk.de" },
      ],
    });
    const d = await draft.createDraft(ali, { companyIds: [co.company.id] });
    await draft.saveDraftSteps(ali, d.id, steps);
    const anna = co.people[0]!.id;
    const ben = co.people[1]!.id;
    const annaRow = await db.campaignRecipient.findUniqueOrThrow({ where: { campaignId_personId: { campaignId: d.id, personId: anna } } });
    // The Message step's unsaved text.
    const unsaved = { subject: "New subject for {{company}}", body: "Hello {{first_name}}" };

    const plain = await draft.previewDraftEmail(d.id, { personId: anna, step: 0, ...unsaved });
    expect(plain.ownVersion).toBeNull();
    expect(plain.subject).toBe("New subject for Printwerk");

    // In Review, Anna's first email gets its own subject and body.
    await draft.editDraftRecipientEmail(ali, d.id, annaRow.id, 0, { subject: "A question for {{company}}", body: "Hi Anna, a short one." });
    const first = await draft.previewDraftEmail(d.id, { personId: anna, step: 0, ...unsaved });
    expect(first.ownVersion).toBe("email");
    // The preview still shows the campaign's text being edited (that's what the step is for).
    expect(first.subject).toBe("New subject for Printwerk");
    expect(first.text.startsWith("Hello Anna")).toBe(true);

    // Follow-up 1: the campaign's body, but the "Re:" line she'll really get.
    const follow = await draft.previewDraftEmail(d.id, { personId: anna, step: 1, subject: unsaved.subject, body: "Any thoughts, {{first_name}}?" });
    expect(follow.ownVersion).toBe("subject");
    expect(follow.subject).toBe("Re: A question for Printwerk");
    expect(follow.text.startsWith("Any thoughts, Anna?")).toBe(true);

    // Her follow-up edited too.
    await draft.editDraftRecipientEmail(ali, d.id, annaRow.id, 1, { body: "Anna's own follow-up." });
    const followOwn = await draft.previewDraftEmail(d.id, { personId: anna, step: 1, subject: unsaved.subject, body: "Any thoughts?" });
    expect(followOwn.ownVersion).toBe("email");

    // Only the body of her first email edited: follow-ups keep the campaign's subject.
    await draft.editDraftRecipientEmail(ali, d.id, annaRow.id, 0, { subject: "3D models for {{company}}", body: "Hi Anna, a short one." });
    await draft.resetDraftRecipientEmail(ali, d.id, annaRow.id, 1);
    const bodyOnly = await draft.previewDraftEmail(d.id, { personId: anna, step: 1, subject: unsaved.subject, body: "Any thoughts?" });
    expect(bodyOnly.ownVersion).toBeNull();
    expect(bodyOnly.subject).toBe("Re: New subject for Printwerk");

    // Someone else gets the campaign's text.
    const other = await draft.previewDraftEmail(d.id, { personId: ben, step: 1, subject: unsaved.subject, body: "Any thoughts?" });
    expect(other.ownVersion).toBeNull();
    expect(other.subject).toBe("Re: New subject for Printwerk");
  });
});

describe("the Message step's save-before-leaving question", () => {
  it("recognises the service's refusal for a campaign that isn't a draft any more (and offers the campaign page)", () => {
    expect(isNotDraftError(notDraftText("RUNNING"))).toBe(true);
    expect(isNotDraftError(notDraftText("PAUSED"))).toBe(true);
    expect(isNotDraftError(notDraftText("CANCELLED"))).toBe(true);
  });

  it("treats a save refused while the draft is being launched (SEC-3) the same way", () => {
    // loadDraftForChange refuses with LAUNCHING_TEXT (code "launching") while a launch runs.
    expect(isNotDraftError(LAUNCHING_TEXT)).toBe(true);
  });
});
