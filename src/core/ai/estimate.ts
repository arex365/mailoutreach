/**
 * The cost math of AI drafting (docs/dev/M5-DESIGN.md §3.3): "about" and "at most" per company and per run, the ceiling
 * of one Claude call, the running token averages and the monthly-limit sentence. Pure and browser-safe (the Settings ›
 * AI radios and the start dialog show these amounts); the database side is src/server/services/ai/estimate.ts.
 *
 *   perAbout = ((systemTokens + avgPageTokens) × inputPrice + avgOutputTokens × outputPrice) / 1e6 × 1.15
 *   perMax   = ((systemTokens + maxPageTokens) × inputPrice + maxOutputTokens × outputPrice) / 1e6 × 1.25
 *   aboutUsd = n × perAbout;  atMostUsd = n × perMax
 *
 * `maxPageTokens` = TOTAL_TOKEN_CAP × the profile's tokenizer factor, `maxOutputTokens` = the profile's `max_tokens`.
 * With the profile defaults this is about $1.69 / at most $3.15 per 300 companies with Claude Haiku 4.5 and about
 * $5.91 / at most $12.77 with Claude Sonnet 5.
 */
import { formatUsd, roundUsd } from "@/core/money";
import { PROMPT_VERSION } from "@/core/ai/prompt";
import { retryMaxTokens } from "@/core/ai/request";
import { TOTAL_TOKEN_CAP, type ModelProfile, type ResolvedProfile } from "@/core/ai/types";

/**
 * The prompt version new drafts are written with and measured tokens are keyed by ("<model>|<version>", §3.5.4):
 * the prompt's own PROMPT_VERSION (@/core/ai/prompt.ts), so a new prompt text starts new token measurements.
 */
export const DRAFT_PROMPT_VERSION: string = PROMPT_VERSION;

/** "about": one company's average cost plus an allowance for the regenerations the automatic checks cause. */
export const ABOUT_FACTOR = 1.15;
/** "at most": one call at the page cap and `max_tokens`, plus 25 % (PLAN B6.12; the run stops at 125 % of it). */
export const MAX_FACTOR = 1.25;
/** Running averages use this many of the model's most recent drafted drafts… */
export const AVERAGE_WINDOW = 50;
/** …and only once there are at least this many (the profile defaults before). */
export const AVERAGE_MIN_DRAFTS = 10;

/** The SystemState "ai.tokens" key of one model and prompt version. */
export function aiTokenKey(model: string, promptVersion: string = DRAFT_PROMPT_VERSION): string {
  return `${model}|${promptVersion}`;
}

/** The most page text one company can send, in the model's own tokens (the reader cuts pages at TOTAL_TOKEN_CAP). */
export function maxPageTokens(profile: Pick<ModelProfile, "tokenizerFactor">): number {
  return Math.round(TOTAL_TOKEN_CAP * profile.tokenizerFactor);
}

/**
 * The most one Claude call can cost (the "ceiling" of §0.3) at the page cap and the profile's `max_tokens`, without the
 * 25 % margin: used for a stuck draft's estimated cost (resetStuckDrafts) and for the drafting job's cap rescale.
 * 0 when the model has no price (no call is ever made without one, §3.3).
 */
export function perCallMaxUsd(profile: ResolvedProfile, systemTokens: number): number {
  if (!profile.prices) return 0;
  const input = (Math.max(0, systemTokens) + maxPageTokens(profile)) * profile.prices.inputPerMTok;
  const output = profile.maxTokens * profile.prices.outputPerMTok;
  return (input + output) / 1e6;
}

/**
 * Room in one call's estimate for everything in the user message besides the page text (estimated tokens, before the
 * tokenizer factor): the company, the pages' addresses and titles, the JSON around them, up to five avoid lines of 300
 * characters (a regeneration), the previous problem and the task sentence.
 */
export const MESSAGE_ALLOWANCE_TOKENS = 1_500;

/**
 * The most Claude calls one company's drafting makes (src/server/ai/drafter.ts): the first call and the regeneration
 * (§3.6), one retry after a `max_tokens` stop, and one more try after a call that brought no answer (a timeout).
 */
export const DRAFTER_MAX_CALLS = 4;

/** The most one call can cost at the page cap plus the message allowance, with this call's `max_tokens` (0 without a price). */
export function callMaxUsd(profile: ResolvedProfile, systemTokens: number, maxTokens: number): number {
  if (!profile.prices) return 0;
  const messageTokens = Math.ceil((TOTAL_TOKEN_CAP + MESSAGE_ALLOWANCE_TOKENS) * profile.tokenizerFactor);
  const input = (Math.max(0, systemTokens) + messageTokens) * profile.prices.inputPerMTok;
  const output = Math.max(0, maxTokens) * profile.prices.outputPerMTok;
  return (input + output) / 1e6;
}

