import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World, type TestClock } from "./helpers";

/**
 * The reconciler (PLAN B6.7, M3-DESIGN §4.3.6) against the fake Mailgun: emails whose outcome isn't known are found in
 * Mailgun's logs and recorded as sent; "not sent" is only trusted after a positive control, and then the SAME
 * Message-ID goes back to the queue; anything still unclear after 2 hours goes to a person (Retry or Skip).
 */

const t = await createTestDb("m3-reconcile");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { cancelCampaign } = await import("@/server/services/campaigns/control");
const rec = await import("@/server/services/sending/reconcile");
const { ReconcilerLoop } = await import("../../../worker/reconciler");
const { readTyped } = await import("@/server/state-typed");
const { parseLogsFormState } = await import("@/core/system-state-parse");

const ADDRESSES = ["r1@recon-1.de", "r2@recon-2.de", "r3@recon-3.de", "r4@recon-4.de", "r5@recon-5.de", "r6@recon-6.de"];
const [A, B, C, D, E, F] = ADDRESSES as [string, string, string, string, string, string];
const MIN = 60_000;

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: ADDRESSES });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", ADDRESSES);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: "mailgun.logsForm" } });
    // Earlier tests' sent emails must not act as this test's positive control.
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Sends one email for real (Mailgun has it): the positive control. */
async function sendControl(clock: TestClock, to: string): Promise<number> {
  const { campaignId } = await launchTo(world, [to], { now: clock.now() });
  await clearPacer();
  const r = await loop.sendingTick(tickDeps(world, clock));
  expect(r.sent).toBe(1);
  return campaignId;
}

/** An email that was claimed but never reached Mailgun (the worker stopped before the POST): now UNKNOWN. */
async function neverPosted(clock: TestClock, to: string): Promise<{ campaignId: number; id: number; messageId: string }> {
  const { campaignId } = await launchTo(world, [to], { now: clock.now() });
  const e = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
  await dbWrite((c) =>
    c.outboundEmail.update({ where: { id: e.id }, data: { status: "UNKNOWN", claimedAt: clock.now(), attempts: 1, lastError: rec.CHECKING_MESSAGE } }),
  );
  return { campaignId, id: e.id, messageId: e.messageId };
}

/** An email Mailgun accepted, but whose answer never arrived (dropped connection): UNKNOWN. */
async function droppedAnswer(clock: TestClock, to: string): Promise<{ campaignId: number; id: number; messageId: string }> {
  const { campaignId } = await launchTo(world, [to], { now: clock.now() });
  world.mg.fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
  await clearPacer();
  expect((await loop.sendingTick(tickDeps(world, clock))).unknown).toBe(1);
  const e = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
  return { campaignId, id: e.id, messageId: e.messageId };
}

async function email(id: number) {
  return db.outboundEmail.findUniqueOrThrow({ where: { id } });
}

describe("emails Mailgun has", () => {
  it("are found by Message-ID and recorded once; the proven form is remembered", async () => {
    const clock = worldClock(world);
    const lost = await droppedAnswer(clock, A);
    const r = await rec.reconcileSends({ now: clock.advance(5 * MIN), mailgun: world.mailgun });
    expect(r).toMatchObject({ checked: 1, sent: 1, requeued: 0 });
    expect(await email(lost.id)).toMatchObject({ status: "SENT", providerId: lost.messageId, lastError: null });
    expect(world.mg.fake.messages).toHaveLength(1);
    expect((await readTyped("mailgun.logsForm", parseLogsFormState)).value.messageIdForm).toBe("plain");
  });

  it("learns the bracketed Message-ID form when Mailgun only matches <id>", async () => {
    const clock = worldClock(world);
    world.mg.fake.setSwitches({ bracketedMessageIdFilter: true });
    const lost = await droppedAnswer(clock, B);
    expect((await rec.reconcileSends({ now: clock.advance(5 * MIN), mailgun: world.mailgun })).sent).toBe(1);
    expect((await email(lost.id)).status).toBe("SENT");
    expect((await readTyped("mailgun.logsForm", parseLogsFormState)).value).toMatchObject({ messageIdForm: "bracketed" });
  });

  it("finds an email whose Message-ID Mailgun rewrote, by its send id, and keeps Mailgun's id", async () => {
    const clock = worldClock(world);
    world.mg.fake.setSwitches({ rewriteMessageId: true });
    const lost = await droppedAnswer(clock, C);
    const mailgunId = world.mg.fake.messages[0]!.id;
    expect(mailgunId).not.toBe(lost.messageId);
    expect((await rec.reconcileSends({ now: clock.advance(5 * MIN), mailgun: world.mailgun })).sent).toBe(1);
    expect(await email(lost.id)).toMatchObject({ status: "SENT", providerId: mailgunId });
    expect(world.mg.fake.messages).toHaveLength(1);
  });
});

