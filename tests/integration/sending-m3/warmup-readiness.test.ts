import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SendMode } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeSentEmail, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * Warm-up days wait for their bounces and complaints (review GATES-06, B1 "catch up, then evaluate closed days"):
 * a closed day on which anything went through Mailgun is judged only after a catch-up that finished an hour after
 * the day ended, even while Mailgun can't be loaded right now (a key that can't be read after an update, keys
 * removed). Only the practice copy, or a day with nothing sent through Mailgun, is judged without one.
 * Warm-up table [4, 8, 16]; the cap day follows Asia/Karachi, so Tuesday 22 Sep ends at 19:00 UTC.
 */

const t = await createTestDb("m3-warmup-readiness");
const { db, dbWrite } = await import("@/server/db");
const { evaluateWarmupDays, closedDayReady, hadMailgunSends } = await import("@/server/services/sending/warmup-days");
const { setState } = await import("@/server/state");

const WED = new Date("2026-09-23T08:00:00Z");
const TUESDAY_NOON = new Date("2026-09-22T07:00:00Z");
const TUESDAY = { start: new Date("2026-09-21T19:00:00Z"), end: new Date("2026-09-22T19:00:00Z") };
const NO_KEY = async () => ({ connected: false as const, reason: "no-key" as const, text: "The saved Mailgun key can't be read." });
const PRACTICE = async () => ({ connected: false as const, reason: "practice-copy" as const, text: "" });

const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@warmup-ready.test" });
const { company, people } = await makeCompany({ name: "Ready Co", people: [{ name: "Rita", email: "rita@ready-co.de" }] });

async function seed(count: number, mode: SendMode, at: Date = TUESDAY_NOON) {
  for (let i = 0; i < count; i++) {
    await makeSentEmail({ createdById: owner.id, mode, companyId: company.id, personId: people[0]!.id, toNorm: "rita@ready-co.de", sentAt: at });
  }
}

async function catchUpAt(lastSuccessAt: string | null) {
  await setState("mailgun.catchUp", {
    lastStartedAt: lastSuccessAt,
    lastFinishedAt: lastSuccessAt,
    lastSuccessAt,
    lastError: null,
    lastErrorKind: null,
    lastReason: "hourly",
    lastSummary: null,
  });
}

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.testSend.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["warmup", "mailgun.catchUp"] } } });
  });
  await setSettingValue("practice.copy", false);
  await setSettingValue("mailgun.domain", "send.example.com");
  await setSettingValue("warmup.startCap", 4);
  await setSettingValue("sending.maxDailyCap", 16);
  await setSettingValue("warmup.steps", 3);
  await setSettingValue("sending.capDayTimeZone", "Asia/Karachi");
  await setState("warmup", { domain: "send.example.com", step: 0, lastEvaluatedCapDay: "2026-09-21", startedCapDay: "2026-09-01", history: [] });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("warm-up readiness", () => {
  it("a day with live sends waits for the catch-up even while the Mailgun key can't be read right now", async () => {
    await seed(2, "LIVE");
    let res = await evaluateWarmupDays({ now: WED, mailgun: NO_KEY });
    expect(res.evaluated).toEqual([]);
    expect(res.state.step).toBe(0);
    // A catch-up too early (30 minutes after the day ended) isn't enough either.
    await catchUpAt("2026-09-22T19:30:00.000Z");
    expect((await evaluateWarmupDays({ now: WED, mailgun: NO_KEY })).evaluated).toEqual([]);
    // Once the overnight bounces are in, the day is judged.
    await catchUpAt("2026-09-22T20:00:00.000Z");
    res = await evaluateWarmupDays({ now: WED, mailgun: NO_KEY });
    expect(res.evaluated.map((d) => [d.day, d.result])).toEqual([["2026-09-22", "up"]]);
    expect(res.state.step).toBe(1);
  });

  it("a test send through Mailgun makes the day wait too; a test that failed doesn't", async () => {
    await dbWrite((c) =>
      c.testSend.create({ data: { userId: owner.id, to: "me@x.de", subject: "s", mode: "LIVE", status: "FAILED", sentAt: TUESDAY_NOON } }),
    );
    expect(await hadMailgunSends(TUESDAY.start, TUESDAY.end)).toBe(false);
    await dbWrite((c) => c.testSend.create({ data: { userId: owner.id, to: "me@x.de", subject: "s", mode: "LIVE", sentAt: TUESDAY_NOON } }));
    expect(await hadMailgunSends(TUESDAY.start, TUESDAY.end)).toBe(true);
    expect((await evaluateWarmupDays({ now: WED, mailgun: NO_KEY })).evaluated).toEqual([]);
  });

  it("a day with nothing sent through Mailgun is judged at once while Mailgun isn't connected", async () => {
    await seed(3, "DRY_RUN");
    // A live email on Monday doesn't make Tuesday wait.
    await seed(1, "LIVE", new Date("2026-09-21T07:00:00Z"));
    expect(await hadMailgunSends(TUESDAY.start, TUESDAY.end)).toBe(false);
    const res = await evaluateWarmupDays({ now: WED, mailgun: NO_KEY });
    // Dry runs on real data don't count toward the limit: low use, the limit stays.
    expect(res.evaluated.map((d) => [d.day, d.result, d.used])).toEqual([["2026-09-22", "hold-low-use", 0]]);
  });

  it("the practice copy never waits for Mailgun", async () => {
    await setSettingValue("practice.copy", true);
    await seed(2, "DRY_RUN");
    const res = await evaluateWarmupDays({ now: WED, mailgun: PRACTICE });
    expect(res.evaluated.map((d) => [d.day, d.result, d.used])).toEqual([["2026-09-22", "up", 2]]);
  });

  it("with Mailgun connected, a day always waits for its catch-up", async () => {
    const connected = { connected: true } as unknown as Parameters<typeof closedDayReady>[1];
    expect(await closedDayReady(TUESDAY, connected, Number.NaN)).toBe(false);
    expect(await closedDayReady(TUESDAY, connected, Date.parse("2026-09-22T20:00:00Z"))).toBe(true);
    expect(await closedDayReady(TUESDAY, await PRACTICE(), Number.NaN)).toBe(true);
    expect(await closedDayReady(TUESDAY, await NO_KEY(), Number.NaN)).toBe(true);
    await seed(1, "TEST");
    expect(await closedDayReady(TUESDAY, await NO_KEY(), Number.NaN)).toBe(false);
  });
});
