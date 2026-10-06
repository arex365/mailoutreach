import { formatTime } from "@/core/time/format";
import { PLAN_TEXTS } from "@/core/mailgun/plan";
import { FALLBACK_CAP_ZONE, safeZone } from "@/core/sending/capday";
import { redactText } from "../jobs";
import type { MailgunErrorKind, MailgunRegion } from "./types";

/**
 * Mailgun errors (M3-DESIGN §4.2.2). Every failure of the client is a MailgunError with a `kind` the callers switch on;
 * the owner-facing sentence comes from plainMailgunError (§5.9), Mailgun's own text stays behind "Details".
 *
 * Secrets: a MailgunError never stores request headers or the request body. Its message, mailgunMessage and
 * bodySnippet pass through redactText with the key in use and its Basic-auth form base64("api:" + key), so neither
 * JSON.stringify(err) nor err.stack can carry a key.
 */

export type MailgunErrorInit = {
  kind: MailgunErrorKind;
  /** Technical sentence for logs and "Details" (redacted). */
  message: string;
  status?: number | null;
  /** Mailgun's own error text (errorText of the body), or our own sentence for errors raised before any request. */
  mailgunMessage?: string;
  retryAfterMs?: number | null;
  /** The raw response body; kept as a short, redacted snippet. */
  body?: string;
  /** "METHOD /path" of the call, for logs. */
  endpoint?: string;
  /** false when nothing left this PC (guard, bad input, refused target). Default true. */
  requestStarted?: boolean;
  /** Values to hide (the key and its Basic-auth form). */
  secrets?: readonly string[];
};

/** At most this many characters of a response body are kept on an error (redactText caps at 1,000). */
export const BODY_SNIPPET_MAX = 1000;

const AMBIGUOUS_KINDS: ReadonlySet<MailgunErrorKind> = new Set(["timeout", "network", "server", "unexpected"]);

export class MailgunError extends Error {
  readonly kind: MailgunErrorKind;
  readonly status: number | null;
  readonly mailgunMessage: string;
  readonly retryAfterMs: number | null;
  /** ≤ 1,000 characters of the response body, redacted. */
  readonly bodySnippet: string;
  readonly endpoint: string;
  /** false when the error was raised before fetch() was called (guard, bad input): nothing left this PC. */
  readonly requestStarted: boolean;

  constructor(init: MailgunErrorInit) {
    const secrets = [...(init.secrets ?? [])];
    super(redactText(init.message, secrets));
    this.name = "MailgunError";
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.mailgunMessage = redactText(init.mailgunMessage ?? "", secrets);
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.bodySnippet = init.body ? redactText(init.body, secrets).slice(0, BODY_SNIPPET_MAX) : "";
    this.endpoint = init.endpoint ?? "";
    this.requestStarted = init.requestStarted ?? true;
  }

  /**
   * A send may have been accepted: timeout, network error, abort, 5xx, a 3xx (redirects are errors), or a 2xx without
   * a readable id. Never true for a 4xx response (Mailgun answered "no") or when requestStarted is false. A 5xx or 3xx
   * answer is ambiguous whatever its kind: only a 4xx is a definite "no" (research: the text rules apply to 4xx bodies).
   */
  get ambiguous(): boolean {
    if (!this.requestStarted) return false;
    if (this.status !== null && this.status >= 400 && this.status < 500) return false;
    if (this.status !== null && (this.status >= 500 || (this.status >= 300 && this.status < 400))) return true;
    return AMBIGUOUS_KINDS.has(this.kind);
  }

