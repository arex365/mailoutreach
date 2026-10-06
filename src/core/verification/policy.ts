import { checkDecision, type CheckDecision, type RiskValue, type VerificationPolicy, type VerificationStatusValue } from "@/core/rules/eligibility";
import { FAKE_SERVER_PROVIDER, REAL_PROVIDERS, type CheckRunCounts } from "./types";

/**
 * Policy helpers for address checks (M5-DESIGN §2.3, §2.7). The decision itself is `checkDecision` in
 * @/core/rules/eligibility (the one table); these helpers sort a result into the buckets that the run summary, the
 * toasts and the "Who is left out" list talk about, and say which providers' results count. Pure and browser-safe.
 */

/** The part of a run's counts one result belongs to (CheckRunCounts, M5-DESIGN §5.8). */
export type CheckBucket = "canEmail" | "invalid" | "doNotSend" | "risky" | "catchAllBlocked" | "disposable" | "unknown";

/** A stored result as the buckets need it. */
export type CheckVerdict = { status: VerificationStatusValue; risk: RiskValue | null; disposable: boolean };

/**
 * The policy's decision for one result and its bucket: undeliverable → invalid; do not send → doNotSend; a result
 * the policy sends → canEmail (`lowRiskCatchAll` for a low-risk catch-all); an unknown result → unknown; a throwaway
 * address skipped by the "Throwaway addresses" row → disposable; a catch-all → catchAllBlocked; anything else that is
 * skipped ("deliverable, high risk") → risky.
 */
export function checkBucket(r: CheckVerdict, policy: VerificationPolicy): { decision: CheckDecision; bucket: CheckBucket; lowRiskCatchAll: boolean } {
  const decision = checkDecision(r.status, r.risk, policy, { disposable: r.disposable });
  const lowRiskCatchAll = r.status === "CATCH_ALL" && r.risk === "LOW";
  if (r.status === "INVALID") return { decision, bucket: "invalid", lowRiskCatchAll: false };
  if (r.status === "DO_NOT_SEND") return { decision, bucket: "doNotSend", lowRiskCatchAll: false };
  if (decision === "send") return { decision, bucket: "canEmail", lowRiskCatchAll };
  if (r.status === "UNKNOWN") return { decision, bucket: "unknown", lowRiskCatchAll: false };
  if (r.disposable && policy.disposable !== "send") return { decision, bucket: "disposable", lowRiskCatchAll: false };
  if (r.status === "CATCH_ALL") return { decision, bucket: "catchAllBlocked", lowRiskCatchAll: false };
  return { decision, bucket: "risky", lowRiskCatchAll: false };
}

/** Counts with every number at zero (a run that hasn't checked anything yet). */
export function emptyCheckRunCounts(): CheckRunCounts {
  return {
    checked: 0,
    canEmail: 0,
    lowRiskCatchAll: 0,
    invalid: 0,
    doNotSend: 0,
    risky: 0,
    catchAllBlocked: 0,
    disposable: 0,
    unknown: 0,
    refused: 0,
    notReached: 0,
    mayBeCharged: 0,
    skipped: { fresh: 0, suppressed: 0, noEmail: 0, neverEmailed: 0 },
    costUsd: 0,
  };
}

/**
 * Providers whose results count for TEST/LIVE sending (M5-DESIGN §0.3 "Real provider", D10): Mailgun, ZeroBounce and
 * NeverBounce, plus "mailgun-fake" only while the app talks to the fake Mailgun (`fakeMode`, never on app.db).
 */
export function realProviderSet(fakeMode: boolean): ReadonlySet<string> {
  return new Set(fakeMode ? [...REAL_PROVIDERS, FAKE_SERVER_PROVIDER] : REAL_PROVIDERS);
}

/** True when a result from `provider` counts for real sending. */
export function isRealProvider(provider: string | null | undefined, realProviders: ReadonlySet<string>): boolean {
  return typeof provider === "string" && realProviders.has(provider);
}
