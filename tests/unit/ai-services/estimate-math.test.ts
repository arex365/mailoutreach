import { describe, expect, it } from "vitest";
import { callCeilingUsd } from "@/core/ai/cost";
import {
  ABOUT_FACTOR,
  aiTokenKey,
  averageCallTokens,
  AVERAGE_MIN_DRAFTS,
  callMaxUsd,
  companyWorstCaseUsd,
  DRAFT_PROMPT_VERSION,
  DRAFTER_MAX_CALLS,
  limitUsdText,
  MAX_FACTOR,
  maxPageTokens,
  MESSAGE_ALLOWANCE_TOKENS,
  monthlyLimitText,
  perCallMaxUsd,
  perCompanyUsd,
  runCostUsd,
  type TokenSample,
} from "@/core/ai/estimate";
import { buildUserMessage } from "@/core/ai/prompt";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile, SONNET_MODEL } from "@/core/ai/types";
import { aboutUsd, formatUsd } from "@/core/money";

/** The cost math of docs/dev/M5-DESIGN.md §3.3 (P5 `@/core/ai/estimate`). */

const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
const sonnet = resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES);
const defaults = (p: typeof haiku) => ({
  systemTokens: p.defaultSystemTokens,
  avgPageTokens: p.defaultPageTokens,
  avgOutputTokens: p.defaultOutputTokens,
});

describe("per company and per run (§3.3 worked defaults)", () => {
  it("Haiku 4.5: about $0.0056, at most $0.0105 per company; $1.69 / $3.15 per 300", () => {
    const one = perCompanyUsd(haiku, defaults(haiku))!;
    expect(one.aboutUsd).toBeCloseTo(0.005635, 9);
    expect(one.maxUsd).toBeCloseTo(0.0105, 9);
    const run = runCostUsd(300, one);
    expect(formatUsd(run.aboutUsd)).toBe("$1.69");
    expect(formatUsd(run.atMostUsd)).toBe("$3.15");
    expect(aboutUsd(run.aboutUsd)).toBe("about $1.69");
  });

  it("Sonnet 5: about $0.0197, at most $0.0426 per company; $5.91 / $12.77 per 300", () => {
    const one = perCompanyUsd(sonnet, defaults(sonnet))!;
    expect(one.aboutUsd).toBeCloseTo(0.019711, 6);
    expect(one.maxUsd).toBeCloseTo(0.04255, 9);
    const run = runCostUsd(300, one);
    expect(formatUsd(run.aboutUsd)).toBe("$5.91");
    expect(formatUsd(run.atMostUsd)).toBe("$12.77");
  });

  it("uses the page cap in the model's own tokens and max_tokens for the maximum", () => {
    expect(maxPageTokens(haiku)).toBe(4_000);
    expect(maxPageTokens(sonnet)).toBe(5_200);
    // One call's ceiling without the 25 % margin: ((1,400 + 4,000) × $1 + 600 × $5) / 1e6.
    expect(perCallMaxUsd(haiku, 1_400)).toBeCloseTo(0.0084, 12);
    expect(perCallMaxUsd(sonnet, 1_820)).toBeCloseTo(0.03404, 12);
    expect(perCompanyUsd(haiku, defaults(haiku))!.maxUsd).toBeCloseTo(perCallMaxUsd(haiku, 1_400) * MAX_FACTOR, 12);
  });

  it("follows measured system tokens and averages", () => {
    const one = perCompanyUsd(haiku, { systemTokens: 2_000, avgPageTokens: 1_000, avgOutputTokens: 100 })!;
    expect(one.aboutUsd).toBeCloseTo(((3_000 * 1 + 100 * 5) / 1e6) * ABOUT_FACTOR, 12);
    expect(one.maxUsd).toBeCloseTo((((2_000 + 4_000) * 1 + 600 * 5) / 1e6) * MAX_FACTOR, 12);
  });

  it("a model without a price can't be estimated, and one call's ceiling reads as 0", () => {
    const custom = resolveProfile("claude-x", { id: "claude-x", label: "X", maxTokens: 3_000, effortLow: false, checkedAt: "2026-09-26T00:00:00Z" }, {});
    expect(custom.prices).toBeNull();
    expect(perCompanyUsd(custom, defaults(custom))).toBeNull();
    expect(perCallMaxUsd(custom, 1_820)).toBe(0);
    expect(runCostUsd(10, null)).toEqual({ aboutUsd: 0, atMostUsd: 0 });
  });

  it("rounds a run to 6 decimals and never goes below 0", () => {
    expect(runCostUsd(0, { aboutUsd: 1, maxUsd: 2 })).toEqual({ aboutUsd: 0, atMostUsd: 0 });
    expect(runCostUsd(-3, { aboutUsd: 1, maxUsd: 2 })).toEqual({ aboutUsd: 0, atMostUsd: 0 });
    expect(runCostUsd(3, { aboutUsd: 0.1234567891, maxUsd: 0.2 })).toEqual({ aboutUsd: 0.37037, atMostUsd: 0.6 });
  });
});

