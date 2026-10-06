import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeSentEmail, setSettingValue } from "../campaigns/seed";
import { resetSendingState, setupM3, type M3World } from "./helpers";

/**
 * The health check (auto-pause and half-limit warnings) and warm-up days (M3-DESIGN §4.3.8), on seeded sends and
 * Mailgun events. Health defaults: 200 emails × 3 % → pauses at 7 bounces, warns at 3; 1,000 × 0.1 % → pauses at
 * 2 complaints, warns at 1. Warm-up here uses a short table [4, 8, 16] (start 4, max 16, 3 steps) and the cap-day zone
 * Asia/Karachi (UTC+5): cap day D runs from D−1 19:00 to D 19:00 UTC.
 */

// A pass-through of casState that can be told to lose one compare-and-set (another writer won).
const cas = vi.hoisted(() => ({ loseNext: null as string | null }));
vi.mock("@/server/state", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/state")>();
  return {
    ...orig,
    casState: async (key: string, version: number | null, value: unknown) => {
      if (cas.loseNext === key) {
        cas.loseNext = null;
        return false;
      }
      return orig.casState(key, version, value);
    },
  };
});

const t = await createTestDb("m3-health-warmup");
const { db, dbWrite } = await import("@/server/db");
const { runHealthCheck } = await import("@/server/services/sending/health-check");
const { evaluateWarmupDays, warmupRiseText, countedSendsBetween } = await import("@/server/services/sending/warmup-days");
const { getPauseState, pauseSending, resumeSending } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { setState } = await import("@/server/state");
const { parseHealthBaseline, parseWarmupState } = await import("@/core/system-state-parse");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOT_CONNECTED = async () => ({ connected: false as const, reason: "no-key" as const, text: "" });

let world: M3World;
let campaignId = 0;
let recipientId = 0;
let companyId = 0;
let personId = 0;
let seq = 0;

beforeAll(async () => {
  world = await setupM3();
  const { company, people } = await makeCompany({ name: "Health Co", people: [{ name: "Hanna", email: "hanna@health-co.de" }] });
  companyId = company.id;
  personId = people[0]!.id;
  const first = await makeSentEmail({
    createdById: world.owner.id,
    companyId,
    personId,
    toNorm: "hanna@health-co.de",
    sentAt: new Date("2020-01-01T00:00:00Z"),
  });
  campaignId = first.campaignId;
  recipientId = first.recipientId;
});

beforeEach(async () => {
  await resetSendingState();
  cas.loseNext = null;
  await setSettingValue("practice.copy", false);
  await setSettingValue("warmup.startCap", 4);
  await setSettingValue("sending.maxDailyCap", 16);
  await setSettingValue("warmup.steps", 3);
  await setSettingValue("sending.capDayTimeZone", "Asia/Karachi");
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({ where: { type: { in: ["sending.warmup", "sending.paused", "sending.resumed"] } } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** `count` counted (LIVE) emails sent at `at`; the first `bounced` bounce and the next `complained` draw a complaint. */
async function seedSends(count: number, at: Date, opts: { bounced?: number; complained?: number; mode?: "LIVE" | "TEST" | "DRY_RUN" } = {}) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    const messageId = `pp.health${seq}@send.example.com`;
    const toNorm = `h${seq}@health-co.de`;
    const row = await dbWrite((c) =>
      c.outboundEmail.create({
        data: {
          campaignId,
          recipientId,
          personId,
          companyId,
          step: 0,
          mode: opts.mode ?? "LIVE",
          toEmail: toNorm,
          toNorm,
          companyName: "Health Co",
          fromAddress: "Ali <ali@send.example.com>",
          subject: "s",
          text: "t",
          html: "h",
          messageId,
          sendId: `health-${seq}`,
          dueAt: at,
          status: "SENT",
          claimedAt: at,
          sentAt: at,
          providerId: messageId,
        },
      }),
    );
    ids.push(row.id);
    const bounced = i < (opts.bounced ?? 0);
    const complained = !bounced && i < (opts.bounced ?? 0) + (opts.complained ?? 0);
    if (bounced || complained) await eventFor(row.id, messageId, toNorm, bounced ? "failed" : "complained", new Date(at.getTime() + 60_000));
  }
  return ids;
}

async function eventFor(emailId: number, messageId: string, recipient: string, type: "failed" | "complained", at: Date) {
  seq += 1;
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `health-event-${seq}`,
        type,
        severity: type === "failed" ? "permanent" : null,
        reason: type === "failed" ? "bounce" : null,
        occurredAt: at,
        messageId,
        recipient,
        outboundEmailId: emailId,
        source: "WEBHOOK",
        raw: {},
        processedAt: at,
      },
    }),
  );
}

