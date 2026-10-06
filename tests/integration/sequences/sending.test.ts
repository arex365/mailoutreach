import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Sending follow-ups (M4-DESIGN §2.8.3, §2.10): steps 1–3 go out in every mode, follow-ups before first emails,
 * overdue dry-run follow-ups at the next tick, gated dry runs picked apart so they never crowd out real emails,
 * people on hold (or waiting for an address check) never picked, a claim that finds its person on hold put back,
 * the outage gate and the stricter start-up check for follow-ups, and hold fields cleared on every way out of HELD.
 * The real sending loop, the local fake Mailgun and a fixed clock (Wednesday 10:00 in Berlin).
 */

const t = await createTestDb("sequences-sending");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const control = await import("@/server/services/campaigns/control");
const { setState } = await import("@/server/state");
const { DEFAULT_WINDOW } = await import("@/core/sending/window");

const LIST = Array.from({ length: 40 }, (_, i) => `f${i}@follow-${i}.de`);
const WED = new Date("2026-09-23T08:00:00Z");
const MON = new Date("2026-09-28T07:00:00Z");
const MIN = 60_000;
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let world: M3World;
let next = 0;
const address = () => LIST[next++]!;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("practice.copy", false);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const pick = (now: Date) => gates.pickCandidates(now, { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin" });

describe("follow-ups go out (MAX_SENDABLE_STEP 3)", () => {
  it("test mode: the follow-up goes after its delay, through Mailgun's test mode", async () => {
    await setSettingValue("sending.mode", "TEST");
    const clock = worldClock(world, WED);
    const to = address();
    const { campaignId } = await launchTo(world, [to], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(MON);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const sent = world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.fields["o:testmode"]).toEqual(["yes"]);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });

  it("gated: a due follow-up goes before a due first email, even one of a High priority company", async () => {
    const clock = worldClock(world, WED);
    const old = await launchTo(world, [address()], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(MON);
    const high = address();
    const fresh = await launchTo(world, [high], { now: clock.now() });
    await dbWrite((c) => c.company.updateMany({ where: { id: { in: fresh.companyIds } }, data: { priority: "HIGH", priorityRank: 1 } }));
    const { gated } = await pick(clock.now());
    expect(gated.map((c) => [c.campaignId, c.step])).toEqual([
      [old.campaignId, 1],
      [fresh.campaignId, 0],
    ]);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: old.campaignId, step: 1 } })).status).toBe("SENT");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: fresh.campaignId } })).status).toBe("QUEUED");
  });

  it("overdue dry-run follow-ups made before Milestone 4 go at the next tick, to the outbox", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [address(), address()], { now: clock.now(), steps: STEPS, ignoreWindow: true });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(2);
    // As Milestone 2/3 left them: follow-ups that have been due for weeks.
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId, step: 1 }, data: { dueAt: new Date("2026-08-01T00:00:00Z") } }));
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 2, finished: [campaignId] });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("600 due gated dry-run follow-ups never keep a due live first email out of the candidates", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const many = Array.from({ length: 600 }, (_, i) => `busy${i}@busy-dry-run.de`);
    const dry = await launchTo(world, many, { now: clock.now(), sameCompany: true, ignoreWindow: false, steps: STEPS });
    // Every one of them waits for an overdue follow-up (as an old dry run's rows would).
    await dbWrite(async (c) => {
      await c.outboundEmail.updateMany({ where: { campaignId: dry.campaignId }, data: { step: 1, dueAt: new Date("2026-09-01T00:00:00Z") } });
      await c.campaignRecipient.updateMany({ where: { campaignId: dry.campaignId }, data: { state: "WAITING", currentStep: 1 } });
    });
    await setSettingValue("sending.mode", "LIVE");
    const live = await launchTo(world, [address()], { now: clock.now() });
    const { gated } = await pick(clock.now());
    expect(gated.filter((c) => c.campaignId === dry.campaignId)).toHaveLength(gates.GATED_DRY_RUN_LIMIT);
    expect(gated.filter((c) => c.campaignId === live.campaignId)).toHaveLength(1);
    // Follow-ups first: a dry-run follow-up takes this tick's turn; the live email takes the next turn of its own class.
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.advance(20_000);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status).toBe("SENT");
  }, 60_000);
});

