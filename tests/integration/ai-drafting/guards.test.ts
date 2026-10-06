import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, stubClaudeApi, type FakeClaudeConnection } from "../helpers/claude";
import {
  claudeAnswerOf,
  draftsOf,
  fixtureReader,
  gate,
  makeCompany,
  memoryLogger,
  ORIGIN,
  resetAiState,
  runAiJob,
  seedUsers,
  startRun,
  type TestUser,
} from "./harness";

/**
 * The spend guard in the running job (M5-DESIGN §3.3, §3.7, D30; §8 P8 "guards"): the run never passes 125 % of its
 * server-side "at most" (nor, for a small run, one company's worst case: M5 review AI-3), counting calls in flight
 * (stop: never-paid QUEUED drafts deleted, paid ones FAILED, `ai.runStopped` for Contacts and list runs); the office
 * month never passes the limit (the refused request never reaches Claude; pause `monthly_limit` until the next month;
 * raising the limit and resuming continues).
 */

const t = await createTestDb("ai-drafting-guards");
const { db, dbWrite } = await import("@/server/db");
const { HAIKU_MODEL } = await import("@/core/ai/types");
const { STATE_KEYS } = await import("@/core/system-state");
const { monthBounds } = await import("@/core/time/month");
const { formatUsd } = await import("@/core/money");
const { estimateDraftRun, getAiPause, monthSpendUsd, resumeAi } = await import("@/server/services/ai");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");

let users: { owner: TestUser; ali: TestUser };
let cl: FakeClaudeConnection;

/** The prompt's measured tokens, fixed so every ceiling is known: (2,000 + page tokens) × $1 + 600 × $5 per million. */
const SYSTEM_TOKENS = 2_000;

beforeAll(async () => {
  users = await seedUsers();
  cl = await connectFakeClaude();
  await setState(STATE_KEYS.aiTokens, {
    entries: { [`${HAIKU_MODEL}|pl-2026-09-26`]: { systemTokens: SYSTEM_TOKENS, measuredAt: new Date().toISOString() } },
  });
});
afterEach(async () => {
  cl.fake.reset();
  await resetAiState(users.owner);
  await db.notification.deleteMany({});
});
afterAll(async () => {
  await cl.stop();
  await db.$disconnect();
  t.cleanup();
});

function stubAnswer(value: object, params: LineRequest, inputTokens = 3_000): ClaudeAnswer {
  return {
    text: JSON.stringify(value),
    stopReason: "end_turn",
    usage: { inputTokens, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, thinkingTokens: null, inferenceGeo: null },
    requestId: "req_stub",
    model: params.model,
  };
}

