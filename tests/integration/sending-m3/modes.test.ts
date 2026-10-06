import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "./helpers";

/**
 * The mode matrix (M3-DESIGN §1.6) row by row, and §1.7 (live sends to the test list before go-live aren't
 * "emailed"), through the real sending loop and the fake Mailgun.
 */

const t = await createTestDb("m3-modes");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { pauseSending } = await import("@/server/services/sending/pause");
const { getTodayCap, loadHealthCounts } = await import("@/server/services/sending/usage");

const LIST = ["m1@modes-1.de", "m2@modes-2.de", "m3@modes-3.de"];
const [A, B, C] = LIST as [string, string, string];
const SUNDAY_3AM_BERLIN = new Date("2026-09-27T01:00:00Z");
const FOLLOW_UPS: StepSeed[] = [
  { step: 0, subject: "Hello", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
  { step: 2, body: "Third", delayDays: 5 },
];

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.capOverride", null);
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
  await dbWrite((c) => c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } }));
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("dry runs", () => {
  it("with 'Ignore sending hours' on (as in Milestone 2): straight to the outbox, day or night, no pacing, never Mailgun", async () => {
    const clock = worldClock(world, SUNDAY_3AM_BERLIN);
    const addresses = Array.from({ length: 30 }, (_, i) => `night${i}@dry-night.de`);
    const { campaignId } = await launchTo(world, addresses, { now: clock.now(), ignoreWindow: true });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).ignoreWindow).toBe(true);
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 25, sent: 25 });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(5);
    expect(world.mg.fake.messages).toHaveLength(0);
    const rows = await db.outboundEmail.findMany({ where: { campaignId } });
    expect(rows.every((e) => e.status === "SENT" && e.providerId === `dry-run:${e.messageId}`)).toBe(true);
  });

  it("with it off: waits for sending hours and takes a turn with the pacer", async () => {
    const clock = worldClock(world, SUNDAY_3AM_BERLIN);
    const { campaignId } = await launchTo(world, ["hours1@dry-hours.de", "hours2@dry-hours.de"], { now: clock.now(), ignoreWindow: false });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "outside-hours" } });
    clock.set(new Date("2026-09-28T07:00:00Z")); // Monday 09:00 Berlin
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "pacing" } });
    expect(await db.outboundEmail.count({ where: { campaignId, status: "SENT" } })).toBe(1);
    // A dry run never counts toward the real daily limit.
    expect((await getTodayCap(clock.now())).used).toBe(0);
  });

  it("in the practice copy: gated and counted toward the daily limit", async () => {
    await setSettingValue("practice.copy", true);
    const clock = worldClock(world);
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 1, byUserId: world.owner.id, at: clock.now().toISOString() });
    await launchTo(world, ["p1@practice-co.de", "p2@practice-co.de"], { now: clock.now(), ignoreWindow: false });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await getTodayCap(clock.now())).used).toBe(1);
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "cap-reached" } });
  });

  it("launched as a dry run, never sent to Mailgun after sending switches to live", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, ["still-dry@switch-co.de"], { now: clock.now(), ignoreWindow: true });
    await setSettingValue("sending.mode", "LIVE");
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages).toHaveLength(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).providerId).toMatch(/^dry-run:/);
  });

  it("Pause all sending stops dry runs too", async () => {
    const clock = worldClock(world);
    await launchTo(world, ["paused-dry@pause-co.de"], { now: clock.now(), ignoreWindow: true });
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: world.owner.id });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ paused: true, picked: 0, sent: 0 });
  });
});