describe("running averages", () => {
  const sample = (inputTokens: number, outputTokens: number, calls = 1): TokenSample => ({ inputTokens, outputTokens, calls });

  it("needs at least 10 drafted drafts", () => {
    const nine = Array.from({ length: AVERAGE_MIN_DRAFTS - 1 }, () => sample(4_000, 150));
    expect(averageCallTokens(nine, 1_400)).toBeNull();
    const ten = [...nine, sample(4_000, 150)];
    expect(averageCallTokens(ten, 1_400)).toEqual({ pageTokens: 2_600, outputTokens: 150, drafts: 10 });
  });

  it("averages per Claude call (a regenerated draft counts two calls) and never goes below 0 page tokens", () => {
    const rows = [...Array.from({ length: 9 }, () => sample(3_400, 100)), sample(6_800, 400, 2), sample(500, 50)];
    // 9 × 2,000 + (6,800 − 2 × 1,400 = 4,000) + max(0, 500 − 1,400) over 12 calls; outputs 900 + 400 + 50 over 12.
    const avg = averageCallTokens(rows, 1_400)!;
    expect(avg.drafts).toBe(11);
    expect(avg.pageTokens).toBeCloseTo((9 * 2_000 + 4_000) / 12, 9);
    expect(avg.outputTokens).toBeCloseTo((900 + 400 + 50) / 12, 9);
  });

  it("uses the newest 50 only and skips unusable samples", () => {
    const newest = Array.from({ length: 50 }, () => sample(2_400, 100));
    const older = Array.from({ length: 30 }, () => sample(99_999, 9_999));
    const bad = [sample(1, 1, 0), { inputTokens: Number.NaN, outputTokens: 1, calls: 1 }];
    expect(averageCallTokens([...bad, ...newest, ...older], 1_400)).toEqual({ pageTokens: 1_000, outputTokens: 100, drafts: 50 });
  });

  it("leaves out drafts that were never billed: 0-token error answers don't pull the 'about' down (AI-8)", () => {
    const real = Array.from({ length: 10 }, () => sample(3_400, 100));
    const failures = Array.from({ length: 20 }, () => sample(0, 0, 1));
    expect(averageCallTokens([...failures, ...real], 1_400)).toEqual({ pageTokens: 2_000, outputTokens: 100, drafts: 10 });
    // Only the failures: not enough measured drafts, so the profile defaults apply.
    expect(averageCallTokens(failures, 1_400)).toBeNull();
  });
});

describe("one company's worst case (the run cap's floor, AI-3)", () => {
  it("one call at the page cap plus the message allowance, with this call's max_tokens", () => {
    expect(MESSAGE_ALLOWANCE_TOKENS).toBe(1_500);
    // ((1,400 + 5,500) × $1 + 600 × $5) / 1e6 and the doubled retry's 1,200 output tokens.
    expect(callMaxUsd(haiku, 1_400, 600)).toBeCloseTo(0.0099, 12);
    expect(callMaxUsd(haiku, 1_400, 1_200)).toBeCloseTo(0.0129, 12);
    // Sonnet counts the page and allowance in its own tokens: 5,500 × 1.3 = 7,150.
    expect(callMaxUsd(sonnet, 1_820, 4_000)).toBeCloseTo(((1_820 + 7_150) * 2 + 4_000 * 10) / 1e6, 12);
  });

  it("the first call plus three more at the doubled max_tokens (regeneration, max_tokens retry, one retry after no answer)", () => {
    expect(DRAFTER_MAX_CALLS).toBe(4);
    expect(companyWorstCaseUsd(haiku, 1_400)).toBeCloseTo(0.0099 + 3 * 0.0129, 12);
    // Always more than 125 % of one company's "at most", so a panel run can afford its regeneration.
    expect(companyWorstCaseUsd(haiku, 1_400)).toBeGreaterThan(1.25 * perCompanyUsd(haiku, defaults(haiku))!.maxUsd);
    expect(companyWorstCaseUsd(sonnet, 1_820)).toBeGreaterThan(1.25 * perCompanyUsd(sonnet, defaults(sonnet))!.maxUsd);
    const custom = resolveProfile("claude-x", { id: "claude-x", label: "X", maxTokens: 3_000, effortLow: false, checkedAt: "2026-09-26T00:00:00Z" }, {});
    expect(companyWorstCaseUsd(custom, 1_820)).toBe(0);
  });

  it("covers a regeneration's real ceiling on a page at the cap (the reported 11,900-character page)", () => {
    const page = "Resin busts and dragons for collectors. ".repeat(298).slice(0, 11_900);
    const avoid = ["Your Moscow studio casts resin figures of dragons and griffins for collectors."];
    const message = buildUserMessage({
      company: { name: "Big Page Studio", country: "Germany", niche: "miniatures" },
      pages: [{ source: "homepage", url: "https://big-page.example/", lang: "en", title: "Big Page Studio", text: page }],
      avoid,
      previousProblem: "The line mentions “Moscow”, but the pages don't.",
    });
    const regeneration = callCeilingUsd(haiku, 1_400, message, 600);
    const retry = callCeilingUsd(haiku, 1_400, message, 1_200);
    expect(regeneration).toBeLessThanOrEqual(callMaxUsd(haiku, 1_400, 600));
    expect(retry).toBeLessThanOrEqual(callMaxUsd(haiku, 1_400, 1_200));
    // The first call's real cost ($0.00515) plus the regeneration fits a one-company run's cap now.
    expect(0.00515 + regeneration).toBeLessThanOrEqual(companyWorstCaseUsd(haiku, 1_400));
  });
});

describe("words", () => {
  it("writes the A6 monthly limit sentence with whole dollars", () => {
    expect(monthlyLimitText(20, "1 November")).toBe(
      "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November.",
    );
    expect(limitUsdText(1_000)).toBe("$1,000");
    expect(limitUsdText(12.5)).toBe("$12.50");
    expect(limitUsdText(0)).toBe("$0");
  });

  it("keys measured tokens by model and prompt version", () => {
    expect(DRAFT_PROMPT_VERSION).toBe("pl-2026-09-26");
    expect(aiTokenKey(HAIKU_MODEL)).toBe("claude-haiku-4-5-20251001|pl-2026-09-26");
    expect(aiTokenKey("m", "v2")).toBe("m|v2");
  });
});
