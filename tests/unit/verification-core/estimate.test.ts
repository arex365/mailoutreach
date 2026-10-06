import { describe, expect, it } from "vitest";
import { estimateChecks, expectedSecondChecks } from "@/core/verification/estimate";

/** The cost estimate of a check run (M5-DESIGN §2.10). */

const base = { pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" };

describe("estimateChecks", () => {
  it("prices every check on a plan without included checks, with the second-check extra", () => {
    const e = estimateChecks({ ...base, count: 40 });
    expect(e).toEqual({
      count: 40,
      pricePerCheck: 0.012,
      includedPerMonth: 0,
      freeLeft: 0,
      paidCount: 40,
      aboutUsd: 0.48,
      recheckExtraUsd: 0.024,
      provider: "mailgun",
      free: false,
    });
    // The M5 end-to-end numbers: 12 addresses → $0.144, ceil(12 × 5 %) = 1 second check → $0.012.
    expect(estimateChecks({ ...base, count: 12 })).toMatchObject({ aboutUsd: 0.144, recheckExtraUsd: 0.012 });
  });

  it("uses the plan's included checks first (partly free, all free)", () => {
    const partly = estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 4_990 });
    expect(partly).toMatchObject({ freeLeft: 10, paidCount: 30, aboutUsd: 0.36, free: false, recheckExtraUsd: 0.024 });
    const all = estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 840 });
    expect(all).toMatchObject({ freeLeft: 4_160, paidCount: 0, aboutUsd: 0, free: true, recheckExtraUsd: 0 });
    // Second checks that the included checks can't cover any more are priced.
    const edge = estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 4_959 });
    expect(edge).toMatchObject({ freeLeft: 41, paidCount: 0, free: true, recheckExtraUsd: 0.012 });
    // More used than included (a mid-month plan change): nothing is left.
    expect(estimateChecks({ ...base, count: 5, includedPerMonth: 100, usedThisMonth: 400 }).freeLeft).toBe(0);
  });

  it("is free with the test checker, whatever the price setting says", () => {
    const e = estimateChecks({ ...base, count: 40, provider: "fake", usedThisMonth: 99 });
    expect(e).toMatchObject({ pricePerCheck: 0, paidCount: 0, aboutUsd: 0, recheckExtraUsd: 0, free: true, provider: "fake" });
  });

  it("rounds the second checks up, without floating-point surprises", () => {
    expect(expectedSecondChecks(1)).toBe(1);
    expect(expectedSecondChecks(20)).toBe(1);
    expect(expectedSecondChecks(21)).toBe(2);
    expect(expectedSecondChecks(60)).toBe(3); // 60 × 0.05 is 3.0000000000000004 in floating point
    expect(expectedSecondChecks(0)).toBe(0);
    expect(estimateChecks({ ...base, count: 60 }).recheckExtraUsd).toBe(0.036);
  });

  it("treats broken inputs as zero and rounds money to 6 decimals", () => {
    expect(estimateChecks({ ...base, count: -3 })).toMatchObject({ count: 0, paidCount: 0, aboutUsd: 0, free: true });
    expect(estimateChecks({ ...base, count: 3, pricePerCheck: Number.NaN })).toMatchObject({ pricePerCheck: 0, aboutUsd: 0 });
    expect(estimateChecks({ ...base, count: 3, pricePerCheck: 0.0123456789 }).aboutUsd).toBe(0.037037);
  });
});
