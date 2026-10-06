import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_POLICY,
  checkDecision,
  evaluateEligibility,
  personReasons,
  policyBlockedText,
  type CompanyFacts,
  type EligibilityContext,
  type PersonFacts,
  type RiskValue,
  type VerificationStatusValue,
} from "@/core/rules/eligibility";
import { DAY_MS } from "@/core/rules/team-rule";

/** Address checks in the eligibility rules, per phase (M5-DESIGN §2.3 policy table, §2.8 rules 1–9). */

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function person(over: Partial<PersonFacts> = {}): PersonFacts {
  return {
    id: 1,
    email: "anna@acme.de",
    emailNorm: "anna@acme.de",
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

const checked = (status: VerificationStatusValue, risk: RiskValue | null, over: Partial<PersonFacts> = {}) =>
  person({ verificationStatus: status, verificationRisk: risk, verifiedAt: ago(DAY_MS), verificationProvider: "mailgun", ...over });

const company: CompanyFacts = { id: 1, status: "NOT_CONTACTED", deleted: false };

function ctx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    mode: "LIVE",
    now: NOW,
    maxCheckAgeDays: 90,
    policy: DEFAULT_VERIFICATION_POLICY,
    testList: new Set(),
    goLive: true,
    ...over,
  };
}

const run = (p: PersonFacts, c: EligibilityContext) => evaluateEligibility({ company, person: p, teamRule: null, ctx: c });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("checkDecision: the §2.3 policy table", () => {
  const p = DEFAULT_VERIFICATION_POLICY;
  const rows: Array<[VerificationStatusValue, RiskValue | null, boolean, string]> = [
    ["VALID", "LOW", false, "send"],
    ["VALID", "MEDIUM", false, "send"],
    ["VALID", "UNKNOWN", false, "send"],
    ["VALID", null, false, "send"],
    ["VALID", "HIGH", false, "block"],
    ["RISKY", "HIGH", false, "block"],
    ["CATCH_ALL", "LOW", false, "send"],
    ["CATCH_ALL", "MEDIUM", false, "block"],
    ["CATCH_ALL", "HIGH", false, "block"],
    ["CATCH_ALL", "UNKNOWN", false, "block"],
    ["UNKNOWN", "UNKNOWN", false, "recheck"],
    ["UNKNOWN", "HIGH", false, "recheck"],
    ["INVALID", "HIGH", false, "undeliverable"],
    ["DO_NOT_SEND", "HIGH", false, "do-not-send"],
    // Throwaway addresses (the new "Throwaway addresses: Skip" row).
    ["VALID", "LOW", true, "block"],
    ["CATCH_ALL", "LOW", true, "block"],
    ["INVALID", "HIGH", true, "undeliverable"],
    ["DO_NOT_SEND", "HIGH", true, "do-not-send"],
    ["UNKNOWN", "UNKNOWN", true, "recheck"],
  ];
  it.each(rows)("%s / %s (throwaway %s) → %s", (status, risk, disposable, want) => {
    expect(checkDecision(status, risk, p, { disposable })).toBe(want);
  });

  it("follows the Owner's choices, and any value that isn't send (or recheck for unknown) blocks", () => {
    expect(checkDecision("VALID", "LOW", { ...p, disposable: "send" }, { disposable: true })).toBe("send");
    expect(checkDecision("RISKY", "HIGH", { ...p, deliverableHighRisk: "send" })).toBe("send");
    expect(checkDecision("CATCH_ALL", "LOW", { ...p, catchAllLow: "block" })).toBe("block");
    expect(checkDecision("CATCH_ALL", "MEDIUM", { ...p, catchAllMedium: "send" })).toBe("send");
    expect(checkDecision("CATCH_ALL", "HIGH", { ...p, catchAllHigh: "send" })).toBe("send");
    expect(checkDecision("UNKNOWN", null, { ...p, unknown: "block" })).toBe("block");
    expect(checkDecision("UNKNOWN", null, { ...p, unknown: "whatever" })).toBe("block");
    expect(checkDecision("VALID", "HIGH", { ...p, deliverableHighRisk: "yes" })).toBe("block");
  });

  it("words the policy sentences, the throwaway and 'no answer' ones included", () => {
    expect(policyBlockedText("VALID", "LOW", { disposable: true })).toBe("A throwaway address; your check settings skip these");
    expect(policyBlockedText("UNKNOWN", null)).toBe("The address check got no answer; your check settings skip these");
    expect(policyBlockedText("CATCH_ALL", "HIGH")).toBe("Can't confirm this address (high risk); your check settings skip these");
    expect(policyBlockedText("RISKY", "HIGH")).toBe("The address check rated this address high risk; your check settings skip these");
  });
});

