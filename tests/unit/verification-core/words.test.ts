import { describe, expect, it } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { emptyCheckRunCounts } from "@/core/verification/policy";
import type { CheckRunCounts, CheckSingleOutcome } from "@/core/verification/types";
import {
  checkCostLine,
  checkFinishedTitle,
  checkOutcomeToast,
  checkPauseText,
  checkPauseTitle,
  checkResultWords,
  checkRunActivity,
  checkRunDoneLines,
  checkRunSummary,
  checkStartToast,
  checkTestResultText,
  checkVerdictDetail,
  checkedTodayText,
  leftOutWords,
  monthlyLimitRefusal,
  pricePerCheckText,
  reasonWords,
  recheckLeftOutNotice,
  tooManyChecksText,
  usdAmountText,
} from "@/core/verification/words";

/** Every sentence about address checks (M5-DESIGN §2.3, §2.9–§2.12, §6.1, §6.5, §6.6, §9.3 Part B). */

function counts(over: Partial<CheckRunCounts> = {}): CheckRunCounts {
  return { ...emptyCheckRunCounts(), ...over };
}

/** The §2.11 example run. */
const EXAMPLE = counts({ checked: 40, canEmail: 33, invalid: 2, risky: 1, catchAllBlocked: 2, disposable: 1, unknown: 1, costUsd: 0.48 });

describe("checkRunSummary (§2.11)", () => {
  it("writes the example sentence, parts in order, zero parts left out", () => {
    expect(checkRunSummary(EXAMPLE)).toBe(
      "40 addresses checked: 33 can be emailed, 2 don't exist, 1 is rated high risk, 2 can't be confirmed, 1 is a throwaway address, 1 got no answer. Cost $0.48.",
    );
  });

  it("writes the §9.3 Part B sentence exactly", () => {
    const partB = counts({
      checked: 12,
      canEmail: 5,
      lowRiskCatchAll: 1,
      invalid: 1,
      doNotSend: 1,
      risky: 1,
      catchAllBlocked: 1,
      disposable: 1,
      unknown: 2,
      costUsd: 0.144,
    });
    expect(checkRunSummary(partB)).toBe(
      "12 addresses checked: 5 can be emailed, 1 doesn't exist, 1 shouldn't be emailed, 1 is rated high risk, 1 can't be confirmed, 1 is a throwaway address, 2 got no answer. Cost $0.14.",
    );
  });

  it("pluralises every part", () => {
    expect(checkRunSummary(counts({ checked: 1, canEmail: 1, costUsd: 0.012 }))).toBe("1 address checked: 1 can be emailed. Cost $0.01.");
    expect(
      checkRunSummary(counts({ checked: 7, invalid: 1, doNotSend: 2, risky: 2, catchAllBlocked: 1, disposable: 1, costUsd: 0.084 })),
    ).toBe(
      "7 addresses checked: 1 doesn't exist, 2 shouldn't be emailed, 2 are rated high risk, 1 can't be confirmed, 1 is a throwaway address. Cost $0.08.",
    );
    expect(checkRunSummary(counts({ checked: 3, disposable: 3 }))).toBe("3 addresses checked: 3 are throwaway addresses. Cost $0.");
    expect(checkRunSummary(counts({ checked: 1_200, canEmail: 1_200, costUsd: 14.4 }))).toBe("1,200 addresses checked: 1,200 can be emailed. Cost $14.40.");
  });

  it("adds who couldn't be checked right now, and that some may have been charged", () => {
    expect(checkRunSummary(counts({ checked: 2, canEmail: 2, refused: 1, notReached: 2, costUsd: 0.024 }))).toBe(
      "2 addresses checked: 2 can be emailed. 3 couldn't be checked right now. Cost $0.02.",
    );
    expect(checkRunSummary(counts({ checked: 2, canEmail: 2, notReached: 2, mayBeCharged: 1, costUsd: 0.024 }))).toBe(
      "2 addresses checked: 2 can be emailed. 2 couldn't be checked right now. Some of them may have been charged. Cost $0.02.",
    );
    expect(checkRunSummary(counts({ notReached: 1, mayBeCharged: 1 }))).toBe(
      "No addresses were checked. 1 couldn't be checked right now. It may have been charged. Cost $0.",
    );
  });

  it("says when nothing was checked", () => {
    expect(checkRunSummary(counts())).toBe("No addresses were checked. Cost $0.");
  });
});