describe("the health check", () => {
  it("warns at half the limit, pauses on the 7th bounce, and doesn't trip again after a resume", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    await seedSends(20, new Date(now.getTime() - 2 * HOUR), { bounced: 6 });
    const warned = await runHealthCheck({ now });
    expect(warned).toMatchObject({ paused: false, warned: ["bounce"] });
    const warning = await db.notification.findFirstOrThrow({ where: { type: "sending.warning", userId: world.owner.id } });
    expect(warning.title).toBe("Bounces are rising: 6 of the last 20 emails bounced");
    expect(warning.body).toBe("Sending pauses automatically at 7. Check the bounced addresses in Settings › Deliverability.");
    expect((await getPauseState()).paused).toBe(false);

    // The 7th bounce.
    await seedSends(1, new Date(now.getTime() - HOUR), { bounced: 1 });
    const res = await runHealthCheck({ now });
    expect(res.paused).toBe(true);
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "health-bounce", reason: "7 of the last 21 emails bounced" });
    expect(pause.detail).toEqual({ count: 7, sample: 21, window: 200, limit: 6 });

    const resumed = await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now });
    expect(resumed).toMatchObject({ resumed: true, summary: "Resumed by Arslan with 7 of 21 acknowledged" });
    expect(await runHealthCheck({ now: new Date(now.getTime() + 60_000) })).toMatchObject({ paused: false, warned: [] });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("doesn't trip again after a resume when the health pause was an added cause", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: world.owner.id, now });
    await seedSends(10, new Date(now.getTime() - HOUR), { bounced: 8 });
    expect((await runHealthCheck({ now })).paused).toBe(true);
    const pause = await getPauseState();
    expect(pause.kind).toBe("manual");
    expect(pause.also.map((a) => a.kind)).toEqual(["health-bounce"]);
    expect((await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now })).resumed).toBe(true);
    expect((await readTyped("health.baseline", parseHealthBaseline)).value.since).toBe(now.toISOString());
    expect(await runHealthCheck({ now: new Date(now.getTime() + 60_000) })).toMatchObject({ paused: false });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("warns once per rise: warned at 3, down to 1, up to 3 again warns a second time", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    const ids = await seedSends(10, new Date(now.getTime() - HOUR), { bounced: 3 });
    expect((await runHealthCheck({ now })).warned).toEqual(["bounce"]);
    expect((await runHealthCheck({ now })).warned).toEqual([]);
    expect(await db.notification.count({ where: { type: "sending.warning" } })).toBe(1);

    // Two of the bounces leave the count (their events are gone).
    await dbWrite((c) => c.mailEvent.deleteMany({ where: { outboundEmailId: { in: ids.slice(0, 2) } } }));
    expect((await runHealthCheck({ now })).warned).toEqual([]);
    expect((await readTyped("health.baseline", parseHealthBaseline)).value.warnedBounceAt).toBeNull();

    await seedSends(2, new Date(now.getTime() - HOUR), { bounced: 2 });
    expect((await runHealthCheck({ now })).warned).toEqual(["bounce"]);
    expect(await db.notification.count({ where: { type: "sending.warning" } })).toBe(2);
  });

  it("forgets a warning after a week; a spam complaint warns, a second pauses", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    await seedSends(5, new Date(now.getTime() - HOUR), { complained: 1 });
    const first = await runHealthCheck({ now });
    expect(first.warned).toEqual(["complaint"]);
    expect(await db.notification.findFirstOrThrow({ where: { type: "sending.warning" } })).toMatchObject({
      title: "An email was marked as spam",
      body: "1 of the last 5 emails drew a complaint. Sending pauses automatically at 2.",
    });
    expect((await runHealthCheck({ now: new Date(now.getTime() + 6 * DAY) })).warned).toEqual([]);
    expect((await runHealthCheck({ now: new Date(now.getTime() + 8 * DAY) })).warned).toEqual(["complaint"]);

    await seedSends(1, new Date(now.getTime() - HOUR), { complained: 1 });
    expect((await runHealthCheck({ now })).paused).toBe(true);
    expect(await getPauseState()).toMatchObject({ kind: "health-complaint", reason: "2 of the last 6 emails were marked as spam" });
  });

  it("shared-From mode: the complaint warning names the From address and the everyday email; bounce warnings and the thresholds are unchanged (SHARED-FROM-DESIGN F20)", async () => {
    const { teamFromComplaintNote } = await import("@/server/services/sending/health-check");
    const note =
      " Your emails come from contact@example.com, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check Google Postmaster Tools.";
    expect(teamFromComplaintNote("contact@example.com")).toBe(note);
    const now = new Date("2026-09-23T08:00:00Z");
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    try {
      await seedSends(10, new Date(now.getTime() - HOUR), { bounced: 3, complained: 1 });
      expect((await runHealthCheck({ now })).warned).toEqual(["bounce", "complaint"]);
      const warnings = await db.notification.findMany({ where: { type: "sending.warning" }, orderBy: { id: "asc" } });
      expect(warnings.map((w) => [w.title, w.body])).toEqual([
        ["Bounces are rising: 3 of the last 10 emails bounced", "Sending pauses automatically at 7. Check the bounced addresses in Settings › Deliverability."],
        ["An email was marked as spam", `1 of the last 10 emails drew a complaint. Sending pauses automatically at 2.${note}`],
      ]);
      // The same limits as per-person mode: the second complaint pauses.
      await seedSends(1, new Date(now.getTime() - HOUR), { complained: 1 });
      expect((await runHealthCheck({ now })).paused).toBe(true);
      expect(await getPauseState()).toMatchObject({ kind: "health-complaint", reason: "2 of the last 11 emails were marked as spam" });
    } finally {
      await dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.fromAddress" } }));
    }
  });

  it("per-person mode (and a saved From address that doesn't fit): the complaint warning is unchanged", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    await setSettingValue("mailgun.fromAddress", "contact@other.example.org");
    try {
      await seedSends(5, new Date(now.getTime() - HOUR), { complained: 1 });
      expect((await runHealthCheck({ now })).warned).toEqual(["complaint"]);
      expect((await db.notification.findFirstOrThrow({ where: { type: "sending.warning" } })).body).toBe(
        "1 of the last 5 emails drew a complaint. Sending pauses automatically at 2.",
      );
    } finally {
      await dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.fromAddress" } }));
    }
  });

  it("never counts test-mode or dry-run sends", async () => {
    const now = new Date("2026-09-23T08:00:00Z");
    await seedSends(10, new Date(now.getTime() - HOUR), { bounced: 10, mode: "TEST" });
    await seedSends(10, new Date(now.getTime() - HOUR), { bounced: 10, mode: "DRY_RUN" });
    expect(await runHealthCheck({ now })).toMatchObject({ paused: false, warned: [] });
  });
});

