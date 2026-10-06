import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The check pause and Resume (M5-DESIGN §2.12), this office month's spend (§2.10) and a run's counts and views
 * (§2.11, §6.11), on a temp database.
 */

const t = await createTestDb("verification-pause-spend");
const { db, dbWrite } = await import("@/server/db");
const { getChecksPause, pauseChecks, resumeChecks } = await import("@/server/services/verification/pause");
const { checksThisMonth, monthlyCheckLimit } = await import("@/server/services/verification/spend");
const { checkCostEstimate } = await import("@/server/services/verification/estimate");
const runs = await import("@/server/services/verification/runs");
const { EMPTY_VERIFY_CARRY } = await import("@/core/verification/types");
const { checkPauseText } = await import("@/core/verification/words");

let owner: { id: number; name: string };

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["checks.pause", "notices"] } } }));
  await dbWrite((c) => c.notification.deleteMany({}));
  await dbWrite((c) => c.verificationCheck.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function row(data: Partial<Prisma.VerificationCheckUncheckedCreateInput> & { emailNorm: string }) {
  return dbWrite((c) =>
    c.verificationCheck.create({
      data: { provider: "mailgun-fake", status: "VALID", risk: "LOW", costUsd: 0.012, source: "contacts", ...data },
    }),
  );
}

describe("the check pause (§2.12)", () => {
  const NOW = new Date("2026-09-30T10:00:00Z");

  it("the first cause wins, and the Owner gets one notice per kind per 24 hours", async () => {
    await pauseChecks("auth", checkPauseText("auth"), "Invalid private key", { now: NOW });
    await pauseChecks("payment", checkPauseText("payment"), null, { now: NOW });
    const p = await getChecksPause(NOW);
    expect(p).toMatchObject({ paused: true, kind: "auth", text: checkPauseText("auth"), detail: "Invalid private key", until: null });
    expect(p.since).toBe(NOW.toISOString());
    const notes = await db.notification.findMany({ where: { userId: owner.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "verify.paused",
      title: "Address checks paused",
      body: checkPauseText("auth"),
      link: "/settings/deliverability#checks",
    });

    // Resumed, then paused again for the same reason within 24 hours: no second notice.
    expect(await resumeChecks(owner, { now: NOW })).toEqual({ message: "Address checks resumed." });
    await pauseChecks("auth", checkPauseText("auth"), null, { now: new Date(NOW.getTime() + 3_600_000) });
    expect((await getChecksPause(NOW)).paused).toBe(true);
    expect(await db.notification.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("a monthly-limit pause reads as not paused once its `until` has passed, and is replaced then", async () => {
    const until = new Date("2026-09-30T19:00:00Z");
    const text = checkPauseText("monthly_limit", { limitUsd: 100, resetLabel: "1 October" });
    await pauseChecks("monthly_limit", text, null, { until, now: NOW });
    expect(await getChecksPause(NOW)).toMatchObject({ paused: true, kind: "monthly_limit", until: until.toISOString() });
    expect((await db.notification.findFirstOrThrow({ where: { userId: owner.id } })).title).toBe("Address checks stopped");
    const later = new Date("2026-09-30T19:00:01Z");
    expect(await getChecksPause(later)).toEqual({ paused: false, kind: null, text: "", since: null, until: null, detail: null });
    await pauseChecks("unreadable", checkPauseText("unreadable"), null, { now: later });
    expect((await getChecksPause(later)).kind).toBe("unreadable");
  });

  it("resume clears the pause, lets waiting check runs go at once and logs who did it", async () => {
    await pauseChecks("payment", checkPauseText("payment"), null, { now: NOW });
    const deferred = await dbWrite((c) =>
      c.job.create({ data: { type: "verify.addresses", status: "QUEUED", runAt: new Date(NOW.getTime() + 3_600_000), payload: { source: "recheck" } } }),
    );
    const backup = await dbWrite((c) => c.job.create({ data: { type: "backup.run", status: "QUEUED", runAt: new Date(NOW.getTime() + 3_600_000) } }));
    // Saving an address check key lifts only an "auth" pause.
    expect(await resumeChecks(owner, { onlyKinds: ["auth"], now: NOW })).toEqual({ message: "Address checks stay paused for another reason." });
    expect((await getChecksPause(NOW)).paused).toBe(true);

    expect(await resumeChecks(owner, { now: NOW })).toEqual({ message: "Address checks resumed." });
    expect((await getChecksPause(NOW)).paused).toBe(false);
    expect((await db.job.findUniqueOrThrow({ where: { id: deferred.id } })).runAt.getTime()).toBe(NOW.getTime());
    expect((await db.job.findUniqueOrThrow({ where: { id: backup.id } })).runAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" }, orderBy: { id: "desc" } });
    expect(activity).toMatchObject({ actorId: owner.id, summary: "Arslan resumed address checks" });
    expect(await resumeChecks(owner, { now: NOW })).toEqual({ message: "Address checks aren't paused." });
  });
});

describe("checksThisMonth (the office month, Asia/Karachi)", () => {
  it("splits at midnight in Karachi: 30 Sep 19:30 UTC is already October", async () => {
    await row({ emailNorm: "sep@spend.example", checkedAt: new Date("2026-09-30T18:30:00Z") }); // 23:30 in Karachi, September
    await row({ emailNorm: "oct@spend.example", checkedAt: new Date("2026-09-30T19:30:00Z") }); // 00:30 on 1 October
    await row({ emailNorm: "oct2@spend.example", checkedAt: new Date("2026-10-02T10:00:00Z"), provider: "mailgun", costUsd: 0.012 });
    await row({ emailNorm: "fake@spend.example", checkedAt: new Date("2026-10-02T10:00:00Z"), provider: "fake", costUsd: 0 });
    await row({ emailNorm: "free@spend.example", checkedAt: new Date("2026-10-03T10:00:00Z"), costUsd: 0 });
    expect(await checksThisMonth(new Date("2026-09-30T19:30:00Z"))).toEqual({ count: 3, costUsd: 0.024 });
    expect(await checksThisMonth(new Date("2026-09-30T18:00:00Z"))).toEqual({ count: 1, costUsd: 0.012 });
    expect(await monthlyCheckLimit(0.01, { now: new Date("2026-10-05T00:00:00Z") })).toEqual({ limitUsd: 100, spentUsd: 0.024, wouldPass: false });
  });

  it("uses this month's included checks first in the estimate", async () => {
    const now = new Date("2026-10-05T00:00:00Z");
    await setSettingValue("verification.includedPerMonth", 5);
    for (let i = 0; i < 3; i++) await row({ emailNorm: `inc${i}@spend.example`, checkedAt: new Date("2026-10-02T10:00:00Z"), costUsd: 0 });
    expect(await checkCostEstimate(4, now)).toMatchObject({ freeLeft: 2, paidCount: 2, aboutUsd: 0.024, includedPerMonth: 5 });
    await setSettingValue("verification.includedPerMonth", 0);
    await setSettingValue("practice.copy", true);
    expect(await checkCostEstimate(4, now)).toMatchObject({ provider: "fake", free: true, aboutUsd: 0 });
  });
});

describe("check runs (§2.11, §6.11)", () => {
  async function job(data: Partial<Prisma.JobUncheckedCreateInput>) {
    return dbWrite((c) => c.job.create({ data: { type: "verify.addresses", status: "DONE", ...data } }));
  }

  it("counts a run from its rows and its carry, with the current policy", async () => {
    const j = await job({ payload: { source: "contacts", personIds: [], confirmedCount: 9, recheckRecent: false } });
    const r = (emailNorm: string, over: Partial<Prisma.VerificationCheckUncheckedCreateInput> = {}) => row({ emailNorm, jobId: j.id, ...over });
    await r("ok@run.example");
    await r("medium@run.example", { risk: "MEDIUM" });
    await r("low-catch@run.example", { status: "CATCH_ALL", risk: "LOW" });
    await r("catch@run.example", { status: "CATCH_ALL", risk: "MEDIUM" });
    await r("risky@run.example", { status: "RISKY", risk: "HIGH" });
    await r("temp@run.example", { isDisposable: true });
    await r("bad@run.example", { status: "INVALID", risk: "HIGH" });
    await r("dns@run.example", { status: "DO_NOT_SEND", risk: "HIGH" });
    await r("unknown@run.example", { status: "UNKNOWN", risk: "UNKNOWN" });
    await r("weird@run.example", { status: "UNKNOWN", risk: "UNKNOWN", reasons: ["app:unreadable_response"] });
    const carry = { ...EMPTY_VERIFY_CARRY, refused: 1, notReached: 2, mayBeCharged: 1, skipped: { fresh: 3, suppressed: 1, noEmail: 0, neverEmailed: 2 } };
    const json = (v: unknown) => v as Prisma.InputJsonValue;
    await dbWrite((c) => c.job.update({ where: { id: j.id }, data: { result: json({ summary: "done", carry }) } }));

    const counts = await runs.checkRunCounts(j.id);
    expect(counts).toEqual({
      checked: 9,
      canEmail: 3,
      lowRiskCatchAll: 1,
      invalid: 1,
      doNotSend: 1,
      risky: 1,
      catchAllBlocked: 1,
      disposable: 1,
      unknown: 1,
      refused: 1,
      notReached: 3,
      mayBeCharged: 1,
      skipped: { fresh: 3, suppressed: 1, noEmail: 0, neverEmailed: 2 },
      costUsd: 0.12,
    });
    // The job's own (newer) carry wins when it passes one.
    expect((await runs.checkRunCounts(j.id, { ...carry, refused: 4 })).refused).toBe(4);

    // Stored counts (frozen at the end of the run) are what the view shows.
    const view = await runs.checkRunView(j.id);
    expect(view).toMatchObject({ status: "DONE", counts, single: null, error: null });
    expect(view.leftOut).toEqual([]); // rows without a person leave nobody out by name
    const frozen = { ...counts, canEmail: 99 };
    await dbWrite((c) => c.job.update({ where: { id: j.id }, data: { result: json({ summary: "done", carry, counts: frozen }) } }));
    expect((await runs.checkRunView(j.id)).counts?.canEmail).toBe(99);
  });

  it("gives a panel run's one address and who a run left out", async () => {
    const co = await makeCompany({ name: "Runs Co", people: [{ name: "Anna Berg" }, { name: "Ok Person" }, { name: "First Unknown" }] });
    const [anna, okP, unk] = co.people;
    const single = {
      personId: anna!.id,
      outcome: "checked",
      skipReason: null,
      status: "INVALID",
      risk: "HIGH",
      disposable: false,
      decision: "undeliverable",
      ms: 1400,
      detail: null,
    };
    const j = await job({ payload: { source: "panel", personIds: [anna!.id], confirmedCount: 1, recheckRecent: true }, result: { summary: "x", single } });
    await row({ emailNorm: anna!.emailNorm!, personId: anna!.id, jobId: j.id, status: "INVALID", risk: "HIGH" });
    await row({ emailNorm: okP!.emailNorm!, personId: okP!.id, jobId: j.id });
    await row({ emailNorm: unk!.emailNorm!, personId: unk!.id, jobId: j.id, status: "UNKNOWN", risk: "UNKNOWN" });
    const view = await runs.checkRunView(j.id);
    expect(view.single).toEqual(single);
    expect(view.leftOut).toEqual([{ personId: anna!.id, name: "Anna Berg", email: anna!.emailNorm, companyName: "Runs Co", reason: "doesn't exist" }]);

    // A queued run has no counts yet, and says until when it waits.
    const waiting = await job({ status: "QUEUED", runAt: new Date(Date.now() + 600_000), progressDone: 3, progressTotal: 9 });
    const w = await runs.checkRunView(waiting.id);
    expect(w).toMatchObject({ status: "QUEUED", done: 3, total: 9, counts: null, leftOut: [] });
    expect(w.waitingUntil).not.toBeNull();
  });

  it("refuses a job of another type", async () => {
    const backup = await dbWrite((c) => c.job.create({ data: { type: "backup.run" } }));
    await expect(runs.checkRunView(backup.id)).rejects.toThrow("This isn't an address check run.");
  });

  it("finds the campaign's active run, whether it waits behind another one, and else its latest run", async () => {
    const draft = await makeDraft({ name: "Runs Q4", createdById: owner.id });
    expect(await runs.activeCampaignCheckRun(draft.id)).toBeNull();
    expect(await runs.campaignCheckRun(draft.id)).toBeNull();
    const now = new Date();
    const payload = { source: "wizard", campaignId: draft.id, personIds: [1, 2], confirmedCount: 2 };
    const old = await job({ payload, status: "DONE", result: { summary: "2 addresses checked: 2 can be emailed. Cost $0.02." } });
    expect(await runs.campaignCheckRun(draft.id, now)).toMatchObject({ jobId: old.id, status: "DONE", summary: "2 addresses checked: 2 can be emailed. Cost $0.02." });

    const active = await job({ payload, status: "QUEUED", runAt: new Date(now.getTime() - 1_000), activeDedupeKey: `verify:campaign:${draft.id}`, progressTotal: 2 });
    const other = await job({ payload: { source: "contacts", personIds: [], confirmedCount: 0, recheckRecent: false }, status: "RUNNING" });
    expect(await runs.activeCampaignCheckRun(draft.id, now)).toEqual({ jobId: active.id, done: 0, total: 2, queuedBehindOther: true });
    expect(await runs.campaignCheckRun(draft.id, now)).toMatchObject({ jobId: active.id, status: "QUEUED", blockedByOtherRun: true, waitingUntil: null });
    await dbWrite((c) => c.job.update({ where: { id: other.id }, data: { status: "DONE" } }));
    expect((await runs.activeCampaignCheckRun(draft.id, now))?.queuedBehindOther).toBe(false);
  });

  it("reads stored payloads and carries leniently", () => {
    expect(runs.readVerifyRunPayload({ source: "wizard", campaignId: 3, personIds: [1, "x", 2], confirmedCount: 2 })).toEqual({
      source: "wizard",
      campaignId: 3,
      personIds: [1, 2],
      confirmedCount: 2,
    });
    expect(runs.readVerifyRunPayload({ source: "nope" })).toBeNull();
    const carry = runs.readVerifyRunCarry({ cursor: 5, pending: [3, -1], timeouts: { "7": 2, x: 1 }, refused: "no", uncommitted: [{ emailNorm: "a@b", result: {} }] });
    expect(carry).toMatchObject({ cursor: 5, pending: [3], timeouts: { "7": 2 }, refused: 0, uncommitted: [], single: null });
    expect(runs.readVerifyRunCarry(null)).toEqual(EMPTY_VERIFY_CARRY);
    expect(runs.readCheckRunCounts({ checked: 1 })).toBeNull();
  });
});