describe("checkRunActivity", () => {
  it("names the requester, the campaign and the first three parts, with no dates", () => {
    expect(checkRunActivity("Ali", EXAMPLE, "Germany Q4")).toBe(
      "Ali checked 40 addresses for Germany Q4: 33 can be emailed, 2 don't exist, 1 is rated high risk.",
    );
    expect(checkRunActivity("Sara", counts({ checked: 1, unknown: 1 }), null)).toBe("Sara checked 1 address: 1 got no answer.");
    expect(checkRunActivity("Sara", counts(), null)).toBe("Sara checked no addresses.");
  });
});

describe("checkRunDoneLines (§6.1)", () => {
  it("writes one line per non-zero part, then the cost", () => {
    const c = counts({
      checked: 43,
      canEmail: 33,
      lowRiskCatchAll: 2,
      invalid: 2,
      doNotSend: 1,
      risky: 1,
      catchAllBlocked: 2,
      disposable: 1,
      unknown: 1,
      refused: 1,
      notReached: 2,
      mayBeCharged: 1,
      costUsd: 0.48,
    });
    expect(checkRunDoneLines(c)).toEqual([
      "33 can be emailed (2 of them can't be confirmed but are low risk).",
      "2 don't exist. They're left out and on the do-not-email list now.",
      "1 shouldn't be emailed: the check says not to. It's left out and on the do-not-email list now.",
      "1 is rated high risk. Your check settings skip these.",
      "2 can't be confirmed. Your check settings skip these.",
      "1 is a throwaway address. Your check settings skip these.",
      "1 got no answer. It's checked again 24 hours after the first try, and emailed if it passes.",
      "1 couldn't be checked: Mailgun refused it. That person is left out.",
      "2 couldn't be checked right now. They're left out at launch unless you check them again. Mailgun may have charged for some of them.",
      "Cost $0.48.",
    ]);
  });

  it("pluralises the other way round", () => {
    const c = counts({ checked: 9, canEmail: 1, lowRiskCatchAll: 1, invalid: 1, doNotSend: 2, risky: 2, disposable: 2, unknown: 2, refused: 2, notReached: 1 });
    expect(checkRunDoneLines(c)).toEqual([
      "1 can be emailed (it can't be confirmed but is low risk).",
      "1 doesn't exist. It's left out and on the do-not-email list now.",
      "2 shouldn't be emailed: the check says not to. They're left out and on the do-not-email list now.",
      "2 are rated high risk. Your check settings skip these.",
      "2 are throwaway addresses. Your check settings skip these.",
      "2 got no answer. They're checked again 24 hours after the first try, and emailed if they pass.",
      "2 couldn't be checked: Mailgun refused them. Those people are left out.",
      "1 couldn't be checked right now. It's left out at launch unless you check it again.",
      "Cost $0.",
    ]);
    expect(checkRunDoneLines(counts({ checked: 3, canEmail: 3, lowRiskCatchAll: 1 }))[0]).toBe(
      "3 can be emailed (1 of them can't be confirmed but is low risk).",
    );
    expect(checkRunDoneLines(counts())).toEqual(["No addresses were checked.", "Cost $0."]);
  });

  it("Contacts and list runs (no campaign) promise no re-check, email or launch", () => {
    const c = counts({
      checked: 11,
      canEmail: 5,
      invalid: 2,
      doNotSend: 1,
      unknown: 3,
      refused: 1,
      notReached: 2,
      mayBeCharged: 1,
      costUsd: 0.132,
    });
    const lines = checkRunDoneLines(c, { inCampaign: false });
    expect(lines).toEqual([
      "5 can be emailed.",
      "2 don't exist. They're on the do-not-email list now.",
      "1 shouldn't be emailed: the check says not to. It's on the do-not-email list now.",
      "3 got no answer. They're tried again after 24 hours when these people are in a campaign.",
      "1 couldn't be checked: Mailgun refused it.",
      "2 couldn't be checked right now. You can check them again later. Mailgun may have charged for some of them.",
      "Cost $0.13.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/emailed if|left out|at launch/);
    expect(checkRunDoneLines(counts({ checked: 1, unknown: 1, invalid: 1, notReached: 1 }), { inCampaign: false })).toEqual([
      "1 doesn't exist. It's on the do-not-email list now.",
      "1 got no answer. It's tried again after 24 hours when this person is in a campaign.",
      "1 couldn't be checked right now. You can check it again later.",
      "Cost $0.",
    ]);
    // The Verify step's lines stay as they were (its run belongs to a campaign).
    expect(checkRunDoneLines(counts({ checked: 1, unknown: 1 }), { inCampaign: true })).toEqual(checkRunDoneLines(counts({ checked: 1, unknown: 1 })));
  });
});

describe("checkCostLine (§2.10)", () => {
  const base = { pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" };

  it("paid", () => {
    expect(checkCostLine(estimateChecks({ ...base, count: 40 }))).toBe(
      "Cost: about $0.48 (40 checks × $0.012). Up to $0.02 more if some need a second check tomorrow.",
    );
    expect(checkCostLine(estimateChecks({ ...base, count: 1 }))).toBe(
      "Cost: about $0.01 (1 check × $0.012). Up to $0.01 more if some need a second check tomorrow.",
    );
  });

  it("partly free", () => {
    expect(checkCostLine(estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 4_990 }))).toBe(
      "Cost: about $0.36 (30 checks × $0.012; 10 are included in your plan). Up to $0.02 more if some need a second check tomorrow.",
    );
    expect(checkCostLine(estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 4_999 }))).toContain(
      "(39 checks × $0.012; 1 is included in your plan)",
    );
  });

  it("all included, and the test checker", () => {
    expect(checkCostLine(estimateChecks({ ...base, count: 40, includedPerMonth: 5_000, usedThisMonth: 840 }))).toBe(
      "Cost: free (40 of the 5,000 checks your Mailgun plan includes this month; 4,120 left).",
    );
    expect(checkCostLine(estimateChecks({ ...base, count: 40, provider: "fake" }))).toBe("Cost: free (the test checker is used here).");
    expect(checkCostLine(estimateChecks({ ...base, count: 0 }))).toBe("Cost: $0 (nothing to check).");
  });

  it("formats prices and limits with their real precision", () => {
    expect(pricePerCheckText(0.012)).toBe("$0.012");
    expect(pricePerCheckText(0.01)).toBe("$0.01");
    expect(pricePerCheckText(1)).toBe("$1");
    expect(usdAmountText(100)).toBe("$100");
    expect(usdAmountText(12.5)).toBe("$12.50");
    expect(usdAmountText(10_000)).toBe("$10,000");
  });
});