describe("people on hold (§2.8.1, §2.10)", () => {
  it("never picks the emails of HELD or RECHECK people, gated or not, and doesn't count them as due", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const fast = await launchTo(world, [address(), address()], { now: clock.now(), ignoreWindow: true });
    const slow = await launchTo(world, [address()], { now: clock.now(), ignoreWindow: false });
    await setSettingValue("sending.mode", "LIVE");
    const live = await launchTo(world, [address()], { now: clock.now() });
    const ids = [fast, slow, live].map((x) => x.campaignId);
    const fastRecipients = await db.campaignRecipient.findMany({ where: { campaignId: fast.campaignId }, orderBy: { id: "asc" } });
    await dbWrite(async (c) => {
      await c.campaignRecipient.update({ where: { id: fastRecipients[0]!.id }, data: { state: "HELD", holdReason: "possible-reply", heldAt: clock.now() } });
      await c.campaignRecipient.update({ where: { id: fastRecipients[1]!.id }, data: { state: "RECHECK" } });
      await c.campaignRecipient.updateMany({ where: { campaignId: { in: [slow.campaignId, live.campaignId] } }, data: { state: "HELD", holdReason: "outage", heldAt: clock.now() } });
    });
    const picked = await pick(clock.now());
    expect(picked.ungated.filter((c) => ids.includes(c.campaignId))).toEqual([]);
    expect(picked.gated.filter((c) => ids.includes(c.campaignId))).toEqual([]);
    expect(picked.due.reduce((n, d) => n + d.count, 0)).toBe(0);
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(0);
    expect(await db.outboundEmail.count({ where: { campaignId: { in: ids }, status: "QUEUED" } })).toBe(4);
    // Released: they go again.
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: { in: ids } }, data: { state: "SCHEDULED", holdReason: null, heldAt: null } }));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBeGreaterThanOrEqual(2);
  });

  it("an email whose person was put on hold after it was picked goes back in the queue without counting a try", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [address()], { now: clock.now(), ignoreWindow: true });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId }, data: { state: "HELD", holdReason: "possible-reply", heldAt: clock.now() } }));
    expect(await loop.sendOneEmail(row.id, { now: clock.now })).toBe("held");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
  });

  it("a live email whose person is put on hold while it is being prepared is put back, and Mailgun gets nothing", async () => {
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [address()], { now: clock.now() });
    const render = async (args: { recipientId: number }) => {
      await dbWrite((c) => c.campaignRecipient.update({ where: { id: args.recipientId }, data: { state: "HELD", holdReason: "outage", heldAt: clock.now() } }));
      return { subject: "Hello", text: "Hi\n\n%unsubscribe_url%", html: "<p>Hi</p>", warnings: [] };
    };
    const r = await loop.sendingTick(tickDeps(world, clock, { render }));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  it("clears the hold fields on skip, cancel, retry and on a stop at send time", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [address(), address(), address()], { now: clock.now(), ignoreWindow: true });
    const [a, b, c] = await db.campaignRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    const held = { state: "HELD" as const, holdReason: "outage,possible-reply", heldAt: clock.now() };
    await dbWrite((x) => x.campaignRecipient.updateMany({ where: { campaignId }, data: held }));
    await control.skipRecipient(a!.id, world.owner.id, { now: clock.now() });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ state: "STOPPED", holdReason: null, heldAt: null });

    // A stop at send time (the person unsubscribed) on a recipient with a hold left over by old code.
    await dbWrite(async (x) => {
      await x.campaignRecipient.update({ where: { id: b!.id }, data: { state: "SCHEDULED" } });
      await x.person.update({ where: { id: b!.personId }, data: { unsubscribedAt: clock.now() } });
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).skipped).toBe(1);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: b!.id } })).toMatchObject({ state: "STOPPED", holdReason: null, heldAt: null });

    await control.cancelCampaign(campaignId, world.owner.id, { now: clock.now() });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: c!.id } })).toMatchObject({
      state: "STOPPED",
      stopReason: "campaign_cancelled",
      holdReason: null,
      heldAt: null,
    });
  });

  it("Retry reopens a person without a stale hold", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [address()], { now: clock.now(), ignoreWindow: true });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await dbWrite(async (x) => {
      await x.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5 } });
      await x.campaignRecipient.updateMany({ where: { campaignId }, data: { state: "STOPPED", stopReason: "failed", holdReason: "outage", heldAt: clock.now() } });
    });
    await control.retryEmail(row.id, world.owner.id, { now: clock.now() });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "SCHEDULED", holdReason: null, heldAt: null });
  });
});

