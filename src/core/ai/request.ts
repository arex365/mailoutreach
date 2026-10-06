/**
 * Milestone 5 (docs/dev/M5-DESIGN.md §3.5.1, §3.5.3): the Messages API request for one company's line. Browser-safe,
 * pure, so an "economy mode" (Message Batches) could reuse it later.
 *
 * Per model profile: `max_tokens` from the profile, `output_config.effort` only when the profile has one (Sonnet 5,
 * or a custom model that supports low effort). Never `thinking`, `temperature`, `top_p`, `top_k`, prefill, tools or
 * `inference_geo`: the request is built field by field, so nothing else can slip in.
 */
import { buildUserMessage, SYSTEM_PROMPT, type LineMessageInput } from "./prompt";
import { LINE_SCHEMA, type ResolvedProfile } from "./types";

/** The body of `messages.create` for one line (and, without `max_tokens`, of `messages.countTokens`). */
export type LineRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: [{ role: "user"; content: string }];
  output_config: { format: { type: "json_schema"; schema: typeof LINE_SCHEMA }; effort?: "low" };
};

/** A usable `max_tokens`: a whole number of at least 1, else the profile's. */
function maxTokensOf(profile: ResolvedProfile, override: number | undefined): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 1) return Math.floor(override);
  return profile.maxTokens;
}

function outputConfig(profile: ResolvedProfile): LineRequest["output_config"] {
  return {
    format: { type: "json_schema", schema: LINE_SCHEMA },
    ...(profile.effort === "low" ? { effort: "low" as const } : {}),
  };
}

/**
 * The request for one company. `opts.maxTokens` replaces the profile's `max_tokens` (the retry after a `max_tokens`
 * stop sends `retryMaxTokens(…)`, M5-DESIGN §3.6).
 */
export function buildLineRequest(input: LineMessageInput, profile: ResolvedProfile, opts: { maxTokens?: number } = {}): LineRequest {
  return {
    model: profile.id,
    max_tokens: maxTokensOf(profile, opts.maxTokens),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input) }],
    output_config: outputConfig(profile),
  };
}

/** `max_tokens` for the one retry after an answer stopped at `max_tokens`: double what the stopped call had. */
export function retryMaxTokens(previousMaxTokens: number): number {
  return Math.max(1, Math.floor(previousMaxTokens)) * 2;
}

/**
 * What the worker measures with the free `messages.countTokens` once per model and prompt version (§3.5.4): the
 * system prompt, a user message with an empty <website_pages> block, and the schema.
 */
export function buildSystemTokenRequest(profile: ResolvedProfile): Omit<LineRequest, "max_tokens"> {
  return {
    model: profile.id,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage({ company: { name: "", country: null, niche: null }, pages: [] }) }],
    output_config: outputConfig(profile),
  };
}
