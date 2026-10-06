import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeAiJob, makeCompany, makeDraft, seedUsers } from "./seed";

/**
 * The drafting job's writers (docs/dev/M5-DESIGN.md §3.4.9, §3.7, §3.8, §8 P5 "drafts" and "spend is never erased"):
 * the claim with busy hosts, the compare-and-set transitions, recordCall's sums, finishDraft's fields, resetStuckDrafts,
 * deleteQueuedDrafts, failOrphanedDrafts (a cancelled run included), snapshots and their reuse, and the spend sums.
 */

const t = await createTestDb("ai-drafts");
const { db, dbWrite } = await import("@/server/db");
const ai = await import("@/server/services/ai");

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const NOW = new Date("2026-09-26T08:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
  await seedUsers();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.websiteSnapshot.deleteMany({});
    await c.job.deleteMany({});
    await c.company.deleteMany({});
  });
});

const draftRow = (id: number) => db.aiDraft.findUniqueOrThrow({ where: { id } });
const call = (over: Partial<import("@/core/ai/types").CallRecord> = {}) => ({
  inputTokens: 3_000,
  outputTokens: 120,
  costUsd: 0.0036,
  requestId: "req_1",
  stopReason: "end_turn",
  estimated: false,
  ...over,
});

describe("claimQueuedDrafts", () => {
  it("claims distinct hosts that aren't busy, writes the model and counts the read attempt", async () => {
    const job = await makeAiJob("RUNNING");
    const a1 = await makeCompany({ name: "A one", website: "https://www.a.de", country: "DE", niche: "miniatures", domain: "a.de" });
    const a2 = await makeCompany({ name: "A two", website: "https://a.de/shop", domain: "a.de" });
    const b = await makeCompany({ name: "B", website: "https://b.no" });
    const c = await makeCompany({ name: "C", website: "https://c.de" });
    const gone = await makeCompany({ name: "Gone", website: null });
    const d1 = await makeDraft({ companyId: a1, jobId: job });
    const d2 = await makeDraft({ companyId: a2, jobId: job });
    const d3 = await makeDraft({ companyId: b, jobId: job });
    const d4 = await makeDraft({ companyId: c, jobId: job });
    const d5 = await makeDraft({ companyId: gone, jobId: job });
    await dbWrite((cl) => cl.aiDraft.update({ where: { id: d1 }, data: { avoidLines: ["An earlier line."], refetch: true } }));
    const other = await makeDraft({ companyId: b, jobId: await makeAiJob("RUNNING") });

    const first = await ai.claimQueuedDrafts(job, 4, new Set(["c.de"]), SONNET);
    expect(first.map((d) => d.id)).toEqual([d1, d3, d5]);
    expect(first[0]).toEqual({
      id: d1,
      companyId: a1,
      companyName: "A one",
      website: "https://www.a.de",
      host: "a.de",
      countryName: "Germany",
      niche: "miniatures",
      companyDomain: "a.de",
      refetch: true,
      avoidLines: ["An earlier line."],
      readAttempts: 1,
      model: SONNET,
    });
    expect(first[2]!.host).toBe(`#company-${gone}`);
    for (const id of [d1, d3, d5]) expect(await draftRow(id)).toMatchObject({ status: "FETCHING", readAttempts: 1, model: SONNET });
    expect((await draftRow(d2)).status).toBe("QUEUED");
    expect((await draftRow(other)).status).toBe("QUEUED");

    const second = await ai.claimQueuedDrafts(job, 4, new Set(["a.de", "b.no", `#company-${gone}`]), HAIKU);
    expect(second.map((d) => d.id)).toEqual([d4]);
    expect(await ai.claimQueuedDrafts(job, 0, new Set(), HAIKU)).toEqual([]);
    expect((await ai.claimQueuedDrafts(job, 4, new Set(), HAIKU)).map((d) => d.id)).toEqual([d2]);
  });
});

