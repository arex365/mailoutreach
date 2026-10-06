import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { formatUsd } from "@/core/money";
import { FALLBACK_CAP_ZONE, safeZone } from "@/core/sending/capday";
import type { AiPauseKind } from "@/core/system-state";
import { monthBounds } from "@/core/time/month";
import { redactText } from "../jobs";
import { ClaudeTargetError } from "./base-url";

/**
 * What a failed Claude call means for the drafting job (M5-DESIGN §3.5.2, §3.7; research ai-and-fetch A7), and the
 * Owner's pause sentences. The job decides every retry: the client never retries a paid call itself.
 */
export type AiFailure =
  /** Needs the Owner (or Anthropic's reset): pause the AI queue. */
  | { kind: "pause"; reason: Exclude<AiPauseKind, "monthly_limit" | "no_price"> }
  /** An ordinary 429 with retry-after (at most 300 s): put the draft back and wait. */
  | { kind: "requeue"; afterMs: number }
  /**
   * Anthropic or the network had a problem (5xx, 529, connection errors: `mayBeBilled` false), or the request left and
   * no answer came (a timeout or an abort after sending, an unreadable 200: `mayBeBilled` true, so the call is
   * recorded at its ceiling).
   */
  | { kind: "backoff"; mayBeBilled: boolean }
  /** Anything else (other 4xx): this company only. `message` is scrubbed; it goes to the worker log, never to people. */
  | { kind: "fail_draft"; message: string };

/**
 * A 200 whose body couldn't be read (it broke off, stalled past the call's timeout, wasn't JSON) or wasn't a Messages
 * answer. The request was answered, so it may have been billed: the job records it at its ceiling. `requestId` is the
 * answer's `request-id` header when it came.
 */
export class UnreadableAnswerError extends Error {
  readonly requestId: string | null;

  constructor(message = "Anthropic's answer couldn't be read.", requestId: string | null = null) {
    super(message);
    this.name = "UnreadableAnswerError";
    this.requestId = requestId;
  }
}

/** Longest retry-after the job waits for by requeueing (longer ones wait 300 s and ask again). */
export const MAX_REQUEUE_SECONDS = 300;
/** Longest provider text kept (M5-DESIGN §0.2 rule 13). */
const MAX_PROVIDER_TEXT = 300;
/** Anything shaped like an email address (M5-DESIGN §0.2 rule 13). */
const ADDRESS_LIKE = /[^\s@]{1,64}@[^\s@]{1,255}/g;

/**
 * The default scrubber for Anthropic's texts when the caller passes none: redactText (every sk-ant- key, "api_key=…"
 * forms), anything shaped like an address as "[address]", at most 300 characters. The drafting job passes P4's
 * scrubProviderText, which also hides every saved secret.
 */
export function scrubAnthropicText(text: string): string {
  return redactText(String(text ?? ""))
    .replace(ADDRESS_LIKE, "[address]")
    .slice(0, MAX_PROVIDER_TEXT);
}

type ErrorBody = { error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } | null } | null } | null;

function bodyOf(err: APIError): ErrorBody {
  const b = err.error as ErrorBody | undefined;
  return b && typeof b === "object" ? b : null;
}

/** The API's own message ("model: claude-x", "You have reached your specified API usage limits…"). */
function apiMessage(err: APIError): string {
  const m = bodyOf(err)?.error?.message;
  return typeof m === "string" && m ? m : err.message;
}

/** Seconds from a retry-after header (seconds or an HTTP date); null when missing or unreadable. */
function retryAfterSeconds(headers: Headers | undefined, now: number): number | null {
  const raw = headers?.get("retry-after");
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, (at - now) / 1000) : null;
}

/** A DOM-style abort or timeout (a signal fired while the request was out). */
function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

/**
 * Classifies anything a Claude call threw (research A7): connection errors first (they are APIErrors too), then the
 * status. The two message tests (the Owner's own Console limit, a credit balance) are the documented exceptions to
 * "classify by type". `opts.scrub` cleans `fail_draft.message` (default scrubAnthropicText); `opts.now` reads an
 * HTTP-date retry-after.
 */
