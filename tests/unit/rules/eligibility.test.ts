import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_POLICY,
  ELIGIBILITY_CODES,
  NOT_ON_TEST_LIST_TEXT,
  checkDecision,
  evaluateEligibility,
  notOnTestListText,
  readRecipientOverrides,
  reasonOrder,
  sortReasons,
  stopReasonFor,
  withRecipientOverride,
  type CompanyFacts,
  type EligibilityContext,
  type PersonFacts,
} from "@/core/rules/eligibility";
import { DAY_MS, type TeamRuleBlock } from "@/core/rules/team-rule";

const NOW = new Date("2026-10-20T12:00:00Z");

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

const company = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({ id: 1, status: "NOT_CONTACTED", deleted: false, ...over });

function ctx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    mode: "DRY_RUN",
    now: NOW,
    maxCheckAgeDays: 90,
    policy: DEFAULT_VERIFICATION_POLICY,
    testList: new Set(),
    goLive: false,
    ...over,
  };
}

const emailed: TeamRuleBlock = {
  kind: "emailed",
  text: "Emailed by Ali 12 days ago (Germany Q4, follow-up 1)",
  at: new Date(NOW.getTime() - 12 * DAY_MS),
  matchedBy: "company",
  campaignId: 7,
  campaignName: "Germany Q4",
  senderName: "Ali",
  step: 1,
  toNorm: "anna@acme.de",
};

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("eligibility reasons", () => {
  it("lets a normal person through in a dry run without an address check", () => {
    const r = evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: ctx() });
    expect(r).toMatchObject({ eligible: true, reason: null, reasons: [], blocking: [] });
  });

  it("uses a stable code and a plain sentence, in the PLAN B6.2 order", () => {
    const r = evaluateEligibility({
      company: company({ status: "CLIENT", deleted: true }),
      person: person({ unsubscribedAt: NOW, verificationStatus: "INVALID", verifiedAt: NOW }),
      teamRule: emailed,
      recipient: { excludedByHand: true },
      ctx: ctx(),
    });
    expect(codes(r)).toEqual(["check-undeliverable", "unsubscribed", "company-status", "team-rule", "excluded-by-hand", "company-deleted"]);
    expect(r.reason).toEqual({ code: "check-undeliverable", text: "The address check said this address doesn't exist", overridable: false });
    expect(r.reasons.find((x) => x.code === "company-status")?.text).toBe("Company status is Client");
    expect(r.reasons.find((x) => x.code === "team-rule")?.text).toBe("Emailed by Ali 12 days ago (Germany Q4, follow-up 1)");
    // The order table itself follows B6.2.
    expect(reasonOrder("no-email")).toBeLessThan(reasonOrder("invalid-email"));
    expect(reasonOrder("check-too-old")).toBeLessThan(reasonOrder("check-undeliverable"));
    expect(reasonOrder("policy-blocked")).toBeLessThan(reasonOrder("unsubscribed"));
    expect(reasonOrder("suppressed")).toBeLessThan(reasonOrder("company-status"));
    expect(reasonOrder("company-replied")).toBeLessThan(reasonOrder("team-rule"));
    expect(reasonOrder("reserved")).toBeLessThan(reasonOrder("duplicate"));
    expect(reasonOrder("excluded-by-hand")).toBeLessThan(reasonOrder("company-deleted"));
    expect(ELIGIBILITY_CODES.at(-1)).toBe("no-reply-route");
  });

  it("stops at 'no email address' for people without one", () => {
    const r = evaluateEligibility({ company: company(), person: person({ email: null, emailNorm: null }), teamRule: null, ctx: ctx() });
    expect(codes(r)).toEqual(["no-email"]);
    expect(r.reason?.text).toBe("No email address");
  });

  it("flags invalid stored addresses and removed people", () => {
    expect(codes(evaluateEligibility({ company: company(), person: person({ emailNorm: "not-an-address" }), teamRule: null, ctx: ctx() }))).toEqual([
      "invalid-email",
    ]);
    expect(codes(evaluateEligibility({ company: company(), person: person({ deleted: true }), teamRule: null, ctx: ctx() }))).toEqual([
      "person-removed",
    ]);
  });

  describe("address checks (test and live campaigns only)", () => {
    const live = ctx({ mode: "LIVE", goLive: true });

    it("needs a check, not by the test checker, and not older than the setting", () => {
      expect(codes(evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: live }))).toEqual(["not-checked"]);
      const fake = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationProvider: "fake" });
      expect(codes(evaluateEligibility({ company: company(), person: fake, teamRule: null, ctx: live }))).toEqual(["test-checker"]);
      const old = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(NOW.getTime() - 91 * DAY_MS), verificationProvider: "mailgun" });
      const r = evaluateEligibility({ company: company(), person: old, teamRule: null, ctx: live });
      expect(codes(r)).toEqual(["check-too-old"]);
      expect(r.reason?.text).toBe("Last checked more than 90 days ago");
      const fresh = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(NOW.getTime() - 10 * DAY_MS), verificationProvider: "mailgun" });
      expect(evaluateEligibility({ company: company(), person: fresh, teamRule: null, ctx: live }).eligible).toBe(true);
    });

    it("doesn't ask for checks in a dry run", () => {
      expect(evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: ctx() }).eligible).toBe(true);
    });

    it("counts test-list addresses as checked until go-live, and emails only them", () => {
      const test = ctx({ mode: "TEST", goLive: false, testList: new Set(["anna@acme.de"]) });
      const r = evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: test });
      expect(r.eligible).toBe(true);
      expect(r.notes).toEqual(["On test list"]);
      const other = evaluateEligibility({ company: company(), person: person({ emailNorm: "bob@acme.de", email: "bob@acme.de" }), teamRule: null, ctx: test });
      expect(codes(other)).toEqual(["not-on-test-list", "not-checked"]);
      // After go-live the test list is no longer special.
      const after = evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: { ...test, mode: "LIVE", goLive: true } });
      expect(codes(after)).toEqual(["not-checked"]);
    });

    describe("the test list before and after go-live (M6-DESIGN §2.3)", () => {
      const list = new Set(["tess@test-mailbox.example"]);
      const tess = person({ email: "tess@test-mailbox.example", emailNorm: "tess@test-mailbox.example" });
      const anna = person();
      const run = (p: PersonFacts, c: Partial<EligibilityContext>) =>
        evaluateEligibility({ company: company(), person: p, teamRule: null, ctx: ctx({ testList: list, ...c }) });

      it("words the reason by mode: live before go-live, test mode for good", () => {
        expect(NOT_ON_TEST_LIST_TEXT).toEqual({
          live: "Not on the test list (until you go live, only test-list addresses get real email)",
          test: "Not on the test list (Test mode only emails your test list)",
        });
        expect(notOnTestListText("LIVE")).toBe(NOT_ON_TEST_LIST_TEXT.live);
        expect(notOnTestListText("TEST")).toBe(NOT_ON_TEST_LIST_TEXT.test);
        expect(run(anna, { mode: "LIVE", goLive: false }).reasons[0]).toEqual({
          code: "not-on-test-list",
          text: "Not on the test list (until you go live, only test-list addresses get real email)",
          overridable: false,
        });
        expect(run(anna, { mode: "TEST", goLive: false }).reasons[0]?.text).toBe("Not on the test list (Test mode only emails your test list)");
      });

      it("keeps test mode on the test list after go-live, with the test-mode sentence (G3)", () => {
        for (const phase of ["draft", "launch"] as const) {
          const r = run(anna, { mode: "TEST", goLive: true, phase });
          expect(r.eligible).toBe(false);
          expect(r.reason).toMatchObject({ code: "not-on-test-list", text: "Not on the test list (Test mode only emails your test list)" });
        }
      });

      it("counts a test-list address as checked in test mode, also after go-live", () => {
        for (const goLive of [false, true]) {
          const r = run(tess, { mode: "TEST", goLive });
          expect(r).toMatchObject({ eligible: true, reasons: [], notes: ["On test list"] });
        }
      });

      it("drops the test-list rule for live after go-live: anyone checked is eligible, the test list needs a check too", () => {
        const checked = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationProvider: "mailgun" });
        expect(run(checked, { mode: "LIVE", goLive: true }).eligible).toBe(true);
        expect(codes(run(anna, { mode: "LIVE", goLive: true }))).toEqual(["not-checked"]);
        // Test mailboxes are ordinary companies after go-live (G9): no note, and they need a real check.
        const t = run(tess, { mode: "LIVE", goLive: true });
        expect(t.notes).toEqual([]);
        expect(codes(t)).toEqual(["not-checked"]);
        // Before go-live they count as checked and nobody else is let through.
        expect(run(tess, { mode: "LIVE", goLive: false })).toMatchObject({ eligible: true, notes: ["On test list"] });
        expect(codes(run(checked, { mode: "LIVE", goLive: false }))).toEqual(["not-on-test-list"]);
      });

      it("send phase: judged by the campaign's launch flag passed as goLive, whatever today's switch says", () => {
        // A live campaign launched before go-live (flag false), sending after go-live: still test-list only.
        const before = { mode: "LIVE" as const, phase: "send" as const, sendStep: 1, goLive: false, testListCountsAsChecked: true };
        expect(run(anna, before).reason?.code).toBe("not-on-test-list");
        expect(run(tess, before).eligible).toBe(true);
        // Launched after go-live (flag true): no test-list rule, and the test list doesn't count as checked.
        const after = { mode: "LIVE" as const, phase: "send" as const, sendStep: 0, goLive: true, testListCountsAsChecked: false };
        expect(codes(run(anna, after))).toEqual(["not-checked"]);
        expect(codes(run(tess, after))).toEqual(["not-checked"]);
        // Test mode at send: the test list for good, counted as checked.
        const test = { mode: "TEST" as const, phase: "send" as const, sendStep: 0, goLive: true, testListCountsAsChecked: true };
        expect(run(tess, test).eligible).toBe(true);
        expect(run(anna, test).reason).toMatchObject({ code: "not-on-test-list", text: NOT_ON_TEST_LIST_TEXT.test });
      });
    });

    it("respects a check result in every mode, following the verification policy", () => {
      const checked = (status: PersonFacts["verificationStatus"], risk: PersonFacts["verificationRisk"], over: Partial<PersonFacts> = {}) =>
        person({ verificationStatus: status, verificationRisk: risk, verifiedAt: NOW, verificationProvider: "mailgun", ...over });
      const run = (p: PersonFacts, c = ctx()) => evaluateEligibility({ company: company(), person: p, teamRule: null, ctx: c });
      expect(codes(run(checked("DO_NOT_SEND", "HIGH")))).toEqual(["check-do-not-send"]);
      expect(run(checked("CATCH_ALL", "LOW")).eligible).toBe(true);
      const medium = run(checked("CATCH_ALL", "MEDIUM"));
      expect(codes(medium)).toEqual(["policy-blocked"]);
      expect(medium.reason?.text).toBe("Can't confirm this address (medium risk); your check settings skip these");
      expect(codes(run(checked("VALID", "HIGH")))).toEqual(["policy-blocked"]);
      expect(codes(run(checked("RISKY", "HIGH")))).toEqual(["policy-blocked"]);
      // Unknown results now split (M5-DESIGN §2.8 rule 2): a first "no answer" waits for its re-check (a dry run
      // leaves it out, since dry runs never check again); a second one within 30 days can't be checked.
      const first = run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1 }));
      expect(codes(first)).toEqual(["check-waiting"]);
      expect(first.reason?.text).toBe("The address check got no answer. Dry runs don't check addresses again, so this person is left out.");
      const live = run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 1 }), ctx({ mode: "LIVE", goLive: true }));
      expect(live.reason).toMatchObject({
        code: "check-waiting",
        text: "Waiting for re-check: the address check got no answer, so it's checked again 24 hours later",
      });
      const twice = run(checked("UNKNOWN", "UNKNOWN", { verificationUnknowns: 2 }));
      expect(twice.reason).toMatchObject({ code: "check-unknown", text: "Couldn't be checked: the address check got no answer twice" });
      const skipped = run(checked("UNKNOWN", null), ctx({ policy: { ...DEFAULT_VERIFICATION_POLICY, unknown: "block" } }));
      expect(skipped.reason).toMatchObject({ code: "policy-blocked", text: "The address check got no answer; your check settings skip these" });
      const lenient = ctx({ policy: { ...DEFAULT_VERIFICATION_POLICY, catchAllMedium: "send", unknown: "send" } });
      expect(run(checked("CATCH_ALL", "MEDIUM"), lenient).eligible).toBe(true);
      expect(run(checked("UNKNOWN", null), lenient).eligible).toBe(true);
    });

    it("keeps the 'needs a check' codes pending in the draft: tickable, not blocking", () => {
      const draft = ctx({ mode: "LIVE", goLive: true, phase: "draft" });
      const r = evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: draft });
      expect(r.eligible).toBe(true);
      expect(r.blocking).toEqual([]);
      expect(r.pending).toEqual([{ code: "not-checked", text: "Address not checked yet", overridable: false, pending: true }]);
      expect(codes(r)).toEqual(["not-checked"]);
      expect(r.checkNeed).toBe("check");
      // The same person blocks at launch (the default phase).
      const launch = evaluateEligibility({ company: company(), person: person(), teamRule: null, ctx: { ...draft, phase: "launch" } });
      expect(launch).toMatchObject({ eligible: false, pending: [], checkNeed: "check", reason: { code: "not-checked" } });
      // Other reasons still block in the draft.
      const unsubscribed = evaluateEligibility({ company: company(), person: person({ unsubscribedAt: NOW }), teamRule: null, ctx: draft });
      expect(unsubscribed.reason?.code).toBe("unsubscribed");
      expect(unsubscribed.pending.map((p) => p.code)).toEqual(["not-checked"]);
    });
  });

  it("checkDecision follows the B6.9 table, and unknown setting values block", () => {
    const p = DEFAULT_VERIFICATION_POLICY;
    expect(checkDecision("VALID", "LOW", p)).toBe("send");
    expect(checkDecision("VALID", "MEDIUM", p)).toBe("send");
    expect(checkDecision("VALID", "HIGH", p)).toBe("block");
    expect(checkDecision("CATCH_ALL", "LOW", p)).toBe("send");
    expect(checkDecision("CATCH_ALL", "HIGH", p)).toBe("block");
    expect(checkDecision("UNKNOWN", null, p)).toBe("recheck");
    expect(checkDecision("INVALID", "HIGH", p)).toBe("undeliverable");
    expect(checkDecision("DO_NOT_SEND", null, p)).toBe("do-not-send");
    expect(checkDecision("CATCH_ALL", "LOW", { ...p, catchAllLow: "maybe" })).toBe("block");
  });

  it("never emails suppressed, unsubscribed, bounced or complained addresses", () => {
    const run = (p: PersonFacts) => evaluateEligibility({ company: company(), person: p, teamRule: null, ctx: ctx() });
    expect(codes(run(person({ suppression: "UNSUBSCRIBED" })))).toEqual(["unsubscribed"]);
    expect(codes(run(person({ unsubscribedAt: NOW, suppression: "UNSUBSCRIBED" })))).toEqual(["unsubscribed"]);
    expect(codes(run(person({ bouncedAt: NOW })))).toEqual(["bounced"]);
    expect(codes(run(person({ complainedAt: NOW })))).toEqual(["complained"]);
    const manual = run(person({ suppression: "MANUAL" }));
    expect(codes(manual)).toEqual(["suppressed"]);
    expect(manual.reason?.text).toBe("On the do-not-email list");
  });

  it("never emails Client, Not interested or Do not contact companies", () => {
    for (const status of ["CLIENT", "NOT_INTERESTED", "DO_NOT_CONTACT"] as const) {
      const r = evaluateEligibility({ company: company({ status }), person: person(), teamRule: null, ctx: ctx() });
      expect(r.reason).toMatchObject({ code: "company-status", overridable: false, status });
    }
  });

  it("leaves Replied companies out by default, but lets people include them by hand", () => {
    const replied = company({ status: "REPLIED" });
    const r = evaluateEligibility({ company: replied, person: person(), teamRule: null, ctx: ctx() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatchObject({ code: "company-replied", overridable: true });
    const overridden = evaluateEligibility({
      company: replied,
      person: person(),
      teamRule: null,
      recipient: { overrides: new Set(["company-replied"]) },
      ctx: ctx(),
    });
    expect(overridden.eligible).toBe(true);
    expect(codes(overridden)).toEqual(["company-replied"]); // still listed, just not blocking
    // An override never gets round the 30-day rule.
    const both = evaluateEligibility({
      company: replied,
      person: person(),
      teamRule: emailed,
      recipient: { overrides: new Set(["company-replied"]) },
      ctx: ctx(),
    });
    expect(both.reason?.code).toBe("team-rule");
  });

  it("reports the reservation, duplicates, hand exclusions and changed addresses", () => {
    const reserved: TeamRuleBlock = { kind: "reserved", text: "Waiting in Sara's campaign 'Norway prints'", campaignId: 3, campaignName: "Norway prints", ownerName: "Sara" };
    expect(evaluateEligibility({ company: company(), person: person(), teamRule: reserved, ctx: ctx() }).reason).toMatchObject({
      code: "reserved",
      text: "Waiting in Sara's campaign 'Norway prints'",
    });
    expect(codes(evaluateEligibility({ company: company(), person: person(), teamRule: null, recipient: { duplicate: true }, ctx: ctx() }))).toEqual([
      "duplicate",
    ]);
    expect(
      evaluateEligibility({ company: company(), person: person(), teamRule: null, recipient: { sentToNorm: "old@acme.de" }, ctx: ctx() }).reason?.code,
    ).toBe("email-changed");
    expect(
      evaluateEligibility({ company: company(), person: person(), teamRule: null, recipient: { sentToNorm: "anna@acme.de" }, ctx: ctx() }).eligible,
    ).toBe(true);
  });

  it("checks the sender's reply route for live campaigns only (Milestone 3)", () => {
    const p = person({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationProvider: "mailgun" });
    const live = ctx({ mode: "LIVE", goLive: true, senderHasReplyRoute: false, senderName: "Ali" });
    const r = evaluateEligibility({ company: company(), person: p, teamRule: null, ctx: live });
    expect(r.reason?.code).toBe("no-reply-route");
    expect(r.reason?.text).toBe("Ali has no working reply route yet, so replies couldn't reach them");
    expect(evaluateEligibility({ company: company(), person: p, teamRule: null, ctx: { ...live, mode: "DRY_RUN" } }).eligible).toBe(true);
  });

  it("sortReasons keeps the first of each code", () => {
    const sorted = sortReasons([
      { code: "team-rule", text: "b", overridable: false },
      { code: "no-email", text: "a", overridable: false },
      { code: "team-rule", text: "c", overridable: false },
    ]);
    expect(sorted.map((r) => r.text)).toEqual(["a", "b"]);
  });
});