describe("transitions are compare-and-set", () => {
  it("markDrafting, finishDraft and requeueDraft return false for a draft another attempt already took", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, jobId: job, status: "FETCHING" });
    expect(await ai.markDrafting(d, job + 1)).toBe(false);
    expect(await ai.markDrafting(d, job)).toBe(true);
    expect((await draftRow(d)).status).toBe("DRAFTING");
    expect(await ai.requeueDraft(d, job)).toBe(true);
    // QUEUED now: nothing but a claim may take it.
    expect(await ai.markDrafting(d, job)).toBe(false);
    expect(await ai.requeueDraft(d, job)).toBe(false);
    expect(await ai.finishDraft(d, job, { status: "FAILED", error: "x", flags: [] })).toBe(false);

    await dbWrite((c) => c.aiDraft.update({ where: { id: d }, data: { status: "READY" } }));
    expect(await ai.finishDraft(d, job, { status: "FAILED", error: "x", flags: [] })).toBe(false);
    expect((await draftRow(d)).status).toBe("READY");
  });

  it("finishDraft writes READY, NO_LINE and FAILED fields and keeps a cost-estimated flag", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const ready = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    await ai.recordCall(ready, call({ estimated: true, costUsd: 0.0084, requestId: null, stopReason: null }), NOW);
    expect(
      await ai.finishDraft(ready, job, {
        status: "READY",
        line: "You sell 32mm fantasy miniatures in resin.",
        evidenceQuote: "32mm fantasy miniatures in resin",
        evidenceSource: "homepage",
        evidenceUrl: "https://a.de/",
        flags: [{ code: "quote-other-page", text: "Found on the other page." }],
        homeSnapshotId: 11,
        pageSnapshotId: 12,
      }),
    ).toBe(true);
    const r = await draftRow(ready);
    expect(r).toMatchObject({
      status: "READY",
      line: "You sell 32mm fantasy miniatures in resin.",
      evidenceQuote: "32mm fantasy miniatures in resin",
      evidenceSource: "homepage",
      evidenceUrl: "https://a.de/",
      homeSnapshotId: 11,
      pageSnapshotId: 12,
      calls: 1,
      costUsd: 0.0084,
    });
    expect(r.flags).toEqual([
      { code: "quote-other-page", text: "Found on the other page." },
      { code: "cost-estimated", text: ai.COST_ESTIMATED_TIMEOUT_TEXT },
    ]);

    const noLine = await makeDraft({ companyId: co, jobId: job, status: "FETCHING" });
    await ai.finishDraft(noLine, job, { status: "NO_LINE", reasonIfNull: "parked", flags: [], homeSnapshotId: 5, pageSnapshotId: null });
    expect(await draftRow(noLine)).toMatchObject({ status: "NO_LINE", reasonIfNull: "parked", line: null, homeSnapshotId: 5, flags: [] });

    const failed = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    await ai.finishDraft(failed, job, { status: "FAILED", error: "Claude couldn't write a line for this company. Click Try again later.", flags: [] });
    expect(await draftRow(failed)).toMatchObject({ status: "FAILED", error: "Claude couldn't write a line for this company. Click Try again later." });
  });
});

describe("recordCall", () => {
  it("adds every call: calls, tokens and cost summed, the last stop reason and request id, draftedAt", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, jobId: await makeAiJob("RUNNING"), status: "DRAFTING" });
    await ai.recordCall(d, call(), NOW);
    const later = new Date(NOW.getTime() + 5_000);
    await ai.recordCall(d, call({ inputTokens: 3_200, outputTokens: 180, costUsd: 0.0041, requestId: "req_2", stopReason: "max_tokens" }), later);
    expect(await draftRow(d)).toMatchObject({
      calls: 2,
      inputTokens: 6_200,
      outputTokens: 300,
      costUsd: 0.0077,
      stopReason: "max_tokens",
      requestId: "req_2",
      draftedAt: later,
      flags: null,
    });
    // A call without an answer keeps the last request id and adds the flag once.
    await ai.recordCall(d, call({ inputTokens: 0, outputTokens: 0, costUsd: 0.0084, requestId: null, stopReason: null, estimated: true }), later);
    await ai.recordCall(d, call({ costUsd: 0, estimated: true, requestId: null }), later);
    const r = await draftRow(d);
    expect(r).toMatchObject({ calls: 4, costUsd: 0.0161, requestId: "req_2" });
    expect(r.flags).toEqual([{ code: "cost-estimated", text: ai.COST_ESTIMATED_TIMEOUT_TEXT }]);
  });

  it("records money whatever the draft's state (no compare-and-set on the status)", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, status: "FAILED" });
    await ai.recordCall(d, call(), NOW);
    expect(await draftRow(d)).toMatchObject({ status: "FAILED", calls: 1, costUsd: 0.0036 });
  });

  it("an error answer (not billed) keeps only its request id: no call, no tokens, no draftedAt (AI-8)", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, jobId: await makeAiJob("RUNNING"), status: "DRAFTING" });
    await ai.markCallInFlight(d, 0.0084);
    await ai.recordCall(d, call({ inputTokens: 0, outputTokens: 0, costUsd: 0, requestId: "req_400", stopReason: null, notBilled: true }), NOW);
    expect(await draftRow(d)).toMatchObject({ calls: 0, inputTokens: null, outputTokens: null, costUsd: null, draftedAt: null, requestId: "req_400", stopReason: null });
    // After a billed call, a later error answer changes nothing but the request id.
    await ai.recordCall(d, call(), NOW);
    const later = new Date(NOW.getTime() + 5_000);
    await ai.recordCall(d, call({ inputTokens: 0, outputTokens: 0, costUsd: 0, requestId: "req_401", stopReason: null, notBilled: true }), later);
    expect(await draftRow(d)).toMatchObject({ calls: 1, inputTokens: 3_000, outputTokens: 120, costUsd: 0.0036, draftedAt: NOW, requestId: "req_401" });
  });
});