export function classifyAnthropicError(err: unknown, opts: { scrub?: (s: string) => string; now?: Date } = {}): AiFailure {
  const scrub = opts.scrub ?? scrubAnthropicText;
  if (err instanceof APIConnectionTimeoutError) return { kind: "backoff", mayBeBilled: true };
  if (err instanceof APIUserAbortError) return { kind: "backoff", mayBeBilled: true };
  if (err instanceof APIConnectionError) return { kind: "backoff", mayBeBilled: false };
  if (err instanceof UnreadableAnswerError) return { kind: "backoff", mayBeBilled: true };
  if (err instanceof ClaudeTargetError) return { kind: "pause", reason: "key_rejected" };
  if (isAbortLike(err)) return { kind: "backoff", mayBeBilled: true };
  if (!(err instanceof APIError)) {
    return { kind: "fail_draft", message: scrub(err instanceof Error ? err.message : String(err)) };
  }

  const status = err.status;
  const body = bodyOf(err);
  const msg = apiMessage(err);
  if (status === undefined) return { kind: "backoff", mayBeBilled: false };
  if (status === 401) return { kind: "pause", reason: "key_rejected" };
  if (status === 403) return { kind: "pause", reason: "no_permission" };
  if (status === 404) return { kind: "pause", reason: "model_not_found" };
  if (status === 402 || err.type === "billing_error" || body?.error?.type === "billing_error") {
    return { kind: "pause", reason: "billing" };
  }
  if (status === 429) {
    const ra = retryAfterSeconds(err.headers, (opts.now ?? new Date()).getTime());
    if (body?.error?.details?.error_code === "enforced_spend_limit_reached" || ra === null) {
      return { kind: "pause", reason: "tier_spend_cap" };
    }
    return { kind: "requeue", afterMs: Math.round(Math.min(ra, MAX_REQUEUE_SECONDS) * 1000) };
  }
  if (status >= 500) return { kind: "backoff", mayBeBilled: false };
  // Request timeout and lock timeout: temporary, like the SDK's own retry list (never billed).
  if (status === 408 || status === 409) return { kind: "backoff", mayBeBilled: false };
  if (status === 400 && /^You have reached your specified/i.test(msg)) return { kind: "pause", reason: "own_spend_limit" };
  if (status === 400 && /credit balance/i.test(msg)) return { kind: "pause", reason: "billing" };
  return { kind: "fail_draft", message: scrub(msg) };
}

/**
 * The request id of a failed call (the `request-id` header, else the error body's `request_id`; for an answer whose
 * body couldn't be read, its header), for the worker log and the Failed card's Details; null when the request never
 * got an answer.
 */
export function requestIdOfError(err: unknown): string | null {
  if (err instanceof UnreadableAnswerError) return err.requestId;
  if (!(err instanceof APIError)) return null;
  if (typeof err.requestID === "string" && err.requestID) return err.requestID;
  const fromBody = (err.error as { request_id?: unknown } | undefined)?.request_id;
  return typeof fromBody === "string" && fromBody ? fromBody : null;
}

/** When Anthropic's own monthly spend cap lifts: 00:00 UTC on the first day of the next month (the job adds 5 min). */
export function tierCapResetAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** "$20" for a whole-dollar limit, "$12.50" otherwise (formatUsd without ".00"). */
function limitText(usd: number): string {
  return formatUsd(usd).replace(/\.00$/, "");
}

/** "1 November at 05:00" in the zone. */
function dayAndTime(at: Date, timeZone: string): string {
  const zone = safeZone(timeZone, FALLBACK_CAP_ZONE);
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: zone }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(at);
  return `${day} at ${time}`;
}

/**
 * The Owner's pause sentence for each kind (M5-DESIGN §3.7, A6 wording). `model` is the model id the pause is about;
 * `limitUsd` the monthly limit; `resetLabel` when drafting starts again ("1 November" for the monthly limit; for the
 * tier cap the whole "1 November at 05:00"), otherwise worked out from `now` in `timeZone` (the office zone for the
 * monthly limit, the Owner's zone for the tier cap).
 */
export function aiPauseText(
  kind: AiPauseKind,
  ctx: { model: string; limitUsd?: number; resetLabel?: string; timeZone?: string; now?: Date },
): string {
  const now = ctx.now ?? new Date();
  const zone = ctx.timeZone ?? FALLBACK_CAP_ZONE;
  switch (kind) {
    case "monthly_limit": {
      const reset = ctx.resetLabel ?? monthBounds(now, zone).resetLabel;
      const limit = typeof ctx.limitUsd === "number" && Number.isFinite(ctx.limitUsd) ? ` of ${limitText(ctx.limitUsd)}` : "";
      return `AI drafting stopped: this month's limit${limit} is reached. Raise it in Settings › AI or wait until ${reset}.`;
    }
    case "key_rejected":
      return "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.";
    case "no_permission":
      return "AI drafting paused: this Anthropic key isn't allowed to use Claude. Check the key in the Anthropic Console, then click Resume drafting.";
    case "model_not_found":
      return `AI drafting paused: Anthropic doesn't know the model “${ctx.model}”, or your account can't use it. Pick another model in Settings › AI.`;
    case "tier_spend_cap": {
      const when = ctx.resetLabel ?? dayAndTime(tierCapResetAt(now), zone);
      return `AI drafting paused: your Anthropic account reached its monthly spending cap. Drafting starts again on ${when}, or raise the cap in the Anthropic Console.`;
    }
    case "own_spend_limit":
      return "AI drafting paused: the spending limit you set in the Anthropic Console is reached. Raise it there, then click Resume drafting.";
    case "billing":
      return "AI drafting paused: Anthropic refused the request for a billing reason. Check Billing in the Anthropic Console, then click Resume drafting.";
    case "no_price":
      return `AI drafting paused: no price is saved for the model “${ctx.model}”. Enter its prices in Settings › AI.`;
  }
}
