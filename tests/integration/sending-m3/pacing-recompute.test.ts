import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { checklistRows, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World, type TestClock } from "./helpers";

/**
 * The pacer recomputed every tick (review GATES-02, GATES-01) and a failure between the claim and the hand-over
 * (CRASH-7), through the real sending loop, the real database and the fake Mailgun, with a fixed clock.
 *
 *  - A campaign launched after a send shortens the wait at once (the gap is never frozen at the time of the send).
 *  - One class of email (counted live, uncounted dry run / test mode) never waits for the other's gap.
 *  - The last email of the day is planned inside the sending window, so it doesn't slip to the next day.
 *  - Nothing was sent when preparing the email failed: it goes back to the queue, never "Not sure it was sent".
 */

// recheckRecipient can be told to fail once, as when the database stays locked by a big import.
const fail = vi.hoisted(() => ({ recheck: false }));
vi.mock("@/server/services/eligibility", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/eligibility")>();
  return {
    ...orig,
    recheckRecipient: async (...args: Parameters<typeof orig.recheckRecipient>) => {
      if (fail.recheck) {
        fail.recheck = false;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return orig.recheckRecipient(...args);
    },
  };
});

const t = await createTestDb("m3-pacing-recompute");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const { reconcileSends } = await import("@/server/services/sending/reconcile");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parsePacerState } = await import("@/core/system-state-parse");

const LIST = ["p1@pace-1.de", "p2@pace-2.de", "p3@pace-3.de", "p4@pace-4.de", "p5@pace-5.de"];
const [A, B, C, D, E] = LIST as [string, string, string, string, string];
const MIN = 60_000;
/** Wednesday 23 Sep 2026, 09:00 in Berlin (07:00 UTC); the window closes at 17:00 Berlin (15:00 UTC). */
const WED_9_BERLIN = new Date("2026-09-23T07:00:00Z");
const WED_CLOSE = new Date("2026-09-23T15:00:00Z");

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  fail.recheck = false;
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.capOverride", null);
  await setSettingValue("practice.copy", false);
  await setState("domain.check", { domain: world.mg.domain, region: "EU", checkedAt: null, lastVerifyAt: null, rows: checklistRows(), error: null });
  await dbWrite(async (c) => {
    await c.senderAddress.updateMany({ data: { routeStatus: "ok" } });
    await c.user.updateMany({ data: { dailyCap: null } });
    // Earlier tests' sends must not use up today's limit (every test runs on the same fixed day).
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function pacer() {
  return (await readTyped("sending.pacer", parsePacerState)).value;
}

/** Ticks, jumping the clock to each pacing slot, until nothing is queued in these campaigns or the window closes. */
async function sendAll(world: M3World, clock: TestClock, campaignIds: number[], deps: Record<string, unknown> = {}) {
  for (let i = 0; i < 50; i++) {
    const left = await db.outboundEmail.count({ where: { campaignId: { in: campaignIds }, status: "QUEUED" } });
    if (left === 0) return;
    const r = await loop.sendingTick(tickDeps(world, clock, deps));
    if (r.sent > 0) continue;
    if (r.waiting?.reason !== "pacing" || !r.waiting.until) return;
    clock.set(new Date(Math.max(r.waiting.until.getTime(), clock.now().getTime() + 1_000)));
  }
}

describe("the gap follows the emails due now (GATES-02)", () => {
  it("a campaign launched after a send shortens the wait at once; all emails go out the same day", async () => {
    const clock = worldClock(world, WED_9_BERLIN);
    const first = await launchTo(world, [A, B], { now: clock.now() });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // One more due: 8 hours open → 2 intervals, so the next is planned for 13:00 Berlin.
    expect((await pacer()).nextSendAt).toBe("2026-09-23T11:00:00.000Z");

    clock.advance(5 * MIN);
    const second = await launchTo(world, [C, D, E], { now: clock.now() });
    const r = await loop.sendingTick(tickDeps(world, clock));
    // Now 4 are due: 8 hours over 5 intervals → 10:36 Berlin, not 13:00.
    expect(r).toMatchObject({ picked: 0, waiting: { reason: "pacing", until: new Date("2026-09-23T08:36:00Z") } });
    // The campaign page says the same.
    expect(await gates.explainCampaignWaiting(second.campaignId, clock.now())).toEqual({
      reason: "pacing",
      until: new Date("2026-09-23T08:36:00Z"),
    });

    await sendAll(world, clock, [first.campaignId, second.campaignId]);
    const rows = await db.outboundEmail.findMany({ where: { campaignId: { in: [first.campaignId, second.campaignId] } }, orderBy: { sentAt: "asc" } });
    expect(rows.map((e) => e.status)).toEqual(["SENT", "SENT", "SENT", "SENT", "SENT"]);
    // Evenly spaced (96 minutes apart), and the last one well before the window closes.
    expect(rows.map((e) => e.sentAt!.toISOString())).toEqual([
      "2026-09-23T07:00:00.000Z",
      "2026-09-23T08:36:00.000Z",
      "2026-09-23T10:12:00.000Z",
      "2026-09-23T11:48:00.000Z",
      "2026-09-23T13:24:00.000Z",
    ]);
    expect(rows.at(-1)!.sentAt!.getTime()).toBeLessThan(WED_CLOSE.getTime());
    expect(world.mg.fake.messages).toHaveLength(5);
  });

  it("a live send never freezes a dry run that follows sending hours (the other class keeps its own gap)", async () => {
    const clock = worldClock(world, WED_9_BERLIN);
    const live = await launchTo(world, [A, B], { now: clock.now() });
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await launchTo(
      world,
      Array.from({ length: 6 }, (_, i) => `dry${i}@pace-dry.de`),
      { now: clock.now(), ignoreWindow: false },
    );
    await setSettingValue("sending.mode", "LIVE");
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId: live.campaignId, status: "SENT" } })).toBe(1);

    // 10 seconds later nothing goes (no two gated emails closer than the smallest gap, 20 s) ...
    clock.advance(10_000);
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "pacing" } });
    // ... 20 seconds after the live email, the dry run takes its turn instead of waiting until 13:00 Berlin.
    clock.advance(10_000);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId: dry.campaignId, status: "SENT" } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId: live.campaignId, status: "QUEUED" } })).toBe(1);
    expect((await pacer()).lastByClass).toMatchObject({
      counted: { at: "2026-09-23T07:00:00.000Z", jitter: 1 },
      uncounted: { at: "2026-09-23T07:00:20.000Z", jitter: 1 },
    });
  });
});