describe("stop reasons", () => {
  it("stores the keys the company panel words nicely, else the sentence", () => {
    expect(stopReasonFor({ code: "unsubscribed", text: "Unsubscribed", overridable: false })).toBe("unsubscribed");
    expect(stopReasonFor({ code: "check-undeliverable", text: "x", overridable: false })).toBe("invalid");
    expect(stopReasonFor({ code: "company-status", text: "x", overridable: false, status: "CLIENT" })).toBe("status:CLIENT");
    expect(stopReasonFor({ code: "company-replied", text: "x", overridable: true, status: "REPLIED" })).toBe("status:REPLIED");
    expect(stopReasonFor({ code: "company-deleted", text: "x", overridable: false })).toBe("company_deleted");
    expect(stopReasonFor({ code: "team-rule", text: "Emailed by Ali 3 days ago (X, first email)", overridable: false })).toBe(
      "Emailed by Ali 3 days ago (X, first email)",
    );
  });
});

describe("overrides stored on the recipient", () => {
  it("reads them fail-safe", () => {
    expect([...readRecipientOverrides({ overrides: ["company-replied"] })]).toEqual(["company-replied"]);
    expect(readRecipientOverrides(null).size).toBe(0);
    expect(readRecipientOverrides([{ overrides: ["company-replied"] }]).size).toBe(0);
    expect(readRecipientOverrides({ overrides: "company-replied" }).size).toBe(0);
    expect(readRecipientOverrides({ overrides: ["team-rule", "nonsense"] }).size).toBe(0);
  });

  it("writes them without touching other keys", () => {
    const on = withRecipientOverride({ missing: 2 }, "company-replied", true);
    expect(on).toEqual({ missing: 2, overrides: ["company-replied"] });
    expect(withRecipientOverride(on, "company-replied", false)).toEqual({ missing: 2 });
    expect(withRecipientOverride(null, "company-replied", true)).toEqual({ overrides: ["company-replied"] });
  });
});
