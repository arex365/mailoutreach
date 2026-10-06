import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * Bounces and complaints count from go-live on real data (M6-DESIGN §2.6, G12): bounces to a test mailbox during the
 * rehearsal count before go-live (the health check pauses on them), and are left out of Domain health and the health
 * check once the Owner has gone live; Domain health says "Counting since you went live on …". The practice copy never
 * goes live, so there only the baseline counts. Nothing reaches the network.
 */

const t = await createTestDb("go-live-health-since");
const { db, dbWrite } = await import("@/server/db");
const { loadHealthView } = await import("@/server/services/mail-events/deliverability");
const { runHealthCheck } = await import("@/server/services/sending/health-check");
const { getPauseState } = await import("@/server/services/sending/pause");
const { setState } = await import("@/server/state");
const { formatShortDate } = await import("@/core/time/format");

const TZ = "Europe/Berlin";
const HOUR = 3_600_000;
let world: GoLiveWorld;

beforeAll(async () => {
  world = await setupGoLive();
});

beforeEach(async () => {
  await resetGoLive();
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** `n` live emails to the test mailbox at `at`, each bounced for good. */
async function rehearsalBounces(n: number, at: Date): Promise<void> {
  for (let i = 0; i < n; i++) await seedLiveTest(world, { at, delivered: false, failed: true });
}

describe("health counted from go-live", () => {
  it("counts rehearsal bounces before go-live, as before", async () => {
    const now = new Date();
    await rehearsalBounces(1, new Date(now.getTime() - 2 * HOUR));
    const view = await loadHealthView(TZ, now);
    expect(view.counts).toMatchObject({ bounces: 1, bounceSample: 1 });
    expect(view.sinceNote).toBeNull();
  });

  it("leaves a bounce to a test mailbox before go-live out of Domain health, and says since when", async () => {
    const now = new Date();
    const goLiveAt = new Date(now.getTime() - HOUR);
    await rehearsalBounces(1, new Date(now.getTime() - 2 * HOUR));
    await seedLiveTest(world, { at: new Date(now.getTime() - 30 * 60_000) }); // a real send after go-live, delivered
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", goLiveAt.toISOString());
    const view = await loadHealthView(TZ, now);
    expect(view.counts).toMatchObject({ bounces: 0, bounceSample: 1, complaints: 0, complaintSample: 1 });
    expect(view.sinceNote).toBe(`Counting since you went live on ${formatShortDate(goLiveAt, TZ, now)}.`);
    expect(view.bounceNote).toBe(`Only 1 live email since ${formatShortDate(goLiveAt, TZ, now)}; the limit is counted per 200.`);
  });

  it("a health pause resumed after go-live counts from the resume, and says so", async () => {
    const now = new Date();
    const goLiveAt = new Date(now.getTime() - 3 * HOUR);
    const resumed = new Date(now.getTime() - HOUR);
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", goLiveAt.toISOString());
    await setState("health.baseline", {
      since: resumed.toISOString(),
      resumedById: world.owner.id,
      acknowledged: null,
      warnedBounceAt: null,
      warnedComplaintAt: null,
    });
    await rehearsalBounces(1, new Date(now.getTime() - 2 * HOUR));
    const view = await loadHealthView(TZ, now);
    expect(view.counts.bounces).toBe(0);
    expect(view.sinceNote).toBe(`Counting since you resumed on ${formatShortDate(resumed, TZ, now)}.`);
  });

  it("the health check pauses on rehearsal bounces before go-live, and ignores them after it", async () => {
    const now = new Date();
    await rehearsalBounces(7, new Date(now.getTime() - 2 * HOUR));
    expect((await runHealthCheck({ now })).paused).toBe(true);
    expect((await getPauseState()).kind).toBe("health-bounce");

    await resetGoLive(); // clears the pause and the baseline
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", new Date(now.getTime() - HOUR).toISOString());
    expect(await runHealthCheck({ now })).toMatchObject({ paused: false, warned: [] });
    expect((await getPauseState()).paused).toBe(false);
    expect(await db.notification.count({ where: { type: "sending.warning" } })).toBe(0);
  });

  it("the practice copy keeps counting everything (it never goes live)", async () => {
    const now = new Date();
    await setSettingValue("practice.copy", true);
    await setSettingValue("sending.goLiveAt", new Date(now.getTime() - HOUR).toISOString());
    await rehearsalBounces(1, new Date(now.getTime() - 2 * HOUR));
    const view = await loadHealthView(TZ, now);
    expect(view.counts.bounces).toBe(1);
    expect(view.sinceNote).toBeNull();
  });
});
