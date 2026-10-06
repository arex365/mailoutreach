/** Milestone 5 contract (docs/dev/M5-DESIGN.md §2): address checks. Browser-safe, no I/O. */
import type { CheckDecision, RiskValue, VerificationStatusValue } from "@/core/rules/eligibility";
export type { CheckDecision, RiskValue, VerificationStatusValue };

/** One provider answer mapped to our words (PLAN B6.9 adapter output). */
export type CheckResult = {
  status: VerificationStatusValue;
  risk: RiskValue;
  isRole: boolean;
  isDisposable: boolean;
  didYouMean: string | null;
  /** Provider reason codes as received; "app:unreadable_response" when the answer couldn't be read. */
  reasons: string[];
  /** The whole parsed answer (nothing secret). */
  raw: unknown;
};

export const CHECK_SOURCES = ["wizard", "contacts", "list", "panel", "settings", "recheck"] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

export const REAL_PROVIDERS: readonly string[] = ["mailgun", "zerobounce", "neverbounce"];
/** Results from the local fake Mailgun: real only while the app talks to it (never on app.db). */
export const FAKE_SERVER_PROVIDER = "mailgun-fake";
/** The in-process test checker (practice copy, unit tests): never counts for real sending. */
export const TEST_CHECKER_PROVIDER = "fake";

/** Job payload of "verify.addresses". Never secrets. */
export type VerifyRunPayload =
  | { source: "wizard"; campaignId: number; personIds: number[]; confirmedCount: number }
  | { source: "contacts" | "list" | "panel"; personIds: number[]; confirmedCount: number; recheckRecent: boolean; listId?: number | null }
  | { source: "settings"; address: string }
  | { source: "recheck" };

/** Where a person stands with checks (M5-DESIGN §2.8 rule 8). */
export type CheckNeed = "none" | "check" | "second-check" | "wait";

export const UNKNOWN_RECHECK_AFTER_MS = 24 * 3_600_000;
export const FAILED_CHECK_RETRY_AFTER_DAYS = 30;
export const MAX_UNKNOWNS_IN_A_ROW = 3;
export const MAX_CHECKS_PER_RUN = 5_000;
export const CHECK_CONCURRENCY_MAX = 4;
/** Share of addresses assumed to need a second check, for "up to $X more" (research §5.4). */
export const RECHECK_SHARE_ESTIMATE = 0.05;

/** The Person check fields, written together by a check and cleared together when the address changes. */
export const CLEARED_CHECK_FIELDS = {
  verificationStatus: null,
  verificationRisk: null,
  verifiedAt: null,
  verificationProvider: null,
  verificationDisposable: false,
  verificationUnknowns: 0,
} as const;

/** What a finished (or stopped) run counted; the summary and notification sentences are built from it (P1 words, §2.11). */
export type CheckRunCounts = {
  checked: number;             // committed verdict rows (unreadable rows are counted in notReached)
  canEmail: number;            // decision "send"
  lowRiskCatchAll: number;     // part of canEmail: CATCH_ALL + LOW
  invalid: number;             // INVALID
  doNotSend: number;           // DO_NOT_SEND
  risky: number;               // blocked by "deliverable, high risk" (RISKY, or VALID + HIGH)
  catchAllBlocked: number;     // CATCH_ALL blocked by the policy (medium, high or unknown risk; low when set to Skip)
  disposable: number;          // blocked because throwaway
  unknown: number;             // UNKNOWN verdicts (a second check follows in a campaign, or left out)
  refused: number;             // Mailgun refused (400)
  notReached: number;          // no verdict: pending at the end (5xx / timeouts / 429 exhausted / stopped) or unreadable
  mayBeCharged: number;        // part of notReached: timed out twice (the requests left, Mailgun may have billed them)
  skipped: { fresh: number; suppressed: number; noEmail: number; neverEmailed: number };
  costUsd: number;
};

/** A panel or settings run's one address, for its screen (job result `single`; read through checkRunView). */
export type CheckSingleOutcome = {
  personId: number | null;
  outcome: "checked" | "refused" | "skipped" | "not-reached";
  skipReason: "suppressed" | "no-email" | "never-emailed" | null;
  status: VerificationStatusValue | null;
  risk: RiskValue | null;
  disposable: boolean;
  decision: CheckDecision | null;
  /** How long Mailgun took (the Settings test says "Checked in 1.4 s"). */
  ms: number | null;
  /** Mailgun's refusal text, scrubbed (no address, no key), for "Details" only. */
  detail: string | null;
};

/** The check job's carry (M5-DESIGN §2.5), kept by the runner across deferrals and retries. P6 writes, P1 reads. */
export type VerifyRunCarry = {
  cursor: number;                          // next index into payload.personIds
  pending: number[];                       // person ids to try again on the next pass
  failed: number[];                        // refused by Mailgun (400): never again in this run
  timeouts: Record<string, number>;        // timed-out attempts per person id
  uncommitted: Array<{ personId: number | null; emailNorm: string; result: CheckResult; unreadable: boolean; provider: string; costUsd: number }>;
  retries: number;                         // retry-later deferrals so far (max 6)
  unreadableInARow: number;
  skipped: { fresh: number; suppressed: number; noEmail: number; neverEmailed: number };
  refused: number;
  notReached: number;
  mayBeCharged: number;
  single: CheckSingleOutcome | null;
};
export const EMPTY_VERIFY_CARRY: VerifyRunCarry = {
  cursor: 0, pending: [], failed: [], timeouts: {}, uncommitted: [], retries: 0, unreadableInARow: 0,
  skipped: { fresh: 0, suppressed: 0, noEmail: 0, neverEmailed: 0 }, refused: 0, notReached: 0, mayBeCharged: 0, single: null,
};

/**
 * The context part of `liveCheckContext(settings, now)` (P1, need.ts): Contacts, list and panel checks and the job's
 * skip rule judge "needs a check" as a live campaign would, whatever the sending mode and go-live (M5-DESIGN §2.8 rule 8).
 */
export const LIVE_CHECK_CONTEXT = { mode: "LIVE", phase: "launch", goLive: true, testListCountsAsChecked: false } as const;
