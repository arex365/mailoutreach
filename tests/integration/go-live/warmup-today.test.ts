import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * Today's warm-up facts (M6-DESIGN §2.6, `loadWarmupToday`) and the warm-up line they give: a sending day or not, the
 * counted sends of the open cap day against the scheduled limit of the ramp's step, and the health over the counts the
 * evaluation uses (from go-live on real data). A short table [4, 8, 16] (start 4, max 16, 3 steps), cap-day zone
 * Asia/Karachi (UTC+5): Wednesday 23 Sep 2026 runs from 22 Sep 19:00 to 23 Sep 19:00 UTC.
 */

const t = await createTestDb("go-live-warmup-today");
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const { loadWarmupProgress, loadWarmupToday, startWarmupAtGoLive } = await import("@/server/services/sending/warmup-days");
const { warmupLine } = await import("@/core/sending/warmup-line");

const WED = new Date("2026-09-23T08:00:00Z"); // 13:00 in Karachi
const SAT = new Date("2026-09-26T08:00:00Z");
const HOUR = 3_600_000;
let world: GoLiveWorld;

beforeAll(async () => {
  world = await setupGoLive();
});

beforeEach(async () => {
  await resetGoLive();
  await setSettingValue("warmup.startCap", 4);
  await setSettingValue("sending.maxDailyCap", 16);
  await setSettingValue("warmup.steps", 3);
  await setSettingValue("sending.capDayTimeZone", "Asia/Karachi");
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.testSend.deleteMany({});
  });
  await setState("warmup", { domain: "send.example.com", step: 0, lastEvaluatedCapDay: "2026-09-22", startedCapDay: "2026-09-22", history: [] });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function sends(n: number, at: Date, opts: { failed?: boolean } = {}): Promise<void> {
  for (let i = 0; i < n; i++) await seedLiveTest(world, { at, failed: opts.failed });
}

describe("loadWarmupToday", () => {
  it("a weekday with half the limit used and healthy numbers: 'Tomorrow 8'", async () => {
    await sends(2, new Date(WED.getTime() - HOUR));
    expect(await loadWarmupToday(WED)).toEqual({ sendingDay: true, used: 2, cap: 4, minUsePercent: 50, healthy: true, weekdaysOnly: true });
    const p = await loadWarmupProgress(WED);
    expect(p).toMatchObject({ step: 0, table: [4, 8, 16] });
    expect(warmupLine(p.step, p.table, p.today)).toBe("Warm-up step 1 of 3: 4 a day. Tomorrow 8, if today's numbers stay healthy.");
  });

  it("low use: the 'how it goes up' line", async () => {
    await sends(1, new Date(WED.getTime() - HOUR));
    const today = await loadWarmupToday(WED);
    expect(today).toMatchObject({ sendingDay: true, used: 1, cap: 4 });
    expect(warmupLine(0, [4, 8, 16], today)).toBe(
      "Warm-up step 1 of 3: 4 a day. It goes up to 8 after a weekday with at least half the limit used and healthy numbers.",
    );
  });

  it("a weekend day is no sending day", async () => {
    await sends(3, new Date(SAT.getTime() - HOUR));
    const today = await loadWarmupToday(SAT);
    expect(today).toMatchObject({ sendingDay: false, used: 3 });
    expect(warmupLine(0, [4, 8, 16], today)).toMatch(/It goes up to 8 after a weekday/);
  });

  it("unhealthy: 4 bounces among the last 200 (2 % allows 3)", async () => {
    await sends(4, new Date(WED.getTime() - HOUR), { failed: true });
    const today = await loadWarmupToday(WED);
    expect(today).toMatchObject({ sendingDay: true, used: 4, healthy: false });
    expect(warmupLine(0, [4, 8, 16], today)).toMatch(/It goes up to 8 after a weekday/);
  });

  it("counts health from go-live on real data: rehearsal bounces don't make today unhealthy", async () => {
    await sends(4, new Date(WED.getTime() - 3 * HOUR), { failed: true });
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", new Date(WED.getTime() - 2 * HOUR).toISOString());
    await startWarmupAtGoLive(WED);
    await sends(2, new Date(WED.getTime() - HOUR));
    // All six sends count toward today's use; only the two after go-live count for health.
    expect(await loadWarmupToday(WED)).toEqual({ sendingDay: true, used: 6, cap: 4, minUsePercent: 50, healthy: true, weekdaysOnly: true });
  });

  it("words the rise with the Owner's minimum use and sending days (review SCREENS-10)", async () => {
    await setSettingValue("warmup.minUsePercent", 80);
    await setSettingValue("sending.window", { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" });
    try {
      await sends(1, new Date(SAT.getTime() - HOUR));
      const today = await loadWarmupToday(SAT);
      expect(today).toMatchObject({ sendingDay: true, used: 1, minUsePercent: 80, weekdaysOnly: false });
      expect(warmupLine(0, [4, 8, 16], today)).toBe(
        "Warm-up step 1 of 3: 4 a day. It goes up to 8 after a sending day with at least 80% of the limit used and healthy numbers.",
      );
    } finally {
      await setSettingValue("warmup.minUsePercent", 50);
      await setSettingValue("sending.window", { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
    }
  });

  it("uses step 0 for a ramp of another domain, the step itself otherwise", async () => {
    await setState("warmup", { domain: "old.example.com", step: 2, lastEvaluatedCapDay: "2026-09-22", startedCapDay: "2026-09-01", history: [] });
    expect(await loadWarmupProgress(WED)).toMatchObject({ step: 0, today: { cap: 4 } });
    await setState("warmup", { domain: "send.example.com", step: 1, lastEvaluatedCapDay: "2026-09-22", startedCapDay: "2026-09-01", history: [] });
    expect(await loadWarmupProgress(WED)).toMatchObject({ step: 1, today: { cap: 8 } });
  });
});
