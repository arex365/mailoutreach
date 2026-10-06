import { describe, expect, it } from "vitest";
import { callCeilingUsd, costUsd, emptyUsage, MissingAiPriceError, totalInputTokens, type ClaudeUsage } from "@/core/ai/cost";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile, SONNET_MODEL } from "@/core/ai/types";

/** M5-DESIGN §3.3, research ai-and-fetch A8: cost per call and the ceiling the spend guard reserves. */

const HAIKU_PRICES = DEFAULT_AI_PRICES[HAIKU_MODEL]!;
const SONNET_PRICES = DEFAULT_AI_PRICES[SONNET_MODEL]!;

function usage(over: Partial<ClaudeUsage>): ClaudeUsage {
  return { ...emptyUsage(), ...over };
}

describe("costUsd", () => {
  it("Haiku 4.5 at 4,500 input and 200 output tokens costs $0.0055", () => {
    expect(costUsd(usage({ inputTokens: 4_500, outputTokens: 200 }), HAIKU_PRICES)).toBe(0.0055);
  });

  it("the fake's default usage (3,000 / 120) costs $0.0036 on Haiku and $0.0072 on Sonnet", () => {
    expect(costUsd(usage({ inputTokens: 3_000, outputTokens: 120 }), HAIKU_PRICES)).toBe(0.0036);
    expect(costUsd(usage({ inputTokens: 3_000, outputTokens: 120 }), SONNET_PRICES)).toBe(0.0072);
  });

  it("prices cache writes at 1.25× and 2×, cache reads at 0.1×", () => {
    const u = usage({ inputTokens: 1_000, cacheWrite5mTokens: 2_000, cacheWrite1hTokens: 1_000, cacheReadTokens: 3_000, outputTokens: 100 });
    // 1,000 + 2,500 + 2,000 + 300 input-price tokens, 100 output tokens × 5.
    expect(costUsd(u, HAIKU_PRICES)).toBe(0.0063);
    expect(totalInputTokens(u)).toBe(7_000);
  });

  it('inference_geo "us" costs 1.1 times as much; other regions don\'t', () => {
    expect(costUsd(usage({ inputTokens: 4_500, outputTokens: 200, inferenceGeo: "us" }), HAIKU_PRICES)).toBe(0.00605);
    expect(costUsd(usage({ inputTokens: 4_500, outputTokens: 200, inferenceGeo: "global" }), HAIKU_PRICES)).toBe(0.0055);
  });

  it("rounds to 6 decimals and ignores negative or broken counts", () => {
    expect(costUsd(usage({ inputTokens: 1, outputTokens: 0 }), { inputPerMTok: 0.3333333, outputPerMTok: 1 })).toBe(0);
    expect(costUsd(usage({ inputTokens: -5, outputTokens: Number.NaN }), HAIKU_PRICES)).toBe(0);
  });

  it("throws on missing or broken prices", () => {
    expect(() => costUsd(usage({ inputTokens: 10 }), null)).toThrow(MissingAiPriceError);
    expect(() => costUsd(usage({ inputTokens: 10 }), { inputPerMTok: Number.NaN, outputPerMTok: 5 })).toThrow(MissingAiPriceError);
    expect(() => costUsd(usage({ inputTokens: 10 }), { inputPerMTok: 1, outputPerMTok: -1 })).toThrow(MissingAiPriceError);
  });
});

describe("callCeilingUsd", () => {
  it("counts the system prompt, the estimated message tokens and this call's max_tokens", () => {
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    // 3,000 plain characters = 1,000 estimated tokens; (1,400 + 1,000) × $1 + 600 × $5 per million.
    expect(callCeilingUsd(haiku, 1_400, "a".repeat(3_000), 600)).toBe(0.0054);
    // The retry with double max_tokens.
    expect(callCeilingUsd(haiku, 1_400, "a".repeat(3_000), 1_200)).toBe(0.0084);
  });

  it("applies the tokenizer factor and counts non-ASCII text by character", () => {
    const sonnet = resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES);
    // 1,000 × 1.3 = 1,300; (1,820 + 1,300) × $2 + 2,000 × $10 per million.
    expect(callCeilingUsd(sonnet, 1_820, "a".repeat(3_000), 2_000)).toBe(0.02624);
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    // 300 Cyrillic characters count as 300 tokens, not 100.
    expect(callCeilingUsd(haiku, 0, "д".repeat(300), 0)).toBe(0.0003);
  });

  it("never understates by rounding", () => {
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    const ceiling = callCeilingUsd(haiku, 1, "abcd", 1);
    // 1 + 2 input tokens × $1 + 1 output token × $5 = 8 micro-dollars.
    expect(ceiling).toBe(0.000008);
    expect(callCeilingUsd({ ...haiku, prices: { inputPerMTok: 0.1, outputPerMTok: 0 } }, 1, "", 0)).toBe(0.000001);
  });

  it("throws when the profile has no prices", () => {
    const custom = resolveProfile("claude-unpriced", null, DEFAULT_AI_PRICES);
    expect(custom.prices).toBeNull();
    expect(() => callCeilingUsd(custom, 1_000, "text", 100)).toThrow(MissingAiPriceError);
  });
});
