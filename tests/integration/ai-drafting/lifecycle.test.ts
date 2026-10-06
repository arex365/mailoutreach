import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import type { WebsiteReader } from "@/server/web";
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
 * The drafting job's life (M5-DESIGN §8 P8 "shutdown and restart", "stop", yields, the practice copy): shutdown never
 * aborts a call in flight and the handler drains; a restart charges a draft found mid-call one ceiling and fails a page
 * that stopped the worker twice; Stop finishes the companies in flight and takes the rest off the list; a waiting panel
 * run goes first; the practice copy drafts made-up lines for free, whatever deps were injected.
 */

const t = await createTestDb("ai-drafting-lifecycle");
const { db, dbWrite } = await import("@/server/db");
const { HAIKU_MODEL, DEFAULT_AI_PRICES, resolveProfile } = await import("@/core/ai/types");
const { perCallMaxUsd } = await import("@/core/ai/estimate");
const { callCeilingUsd } = await import("@/core/ai/cost");
const { buildLineRequest } = await import("@/core/ai/request");
const { roundUsd } = await import("@/core/money");
const { markCallInFlight, stopDraftRun, systemTokensFor } = await import("@/server/services/ai");
const { setSetting } = await import("@/server/settings");

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

function stubAnswer(value: object, params: LineRequest): ClaudeAnswer {
  return {
    text: JSON.stringify(value),
    stopReason: "end_turn",
    usage: { inputTokens: 3_000, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, thinkingTokens: null, inferenceGeo: null },
    requestId: "req_stub",
    model: params.model,
  };
}

/** A stub whose German-site call stays out until released; every other call answers with the site's claude.json. */
function heldStub() {
  const started = gate();
  const release = gate();
  const handler = async (params: LineRequest): Promise<ClaudeAnswer> => {
    const text = params.messages[0].content;
    if (text.includes("figuren-werkstatt")) {
      started.open();
      await release.promise;
      return stubAnswer(claudeAnswerOf("de-figuren"), params);
    }
    if (text.includes("butikk.example")) return stubAnswer(claudeAnswerOf("no-butikk"), params);
    if (text.includes("gridshop.example")) return stubAnswer(claudeAnswerOf("shop-grid"), params);
    return stubAnswer(claudeAnswerOf("cookie-banner"), params);
  };
  const claude = stubClaudeApi(Array.from({ length: 20 }, () => handler));
  return { claude, started, release };
}