describe("the last email of the day stays inside the window (GATES-01)", () => {
  for (const random of [0.5, 0.94, 1]) {
    it(`16:42 in Berlin with 2 live emails due: both go on Wednesday (random ${random})`, async () => {
      const clock = worldClock(world, new Date("2026-09-23T14:42:00Z"));
      const { campaignId } = await launchTo(world, [D, E], { now: clock.now() });
      expect((await loop.sendingTick(tickDeps(world, clock, { random: () => random }))).sent).toBe(1);
      const planned = Date.parse((await pacer()).nextSendAt!);
      expect(planned).toBeLessThan(WED_CLOSE.getTime());
      await sendAll(world, clock, [campaignId], { random: () => random });
      const rows = await db.outboundEmail.findMany({ where: { campaignId } });
      expect(rows.map((e) => e.status)).toEqual(["SENT", "SENT"]);
      for (const e of rows) expect(e.sentAt!.getTime()).toBeLessThan(WED_CLOSE.getTime());
    });
  }
});

describe("practice copy: dry runs that ignore sending hours still stay within today's limit (GATES-04)", () => {
  it("sends only what today's limit allows, says why the rest waits, and the campaign page agrees", async () => {
    await setSettingValue("practice.copy", true);
    await setSettingValue("sending.mode", "DRY_RUN");
    await dbWrite((c) => c.notification.deleteMany({ where: { type: "sending.capReached" } }));
    const clock = worldClock(world, new Date("2026-09-23T08:00:00Z"));
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 3, byUserId: world.owner.id, at: clock.now().toISOString() });
    const addresses = Array.from({ length: 10 }, (_, i) => `fast${i}@practice-fast.de`);
    const { campaignId } = await launchTo(world, addresses, { now: clock.now(), ignoreWindow: true });

    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 3, waiting: { reason: "cap-reached", until: new Date("2026-09-23T19:00:00Z") } });
    expect(await db.outboundEmail.count({ where: { campaignId, status: "SENT" } })).toBe(3);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
    expect(await db.outboundEmail.count({ where: { campaignId, status: "QUEUED" } })).toBe(7);
    expect(await gates.explainCampaignWaiting(campaignId, clock.now())).toEqual({ reason: "cap-reached", until: new Date("2026-09-23T19:00:00Z") });
    const { getTodayCap } = await import("@/server/services/sending/usage");
    expect(await getTodayCap(clock.now())).toMatchObject({ used: 3, left: 0 });
    expect(await db.notification.count({ where: { type: "sending.capReached" } })).toBe(1);
    expect(world.mg.fake.messages).toHaveLength(0);
  });
});

describe("a failure before the hand-over (CRASH-7)", () => {
  it("puts the email back in the queue as a failed try: nothing was sent, so it never becomes 'Not sure it was sent'", async () => {
    const clock = worldClock(world, new Date("2026-09-23T08:00:00Z"));
    const { campaignId } = await launchTo(world, [A], { now: clock.now() });
    fail.recheck = true;
    const errors: string[] = [];
    const logger = { warn: () => undefined, error: (m: string) => void errors.push(m) };
    const r = await loop.sendingTick(tickDeps(world, clock, { logger }));
    expect(r).toMatchObject({ sent: 0, retried: 1, unknown: 0 });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row).toMatchObject({ status: "QUEUED", claimedAt: null, attempts: 1, lastError: "Couldn't prepare this email: Something unexpected went wrong." });
    expect(row.dueAt).toEqual(new Date(clock.now().getTime() + MIN));
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(errors.join("\n")).toContain("database is locked");

    // Two hours later the reconciler has nothing to settle: the email was never "Sending".
    expect(await reconcileSends({ now: new Date(clock.now().getTime() + 125 * MIN), mailgun: world.mailgun })).toMatchObject({
      unconfirmed: 0,
    });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).status).toBe("QUEUED");

    // A minute later it goes, once.
    clock.advance(MIN);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "SENT", attempts: 2, lastError: null });
    expect(world.mg.fake.messages).toHaveLength(1);
  });
});