describe("test mode and live", () => {
  it("test mode: sending hours and pacing, Mailgun's test mode, never counted", async () => {
    await setSettingValue("sending.mode", "TEST");
    const clock = worldClock(world, SUNDAY_3AM_BERLIN);
    const { campaignId } = await launchTo(world, [A], { now: clock.now() });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).ignoreWindow).toBe(false);
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "outside-hours" } });
    clock.set(new Date("2026-09-28T07:30:00Z"));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages[0]!.fields["o:testmode"]).toEqual(["yes"]);
    expect((await getTodayCap(clock.now())).used).toBe(0);
  });

  it("live: follow-ups stay on and go out after their delay, in the next sending hours (M4)", async () => {
    await setSettingValue("sending.mode", "LIVE");
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [B], { now: clock.now(), steps: FOLLOW_UPS });
    const steps = await db.campaignStep.findMany({ where: { campaignId }, orderBy: { step: "asc" } });
    expect(steps.map((s) => [s.step, s.enabled])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // Wed 10:00 + 3 calendar days = Saturday: due at Monday's window start (09:00 Berlin = 07:00 UTC).
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } });
    expect(first).toMatchObject({ status: "QUEUED", dueAt: new Date("2026-09-28T07:00:00Z") });
    clock.set(new Date("2026-09-28T06:59:00Z"));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
    clock.set(new Date("2026-09-28T07:00:00Z"));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // Mon 09:00 + 5 days = Saturday again: Monday 5 Oct, 09:00.
    const second = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 2 } });
    expect(second.dueAt).toEqual(new Date("2026-10-05T07:00:00Z"));
    clock.set(second.dueAt);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).finished).toEqual([campaignId]);
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([B, B, B]);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "FINISHED", currentStep: 2 });
  });

  it("§1.7: two live campaigns to the same test mailboxes before go-live both send; counted, but never 'emailed'", async () => {
    await setSettingValue("sending.mode", "LIVE");
    const clock = worldClock(world);
    const first = await launchTo(world, [A, C], { now: clock.now(), name: "Live test one" });
    for (let i = 0; i < 2; i++) {
      await clearPacer();
      expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    }
    // The same mailboxes again, straight away: no 30-day block, no reservation.
    const second = await launchTo(world, [A, C], { now: clock.now(), name: "Live test two" });
    expect(await db.campaignRecipient.count({ where: { campaignId: second.campaignId, state: "SCHEDULED" } })).toBe(2);
    for (let i = 0; i < 2; i++) {
      await clearPacer();
      expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    }
    expect(world.mg.fake.messages).toHaveLength(4);
    expect(await db.companyReservation.count({ where: { campaignId: { in: [first.campaignId, second.campaignId] } } })).toBe(0);
    for (const id of first.companyIds) {
      expect(await db.company.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null, firstContactedById: null });
    }
    for (const id of first.personIds) {
      expect((await db.person.findUniqueOrThrow({ where: { id } })).lastEmailedAt).toBeNull();
    }
    // Still real sends: the daily limit and the health counts see them.
    expect((await getTodayCap(clock.now())).used).toBe(4);
    const health = await loadHealthCounts({ since: new Date("2026-09-01T00:00:00Z"), bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
    expect(health.bounceSample).toBe(4);
    // The activity log and timeline still show them.
    expect(await db.activityLog.count({ where: { campaignId: { in: [first.campaignId, second.campaignId] }, type: "email.sent", mode: "LIVE" } })).toBe(4);
  });

  it("after go-live a live send is 'emailed' again (company Contacted, reservation taken)", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    try {
      const clock = worldClock(world);
      // After go-live anyone may be emailed, once their address was checked.
      await makeCompany({
        name: "After go-live",
        people: [{ name: "Gina", email: "golive@after-golive.de", verificationStatus: "VALID", verifiedAt: clock.now() }],
      });
      const { campaignId, companyIds } = await launchTo(world, ["golive@after-golive.de"], { now: clock.now() });
      expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(1);
      expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
      expect(await db.company.findUniqueOrThrow({ where: { id: companyIds[0]! } })).toMatchObject({ status: "CONTACTED" });
    } finally {
      await setSettingValue("sending.goLive", false);
    }
  });
});