  /** What JSON.stringify shows: every field above, nothing else. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      status: this.status,
      message: this.message,
      mailgunMessage: this.mailgunMessage,
      retryAfterMs: this.retryAfterMs,
      bodySnippet: this.bodySnippet,
      endpoint: this.endpoint,
      requestStarted: this.requestStarted,
      ambiguous: this.ambiguous,
    };
  }
}

export function isMailgunError(err: unknown): err is MailgunError {
  return err instanceof MailgunError;
}

/**
 * Mailgun's error bodies come in six shapes (research §0.4, verification-reference §0.8): `{message}`, plain text,
 * `{Reason}`, `{Description}`, `{Error}` (mailgun-php reads it on 403s) and `{Field}`. Returns the readable text:
 * message ?? Reason ?? Description ?? Error ?? "invalid field <Field>" ?? the text.
 */
export function errorText(body: string): string {
  const text = (body ?? "").trim();
  if (!text) return "";
  try {
    const j: unknown = JSON.parse(text);
    if (typeof j === "string") return j.trim();
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const o = j as Record<string, unknown>;
      for (const k of ["message", "Reason", "Description", "Error"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      if (typeof o.Field === "string" && o.Field.trim()) return `invalid field ${o.Field.trim()}`;
    }
  } catch {
    // not JSON: plain text such as "Forbidden"
  }
  return text.slice(0, 500);
}

/**
 * A send refusal that says the plan's sending limit is reached (MAIN-DOMAIN-DESIGN O24, §2.8): "daily sending limit",
 * "sending quota", "message limit", "plan limit", "quota", "100 messages per day"… The last form catches "Free accounts
 * are limited to 100 messages per day", which has no "limit" word.
 */
const SEND_LIMIT_TEXT =
  /\b(daily|sending|messages?|account|plan)\s+(sending\s+)?(limit|quota)\b|\bquota\b|\b(emails|messages)\s+(per|a)\s+day\b/i;
/** Limits that are about one message, never the plan (size, attachments, recipients per message): stay "rejected". */
const MESSAGE_SIZE_TEXT = /\bsize\b|too large|attachment|recipients?\s+per\s+message/i;

/**
 * 429 → rate-limited (checked first: its text also says "is not allowed to send"). A 5xx is "server" and anything
 * below 400 "unexpected" (the client never classifies successes), whatever the text says: only a 4xx is a definite
 * "no", and a 5xx or a proxy page may hide an email Mailgun already accepted (a maintenance page saying "disabled"
 * must never release the email to be sent again). Then, on any other 4xx, 400 included: /business verification/i →
 * business-verification; /is not allowed to send|disabled|suspended/i → not-allowed. Then 401/403 auth; 402 payment;
 * 404 not-found; 409 conflict; other 4xx rejected.
 *
 * MAIN-DOMAIN-DESIGN O24: only with `opts.send === true` (set by `MailgunClient.sendMessage` alone), a 400 or 403 whose
 * text says the plan's sending limit is reached (SEND_LIMIT_TEXT, and not MESSAGE_SIZE_TEXT) is "limit", checked after
 * business verification and before "not allowed". Without `send` (every other endpoint) and for every other status the
 * kinds are exactly as before.
 */
export function classifyStatus(status: number, text: string, opts: { send?: boolean } = {}): MailgunErrorKind {
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  if (status < 400) return "unexpected";
  if (/business verification/i.test(text)) return "business-verification";
  if (opts.send === true && (status === 400 || status === 403) && SEND_LIMIT_TEXT.test(text) && !MESSAGE_SIZE_TEXT.test(text)) {
    return "limit";
  }
  if (/is not allowed to send|disabled|suspended/i.test(text)) return "not-allowed";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  return "rejected";
}

export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 15 * 60_000;
export const RETRY_AFTER_DEFAULT_MS = 60_000;

/**
 * How long Mailgun asked us to wait after a 429, or null when it didn't say (research §0.6): `X-RateLimit-Reset` above
 * 10^12 is an absolute epoch in ms, a smaller number is a delay in ms; otherwise "try again after N seconds" in the
 * message. Clamped 1 s–15 min. The address checks use this (M5-DESIGN §2.5.1: no hint → their own back-off).
 */
export function retryAfterHintMs(headers: Headers, message: string, now: Date): number | null {
  let ms: number | null = null;
  const raw = headers.get("x-ratelimit-reset");
  if (raw !== null && raw.trim() !== "") {
    const v = Number(raw.trim());
    if (Number.isFinite(v)) ms = v > 1e12 ? v - now.getTime() : v;
  }
  if (ms === null) {
    const m = /try again after (\d+) seconds?/i.exec(message);
    if (m) ms = Number(m[1]) * 1000;
  }
  if (ms === null) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(ms)));
}

/**
 * How long to wait after a 429 (research §0.6): `retryAfterHintMs`, or 60 s when Mailgun gave no hint. Clamped
 * 1 s–15 min.
 */
export function retryAfterMs(headers: Headers, message: string, now: Date): number {
  return retryAfterHintMs(headers, message, now) ?? RETRY_AFTER_DEFAULT_MS;
}

export const AUTH_TEXT =
  "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here.";