describe("emails Mailgun never received", () => {
  it("go back to the queue with the SAME Message-ID once a positive control proves the empty answer", async () => {
    const clock = worldClock(world);
    await sendControl(clock, D);
    clock.advance(5 * MIN);
    const never = await neverPosted(clock, E);
    // Younger than 45 minutes: stays "checking".
    expect(await rec.reconcileSends({ now: clock.advance(20 * MIN), mailgun: world.mailgun })).toMatchObject({ requeued: 0, stillUnknown: 1 });
    expect((await email(never.id)).status).toBe("UNKNOWN");

    const now = clock.advance(30 * MIN);
    expect(await rec.reconcileSends({ now, mailgun: world.mailgun })).toMatchObject({ requeued: 1 });
    const e = await email(never.id);
    expect(e).toMatchObject({ status: "QUEUED", messageId: never.messageId, claimedAt: null, attempts: 1, lastError: rec.NEVER_RECEIVED_MESSAGE });
    expect(e.dueAt.toISOString()).toBe(now.toISOString());
    expect((await readTyped("mailgun.logsForm", parseLogsFormState)).value).toMatchObject({ messageIdForm: "plain", sendIdFilterOk: true });
    // The requeued email then goes out, with its original Message-ID.
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages.map((m) => m.id)).toContain(never.messageId);
  });

  it("are cancelled instead when their campaign has ended", async () => {
    const clock = worldClock(world);
    await sendControl(clock, A);
    clock.advance(5 * MIN);
    const never = await neverPosted(clock, F);
    await cancelCampaign(never.campaignId, world.owner.id);
    expect(await rec.reconcileSends({ now: clock.advance(50 * MIN), mailgun: world.mailgun })).toMatchObject({ cancelled: 1, requeued: 0 });
    expect(await email(never.id)).toMatchObject({ status: "CANCELLED", lastError: "This campaign was cancelled" });
  });

  it("are never requeued without a control: Not sure it was sent at 2 hours, and the sender and the Owner are told", async () => {
    const clock = worldClock(world);
    const never = await neverPosted(clock, B);
    expect(await rec.reconcileSends({ now: clock.advance(50 * MIN), mailgun: world.mailgun })).toMatchObject({ requeued: 0, stillUnknown: 1 });
    expect((await email(never.id)).status).toBe("UNKNOWN");
    const r = await rec.reconcileSends({ now: clock.advance(71 * MIN), mailgun: world.mailgun });
    expect(r.unconfirmed).toBe(1);
    expect(await email(never.id)).toMatchObject({ status: "UNCONFIRMED", lastError: rec.UNCONFIRMED_MESSAGE, messageId: never.messageId });
    const notes = await db.notification.findMany({ where: { type: "email.unconfirmed" }, orderBy: { userId: "asc" } });
    expect(notes.map((n) => n.userId).sort((a, b) => a - b)).toEqual([world.owner.id, world.member.id].sort((a, b) => a - b));
    expect(notes[0]).toMatchObject({
      title: "1 email needs your decision",
      body: `We can't tell whether the first email to ${B} went out. Open the campaign and choose Retry or Skip.`,
      link: `/campaigns/${never.campaignId}`,
    });
  });

  it("are never requeued when the control isn't found (Mailgun's `contains` filter doesn't work)", async () => {
    const clock = worldClock(world);
    world.mg.fake.setSwitches({ brokenContainsFilter: true });
    await sendControl(clock, C);
    clock.advance(MIN);
    const never = await neverPosted(clock, D);
    expect(await rec.reconcileSends({ now: clock.advance(50 * MIN), mailgun: world.mailgun })).toMatchObject({ requeued: 0, stillUnknown: 1 });
    expect((await email(never.id)).status).toBe("UNKNOWN");
    expect((await readTyped("mailgun.logsForm", parseLogsFormState)).value.sendIdFilterOk).not.toBe(true);
    expect((await rec.reconcileSends({ now: clock.advance(71 * MIN), mailgun: world.mailgun })).unconfirmed).toBe(1);
    expect(world.mg.fake.messages).toHaveLength(1);
  });

  it("a failing log search leaves the email checking, then Not sure it was sent at 2 hours", async () => {
    const clock = worldClock(world);
    await sendControl(clock, E);
    clock.advance(MIN);
    const never = await neverPosted(clock, F);
    world.mg.fake.failNext("POST /v1/analytics/logs", { kind: "status", status: 500, body: { message: "Internal Server Error" } }, 100);
    const r1 = await rec.reconcileSends({ now: clock.advance(50 * MIN), mailgun: world.mailgun });
    expect(r1).toMatchObject({ requeued: 0, sent: 0, stillUnknown: 1 });
    expect(r1.error).toMatch(/500/);
    const r2 = await rec.reconcileSends({ now: clock.advance(80 * MIN), mailgun: world.mailgun });
    expect(r2.unconfirmed).toBe(1);
    expect((await email(never.id)).status).toBe("UNCONFIRMED");
    expect(await db.notification.count({ where: { type: "email.unconfirmed" } })).toBe(2);
  });
});

describe("emails left 'Sending'", () => {
  it("become 'checking' after 2 minutes, unless the sending loop still has them", async () => {
    const clock = worldClock(world);
    const ids: number[] = [];
    for (const [to, ageMin] of [
      [A, 1],
      [B, 5],
      [C, 5],
    ] as const) {
      const { campaignId } = await launchTo(world, [to], { now: clock.now() });
      const e = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
      await dbWrite((c) =>
        c.outboundEmail.update({ where: { id: e.id }, data: { status: "SENDING", claimedAt: new Date(clock.now().getTime() - ageMin * MIN) } }),
      );
      ids.push(e.id);
    }
    await rec.reconcileSends({ now: clock.now(), mailgun: world.mailgun, inFlight: new Set([ids[1]!]) });
    expect((await email(ids[0]!)).status).toBe("SENDING");
    expect((await email(ids[1]!)).status).toBe("SENDING");
    expect(await email(ids[2]!)).toMatchObject({ status: "UNKNOWN", lastError: rec.CHECKING_MESSAGE });
  });

  it("the reconciler loop only works while this worker holds the lease", async () => {
    const logs: string[] = [];
    const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const off = new ReconcilerLoop({ ownsLease: async () => false, logger, mailgun: world.mailgun });
    expect(await off.tick()).toBeNull();
    const on = new ReconcilerLoop({ ownsLease: async () => true, logger, mailgun: world.mailgun, now: () => new Date() });
    expect(await on.tick()).toMatchObject({ error: null });
    expect(await on.waitForIdle(100)).toBe(true);
  });
});
