import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cross-checks between the Milestone 5 packages (M5-DESIGN §8 P11): every fixture site's `claude.json` answer (what
 * the fake Claude answers for that site) goes through the real pipeline pieces: the website reader over the fixture
 * sites (P3), the page text exactly as the request carries it (after stripOurTags, P2), the automatic checks
 * (`checkLine`, P2) and the review card's evidence snippet (`evidenceSnippet`, P5). The checks and the snippet share the
 * contract normaliser (@/core/ai/normalize), so a quote the checks find is a quote the card can highlight. Also: the
 * prompt version and the monthly-limit sentence that P5 and P2/P8 each use are the same. No network: the fixture
 * transport serves the saved sites.
 */

const SITES = path.resolve("tests/fixtures/sites");
const { createReader, fixtureTransport, immediatePoliteness, memoryRobotsStore } = await import("@/server/web");
const { checkLine } = await import("@/core/ai/checks");
const { stripOurTags, PROMPT_VERSION } = await import("@/core/ai/prompt");
const { normalizeForMatch } = await import("@/core/ai/normalize");
const { evidenceSnippet } = await import("@/server/services/ai/snippet");
const { DRAFT_PROMPT_VERSION, aiTokenKey, monthlyLimitText } = await import("@/core/ai/estimate");
const { aiPauseText } = await import("@/server/anthropic/errors");
const { HAIKU_MODEL } = await import("@/core/ai/types");

type LineAnswer = import("@/core/ai/types").LineAnswer;

/** Every fixture folder that has a claude.json answer, with its site's origin. */
const answered = fs
  .readdirSync(SITES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SITES, d.name, "claude.json")))
  .map((d) => {
    const site = JSON.parse(fs.readFileSync(path.join(SITES, d.name, "site.json"), "utf8")) as { origin: string };
    const answer = JSON.parse(fs.readFileSync(path.join(SITES, d.name, "claude.json"), "utf8")) as LineAnswer;
    return { folder: d.name, origin: site.origin, answer };
  });

/** Warnings the checks may add to a passing line: notes about the site, never about the line itself. */
const EXPECTED_NOTES: Record<string, string[]> = {
  "hidden-text": ["hidden-text"],
  injection: ["injection-hint"],
};

describe("every fixture site's Claude answer", () => {
  it("is there for the ten sites that get a line", () => {
    expect(answered.map((a) => a.folder).sort()).toEqual([
      "cookie-banner",
      "crawl-delay",
      "de-figuren",
      "hidden-text",
      "injection",
      "js-meta",
      "latin1",
      "no-butikk",
      "redirect-www",
      "shop-grid",
    ]);
  });

  it.each(answered)("$folder: passes the automatic checks on the pages Claude is sent, and the card can highlight its quote", async ({ folder, origin, answer }) => {
    const reader = createReader({ transport: fixtureTransport(SITES), politeness: immediatePoliteness, robotsStore: memoryRobotsStore() });
    const read = await reader.read({ website: origin, companyName: folder }, { signal: new AbortController().signal, now: new Date("2026-09-23T08:00:00.000Z") });
    expect(read.ok, `${folder} should be readable`).toBe(true);
    if (!read.ok) return;

    // Exactly what the drafting job sends and checks (src/server/ai/drafter.ts checkPages).
    const pages = read.pages.map((p) => ({
      source: p.kind,
      title: p.title == null ? null : stripOurTags(p.title).trim() || null,
      text: stripOurTags(p.text),
      lang: p.lang,
      notes: p.notes,
    }));
    const host = new URL(origin).hostname.replace(/^www\./, "");
    const res = checkLine({ answer, pages, companyName: folder, countryName: null, companyDomain: host, avoid: [], injectionHint: read.injectionHint });
    expect(res.problems, `${folder}: ${JSON.stringify(res.problems)}`).toEqual([]);
    expect(res.pass).toBe(true);
    expect(res.flags.map((f) => f.code).sort()).toEqual((EXPECTED_NOTES[folder] ?? []).sort());

    // The quote is on the page Claude named (or the other one, noted), and the snippet finds the same words there.
    expect(res.quotePage).not.toBeNull();
    const page = pages.find((p) => p.source === res.quotePage)!;
    const snippet = evidenceSnippet({ title: page.title, text: page.text }, answer.evidence_quote!);
    expect(snippet, `${folder}: the card couldn't highlight the quote`).not.toBeNull();
    expect(normalizeForMatch(snippet!.match)).toBe(normalizeForMatch(answer.evidence_quote!));
  });
});

describe("shared constants between the packages", () => {
  it("drafts and measured tokens use the prompt's own version", () => {
    expect(DRAFT_PROMPT_VERSION).toBe(PROMPT_VERSION);
    expect(aiTokenKey(HAIKU_MODEL)).toBe(`${HAIKU_MODEL}|${PROMPT_VERSION}`);
  });

  it("a refused start and the monthly-limit pause say the same sentence", () => {
    for (const [limitUsd, resetLabel] of [
      [20, "1 November"],
      [12.5, "1 January"],
      [1_000, "1 October"],
    ] as const) {
      expect(monthlyLimitText(limitUsd, resetLabel)).toBe(aiPauseText("monthly_limit", { model: HAIKU_MODEL, limitUsd, resetLabel }));
    }
    expect(monthlyLimitText(20, "1 November")).toBe(
      "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November.",
    );
  });
});