describe("the call in flight (AI-7)", () => {
  it("markCallInFlight notes the reserved ceiling; recordCall replaces it with the call's stop reason; clearCallInFlight removes it", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, jobId: await makeAiJob("RUNNING"), status: "DRAFTING" });
    await ai.markCallInFlight(d, 0.0114429);
    expect((await draftRow(d)).stopReason).toBe("in-flight:0.011443");
    expect(ai.inFlightCeiling("in-flight:0.011443")).toBe(0.011443);
    expect(ai.inFlightCeiling("end_turn")).toBeNull();
    expect(ai.inFlightCeiling(null)).toBeNull();
    expect(ai.inFlightCeiling("in-flight:x")).toBeNull();
    await ai.recordCall(d, call(), NOW);
    expect((await draftRow(d)).stopReason).toBe("end_turn");
    await ai.clearCallInFlight(d);
    expect((await draftRow(d)).stopReason).toBe("end_turn");
    await ai.markCallInFlight(d, 0.0084);
    await ai.clearCallInFlight(d);
    expect((await draftRow(d)).stopReason).toBeNull();
  });

  it("resetStuckDrafts and failOrphanedDrafts charge the reserved ceiling of the call that was out, never the smaller default", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    // A doubled max_tokens retry was out: its ceiling ($0.0114) is more than one call at the page cap ($0.0084).
    const retry = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING", model: HAIKU, calls: 1, costUsd: 0.006, inputTokens: 3_000 });
    await ai.markCallInFlight(retry, 0.0114);
    // Nothing was out (between two calls): one call at the page cap, as before.
    const between = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING", model: HAIKU });
    expect(await ai.resetStuckDrafts(job, NOW)).toBe(2);
    const r = await draftRow(retry);
    expect(r).toMatchObject({ status: "QUEUED", calls: 2, costUsd: 0.0174, stopReason: null, draftedAt: NOW });
    expect(r.flags).toEqual([{ code: "cost-estimated", text: ai.COST_ESTIMATED_RESTART_TEXT }]);
    expect(await draftRow(between)).toMatchObject({ status: "QUEUED", calls: 1, costUsd: 0.0084 });

    const failed = await makeAiJob("FAILED");
    const orphan = await makeDraft({ companyId: co, jobId: failed, status: "DRAFTING", model: HAIKU });
    await ai.markCallInFlight(orphan, 0.0231);
    expect(await ai.failOrphanedDrafts(NOW)).toBe(1);
    expect(await draftRow(orphan)).toMatchObject({ status: "FAILED", calls: 1, costUsd: 0.0231, stopReason: null });
  });
});

describe("read attempts count only interrupted reads (DATA-05)", () => {
  it("a read that finishes, or a claim put back on purpose, takes its attempt back; two interrupted reads fail the draft", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://slow.example" });
    const d = await makeDraft({ companyId: co, jobId: job });
    const claim = async () => {
      const got = await ai.claimQueuedDrafts(job, 1, new Set(), HAIKU);
      expect(got.map((x) => x.id)).toEqual([d]);
      return got[0]!;
    };

    // Claimed, then put back without a finished read (a pause, shutdown): not counted.
    expect((await claim()).readAttempts).toBe(1);
    expect(await ai.requeueDraft(d, job)).toBe(true);
    expect(await draftRow(d)).toMatchObject({ status: "QUEUED", readAttempts: 0 });

    // Claimed and read: not counted either (the requeue from DRAFTING keeps it at 0).
    await claim();
    expect(await ai.markDrafting(d, job)).toBe(true);
    expect(await draftRow(d)).toMatchObject({ status: "DRAFTING", readAttempts: 0 });
    expect(await ai.requeueDraft(d, job)).toBe(true);
    expect(await draftRow(d)).toMatchObject({ status: "QUEUED", readAttempts: 0 });

    // The reported case: a crash during the read after those normal requeues is read again, not failed.
    await claim();
    expect(await ai.resetStuckDrafts(job, NOW)).toBe(1);
    expect(await draftRow(d)).toMatchObject({ status: "QUEUED", readAttempts: 1 });

    // A second interrupted read: the page is never read a third time.
    await claim();
    expect(await ai.resetStuckDrafts(job, NOW)).toBe(1);
    expect(await draftRow(d)).toMatchObject({ status: "FAILED", error: ai.UNSAFE_SITE_TEXT, readAttempts: 2 });
  });
});

