import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

/**
 * The campaign page and the Contacts "Sequence" column with people on hold and stopped by replies (M4-DESIGN §2.11,
 * §2.12, §9.3): the step lines count held emails apart ("· 5 on hold") and leave them out of "waiting" and the next due
 * time, the notices count companies waiting for a possible reply and people held after the PC was off, and the
 * recipient texts come from the hold reason and the M4 stop codes.
 */

const t = await createTestDb("campaign-pages-holds");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const queries = await import("@/server/services/campaigns/queries");
const { setState } = await import("@/server/state");
const loop = await import("@/server/services/sending/loop");
const format = await import("@/components/campaigns/format");

const TZ = "Europe/Berlin";
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let owner: { id: number };
let campaignId = 0;
const companies: number[] = [];

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER" });
  await setSettingValue("practice.copy", false);
  const recipients = [];
  for (let i = 0; i < 8; i++) {
    const { company, people } = await makeCompany({ name: `Held Page ${i}`, people: [{ name: `P ${i}`, email: `p${i}@held-page-${i}.de` }] });
    companies.push(company.id);
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({ name: "Held page", createdById: owner.id, steps: STEPS, recipients });
  await launchCampaign(draft.id, owner.id);
  campaignId = draft.id;
  // Every first email goes (dry run); each person then waits for follow-up 1.
  expect((await loop.sendingTick()).sent).toBe(8);
  const rs = await db.campaignRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
  await dbWrite(async (c) => {
    // Two companies wait for a possible reply, three people for the outage check (one of them for both).
    for (const r of rs.slice(0, 2)) await c.campaignRecipient.update({ where: { id: r.id }, data: { state: "HELD", holdReason: "possible-reply", heldAt: new Date() } });
    for (const r of rs.slice(2, 4)) await c.campaignRecipient.update({ where: { id: r.id }, data: { state: "HELD", holdReason: "outage", heldAt: new Date() } });
    await c.campaignRecipient.update({ where: { id: rs[4]!.id }, data: { state: "HELD", holdReason: "outage,possible-reply", heldAt: new Date() } });
    await c.campaignRecipient.update({ where: { id: rs[5]!.id }, data: { state: "STOPPED", stopReason: "replied" } });
    await c.outboundEmail.updateMany({ where: { recipientId: rs[5]!.id, status: "QUEUED" }, data: { status: "SKIPPED", lastError: "Stopped: they replied" } });
    await c.campaignRecipient.update({ where: { id: rs[6]!.id }, data: { state: "STOPPED", stopReason: "company_replied" } });
    await c.outboundEmail.updateMany({ where: { recipientId: rs[6]!.id, status: "QUEUED" }, data: { status: "SKIPPED", lastError: "Stopped: someone at the company replied" } });
  });
  await setState("catchup.outage", {
    detectedAt: "2026-10-09T08:00:00.000Z",
    from: "2026-10-03T06:00:00.000Z",
    to: "2026-10-09T06:00:00.000Z",
    beyondLogRetention: true,
    beyondMessageRetention: false,
    handledAt: "2026-10-09T08:05:00.000Z",
    heldFor: "2026-10-03T06:00:00.000Z",
    heldTo: "2026-10-09T06:00:00.000Z",
    heldCount: 3,
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the campaign overview", () => {
  it("counts held emails apart from the waiting ones", async () => {
    const o = (await queries.getCampaignOverview(campaignId))!;
    const follow = o.steps.find((s) => s.step === 1)!;
    expect(follow).toMatchObject({ waiting: 1, held: 5, skipped: 2 });
    const free = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1, status: "QUEUED", recipient: { state: "WAITING" } } });
    expect(follow.nextDueAt).toEqual(free.dueAt);
    expect(o.emailsWaiting).toBe(1);
    expect(format.stepProgressText(follow, TZ, new Date(free.dueAt.getTime() - 86_400_000))).toMatch(/^Follow-up 1: 1 waiting, next on \d+ \w+, 2 skipped · 5 on hold$/);
  });

  it("says who is on hold and why", async () => {
    const o = (await queries.getCampaignOverview(campaignId))!;
    expect(o.holds).toEqual({
      possibleReplyCompanies: 3,
      outage: { followUps: 3, firstEmails: 0 },
      outageFrom: "2026-10-03T06:00:00.000Z",
      outageTo: "2026-10-09T06:00:00.000Z",
    });
    const now = new Date("2026-10-10T10:00:00Z");
    expect(format.possibleReplyNotice(o.holds.possibleReplyCompanies)).toBe(
      "Follow-ups to 3 companies are on hold until someone checks a possible reply.",
    );
    expect(format.outageHoldNotice(o.holds, { senderName: "Arslan", viewerIsSender: false, viewerIsOwner: false, timeZone: TZ, now })).toBe(
      // SPEC-03: the dates are the replies that may have been missed, not the PC's off-time.
      "Follow-ups of 3 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Arslan can continue them from Notifications after checking their inbox.",
    );
  });

  it("words every person's state from the hold reason and the reply stop codes", async () => {
    const list = await queries.listCampaignRecipients(campaignId, {});
    const now = new Date();
    const texts = list.rows.map((r) => format.toRecipientRowView(r, { campaignId, campaignStatus: "RUNNING", query: {} }, TZ, now).stateText);
    expect(texts.filter((x) => x === "On hold: a possible reply needs checking")).toHaveLength(3);
    expect(texts.filter((x) => x === "On hold: replies may have been missed while the PC was off")).toHaveLength(2);
    expect(texts).toContain("Stopped: they replied");
    expect(texts).toContain("Stopped: someone at the company replied");
    const held = list.rows.find((r) => r.holdReason === "outage")!;
    expect((await queries.getRecipientDetail(campaignId, held.id))?.holdReason).toBe("outage");
  });

  it("the Contacts Sequence column reads the hold and whether the campaign counts as emailed", async () => {
    const map = await queries.companySequences(companies);
    const first = map.get(companies[0]!)!;
    expect(first[0]).toMatchObject({ holdReason: "possible-reply", countsAsEmailed: false });
    expect(first[0]).not.toHaveProperty("countsAsReal");
    expect(format.companySequenceLabel(first, TZ)?.text).toBe("On hold: a possible reply needs checking (dry run)");
    const replied = map.get(companies[5]!)!;
    expect(format.companySequenceLabel(replied, TZ)?.text).toBe("Stopped: they replied (dry run)");
  });
});
