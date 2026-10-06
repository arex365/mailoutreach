/** Milestone 5 contract (docs/dev/M5-DESIGN.md §3): AI personal lines. Browser-safe, no I/O. */
import type { AiCustomModel, AiModelPrices, AiPrices } from "@/core/setting-types";

export type AiDraftStatusValue = "QUEUED" | "FETCHING" | "DRAFTING" | "READY" | "NO_LINE" | "FAILED" | "APPROVED" | "REJECTED";
export const IN_PROGRESS_STATUSES: readonly AiDraftStatusValue[] = ["QUEUED", "FETCHING", "DRAFTING"];

export const AI_QUEUE_TABS = ["waiting", "approved", "rejected", "no-line", "failed"] as const;
export type AiQueueTab = (typeof AI_QUEUE_TABS)[number];
export const AI_TAB_STATUS: Readonly<Record<AiQueueTab, AiDraftStatusValue>> = {
  waiting: "READY", approved: "APPROVED", rejected: "REJECTED", "no-line": "NO_LINE", failed: "FAILED",
};
export const AI_TAB_LABELS: Readonly<Record<AiQueueTab, string>> = {
  waiting: "Waiting", approved: "Approved", rejected: "Rejected", "no-line": "No line", failed: "Failed",
};

/** Claude's reasons for no line (the schema enum). */
export const REASON_CODES = ["too_little_text", "only_generic_claims", "not_the_company_site", "unrelated_business", "content_unreadable"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
/** Why a website gave no line before Claude was asked. */
export const SKIP_CODES = [
  "no_website", "social_only", "bad_url", "private_address", "blocked", "robots_disallowed", "unreachable", "not_found",
  "not_html", "redirect_loop", "too_many_redirects", "parked", "placeholder", "js_only", "thin",
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];
export type NoLineCode = ReasonCode | SkipCode | "model_declined";
export const NO_LINE_TEXT: Readonly<Record<NoLineCode, string>> = {
  too_little_text: "Not enough about their work on the website",
  only_generic_claims: "Only general claims on the website, nothing specific",
  not_the_company_site: "The website isn't the company's own",
  unrelated_business: "Their business doesn't seem related to making or selling products",
  content_unreadable: "The website text couldn't be read",
  model_declined: "Claude declined to write a line",
  no_website: "No website",
  social_only: "Only a social or marketplace link, no website",
  bad_url: "The website address isn't valid",
  private_address: "The website address points to a private network",
  blocked: "Website blocked automated reading",
  robots_disallowed: "The website asks robots not to read it",
  unreachable: "Website unreachable",
  not_found: "Website page not found",
  not_html: "Not a web page (PDF or image)",
  redirect_loop: "Website redirects in a loop",
  too_many_redirects: "Website redirects too many times",
  parked: "Domain is parked or for sale",
  placeholder: "Website is a placeholder (coming soon or under construction)",
  js_only: "Website needs JavaScript to show its content",
  thin: "Website has too little readable text",
};

export const EVIDENCE_SOURCES = ["homepage", "second_page", "none"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
/** The structured-output schema (output_config.format). Quote before line; no length keywords (unsupported). */
export const LINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["evidence_source", "evidence_quote", "line", "reason_if_null"],
  properties: {
    evidence_source: { type: "string", enum: [...EVIDENCE_SOURCES] },
    evidence_quote: { anyOf: [{ type: "string" }, { type: "null" }] },
    line: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason_if_null: { anyOf: [{ type: "string", enum: [...REASON_CODES] }, { type: "null" }] },
  },
} as const;
export type LineAnswer = { evidence_source: EvidenceSource; evidence_quote: string | null; line: string | null; reason_if_null: ReasonCode | null };

export type DraftFlagCode =
  | "quote-not-found" | "approximate-quote" | "quote-other-page" | "quote-size" | "number-not-found" | "name-not-found"
  | "too-long" | "too-short" | "not-one-sentence" | "plain-characters" | "banned-word" | "link" | "repeat"
  | "injection-hint" | "hidden-text" | "metadata-only" | "second-page-failed" | "cost-estimated" | "practice"
  /** A warning only (never a regeneration): the line could be said of almost any company (@/core/ai/checks). */
  | "generic-line";
export type DraftFlag = { code: DraftFlagCode; text: string };

// ── shapes shared by the AI services (P5) and the drafting job (P8) ──
/** A page as the job hands it to saveSnapshots (the reader's ReadPage satisfies it). */
export type ReadPageLike = {
  kind: "homepage" | "second_page"; url: string; finalUrl: string; httpStatus: number;
  contentType: string | null; bytes: number; title: string | null; lang: string | null;
  /** Exactly what Claude is sent (a metadata-only page: its metadata text). */
  text: string;
  notes: Array<"metadata-only" | "hidden-text">;
};
/** A stored snapshot, as reused by the job. */
export type SnapshotPage = ReadPageLike & { snapshotId: number; fetchedAt: string };
/** A draft claimed by the job (QUEUED → FETCHING, CAS). */
export type ClaimedDraft = {
  id: number; companyId: number; companyName: string; website: string; host: string;
  countryName: string | null; niche: string | null; companyDomain: string | null;
  refetch: boolean; avoidLines: string[]; readAttempts: number;
  /** The model actually used (current settings at claim time, §3.3). */
  model: string;
};
/** How a draft ends (tokens and cost are NOT here: recordCall writes them per call). */
export type DraftOutcome =
  | { status: "READY"; line: string; evidenceQuote: string; evidenceSource: "homepage" | "second_page"; evidenceUrl: string | null; flags: DraftFlag[]; homeSnapshotId: number | null; pageSnapshotId: number | null }
  | { status: "NO_LINE"; reasonIfNull: NoLineCode; flags: DraftFlag[]; homeSnapshotId: number | null; pageSnapshotId: number | null }
  | { status: "FAILED"; error: string; flags: DraftFlag[] };
/**
 * One Claude call's record (P5 recordCall). `estimated`: no answer came, the ceiling is recorded (flag cost-estimated).
 * `notBilled`: Claude refused the request with an error of its own (another 4xx); only its request id is kept, and it
 * doesn't count as a call, so the running token averages never include it (M5 review AI-8).
 */
export type CallRecord = {
  inputTokens: number; outputTokens: number; costUsd: number;
  requestId: string | null; stopReason: string | null; estimated: boolean;
  notBilled?: boolean;
};

/** A conservative local token estimate: 3 characters per token, and at least one token per non-ASCII character. */
export function estimateTextTokens(s: string): number {
  let nonAscii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++;
  return Math.max(Math.ceil(s.length / 3), nonAscii);
}

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-5";
export type ModelProfile = {
  id: string;
  label: string;
  maxTokens: number;
  effort: "low" | null;
  tokenizerFactor: number;
  defaultSystemTokens: number;
  defaultPageTokens: number;
  defaultOutputTokens: number;
  builtIn: boolean;
};
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  [HAIKU_MODEL]: { id: HAIKU_MODEL, label: "Claude Haiku 4.5", maxTokens: 600, effort: null, tokenizerFactor: 1,
    defaultSystemTokens: 1_400, defaultPageTokens: 2_500, defaultOutputTokens: 200, builtIn: true },
  [SONNET_MODEL]: { id: SONNET_MODEL, label: "Claude Sonnet 5", maxTokens: 2_000, effort: "low", tokenizerFactor: 1.3,
    defaultSystemTokens: 1_820, defaultPageTokens: 3_250, defaultOutputTokens: 700, builtIn: true },
};
export const DEFAULT_AI_PRICES: AiPrices = {
  [HAIKU_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 },
  [SONNET_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 },
};
export type ResolvedProfile = ModelProfile & { prices: AiModelPrices | null };
/** The profile for the chosen model: built-in, or the checked custom model (neutral: no thinking, effort only when supported). */
export function resolveProfile(model: string, custom: AiCustomModel | null, prices: AiPrices): ResolvedProfile {
  const builtIn = MODEL_PROFILES[model];
  const base: ModelProfile = builtIn ?? {
    id: model,
    label: custom?.id === model ? custom.label : model,
    maxTokens: custom?.id === model ? Math.min(4_000, custom.maxTokens) : 4_000,
    effort: custom?.id === model && custom.effortLow ? "low" : null,
    tokenizerFactor: 1.3,
    defaultSystemTokens: 1_820,
    defaultPageTokens: 3_250,
    defaultOutputTokens: 700,
    builtIn: false,
  };
  return { ...base, prices: prices[model] ?? DEFAULT_AI_PRICES[model] ?? null };
}

