import { fromMailgun, unknownResultValue, unreadableResult } from "@/core/verification/mailgun-map";
import { FAKE_SERVER_PROVIDER } from "@/core/verification/types";
import { isLoopbackBase } from "../mailgun/base-url";
import { MailgunClient } from "../mailgun/client";
import { isMailgunError, type MailgunError } from "../mailgun/errors";
import type { MailgunRegion } from "../mailgun/types";
import { scrubProviderText } from "../secret-values";
import { VERIFY_FAILURE_TEXT } from "./failures";
import type { Verifier, VerifyFailureKind, VerifyOutcome } from "./verifier";

/**
 * Mailgun behind the address-check adapter (docs/dev/M5-DESIGN.md §2.2). One `check()` = one
 * GET /v4/address/validate with its own 30 s timeout and nothing else: the client never retries it and nothing from
 * outside aborts it, so an address is never paid for twice by accident (§0.2 rule 11). Mailgun's texts never leave
 * here unscrubbed: `detail` has the key and every address replaced (§0.2 rules 9 and 13).
 */

/** Each check's own timeout; never the job's shutdown signal. */
export const VERIFY_TIMEOUT_MS = 30_000;

export type MailgunVerifierOptions = {
  apiKey: string;
  region: MailgunRegion;
  /** Mailgun's host for the region, or the fake server (then the provider is "mailgun-fake"). */
  baseUrl: string;
  /** Dollars per answered check (Setting "verification.pricePerCheck"). */
  pricePerCheck: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** `result` values Mailgun sent that we don't know, logged once each per process (§2.3 "logged once per new value"). */
const loggedResults = new Set<string>();

function logUnknownResult(value: string): void {
  // A provider value, capped and without anything address-shaped: it goes to the log.
  const safe = value.replace(/[^\s@]{1,64}@[^\s@]{1,255}/g, "[address]").slice(0, 60);
  if (loggedResults.has(safe)) return;
  loggedResults.add(safe);
  console.warn(`[verification] Mailgun answered an address check with a result the app doesn't know ("${safe}"); stored as "couldn't be read".`);
}

/**
 * True when Mailgun had already answered with a 2xx status and only reading the body failed (the connection broke, or
 * the body stalled past the timeout). The validation was done, and billed, at that point.
 */
export function answeredBeforeFailing(err: MailgunError): boolean {
  return err.status !== null && err.status >= 200 && err.status < 300;
}

let loggedBroken = false;

function logBrokenAnswer(): void {
  if (loggedBroken) return;
  loggedBroken = true;
  console.warn(`[verification] Mailgun's answer to an address check broke off before it was complete; stored as "couldn't be read".`);
}

/** The failure kind for a Mailgun error (§2.2): every 400 is "rejected", whatever its text says. */
export function failureKindOf(err: MailgunError): VerifyFailureKind {
  // A 400 may echo the address ("disabled@…", "suspended-models.de"), which classifyStatus would read as not-allowed.
  if (err.status === 400) return "rejected";
  switch (err.kind) {
    case "rejected":
    case "conflict":
      return "rejected";
    case "rate-limited":
      return "rate-limited";
    case "auth":
    case "payment":
    case "not-allowed":
    case "business-verification":
    case "not-found":
      return err.kind;
    default:
      // timeout, network, server, unexpected (ambiguous or not: nothing we understand came back), guard.
      return "transient";
  }
}

/** A Mailgun verifier on a client of its own (validation is account-level: no sending domain needed, D35). */
export function createMailgunVerifier(opts: MailgunVerifierOptions): Verifier {
  const client = new MailgunClient({
    apiKey: opts.apiKey,
    region: opts.region,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  const now = opts.now ?? (() => Date.now());
  const provider = isLoopbackBase(client.baseUrl) ? FAKE_SERVER_PROVIDER : "mailgun";

  return {
    provider,
    pricePerCheck: opts.pricePerCheck,
    async check(email: string, emailNorm: string): Promise<VerifyOutcome> {
      const started = now();
      let body: unknown;
      try {
        body = await client.validateAddress(email);
      } catch (err) {
        if (!isMailgunError(err)) {
          return { ok: false, kind: "transient", retryAfterMs: null, timedOut: false, message: VERIFY_FAILURE_TEXT.transient, detail: null };
        }
        if (answeredBeforeFailing(err)) {
          // Mailgun answered 200 (so it billed the check) and the body broke off or stalled: an answer we can't
          // read, stored with its cost like any other (§2.3), never asked again at once (§0.2 rule 11).
          logBrokenAnswer();
          return { ok: true, result: unreadableResult(null), unreadable: true, ms: Math.max(0, now() - started) };
        }
        const kind = failureKindOf(err);
        // Mailgun's own text when it sent one, else the client's technical sentence (timeouts, network errors).
        const text = err.mailgunMessage || err.message;
        const detail = text ? await scrubProviderText(text, { address: email }) : null;
        return {
          ok: false,
          kind,
          retryAfterMs: kind === "rate-limited" ? err.retryAfterMs : null,
          timedOut: err.kind === "timeout",
          message: VERIFY_FAILURE_TEXT[kind],
          detail: detail || null,
        };
      }
      const ms = Math.max(0, now() - started);
      const mapped = fromMailgun(body, { emailNorm });
      if (mapped === "unreadable") {
        const unknownValue = unknownResultValue(body);
        if (unknownValue !== null) logUnknownResult(unknownValue);
        return { ok: true, result: unreadableResult(body), unreadable: true, ms };
      }
      return { ok: true, result: mapped, unreadable: false, ms };
    },
  };
}