describe("phases (§2.8 rule 3)", () => {
  it("draft: the 'needs a check' codes are pending, the person stays eligible, with the check need", () => {
    const draft = ctx({ phase: "draft" });
    const cases: Array<[PersonFacts, string, string]> = [
      [person(), "not-checked", "check"],
      [checked("VALID", "LOW", { verificationProvider: "fake" }), "test-checker", "check"],
      [checked("VALID", "LOW", { verifiedAt: ago(91 * DAY_MS) }), "check-too-old", "check"],
      [checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1, verifiedAt: ago(HOUR) }), "check-waiting", "wait"],
      [checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1, verifiedAt: ago(25 * HOUR) }), "check-waiting", "second-check"],
    ];
    for (const [p, code, need] of cases) {
      const r = run(p, draft);
      expect(r.eligible).toBe(true);
      expect(r.pending.map((x) => x.code)).toEqual([code]);
      expect(r.pending[0]!.pending).toBe(true);
      expect(r.checkNeed).toBe(need);
    }
  });

  it("launch: every one of them blocks", () => {
    const r = run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1, verifiedAt: ago(2 * HOUR) }), ctx());
    expect(r).toMatchObject({ eligible: false, pending: [], reason: { code: "check-waiting" }, checkNeed: "wait" });
    expect(run(person(), ctx()).reason?.code).toBe("not-checked");
    // Verdicts block in the draft too.
    const draft = ctx({ phase: "draft" });
    expect(run(checked("INVALID", "HIGH"), draft).reason?.code).toBe("check-undeliverable");
    expect(run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 2 }), draft).reason?.code).toBe("check-unknown");
  });

  it("send, first email: freshness is measured at the launch (85 days old at launch, 95 now passes)", () => {
    const launchedAt = ago(10 * DAY_MS);
    const p = checked("VALID", "LOW", { verifiedAt: ago(95 * DAY_MS) });
    const send0 = ctx({ phase: "send", sendStep: 0, checkAgeAt: launchedAt });
    expect(run(p, send0).eligible).toBe(true);
    // Without the launch instant it's too old, as at launch today.
    expect(run(p, ctx({ phase: "send", sendStep: 0 })).reason?.code).toBe("check-too-old");
    // A first "no answer" still waits at send time (the loop moves the recipient to RECHECK).
    expect(run(checked("UNKNOWN", null, { verificationUnknowns: 1 }), send0).reason?.code).toBe("check-waiting");
    expect(run(person(), send0).reason?.code).toBe("not-checked");
  });

  it("send, follow-ups: check age and unknown results are ignored, policy blocks still apply", () => {
    const send1 = ctx({ phase: "send", sendStep: 1, checkAgeAt: ago(200 * DAY_MS) });
    expect(run(checked("VALID", "LOW", { verifiedAt: ago(300 * DAY_MS) }), send1).eligible).toBe(true);
    expect(run(checked("UNKNOWN", null, { verificationUnknowns: 1 }), send1).eligible).toBe(true);
    expect(run(checked("UNKNOWN", null, { verificationUnknowns: 3 }), send1).eligible).toBe(true);
    expect(run(person(), send1).eligible).toBe(true);
    const policy = run(checked("CATCH_ALL", "MEDIUM"), send1);
    expect(policy.reason?.code).toBe("policy-blocked");
    expect(run(checked("INVALID", "HIGH"), send1).reason?.code).toBe("check-undeliverable");
    expect(run(checked("VALID", "LOW", { verificationDisposable: true }), send1).reason?.code).toBe("policy-blocked");
    expect(run(checked("VALID", "LOW"), send1).checkNeed).toBe("none");
  });
});

