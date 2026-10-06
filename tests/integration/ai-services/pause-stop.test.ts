import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { actorOf, makeAiJob, makeCompany, makeDraft, seedUsers, type SeedUser } from "./seed";

/**
 * The AI queue's pause and the Stop button (docs/dev/M5-DESIGN.md §3.7, §3.9 "Stop", §8 P5 "pause" and "stop"):
 * compare-and-set with the first cause winning, the throttled Owner notice, `until`, resumeAi moving queued runs,
 * `onlyKinds`, and Stop acting on `ai.draftLines` jobs only.
 */

const t = await createTestDb("ai-pause");
const { db, dbWrite } = await import("@/server/db");
const { enqueueJob } = await import("@/server/jobs");
const { STATE_KEYS } = await import("@/core/system-state");
const ai = await import("@/server/services/ai");
const { ServiceError } = await import("@/server/services/companies/mutations");

const NOW = new Date("2026-09-26T08:00:00Z");
const KEY_TEXT = "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.";
const LIMIT_TEXT = "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 October.";
let owner: SeedUser;
let ali: SeedUser;

beforeAll(async () => {
  ({ owner, ali } = await seedUsers());
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.job.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.company.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: [STATE_KEYS.aiPause, STATE_KEYS.notices] } } });
  });
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("pauseAi and getAiPause", () => {
  it("is not paused by default", async () => {
    expect(await ai.getAiPause(NOW)).toEqual({ paused: false, kind: null, text: "", since: null, until: null, model: null, detail: null });
  });

  it("the first cause wins, and the Owner hears about it once", async () => {
    expect(await ai.pauseAi("key_rejected", { text: KEY_TEXT, until: null, detail: "401 authentication_error", now: NOW })).toEqual({ newlyPaused: true });
    expect(await ai.pauseAi("billing", { text: "Billing.", until: null, now: NOW })).toEqual({ newlyPaused: false });
    expect(await ai.getAiPause(NOW)).toEqual({
      paused: true,
      kind: "key_rejected",
      text: KEY_TEXT,
      since: NOW.toISOString(),
      until: null,
      model: null,
      detail: "401 authentication_error",
    });
    const notes = await db.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: owner.id, type: "ai.paused", title: "AI drafting paused", body: KEY_TEXT, link: "/settings/ai" });

    // Resumed and paused again for the same reason within 24 hours: paused, but no second notice.
    await ai.resumeAi(actorOf(owner), { now: NOW });
    expect((await ai.pauseAi("key_rejected", { text: KEY_TEXT, until: null, now: new Date(NOW.getTime() + 3_600_000) })).newlyPaused).toBe(true);
    expect(await db.notification.count()).toBe(1);
  });

  it("a pause with `until` lifts by itself, and a new cause may then pause again", async () => {
    const until = new Date("2026-09-30T19:00:00Z");
    await ai.pauseAi("monthly_limit", { text: LIMIT_TEXT, until, now: NOW });
    expect(await db.notification.findFirstOrThrow()).toMatchObject({ title: "AI drafting stopped", body: LIMIT_TEXT });
    expect((await ai.getAiPause(new Date(until.getTime() - 1))).paused).toBe(true);
    expect((await ai.getAiPause(until)).paused).toBe(false);
    const later = new Date(until.getTime() + 60_000);
    expect(await ai.pauseAi("model_not_found", { text: "Model.", until: null, model: "claude-x", now: later })).toEqual({ newlyPaused: true });
    expect(await ai.getAiPause(later)).toMatchObject({ paused: true, kind: "model_not_found", model: "claude-x", until: null });
  });
});

describe("resumeAi", () => {
  it("is for the Owner only, moves waiting runs to now and logs it", async () => {
    await ai.pauseAi("billing", { text: "Billing.", until: null, now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    const waiting = await enqueueJob({ type: "ai.draftLines", runAt: later });
    const backup = await enqueueJob({ type: "backup.run", runAt: later });
    expect(await refusal(ai.resumeAi(actorOf(ali), { now: NOW }))).toBe("Only the Owner can resume AI drafting.");
    expect((await ai.getAiPause(NOW)).paused).toBe(true);

    expect(await ai.resumeAi(actorOf(owner), { now: NOW })).toEqual({ message: "AI drafting resumed.", resumed: true });
    expect((await ai.getAiPause(NOW)).paused).toBe(false);
    expect((await db.job.findUniqueOrThrow({ where: { id: waiting.id } })).runAt).toEqual(NOW);
    expect((await db.job.findUniqueOrThrow({ where: { id: backup.id } })).runAt).toEqual(later);
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } });
    expect(act).toMatchObject({ actorId: owner.id, summary: "Arslan resumed AI drafting" });
    expect(act.data).toEqual({ key: "ai.pause", kind: "billing" });
    expect(await ai.resumeAi(actorOf(owner), { now: NOW })).toEqual({ message: "AI drafting isn't paused.", resumed: false });
  });

  it("with onlyKinds, lifts only those kinds (saving a key lifts key_rejected, not the monthly limit)", async () => {
    await ai.pauseAi("monthly_limit", { text: LIMIT_TEXT, until: new Date("2026-09-30T19:00:00Z"), now: NOW });
    expect(await ai.resumeAi(actorOf(owner), { onlyKinds: ["key_rejected", "no_permission"], now: NOW })).toMatchObject({ resumed: false });
    expect((await ai.getAiPause(NOW)).kind).toBe("monthly_limit");
    expect(await ai.resumeAi(actorOf(owner), { onlyKinds: ["monthly_limit"], now: NOW })).toMatchObject({ resumed: true });
    expect((await ai.getAiPause(NOW)).paused).toBe(false);

    await ai.pauseAi("key_rejected", { text: KEY_TEXT, until: null, now: NOW });
    expect((await ai.resumeAi(actorOf(owner), { onlyKinds: ["key_rejected", "no_permission"], now: NOW })).resumed).toBe(true);
  });
});