describe("warm-up days", () => {
  const WED = new Date("2026-09-23T08:00:00Z"); // Wednesday, 13:00 in Karachi
  const TUESDAY_NOON = new Date("2026-09-22T07:00:00Z");
  const MONDAY_NOON = new Date("2026-09-21T07:00:00Z");

  // These days had live sends, so they wait for a catch-up with Mailgun even while it isn't connected right now
  // (GATES-06): give them one that finished long after every day used here.
  beforeEach(async () => {
    await setState("mailgun.catchUp", {
      lastStartedAt: "2026-10-30T00:00:00.000Z",
      lastFinishedAt: "2026-10-30T00:00:00.000Z",
      lastSuccessAt: "2026-10-30T00:00:00.000Z",
      lastError: null,
      lastErrorKind: null,
      lastReason: "hourly",
      lastSummary: null,
    });
  });

  async function warmupAt(step: number, lastEvaluatedCapDay: string, domain = "send.example.com") {
    await setState("warmup", { domain, step, lastEvaluatedCapDay, startedCapDay: "2026-09-01", history: [] });
  }
  async function riseActivities() {
    return db.activityLog.findMany({ where: { type: "sending.warmup" }, orderBy: { id: "asc" }, select: { summary: true, data: true } });
  }

  it("rises one step after a sending day with half the limit used and healthy numbers", async () => {
    await warmupAt(0, "2026-09-21");
    await seedSends(2, TUESDAY_NOON);
    const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated).toEqual([
      { day: "2026-09-22", cap: 4, used: 2, result: "up", bounces: 0, bounceSample: 2, complaints: 0, complaintSample: 2, stepAfter: 1 },
    ]);
    expect(res.state).toMatchObject({ step: 1, lastEvaluatedCapDay: "2026-09-22" });
    expect((await readTyped("warmup", parseWarmupState)).value.step).toBe(1);
    expect(await riseActivities()).toEqual([
      // The ramp's step, never "day N" (review DASHBOARD-8).
      { summary: "The daily limit rises to 8 (warm-up step 2 of 3)", data: { day: "2026-09-22", cap: 8, used: 2, stepAfter: 1 } },
    ]);
    // Evaluated once only.
    expect((await evaluateWarmupDays({ now: new Date(WED.getTime() + HOUR), mailgun: NOT_CONNECTED })).evaluated).toEqual([]);
    expect(await riseActivities()).toHaveLength(1);
  });

  it("evaluates several closed days in one run, oldest first", async () => {
    await warmupAt(0, "2026-09-20");
    await seedSends(2, MONDAY_NOON);
    await seedSends(4, TUESDAY_NOON);
    const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => [d.day, d.cap, d.used, d.result, d.stepAfter])).toEqual([
      ["2026-09-21", 4, 2, "up", 1],
      ["2026-09-22", 8, 4, "up", 2],
    ]);
    expect((await riseActivities()).map((a) => a.summary)).toEqual([
      "The daily limit rises to 8 (warm-up step 2 of 3)",
      "The daily limit rises to 16 (warm-up step 3 of 3)",
    ]);
  });

  it("holds on a weekend, on low use, with 4 bounces, with a spam complaint, and at the top of the table", async () => {
    // Saturday and Sunday (not sending days), even with sends.
    await warmupAt(0, "2026-09-25");
    await seedSends(4, new Date("2026-09-26T07:00:00Z"));
    let res = await evaluateWarmupDays({ now: new Date("2026-09-28T08:00:00Z"), mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => [d.day, d.result])).toEqual([
      ["2026-09-26", "hold-not-sending-day"],
      ["2026-09-27", "hold-not-sending-day"],
    ]);
    expect(res.state.step).toBe(0);

    // Low use: 1 of 4.
    await dbWrite((c) => c.outboundEmail.deleteMany({}));
    await warmupAt(0, "2026-09-21");
    await seedSends(1, TUESDAY_NOON);
    res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => d.result)).toEqual(["hold-low-use"]);

    // 4 bounces among the last 200: not healthy enough (2 % of 200 allows 3).
    await dbWrite(async (c) => {
      await c.mailEvent.deleteMany({});
      await c.outboundEmail.deleteMany({});
    });
    await warmupAt(0, "2026-09-21");
    await seedSends(6, TUESDAY_NOON, { bounced: 4 });
    res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => [d.result, d.bounces])).toEqual([["hold-unhealthy", 4]]);

    // 3 bounces are still healthy.
    await dbWrite(async (c) => {
      await c.mailEvent.deleteMany({});
      await c.outboundEmail.deleteMany({});
    });
    await warmupAt(0, "2026-09-21");
    await seedSends(6, TUESDAY_NOON, { bounced: 3 });
    res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => d.result)).toEqual(["up"]);

    // One spam complaint.
    await dbWrite(async (c) => {
      await c.mailEvent.deleteMany({});
      await c.outboundEmail.deleteMany({});
    });
    await warmupAt(0, "2026-09-21");
    await seedSends(3, TUESDAY_NOON, { complained: 1 });
    res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => d.result)).toEqual(["hold-unhealthy"]);

    // Already at the top.
    await warmupAt(2, "2026-09-21");
    res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => [d.result, d.stepAfter])).toEqual([["hold-at-max", 2]]);
    expect(await riseActivities()).toHaveLength(1);
  });

  it("a different sending domain starts the ramp again", async () => {
    await warmupAt(2, "2026-09-10", "old-domain.example.com");
    await seedSends(4, TUESDAY_NOON);
    const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated).toEqual([]);
    expect(res.state).toEqual({ domain: "send.example.com", step: 0, lastEvaluatedCapDay: "2026-09-22", startedCapDay: "2026-09-23", history: [] });
    expect((await readTyped("warmup", parseWarmupState)).value).toEqual(res.state);
  });

  it("with Mailgun connected, waits for a catch-up that finished an hour after the day ended", async () => {
    await warmupAt(0, "2026-09-21");
    await seedSends(2, TUESDAY_NOON);
    const catchUp = (lastSuccessAt: string | null) =>
      setState("mailgun.catchUp", {
        lastStartedAt: lastSuccessAt,
        lastFinishedAt: lastSuccessAt,
        lastSuccessAt,
        lastError: null,
        lastErrorKind: null,
        lastReason: "hourly",
        lastSummary: null,
      });
    await catchUp(null);
    expect((await evaluateWarmupDays({ now: WED, mailgun: world.mailgun })).evaluated).toEqual([]);
    // Tuesday ended at 19:00 UTC; a catch-up at 19:30 is too early.
    await catchUp("2026-09-22T19:30:00.000Z");
    expect((await evaluateWarmupDays({ now: WED, mailgun: world.mailgun })).evaluated).toEqual([]);
    expect((await readTyped("warmup", parseWarmupState)).value.step).toBe(0);
    await catchUp("2026-09-22T20:00:00.000Z");
    expect((await evaluateWarmupDays({ now: WED, mailgun: world.mailgun })).evaluated.map((d) => d.result)).toEqual(["up"]);
  });

  it("after go-live: the ramp restarts at the go-live day if go-live's own restart didn't happen, and rehearsal bounces don't hold it (M6-DESIGN §2.6, G12)", async () => {
    // A ramp that climbed before go-live; go-live on Tuesday 10:00 in Karachi, but its warm-up restart was lost.
    await warmupAt(2, "2026-09-21");
    await seedSends(6, MONDAY_NOON, { bounced: 4 }); // rehearsal bounces to the test mailboxes
    await seedSends(2, TUESDAY_NOON); // after go-live, healthy
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", "2026-09-22T05:00:00.000Z");
    try {
      const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
      // Started again on Tuesday at step 0; Tuesday judged with only its own (healthy) sends counted for health.
      expect(res.evaluated).toEqual([
        { day: "2026-09-22", cap: 4, used: 2, result: "up", bounces: 0, bounceSample: 2, complaints: 0, complaintSample: 2, stepAfter: 1 },
      ]);
      expect(res.state).toMatchObject({ domain: "send.example.com", step: 1, startedCapDay: "2026-09-22", lastEvaluatedCapDay: "2026-09-22" });
      expect(res.state.history).toHaveLength(1);
      // A second run changes nothing: the ramp already started on the go-live day.
      expect((await evaluateWarmupDays({ now: new Date(WED.getTime() + HOUR), mailgun: NOT_CONNECTED })).evaluated).toEqual([]);
      expect((await readTyped("warmup", parseWarmupState)).value.step).toBe(1);
    } finally {
      await setSettingValue("sending.goLive", false);
      await setSettingValue("sending.goLiveAt", null);
    }
  });

  describe("the go-live the ramp restarted for (review GOLIVE-02)", () => {
    // 23:30 in Karachi on Monday 14 Sep, but already 03:30 on Tuesday 15 Sep in Tokyo.
    const GO_LIVE_AT = "2026-09-14T18:30:00.000Z";
    const climbed = (over: Record<string, unknown> = {}) => ({
      domain: "send.example.com",
      step: 2,
      lastEvaluatedCapDay: "2026-09-22",
      startedCapDay: "2026-09-14",
      history: [
        { day: "2026-09-15", cap: 4, used: 2, result: "up", bounces: 0, bounceSample: 2, complaints: 0, complaintSample: 2, stepAfter: 1 },
        { day: "2026-09-16", cap: 8, used: 4, result: "up", bounces: 0, bounceSample: 6, complaints: 0, complaintSample: 6, stepAfter: 2 },
      ],
      ...over,
    });
    const live = async (at = GO_LIVE_AT) => {
      await setSettingValue("sending.goLive", true);
      await setSettingValue("sending.goLiveAt", at);
    };
    const notLive = async () => {
      await setSettingValue("sending.goLive", false);
      await setSettingValue("sending.goLiveAt", null);
    };

    it("go-live's restart records the go-live it was for", async () => {
      await live();
      try {
        const { startWarmupAtGoLive } = await import("@/server/services/sending/warmup-days");
        const state = await startWarmupAtGoLive(new Date(GO_LIVE_AT));
        expect(state).toEqual({
          domain: "send.example.com",
          step: 0,
          lastEvaluatedCapDay: "2026-09-13",
          startedCapDay: "2026-09-14",
          history: [],
          startedForGoLiveAt: GO_LIVE_AT,
        });
        expect((await readTyped("warmup", parseWarmupState)).value).toEqual(state);
      } finally {
        await notLive();
      }
    });

    it("changing the cap-day zone after go-live never restarts the ramp or wipes its history", async () => {
      await setState("warmup", climbed({ startedForGoLiveAt: GO_LIVE_AT }));
      await live();
      try {
        // Moved east: the go-live instant now falls on the next calendar day.
        await setSettingValue("sending.capDayTimeZone", "Asia/Tokyo");
        const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
        expect(res.evaluated).toEqual([]);
        expect(res.state).toMatchObject({ step: 2, startedCapDay: "2026-09-14", lastEvaluatedCapDay: "2026-09-22", startedForGoLiveAt: GO_LIVE_AT });
        expect(res.state.history).toHaveLength(2);
        expect((await readTyped("warmup", parseWarmupState)).value).toEqual(climbed({ startedForGoLiveAt: GO_LIVE_AT }));
        expect(await riseActivities()).toEqual([]);
      } finally {
        await notLive();
      }
    });

    it("a ramp stored before the record is compared by cap day once, gets the record, and then keeps it through a zone change", async () => {
      await setState("warmup", climbed());
      await live();
      try {
        const first = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
        expect(first.state).toEqual(climbed({ startedForGoLiveAt: GO_LIVE_AT }));
        expect((await readTyped("warmup", parseWarmupState)).value).toEqual(first.state);
        await setSettingValue("sending.capDayTimeZone", "Asia/Tokyo");
        const second = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
        expect(second.state).toMatchObject({ step: 2, startedCapDay: "2026-09-14" });
        expect(second.state.history).toHaveLength(2);
      } finally {
        await notLive();
      }
    });

    it("a later go-live whose own restart was lost is still repaired, at its own day", async () => {
      // Restarted for the first go-live; going live again (after a domain change) on Tuesday 22 Sep lost its restart.
      await setState("warmup", climbed({ startedForGoLiveAt: GO_LIVE_AT }));
      await live("2026-09-22T05:00:00.000Z");
      try {
        const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
        expect(res.state).toMatchObject({
          step: 0,
          startedCapDay: "2026-09-22",
          lastEvaluatedCapDay: "2026-09-22",
          startedForGoLiveAt: "2026-09-22T05:00:00.000Z",
        });
        // A second run changes nothing.
        expect((await evaluateWarmupDays({ now: new Date(WED.getTime() + HOUR), mailgun: NOT_CONNECTED })).evaluated).toEqual([]);
        expect((await readTyped("warmup", parseWarmupState)).value.startedForGoLiveAt).toBe("2026-09-22T05:00:00.000Z");
      } finally {
        await notLive();
      }
    });
  });

  it("before go-live the pre-go-live days are judged as before, bounces included", async () => {
    await warmupAt(0, "2026-09-21");
    await seedSends(6, TUESDAY_NOON, { bounced: 4 });
    const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(res.evaluated.map((d) => [d.day, d.result, d.bounces])).toEqual([["2026-09-22", "hold-unhealthy", 4]]);
    expect(res.state.startedCapDay).toBe("2026-09-01");
  });

  it("logs a rise only after its compare-and-set succeeded (a lost write is redone, logged once)", async () => {
    await warmupAt(0, "2026-09-21");
    await seedSends(2, TUESDAY_NOON);
    cas.loseNext = "warmup";
    const res = await evaluateWarmupDays({ now: WED, mailgun: NOT_CONNECTED });
    expect(cas.loseNext).toBeNull();
    expect(res.state.step).toBe(1);
    expect(res.state.history).toHaveLength(1);
    expect(await riseActivities()).toHaveLength(1);
  });

  it("counts a day's sends like the daily limit: counted modes, sent or maybe sent, plus test sends", async () => {
    const start = new Date("2026-09-21T19:00:00Z");
    const end = new Date("2026-09-22T19:00:00Z");
    await seedSends(2, TUESDAY_NOON);
    await seedSends(3, TUESDAY_NOON, { mode: "TEST" });
    await seedSends(1, new Date("2026-09-22T19:00:00Z"));
    const [unknownId] = await seedSends(1, TUESDAY_NOON);
    await dbWrite((c) => c.outboundEmail.update({ where: { id: unknownId! }, data: { status: "UNKNOWN", sentAt: null } }));
    await dbWrite((c) => c.testSend.create({ data: { userId: world.owner.id, to: "me@x.de", subject: "s", mode: "LIVE", sentAt: TUESDAY_NOON } }));
    expect(await countedSendsBetween(start, end, false)).toBe(4);
    expect(warmupRiseText(1, [4, 8, 16])).toBe("The daily limit rises to 8 (warm-up step 2 of 3)");
    expect(warmupRiseText(0, [4, 8, 16])).toBe("The daily limit rises to 4 (warm-up step 1 of 3)");
    expect(warmupRiseText(9, [4, 8, 16])).toBe("The daily limit rises to 16 (warm-up step 3 of 3)");
  });
});