/** Job payload of "ai.draftLines". Never secrets. `aboutUsd`/`atMostUsd` are the server's own estimate at the start. */
export type AiRunPayload = {
  source: "contacts" | "list" | "panel" | "regenerate" | "retry";
  companyCount: number;
  aboutUsd: number;
  atMostUsd: number;
  /** The estimate's model; the job uses the current setting per claim (§3.3). "practice" in the practice copy. */
  model: string;
  listId?: number | null;
};
/** The drafting job's carry. */
export type AiRunCarry = { model: string | null; runCapUsd: number | null };

export const MAX_COMPANIES_PER_RUN = 1_000;
export const PAGE_TEXT_CAP = 6_000;
export const TOTAL_TEXT_CAP = 12_000;
/** All pages of one company together, by estimateTextTokens (§3.3). */
export const TOTAL_TOKEN_CAP = 4_000;
/** Every HTTP request for one company (robots, pages, redirect hops, retries, http fallback), §3.4.4. */
export const MAX_REQUESTS_PER_COMPANY = 8;
export const RUN_STOP_FACTOR = 1.25;
export const SNAPSHOT_REUSE_DAYS = 30;
export const PERSONAL_LINE_MAX_WORDS = 25;
export const UNDO_SECONDS = 10;
export const WEB_USER_AGENT = "Mozilla/5.0 (compatible; PolygonParadiseBot/1.0; +https://www.polygonparadise.com)";
export const ROBOTS_PRODUCT_TOKEN = "PolygonParadiseBot";
/** A robots.txt disallow for this token also skips the site: the text goes to Claude (§3.4.5). */
export const CLAUDE_USER_TOKEN = "Claude-User";
/** Price rows are validated to this range, dollars per million tokens (§3.11). */
export const AI_PRICE_MIN = 0.01;
export const AI_PRICE_MAX = 1_000;