describe("stopDraftRun", () => {
  it("refuses other job types and leaves them alone", async () => {
    const backup = await enqueueJob({ type: "backup.run" });
    const catchUp = await enqueueJob({ type: "mailgun.catchUp" });
    expect(await refusal(ai.stopDraftRun(actorOf(ali), backup.id))).toBe("This isn't an AI drafting run.");
    expect(await refusal(ai.stopDraftRun(actorOf(ali), catchUp.id))).toBe("This isn't an AI drafting run.");
    expect(await refusal(ai.stopDraftRun(actorOf(ali), 999_999))).toBe("This isn't an AI drafting run.");
    for (const id of [backup.id, catchUp.id]) expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe("QUEUED");
  });

  it("cancels a queued run at once and takes its drafts off the list (paid ones become FAILED)", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const job = await makeAiJob("QUEUED");
    await makeDraft({ companyId: co, jobId: job });
    await makeDraft({ companyId: co, jobId: job });
    const paid = await makeDraft({ companyId: co, jobId: job, calls: 1, costUsd: 0.004, draftedAt: NOW });
    expect(await ai.stopDraftRun(actorOf(ali), job, { now: NOW })).toEqual({ message: "Drafting stopped before it started." });
    expect(await db.job.findUniqueOrThrow({ where: { id: job } })).toMatchObject({ status: "CANCELLED" });
    expect(await db.aiDraft.count({ where: { jobId: job } })).toBe(1);
    expect(await db.aiDraft.findUniqueOrThrow({ where: { id: paid } })).toMatchObject({ status: "FAILED", error: "Stopped before a line was finished.", costUsd: 0.004 });
    expect(await ai.stopDraftRun(actorOf(ali), job, { now: NOW })).toEqual({ message: "This drafting run has already finished." });
  });

  it("a queued run that a stopped worker left mid-call keeps that call's possible cost", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const job = await makeAiJob("QUEUED");
    const midCall = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    const midRead = await makeDraft({ companyId: co, jobId: job, status: "FETCHING", readAttempts: 1 });
    await ai.stopDraftRun(actorOf(ali), job, { now: NOW });
    expect(await db.aiDraft.findUniqueOrThrow({ where: { id: midCall } })).toMatchObject({
      status: "FAILED",
      error: "Stopped before a line was finished.",
      calls: 1,
      costUsd: 0.0084,
    });
    expect(await db.aiDraft.findUnique({ where: { id: midRead } })).toBeNull();
  });

  it("a deferred run that already drafted some says how far it got", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const job = await makeAiJob("QUEUED", { runAt: new Date(NOW.getTime() + 600_000) });
    await makeDraft({ companyId: co, jobId: job, status: "READY" });
    await makeDraft({ companyId: co, jobId: job });
    await makeDraft({ companyId: co, jobId: job });
    expect(await ai.stopDraftRun(actorOf(ali), job, { now: NOW })).toEqual({ message: "Stopped after 1 of 3 companies." });
    expect(await db.aiDraft.count({ where: { jobId: job } })).toBe(1);
  });

  it("asks a running run to stop at its next safe point and leaves its drafts to it", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const job = await makeAiJob("RUNNING");
    await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    await makeDraft({ companyId: co, jobId: job });
    const res = await ai.stopDraftRun(actorOf(ali), job, { now: NOW });
    expect(res.message).toBe("Stopping. The companies being drafted right now are finished first.");
    expect(await db.job.findUniqueOrThrow({ where: { id: job } })).toMatchObject({ status: "RUNNING", cancelRequestedAt: NOW });
    expect(await db.aiDraft.count({ where: { jobId: job } })).toBe(2);
  });
});