describe("spend is never erased", () => {
  it("requeueDraft keeps tokens, cost, calls and draftedAt", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const d = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    await ai.recordCall(d, call(), NOW);
    expect(await ai.requeueDraft(d, job)).toBe(true);
    expect(await draftRow(d)).toMatchObject({ status: "QUEUED", calls: 1, inputTokens: 3_000, outputTokens: 120, costUsd: 0.0036, draftedAt: NOW });
  });

  it("resetStuckDrafts requeues FETCHING, fails a twice-stuck read, and charges a DRAFTING draft one call's ceiling", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const fetching = await makeDraft({ companyId: co, jobId: job, status: "FETCHING", readAttempts: 1 });
    const poison = await makeDraft({ companyId: co, jobId: job, status: "FETCHING", readAttempts: 2 });
    const drafting = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING", model: HAIKU, calls: 1, costUsd: 0.004, inputTokens: 3_000 });
    const otherJob = await makeDraft({ companyId: co, jobId: await makeAiJob("RUNNING"), status: "DRAFTING" });
    const ready = await makeDraft({ companyId: co, jobId: job, status: "READY", costUsd: 0.005 });

    expect(await ai.resetStuckDrafts(job, NOW)).toBe(3);
    expect(await draftRow(fetching)).toMatchObject({ status: "QUEUED", readAttempts: 1 });
    expect(await draftRow(poison)).toMatchObject({ status: "FAILED", error: "This website couldn't be read safely." });
    const d = await draftRow(drafting);
    // Haiku's ceiling with the default 1,400 system tokens: ((1,400 + 4,000) × $1 + 600 × $5) / 1e6 = $0.0084.
    expect(d).toMatchObject({ status: "QUEUED", calls: 2, costUsd: 0.0124, inputTokens: 3_000, draftedAt: NOW });
    expect(d.flags).toEqual([{ code: "cost-estimated", text: ai.COST_ESTIMATED_RESTART_TEXT }]);
    expect((await draftRow(otherJob)).status).toBe("DRAFTING");
    expect((await draftRow(ready)).status).toBe("READY");
    expect(await ai.resetStuckDrafts(job, NOW)).toBe(0);
  });

  it("resetStuckDrafts uses the measured system tokens, and charges nothing for a model without a price", async () => {
    const { setState } = await import("@/server/state");
    const { STATE_KEYS } = await import("@/core/system-state");
    await setState(STATE_KEYS.aiTokens, { entries: { [`${SONNET}|pl-2026-09-26`]: { systemTokens: 2_000, measuredAt: NOW.toISOString() } } });
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const sonnet = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING", model: SONNET });
    const practice = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING", model: "practice" });
    expect(await ai.resetStuckDrafts(job, NOW)).toBe(2);
    // ((2,000 + 5,200) × $2 + 2,000 × $10) / 1e6 = $0.0344.
    expect(await draftRow(sonnet)).toMatchObject({ status: "QUEUED", calls: 1, costUsd: 0.0344 });
    expect(await draftRow(practice)).toMatchObject({ status: "QUEUED", calls: 0, costUsd: null, flags: null });
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: STATE_KEYS.aiTokens } }));
  });

  it("deleteQueuedDrafts deletes only drafts without a call; paid ones become FAILED with their cost", async () => {
    const job = await makeAiJob("RUNNING");
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const free1 = await makeDraft({ companyId: co, jobId: job });
    const free2 = await makeDraft({ companyId: co, jobId: job });
    const paid = await makeDraft({ companyId: co, jobId: job, calls: 1, costUsd: 0.004, draftedAt: NOW });
    const working = await makeDraft({ companyId: co, jobId: job, status: "DRAFTING" });
    const done = await makeDraft({ companyId: co, jobId: job, status: "READY", calls: 1, costUsd: 0.005 });
    expect(await ai.deleteQueuedDrafts(job)).toEqual({ deleted: 2, failed: 1 });
    expect(await db.aiDraft.count({ where: { id: { in: [free1, free2] } } })).toBe(0);
    expect(await draftRow(paid)).toMatchObject({ status: "FAILED", error: "Stopped before a line was finished.", costUsd: 0.004, calls: 1 });
    expect((await draftRow(working)).status).toBe("DRAFTING");
    expect((await draftRow(done)).status).toBe("READY");
    expect(await ai.runSpendUsd(job)).toBe(0.009);
  });
});

