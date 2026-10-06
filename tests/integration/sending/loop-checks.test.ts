import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * The sending loop and address checks (M5-DESIGN §2.8 rules 5–6, D24): RECHECK recipients are never picked; a first
 * "no answer" found at send time puts the recipient in RECHECK (the claim goes back without counting a try); every
 * other check or policy reason before the first email leaves the recipient out ("Left out: …"), never stopped;
 * follow-ups rely on the check judged at launch; the test-list exception is the one judged at launch.
 */

const t = await createTestDb("loop-checks");
let world: M3World;
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { CLEARED_CHECK_FIELDS } = await import("@/core/verification/types");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LISTED = "listed@loop-checks.test";

beforeAll(async () => {
  world = await setupM3({ testList: [LISTED] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

let seq = 0;
/** A person with a fresh "can be emailed" check, or the given result. */
async function checked(email: string, at: Date, data: Record<string, unknown> = {}) {
  seq += 1;
  const { people } = await makeCompany({ name: `Loop check ${seq}`, people: [{ name: `L${seq}`, email }] });
  await dbWrite((c) =>
    c.person.update({
      where: { id: people[0]!.id },
      data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: at, verificationProvider: "mailgun-fake", ...data },
    }),
  );
  return people[0]!;
}

const recipientOf = (campaignId: number, personId: number) => db.campaignRecipient.findFirstOrThrow({ where: { campaignId, personId } });
const sentTo = () => world.mg.fake.messages.map((m) => m.fields.to?.[0]);

async function tick(clock: ReturnType<typeof worldClock>, times = 1) {
  const results = [];
  for (let i = 0; i < times; i++) {
    await clearPacer();
    results.push(await loop.sendingTick(tickDeps(world, clock)));
  }
  return results;
}

describe("before the first email", () => {
  it("a RECHECK recipient's email is never picked", async () => {
    const clock = worldClock(world);
    const p = await checked("waits@loop-a.test", new Date(clock.now().getTime() - HOUR), { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verificationUnknowns: 1 });
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now() });
    expect((await recipientOf(campaignId, p.id)).state).toBe("RECHECK");
    const [r] = await tick(clock);
    expect(r).toMatchObject({ picked: 0, sent: 0 });
    expect(sentTo()).toEqual([]);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  it("a first 'no answer' found at send time waits for its re-check (no try counted)", async () => {
    const clock = worldClock(world);
    const p = await checked("rechecked@loop-b.test", new Date(clock.now().getTime() - DAY));
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now() });
    // Someone checked the address again after the launch: "no answer".
    const at = new Date(clock.now().getTime() - HOUR);
    await dbWrite((c) =>
      c.person.update({ where: { id: p.id }, data: { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: at, verificationUnknowns: 1 } }),
    );
    const [r] = await tick(clock);
    expect(r).toMatchObject({ held: 1, sent: 0 });
    expect(await recipientOf(campaignId, p.id)).toMatchObject({ state: "RECHECK", recheckAt: new Date(at.getTime() + DAY) });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    expect(sentTo()).toEqual([]);
  });

  it("someone who already waited once and gets another 'no answer' is left out", async () => {
    const clock = worldClock(world);
    const p = await checked("again@loop-c.test", new Date(clock.now().getTime() - DAY));
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now() });
    const r = await recipientOf(campaignId, p.id);
    // Released from an earlier re-check (recheckAt kept), then "no answer" again.
    await dbWrite(async (c) => {
      await c.campaignRecipient.update({ where: { id: r.id }, data: { recheckAt: new Date(clock.now().getTime() - HOUR) } });
      await c.person.update({
        where: { id: p.id },
        data: { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: clock.now(), verificationUnknowns: 1 },
      });
    });
    const [res] = await tick(clock);
    expect(res).toMatchObject({ skipped: 1 });
    expect(await recipientOf(campaignId, p.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
  });

  it("other check and policy reasons leave the recipient out (not stopped), and the campaign finishes", async () => {
    const clock = worldClock(world);
    const at = new Date(clock.now().getTime() - DAY);
    const twice = await checked("twice@loop-d.test", at);
    const edited = await checked("edited@loop-e.test", at);
    const catchAll = await checked("medium@loop-f.test", at);
    const { campaignId, companyIds } = await launchTo(world, [twice.email!, edited.email!, catchAll.email!], { now: clock.now() });
    await dbWrite(async (c) => {
      await c.person.update({
        where: { id: twice.id },
        data: { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: clock.now(), verificationUnknowns: 2 },
      });
      await c.person.update({ where: { id: edited.id }, data: { ...CLEARED_CHECK_FIELDS } });
      await c.person.update({ where: { id: catchAll.id }, data: { verificationStatus: "CATCH_ALL", verificationRisk: "MEDIUM" } });
    });
    const results = await tick(clock, 3);
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(3);
    expect(sentTo()).toEqual([]);
    const expectations: Array<[number, string]> = [
      [twice.id, "Address couldn't be checked"],
      [edited.id, "Address not checked"],
      [catchAll.id, "Can't confirm this address (medium risk); your check settings skip these"],
    ];
    for (const [personId, text] of expectations) {
      const r = await recipientOf(campaignId, personId);
      expect(r).toMatchObject({ state: "EXCLUDED", included: false, exclusionReason: text, stopReason: null });
      expect(await db.outboundEmail.findFirstOrThrow({ where: { recipientId: r.id } })).toMatchObject({ status: "SKIPPED", lastError: text });
    }
    expect(await db.companyReservation.count({ where: { campaignId, companyId: { in: companyIds }, releasedAt: null } })).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "email.skipped", personId: edited.id } })).summary).toBe(
      "First email to edited@loop-e.test skipped: address not checked",
    );
  });

  it("an address on the do-not-email list is still stopped as before", async () => {
    const clock = worldClock(world);
    const p = await checked("stopped@loop-g.test", new Date(clock.now().getTime() - DAY));
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now() });
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: p.emailNorm!, reason: "MANUAL", source: "manual" } }));
    await tick(clock);
    expect(await recipientOf(campaignId, p.id)).toMatchObject({ state: "STOPPED", stopReason: "suppressed" });
  });

  it("a dry run leaves a first 'no answer' out with its own sentence", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world);
    const p = await checked("dry@loop-h.test", new Date(clock.now().getTime() - DAY));
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now(), ignoreWindow: true });
    await dbWrite((c) =>
      c.person.update({ where: { id: p.id }, data: { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: clock.now(), verificationUnknowns: 1 } }),
    );
    await tick(clock);
    expect(await recipientOf(campaignId, p.id)).toMatchObject({
      state: "EXCLUDED",
      exclusionReason: "The address check got no answer. Dry runs don't check addresses again, so this person is left out.",
    });
  });
});

