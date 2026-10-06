import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue, type StepSeed } from "../campaigns/seed";
import { launchTo, resetSendingState, setupM3, type M3World } from "../sending-m3/helpers";

/**
 * Follow-up scheduling through markSent and the sweeper (SPEC "follow-up scheduling", PLAN A5.4, B6.4; M4-DESIGN §2.1,
 * §2.8.1, §2.11): calendar days in the recipient's own zone, moved to the next sending-hours start when the campaign
 * follows sending hours, across weekends and daylight-saving changes; minutes for the dry-run helper; a HELD
 * recipient stays held; an earlier step proven sent late never moves anyone back. A fixed time for every send.
 */

const t = await createTestDb("sequences-scheduling");
const { db, dbWrite } = await import("@/server/db");
const { claimEmail } = await import("@/server/services/sending/claim");
const { markSent, sweepFollowUps } = await import("@/server/services/sending/mark-sent");

const LIST = Array.from({ length: 12 }, (_, i) => `s${i}@schedule-${i}.de`);
const TWO: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];
const THREE: StepSeed[] = [...TWO, { step: 2, body: "Third", delayDays: 4 }];

let world: M3World;
let next = 0;
const address = () => LIST[next++]!;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("practice.copy", false);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** A launched one-person campaign in the current sending mode; its first email claimed as the loop would. */
async function launched(opts: { now: Date; steps?: StepSeed[]; timeZone?: string | null; ignoreWindow?: boolean; daysAsMinutes?: boolean }) {
  const { campaignId } = await launchTo(world, [address()], { now: opts.now, steps: opts.steps ?? TWO, timeZone: opts.timeZone, ignoreWindow: opts.ignoreWindow });
  if (opts.daysAsMinutes) await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { daysAsMinutes: true } }));
  const email = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
  expect(await claimEmail(email.id, opts.now)).toBe(true);
  return { campaignId, email };
}

async function nextRow(campaignId: number, step: number) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, step } });
}

describe("when a follow-up is due (§2.1)", () => {
  it("gated live: Wednesday 10:00 in Berlin + 3 days is Saturday, so it's due Monday 09:00 Berlin", async () => {
    const at = new Date("2026-09-23T08:00:00Z");
    const { campaignId, email } = await launched({ now: at });
    const res = await markSent(email.id, at, { providerId: email.messageId });
    expect(res.next?.dueAt).toEqual(new Date("2026-09-28T07:00:00Z"));
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      state: "WAITING",
      currentStep: 1,
      nextDueAt: new Date("2026-09-28T07:00:00Z"),
    });
  });

  it("keeps the local clock time across the March change in Berlin: Fri 16:45 CET → Mon 16:45 CEST", async () => {
    const at = new Date("2026-03-27T15:45:00Z");
    const { campaignId, email } = await launched({ now: at });
    await markSent(email.id, at, { providerId: email.messageId });
    expect((await nextRow(campaignId, 1)).dueAt).toEqual(new Date("2026-03-30T14:45:00Z"));
  });

  it("keeps the local clock time across the October change in Berlin: Fri 16:45 CEST → Mon 16:45 CET", async () => {
    const at = new Date("2026-10-23T14:45:00Z");
    const { campaignId, email } = await launched({ now: at });
    await markSent(email.id, at, { providerId: email.messageId });
    expect((await nextRow(campaignId, 1)).dueAt).toEqual(new Date("2026-10-26T15:45:00Z"));
  });

  it("uses the company's own zone: New York's spring change, Fri 15:00 EST → Mon 15:00 EDT", async () => {
    const at = new Date("2026-03-06T20:00:00Z");
    const { campaignId, email } = await launched({ now: at, timeZone: "America/New_York" });
    await markSent(email.id, at, { providerId: email.messageId });
    expect((await nextRow(campaignId, 1)).dueAt).toEqual(new Date("2026-03-09T19:00:00Z"));
  });

  it("a dry run that ignores sending hours isn't moved: Saturday 10:00 + 3 days is Tuesday 10:00", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const at = new Date("2026-09-26T08:00:00Z");
    const { campaignId, email } = await launched({ now: at, ignoreWindow: true });
    await markSent(email.id, at);
    expect((await nextRow(campaignId, 1)).dueAt).toEqual(new Date("2026-09-29T08:00:00Z"));
  });

  it("'Treat follow-up days as minutes': 3 minutes later, never moved into sending hours", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const at = new Date("2026-09-26T08:00:00Z"); // Saturday
    const { campaignId, email } = await launched({ now: at, ignoreWindow: false, daysAsMinutes: true });
    await markSent(email.id, at);
    expect((await nextRow(campaignId, 1)).dueAt).toEqual(new Date("2026-09-26T08:03:00Z"));
  });

  it("the sweeper gives a missing follow-up the same due time", async () => {
    const at = new Date("2026-09-23T08:00:00Z");
    const { campaignId, email } = await launched({ now: at });
    // An older version marked it sent without moving the person on.
    await dbWrite((c) => c.outboundEmail.update({ where: { id: email.id }, data: { status: "SENT", sentAt: at, providerId: email.messageId } }));
    const res = await sweepFollowUps(new Date("2026-09-23T09:00:00Z"));
    expect(res.created).toBeGreaterThanOrEqual(1);
    const row = await nextRow(campaignId, 1);
    expect(row).toMatchObject({ dueAt: new Date("2026-09-28T07:00:00Z"), inReplyTo: email.messageId, references: email.messageId });
  });
});