describe("failOrphanedDrafts", () => {
  it("fails drafts whose run is gone, failed, done or cancelled (deleting unpaid ones of a cancelled run)", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const running = await makeAiJob("RUNNING");
    const queued = await makeAiJob("QUEUED");
    const failedJob = await makeAiJob("FAILED");
    const doneJob = await makeAiJob("DONE");
    const cancelled = await makeAiJob("CANCELLED");
    const keep1 = await makeDraft({ companyId: co, jobId: running, status: "DRAFTING" });
    const keep2 = await makeDraft({ companyId: co, jobId: queued });
    const f1 = await makeDraft({ companyId: co, jobId: failedJob });
    const f2 = await makeDraft({ companyId: co, jobId: doneJob, status: "FETCHING" });
    const f3 = await makeDraft({ companyId: co, jobId: 999_999, status: "DRAFTING", calls: 1, costUsd: 0.004 });
    const f4 = await makeDraft({ companyId: co, jobId: null });
    const gone = await makeDraft({ companyId: co, jobId: cancelled });
    const paidCancelled = await makeDraft({ companyId: co, jobId: cancelled, calls: 1, costUsd: 0.003 });
    // Found mid-call: a call may have been billed, so it is charged one ceiling and never deleted.
    const midCall = await makeDraft({ companyId: co, jobId: cancelled, status: "DRAFTING" });
    const practice = await makeDraft({ companyId: co, jobId: cancelled, status: "DRAFTING", model: "practice" });
    const finished = await makeDraft({ companyId: co, jobId: failedJob, status: "READY" });

    expect(await ai.failOrphanedDrafts(NOW)).toBe(8);
    for (const id of [keep1, keep2]) expect(["DRAFTING", "QUEUED"]).toContain((await draftRow(id)).status);
    for (const id of [f1, f2, f3, f4, paidCancelled, midCall]) {
      expect(await draftRow(id)).toMatchObject({ status: "FAILED", error: "Claude couldn't be reached. Click Try again." });
    }
    // f3 was DRAFTING with one recorded call: + Haiku's ceiling ($0.0084).
    expect(await draftRow(f3)).toMatchObject({ costUsd: 0.0124, calls: 2, draftedAt: NOW });
    expect((await draftRow(f3)).flags).toEqual([{ code: "cost-estimated", text: ai.COST_ESTIMATED_RESTART_TEXT }]);
    expect(await draftRow(midCall)).toMatchObject({ costUsd: 0.0084, calls: 1 });
    expect(await draftRow(paidCancelled)).toMatchObject({ costUsd: 0.003, calls: 1 });
    // The practice drafter costs nothing: an unpaid practice draft of a cancelled run is deleted like any other.
    expect(await db.aiDraft.findUnique({ where: { id: practice } })).toBeNull();
    expect(await db.aiDraft.findUnique({ where: { id: gone } })).toBeNull();
    expect((await draftRow(finished)).status).toBe("READY");
    expect(await ai.failOrphanedDrafts()).toBe(0);
  });
});

