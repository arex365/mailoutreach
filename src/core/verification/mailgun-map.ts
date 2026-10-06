/**
 * Mailgun's address-validation answer (GET /v4/address/validate, docs/dev/research/verification-reference.md §2) mapped
 * to our words (docs/dev/M5-DESIGN.md §2.3, the contract table). Browser-safe and pure: no I/O, shared by the Mailgun
 * verifier, the in-process test checker and the tests.
 *
 * The only judgement is splitting "deliverable" by risk (high → RISKY, everything else VALID, D8) and treating an
 * "undeliverable" whose reasons are all soft (a full mailbox, an SMTP hiccup) as UNKNOWN (D33): it isn't proof the
 * address is gone, so it must never become a permanent INVALID suppression. The policy decides the rest
 * (`checkDecision` in @/core/rules/eligibility).
 */
import { normalizeEmail } from "@/core/email-address";
import type { CheckResult, RiskValue, VerificationStatusValue } from "./types";

/** Undeliverable reasons that don't prove an address is gone (research §2.4): with only these it is stored as UNKNOWN. */
export const SOFT_REASONS: readonly string[] = ["mailbox_quota_exceeded", "smtp_error", "smtp_timeout"];

/** The reason stored for an answer the app couldn't read (a 200 without a readable `result`, or one we don't know). */
export const UNREADABLE_REASON = "app:unreadable_response";

const RISKS: Readonly<Record<string, RiskValue>> = { low: "LOW", medium: "MEDIUM", high: "HIGH", unknown: "UNKNOWN" };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Mailgun's `risk`: low/medium/high/unknown; anything else (or missing) is UNKNOWN. */
function riskOf(v: unknown): RiskValue {
  return typeof v === "string" ? (RISKS[v.trim().toLowerCase()] ?? "UNKNOWN") : "UNKNOWN";
}

/**
 * The reason codes as received: an array keeps its non-empty strings (codes with spaces included, "failed custom
 * grammar check"), a bare string (the old v3 form) becomes a one-item list, `null`/missing an empty one.
 */
export function reasonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((r): r is string => typeof r === "string" && r.trim() !== "");
  return typeof v === "string" && v.trim() !== "" ? [v] : [];
}

/**
 * Mailgun's typo suggestion, or null. Compared with OUR stored address (never with Mailgun's echoed `address`), so a
 * suggestion that differs only in case (or is our own address) is never offered: taking it would throw away a paid
 * result for nothing. It is only ever shown, never applied automatically.
 */
function didYouMeanOf(v: unknown, emailNorm: string): string | null {
  if (typeof v !== "string") return null;
  const suggestion = v.trim();
  if (!suggestion) return null;
  const norm = normalizeEmail(suggestion) ?? suggestion.toLowerCase();
  return norm === emailNorm.trim().toLowerCase() ? null : suggestion;
}

/** A soft "undeliverable": non-empty reasons that are all in SOFT_REASONS. */
function onlySoftReasons(reasons: readonly string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => SOFT_REASONS.includes(r.trim().toLowerCase()));
}

/**
 * Mailgun's body → our result, or "unreadable" when `result` is missing, not a string, or a value we don't know (the
 * v3-shaped body, "maybe"…). The caller stores an unreadable answer as a charged row that leaves the person alone
 * (§2.6, D32), through `unreadableResult`.
 *
 * | result        | risk               | → status                                             |
 * |---------------|--------------------|------------------------------------------------------|
 * | deliverable   | high               | RISKY                                                |
 * | deliverable   | low/medium/unknown | VALID                                                |
 * | catch_all     | as given           | CATCH_ALL                                            |
 * | unknown       | as given           | UNKNOWN                                              |
 * | undeliverable | as given           | UNKNOWN when every reason is soft, else INVALID      |
 * | do_not_send   | as given           | DO_NOT_SEND                                          |
 */
export function fromMailgun(body: unknown, opts: { emailNorm: string }): CheckResult | "unreadable" {
  if (!isObject(body) || typeof body.result !== "string") return "unreadable";
  const result = body.result.trim().toLowerCase();
  const risk = riskOf(body.risk);
  const reasons = reasonList(body.reason);
  let status: VerificationStatusValue;
  switch (result) {
    case "deliverable":
      status = risk === "HIGH" ? "RISKY" : "VALID";
      break;
    case "catch_all":
      status = "CATCH_ALL";
      break;
    case "unknown":
      status = "UNKNOWN";
      break;
    case "undeliverable":
      status = onlySoftReasons(reasons) ? "UNKNOWN" : "INVALID";
      break;
    case "do_not_send":
      status = "DO_NOT_SEND";
      break;
    default:
      return "unreadable";
  }
  return {
    status,
    risk,
    isRole: body.is_role_address === true,
    isDisposable: body.is_disposable_address === true,
    didYouMean: didYouMeanOf(body.did_you_mean, opts.emailNorm),
    reasons,
    raw: body,
  };
}

/** What an unreadable answer is stored as (UNKNOWN, reason "app:unreadable_response", the whole answer in `raw`). */
export function unreadableResult(raw: unknown): CheckResult {
  return {
    status: "UNKNOWN",
    risk: "UNKNOWN",
    isRole: false,
    isDisposable: false,
    didYouMean: null,
    reasons: [UNREADABLE_REASON],
    raw: raw === undefined ? null : raw,
  };
}

/** Mailgun's `result` value when it is a string we don't know (for the "logged once per new value" line), else null. */
export function unknownResultValue(body: unknown): string | null {
  if (!isObject(body) || typeof body.result !== "string") return null;
  const known = ["deliverable", "catch_all", "unknown", "undeliverable", "do_not_send"];
  return known.includes(body.result.trim().toLowerCase()) ? null : body.result;
}
