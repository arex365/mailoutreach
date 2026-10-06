import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFICATION_POLICY, type EligibilityContext, type PersonFacts } from "@/core/rules/eligibility";
import { DAY_MS } from "@/core/rules/team-rule";
import { checkNeedOf, liveCheckContext, needsCheck } from "@/core/verification/need";
import { realProviderSet } from "@/core/verification/policy";
import { LIVE_CHECK_CONTEXT, type CheckNeed } from "@/core/verification/types";

/** Who needs an address check (M5-DESIGN §2.8 rule 8) and the live check context (D38). */

const NOW = new Date("2026-09-23T08:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function person(over: Partial<PersonFacts> = {}): PersonFacts {
  return {
    id: 7,
    email: "anna@firma.de",
    emailNorm: "anna@firma.de",
    deleted: false,
    verificationStatus: null,
    verificationRisk: null,
    verifiedAt: null,
    verificationProvider: null,
    unsubscribedAt: null,
    bouncedAt: null,
    complainedAt: null,
    suppression: null,
    ...over,
  };
}

/** The default settings of a fresh database: dry run, go-live off, the address on the test list. */
const defaults = {
  maxCheckAgeDays: 90,
  policy: DEFAULT_VERIFICATION_POLICY,
  realProviders: realProviderSet(false),
};

describe("checkNeedOf", () => {
  const live = liveCheckContext(defaults, NOW);
  const rows: Array<[string, PersonFacts, CheckNeed]> = [
    ["never checked", person(), "check"],
    ["checked by the test checker", person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(DAY_MS), verificationProvider: "fake" }), "check"],
    ["fake Mailgun outside fake mode", person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(DAY_MS), verificationProvider: "mailgun-fake" }), "check"],
    ["fresh valid", person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(10 * DAY_MS), verificationProvider: "mailgun" }), "none"],
    ["valid, 91 days old", person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(91 * DAY_MS), verificationProvider: "mailgun" }), "check"],
    ["risky, fresh (the policy decides)", person({ verificationStatus: "RISKY", verificationRisk: "HIGH", verifiedAt: ago(DAY_MS), verificationProvider: "mailgun" }), "none"],
    ["invalid", person({ verificationStatus: "INVALID", verificationRisk: "HIGH", verifiedAt: ago(DAY_MS), verificationProvider: "mailgun" }), "none"],
    ["first unknown, 1 h", person({ verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: ago(HOUR), verificationProvider: "mailgun", verificationUnknowns: 1 }), "wait"],
    ["first unknown, 24 h", person({ verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: ago(24 * HOUR), verificationProvider: "mailgun", verificationUnknowns: 1 }), "second-check"],
    ["second unknown, 2 days", person({ verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: ago(2 * DAY_MS), verificationProvider: "mailgun", verificationUnknowns: 2 }), "none"],
    ["second unknown, 30 days", person({ verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: ago(30 * DAY_MS), verificationProvider: "mailgun", verificationUnknowns: 2 }), "check"],
    ["no email", person({ email: null, emailNorm: null }), "none"],
  ];
  it.each(rows)("%s", (_label, p, want) => {
    expect(checkNeedOf(p, live)).toBe(want);
  });

  it("is 'none' in a dry run and for test-list addresses before go-live", () => {
    const dry: EligibilityContext = { ...live, mode: "DRY_RUN" };
    expect(checkNeedOf(person(), dry)).toBe("none");
    expect(checkNeedOf(person({ verificationStatus: "UNKNOWN", verifiedAt: ago(30 * HOUR), verificationUnknowns: 1 }), dry)).toBe("none");
    const beforeGoLive: EligibilityContext = { ...live, mode: "TEST", goLive: false, testList: new Set(["anna@firma.de"]), testListCountsAsChecked: undefined };
    expect(checkNeedOf(person(), beforeGoLive)).toBe("none");
    // …but testListCountsAsChecked false makes the test-list address need a check.
    expect(checkNeedOf(person(), { ...beforeGoLive, testListCountsAsChecked: false })).toBe("check");
  });

  it("follows the policy: 'no answer' skipped by the settings needs no second check", () => {
    const block = liveCheckContext({ ...defaults, policy: { ...DEFAULT_VERIFICATION_POLICY, unknown: "block" } }, NOW);
    expect(checkNeedOf(person({ verificationStatus: "UNKNOWN", verifiedAt: ago(30 * HOUR), verificationUnknowns: 1, verificationProvider: "mailgun" }), block)).toBe("none");
  });

  it("needsCheck is true for a check or a due second check", () => {
    expect([needsCheck("check"), needsCheck("second-check"), needsCheck("wait"), needsCheck("none")]).toEqual([true, true, false, false]);
  });
});

describe("liveCheckContext", () => {
  it("judges as a live campaign after go-live would, with an empty test list and the settings", () => {
    const c = liveCheckContext(defaults, NOW);
    expect(c).toMatchObject({ ...LIVE_CHECK_CONTEXT, now: NOW, maxCheckAgeDays: 90, policy: DEFAULT_VERIFICATION_POLICY });
    expect(c.testList.size).toBe(0);
    expect(c.realProviders).toBe(defaults.realProviders);
  });

  it("still says 'check' for an unchecked person under the default settings (dry run, go-live off, on the test list)", () => {
    // Whatever the sending mode and the test list, Contacts and panel checks count what a live campaign would need.
    expect(checkNeedOf(person(), liveCheckContext(defaults, NOW))).toBe("check");
  });

  it("counts fake-Mailgun results only in fake mode", () => {
    const p = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(DAY_MS), verificationProvider: "mailgun-fake" });
    expect(checkNeedOf(p, liveCheckContext({ ...defaults, realProviders: realProviderSet(true) }, NOW))).toBe("none");
    expect(checkNeedOf(p, liveCheckContext(defaults, NOW))).toBe("check");
  });
});
