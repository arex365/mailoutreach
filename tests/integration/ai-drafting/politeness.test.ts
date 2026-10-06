import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import type { WebsiteReader } from "@/server/web";
import { createTestDb } from "../helpers/test-db";
import { stubClaudeApi } from "../helpers/claude";
import { echoAnswer, userTextOf } from "../../fake-claude/answers";
import { draftsOf, makeCompany, memoryLogger, ORIGIN, runAiJob, seedUsers, SITES, startRun, type TestUser } from "./harness";

/**
 * Politeness and concurrency of the drafting job (M5-DESIGN §3.1, §3.4.5; §8 P8 "politeness"): two companies on the
 * same host are never read at the same time and their requests are at least 2 s apart (the reader's politeness, with
 * an injected clock); at most 4 hosts are read at once and at most 2 Claude calls are out at once.
 */

const t = await createTestDb("ai-drafting-politeness");
const { db } = await import("@/server/db");
const { setSecret } = await import("@/server/secrets");
const { createPoliteness, createReader, fixtureTransport, memoryRobotsStore } = await import("@/server/web");

let users: { owner: TestUser; ali: TestUser };

beforeAll(async () => {
  users = await seedUsers();
  // A start needs a saved key; nothing here calls Anthropic (the Claude side is a stub).
  await setSecret("anthropic.apiKey", "sk-ant-fake-key-politeness", users.owner.id);
});
afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

function echo(params: LineRequest): ClaudeAnswer {
  return {
    text: JSON.stringify(echoAnswer(userTextOf(params))),
    stopReason: "end_turn",
    usage: { inputTokens: 3_000, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, thinkingTokens: null, inferenceGeo: null },
    requestId: "req_stub",
    model: params.model,
  };
}

const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("politeness", () => {
  it("two companies on the same host never overlap and their requests are at least 2 s apart", async () => {
    let now = Date.parse("2026-09-26T08:00:00Z");
    const clock = () => now;
    const transport = fixtureTransport(SITES, { now: clock });
    const inner = createReader({
      transport,
      politeness: createPoliteness({ now: clock, sleep: async (ms) => void (now += ms) }),
      robotsStore: memoryRobotsStore(),
      now: () => new Date(clock()),
    });
    const active = new Map<string, number>();
    let maxSameHost = 0;
    const windows: Array<{ host: string; start: number; end: number }> = [];
    const reader: WebsiteReader = {
      async read(input, opts) {
        const host = new URL(input.website).hostname;
        active.set(host, (active.get(host) ?? 0) + 1);
        maxSameHost = Math.max(maxSameHost, active.get(host)!);
        const start = now;
        try {
          return await inner.read(input, opts);
        } finally {
          active.set(host, active.get(host)! - 1);
          windows.push({ host, start, end: now });
        }
      },
    };
    const X1 = await makeCompany({ name: "Figuren One", website: ORIGIN.deFiguren });
    const X2 = await makeCompany({ name: "Figuren Two", website: ORIGIN.deFiguren });
    const X3 = await makeCompany({ name: "Butikk Three", website: ORIGIN.noButikk });
    const jobId = await startRun(users.ali, [X1, X2, X3]);
    const claude = stubClaudeApi(Array.from({ length: 10 }, () => (p: LineRequest) => echo(p)));
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");

    const drafts = await draftsOf(jobId);
    for (const id of [X1, X2, X3]) expect(drafts.get(id)?.status).toBe("READY");
    expect(maxSameHost).toBe(1);
    const figuren = windows.filter((w) => w.host === "www.figuren-werkstatt.example").sort((a, b) => a.start - b.start);
    expect(figuren).toHaveLength(2);
    expect(figuren[1]!.start).toBeGreaterThanOrEqual(figuren[0]!.end);
    const hostCalls = transport.calls.filter((c) => new URL(c.url).hostname === "www.figuren-werkstatt.example").map((c) => c.at);
    expect(hostCalls.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < hostCalls.length; i++) expect(hostCalls[i]! - hostCalls[i - 1]!).toBeGreaterThanOrEqual(2_000);
  });

  it("at most 4 hosts are read at once and at most 2 Claude calls are out at once", async () => {
    const { immediatePoliteness } = await import("@/server/web");
    const inner = createReader({ transport: fixtureTransport(SITES), politeness: immediatePoliteness, robotsStore: memoryRobotsStore() });
    let reading = 0;
    let maxReading = 0;
    const reader: WebsiteReader = {
      async read(input, opts) {
        reading += 1;
        maxReading = Math.max(maxReading, reading);
        try {
          await sleepReal(20);
          return await inner.read(input, opts);
        } finally {
          reading -= 1;
        }
      },
    };
    let calling = 0;
    let maxCalling = 0;
    const claude = stubClaudeApi(
      Array.from({ length: 20 }, () => async (p: LineRequest) => {
        calling += 1;
        maxCalling = Math.max(maxCalling, calling);
        try {
          await sleepReal(30);
          return echo(p);
        } finally {
          calling -= 1;
        }
      }),
    );
    const sites = [ORIGIN.deFiguren, ORIGIN.noButikk, ORIGIN.shopGrid, ORIGIN.cookieBanner, ORIGIN.latin1, ORIGIN.hiddenText];
    const ids: number[] = [];
    for (const [i, website] of sites.entries()) ids.push(await makeCompany({ name: `Host ${i}`, website }));
    const jobId = await startRun(users.ali, ids);
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    expect(maxReading).toBe(4);
    expect(maxCalling).toBe(2);
    const drafts = await draftsOf(jobId);
    expect(drafts.size).toBe(6);
    expect([...drafts.values()].every((d) => d.status === "READY")).toBe(true);
    expect(claude.calls).toHaveLength(6);
  });
});
