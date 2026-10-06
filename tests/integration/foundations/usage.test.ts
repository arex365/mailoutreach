import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SendMode, SendStatus } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeSentEmail, makeUser, setSettingValue } from "../campaigns/seed";

/** Today's limit and usage, and the health counts (M3-DESIGN §4.2.5). */

const t = await createTestDb("foundations-usage");
const { db, dbWrite } = await import("@/server/db");
const { getTodayCap, countUserTestSends, loadHealthCounts } = await import("@/server/services/sending/usage");
const { setState } = await import("@/server/state");
const { DEFAULT_WARMUP_TABLE } = await import("@/core/sending/caps");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

// 10:00 UTC = 15:00 in Karachi. The Karachi cap day 2026-09-23 runs 2026-09-22T19:00Z → 2026-09-23T19:00Z.
const NOW = new Date("2026-09-23T10:00:00Z");
const DAY_START = new Date("2026-09-22T19:00:00Z");
const DAY_END = new Date("2026-09-23T19:00:00Z");

const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
const ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
const { company, people } = await makeCompany({ name: "Studio", people: [{ email: "anna@studio.de" }] });
const person = people[0]!;

async function wipe() {
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.testSend.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaign.deleteMany({});
    await c.setting.deleteMany({});
    await c.systemState.deleteMany({});
  });
}

async function email(opts: { mode?: SendMode; status?: SendStatus; at: Date; senderId?: number }) {
  const { email: row } = await makeSentEmail({
    createdById: owner.id,
    senderId: opts.senderId ?? owner.id,
    mode: opts.mode ?? "LIVE",
    status: opts.status ?? "SENT",
    companyId: company.id,
    personId: person.id,
    toNorm: "anna@studio.de",
    sentAt: opts.at,
  });
  return row;
}

async function testSend(opts: { status?: SendStatus; at: Date; userId?: number; purpose?: "SELF" | "REPLY_TEST" }) {
  return dbWrite((c) =>
    c.testSend.create({
      data: {
        userId: opts.userId ?? owner.id,
        to: "arslan@gmail.com",
        subject: "Test",
        mode: "LIVE",
        status: opts.status ?? "SENT",
        sentAt: opts.at,
        ...(opts.purpose ? { purpose: opts.purpose } : {}),
      },
    }),
  );
}

let eventSeq = 0;
async function event(emailId: number, e: { type: string; severity?: string | null; reason?: string | null; isTestMode?: boolean }) {
  eventSeq += 1;
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `test-${eventSeq}`,
        type: e.type,
        severity: e.severity ?? null,
        reason: e.reason ?? null,
        occurredAt: NOW,
        outboundEmailId: emailId,
        isTestMode: e.isTestMode ?? false,
        source: "WEBHOOK",
        raw: {},
      },
    }),
  );
}

const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

beforeEach(async () => {
  await wipe();
});