describe("one address", () => {
  const email = "anna@firma.de";
  const single = (over: Partial<CheckSingleOutcome>): CheckSingleOutcome => ({
    personId: 1,
    outcome: "checked",
    skipReason: null,
    status: "VALID",
    risk: "LOW",
    disposable: false,
    decision: "send",
    ms: 1_400,
    detail: null,
    ...over,
  });

  it("toasts every outcome of the panel's check (§6.5)", () => {
    const cases: Array<[Partial<CheckSingleOutcome>, string]> = [
      [{}, "anna@firma.de can be emailed."],
      [{ status: "CATCH_ALL", risk: "LOW" }, "anna@firma.de can't be confirmed, but it's low risk, so it can be emailed."],
      [{ status: "CATCH_ALL", risk: "MEDIUM", decision: "block" }, "anna@firma.de can't be confirmed (medium risk). Your check settings skip it."],
      [{ disposable: true, decision: "block" }, "anna@firma.de is a throwaway address. Your check settings skip it."],
      [{ status: "RISKY", risk: "HIGH", decision: "block" }, "The check rated anna@firma.de high risk. Your check settings skip it."],
      [{ status: "INVALID", risk: "HIGH", decision: "undeliverable" }, "anna@firma.de doesn't exist. It's on the do-not-email list now."],
      [{ status: "DO_NOT_SEND", risk: "HIGH", decision: "do-not-send" }, "The check says not to email anna@firma.de. It's on the do-not-email list now."],
      [
        { status: "UNKNOWN", risk: "UNKNOWN", decision: "recheck" },
        "The check got no answer for anna@firma.de. It's tried again after 24 hours when this person is in a campaign.",
      ],
      [{ status: "UNKNOWN", risk: "UNKNOWN", decision: "block" }, "The check got no answer for anna@firma.de. Your check settings skip these."],
      [{ outcome: "refused", status: null, decision: null, detail: "Invalid address" }, "Mailgun couldn't check anna@firma.de."],
      [{ outcome: "skipped", skipReason: "suppressed", status: null, decision: null }, "anna@firma.de is on the do-not-email list, so it wasn't checked."],
      [{ outcome: "skipped", skipReason: "no-email", status: null, decision: null }, "No email address to check."],
      [
        { outcome: "skipped", skipReason: "never-emailed", status: null, decision: null },
        "anna@firma.de wasn't checked: its company is never emailed (Client, Not interested or Do not contact).",
      ],
      [{ outcome: "not-reached", status: null, decision: null }, "Mailgun didn't answer in time. Try again in a few minutes."],
    ];
    for (const [over, text] of cases) expect(checkOutcomeToast(email, single(over))).toBe(text);
  });

  it("names the test checker instead of Mailgun in the practice copy", () => {
    expect(checkOutcomeToast(email, single({ outcome: "refused" }), { practiceCopy: true })).toBe("The test checker couldn't check anna@firma.de.");
    expect(checkOutcomeToast(email, single({ outcome: "not-reached" }), { practiceCopy: true })).toBe(
      "The test checker didn't answer in time. Try again in a few minutes.",
    );
    expect(checkOutcomeToast(email, single({}), { practiceCopy: true })).toBe("anna@firma.de can be emailed.");
  });

  it("words the Settings test with the time, and never puts the address on the do-not-email list", () => {
    expect(checkTestResultText(single({}))).toBe("Checked in 1.4 s: can be emailed (deliverable, low risk).");
    expect(checkTestResultText(single({ status: "INVALID", risk: "HIGH", decision: "undeliverable" }))).toBe(
      "Checked in 1.4 s: doesn't exist. It wasn't added to the do-not-email list.",
    );
    expect(checkTestResultText(single({ status: "DO_NOT_SEND", risk: "HIGH", decision: "do-not-send", ms: 30 }))).toBe(
      "Checked in 0.1 s: shouldn't be emailed. It wasn't added to the do-not-email list.",
    );
    expect(checkTestResultText(single({ status: "CATCH_ALL", risk: "MEDIUM", decision: "block", ms: null }))).toBe(
      "Checked: can't be confirmed (medium risk), skipped by your check settings (catch-all, medium risk).",
    );
    expect(checkTestResultText(single({ outcome: "refused" }))).toBe("Mailgun couldn't check this address.");
  });

  it("says a result in a few words", () => {
    expect(checkResultWords({ status: "VALID", risk: "MEDIUM", disposable: false, decision: "send" })).toBe("can be emailed");
    expect(checkResultWords({ status: "INVALID", risk: "HIGH", disposable: false, decision: "undeliverable" })).toBe("doesn't exist");
    expect(checkResultWords({ status: "DO_NOT_SEND", risk: null, disposable: false, decision: "do-not-send" })).toBe("shouldn't be emailed");
    expect(checkResultWords({ status: "UNKNOWN", risk: null, disposable: false, decision: "recheck" })).toBe("got no answer");
    expect(checkResultWords({ status: "VALID", risk: "LOW", disposable: true, decision: "block" })).toBe(
      "a throwaway address, skipped by your check settings",
    );
    expect(checkResultWords({ status: "RISKY", risk: "HIGH", disposable: false, decision: "block" })).toBe(
      "rated high risk, skipped by your check settings",
    );
    expect(checkVerdictDetail("VALID", "LOW")).toBe("deliverable, low risk");
    expect(checkVerdictDetail("VALID", null)).toBe("deliverable, risk unknown");
    expect(checkVerdictDetail("UNKNOWN", "UNKNOWN")).toBe("unknown");
    expect(leftOutWords("invalid")).toBe("doesn't exist");
    expect(leftOutWords("couldnt-check")).toBe("couldn't be checked");
  });
});

