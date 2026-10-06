import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-launch");
const { db, dbWrite } = await import("@/server/db");
const draft = await import("@/server/services/campaigns/draft");
const audience = await import("@/server/services/campaigns/audience");
const { CampaignError } = await import("@/server/services/campaigns/errors");

let arslan: { id: number; name: string };
let ali: { id: number; name: string };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali", { email: "ali.khan@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" });
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

async function sampleDraft(name: string) {
  const slug = name.toLowerCase().replace(/\W+/g, "");
  const a = await makeCompany({
    name: `${name} A`,
    people: [
      { name: "Anna", email: `anna@${slug}-a.de` },
      { name: "Uwe", email: `uwe@${slug}-a.de`, unsubscribedAt: new Date() },
      { name: "Axel", email: `axel@${slug}-a.de` },
    ],
  });
  const inbox = await makeCompany({ name: `${name} Inbox`, people: [{ name: "General inbox", email: `info@${slug}-i.de`, isGeneric: true }] });
  const client = await makeCompany({ name: `${name} Client`, status: "CLIENT", people: [{ name: "Cora", email: `cora@${slug}-c.de` }] });
  const d = await draft.createDraft(arslan, { companyIds: [a.company.id, inbox.company.id, client.company.id] });
  return { d, a, inbox, client };
}

describe("launch summary", () => {
  it("counts the emails, the follow-ups and the missing details, and lists what to fix", async () => {
    const { d } = await sampleDraft("Summary");
    await draft.saveDraftSteps(arslan, d.id, [
      { step: 0, enabled: true, subject: "Hi {{first_name}}", body: "Hello {{first_name|there}}", delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: "Again, {{first_name}}", delayDays: 3 },
      { step: 2, enabled: false, subject: null, body: "Off", delayDays: 4 },
    ]);
    const s = await draft.loadLaunchSummary(d.id);
    expect(s).toMatchObject({
      mode: "DRY_RUN",
      modeReady: true,
      practiceCopy: false,
      people: 2,
      companies: 2,
      excludedCompanies: 1,
      followUps: 1,
      // The General inbox has no first name: the subject and follow-up 1 miss it.
      missingEmails: 2,
      missingPeople: 1,
      senderName: "Arslan",
      problems: [],
    });

    await setSettingValue("sending.mode", "LIVE");
    expect((await draft.loadLaunchSummary(d.id)).modeReady).toBe(false);
    await setSettingValue("sending.mode", "DRY_RUN");

    const empty = await draft.createDraft(ali, {});
    await draft.saveDraftSteps(ali, empty.id, [{ step: 0, enabled: true, subject: "", body: "x", delayDays: 0 }]);
    const problems = (await draft.loadLaunchSummary(empty.id)).problems;
    expect(problems.map((p) => p.step)).toEqual(["audience", "message"]);
  });
});

describe("launching a draft", () => {
  it("hands over to the engine: reasons written for the unticked, first emails queued, the sender told", async () => {
    const { d, a, client } = await sampleDraft("Launch");
    await draft.setDraftSender(arslan, d.id, ali.id);
    const res = await draft.launchDraft(arslan, d.id);
    expect(res).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 2, newlyExcluded: 0 });
    expect(res.message).toMatch(/^Launched .* in dry run\. 2 first emails are on the way to the dry-run outbox\.$/);

    const rows = await db.campaignRecipient.findMany({ where: { campaignId: d.id }, include: { person: true }, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.person.name, r.state, r.exclusionReason])).toEqual([
      ["Anna", "SCHEDULED", null],
      ["Uwe", "EXCLUDED", "Unsubscribed"],
      ["Axel", "EXCLUDED", "Not ticked"],
      ["General inbox", "SCHEDULED", null],
      ["Cora", "EXCLUDED", "Company status is Client"],
    ]);
    const outbound = await db.outboundEmail.findMany({ where: { campaignId: d.id } });
    expect(outbound.map((o) => o.toNorm).sort()).toEqual([`anna@launch-a.de`, `info@launch-i.de`]);
    expect(outbound.every((o) => o.fromAddress === "Ali from Polygon Paradise <ali.khan@your-sending-domain>")).toBe(true);
    const note = await db.notification.findFirst({ where: { userId: ali.id, type: "campaign.sender" } });
    expect(note?.title).toBe(`Arslan launched ${d.name} with you as the sender`);
    expect(a.company.id).toBeGreaterThan(0);
    expect(client.company.id).toBeGreaterThan(0);

    // A launched campaign no longer opens in the wizard's actions.
    await refusal(draft.launchDraft(arslan, d.id), "not-draft");
    await refusal(audience.setPersonTicked(arslan, d.id, a.people[2]!.id, true), "not-draft");
  });

  it("schedules a start in the future, and refuses a start that has passed", async () => {
    const { d } = await sampleDraft("Later");
    const now = new Date();
    await refusal(draft.setDraftSchedule(arslan, d.id, { startAt: new Date(now.getTime() - 60_000) }, { now }), "past-start");
    await refusal(draft.setDraftSchedule(arslan, d.id, { startAt: new Date(now.getTime() + 400 * 86_400_000) }, { now }), "far-start");
    const start = new Date(now.getTime() + 2 * 86_400_000);
    expect(await draft.setDraftSchedule(arslan, d.id, { startAt: start, daysAsMinutes: true }, { now })).toEqual({ startAt: start, daysAsMinutes: true });
    const res = await draft.launchDraft(arslan, d.id);
    expect(res.status).toBe("SCHEDULED");
    expect(res.startAt.getTime()).toBe(start.getTime());
    const c = await db.campaign.findUniqueOrThrow({ where: { id: d.id } });
    expect(c).toMatchObject({ status: "SCHEDULED", daysAsMinutes: true, mode: "DRY_RUN" });
  });

  it("refuses a message that breaks the rules, and live mode while Mailgun isn't connected", async () => {
    const { d } = await sampleDraft("Bad message");
    await draft.saveDraftSteps(arslan, d.id, [
      { step: 0, enabled: true, subject: "Hi", body: "Hello", delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: "Again", delayDays: 0 },
    ]);
    const err = await refusal(draft.launchDraft(arslan, d.id), "message");
    expect(err.message).toMatch(/Open the Message step to fix it\.$/);

    await draft.saveDraftSteps(arslan, d.id, [{ step: 0, enabled: true, subject: "Hi", body: "Hello", delayDays: 0 }]);
    await setSettingValue("sending.mode", "LIVE");
    await refusal(draft.launchDraft(arslan, d.id), "mailgun-not-connected");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
  });

  it("launches in the practice copy with reservations taken, following sending hours by default", async () => {
    await setSettingValue("practice.copy", true);
    const { d } = await sampleDraft("Practice");
    const res = await draft.launchDraft(arslan, d.id);
    expect(res.status).toBe("RUNNING");
    expect(await db.companyReservation.count({ where: { campaignId: d.id, releasedAt: null } })).toBe(2);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).ignoreWindow).toBe(false);
    await dbWrite((c) => c.setting.update({ where: { key: "practice.copy" }, data: { value: false } }));
  });

  it("keeps the Schedule step's 'Ignore sending hours' choice for a dry run (default on for real data)", async () => {
    const on = await sampleDraft("Hours default");
    await draft.launchDraft(arslan, on.d.id);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: on.d.id } })).ignoreWindow).toBe(true);
    const off = await sampleDraft("Hours off");
    await draft.launchDraft(arslan, off.d.id, { ignoreWindow: false });
    const c = await db.campaign.findUniqueOrThrow({ where: { id: off.d.id } });
    expect(c.ignoreWindow).toBe(false);
  });
});
