import { describe, expect, it } from "vitest";
import type { CheckLineResult } from "@/core/ai/checks";
import type { LineAnswer } from "@/core/ai/types";
import { usableAnswer } from "@/server/ai/drafter";
import { PRACTICE_FLAG, PRACTICE_QUOTE, practiceLine, practiceOutcome } from "@/server/ai/practice";

/** The practice drafter's outcomes (M5-DESIGN §3.12) and which answers can be shown as a line (§3.6). */

describe("practiceOutcome", () => {
  const company = (id: number, over: Partial<{ website: string | null; instagram: string | null; deletedAt: Date | null }> = {}) => ({
    id,
    name: "Firma GmbH",
    website: "https://firma.example",
    instagram: null,
    deletedAt: null,
    ...over,
  });

  it("a company with a website gets the made-up line, quote and flag", () => {
    expect(practiceOutcome(company(8))).toEqual({
      status: "READY",
      line: "(Practice) A sentence about Firma GmbH's own work would appear here.",
      evidenceQuote: PRACTICE_QUOTE,
      evidenceSource: "homepage",
      evidenceUrl: null,
      flags: [PRACTICE_FLAG],
      homeSnapshotId: null,
      pageSnapshotId: null,
    });
    expect(practiceLine("Butikk AS")).toBe("(Practice) A sentence about Butikk AS's own work would appear here.");
    expect(PRACTICE_FLAG).toEqual({ code: "practice", text: "Practice copy: made up, not from the website." });
  });

  it("every 7th company (by id) gets No line, thin", () => {
    for (const id of [7, 14, 700]) expect(practiceOutcome(company(id))).toMatchObject({ status: "NO_LINE", reasonIfNull: "thin" });
    for (const id of [1, 6, 8, 13]) expect(practiceOutcome(company(id)).status).toBe("READY");
  });

  it("the skip rules still apply: deleted, no website, social only", () => {
    expect(practiceOutcome(null)).toEqual({ status: "FAILED", error: "This company was deleted.", flags: [] });
    expect(practiceOutcome(company(2, { deletedAt: new Date() }))).toMatchObject({ status: "FAILED" });
    expect(practiceOutcome(company(2, { website: null }))).toMatchObject({ status: "NO_LINE", reasonIfNull: "no_website" });
    expect(practiceOutcome(company(2, { website: null, instagram: "anna" }))).toMatchObject({ status: "NO_LINE", reasonIfNull: "social_only" });
    expect(practiceOutcome(company(2, { website: "https://www.instagram.com/anna" }))).toMatchObject({
      status: "NO_LINE",
      reasonIfNull: "social_only",
    });
  });
});

describe("usableAnswer", () => {
  const answer = (over: Partial<LineAnswer> = {}): LineAnswer => ({
    evidence_source: "homepage",
    evidence_quote: "Hand-painted 32mm tabletop miniatures for fantasy wargames",
    line: "You sell hand-painted 32mm fantasy wargame miniatures.",
    reason_if_null: null,
    ...over,
  });
  const check = (problems: CheckLineResult["problems"] = []): CheckLineResult => ({ pass: problems.length === 0, problems, flags: [], quotePage: null });

  it("a line and a quote from a named page, even with other problems, is usable", () => {
    expect(usableAnswer({ answer: answer(), check: check([{ code: "name-not-found", token: "Leipzig" }]) })).toBe(true);
  });

  it("an inconsistent, empty or null answer isn't", () => {
    expect(usableAnswer(null)).toBe(false);
    expect(usableAnswer({ answer: answer(), check: check([{ code: "inconsistent" }]) })).toBe(false);
    expect(usableAnswer({ answer: answer({ line: null }), check: check() })).toBe(false);
    expect(usableAnswer({ answer: answer({ line: "  " }), check: check() })).toBe(false);
    expect(usableAnswer({ answer: answer({ evidence_quote: null }), check: check() })).toBe(false);
    expect(usableAnswer({ answer: answer({ evidence_source: "none" }), check: check() })).toBe(false);
  });
});
