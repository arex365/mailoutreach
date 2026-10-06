import { APIError } from "@anthropic-ai/sdk";
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
 * §3.7 "Errors and pauses" (M5-DESIGN §8 P8 tests): pauses (key, model, Anthropic's caps, billing) put the draft back
 * with its recorded cost and defer the run after the companies in flight finished; P8's own retries (5xx/529 twice,
 * a short 429 once); long rate limits defer; Claude unreachable goes to the runner's retries and, after the last one,
 * the orphan sweep fails the drafts; a timeout is recorded at its ceiling; no key and no price pause without a call.
 */

const t = await createTestDb("ai-drafting-errors");
const { db } = await import("@/server/db");
const { HAIKU_MODEL, SONNET_MODEL, DEFAULT_AI_PRICES, resolveProfile } = await import("@/core/ai/types");
const { callCeilingUsd } = await import("@/core/ai/cost");
const { companyWorstCaseUsd, perCallMaxUsd, MAX_FACTOR } = await import("@/core/ai/estimate");
const { roundUsd } = await import("@/core/money");
const { aiPauseText, createClaudeApi, tierCapResetAt } = await import("@/server/anthropic");
const { getAiPause, monthSpendUsd, resumeAi, systemTokensFor, failOrphanedDrafts } = await import("@/server/services/ai");
const { setSetting } = await import("@/server/settings");
const { deleteSecret, setSecret } = await import("@/server/secrets");

let users: { owner: TestUser; ali: TestUser };
let cl: FakeClaudeConnection;