describe("results older than the maximum age (§2.7: checked again by a later campaign's Verify step)", () => {
  const stale = { verifiedAt: ago(100 * DAY_MS) };
  const blocked: Array<[string, PersonFacts]> = [
    ["can't be confirmed (medium risk)", checked("CATCH_ALL", "MEDIUM", stale)],
    ["rated high risk", checked("RISKY", "HIGH", stale)],
    ["a throwaway address", checked("VALID", "LOW", { ...stale, verificationDisposable: true })],
  ];

  it.each(blocked)("%s: only 'check-too-old', so the draft keeps them tickable and the Verify step checks them", (_label, p) => {
    const draft = run(p, ctx({ phase: "draft" }));
    expect(codes(draft)).toEqual(["check-too-old"]);
    expect(draft).toMatchObject({ eligible: true, checkNeed: "check" });
    expect(draft.pending.map((r) => r.code)).toEqual(["check-too-old"]);
    // At launch nobody checked it: "Address not checked" (rule 1), like a stale "can be emailed".
    const launch = run(p, ctx());
    expect(launch.blocking.map((r) => r.code)).toEqual(["check-too-old"]);
  });

  it("a fresh blocking result still blocks, and so does a stale one where no check is needed", () => {
    expect(codes(run(checked("CATCH_ALL", "MEDIUM", { verifiedAt: ago(10 * DAY_MS) }), ctx({ phase: "draft" })))).toEqual(["policy-blocked"]);
    // Follow-ups rely on the check judged at launch, a dry run never checks: the policy still decides there.
    expect(run(checked("CATCH_ALL", "MEDIUM", stale), ctx({ phase: "send", sendStep: 1 })).reason?.code).toBe("policy-blocked");
    expect(run(checked("CATCH_ALL", "MEDIUM", stale), ctx({ mode: "DRY_RUN" })).reason?.code).toBe("policy-blocked");
  });

  it("an address that doesn't exist (or mustn't be emailed) stays blocked however old the check", () => {
    expect(codes(run(checked("INVALID", "HIGH", stale), ctx({ phase: "draft" })))).toEqual(["check-too-old", "check-undeliverable"]);
    expect(run(checked("INVALID", "HIGH", stale), ctx({ phase: "draft" })).eligible).toBe(false);
    expect(run(checked("DO_NOT_SEND", "HIGH", stale), ctx({ phase: "draft" })).eligible).toBe(false);
  });
});

describe("dry runs (§2.8 rule 4)", () => {
  const text = "The address check got no answer. Dry runs don't check addresses again, so this person is left out.";
  it("never ask for a check, but a first 'no answer' blocks in every phase with the dry-run text", () => {
    for (const phase of ["draft", "launch", "send"] as const) {
      const c = ctx({ mode: "DRY_RUN", phase, sendStep: 0 });
      expect(run(person(), c).eligible).toBe(true);
      expect(run(checked("VALID", "LOW", { verifiedAt: ago(400 * DAY_MS) }), c).eligible).toBe(true);
      const r = run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1 }), c);
      expect(r.reason).toMatchObject({ code: "check-waiting", text });
      expect(r.pending).toEqual([]);
      expect(r.checkNeed).toBe("none");
    }
  });

  it("respect other results, two 'no answer's and the test checker's results too", () => {
    const c = ctx({ mode: "DRY_RUN" });
    expect(run(checked("CATCH_ALL", "HIGH"), c).reason?.code).toBe("policy-blocked");
    expect(run(checked("UNKNOWN", null, { verificationUnknowns: 2, verifiedAt: ago(40 * DAY_MS) }), c).reason?.code).toBe("check-unknown");
    expect(run(checked("INVALID", "HIGH", { verificationProvider: "fake" }), c).reason?.code).toBe("check-undeliverable");
  });
});

describe("the test list and real providers", () => {
  it("counts test-list addresses as checked before go-live, unless the launch said otherwise", () => {
    const before = ctx({ mode: "TEST", goLive: false, testList: new Set(["anna@acme.de"]) });
    expect(run(person(), before)).toMatchObject({ eligible: true, notes: ["On test list"], checkNeed: "none" });
    const judged = run(person(), { ...before, testListCountsAsChecked: false });
    expect(judged.reason?.code).toBe("not-checked");
    expect(judged.checkNeed).toBe("check");
    // A campaign launched before go-live keeps its exception after go-live (send time passes it explicitly).
    const after = ctx({ mode: "TEST", goLive: true, testList: new Set(["anna@acme.de"]), testListCountsAsChecked: true });
    expect(run(person(), after).eligible).toBe(true);
  });

  it("counts a fake-Mailgun result only when realProviders contains it", () => {
    const p = checked("VALID", "LOW", { verificationProvider: "mailgun-fake" });
    expect(run(p, ctx()).reason?.code).toBe("test-checker");
    expect(run(p, ctx({ realProviders: new Set(["mailgun", "mailgun-fake"]) })).eligible).toBe(true);
    expect(run(checked("VALID", "LOW", { verificationProvider: "zerobounce" }), ctx()).eligible).toBe(true);
    const onlyFake = run(checked("VALID", "LOW"), ctx({ realProviders: new Set(["mailgun-fake"]) }));
    expect(onlyFake.reason?.code).toBe("test-checker");
    // A result without a recorded provider (hand-made data only) counts, as before M5.
    expect(run(checked("VALID", "LOW", { verificationProvider: null }), ctx()).eligible).toBe(true);
  });

  it("an unknown result from the test checker only asks for a real check", () => {
    const r = run(checked("UNKNOWN", null, { verificationProvider: "fake", verificationUnknowns: 2 }), ctx());
    expect(codes(r)).toEqual(["test-checker"]);
    expect(r.checkNeed).toBe("check");
  });
});