describe("after the PC was off (§2.8.3)", () => {
  const outage = (over: Record<string, unknown> = {}) => ({
    detectedAt: WED.toISOString(),
    from: "2026-09-10T00:00:00.000Z",
    to: "2026-09-18T00:00:00.000Z",
    beyondLogRetention: true,
    beyondMessageRetention: false,
    handledAt: null,
    heldFor: null,
    heldTo: null,
    heldCount: 0,
    ...over,
  });

  it("while an outage is found but not held yet, live follow-ups wait ('outage-hold'); first emails go", async () => {
    const clock = worldClock(world, WED);
    const old = await launchTo(world, [address()], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(MON);
    const fresh = await launchTo(world, [address()], { now: clock.now() });
    await setState("catchup.outage", outage());
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 1, waiting: { reason: "outage-hold" } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: fresh.campaignId } })).status).toBe("SENT");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: old.campaignId, step: 1 } })).status).toBe("QUEUED");
    expect(await gates.explainCampaignWaiting(old.campaignId, clock.now())).toEqual({ reason: "outage-hold", until: null });
    // Handled (the hold was applied, or nobody needed it): it goes.
    await setState("catchup.outage", outage({ handledAt: clock.now().toISOString() }));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });

  it("follow-ups wait for a successful check with Mailgun after the start; a network failure opens it after 15 minutes for first emails only", async () => {
    const clock = worldClock(world, WED);
    const old = await launchTo(world, [address()], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(MON);
    const startedAt = new Date(clock.now().getTime() - MIN);
    const fresh = await launchTo(world, [address()], { now: clock.now() });
    const failed = {
      lastStartedAt: clock.now().toISOString(),
      lastFinishedAt: clock.now().toISOString(),
      lastSuccessAt: null,
      lastError: "Couldn't reach Mailgun",
      lastErrorKind: "network",
      lastReason: "startup",
      lastSummary: null,
    };
    await setState("mailgun.catchUp", failed);
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock, { startedAt }))).toMatchObject({ sent: 0, waiting: { reason: "catch-up" } });
    clock.advance(20 * MIN);
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock, { startedAt }));
    expect(r).toMatchObject({ sent: 1, waiting: { reason: "catch-up" } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: fresh.campaignId } })).status).toBe("SENT");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: old.campaignId, step: 1 } })).status).toBe("QUEUED");
    // A successful check since the start lets the follow-up go.
    await setState("mailgun.catchUp", { ...failed, lastSuccessAt: clock.now().toISOString(), lastErrorKind: null, lastError: null });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock, { startedAt }))).sent).toBe(1);
  });

  it("the 5-minute maintenance applies an outage hold that is still pending", async () => {
    const clock = worldClock(world, WED);
    const { campaignId, companyIds } = await launchTo(world, [address()], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // The first email went out before the end of the unchecked window.
    await setState("catchup.outage", outage({ from: "2026-09-20T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z" }));
    const m = await loop.runSendingMaintenance(MON);
    expect(m.outageHold).toMatchObject({ applied: true });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId, companyId: companyIds[0]! } })).toMatchObject({ state: "HELD", holdReason: "outage" });
    // Nothing pending any more: the next maintenance leaves it alone.
    expect((await loop.runSendingMaintenance(MON)).outageHold).toBeNull();
  });
});
