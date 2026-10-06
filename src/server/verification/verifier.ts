import type { CheckResult } from "@/core/verification/types";
import { assertKeyMatchesTarget, mailgunApiBase } from "../mailgun/base-url";
import { NOT_CONNECTED_TEXT } from "../mailgun/context";
import { getSecret, type SecretKey } from "../secrets";
import { getSettings } from "../settings";
import { practiceChecker } from "./fake-verifier";
import { createMailgunVerifier, VERIFY_TIMEOUT_MS } from "./mailgun-verifier";

/**
 * The address-check adapter (PLAN B6.9, docs/dev/M5-DESIGN.md §2.2): one interface in front of whoever checks an
 * address, so the check job never knows which provider answers. Mailgun is the only real one in Milestone 5; the
 * practice copy and unit tests use the in-process test checker, which never touches the network and never counts
 * for real sending (provider "fake").
 *
 * A failed call is never a verdict: nothing is stored on the person, and the job decides what to do from `kind`
 * (research verification-reference §3 "transport failure vs verdict").
 */

export type VerifyFailureKind =
  | "rejected" // any 400, whatever its text: this address can't be checked (never retried; no charge)
  | "rate-limited" // 429: back off (never charged)
  | "transient" // 5xx, network, timeout: see the job's rules (a timeout may have been charged)
  | "auth"
  | "payment"
  | "not-allowed"
  | "business-verification"
  | "not-found"; // pause every check run

export type VerifyOutcome =
  | { ok: true; result: CheckResult; unreadable: boolean; ms: number }
  | {
      ok: false;
      kind: VerifyFailureKind;
      /** Mailgun's own wait hint for a 429 (ms), or null (the job's pacer backs off by itself). */
      retryAfterMs: number | null;
      /** The request left and no answer came within the timeout: Mailgun may have billed it. */
      timedOut: boolean;
      /** Our plain sentence (never an address, never provider text): safe for logs and the job's summary. */
      message: string;
      /** The provider's own text, scrubbed (no key, no address), for "Details" only; null when there was none. */
      detail: string | null;
    };

export interface Verifier {
  /** "mailgun" | "mailgun-fake" | "fake": stored on VerificationCheck.provider and Person.verificationProvider. */
  readonly provider: string;
  /** Dollars charged per answered check (0 for the test checker). */
  readonly pricePerCheck: number;
  /** Exactly one request with its own timeout (30 s); never the job's shutdown signal (§0.2 rule 11). */
  check(email: string, emailNorm: string): Promise<VerifyOutcome>;
}

export type VerifierResult = { ok: true; verifier: Verifier } | { ok: false; reason: "no-key" | "unreadable" | "mismatch"; text: string };

/** Said when neither an address check key nor a Mailgun key is saved (starting refuses with it, §2.9). */
export const NO_CHECK_KEY_TEXT = "Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun.";

export { VERIFY_FAILURE_TEXT } from "./failures";

/** The default price per check when the setting is missing or out of range (Foundation's first 5,000, research §5.1). */
const DEFAULT_PRICE_PER_CHECK = 0.012;

/** Setting "verification.pricePerCheck" when it is a number from 0 to 1 (§2.4), else the default. */
function pricePerCheckOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_PRICE_PER_CHECK;
}

/** A secret, or "unreadable" when it can't be decrypted (the encryption key in .env changed). */
async function readSecret(name: SecretKey): Promise<string | null | "unreadable"> {
  try {
    const v = await getSecret(name);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return "unreadable";
  }
}

/**
 * The checker to use right now. The practice copy → the test checker (no network, $0). Otherwise Mailgun with the
 * Secret "verification.apiKey" when one is saved, else "mailgun.apiKey"; it builds its own client (validation is
 * account-level and needs no sending domain, so not getMailgunContext, D35) on Setting "mailgun.region"'s host (the
 * fake server in fake mode; a test run without the fake throws, on purpose). Not ok, with the sentence every screen
 * shows (`NOT_CONNECTED_TEXT`), when the key can't be read, doesn't fit the server, or is missing.
 */
export async function getVerifier(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<VerifierResult> {
  const s = await getSettings(["practice.copy", "mailgun.region", "verification.pricePerCheck"] as const);
  if (s["practice.copy"] === true) return { ok: true, verifier: practiceChecker() };

  let apiKey = await readSecret("verification.apiKey");
  if (apiKey === null) apiKey = await readSecret("mailgun.apiKey");
  if (apiKey === "unreadable") return { ok: false, reason: "unreadable", text: NOT_CONNECTED_TEXT.unreadable };
  if (apiKey === null) return { ok: false, reason: "no-key", text: NO_CHECK_KEY_TEXT };

  const region = s["mailgun.region"] === "US" ? "US" : "EU";
  const baseUrl = mailgunApiBase(region);
  try {
    assertKeyMatchesTarget(apiKey, baseUrl);
  } catch {
    return { ok: false, reason: "mismatch", text: NOT_CONNECTED_TEXT.mismatch };
  }
  return {
    ok: true,
    verifier: createMailgunVerifier({
      apiKey,
      region,
      baseUrl,
      timeoutMs: opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
      pricePerCheck: pricePerCheckOf(s["verification.pricePerCheck"]),
    }),
  };
}