export const BUSINESS_VERIFICATION_TEXT =
  "Mailgun is holding your account until business verification is finished. Complete the form in the banner at the top of Mailgun, then click Resume.";
export const TIMEOUT_TEXT = "Mailgun didn't answer in time.";
export const NETWORK_TEXT = "Couldn't reach Mailgun. Check this PC's internet connection and try again.";
export const SERVER_TEXT = "Mailgun had a problem on its side. Try again in a few minutes.";
export const REFUSED_TEXT = "Mailgun refused this.";
/** Kind "sender" (SHARED-FROM-DESIGN §2.4): the client's own sender check refused the email before any request. */
export const SENDER_TEXT =
  "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then try again.";

/**
 * MAIN-DOMAIN-DESIGN O25: a "not allowed to send" refusal because a free account may only send to authorized recipients
 * (Mailgun's text names "authorized recipients" or says "Free accounts are for test purposes"). For `plainMailgunError`,
 * `mailgunFailure` (campaign emails: PLAN_TEXTS.authorizedOnlyCampaign) and test sends (PLAN_TEXTS.authorizedOnlyTest).
 */
export function isAuthorizedOnlyRefusal(text: string): boolean {
  return /authori[sz]ed recipients|free accounts are for test purposes/i.test(text ?? "");
}

/** "Mailgun can't find d in the EU region. If you created the domain in the US region, change Region to US." */
export function wrongRegionText(domain: string, region: MailgunRegion): string {
  const other: MailgunRegion = region === "EU" ? "US" : "EU";
  return `Mailgun can't find ${domain} in the ${region} region. If you created the domain in the ${other} region, change Region to ${other}.`;
}

/**
 * The owner's wording for a Mailgun error (§5.9), used everywhere a Mailgun failure is shown. Mailgun's own text and
 * the status code stay behind "Details" (err.mailgunMessage / err.message).
 * `now` and `timeZone` (default Asia/Karachi, the cap-day zone) are only used for "trying again at 14:05".
 */
export function plainMailgunError(
  err: MailgunError,
  ctx: { domain?: string; region?: MailgunRegion; now?: Date; timeZone?: string } = {},
): string {
  const domain = ctx.domain || "your sending domain";
  switch (err.kind) {
    case "guard":
      return err.message;
    case "sender":
      return SENDER_TEXT;
    case "auth":
      // Raised before any request (a test key on real Mailgun, or the other way round): our own sentence.
      return err.requestStarted ? AUTH_TEXT : err.message;
    case "business-verification":
      return BUSINESS_VERIFICATION_TEXT;
    case "not-allowed":
      // MAIN-DOMAIN-DESIGN O25 (every mode): without context the campaign sentence, which never suggests authorizing a
      // prospect's address.
      if (isAuthorizedOnlyRefusal(err.mailgunMessage) || isAuthorizedOnlyRefusal(err.message)) return PLAN_TEXTS.authorizedOnlyCampaign;
      return `Mailgun won't send from ${domain} right now. Check the banner in Mailgun, then click Resume.`;
    case "limit":
      // MAIN-DOMAIN-DESIGN O24: only ever raised for a send.
      return PLAN_TEXTS.limitRefused;
    case "rate-limited": {
      if (err.retryAfterMs !== null) {
        const at = new Date((ctx.now ?? new Date()).getTime() + err.retryAfterMs);
        const time = formatTime(at, safeZone(ctx.timeZone, FALLBACK_CAP_ZONE));
        return `Mailgun asked us to slow down; trying again at ${time}.`;
      }
      return "Mailgun asked us to slow down; the app will try again in a moment.";
    }
    case "timeout":
      return TIMEOUT_TEXT;
    case "network":
      return NETWORK_TEXT;
    case "server":
      return SERVER_TEXT;
    case "not-found":
      // A 404 on a domain endpoint almost always means the domain lives in the other region (research §0.8).
      if (ctx.domain && ctx.region && !/route|message|webhook|address|x509|cert/i.test(err.mailgunMessage)) {
        return wrongRegionText(ctx.domain, ctx.region);
      }
      return REFUSED_TEXT;
    case "unexpected":
      if (!err.requestStarted) return err.message;
      return err.ambiguous ? "Mailgun's answer couldn't be read. Try again in a few minutes." : REFUSED_TEXT;
    default:
      return REFUSED_TEXT;
  }
}