describe("judged at launch", () => {
  it("a follow-up goes out although the check aged past 90 days after the launch", async () => {
    const clock = worldClock(world);
    const p = await checked("aging@loop-i.test", new Date(clock.now().getTime() - 80 * DAY));
    const { campaignId } = await launchTo(world, [p.email!], {
      now: clock.now(),
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    await tick(clock);
    expect(sentTo()).toEqual([p.email]);
    // 20 days later (a Tuesday, 10:00 in Berlin): the check is 100 days old; the follow-up still goes.
    clock.set(new Date(clock.now().getTime() + 20 * DAY));
    const [r] = await tick(clock);
    expect(r?.sent).toBe(1);
    expect(sentTo()).toEqual([p.email, p.email]);
    expect(await recipientOf(campaignId, p.id)).toMatchObject({ state: "FINISHED", currentStep: 1 });
  });

  it("a first email whose check was fresh at the launch goes although it aged out while waiting", async () => {
    const clock = worldClock(world);
    const p = await checked("borderline@loop-j.test", new Date(clock.now().getTime() - 89 * DAY));
    const { campaignId } = await launchTo(world, [p.email!], { now: clock.now() });
    clock.set(new Date(clock.now().getTime() + 2 * DAY));
    await tick(clock);
    expect(sentTo()).toEqual([p.email]);
    expect((await recipientOf(campaignId, p.id)).state).toBe("FINISHED");
  });

  it("a test campaign launched before go-live keeps sending to its test-list address after go-live", async () => {
    await setSettingValue("sending.goLive", false);
    await setSettingValue("sending.mode", "TEST");
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LISTED], { now: clock.now() });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).launchedGoLive).toBe(false);
    await setSettingValue("sending.goLive", true);
    const [r] = await tick(clock);
    expect(r?.sent).toBe(1);
    expect(sentTo()).toEqual([LISTED]);
    expect(world.mg.fake.messages[0]!.fields["o:testmode"]).toEqual(["yes"]);
  });
});