describe("unknowns in a row (§2.7, §2.8 rule 2)", () => {
  const ages: Array<[string, number]> = [
    ["1 h", HOUR],
    ["25 h", 25 * HOUR],
    ["31 days", 31 * DAY_MS],
  ];
  const expected: Record<number, Record<string, [string, string]>> = {
    0: { "1 h": ["check-waiting", "wait"], "25 h": ["check-waiting", "second-check"], "31 days": ["check-waiting", "second-check"] },
    1: { "1 h": ["check-waiting", "wait"], "25 h": ["check-waiting", "second-check"], "31 days": ["check-waiting", "second-check"] },
    2: { "1 h": ["check-unknown", "none"], "25 h": ["check-unknown", "none"], "31 days": ["check-too-old", "check"] },
    3: { "1 h": ["check-unknown", "none"], "25 h": ["check-unknown", "none"], "31 days": ["check-too-old", "check"] },
  };
  for (const unknowns of [0, 1, 2, 3]) {
    for (const [label, ms] of ages) {
      it(`${unknowns} unknown(s) in a row, ${label} old`, () => {
        const p = checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: unknowns, verifiedAt: ago(ms) });
        const r = run(p, ctx());
        const [code, need] = expected[unknowns]![label]!;
        expect(codes(r)).toEqual([code]);
        expect(r.checkNeed).toBe(need);
      });
    }
  }

  it("words them, and skips a first 'no answer' when the policy says so", () => {
    const again = run(checked("UNKNOWN", null, { verificationUnknowns: 2, verifiedAt: ago(31 * DAY_MS) }), ctx());
    expect(again.reason?.text).toBe("Couldn't be checked last time; it can be checked again");
    const block = ctx({ policy: { ...DEFAULT_VERIFICATION_POLICY, unknown: "block" } });
    const r = run(checked("UNKNOWN", null, { verificationUnknowns: 1 }), block);
    expect(r.reason).toMatchObject({ code: "policy-blocked", text: "The address check got no answer; your check settings skip these" });
    expect(r.checkNeed).toBe("none");
    // In the draft the policy block is not pending: nobody pays to re-check what the settings skip.
    expect(run(checked("UNKNOWN", null, { verificationUnknowns: 1 }), { ...block, phase: "draft" }).eligible).toBe(false);
  });
});

describe("throwaway addresses (§2.8 rule 7)", () => {
  it("are skipped by default with their own sentence, and sent when the policy says so", () => {
    const r = run(checked("VALID", "LOW", { verificationDisposable: true }), ctx());
    expect(r.reason).toMatchObject({ code: "policy-blocked", text: "A throwaway address; your check settings skip these" });
    const send = ctx({ policy: { ...DEFAULT_VERIFICATION_POLICY, disposable: "send" } });
    expect(run(checked("VALID", "LOW", { verificationDisposable: true }), send).eligible).toBe(true);
    // A throwaway the policy lets through can still be skipped for its risk, with the risk sentence.
    const risky = run(checked("RISKY", "HIGH", { verificationDisposable: true }), send);
    expect(risky.reason?.text).toBe("The address check rated this address high risk; your check settings skip these");
  });

  it("personReasons returns the same reasons as evaluateEligibility for the person", () => {
    const p = checked("VALID", "LOW", { verificationDisposable: true });
    expect(personReasons(p, ctx()).reasons.map((r) => r.code)).toEqual(["policy-blocked"]);
  });
});