describe("reason words (§2.3)", () => {
  it("words the known codes and shows any other one as received", () => {
    expect(reasonWords("mailbox_does_not_exist")).toBe("This mailbox doesn't exist.");
    expect(reasonWords("No MX host found")).toBe("This domain can't receive email.");
    expect(reasonWords("accept_all")).toBe("Their mail server accepts every address, so nobody can confirm this person exists.");
    expect(reasonWords("long_term_disposable")).toBe("A throwaway address.");
    expect(reasonWords("failed custom grammar check")).toBe("The address breaks the provider's rules.");
    expect(reasonWords("app:unreadable_response")).toBe("Mailgun's answer couldn't be read.");
    expect(reasonWords("brand_new_code")).toBe("brand_new_code");
    expect(reasonWords("toString")).toBe("toString");
  });
});

describe("notices, refusals and pauses", () => {
  it("words the recheck notice to a campaign's sender (§2.11, §9.3 Part B)", () => {
    expect(recheckLeftOutNotice("Germany Q4", 1, 1)).toEqual({
      title: "Left out after a second address check",
      body: "1 person in Germany Q4 was left out: their address couldn't be checked. 1 other passed and gets their first email.",
    });
    expect(recheckLeftOutNotice("Germany Q4", 3, 2).body).toBe(
      "3 people in Germany Q4 were left out: their addresses couldn't be checked. 2 others passed and get their first email.",
    );
    expect(recheckLeftOutNotice("Germany Q4", 1, 0).body).toBe("1 person in Germany Q4 was left out: their address couldn't be checked.");
  });

  it("words the monthly limit refusal for the Owner and for a Member (§2.9)", () => {
    expect(monthlyLimitRefusal({ limitUsd: 100, spentUsd: 91.2, isOwner: true })).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    expect(monthlyLimitRefusal({ limitUsd: 100, spentUsd: 91.2, isOwner: false })).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Ask the Owner to raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
  });

  it("words the pauses (§2.12)", () => {
    expect(checkPauseText("monthly_limit", { limitUsd: 100, resetLabel: "1 November" })).toBe(
      "Address checks stopped: this month's check limit of $100 is reached. Raise it in Settings › Deliverability or wait until 1 November.",
    );
    expect(checkPauseText("unreadable")).toBe("Address checks paused: Mailgun's answers couldn't be read. Run update.bat, then click Resume checks.");
    expect(checkPauseText("auth")).toContain("Mailgun didn't accept the key. In Mailgun, open API Security");
    expect(checkPauseText("payment")).toBe(
      "Address checks paused: Mailgun refused address checks for a billing or plan reason. Check Billing in Mailgun, then click Resume checks.",
    );
    expect(checkPauseText("not-allowed")).toContain("won't run address checks on this account right now");
    expect(checkPauseText("business-verification")).toContain("until business verification is finished");
    expect(checkPauseText("not-found")).toBe("Address checks paused: Mailgun didn't recognise the check request. Run update.bat, then click Resume checks.");
    expect(checkPauseTitle("monthly_limit")).toBe("Address checks stopped");
    expect(checkPauseTitle("auth")).toBe("Address checks paused");
  });

  it("words the rest", () => {
    expect(checkFinishedTitle("Germany Q4")).toBe("Address checks finished for Germany Q4");
    expect(checkFinishedTitle(null)).toBe("Address checks finished");
    expect(checkStartToast(40)).toBe("Checking 40 addresses. You'll get a notification when it's done.");
    expect(tooManyChecksText(7_210)).toBe("That's 7,210 addresses. Check at most 5,000 at a time: tick fewer companies.");
    expect(checkedTodayText("anna@firma.de")).toBe("anna@firma.de was checked today already.");
  });
});
