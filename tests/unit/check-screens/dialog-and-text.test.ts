import { describe, expect, it } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { NOT_PAUSED_CHECKS } from "@/core/system-state-parse";
import { checksDialogModel } from "@/components/checks/dialog-model";
import {
  dateAtTimeText,
  deferredRunText,
  dialogRunningText,
  runProgressText,
  stopRunText,
  waitingText,
  whenText,
} from "@/components/checks/run-text";
import { launchPhaseCounts, secondCheckLaunchLine, uncheckedLaunchLine } from "@/components/checks/schedule-note";
import type { ChecksDialogView } from "@/components/checks/types";

/**
 * The Contacts and list "Check email addresses" dialog (M5-DESIGN §6.3), the small run sentences shared by the check
 * screens, and the Schedule step's address-check note and launch-phase counts (§6.1).
 */

function estimate(count: number, over: Partial<Parameters<typeof estimateChecks>[0]> = {}) {
  return estimateChecks({ count, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun", ...over });
}

function view(over: Partial<ChecksDialogView> = {}): ChecksDialogView {
  return {
    companies: 37,
    addresses: 52,
    need: 40,
    recent: 8,
    wait: 2,
    cannot: 2,
    estimate: estimate(40),
    allEstimate: estimate(50),
    monthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
    allMonthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
    notReady: null,
    pause: { ...NOT_PAUSED_CHECKS },
    listName: null,
    maxAgeDays: 90,
    practiceCopy: false,
    isOwner: true,
    timeZone: "Asia/Karachi",
    ...over,
  };
}

describe("the Check email addresses dialog", () => {
  it("counts the ticked companies' addresses, with the cost and Check these again too", () => {
    const m = checksDialogModel(view(), false);
    expect(m.countsLine).toBe("37 companies · 52 addresses");
    expect(m.lines.map((l) => l.text)).toEqual([
      "40 need a check",
      "8 were checked in the last 90 days",
      "2 got no answer less than 24 hours ago; they can be checked again after that.",
      "2 can't be checked: no email address, on the do-not-email list, or never emailed (company status).",
    ]);
    expect(m.recheck).toEqual({ label: "Check these again too (10)", count: 10 });
    expect(m).toMatchObject({ count: 40, canStart: true, startLabel: "Check 40 addresses", nothing: null, blocker: null });
    expect(m.costLine).toBe("Cost: about $0.48 (40 checks × $0.012). Up to $0.02 more if some need a second check tomorrow.");

    const again = checksDialogModel(view(), true);
    expect(again).toMatchObject({ count: 50, startLabel: "Check 50 addresses" });
    expect(again.costLine).toBe("Cost: about $0.60 (50 checks × $0.012). Up to $0.04 more if some need a second check tomorrow.");
  });

  it("names the list and words one of each", () => {
    const m = checksDialogModel(
      view({ listName: "Germany Q4", companies: 1, addresses: 1, need: 1, recent: 1, wait: 1, cannot: 1, maxAgeDays: 60, estimate: estimate(1) }),
      false,
    );
    expect(m.countsLine).toBe("Germany Q4 · 1 company · 1 address");
    expect(m.lines.map((l) => l.text)).toEqual([
      "1 needs a check",
      "1 was checked in the last 60 days",
      "1 got no answer less than 24 hours ago; it can be checked again after that.",
      "1 can't be checked: no email address, on the do-not-email list, or never emailed (company status).",
    ]);
    expect(m.startLabel).toBe("Check 1 address");
  });

  it("has nothing to check until Check these again too is ticked", () => {
    const v = view({ need: 0, estimate: estimate(0), allEstimate: estimate(10) });
    const m = checksDialogModel(v, false);
    expect(m).toMatchObject({ nothing: "Every address here was checked in the last 90 days.", canStart: false, costLine: null, startLabel: "Check addresses" });
    expect(checksDialogModel(v, true)).toMatchObject({ nothing: null, canStart: true, count: 10 });
    expect(checksDialogModel(view({ need: 0, recent: 0, wait: 0, cannot: 3, addresses: 3, estimate: estimate(0) }), false).nothing).toBe(
      "None of these addresses can be checked.",
    );
    expect(checksDialogModel(view({ need: 0, recent: 0, wait: 0, cannot: 0, addresses: 0, estimate: estimate(0) }), false).nothing).toBe(
      "These companies have no email addresses to check.",
    );
  });

  it("refuses too many, over the monthly limit, paused and not ready", () => {
    const many = checksDialogModel(view({ need: 7_210, estimate: estimate(7_210) }), false);
    expect(many).toMatchObject({ blocker: "That's 7,210 addresses. Check at most 5,000 at a time: tick fewer companies.", canStart: false });

    const over = { monthly: { limitUsd: 100, spentUsd: 91.2, wouldPass: true } };
    expect(checksDialogModel(view(over), false).blocker).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    expect(checksDialogModel(view({ ...over, isOwner: false }), false).blocker).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Ask the Owner to raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    // Only the recheck estimate passes the limit: ticking the box is what stops it.
    const allOver = view({ allMonthly: { limitUsd: 0.5, spentUsd: 0, wouldPass: true } });
    expect(checksDialogModel(allOver, false).canStart).toBe(true);
    expect(checksDialogModel(allOver, true).canStart).toBe(false);

    const paused = checksDialogModel(view({ pause: { ...NOT_PAUSED_CHECKS, paused: true, kind: "payment", text: "Address checks paused: billing." } }), false);
    expect(paused).toMatchObject({ blocker: "Address checks paused: billing.", canStart: false });
    const notReady = checksDialogModel(view({ notReady: "Address checks need a Mailgun key." }), false);
    expect(notReady).toMatchObject({ blocker: "Address checks need a Mailgun key.", canStart: false });
  });

  it("is free with the test checker in the practice copy", () => {
    const m = checksDialogModel(view({ practiceCopy: true, estimate: estimate(40, { provider: "fake" }) }), false);
    expect(m.costLine).toBe("Cost: free (the test checker is used here).");
  });
});

describe("run sentences", () => {
  const NOW = new Date("2026-09-23T08:00:00Z");
  it("says when, in the viewer's zone", () => {
    const at = new Date("2026-09-23T09:05:00Z");
    expect(whenText(at, "Asia/Karachi", NOW)).toBe("14:05");
    expect(whenText(at, "Europe/Berlin", NOW)).toBe("11:05");
    expect(whenText(new Date("2026-09-27T09:05:00Z"), "Asia/Karachi", NOW)).toBe("27 Sept at 14:05");
    expect(dateAtTimeText(at, "Asia/Karachi", NOW)).toBe("23 Sept at 14:05");
    expect(waitingText(at.toISOString(), "Asia/Karachi", NOW)).toBe("Waiting: some checks will be tried again at 14:05.");
    expect(deferredRunText({ waitingUntil: at.toISOString(), summary: "Paused: Address checks paused: billing." }, "Asia/Karachi", NOW)).toBe(
      "Paused: Address checks paused: billing.",
    );
  });

  it("counts progress and what Stop leaves unchecked", () => {
    expect(runProgressText(12, 40)).toBe("12 of 40 checked");
    expect(runProgressText(0, 0)).toBe("Starting the checks…");
    expect(runProgressText(1_200, 5_000)).toBe("1,200 of 5,000 checked");
    expect(stopRunText(12, 40)).toBe("The 28 addresses not checked yet stay unchecked, and those people are left out when you launch.");
    expect(dialogRunningText(40, 12)).toBe("Checking 40 addresses: 12 done.");
    expect(dialogRunningText(1, 0)).toBe("Checking 1 address: 0 done.");
  });
});

describe("the Schedule step's check note (launch phase)", () => {
  it("says who launch leaves out and who waits for a second check", () => {
    expect(uncheckedLaunchLine(40)).toBe("40 people with unchecked addresses will be left out when you launch.");
    expect(uncheckedLaunchLine(1)).toBe("1 person with an unchecked address will be left out when you launch.");
    expect(uncheckedLaunchLine(0)).toBeNull();
    expect(secondCheckLaunchLine(2)).toBe("2 people wait for a second address check. Their first email goes out once it passes.");
    expect(secondCheckLaunchLine(1)).toBe("1 person waits for a second address check. Their first email goes out once it passes.");
    expect(secondCheckLaunchLine(0)).toBeNull();
  });

  it("counts people and today's fit without the unchecked ones", () => {
    const summary = { people: 120, today: { left: 100 }, fits: { today: 100, later: 20 } };
    expect(launchPhaseCounts(summary, { unchecked: 40, secondCheck: 2 })).toEqual({ people: 80, fits: { today: 80, later: 0 } });
    expect(launchPhaseCounts(summary, { unchecked: 0, secondCheck: 0 })).toEqual({ people: 120, fits: { today: 100, later: 20 } });
    expect(launchPhaseCounts({ ...summary, today: { left: 30 } }, { unchecked: 40, secondCheck: 0 })).toEqual({ people: 80, fits: { today: 30, later: 50 } });
    // No limit applies (test mode, dry runs on real data).
    expect(launchPhaseCounts({ people: 10, today: null, fits: null }, { unchecked: 12, secondCheck: 0 })).toEqual({ people: 0, fits: null });
  });
});