describe("getTodayCap", () => {
  it("starts at the first warm-up step with nothing used", async () => {
    const cap = await getTodayCap(NOW);
    expect(cap).toMatchObject({
      capDay: "2026-09-23",
      capZone: "Asia/Karachi",
      dayStart: DAY_START,
      dayEnd: DAY_END,
      cap: 50,
      source: "warmup",
      aboveSchedule: false,
      override: null,
      warmupCap: 50,
      warmupStep: 0,
      warmupSteps: 20,
      maxCap: 1000,
      used: 0,
      testSends: 0,
      left: 50,
    });
    expect(cap.bySender.size).toBe(0);
  });

  it("counts SENT by sentAt and SENDING/UNKNOWN/UNCONFIRMED by claimedAt, LIVE only", async () => {
    await email({ at: minutes(-60) }); // SENT today
    await email({ status: "SENDING", at: minutes(-1) });
    await email({ status: "UNKNOWN", at: minutes(-30) });
    await email({ status: "UNCONFIRMED", at: minutes(-90), senderId: ali.id });
    // not counted
    await email({ status: "QUEUED", at: minutes(-5) });
    await email({ status: "FAILED", at: minutes(-5) });
    await email({ status: "SKIPPED", at: minutes(-5) });
    await email({ status: "CANCELLED", at: minutes(-5) });
    await email({ mode: "TEST", at: minutes(-5) });
    await email({ mode: "DRY_RUN", at: minutes(-5) });
    const cap = await getTodayCap(NOW);
    expect(cap.used).toBe(4);
    expect(cap.left).toBe(46);
    expect([...cap.bySender.entries()].sort()).toEqual([
      [owner.id, 3],
      [ali.id, 1],
    ]);
  });

  it("counts dry runs in the practice copy", async () => {
    await email({ mode: "DRY_RUN", at: minutes(-5) });
    await email({ mode: "LIVE", at: minutes(-5) });
    expect((await getTodayCap(NOW, { practiceCopy: true })).used).toBe(2);
    expect((await getTodayCap(NOW, { practiceCopy: false })).used).toBe(1);
    await setSettingValue("practice.copy", true);
    expect((await getTodayCap(NOW)).used).toBe(2);
  });

  it("includes test sends except failed ones, but not in bySender", async () => {
    await testSend({ at: minutes(-5) });
    await testSend({ status: "SENDING", at: minutes(-1) });
    await testSend({ status: "UNKNOWN", at: minutes(-2) });
    await testSend({ status: "FAILED", at: minutes(-3) });
    await testSend({ at: new Date(DAY_START.getTime() - 1000) }); // yesterday
    const cap = await getTodayCap(NOW);
    expect(cap).toMatchObject({ testSends: 3, used: 3, left: 47 });
    expect(cap.bySender.size).toBe(0);
  });

  it("respects the cap-day boundary (23:59:59 vs 00:00 Karachi time)", async () => {
    await email({ at: new Date("2026-09-22T18:59:59.999Z") }); // 23:59:59 PKT on the 22nd
    await email({ at: new Date("2026-09-22T19:00:00.000Z") }); // 00:00 PKT on the 23rd
    await email({ at: new Date("2026-09-23T18:59:59.999Z") }); // last moment of the 23rd
    await email({ at: new Date("2026-09-23T19:00:00.000Z") }); // the 24th
    expect((await getTodayCap(NOW)).used).toBe(2);
    expect((await getTodayCap(new Date("2026-09-22T18:00:00Z"))).capDay).toBe("2026-09-22");
    expect((await getTodayCap(new Date("2026-09-22T18:00:00Z"))).used).toBe(1);
  });

  it("follows the cap-day zone setting", async () => {
    await setSettingValue("sending.capDayTimeZone", "Europe/Berlin");
    const cap = await getTodayCap(NOW);
    expect(cap.capZone).toBe("Europe/Berlin");
    expect(cap.dayStart).toEqual(new Date("2026-09-22T22:00:00Z"));
    await setSettingValue("sending.capDayTimeZone", "Mars/Olympus");
    expect((await getTodayCap(NOW)).capZone).toBe("Asia/Karachi");
  });

  it("uses the warm-up step of the current domain only", async () => {
    await setSettingValue("mailgun.domain", "send.example.com");
    await setState("warmup", { domain: "send.example.com", step: 3, lastEvaluatedCapDay: "2026-09-22", startedCapDay: "2026-09-18", history: [] });
    expect(await getTodayCap(NOW)).toMatchObject({ warmupStep: 3, warmupCap: DEFAULT_WARMUP_TABLE[3], cap: 80 });
    await setSettingValue("mailgun.domain", "new.example.com");
    expect(await getTodayCap(NOW)).toMatchObject({ warmupStep: 0, cap: 50 });
  });

  it("applies the Owner's override only on its own cap day, never above the maximum", async () => {
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 300, byUserId: owner.id, at: NOW.toISOString() });
    await email({ at: minutes(-5) });
    expect(await getTodayCap(NOW)).toMatchObject({ cap: 300, source: "override", aboveSchedule: true, used: 1, left: 299 });
    expect((await getTodayCap(NOW)).override).toMatchObject({ capDay: "2026-09-23", cap: 300 });
    // the next cap day: ignored
    expect(await getTodayCap(new Date("2026-09-23T20:00:00Z"))).toMatchObject({ cap: 50, source: "warmup", override: null });
    // below the schedule
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 20, byUserId: owner.id, at: NOW.toISOString() });
    expect(await getTodayCap(NOW)).toMatchObject({ cap: 20, aboveSchedule: false });
    // above the maximum
    await setSettingValue("sending.maxDailyCap", 200);
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 5000, byUserId: owner.id, at: NOW.toISOString() });
    expect(await getTodayCap(NOW)).toMatchObject({ cap: 200, maxCap: 200 });
  });

  it("never reports a negative number left", async () => {
    for (let i = 0; i < 3; i++) await email({ at: minutes(-i - 1) });
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 2, byUserId: owner.id, at: NOW.toISOString() });
    expect(await getTodayCap(NOW)).toMatchObject({ cap: 2, used: 3, left: 0 });
  });
});

describe("countUserTestSends", () => {
  it("counts this cap day's tests of one user, any status but FAILED", async () => {
    await testSend({ at: minutes(-5) });
    await testSend({ status: "UNKNOWN", at: minutes(-4) });
    await testSend({ status: "FAILED", at: minutes(-3) });
    await testSend({ at: minutes(-2), userId: ali.id });
    await testSend({ at: new Date(DAY_START.getTime() - 1) });
    expect(await countUserTestSends(owner.id, NOW)).toBe(2);
    expect(await countUserTestSends(ali.id, NOW)).toBe(1);
    expect(await dbWrite((c) => countUserTestSends(owner.id, NOW, c))).toBe(2);
    await db.$transaction(async (tx) => {
      expect(await countUserTestSends(owner.id, NOW, tx)).toBe(2);
    });
  });

  it("never counts the reply test's emails toward the 20 a day, though they still count toward today's limit", async () => {
    await testSend({ at: minutes(-5) });
    for (let i = 0; i < 10; i++) await testSend({ at: minutes(-4), purpose: "REPLY_TEST", status: i === 0 ? "SENDING" : "SENT" });
    expect(await countUserTestSends(owner.id, NOW)).toBe(1);
    expect(await getTodayCap(NOW)).toMatchObject({ testSends: 11, used: 11, left: 39 });
  });
});