describe("the run's cost cap", () => {
  it("counts the call in flight, stops the run, deletes unpaid drafts, fails paid ones and tells the requester", async () => {
    const A = await makeCompany({ name: "Figuren Cap", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Cap", website: ORIGIN.noButikk });
    const C = await makeCompany({ name: "Grid Cap", website: ORIGIN.shopGrid });
    const D = await makeCompany({ name: "Cookie Cap", website: ORIGIN.cookieBanner });
    const P = await makeCompany({ name: "Latin Cap", website: ORIGIN.latin1 });
    // The browser's confirmed maximum is ignored: the payload carries the server's own estimate.
    const jobId = await startRun(users.ali, [A, B, C, D, P], { confirmedAtMostUsd: 1e9 });
    const payload = (await db.job.findUniqueOrThrow({ where: { id: jobId } })).payload as { atMostUsd: number };
    const estimate = await estimateDraftRun(5);
    expect(payload.atMostUsd).toBe(estimate.atMostUsd);
    // 5 × ((2,000 + 4,000) × $1 + 600 × $5) / 1e6 × 1.25; the run stops at 125 % of it ($0.0703125).
    expect(payload.atMostUsd).toBe(0.05625);

    // P was paid for before (a call, then a pause put it back in the queue).
    const drafts0 = await draftsOf(jobId);
    await dbWrite((c) => c.aiDraft.update({ where: { id: drafts0.get(P)!.id }, data: { calls: 1, costUsd: 0.001, inputTokens: 900, outputTokens: 0, draftedAt: new Date() } }));

    // A answers (once B's call is out) and costs a lot ($0.0606); B's call stays out until the cap has refused C.
    const bStarted = gate();
    const bRelease = gate();
    const seen: string[] = [];
    const handler = async (params: LineRequest): Promise<ClaudeAnswer> => {
      const text = params.messages[0].content;
      if (text.includes("figuren-werkstatt")) {
        seen.push("A");
        await bStarted.promise;
        return stubAnswer(claudeAnswerOf("de-figuren"), params, 60_000);
      }
      if (text.includes("butikk.example")) {
        seen.push("B");
        bStarted.open();
        await bRelease.promise;
        return stubAnswer(claudeAnswerOf("no-butikk"), params);
      }
      seen.push("other");
      return stubAnswer(claudeAnswerOf("shop-grid"), params);
    };
    const claude = stubClaudeApi(Array.from({ length: 10 }, () => handler));
    const logger = memoryLogger((m) => {
      if (m.includes("would pass the cost cap")) bRelease.open();
    });
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, claude, logger, companyConcurrency: 2 });
    expect(res.outcome).toBe("done");

    // C's call was refused before it was made: A's recorded $0.0606 + P's $0.001 + C's ceiling alone would have fit
    // under $0.0703, but not with B's ceiling reserved while B's call was out.
    expect([...seen].sort()).toEqual(["A", "B"]);
    const drafts = await draftsOf(jobId);
    expect(drafts.get(A)).toMatchObject({ status: "READY", costUsd: 0.0606 });
    expect(drafts.get(B)).toMatchObject({ status: "READY", costUsd: 0.0036 });
    expect(drafts.has(C)).toBe(false); // never paid: deleted
    expect(drafts.has(D)).toBe(false); // never claimed: deleted
    expect(drafts.get(P)).toMatchObject({ status: "FAILED", error: "Stopped before a line was finished.", costUsd: 0.001 });

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("DONE");
    expect(job.result).toMatchObject({
      summary: "Stopped after 2 of 5 companies: this run was about to cost more than expected.",
      stopped: "cost-cap",
      costUsd: 0.0652,
    });
    const note = await db.notification.findFirstOrThrow({ where: { userId: users.ali.id, type: "ai.runStopped" } });
    expect(note).toMatchObject({
      title: "AI drafting stopped early",
      // Small amounts with three decimals, so they can be told apart.
      body: "This run was about to cost more than expected ($0.065 so far; at most $0.056 was estimated), so it stopped after 2 of 5 companies. The drafted lines are waiting for review.",
      link: "/ai-lines",
    });
    expect(await db.notification.count({ where: { type: "ai.draftsReady" } })).toBe(0);
  });

  it("one company: the doubled max_tokens retry fits the one-company cap, so it is made and the line drafted (AI-3)", async () => {
    const id = await makeCompany({ name: "Figuren Single", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [id]);
    cl.fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "max_tokens" });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, logger: memoryLogger() })).outcome).toBe("done");
    const sent = cl.fake.requests.filter((r) => r.path === "/v1/messages");
    expect(sent.map((r) => r.body.max_tokens)).toEqual([600, 1_200]);
    // 3,000 in and 600 out, then 3,000 in and 120 out.
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "READY", calls: 2, costUsd: 0.0096 });
    expect(await db.notification.count({ where: { type: "ai.runStopped" } })).toBe(0);
  });

  it("a panel run on a page at the cap can afford the regeneration, and tells nobody (the reported case, AI-3)", async () => {
    const id = await makeCompany({ name: "Uralskaya Masterskaya", website: "https://cyrillic.example" });
    const jobId = await startRun(users.ali, [id], { source: "panel" });
    const payload = (await db.job.findUniqueOrThrow({ where: { id: jobId } })).payload as { atMostUsd: number };
    // One company's "at most": ((2,000 + 4,000) × $1 + 600 × $5) / 1e6 × 1.25; 125 % of it is $0.0140625.
    expect(payload.atMostUsd).toBe(0.01125);
    const quote = "Мастерская вырезает фигурки животных из малахита и яшмы для коллекционеров";
    const claude = stubClaudeApi([
      {
        answer: { evidence_source: "homepage", evidence_quote: quote, line: "Your Moscow studio carves animal figures from malachite and jasper.", reason_if_null: null },
        usage: { inputTokens: 4_400, outputTokens: 150 },
      },
      { answer: { evidence_source: "homepage", evidence_quote: quote, line: "You carve animal figures from malachite and jasper for collectors.", reason_if_null: null } },
    ]);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    // The regeneration was made: the first call's $0.00515 plus its ceiling is more than the old cap of $0.0140625.
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]!.messages[0].content).toContain("<previous_problem>The line mentions “Moscow”, but the pages don't.</previous_problem>");
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", calls: 2, line: "You carve animal figures from malachite and jasper for collectors." });
    expect(d.flags ?? []).not.toContainEqual(expect.objectContaining({ code: "name-not-found" }));
    expect(await db.notification.count({ where: { type: { in: ["ai.runStopped", "ai.draftsReady"] } } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).result).toMatchObject({ stopped: null });
  });

  it("a one-company run that does reach its cap keeps the paid line and tells nobody", async () => {
    const id = await makeCompany({ name: "Grid Expensive", website: ORIGIN.shopGrid });
    const jobId = await startRun(users.ali, [id], { source: "panel" });
    const grid = claudeAnswerOf("shop-grid");
    const claude = stubClaudeApi([
      // A failing line (an invented name) that cost more than one company's worst case: no regeneration fits.
      { answer: { ...grid, line: "Your Leipzig studio sells 75mm fantasy bust kits in resin." }, usage: { inputTokens: 60_000, outputTokens: 150 } },
    ]);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    expect(claude.calls).toHaveLength(1);
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", calls: 1, line: "Your Leipzig studio sells 75mm fantasy bust kits in resin." });
    expect(d.flags).toContainEqual({ code: "name-not-found", text: "Mentions “Leipzig”, which isn't on the website." });
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).result).toMatchObject({ stopped: "cost-cap" });
    expect(await db.notification.count({ where: { type: "ai.runStopped" } })).toBe(0);
  });
});

