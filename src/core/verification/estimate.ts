import { roundUsd } from "@/core/money";
import { RECHECK_SHARE_ESTIMATE, TEST_CHECKER_PROVIDER } from "./types";

/**
 * What a run of address checks will cost (M5-DESIGN §2.10). Pure and browser-safe: the server fills in the price, the
 * plan's included checks and this office month's use (@/server/services/verification/estimate), and the screens can
 * recompute a variant (for example with "Check these again too") from the numbers of an estimate they already have.
 *
 * The estimate never promises: Mailgun bills extra checks silently, so the confirm button carries the count and the
 * price, and the monthly check limit is the hard stop.
 */

export type CheckEstimate = {
  /** Addresses to check. */
  count: number;
  /** Dollars per check; 0 for the test checker. */
  pricePerCheck: number;
  /** Checks the Mailgun plan includes each month (Setting "verification.includedPerMonth"). */
  includedPerMonth: number;
  /** max(0, includedPerMonth − real checks this office month). */
  freeLeft: number;
  /** max(0, count − freeLeft); 0 for the test checker. */
  paidCount: number;
  /** paidCount × price. */
  aboutUsd: number;
  /**
   * "Up to $X more if some need a second check tomorrow": ceil(count × 5 %) second checks × price, less the ones the
   * plan's included checks still cover after this run.
   */
  recheckExtraUsd: number;
  /** "mailgun" | "mailgun-fake" | "fake". */
  provider: string;
  /** The test checker, or everything inside the included checks. */
  free: boolean;
};

function wholeOrZero(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * How many of `count` addresses may need a second check: ceil(count × 5 %), rounded first so that a floating-point
 * product such as 60 × 0.05 = 3.0000000000000004 doesn't become 4.
 */
export function expectedSecondChecks(count: number): number {
  return Math.ceil(Number((wholeOrZero(count) * RECHECK_SHARE_ESTIMATE).toFixed(9)));
}

/** The estimate for `count` addresses (M5-DESIGN §2.10). Negative or broken inputs count as 0. */
export function estimateChecks(input: {
  count: number;
  pricePerCheck: number;
  includedPerMonth: number;
  usedThisMonth: number;
  provider: string;
}): CheckEstimate {
  const count = wholeOrZero(input.count);
  const testChecker = input.provider === TEST_CHECKER_PROVIDER;
  const price = testChecker || !Number.isFinite(input.pricePerCheck) || input.pricePerCheck < 0 ? 0 : input.pricePerCheck;
  const includedPerMonth = wholeOrZero(input.includedPerMonth);
  const freeLeft = Math.max(0, includedPerMonth - wholeOrZero(input.usedThisMonth));
  const paidCount = testChecker ? 0 : Math.max(0, count - freeLeft);
  const freeAfterRun = Math.max(0, freeLeft - count);
  const paidSecondChecks = testChecker ? 0 : Math.max(0, expectedSecondChecks(count) - freeAfterRun);
  return {
    count,
    pricePerCheck: price,
    includedPerMonth,
    freeLeft,
    paidCount,
    aboutUsd: roundUsd(paidCount * price),
    recheckExtraUsd: roundUsd(paidSecondChecks * price),
    provider: input.provider,
    free: testChecker || paidCount === 0,
  };
}