describe("shutdown and restart", () => {
  it("shutdown while a call is out: the call isn't aborted, the handler drains, the run waits in the queue", async () => {
    const A = await makeCompany({ name: "Figuren Shutdown", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Shutdown", website: ORIGIN.noButikk });
    const jobId = await startRun(users.ali, [A, B]);
    const stub = heldStub();
    const { reader } = await fixtureReader();
    const controller = new AbortController();
    const running = runAiJob({ reader, claude: stub.claude, companyConcurrency: 1, logger: memoryLogger() }, { signal: controller.signal });
    await stub.started.promise;
    controller.abort(new Error("The background sender is stopping."));
    stub.release.open();
    const res = await running;
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "yield" });
    const drafts = await draftsOf(jobId);
    // The call in flight came back and was recorded; no new company was started.
    expect(drafts.get(A)).toMatchObject({ status: "READY", calls: 1, costUsd: 0.0036 });
    expect(drafts.get(B)).toMatchObject({ status: "QUEUED", calls: 0, readAttempts: 0 });
    expect(stub.claude.calls).toHaveLength(1);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(job.result).toMatchObject({ deferred: "yield", summary: "1 of 2 companies drafted so far." });
  });

  it("a restart finds a draft mid-call: one call's ceiling is recorded (cost-estimated), then it is drafted", async () => {
    const A = await makeCompany({ name: "Figuren Restart", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [A]);
    const d0 = (await draftsOf(jobId)).get(A)!;
    await dbWrite((c) => c.aiDraft.update({ where: { id: d0.id }, data: { status: "DRAFTING", readAttempts: 1 } }));
    const ceiling = roundUsd(perCallMaxUsd(resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES), await systemTokensFor(HAIKU_MODEL)));
    const { reader } = await fixtureReader();
    // A generous cap through the carry keeps this test about the restart charge only (since AI-3 a one-company run's
    // own cap, at least companyWorstCaseUsd, would also have room for the charged ceiling plus a real call).
    await dbWrite((c) => c.job.update({ where: { id: jobId }, data: { result: { carry: { model: HAIKU_MODEL, runCapUsd: 1 } } } }));
    expect((await runAiJob({ reader, logger: memoryLogger() })).outcome).toBe("done");
    const d = (await draftsOf(jobId)).get(A)!;
    // The read that finished took its attempt back (DATA-05): only interrupted reads stay counted.
    expect(d).toMatchObject({ status: "READY", calls: 2, costUsd: roundUsd(ceiling + 0.0036), readAttempts: 1 });
    expect(d.flags).toEqual(
      expect.arrayContaining([{ code: "cost-estimated", text: "Part of this draft's cost is an estimate: the app stopped while Claude was writing." }]),
    );
  });

  it("a restart during a doubled max_tokens retry charges that call's reserved ceiling, never less (AI-7)", async () => {
    const A = await makeCompany({ name: "Figuren Retry Restart", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [A]);
    const d0 = (await draftsOf(jobId)).get(A)!;
    // The run had recorded the first call (stopped at max_tokens) and was waiting for the retry at 1,200 tokens.
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    const message = buildLineRequest({ company: { name: "Figuren Retry Restart", country: null, niche: null }, pages: [] }, haiku).messages[0].content;
    const reserved = callCeilingUsd(haiku, await systemTokensFor(HAIKU_MODEL), `${message}${"Resin dragons. ".repeat(800)}`, 1_200);
    const perCall = roundUsd(perCallMaxUsd(haiku, await systemTokensFor(HAIKU_MODEL)));
    expect(reserved).toBeGreaterThan(perCall);
    await dbWrite((c) =>
      c.aiDraft.update({ where: { id: d0.id }, data: { status: "DRAFTING", calls: 1, costUsd: 0.006, inputTokens: 3_000, outputTokens: 600, draftedAt: new Date() } }),
    );
    await markCallInFlight(d0.id, reserved);
    await dbWrite((c) => c.job.update({ where: { id: jobId }, data: { result: { carry: { model: HAIKU_MODEL, runCapUsd: 1 } } } }));
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, logger: memoryLogger() })).outcome).toBe("done");
    const d = (await draftsOf(jobId)).get(A)!;
    // 0.006 recorded + the in-flight call's reserved ceiling + the new answer's 0.0036.
    expect(d).toMatchObject({ status: "READY", calls: 3, costUsd: roundUsd(0.006 + reserved + 0.0036), stopReason: "end_turn" });
  });

  it("a draft read again after one interrupted read is drafted, not failed (DATA-05)", async () => {
    const A = await makeCompany({ name: "Cookie Once", website: ORIGIN.cookieBanner });
    const jobId = await startRun(users.ali, [A]);
    const d0 = (await draftsOf(jobId)).get(A)!;
    // One read was interrupted by a crash (the claim's attempt stayed counted).
    await dbWrite((c) => c.aiDraft.update({ where: { id: d0.id }, data: { status: "FETCHING", readAttempts: 1 } }));
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, logger: memoryLogger() })).outcome).toBe("done");
    expect((await draftsOf(jobId)).get(A)).toMatchObject({ status: "READY", readAttempts: 1 });
  });

  it("a page that stopped the worker twice (FETCHING, 2 reads) fails and isn't read again", async () => {
    const A = await makeCompany({ name: "Poison Page", website: ORIGIN.cookieBanner });
    const jobId = await startRun(users.ali, [A]);
    const d0 = (await draftsOf(jobId)).get(A)!;
    await dbWrite((c) => c.aiDraft.update({ where: { id: d0.id }, data: { status: "FETCHING", readAttempts: 2 } }));
    const { reader, transport } = await fixtureReader();
    expect((await runAiJob({ reader, logger: memoryLogger() })).outcome).toBe("done");
    expect((await draftsOf(jobId)).get(A)).toMatchObject({ status: "FAILED", error: "This website couldn't be read safely.", calls: 0 });
    expect(transport.calls).toHaveLength(0);
    expect(cl.fake.requests).toHaveLength(0);
  });
});

