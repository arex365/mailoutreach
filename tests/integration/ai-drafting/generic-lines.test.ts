import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, stubClaudeApi, type FakeClaudeConnection } from "../helpers/claude";
import { echoAnswer, userTextOf } from "../../fake-claude/answers";
import { draftsOf, fixtureReader, makeCompany, memoryLogger, resetAiState, runAiJob, seedUsers, startRun, type TestUser } from "./harness";

/**
 * The lead's manual check (M5 review LEAD-1): the cyrillic.example card showed "Your homepage describes the products
 * your company makes and sells." with no warning. A line about their website fails the banned "your website" wording
 * (now also "your homepage", "your site", "your web page"), and a line that could describe almost any company gets the
 * "may be too general" warning, which never costs a paid regeneration.
 */

const t = await createTestDb("ai-drafting-generic");
const { db } = await import("@/server/db");
const { checkLine, GENERIC_LINE_FLAG } = await import("@/core/ai/checks");
const { stripOurTags } = await import("@/core/ai/prompt");

const CYRILLIC = "https://cyrillic.example";
/** The line on the lead's cyrillic.example card (the fake Claude's first echo line). */
const CARD_LINE = "Your homepage describes the products your company makes and sells.";

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

/** A stub reply: the fake's echo answer (the homepage's first 8 words as the quote) with this line. */
function echoWith(line: string) {
  return (params: LineRequest): ClaudeAnswer => ({
    text: JSON.stringify({ ...echoAnswer(userTextOf(params)), line }),
    stopReason: "end_turn",
    usage: { inputTokens: 3_000, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, thinkingTokens: null, inferenceGeo: null },
    requestId: "req_stub",
    model: params.model,
  });
}

describe("the cyrillic.example card line", () => {
  it("fails the banned 'your homepage' wording and is flagged as too general, on the page Claude was sent", async () => {
    const { reader } = await fixtureReader();
    const read = await reader.read({ website: CYRILLIC, companyName: "Cyrillic" }, { signal: new AbortController().signal, now: new Date() });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Exactly what the drafting job sends and checks.
    const pages = read.pages.map((p) => ({
      source: p.kind,
      title: p.title == null ? null : stripOurTags(p.title).trim() || null,
      text: stripOurTags(p.text),
      lang: p.lang,
      notes: p.notes,
    }));
    const quote = pages[0]!.text.split(/\s+/u).filter(Boolean).slice(0, 8).join(" ");
    const r = checkLine({
      answer: { evidence_source: "homepage", evidence_quote: quote, line: CARD_LINE, reason_if_null: null },
      pages,
      companyName: "Cyrillic",
      countryName: null,
      companyDomain: "cyrillic.example",
      avoid: [],
    });
    expect(r.quotePage).toBe("homepage");
    expect(r.problems).toEqual([{ code: "banned-word", kind: "meta", token: "your homepage" }]);
    expect(r.flags).toEqual([{ code: "banned-word", text: "Contains “your homepage”." }, GENERIC_LINE_FLAG]);
  });

  it("the card line is regenerated once (banned wording); a second card line stays with both warnings", async () => {
    const id = await makeCompany({ name: "Cyrillic Card", website: CYRILLIC });
    const jobId = await startRun(users.ali, [id]);
    const claude = stubClaudeApi([echoWith(CARD_LINE), echoWith(CARD_LINE)]);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]!.messages[0].content).toContain(
      "<previous_problem>The line uses “your homepage”; describe their work, not their website.</previous_problem>",
    );
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", calls: 2, line: CARD_LINE });
    expect(d.flags).toEqual(expect.arrayContaining([{ code: "banned-word", text: "Contains “your homepage”." }, GENERIC_LINE_FLAG]));
  });

  it("a too-general line without banned wording is READY after one call, with the warning (never a paid regeneration)", async () => {
    const id = await makeCompany({ name: "Cyrillic General", website: CYRILLIC });
    const jobId = await startRun(users.ali, [id]);
    const line = "You sell a wide range of products to collectors and museums.";
    const claude = stubClaudeApi([echoWith(line)]);
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader, claude, logger: memoryLogger() })).outcome).toBe("done");
    expect(claude.calls).toHaveLength(1);
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", calls: 1, line });
    expect(d.flags).toEqual([GENERIC_LINE_FLAG]);
  });
});