describe("loadHealthCounts", () => {
  const base = { since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false };

  it("counts permanent failures except suppress-* and test mode, each email once", async () => {
    const e1 = await email({ at: minutes(-10) });
    const e2 = await email({ at: minutes(-9) });
    const e3 = await email({ at: minutes(-8) });
    const e4 = await email({ at: minutes(-7) });
    const e5 = await email({ at: minutes(-6) });
    const e6 = await email({ at: minutes(-5) });
    await event(e1.id, { type: "failed", severity: "permanent", reason: "bounce" });
    await event(e1.id, { type: "failed", severity: "permanent", reason: "bounce" }); // twice: still one email
    await event(e2.id, { type: "failed", severity: "permanent", reason: null }); // no reason: counts
    await event(e3.id, { type: "failed", severity: "permanent", reason: "espblock" }); // other permanent: counts
    await event(e4.id, { type: "failed", severity: "permanent", reason: "suppress-bounce" }); // dropped: no
    await event(e5.id, { type: "failed", severity: "temporary", reason: "generic" }); // temporary: no
    await event(e6.id, { type: "failed", severity: "permanent", reason: "bounce", isTestMode: true }); // test mode: no
    const h = await loadHealthCounts(base);
    expect(h).toMatchObject({ bounces: 3, bounceSample: 6, complaints: 0, complaintSample: 6 });
    expect(h.bounceEmailIds).toEqual([e3.id, e2.id, e1.id]);
  });

  it("counts complaints only from complained events (suppress-complaint drops count 0)", async () => {
    const e1 = await email({ at: minutes(-3) });
    const e2 = await email({ at: minutes(-2) });
    const e3 = await email({ at: minutes(-1) });
    await event(e1.id, { type: "failed", severity: "permanent", reason: "suppress-complaint" });
    await event(e2.id, { type: "failed", severity: "permanent", reason: "suppress-complaint" });
    expect(await loadHealthCounts(base)).toMatchObject({ complaints: 0, bounces: 0 });
    await event(e3.id, { type: "complained" });
    await event(e1.id, { type: "complained", isTestMode: true });
    const h = await loadHealthCounts(base);
    expect(h).toMatchObject({ complaints: 1 });
    expect(h.complaintEmailIds).toEqual([e3.id]);
  });

  it("uses fixed windows of the newest SENT emails in counted modes", async () => {
    const old = await email({ at: minutes(-100) });
    await event(old.id, { type: "failed", severity: "permanent", reason: "bounce" });
    const recent = [];
    for (let i = 0; i < 3; i++) recent.push(await email({ at: minutes(-10 + i) }));
    const dry = await email({ mode: "DRY_RUN", at: minutes(-1) });
    await event(dry.id, { type: "failed", severity: "permanent", reason: "bounce" });
    const unknown = await email({ status: "UNKNOWN", at: minutes(-1) });
    await event(unknown.id, { type: "failed", severity: "permanent", reason: "bounce" });

    // window 3: the old bounce is outside the window
    expect(await loadHealthCounts({ ...base, bounceWindow: 3, complaintWindow: 3 })).toMatchObject({ bounces: 0, bounceSample: 3, complaintSample: 3 });
    // window 4 reaches it
    expect(await loadHealthCounts({ ...base, bounceWindow: 4 })).toMatchObject({ bounces: 1, bounceSample: 4 });
    // the practice copy counts dry runs
    expect(await loadHealthCounts({ ...base, practiceCopy: true })).toMatchObject({ bounces: 2, bounceSample: 5 });
  });

  it("filters by since (after a resume) and before (a closed day)", async () => {
    const a = await email({ at: minutes(-30) });
    const b = await email({ at: minutes(-20) });
    const c = await email({ at: minutes(-10) });
    for (const e of [a, b, c]) await event(e.id, { type: "failed", severity: "permanent", reason: "bounce" });
    expect(await loadHealthCounts({ ...base, since: minutes(-20) })).toMatchObject({ bounces: 1, bounceSample: 1 });
    expect(await loadHealthCounts({ ...base, before: minutes(-10) })).toMatchObject({ bounces: 2, bounceSample: 2 });
    expect(await loadHealthCounts({ ...base, since: minutes(-31), before: minutes(-15) })).toMatchObject({ bounces: 2, bounceSample: 2 });
  });

  it("handles windows larger than one IN chunk", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 450; i++) {
      ids.push((await email({ at: new Date(NOW.getTime() - (i + 1) * 1000) })).id);
    }
    await event(ids[0]!, { type: "failed", severity: "permanent", reason: "bounce" });
    await event(ids[449]!, { type: "failed", severity: "permanent", reason: "bounce" });
    const h = await loadHealthCounts({ ...base, bounceWindow: 1000 });
    expect(h).toMatchObject({ bounces: 2, bounceSample: 450 });
    expect(h.bounceEmailIds).toEqual([ids[0], ids[449]]);
  }, 60_000);
});