describe("snapshots", () => {
  const page = (kind: "homepage" | "second_page", text: string, notes: Array<"metadata-only" | "hidden-text"> = []) => ({
    kind,
    url: kind === "homepage" ? "https://a.de" : "https://a.de/galerie",
    finalUrl: kind === "homepage" ? "https://a.de/" : "https://a.de/galerie",
    httpStatus: 200,
    contentType: "text/html",
    bytes: 1_234,
    title: kind === "homepage" ? "Firma" : "Galerie",
    lang: "de",
    text,
    notes,
  });

  it("stores a read and reuses it for 30 days unless the website is read again", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const ids = await ai.saveSnapshots(co, [page("homepage", "Home text"), page("second_page", "Gallery text", ["hidden-text"])], null, NOW);
    expect(ids.homeId).not.toBeNull();
    expect(ids.pageId).not.toBeNull();
    const row = await db.websiteSnapshot.findUniqueOrThrow({ where: { id: ids.pageId! } });
    expect(row).toMatchObject({ pageKind: "second_page", text: "Gallery text", chars: 12, title: "Galerie", lang: "de", bytes: 1_234, notes: ["hidden-text"], skipReason: null });

    const reused = await ai.reusableSnapshots(co, new Date(NOW.getTime() + 29 * DAY), false);
    expect(reused?.skip).toBeNull();
    expect(reused?.pages.map((p) => [p.kind, p.text, p.snapshotId, p.notes])).toEqual([
      ["homepage", "Home text", ids.homeId, []],
      ["second_page", "Gallery text", ids.pageId, ["hidden-text"]],
    ]);
    expect(reused?.pages[0]).toMatchObject({ finalUrl: "https://a.de/", httpStatus: 200, fetchedAt: NOW.toISOString(), title: "Firma" });
    expect(await ai.reusableSnapshots(co, new Date(NOW.getTime() + 29 * DAY), true)).toBeNull();
    expect(await ai.reusableSnapshots(co, new Date(NOW.getTime() + 31 * DAY), false)).toBeNull();
  });

  it("stores a skip as one empty row, reuses it for 24 hours, and never reuses a skipped page as a good one", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    await ai.saveSnapshots(co, [page("homepage", "Home text")], null, NOW);
    const later = new Date(NOW.getTime() + 2 * DAY);
    const skip = await ai.saveSnapshots(co, [page("homepage", "Domain for sale")], { code: "parked", detail: null, url: "https://a.de" }, later);
    expect(skip.pageId).toBeNull();
    expect(await db.websiteSnapshot.findUniqueOrThrow({ where: { id: skip.homeId! } })).toMatchObject({
      skipReason: "parked",
      text: "",
      chars: 0,
      httpStatus: 200,
      pageKind: "homepage",
    });
    expect(await ai.reusableSnapshots(co, new Date(later.getTime() + 23 * 3_600_000), false)).toEqual({ pages: [], skip: "parked" });
    // After 24 hours the older good read (still under 30 days) is used again.
    const after = await ai.reusableSnapshots(co, new Date(later.getTime() + 25 * 3_600_000), false);
    expect(after?.pages.map((p) => p.text)).toEqual(["Home text"]);
    expect(await ai.reusableSnapshots(co, new Date(later.getTime() + 23 * 3_600_000), true)).toBeNull();
  });
});

describe("spend and avoid lines", () => {
  it("sums a run and the office month by draftedAt", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const job = await makeAiJob("RUNNING");
    await makeDraft({ companyId: co, jobId: job, costUsd: 0.001, calls: 1, draftedAt: new Date("2026-08-31T20:00:00Z") });
    await makeDraft({ companyId: co, jobId: job, costUsd: 0.002, calls: 1, draftedAt: new Date("2026-09-10T20:00:00Z") });
    await makeDraft({ companyId: co, costUsd: 0.004, calls: 1, draftedAt: new Date("2026-09-11T20:00:00Z") });
    expect(await ai.runSpendUsd(job)).toBe(0.003);
    // 31 Aug 20:00 UTC is 1 Sep 01:00 in Karachi.
    expect(await ai.monthSpendUsd(NOW)).toBe(0.007);
  });

  it("recentAvoidLines lists this company's rejected and regenerated lines, then others' approved lines", async () => {
    const co = await makeCompany({ name: "A", website: "https://a.de" });
    const other = await makeCompany({ name: "B", website: "https://b.de" });
    await makeDraft({ companyId: co, status: "REJECTED", line: "Rejected line.", createdAt: new Date("2026-09-01T00:00:00Z") });
    await makeDraft({ companyId: co, status: "APPROVED", line: "Regenerated line.", reviewAction: "regenerated", createdAt: new Date("2026-09-02T00:00:00Z") });
    await makeDraft({ companyId: co, status: "READY", line: "Waiting line." });
    await makeDraft({ companyId: other, status: "APPROVED", line: "Claude's.", finalLine: "Edited other line.", reviewedAt: new Date("2026-09-05T00:00:00Z") });
    await makeDraft({ companyId: other, status: "APPROVED", line: "Rejected line.", reviewedAt: new Date("2026-09-04T00:00:00Z") });
    expect(await ai.recentAvoidLines(co)).toEqual(["Regenerated line.", "Rejected line.", "Edited other line."]);
  });
});