describe("the office month's limit", () => {
  it("refuses the call before it is made, pauses until next month; a raised limit and Resume continue the run", async () => {
    const A = await makeCompany({ name: "Figuren Month", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Month", website: ORIGIN.noButikk });
    const C = await makeCompany({ name: "Grid Month", website: ORIGIN.shopGrid });
    const jobId = await startRun(users.ali, [A, B, C]);
    // A's call costs $0.0206 (20,000 input tokens). The limit leaves room for it (its ceiling is at most about $0.01)
    // and $0.004 more: less than any ceiling (at least 2,000 system tokens + 600 × $5 = $0.005), so B's call is
    // refused before it is made. (The run's own cap, 125 % of 3 × $0.01125, is not what stops it.)
    cl.fake.setUsage({ input: 20_000, output: 120 });
    const spent = await monthSpendUsd(new Date());
    const limit = Math.round((spent + 0.0206 + 0.004) * 1e6) / 1e6;
    await setSetting("ai.monthlyLimitUsd", limit, users.owner.id);

    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, companyConcurrency: 1, logger: memoryLogger() });
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    // The fake never got the refused request.
    expect(cl.fake.requests.filter((r) => r.path === "/v1/messages")).toHaveLength(1);
    const drafts = await draftsOf(jobId);
    expect(drafts.get(A)).toMatchObject({ status: "READY", costUsd: 0.0206 });
    expect(drafts.get(B)).toMatchObject({ status: "QUEUED", calls: 0 });
    expect(drafts.get(C)).toMatchObject({ status: "QUEUED", calls: 0 });

    const bounds = monthBounds(new Date(), "Asia/Karachi");
    const pause = await getAiPause();
    expect(pause).toMatchObject({ paused: true, kind: "monthly_limit", until: bounds.end.toISOString() });
    expect(pause.text).toBe(
      `AI drafting stopped: this month's limit of ${formatUsd(limit).replace(/\.00$/, "")} is reached. Raise it in Settings › AI or wait until ${bounds.resetLabel}.`,
    );
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.runAt.toISOString()).toBe(bounds.end.toISOString());
    const note = await db.notification.findFirstOrThrow({ where: { type: "ai.paused" } });
    expect(note).toMatchObject({ userId: users.owner.id, title: "AI drafting stopped", body: pause.text });

    // The Owner raises the limit (Settings › AI lifts the monthly pause): the run goes on at once.
    cl.fake.setUsage({ input: 3_000, output: 120 });
    await setSetting("ai.monthlyLimitUsd", 20, users.owner.id);
    await resumeAi(users.owner, { onlyKinds: ["monthly_limit"] });
    expect((await runAiJob({ reader, companyConcurrency: 1, logger: memoryLogger() })).outcome).toBe("done");
    const after = await draftsOf(jobId);
    expect(after.get(B)).toMatchObject({ status: "READY", calls: 1 });
    expect(after.get(C)).toMatchObject({ status: "READY", calls: 1 });
  });
});