beforeAll(async () => {
  users = await seedUsers();
  cl = await connectFakeClaude();
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

const HOUR = 3_600_000;
const noWait = { retryDelayMs: () => 0, sleep: async () => {} };

function messageRequests() {
  return cl.fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
}

function errorBody(type: string, message: string, extra: object = {}): object {
  return { type: "error", error: { type, message, ...extra } };
}

async function oneCompanyRun(name: string, website: string = ORIGIN.shopGrid): Promise<{ id: number; jobId: number }> {
  const id = await makeCompany({ name, website });
  return { id, jobId: await startRun(users.ali, [id]) };
}

async function jobRow(id: number) {
  return db.job.findUniqueOrThrow({ where: { id } });
}

function near(a: Date, b: number, slackMs = 5_000): boolean {
  return Math.abs(a.getTime() - b) <= slackMs;
}

describe("pauses", () => {
  it("401: the draft goes back with its cost, the other company in flight is finished first, one Owner notice; resume → drafted", async () => {
    const a = await makeCompany({ name: "Figuren A", website: ORIGIN.deFiguren, country: "DE" });
    const b = await makeCompany({ name: "Butikk B", website: ORIGIN.noButikk, country: "NO" });
    const jobId = await startRun(users.ali, [a, b]);

    const figuren = claudeAnswerOf("de-figuren");
    const butikk = claudeAnswerOf("no-butikk");
    const failing = { ...figuren, line: "Your gallery shows hand-painted dragons cast in resin in your Leipzig workshop." };
    const answer = (value: object, params: LineRequest): ClaudeAnswer => ({
      text: JSON.stringify(value),
      stopReason: "end_turn",
      usage: { inputTokens: 3_000, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, thinkingTokens: null, inferenceGeo: null },
      requestId: "req_stub",
      model: params.model,
    });
    const bStarted = gate();
    const bRelease = gate();
    let aCalls = 0;
    const handler = async (params: LineRequest): Promise<ClaudeAnswer> => {
      const text = params.messages[0].content;
      if (text.includes("figuren-werkstatt")) {
        aCalls += 1;
        if (aCalls === 1) return answer(failing, params);
        if (aCalls === 2) {
          // B's call is out when A's second call is refused.
          await bStarted.promise;
          setTimeout(bRelease.open, 50);
          throw APIError.generate(401, errorBody("authentication_error", "invalid x-api-key"), "invalid x-api-key", new Headers({ "request-id": "req_401" }));
        }
        return answer(figuren, params);
      }
      bStarted.open();
      await bRelease.promise;
      return answer(butikk, params);
    };
    const claude = stubClaudeApi(Array.from({ length: 10 }, () => handler));
    const { reader } = await fixtureReader();

    const res = await runAiJob({ reader, claude, logger: memoryLogger() });
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    const drafts = await draftsOf(jobId);
    expect(drafts.get(b)).toMatchObject({ status: "READY", calls: 1 });
    const draftA = drafts.get(a)!;
    expect(draftA).toMatchObject({ status: "QUEUED", calls: 1, costUsd: 0.0036, inputTokens: 3_000 });
    expect(draftA.draftedAt).toBeInstanceOf(Date);

    const pause = await getAiPause();
    expect(pause).toMatchObject({ paused: true, kind: "key_rejected", model: HAIKU_MODEL, until: null });
    expect(pause.text).toBe(aiPauseText("key_rejected", { model: HAIKU_MODEL }));
    const notes = await db.notification.findMany({ where: { type: "ai.paused" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: users.owner.id, title: "AI drafting paused", body: pause.text, link: "/settings/ai" });
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(job.result).toMatchObject({ deferred: "paused", summary: `Paused: ${pause.text}` });
    expect(near(job.runAt, Date.now() + HOUR)).toBe(true);

    // The Owner saves a key and resumes: the run goes on at once and drafts A.
    await resumeAi(users.owner, { onlyKinds: ["key_rejected"] });
    const again = await runAiJob({ reader, claude, logger: memoryLogger() });
    expect(again.outcome).toBe("done");
    expect((await draftsOf(jobId)).get(a)).toMatchObject({ status: "READY", calls: 2, costUsd: 0.0072, line: figuren.line });
  });

  it("404 model → pause; the Owner picks Sonnet 5 → the run goes on with Sonnet and a rescaled cap", async () => {
    const { id, jobId } = await oneCompanyRun("Grid Model");
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 404, body: errorBody("not_found_error", `model: ${HAIKU_MODEL}`) });
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader });
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "QUEUED", calls: 0 });
    const pause = await getAiPause();
    expect(pause).toMatchObject({ kind: "model_not_found", model: HAIKU_MODEL });
    expect(pause.text).toContain(`the model “${HAIKU_MODEL}”`);

    await setSetting("ai.model", SONNET_MODEL, users.owner.id);
    await resumeAi(users.owner, { onlyKinds: ["model_not_found"] });
    expect((await runAiJob({ reader })).outcome).toBe("done");
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", model: SONNET_MODEL });
    expect(messageRequests().at(-1)!.body).toMatchObject({ model: SONNET_MODEL, output_config: { effort: "low" } });

    // The cap was rescaled once for the one company left: 125 % × Sonnet's per-company maximum, but at least one
    // company's worst case with Sonnet (the regeneration and the retries must fit, AI-3).
    const sonnet = resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES);
    const system = await systemTokensFor(SONNET_MODEL);
    const cap = roundUsd(Math.max(1.25 * perCallMaxUsd(sonnet, system) * MAX_FACTOR * 1, companyWorstCaseUsd(sonnet, system)));
    expect(cap).toBe(roundUsd(companyWorstCaseUsd(sonnet, system)));
    expect((await jobRow(jobId)).result).toMatchObject({ carry: { model: SONNET_MODEL, runCapUsd: cap } });
  });

  it("429 enforced_spend_limit_reached → pause until 00:05 UTC on the 1st", async () => {
    const { jobId } = await oneCompanyRun("Grid Tier Cap");
    cl.fake.failNext("POST /v1/messages", {
      kind: "status",
      status: 429,
      body: errorBody("rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold.", {
        details: { error_code: "enforced_spend_limit_reached" },
      }),
    });
    const { reader } = await fixtureReader();
    const before = new Date();
    expect((await runAiJob({ reader })).deferReason).toBe("paused");
    const until = new Date(tierCapResetAt(before).getTime() + 5 * 60_000);
    const pause = await getAiPause();
    expect(pause).toMatchObject({ kind: "tier_spend_cap", until: until.toISOString() });
    // The reset time is written in the Owner's zone (Europe/Berlin here).
    expect(pause.text).toBe(aiPauseText("tier_spend_cap", { model: HAIKU_MODEL, timeZone: "Europe/Berlin", now: before }));
    expect((await jobRow(jobId)).runAt.toISOString()).toBe(until.toISOString());
  });

  it("400 with the Owner's own Console limit → pause own_spend_limit", async () => {
    const { jobId } = await oneCompanyRun("Grid Own Limit");
    cl.fake.failNext("POST /v1/messages", {
      kind: "status",
      status: 400,
      body: errorBody("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."),
    });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader })).deferReason).toBe("paused");
    expect(await getAiPause()).toMatchObject({ kind: "own_spend_limit", until: null });
    expect(near((await jobRow(jobId)).runAt, Date.now() + HOUR)).toBe(true);
  });

  it("no usable key (removed after the start) → pause key_rejected with that sentence, no thrown error, no request", async () => {
    const { id, jobId } = await oneCompanyRun("Grid No Key");
    await deleteSecret("anthropic.apiKey");
    try {
      const { reader } = await fixtureReader();
      const res = await runAiJob({ reader });
      expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused" });
      expect(await getAiPause()).toMatchObject({ kind: "key_rejected", text: "Add your Anthropic API key in Settings › AI first." });
      expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "QUEUED", calls: 0 });
      expect(cl.fake.requests).toHaveLength(0);
    } finally {
      await setSecret("anthropic.apiKey", cl.apiKey, null);
    }
  });

  it("no price for the model chosen after the start → pause no_price, no request", async () => {
    const { id, jobId } = await oneCompanyRun("Grid No Price");
    await setSetting("ai.customModel", { id: "claude-test-custom", label: "Test custom", maxTokens: 8_192, effortLow: true, checkedAt: new Date().toISOString() }, users.owner.id);
    await setSetting("ai.model", "claude-test-custom", users.owner.id);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader })).deferReason).toBe("paused");
    expect(await getAiPause()).toMatchObject({
      kind: "no_price",
      model: "claude-test-custom",
      text: "AI drafting paused: no price is saved for the model “claude-test-custom”. Enter its prices in Settings › AI.",
    });
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "QUEUED", calls: 0 });
    expect(cl.fake.requests).toHaveLength(0);
  });

  it("a paused AI queue defers the run at once", async () => {
    const { jobId } = await oneCompanyRun("Grid Paused");
    const { pauseAi } = await import("@/server/services/ai");
    await pauseAi("billing", { text: "AI drafting paused: billing.", until: null });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader })).deferReason).toBe("paused");
    expect((await jobRow(jobId)).result).toMatchObject({ summary: "Paused: AI drafting paused: billing." });
    expect(cl.fake.requests).toHaveLength(0);
  });
});