describe("compare-and-set", () => {
  it("a draft taken away during its call: the call's cost is still recorded, the result is dropped", async () => {
    const A = await makeCompany({ name: "Figuren Lost", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [A]);
    const draftId = (await draftsOf(jobId)).get(A)!.id;
    const claude = stubClaudeApi([
      async (params: LineRequest) => {
        // Meanwhile the orphan sweep (or another attempt) took the draft.
        await dbWrite((c) => c.aiDraft.update({ where: { id: draftId }, data: { status: "FAILED", error: "Taken by someone else." } }));
        return stubAnswer(claudeAnswerOf("de-figuren"), params);
      },
    ]);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    expect((await draftsOf(jobId)).get(A)).toMatchObject({ status: "FAILED", error: "Taken by someone else.", line: null, calls: 1, costUsd: 0.0036 });
  });
});

describe("Stop", () => {
  it("while running: the company in flight finishes, the others are taken off the list", async () => {
    const A = await makeCompany({ name: "Figuren Stop", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Stop", website: ORIGIN.noButikk });
    const C = await makeCompany({ name: "Grid Stop", website: ORIGIN.shopGrid });
    const jobId = await startRun(users.ali, [A, B, C]);
    const stub = heldStub();
    const { reader } = await fixtureReader();
    const running = runAiJob({ reader, claude: stub.claude, companyConcurrency: 1, logger: memoryLogger() });
    await stub.started.promise;
    expect(await stopDraftRun(users.ali, jobId)).toEqual({ message: "Stopping. The companies being drafted right now are finished first." });
    stub.release.open();
    expect((await running).outcome).toBe("done");
    const drafts = await draftsOf(jobId);
    expect(drafts.get(A)).toMatchObject({ status: "READY" });
    expect(drafts.has(B)).toBe(false);
    expect(drafts.has(C)).toBe(false);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("DONE");
    expect(job.result).toMatchObject({ summary: "Stopped after 1 of 3 companies.", stopped: "stop" });
    expect(await db.notification.count({ where: { type: { in: ["ai.draftsReady", "ai.runStopped"] } } })).toBe(0);
  });
});

describe("yields", () => {
  it("a panel run queued during a Contacts run goes first, then the Contacts run goes on", async () => {
    const A = await makeCompany({ name: "Figuren Yield", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Yield", website: ORIGIN.noButikk });
    const P = await makeCompany({ name: "Grid Panel", website: ORIGIN.shopGrid });
    const contacts = await startRun(users.ali, [A, B]);
    const stub = heldStub();
    const { reader } = await fixtureReader();
    const deps = { reader, claude: stub.claude, companyConcurrency: 1, logger: memoryLogger() };
    const running = runAiJob(deps);
    await stub.started.promise;
    const panel = await startRun(users.ali, [P], { source: "panel" });
    stub.release.open();
    const first = await running;
    expect(first).toMatchObject({ jobId: contacts, outcome: "deferred", deferReason: "yield" });
    expect((await draftsOf(contacts)).get(B)).toMatchObject({ status: "QUEUED" });

    const second = await runAiJob(deps);
    expect(second).toMatchObject({ jobId: panel, outcome: "done" });
    expect((await draftsOf(panel)).get(P)).toMatchObject({ status: "READY" });
    const third = await runAiJob(deps);
    expect(third).toMatchObject({ jobId: contacts, outcome: "done" });
    expect((await draftsOf(contacts)).get(B)).toMatchObject({ status: "READY" });
  });

  it("a long run yields after its time slice and keeps its carry", async () => {
    const A = await makeCompany({ name: "Figuren Slice", website: ORIGIN.deFiguren });
    const B = await makeCompany({ name: "Butikk Slice", website: ORIGIN.noButikk });
    const jobId = await startRun(users.ali, [A, B]);
    let now = Date.parse("2026-09-26T10:00:00Z");
    const clock = () => new Date(now);
    const stub = heldStub();
    stub.release.open();
    const { reader } = await fixtureReader();
    const deps = {
      reader,
      claude: stub.claude,
      companyConcurrency: 1,
      yieldAfterMs: 60_000,
      logger: memoryLogger(),
      // Every read of the clock moves it on 40 s: the second claim comes after the 60-second slice.
      now: () => {
        const at = clock();
        now += 40_000;
        return at;
      },
    };
    const res = await runAiJob(deps);
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "yield" });
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.result).toMatchObject({ deferred: "yield", carry: { model: HAIKU_MODEL, runCapUsd: null } });
    const drafts = await draftsOf(jobId);
    expect([...drafts.values()].filter((d) => d.status === "READY")).toHaveLength(1);
  });
});

describe("the practice copy", () => {
  it("writes made-up lines for free, every 7th company No line, with no reader or Claude, whatever was injected", async () => {
    await setSetting("practice.copy", true, users.owner.id);
    const ids: number[] = [];
    while (ids.length < 8 || !ids.some((id) => id % 7 === 0)) ids.push(await makeCompany({ website: `https://practice-${ids.length + 1}.example` }));
    const insta = await makeCompany({ name: "Insta Only", instagram: "insta_only" });
    const jobId = await startRun(users.ali, [...ids, insta]);
    const payload = (await db.job.findUniqueOrThrow({ where: { id: jobId } })).payload;
    expect(payload).toMatchObject({ model: "practice", aboutUsd: 0, atMostUsd: 0 });

    let reads = 0;
    const reader: WebsiteReader = {
      async read() {
        reads += 1;
        throw new Error("The practice copy must not read websites.");
      },
    };
    const claude = stubClaudeApi();
    expect((await runAiJob({ reader, claude })).outcome).toBe("done");
    expect(reads).toBe(0);
    expect(claude.calls).toHaveLength(0);
    expect(claude.countCalls).toHaveLength(0);
    expect(cl.fake.requests).toHaveLength(0);

    const drafts = await draftsOf(jobId);
    expect(drafts.has(insta)).toBe(false);
    for (const id of ids) {
      const d = drafts.get(id)!;
      expect(d).toMatchObject({ model: "practice", calls: 0, costUsd: null });
      expect(d.flags).toEqual([{ code: "practice", text: "Practice copy: made up, not from the website." }]);
      if (id % 7 === 0) expect(d).toMatchObject({ status: "NO_LINE", reasonIfNull: "thin" });
      else {
        const name = (await db.company.findUniqueOrThrow({ where: { id } })).name;
        expect(d).toMatchObject({
          status: "READY",
          line: `(Practice) A sentence about ${name}'s own work would appear here.`,
          evidenceQuote: "(Practice copy: no website was read.)",
        });
      }
    }
    const noLine = ids.filter((id) => id % 7 === 0).length;
    const ready = ids.length - noLine;
    const note = await db.notification.findFirstOrThrow({ where: { userId: users.ali.id, type: "ai.draftsReady" } });
    expect(note.body).toBe(`${ready} lines are waiting for you. ${noLine === 1 ? "1 company" : `${noLine} companies`} got no line.`);
  });
});
