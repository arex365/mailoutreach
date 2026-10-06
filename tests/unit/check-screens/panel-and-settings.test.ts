import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CheckSingleOutcome } from "@/core/verification/types";
import {
  checkButtonTip,
  checkConfirmText,
  checkedTodayTip,
  checkReasonLine,
  didYouMeanConfirm,
  didYouMeanText,
  panelCheckToast,
} from "@/components/checks/panel-check";
import {
  checkKeyStatusLine,
  checkSettingActivity,
  checkSettingsSchema,
  checkSettingsValuesFrom,
  checksThisMonthLine,
  testCheckResultView,
  testChecksIntro,
  type CheckSettingsInput,
} from "@/components/settings/checks/check-settings";
import { verificationTip } from "@/components/badges";

/**
 * The company panel's "Check" on one person (M5-DESIGN §6.5) and Settings › Deliverability "Address checks" (§2.4,
 * §6.6): tooltips, the confirmation, every toast per one-address outcome, the reason line and "Did you mean", the
 * settings' validation messages and small sentences, and the Settings test's result.
 */

const EMAIL = "anna@firma.de";
const checked = (over: Partial<CheckSingleOutcome>): CheckSingleOutcome => ({
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
const done = (single: CheckSingleOutcome | null) => ({ status: "DONE", single, error: null });

describe("the panel's Check button", () => {
  it("says who checks and what it costs", () => {
    expect(checkButtonTip({ practiceCopy: false, pricePerCheck: 0.012 })).toBe("Check this address with Mailgun (about $0.01)");
    expect(checkButtonTip({ practiceCopy: true, pricePerCheck: 0.012 })).toBe("Check this address with the test checker (free)");
    expect(checkButtonTip({ practiceCopy: false, pricePerCheck: 0 })).toBe("Check this address with Mailgun (free)");
    expect(checkConfirmText(EMAIL, { practiceCopy: false, pricePerCheck: 0.012 })).toBe("Check anna@firma.de? About $0.01.");
    expect(checkConfirmText(EMAIL, { practiceCopy: true, pricePerCheck: 0.012 })).toBe("Check anna@firma.de? Free with the test checker.");
    expect(checkedTodayTip(EMAIL)).toBe("anna@firma.de was checked today already.");
  });

  it("toasts each outcome of the run", () => {
    expect(panelCheckToast(EMAIL, done(checked({})))).toEqual({ tone: "success", text: "anna@firma.de can be emailed.", detail: null });
    expect(panelCheckToast(EMAIL, done(checked({ status: "CATCH_ALL", risk: "LOW" })))).toMatchObject({
      tone: "success",
      text: "anna@firma.de can't be confirmed, but it's low risk, so it can be emailed.",
    });
    expect(panelCheckToast(EMAIL, done(checked({ status: "CATCH_ALL", risk: "MEDIUM", decision: "block" })))).toMatchObject({
      tone: "info",
      text: "anna@firma.de can't be confirmed (medium risk). Your check settings skip it.",
    });
    // temp1@…: deliverable but throwaway.
    expect(panelCheckToast(EMAIL, done(checked({ disposable: true, decision: "block" })))).toMatchObject({
      tone: "info",
      text: "anna@firma.de is a throwaway address. Your check settings skip it.",
    });
    expect(panelCheckToast(EMAIL, done(checked({ status: "RISKY", risk: "HIGH", decision: "block" }))).text).toBe(
      "The check rated anna@firma.de high risk. Your check settings skip it.",
    );
    expect(panelCheckToast(EMAIL, done(checked({ status: "INVALID", risk: "HIGH", decision: "undeliverable" }))).text).toBe(
      "anna@firma.de doesn't exist. It's on the do-not-email list now.",
    );
    expect(panelCheckToast(EMAIL, done(checked({ status: "DO_NOT_SEND", risk: "HIGH", decision: "do-not-send" }))).text).toBe(
      "The check says not to email anna@firma.de. It's on the do-not-email list now.",
    );
    expect(panelCheckToast(EMAIL, done(checked({ status: "UNKNOWN", risk: "UNKNOWN", decision: "recheck" }))).text).toBe(
      "The check got no answer for anna@firma.de. It's tried again after 24 hours when this person is in a campaign.",
    );
    const refused = panelCheckToast(EMAIL, done(checked({ outcome: "refused", status: null, decision: null, detail: "[address] is not a valid address" })));
    expect(refused).toEqual({ tone: "error", text: "Mailgun couldn't check anna@firma.de.", detail: "[address] is not a valid address" });
    expect(panelCheckToast(EMAIL, done(checked({ outcome: "skipped", skipReason: "suppressed", status: null }))).text).toBe(
      "anna@firma.de is on the do-not-email list, so it wasn't checked.",
    );
    expect(panelCheckToast(EMAIL, done(checked({ outcome: "skipped", skipReason: "no-email", status: null }))).text).toBe("No email address to check.");
    expect(panelCheckToast(EMAIL, done(checked({ outcome: "not-reached", status: null })))).toEqual({
      tone: "error",
      text: "Mailgun didn't answer in time. Try again in a few minutes.",
      detail: null,
    });
    // The practice copy names the test checker.
    expect(panelCheckToast(EMAIL, done(checked({ outcome: "not-reached", status: null })), { practiceCopy: true }).text).toBe(
      "The test checker didn't answer in time. Try again in a few minutes.",
    );
    expect(panelCheckToast(EMAIL, { status: "FAILED", single: null, error: "Address checks need a Mailgun key." })).toEqual({
      tone: "error",
      text: "Address checks need a Mailgun key.",
      detail: null,
    });
    expect(panelCheckToast(EMAIL, { status: "CANCELLED", single: null, error: null }).text).toBe("The check of anna@firma.de was stopped before it finished.");
    expect(panelCheckToast(EMAIL, done(null)).text).toBe("The check has finished. Refresh the page to see the result.");
  });

  it("words the latest check's reasons under a result that isn't Valid", () => {
    expect(checkReasonLine("INVALID", ["mailbox_does_not_exist"])).toBe("This mailbox doesn't exist.");
    expect(checkReasonLine("CATCH_ALL", ["catch_all", "accept_all"])).toBe(
      "Their mail server accepts every address, so nobody can confirm this person exists.",
    );
    expect(checkReasonLine("UNKNOWN", ["smtp_timeout", "some_new_code"])).toBe("Their mail server didn't answer the check. some_new_code");
    expect(checkReasonLine("VALID", ["mailbox_is_role_address"])).toBeNull();
    expect(checkReasonLine(null, ["no_mx"])).toBeNull();
    expect(checkReasonLine("RISKY", [])).toBeNull();
  });

  it("offers a suggested address", () => {
    expect(didYouMeanText("anna@yahoo.com")).toBe("Did you mean anna@yahoo.com?");
    expect(didYouMeanConfirm("anna@yahoo.com")).toEqual({ title: "Change the address to anna@yahoo.com?", description: "It needs a new check afterwards." });
  });

  it("explains each badge in its tooltip", () => {
    expect(verificationTip(null)).toBe("This address hasn't been checked yet.");
    expect(verificationTip("CATCH_ALL")).toBe("The mail server accepts every address, so nobody can confirm this person exists.");
    expect(verificationTip("INVALID")).toBe("The address check says this address doesn't exist.");
    expect(verificationTip("UNKNOWN")).toBe("The address check got no answer.");
  });
});

describe("Settings › Deliverability › Address checks", () => {
  const good: CheckSettingsInput = {
    deliverableHighRisk: "block",
    catchAllLow: "send",
    catchAllMedium: "block",
    catchAllHigh: "block",
    disposable: "block",
    unknown: "recheck",
    pricePerCheck: "0.012",
    includedPerMonth: "0",
    maxAgeDays: "90",
    monthlyLimitUsd: "100",
    concurrency: "2",
  };
  const errors = (over: Partial<Record<keyof CheckSettingsInput, unknown>>) => {
    const res = checkSettingsSchema.safeParse({ ...good, ...over });
    return res.success ? {} : z.flattenError(res.error).fieldErrors;
  };

  it("accepts the defaults and reads typed numbers", () => {
    const res = checkSettingsSchema.parse({ ...good, pricePerCheck: "0,008", monthlyLimitUsd: " 250 " });
    expect(res).toMatchObject({ pricePerCheck: 0.008, monthlyLimitUsd: 250, maxAgeDays: 90, concurrency: 2, includedPerMonth: 0 });
    expect(checkSettingsSchema.parse({ ...good, pricePerCheck: 1, includedPerMonth: 1_000_000, maxAgeDays: 365, monthlyLimitUsd: 10_000, concurrency: 4 })).toBeTruthy();
  });

  it("says what to fix in plain words", () => {
    expect(errors({ pricePerCheck: "1.5" })).toEqual({ pricePerCheck: ["Enter a price from $0 to $1 per check."] });
    expect(errors({ pricePerCheck: "" })).toEqual({ pricePerCheck: ["Enter a price from $0 to $1 per check."] });
    expect(errors({ includedPerMonth: "2.5" })).toEqual({ includedPerMonth: ["Enter a whole number of checks, 0 or more."] });
    expect(errors({ includedPerMonth: "-1" })).toEqual({ includedPerMonth: ["Enter a whole number of checks, 0 or more."] });
    expect(errors({ maxAgeDays: "29" })).toEqual({ maxAgeDays: ["Choose between 30 and 365 days."] });
    expect(errors({ maxAgeDays: "400" })).toEqual({ maxAgeDays: ["Choose between 30 and 365 days."] });
    expect(errors({ monthlyLimitUsd: "0.5" })).toEqual({ monthlyLimitUsd: ["Enter an amount from $1 to $10,000."] });
    expect(errors({ monthlyLimitUsd: "20000" })).toEqual({ monthlyLimitUsd: ["Enter an amount from $1 to $10,000."] });
    expect(errors({ concurrency: "5" })).toEqual({ concurrency: ["Choose from 1 to 4 checks at the same time."] });
    expect(errors({ catchAllLow: "maybe" })).toEqual({ catchAllLow: ["Choose Send or Skip."] });
    expect(errors({ unknown: "send" })).toEqual({ unknown: ["Choose Check again after 24 hours or Skip."] });
    expect(errors({ provider: "zerobounce" })).toEqual({ provider: ["Address checks use Mailgun."] });
  });

  it("reads the stored settings, a policy from before Milestone 5 included", () => {
    const v = checkSettingsValuesFrom({
      "verification.policy": { deliverableHighRisk: "send", catchAllLow: "block", catchAllMedium: "block", catchAllHigh: "block", unknown: "block" },
      "verification.pricePerCheck": 0.008,
      "verification.includedPerMonth": 5000,
      "verification.maxAgeDays": "broken",
      "verification.monthlyLimitUsd": 150,
      "verification.concurrency": 3,
    });
    expect(v).toEqual({
      deliverableHighRisk: "send",
      catchAllLow: "block",
      catchAllMedium: "block",
      catchAllHigh: "block",
      disposable: "block",
      unknown: "block",
      pricePerCheck: 0.008,
      includedPerMonth: 5000,
      maxAgeDays: 90,
      monthlyLimitUsd: 150,
      concurrency: 3,
    });
  });

  it("writes the card's lines and the activity", () => {
    expect(checksThisMonthLine(412, 4.94, 100)).toBe("This month: 412 checks, $4.94 of your $100 limit.");
    expect(checksThisMonthLine(1, 0.012, 12.5)).toBe("This month: 1 check, $0.01 of your $12.50 limit.");
    expect(checkKeyStatusLine({ set: false }, "Asia/Karachi")).toBe("Uses your Mailgun key.");
    expect(
      checkKeyStatusLine({ set: true, last4: "1a2b", updatedAt: new Date("2026-10-03T08:00:00Z"), byName: "Arslan" }, "Asia/Karachi", new Date("2026-10-05T08:00:00Z")),
    ).toBe("Own key ending …1a2b, saved 3 Oct by Arslan.");
    const values = checkSettingsValuesFrom({
      "verification.policy": null,
      "verification.pricePerCheck": 0.012,
      "verification.includedPerMonth": 5000,
      "verification.maxAgeDays": 60,
      "verification.monthlyLimitUsd": 150,
      "verification.concurrency": 3,
    });
    expect(checkSettingActivity("Arslan", "verification.monthlyLimitUsd", values)).toBe("Arslan set the monthly limit for address checks to $150");
    expect(checkSettingActivity("Arslan", "verification.policy", values)).toBe("Arslan changed which address check results are emailed");
    expect(checkSettingActivity("Arslan", "verification.includedPerMonth", values)).toBe(
      "Arslan set the checks included in the Mailgun plan to 5,000 a month",
    );
    expect(checkSettingActivity("Arslan", "verification.maxAgeDays", values)).toBe("Arslan set address check results to count for 60 days");
  });

  it("words the Settings test and its result", () => {
    expect(testChecksIntro({ practiceCopy: false, pricePerCheck: 0.012 })).toBe(
      "Checks one address with Mailgun, so you can see that checks work. It costs about $0.01. The result isn't saved on any person.",
    );
    expect(testChecksIntro({ practiceCopy: true, pricePerCheck: 0.012 })).toMatch(/^Checks one address with the free test checker/);
    expect(testCheckResultView(done(checked({})))).toEqual({
      tone: "good",
      text: "Checked in 1.4 s: can be emailed (deliverable, low risk).",
      detail: null,
    });
    expect(testCheckResultView(done(checked({ status: "INVALID", risk: "HIGH", decision: "undeliverable" }))).text).toBe(
      "Checked in 1.4 s: doesn't exist. It wasn't added to the do-not-email list.",
    );
    expect(testCheckResultView(done(checked({ outcome: "refused", status: null, detail: "Mailgun's words" })))).toEqual({
      tone: "error",
      text: "Mailgun couldn't check this address.",
      detail: "Mailgun's words",
    });
    expect(testCheckResultView({ status: "FAILED", single: null, error: "Address checks need a Mailgun key." }).text).toBe(
      "Address checks need a Mailgun key.",
    );
  });
});
