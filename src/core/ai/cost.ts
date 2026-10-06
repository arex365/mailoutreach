/**
 * Milestone 5 (docs/dev/M5-DESIGN.md §3.3, §3.8; research ai-and-fetch A8): what one Claude call costs. Browser-safe,
 * pure. Prices are dollars per million tokens (Setting "ai.prices"); amounts are dollars rounded with roundUsd.
 */
import { roundUsd } from "@/core/money";
import type { AiModelPrices } from "@/core/setting-types";
import { estimateTextTokens, type ResolvedProfile } from "./types";

/** One answer's token counts, as the Anthropic client reports them (research A8). */
export type ClaudeUsage = {
  /** Input tokens after the last cache breakpoint (all of them without caching). */
  inputTokens: number;
  /** Output tokens, thinking included. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Part of outputTokens spent on thinking, when Anthropic reports it (never relied on). */
  thinkingTokens: number | null;
  /** Where the request ran; "us" costs 1.1 times the price (we never ask for it). */
  inferenceGeo: string | null;
};

/** Price multipliers relative to the base input price (pricing page, 2026-09-26). */
export const CACHE_WRITE_5M_FACTOR = 1.25;
export const CACHE_WRITE_1H_FACTOR = 2;
export const CACHE_READ_FACTOR = 0.1;
/** `inference_geo: "us"` on Claude 4.6+ models. */
export const US_INFERENCE_FACTOR = 1.1;

/** No price is saved for the model, so nothing about its cost can be computed (the job pauses with `no_price`). */
export class MissingAiPriceError extends Error {
  constructor(message = "No price is saved for this model.") {
    super(message);
    this.name = "MissingAiPriceError";
  }
}

/** A usage with nothing in it (a call that was never made). */
export function emptyUsage(): ClaudeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    thinkingTokens: null,
    inferenceGeo: null,
  };
}

function count(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The prices, or MissingAiPriceError when there are none or they aren't usable numbers. */
function checkedPrices(prices: AiModelPrices | null | undefined): AiModelPrices {
  if (
    !prices ||
    typeof prices.inputPerMTok !== "number" ||
    typeof prices.outputPerMTok !== "number" ||
    !Number.isFinite(prices.inputPerMTok) ||
    !Number.isFinite(prices.outputPerMTok) ||
    prices.inputPerMTok < 0 ||
    prices.outputPerMTok < 0
  ) {
    throw new MissingAiPriceError();
  }
  return prices;
}

/** Every input token the call was billed for: plain, cache reads and cache writes. */
export function totalInputTokens(usage: ClaudeUsage): number {
  return count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWrite5mTokens) + count(usage.cacheWrite1hTokens);
}

/**
 * Dollars for one answer (research A8): input at the input price, 5-minute cache writes at 1.25×, 1-hour writes at
 * 2×, cache reads at 0.1×, output at the output price, all × 1.1 when it ran with `inference_geo "us"`. Throws
 * MissingAiPriceError when `prices` is null.
 */
export function costUsd(usage: ClaudeUsage, prices: AiModelPrices | null): number {
  const p = checkedPrices(prices);
  const geo = usage.inferenceGeo === "us" ? US_INFERENCE_FACTOR : 1;
  const micros =
    count(usage.inputTokens) * p.inputPerMTok +
    count(usage.cacheWrite5mTokens) * p.inputPerMTok * CACHE_WRITE_5M_FACTOR +
    count(usage.cacheWrite1hTokens) * p.inputPerMTok * CACHE_WRITE_1H_FACTOR +
    count(usage.cacheReadTokens) * p.inputPerMTok * CACHE_READ_FACTOR +
    count(usage.outputTokens) * p.outputPerMTok;
  return roundUsd((geo * micros) / 1e6);
}

/** Rounds up to the next micro-dollar (a ceiling never understates; the epsilon keeps 0.0054 at 0.0054). */
function ceilUsd(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.ceil(v * 1e6 - 1e-6) / 1e6;
}

/**
 * The most one call can cost (M5-DESIGN §0.3 "Ceiling", §3.3): the system prompt's tokens plus the user message's
 * estimated tokens (estimateTextTokens × the model's tokenizer factor) at the input price, plus this call's
 * `max_tokens` at the output price. The spend guard reserves it before the call; a call that timed out is recorded at
 * it. Throws MissingAiPriceError when the profile has no prices.
 */
export function callCeilingUsd(profile: ResolvedProfile, systemTokens: number, userText: string, maxTokens: number): number {
  const p = checkedPrices(profile.prices);
  const factor = Number.isFinite(profile.tokenizerFactor) && profile.tokenizerFactor > 0 ? profile.tokenizerFactor : 1;
  const inputTokens = count(systemTokens) + Math.ceil(estimateTextTokens(userText ?? "") * factor);
  return ceilUsd((inputTokens * p.inputPerMTok + count(maxTokens) * p.outputPerMTok) / 1e6);
}
