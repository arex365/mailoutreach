import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, type FakeClaudeConnection } from "../helpers/claude";
import {
  claudeAnswerOf,
  draftsOf,
  fixtureReader,
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
 * §3.6 "Order of handling" with the fake Claude (M5-DESIGN §8 P8 tests, B12 "AI checks"): a failing first answer is
 * regenerated once with <avoid_repeating> and <previous_problem>; a second failure keeps the line with its warnings;
 * the consistency check failing twice fails the draft; `max_tokens` is retried once with double `max_tokens`; a
 * refusal is No line; Sonnet 5's thinking block before the text works.
 */

const t = await createTestDb("ai-drafting-regenerate");
const { db } = await import("@/server/db");
const { HAIKU_MODEL, SONNET_MODEL } = await import("@/core/ai/types");
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
});
afterAll(async () => {
  await cl.stop();
  await db.$disconnect();
  t.cleanup();
});

const figuren = claudeAnswerOf("de-figuren") as { evidence_source: string; evidence_quote: string; line: string };
/** A first answer whose line names a town the pages don't mention. */
const leipzig = {
  evidence_source: figuren.evidence_source,
  evidence_quote: figuren.evidence_quote,
  line: "Your gallery shows hand-painted dragons and griffins cast in cold-cast resin in your Leipzig workshop.",
  reason_if_null: null,
};

function messageRequests() {
  return cl.fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
}

type Draft = Awaited<ReturnType<typeof draftsOf>> extends Map<number, infer D> ? D : never;

/**
 * Drafts one company on the German fixture site. `withNeighbour` adds a second company (drafted after it, one company
 * at a time): a Contacts run of two, whose cost cap has room for a doubled `max_tokens` retry. (Since AI-3 a
 * one-company run's cap is at least companyWorstCaseUsd and has that room too; see guards.test.ts.)
 */
async function draftOne(name: string, opts: { withNeighbour?: boolean } = {}): Promise<{ id: number; draft: Draft }> {
  const id = await makeCompany({ name, website: ORIGIN.deFiguren, country: "DE" });
  const ids = opts.withNeighbour ? [id, await makeCompany({ name: `${name} Neighbour`, website: ORIGIN.shopGrid })] : [id];
  const jobId = await startRun(users.ali, ids);
  const { reader } = await fixtureReader();
  const res = await runAiJob({ reader, companyConcurrency: 1, logger: memoryLogger() });
  expect(res.outcome).toBe("done");
  return { id, draft: (await draftsOf(jobId)).get(id)! };
}