describe("rate limits and retries", () => {
  it("429 with retry-after 5 s → waits and tries again in-process", async () => {
    const { id, jobId } = await oneCompanyRun("Grid 429 short");
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 429, body: errorBody("rate_limit_error", "Rate limited"), headers: { "retry-after": "5" } });
    const waits: number[] = [];
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, sleep: async (ms) => void waits.push(ms) });
    expect(res.outcome).toBe("done");
    expect(waits).toEqual([5_000]);
    expect(messageRequests()).toHaveLength(2);
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "READY", calls: 1 });
  });

  it("429 with retry-after 120 s → the run is deferred by it", async () => {
    const { id, jobId } = await oneCompanyRun("Grid 429 long");
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 429, body: errorBody("rate_limit_error", "Rate limited"), headers: { "retry-after": "120" } });
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader });
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "rate-limited" });
    expect(near(res.deferredUntil!, Date.now() + 120_000)).toBe(true);
    expect((await jobRow(jobId)).result).toMatchObject({ deferred: "rate-limited", summary: "Waiting: Claude asked us to slow down." });
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "QUEUED", calls: 0 });
    expect(messageRequests()).toHaveLength(1);
  });

  it("529 once → retried in-process, drafted", async () => {
    const { id, jobId } = await oneCompanyRun("Grid 529 once");
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 529, body: errorBody("overloaded_error", "Overloaded") });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, ...noWait })).outcome).toBe("done");
    expect(messageRequests()).toHaveLength(2);
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "READY", calls: 1 });
  });

  it("529 every time → the runner tries again, then FAILED; the orphan sweep fails the draft", async () => {
    const { id, jobId } = await oneCompanyRun("Grid 529 always");
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 529, body: errorBody("overloaded_error", "Overloaded") }, 12);
    const { reader } = await fixtureReader();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await runAiJob({ reader, ...noWait }, { now: new Date(Date.now() + (i === 0 ? 0 : 2 * HOUR)) });
      outcomes.push(res.outcome);
      // Every try puts the draft back first (nothing was billed: calls 0).
      expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "QUEUED", calls: 0 });
    }
    expect(outcomes).toEqual(["retry", "retry", "retry", "failed"]);
    expect(messageRequests()).toHaveLength(12); // 1 + 2 in-process retries, per try
    expect(await jobRow(jobId)).toMatchObject({ status: "FAILED", error: "Claude couldn't be reached." });
    const notice = await db.notification.findFirstOrThrow({ where: { userId: users.owner.id, type: "task.failed" } });
    expect(notice.body).toBe("AI drafting didn't finish: Claude couldn't be reached. Open AI lines and start the drafting again.");
    expect(notice.link).toBe("/ai-lines");

    await failOrphanedDrafts();
    expect((await draftsOf(jobId)).get(id)).toMatchObject({ status: "FAILED", error: "Claude couldn't be reached. Click Try again." });
  });

  it("a timeout → the call's ceiling is recorded (cost-estimated) and it is tried once more; an answer then drafts it", async () => {
    const { id, jobId } = await oneCompanyRun("Grid Timeout");
    cl.fake.failNext("POST /v1/messages", { kind: "hang" });
    const claude = createClaudeApi(cl.apiKey, cl.fake.origin, { timeoutMs: 300 });
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, claude, ...noWait });
    expect(res.outcome).toBe("done");
    expect(messageRequests()).toHaveLength(2);
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    const ceiling = callCeilingUsd(haiku, await systemTokensFor(HAIKU_MODEL), messageRequests()[0]!.body.messages[0].content, 600);
    const d = (await draftsOf(jobId)).get(id)!;
    // The unanswered call stays charged at its ceiling; the answer adds its real cost.
    expect(d).toMatchObject({ status: "READY", calls: 2, costUsd: roundUsd(ceiling + 0.0036), inputTokens: 3_000, outputTokens: 120 });
    expect(d.flags).toEqual(
      expect.arrayContaining([{ code: "cost-estimated", text: "Part of this draft's cost is an estimate: Claude didn't answer in time." }]),
    );
    expect(await jobRow(jobId)).toMatchObject({ status: "DONE", error: null });
  });

  it("one company whose calls keep timing out fails alone after two tries; the run goes on (AI-2)", async () => {
    const a = await makeCompany({ name: "Grid Slow", website: ORIGIN.shopGrid });
    const b = await makeCompany({ name: "Butikk Fine", website: ORIGIN.noButikk });
    const c = await makeCompany({ name: "Figuren Fine", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [a, b, c]);
    cl.fake.failNext("POST /v1/messages", { kind: "hang" }, 2);
    const claude = createClaudeApi(cl.apiKey, cl.fake.origin, { timeoutMs: 300 });
    const logger = memoryLogger();
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, claude, companyConcurrency: 1, logger, ...noWait });
    expect(res.outcome).toBe("done");
    // Two tries for the slow company (each charged its ceiling once), one call each for the others.
    expect(messageRequests()).toHaveLength(4);
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    const ceiling = callCeilingUsd(haiku, await systemTokensFor(HAIKU_MODEL), messageRequests()[0]!.body.messages[0].content, 600);
    const drafts = await draftsOf(jobId);
    expect(drafts.get(a)).toMatchObject({
      status: "FAILED",
      error: "Claude took too long to answer for this company. Click Try again.",
      calls: 2,
      costUsd: roundUsd(2 * ceiling),
      stopReason: null,
    });
    expect(drafts.get(b)).toMatchObject({ status: "READY", calls: 1 });
    expect(drafts.get(c)).toMatchObject({ status: "READY", calls: 1 });
    expect(await jobRow(jobId)).toMatchObject({ status: "DONE", error: null });
    expect(logger.lines.some((l) => l.includes(`draft #${drafts.get(a)!.id}`) && l.includes("only this company"))).toBe(true);
    // The requester hears about the finished run, the failed company included.
    const note = await db.notification.findFirstOrThrow({ where: { userId: users.ali.id, type: "ai.draftsReady" } });
    expect(note.body).toContain("1 company failed.");
  });

  it("calls of two companies unanswered in a row: Claude looks unreachable, the run stops and the runner tries again", async () => {
    const a = await makeCompany({ name: "Grid Down", website: ORIGIN.shopGrid });
    const b = await makeCompany({ name: "Butikk Down", website: ORIGIN.noButikk });
    const jobId = await startRun(users.ali, [a, b]);
    cl.fake.failNext("POST /v1/messages", { kind: "hang" }, 3);
    const claude = createClaudeApi(cl.apiKey, cl.fake.origin, { timeoutMs: 300 });
    const { reader } = await fixtureReader();
    const res = await runAiJob({ reader, claude, companyConcurrency: 1, logger: memoryLogger(), ...noWait });
    expect(res.outcome).toBe("retry");
    expect(messageRequests()).toHaveLength(3);
    const drafts = await draftsOf(jobId);
    expect(drafts.get(a)).toMatchObject({ status: "FAILED", calls: 2 });
    // B's one unanswered call is charged; B waits in the queue for the runner's next try.
    expect(drafts.get(b)).toMatchObject({ status: "QUEUED", calls: 1 });
    expect(await jobRow(jobId)).toMatchObject({ status: "QUEUED", error: "Claude couldn't be reached." });
  });

  it("a 200 whose body breaks off is charged at its ceiling with its request id, never at $0 (AI-1)", async () => {
    const { id, jobId } = await oneCompanyRun("Grid Cut Body");
    cl.fake.failNext("POST /v1/messages", { kind: "cutBody" }, 2);
    const claude = createClaudeApi(cl.apiKey, cl.fake.origin, { timeoutMs: 5_000 });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger(), ...noWait })).outcome).toBe("done");
    expect(messageRequests()).toHaveLength(2);
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    const ceiling = callCeilingUsd(haiku, await systemTokensFor(HAIKU_MODEL), messageRequests()[0]!.body.messages[0].content, 600);
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "FAILED", calls: 2, costUsd: roundUsd(2 * ceiling), inputTokens: 0, outputTokens: 0 });
    expect(d.requestId).toMatch(/^req_fake_\d+$/);
    expect(d.flags).toEqual([{ code: "cost-estimated", text: "Part of this draft's cost is an estimate: Claude didn't answer in time." }]);
    expect(await monthSpendUsd()).toBeGreaterThanOrEqual(roundUsd(2 * ceiling));
  });

  it("another 4xx → FAILED for this company only, request id kept, the run goes on", async () => {
    const a = await makeCompany({ name: "Grid 422", website: ORIGIN.shopGrid });
    const b = await makeCompany({ name: "Butikk 422", website: ORIGIN.noButikk });
    const jobId = await startRun(users.ali, [a, b]);
    cl.fake.failNext("POST /v1/messages", { kind: "status", status: 400, body: errorBody("invalid_request_error", "messages: text content blocks must be non-empty (anna@firma.example)") });
    const logger = memoryLogger();
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, companyConcurrency: 1, logger })).outcome).toBe("done");
    const drafts = await draftsOf(jobId);
    // An error answer isn't billed: it isn't counted as a call (the token averages never see it, AI-8).
    expect(drafts.get(a)).toMatchObject({
      status: "FAILED",
      error: "Claude couldn't write a line for this company. Click Try again later.",
      calls: 0,
      costUsd: null,
      inputTokens: null,
      draftedAt: null,
    });
    expect(drafts.get(a)!.requestId).toMatch(/^req_fake_\d+$/);
    expect(drafts.get(b)).toMatchObject({ status: "READY" });
    // The API's own text only in the log, scrubbed (no address).
    const line = logger.lines.find((l) => l.includes(`draft #${drafts.get(a)!.id}`))!;
    expect(line).toContain("text content blocks must be non-empty");
    expect(line).toContain("[address]");
    expect(line).not.toContain("anna@firma.example");
  });
});