/**
 * The most one company's drafting can cost: the first call at the profile's `max_tokens`, then the other calls the
 * drafter may make (DRAFTER_MAX_CALLS) at the doubled `max_tokens` of the retry after a `max_tokens` stop, each at the
 * page cap plus the message allowance. A run's cost cap is never below this, so a one-company run (the panel,
 * Regenerate, Try again) can always afford the regeneration the drafter promises (M5 review AI-3); the monthly limit
 * stays the hard stop. 0 when the model has no price.
 */
export function companyWorstCaseUsd(profile: ResolvedProfile, systemTokens: number): number {
  if (!profile.prices) return 0;
  const first = callMaxUsd(profile, systemTokens, profile.maxTokens);
  const later = callMaxUsd(profile, systemTokens, retryMaxTokens(profile.maxTokens));
  return first + (DRAFTER_MAX_CALLS - 1) * later;
}

/** What the estimate is built from, in the model's own tokens. */
export type EstimateTokens = { systemTokens: number; avgPageTokens: number; avgOutputTokens: number };

/** One company's "about" and "at most" in dollars (unrounded), or null when the model has no price. */
export type CompanyCost = { aboutUsd: number; maxUsd: number };

export function perCompanyUsd(profile: ResolvedProfile, t: EstimateTokens): CompanyCost | null {
  if (!profile.prices) return null;
  const { inputPerMTok, outputPerMTok } = profile.prices;
  const about =
    ((Math.max(0, t.systemTokens) + Math.max(0, t.avgPageTokens)) * inputPerMTok + Math.max(0, t.avgOutputTokens) * outputPerMTok) /
    1e6;
  return { aboutUsd: about * ABOUT_FACTOR, maxUsd: perCallMaxUsd(profile, t.systemTokens) * MAX_FACTOR };
}

/** A run of `count` companies, rounded to 6 decimals (§0.2 rule 10). */
export function runCostUsd(count: number, perCompany: CompanyCost | null): { aboutUsd: number; atMostUsd: number } {
  const n = Math.max(0, Math.floor(count));
  if (!perCompany || n === 0) return { aboutUsd: 0, atMostUsd: 0 };
  return { aboutUsd: roundUsd(n * perCompany.aboutUsd), atMostUsd: roundUsd(n * perCompany.maxUsd) };
}

/** One drafted draft's sums (tokens and calls are totals over its Claude calls, as recordCall writes them). */
export type TokenSample = { inputTokens: number; outputTokens: number; calls: number };
export type CallAverages = { pageTokens: number; outputTokens: number; drafts: number };

/**
 * Running averages per Claude call over the newest drafted drafts (newest first; at most AVERAGE_WINDOW are used):
 * page tokens = input tokens minus the system prompt's, output tokens as billed. A draft with no input tokens was never
 * billed (only error answers, recorded before they stopped counting as calls) and is left out, so failures can't pull
 * the "about" figure down (M5 review AI-8). Null below AVERAGE_MIN_DRAFTS usable drafts, so the profile defaults apply
 * until the app has measured enough.
 */
export function averageCallTokens(samples: readonly TokenSample[], systemTokens: number): CallAverages | null {
  const usable = samples
    .filter(
      (s) =>
        Number.isInteger(s.calls) &&
        s.calls > 0 &&
        Number.isFinite(s.inputTokens) &&
        Number.isFinite(s.outputTokens) &&
        s.inputTokens > 0 &&
        s.outputTokens >= 0,
    )
    .slice(0, AVERAGE_WINDOW);
  if (usable.length < AVERAGE_MIN_DRAFTS) return null;
  let calls = 0;
  let page = 0;
  let output = 0;
  for (const s of usable) {
    calls += s.calls;
    page += Math.max(0, s.inputTokens - Math.max(0, systemTokens) * s.calls);
    output += s.outputTokens;
  }
  return { pageTokens: page / calls, outputTokens: output / calls, drafts: usable.length };
}

/** A dollar limit as people typed it: "$20", "$1,000", "$12.50". */
export function limitUsdText(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  return Number.isInteger(v) ? `$${v.toLocaleString("en-US")}` : formatUsd(v);
}

/**
 * The A6 sentence for a reached monthly limit (the start dialog's error, a refused start and the monthly_limit pause):
 * "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November."
 */
export function monthlyLimitText(limitUsd: number, resetLabel: string): string {
  return `AI drafting stopped: this month's limit of ${limitUsdText(limitUsd)} is reached. Raise it in Settings › AI or wait until ${resetLabel}.`;
}
