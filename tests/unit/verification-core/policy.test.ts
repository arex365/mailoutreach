import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFICATION_POLICY, type RiskValue, type VerificationStatusValue } from "@/core/rules/eligibility";
import { checkBucket, emptyCheckRunCounts, isRealProvider, realProviderSet } from "@/core/verification/policy";

/** The buckets a run's results are counted in, and which providers count (M5-DESIGN §2.3, §5.8, D10). */

describe("checkBucket", () => {
  const p = DEFAULT_VERIFICATION_POLICY;
  const rows: Array<[VerificationStatusValue, RiskValue | null, boolean, string, boolean]> = [
    ["VALID", "LOW", false, "canEmail", false],
    ["VALID", "MEDIUM", false, "canEmail", false],
    ["VALID", "HIGH", false, "risky", false],
    ["RISKY", "HIGH", false, "risky", false],
    ["CATCH_ALL", "LOW", false, "canEmail", true],
    ["CATCH_ALL", "MEDIUM", false, "catchAllBlocked", false],
    ["CATCH_ALL", "UNKNOWN", false, "catchAllBlocked", false],
    ["VALID", "LOW", true, "disposable", false],
    ["CATCH_ALL", "LOW", true, "disposable", false],
    ["UNKNOWN", "UNKNOWN", false, "unknown", false],
    ["INVALID", "HIGH", true, "invalid", false],
    ["DO_NOT_SEND", "HIGH", false, "doNotSend", false],
  ];
  it.each(rows)("%s / %s (throwaway %s) → %s", (status, risk, disposable, bucket, low) => {
    expect(checkBucket({ status, risk, disposable }, p)).toMatchObject({ bucket, lowRiskCatchAll: low });
  });

  it("follows the policy: a low-risk catch-all set to Skip is blocked, a throwaway sent is judged on its risk", () => {
    expect(checkBucket({ status: "CATCH_ALL", risk: "LOW", disposable: false }, { ...p, catchAllLow: "block" }).bucket).toBe("catchAllBlocked");
    expect(checkBucket({ status: "RISKY", risk: "HIGH", disposable: true }, { ...p, disposable: "send" }).bucket).toBe("risky");
    expect(checkBucket({ status: "VALID", risk: "LOW", disposable: true }, { ...p, disposable: "send" })).toMatchObject({ bucket: "canEmail", decision: "send" });
    expect(checkBucket({ status: "UNKNOWN", risk: null, disposable: false }, { ...p, unknown: "block" })).toMatchObject({ bucket: "unknown", decision: "block" });
    expect(checkBucket({ status: "UNKNOWN", risk: null, disposable: false }, p).decision).toBe("recheck");
  });

  it("starts runs at zero", () => {
    const c = emptyCheckRunCounts();
    expect(c.checked + c.canEmail + c.costUsd + c.skipped.fresh).toBe(0);
    expect(emptyCheckRunCounts()).not.toBe(c);
  });
});

describe("real providers", () => {
  it("adds the fake Mailgun only in fake mode", () => {
    expect([...realProviderSet(false)].sort()).toEqual(["mailgun", "neverbounce", "zerobounce"]);
    expect(realProviderSet(true).has("mailgun-fake")).toBe(true);
    expect(isRealProvider("fake", realProviderSet(true))).toBe(false);
    expect(isRealProvider(null, realProviderSet(true))).toBe(false);
    expect(isRealProvider("mailgun", realProviderSet(false))).toBe(true);
  });
});
