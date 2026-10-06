import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { WEDNESDAY_10_BERLIN, clearPacer, launchTo, makeClock, resetSendingState, setupM3, tickDeps, type M3World, type TestClock } from "./helpers";

/**
 * CRASH-5: the reconciler with this PC's clock off. Mailgun stamps its events with its own time, so an email Mailgun
 * accepted can look "in the future" to a PC whose clock is behind, while an older email (the positive control) is
 * already visible. Such an email must never go back to the queue (the prospect would get it twice): the Logs queries
 * reach past "now", and the control is searched in a window no longer than the email's, anchored on its claim time.
 * Only the local fake Mailgun is used; its clock is set apart from the app's.
 */

const t = await createTestDb("m3-reconcile-clock");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const rec = await import("@/server/services/sending/reconcile");

const ADDRESSES = ["c1@clock-1.de", "c2@clock-2.de", "c3@clock-3.de", "c4@clock-4.de"];
const [A, B, C, D] = ADDRESSES as [string, string, string, string];
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
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z"), claimedAt: new Date("2020-01-01T00:00:00Z") } });
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** This PC's clock, and Mailgun's clock `skewMs` ahead of it (negative: the PC is ahead). */
function skewedClocks(skewMs: number): TestClock {
  const pc = makeClock(WEDNESDAY_10_BERLIN);
  world.mg.fake.setNow(() => new Date(pc.now().getTime() + skewMs));
  return pc;
}

/** One email sent for real by the sending loop (Mailgun has it): the positive control. */
async function sendControl(pc: TestClock, to: string): Promise<number> {
  const { campaignId } = await launchTo(world, [to], { now: pc.now() });
  await clearPacer();
  expect((await loop.sendingTick(tickDeps(world, pc))).sent).toBe(1);
  return (await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).id;
}

/** An email Mailgun accepted, but whose answer never arrived: UNKNOWN, claimed at this PC's time. */
async function droppedAnswer(pc: TestClock, to: string): Promise<number> {
  const { campaignId } = await launchTo(world, [to], { now: pc.now() });
  world.mg.fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
  await clearPacer();
  expect((await loop.sendingTick(tickDeps(world, pc))).unknown).toBe(1);
  return (await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).id;
}

const sentTo = (to: string) => world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to).length;

describe("the reconciler with this PC's clock off", () => {
  it("clock 2 hours behind: an accepted email isn't requeued while its event still looks 'in the future'; it is found later", async () => {
    const pc = skewedClocks(2 * 60 * MIN);
    await sendControl(pc, A); // Mailgun's event: 2 hours "after" this PC's time
    pc.advance(90 * MIN);
    const id = await droppedAnswer(pc, B);

    // 50 minutes later the email's own event is still past the query's end, but the older control's event isn't past
    // "now" any more. The control's window is no longer than the email's, so it isn't found either: no requeue.
    const r1 = await rec.reconcileSends({ now: pc.advance(50 * MIN), mailgun: world.mailgun });
    expect(r1).toMatchObject({ requeued: 0, sent: 0, stillUnknown: 1 });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id } })).status).toBe("UNKNOWN");

    // 15 minutes later the email's event is inside the query (now + 1 h): recorded as sent, never sent again.
    const r2 = await rec.reconcileSends({ now: pc.advance(15 * MIN), mailgun: world.mailgun });
    expect(r2).toMatchObject({ sent: 1, requeued: 0 });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SENT" });
    await clearPacer();
    await loop.sendingTick(tickDeps(world, pc));
    expect(sentTo(B)).toBe(1);
  });

  it("clock up to an hour behind: the email is found at once", async () => {
    const pc = skewedClocks(50 * MIN);
    await sendControl(pc, C);
    pc.advance(30 * MIN);
    const id = await droppedAnswer(pc, D);
    // Its event is 50 minutes "ahead"; the query reaches 1 hour past this PC's now.
    expect(await rec.reconcileSends({ now: pc.advance(5 * MIN), mailgun: world.mailgun })).toMatchObject({ sent: 1, requeued: 0 });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id } })).status).toBe("SENT");
    expect(sentTo(D)).toBe(1);
  });

  it("clock 20 minutes ahead, control proven by Mailgun's own event time: the control is searched from its claim, so no requeue", async () => {
    const pc = skewedClocks(-20 * MIN);
    const control = await sendControl(pc, A);
    // The control was recorded as sent from Mailgun's event (e.g. by the catch-up): its sentAt is Mailgun's time.
    const claimedAt = (await db.outboundEmail.findUniqueOrThrow({ where: { id: control } })).claimedAt!;
    await dbWrite((c) => c.outboundEmail.update({ where: { id: control }, data: { sentAt: new Date(claimedAt.getTime() - 20 * MIN) } }));
    pc.advance(60 * MIN);
    const id = await droppedAnswer(pc, B); // Mailgun's event: 20 minutes "before" the claim, before the query's start

    const r = await rec.reconcileSends({ now: pc.advance(50 * MIN), mailgun: world.mailgun });
    expect(r).toMatchObject({ requeued: 0, stillUnknown: 1 });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id } })).status).toBe("UNKNOWN");
    // Still undecided after 2 hours: a person decides (Retry or Skip); nothing was sent twice.
    expect((await rec.reconcileSends({ now: pc.advance(75 * MIN), mailgun: world.mailgun })).unconfirmed).toBe(1);
    await clearPacer();
    await loop.sendingTick(tickDeps(world, pc));
    expect(sentTo(B)).toBe(1);
  });

  it("with the clocks in step, the control still proves an empty answer: never-posted emails go back to the queue", async () => {
    const pc = skewedClocks(0);
    await sendControl(pc, C);
    pc.advance(5 * MIN);
    const { campaignId } = await launchTo(world, [D], { now: pc.now() });
    const e = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: e.id }, data: { status: "UNKNOWN", claimedAt: pc.now(), attempts: 1 } }));
    expect(await rec.reconcileSends({ now: pc.advance(50 * MIN), mailgun: world.mailgun })).toMatchObject({ requeued: 1 });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("QUEUED");
    expect(rec.CONTROL_WINDOW_AFTER_MS).toBe(100 * MIN);
    expect(rec.LOGS_END_MARGIN_MS).toBe(60 * MIN);
  });
});
