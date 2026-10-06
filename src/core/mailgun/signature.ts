// Server only: uses node:crypto (the webhook routes, the worker and the tests; never the browser).
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mailgun webhook signatures (research mailgun-api-reference §13.3, M3-DESIGN §4.1.6). Both webhook endpoints carry
 * `timestamp`, `token` and `signature`; the signature is the lowercase hex HMAC-SHA256 of `timestamp + token` (no
 * separator), keyed with the account's HTTP webhook signing key. The HMAC doesn't cover the body, so the stored
 * one-time token is what protects it against replays.
 */

/** Event webhooks older than this are refused (Mailgun retries for about 8 hours, reusing the original signature). */
export const EVENT_MAX_AGE_MS = 12 * 3_600_000;
/** Inbound (reply) notifications older than this are refused. */
export const INBOUND_MAX_AGE_MS = 24 * 3_600_000;
/** Allows a PC clock up to 1 hour slow (M3-DESIGN §9.2). */
export const MAX_FUTURE_MS = 3_600_000;

const HEX64 = /^[0-9a-f]{64}$/i;
const SECONDS = /^\d{9,11}$/;

/** The lowercase hex signature Mailgun would send. For tests and the fake Mailgun server. */
export function signMailgun(signingKey: string, timestamp: string, token: string): string {
  return createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
}

/**
 * True when `signature` is the HMAC of `timestamp + token` under `signingKey`, compared in constant time. Refuses
 * anything malformed first: an empty key, a token shorter than 20 characters, a timestamp that isn't 9–11 digits
 * (callers turn a numeric timestamp into a string with `String()`), or a signature that isn't 64 hex characters.
 */
export function verifyMailgunSignature(signingKey: string, timestamp: string, token: string, signature: string): boolean {
  if (typeof signingKey !== "string" || signingKey.length === 0) return false;
  if (typeof timestamp !== "string" || !SECONDS.test(timestamp)) return false;
  if (typeof token !== "string" || token.length < 20) return false;
  if (typeof signature !== "string" || !HEX64.test(signature)) return false;
  const expected = createHmac("sha256", signingKey).update(timestamp + token).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * How fresh a webhook timestamp (epoch seconds, as a string; a decimal fraction is allowed) is at `now`:
 * "fresh" when it is at most `maxAgeMs` old and at most `maxFutureMs` ahead; "stale" when older; "future" when
 * further ahead; "invalid" when it isn't a number of seconds.
 */
export function checkTimestamp(
  timestamp: string,
  now: Date,
  maxAgeMs: number,
  maxFutureMs: number = MAX_FUTURE_MS,
): "fresh" | "stale" | "future" | "invalid" {
  if (typeof timestamp !== "string" || !/^\d{9,11}(\.\d+)?$/.test(timestamp)) return "invalid";
  const ms = Number(timestamp) * 1000;
  if (!Number.isFinite(ms)) return "invalid";
  const age = now.getTime() - ms;
  if (age > maxAgeMs) return "stale";
  if (-age > maxFutureMs) return "future";
  return "fresh";
}