describe("threading (§2.2)", () => {
  it("replies to the email as the person received it: Mailgun's id when it rewrote ours, both in References", async () => {
    const at = new Date("2026-09-23T08:00:00Z");
    const { campaignId, email } = await launched({ now: at, steps: THREE });
    const theirs = "20260923080000.abcdef123456@send.example.com";
    await markSent(email.id, at, { providerId: theirs });
    const step1 = await nextRow(campaignId, 1);
    expect(step1).toMatchObject({ inReplyTo: theirs, references: `${email.messageId} ${theirs}` });
    expect(step1.messageId).toMatch(/^pp\.[0-9a-f]{24}@send\.example\.com$/);
    // Step 2 threads onwards (Mailgun kept our id this time).
    await dbWrite((c) => c.outboundEmail.update({ where: { id: step1.id }, data: { status: "SENDING", claimedAt: at } }));
    await markSent(step1.id, new Date("2026-09-28T07:00:00Z"), { providerId: step1.messageId });
    const step2 = await nextRow(campaignId, 2);
    expect(step2).toMatchObject({ inReplyTo: step1.messageId, references: `${email.messageId} ${theirs} ${step1.messageId}` });
  });
});

describe("the recipient's state (§2.8.1, §2.11)", () => {
  it("an email sent while its person was put on hold keeps them on hold; the last one finishes them and clears the hold", async () => {
    const at = new Date("2026-09-23T08:00:00Z");
    const { campaignId, email } = await launched({ now: at });
    const heldAt = new Date("2026-09-23T07:59:00Z");
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId }, data: { state: "HELD", holdReason: "possible-reply", heldAt } }));
    await markSent(email.id, at, { providerId: email.messageId });
    const step1 = await nextRow(campaignId, 1);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      state: "HELD",
      holdReason: "possible-reply",
      heldAt,
      currentStep: 1,
      nextDueAt: step1.dueAt,
    });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: step1.id }, data: { status: "SENDING", claimedAt: at } }));
    await markSent(step1.id, new Date("2026-09-28T07:00:00Z"), { providerId: step1.messageId });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      state: "FINISHED",
      holdReason: null,
      heldAt: null,
      currentStep: 1,
    });
  });

  it("a first email proven sent after follow-up 1 (restore order) never moves the person back or creates step 1 again", async () => {
    const at = new Date("2026-09-23T08:00:00Z");
    const { campaignId, email } = await launched({ now: at, steps: THREE });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: email.id }, data: { status: "UNKNOWN" } }));
    // The restore check found follow-up 1 in Mailgun's logs first and made its row.
    const step1 = await dbWrite((c) =>
      c.outboundEmail.create({
        data: {
          campaignId,
          recipientId: email.recipientId,
          personId: email.personId,
          companyId: email.companyId,
          senderId: email.senderId,
          step: 1,
          mode: email.mode,
          toEmail: email.toEmail,
          toNorm: email.toNorm,
          companyName: email.companyName,
          fromAddress: email.fromAddress,
          subject: "",
          text: "",
          html: "",
          messageId: `pp.${"1".repeat(24)}@send.example.com`,
          sendId: "restore-step-1",
          dueAt: new Date("2026-09-28T07:00:00Z"),
          status: "UNKNOWN",
          claimedAt: new Date("2026-09-28T07:00:00Z"),
        },
      }),
    );
    await markSent(step1.id, new Date("2026-09-28T07:00:00Z"), { providerId: step1.messageId });
    const step2 = await nextRow(campaignId, 2);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "WAITING", currentStep: 2 });
    // Now the first email's own proof arrives.
    await markSent(email.id, at, { providerId: email.messageId });
    expect(await db.outboundEmail.count({ where: { campaignId, step: 1 } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId, step: 2 } })).toBe(1);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      state: "WAITING",
      currentStep: 2,
      nextDueAt: step2.dueAt,
    });
  });
});