describe("regeneration", () => {
  it("an invented name → the second call avoids the line and names the problem → READY without warnings", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: leipzig });
    const { draft } = await draftOne("Werkstatt One");
    const sent = messageRequests();
    expect(sent).toHaveLength(2);
    const second: string = sent[1]!.body.messages[0].content;
    expect(second).toContain(`<avoid_repeating>${JSON.stringify([leipzig.line])}</avoid_repeating>`);
    expect(second).toContain("<previous_problem>The line mentions “Leipzig”, but the pages don't.</previous_problem>");
    expect(sent[0]!.body.messages[0].content).not.toContain("<previous_problem>");
    expect(draft).toMatchObject({ status: "READY", line: figuren.line, calls: 2, costUsd: 0.0072, inputTokens: 6_000, outputTokens: 240 });
    expect(draft.flags).toEqual([]);
  });

  it("both answers fail → READY with the warnings (reviewers decide)", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: leipzig }, 2);
    const { draft } = await draftOne("Werkstatt Two");
    expect(messageRequests()).toHaveLength(2);
    expect(draft).toMatchObject({ status: "READY", line: leipzig.line, calls: 2 });
    expect(draft.flags).toEqual(
      expect.arrayContaining([
        { code: "name-not-found", text: "Mentions “Leipzig”, which isn't on the website." },
        { code: "repeat", text: "Same as an earlier line." },
      ]),
    );
  });

  it("the consistency check failing twice → FAILED", async () => {
    const inconsistent = { evidence_source: "homepage", evidence_quote: null, line: "You make hand-painted resin figures in small series.", reason_if_null: null };
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: inconsistent }, 2);
    const { draft } = await draftOne("Werkstatt Three");
    expect(messageRequests()).toHaveLength(2);
    expect(draft).toMatchObject({ status: "FAILED", error: "Claude's answer didn't fit together.", calls: 2, costUsd: 0.0072 });
    expect(draft.line).toBeNull();
  });

  it("an inconsistent first answer and a good second one → READY", async () => {
    const inconsistent = { evidence_source: "none", evidence_quote: null, line: "You make hand-painted resin figures in small series.", reason_if_null: null };
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: inconsistent });
    const { draft } = await draftOne("Werkstatt Four");
    expect(messageRequests()[1]!.body.messages[0].content).toContain(
      "<previous_problem>When the line is null, the quote must be null too, and the other way round.</previous_problem>",
    );
    expect(draft).toMatchObject({ status: "READY", line: figuren.line, calls: 2 });
  });

  it("two unreadable answers → FAILED", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: "this is not JSON" }, 2);
    const { draft } = await draftOne("Werkstatt Five");
    expect(draft).toMatchObject({ status: "FAILED", error: "Claude's answer couldn't be read. Click Try again.", calls: 2 });
  });

  it("a null line on the regeneration → No line with Claude's reason", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: leipzig });
    cl.fake.failNext("POST /v1/messages", {
      kind: "answer",
      answer: { evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "only_generic_claims" },
    });
    const { draft } = await draftOne("Werkstatt Six");
    expect(draft).toMatchObject({ status: "NO_LINE", reasonIfNull: "only_generic_claims", calls: 2 });
  });
});

describe("stop reasons", () => {
  it("max_tokens → one retry with double max_tokens", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "max_tokens" });
    const { draft } = await draftOne("Werkstatt Tokens", { withNeighbour: true });
    // The first company: 600, then the retry at 1,200; the neighbour: 600.
    expect(messageRequests().map((r) => r.body.max_tokens)).toEqual([600, 1_200, 600]);
    // The stopped call billed its 600 output tokens: (3,000 + 600 × 5) / 1e6 + the retry's $0.0036.
    expect(draft).toMatchObject({ status: "READY", line: figuren.line, calls: 2, stopReason: "end_turn", costUsd: 0.0096 });
  });

  it("max_tokens counts once: a failing answer after it is still regenerated", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "max_tokens" });
    cl.fake.failNext("POST /v1/messages", { kind: "answer", answer: leipzig });
    const { draft } = await draftOne("Werkstatt Tokens Two", { withNeighbour: true });
    expect(messageRequests().map((r) => r.body.max_tokens)).toEqual([600, 1_200, 1_200, 600]);
    expect(draft).toMatchObject({ status: "READY", line: figuren.line, calls: 3 });
  });

  it("refusal → No line model_declined, no second call", async () => {
    cl.fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "refusal" });
    const { draft } = await draftOne("Werkstatt Refusal");
    expect(messageRequests()).toHaveLength(1);
    expect(draft).toMatchObject({ status: "NO_LINE", reasonIfNull: "model_declined", calls: 1, stopReason: "refusal" });
  });

  it("Sonnet 5: effort low, and a thinking block before the text is fine", async () => {
    await setSetting("ai.model", SONNET_MODEL, users.owner.id);
    cl.fake.failNext("POST /v1/messages", { kind: "thinkingFirst" });
    const { draft } = await draftOne("Werkstatt Sonnet");
    const [req] = messageRequests();
    expect(req!.body).toMatchObject({ model: SONNET_MODEL, max_tokens: 2_000, output_config: { effort: "low" } });
    expect(req!.body).not.toHaveProperty("thinking");
    // Sonnet 5 prices: (3,000 × $2 + 120 × $10) / 1e6.
    expect(draft).toMatchObject({ status: "READY", model: SONNET_MODEL, line: figuren.line, costUsd: 0.0072 });
    expect(draft.model).not.toBe(HAIKU_MODEL);
  });
});
