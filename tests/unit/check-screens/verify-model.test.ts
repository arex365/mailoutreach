import { describe, expect, it } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { emptyCheckRunCounts } from "@/core/verification/policy";
import type { CheckRunCounts } from "@/core/verification/types";
import { NOT_PAUSED_CHECKS } from "@/core/system-state-parse";
import {
  continueWithoutText,
  verifyMonthlyText,
  verifyStepModel,
  type VerifyModelInput,
  type VerifyRunInfo,
} from "@/components/checks/verify-model";
import type { CampaignCheckView } from "@/server/services/verification/select";

/**
 * The wizard's step 4 "Verify" in every state of M5-DESIGN §6.1, as the model the screen draws: before go-live, dry
 * runs (incl. the practice copy), needs checks (the split lines and the cost line variants), too many, over the
 * monthly limit (Owner and Member), queued behind another run, running, waiting, paused (Owner and Member, both with
 * Stop), done and not ready.
 */

const NOW = new Date("2026-09-23T08:00:00Z"); // 13:00 in Karachi
const TZ = "Asia/Karachi";

function estimate(count: number, over: Partial<Parameters<typeof estimateChecks>[0]> = {}) {
  return estimateChecks({ count, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun", ...over });
}

function view(over: Partial<CampaignCheckView> = {}): CampaignCheckView {
  return {
    mode: "LIVE",
    goLive: true,
    practiceCopy: false,
    notReady: null,
    pause: { ...NOT_PAUSED_CHECKS },
    need: { total: 40, notChecked: 32, tooOld: 6, testChecker: 2, secondCheck: 0 },
    tooMany: false,
    waiting: 0,
    fine: 112,
    estimate: estimate(40),
    monthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
    run: null,
    leftOutByChecks: [],
    optional: null,
    ...over,
  };
}

function model(v: CampaignCheckView, over: Partial<VerifyModelInput> = {}) {
  return verifyStepModel({ view: v, run: v.run, lastRun: null, isOwner: true, maxAgeDays: 90, timeZone: TZ, now: NOW, ...over });
}

function run(over: Partial<VerifyRunInfo> = {}): VerifyRunInfo {
  return { jobId: 7, status: "RUNNING", done: 12, total: 40, summary: null, waitingUntil: null, blockedByOtherRun: false, ...over };
}

function counts(over: Partial<CheckRunCounts>): CheckRunCounts {
  return { ...emptyCheckRunCounts(), ...over };
}

describe("before go-live and dry runs", () => {
  it("has nothing to check for test and live campaigns before go-live", () => {
    // Test mode only ever emails the test list (M6-DESIGN §2.7), so its sentence doesn't mention going live.
    const lines = {
      TEST: "Test mode only emails your test list, and those addresses count as checked.",
      LIVE: "Until you go live, only your test-list addresses get email, and they count as checked.",
    } as const;
    for (const mode of ["TEST", "LIVE"] as const) {
      const m = model(view({ mode, goLive: false, need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 } }));
      expect(m.main).toMatchObject({
        kind: "before-go-live",
        heading: "Nothing to check yet.",
        lines: [lines[mode]],
        check: null,
      });
      expect(m).toMatchObject({ footer: "continue", active: null, pause: null, done: null, continueWithout: null });
    }
  });

  it("says a dry run needs no checks", () => {
    const m = model(view({ mode: "DRY_RUN", need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 } }));
    expect(m.main).toMatchObject({ kind: "dry-run", lines: ["This campaign is a dry run, so addresses don't need checking."], check: null });
    expect(m.footer).toBe("continue");
  });

  it("offers to check them anyway, with the cost, the practice copy's words, and a plan that includes them", () => {
    const dry = { mode: "DRY_RUN" as const, need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 } };
    const paid = model(view({ ...dry, optional: { count: 40, estimate: estimate(40) } }));
    expect(paid.main?.lines).toEqual([
      "This campaign is a dry run, so addresses don't need checking.",
      "40 addresses here were never checked or were checked long ago. You can check them now, so they're ready for a live campaign later: about $0.48.",
    ]);
    expect(paid.main?.check).toEqual({ count: 40, label: "Check them anyway", primary: false, disabled: false });
    expect(paid.footer).toBe("continue");

    const practice = model(view({ ...dry, practiceCopy: true, optional: { count: 1, estimate: estimate(1, { provider: "fake" }) } }));
    expect(practice.main?.lines.slice(1)).toEqual([
      "1 address here was never checked or was checked long ago. You can check it now, so it's ready for a live campaign later.",
      "The practice copy uses the free test checker.",
    ]);

    const included = model(view({ ...dry, optional: { count: 40, estimate: estimate(40, { includedPerMonth: 5000, usedThisMonth: 840 }) } }));
    expect(included.main?.costLine).toBe("Cost: free (40 of the 5,000 checks your Mailgun plan includes this month; 4,120 left).");

    const over = model(view({ ...dry, monthly: { limitUsd: 100, spentUsd: 99.9, wouldPass: false }, optional: { count: 40, estimate: estimate(40) } }));
    expect(over.main?.blocker).toBe(
      "That would pass this month's check limit of $100 ($99.90 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    expect(over.main?.check?.disabled).toBe(true);
  });
});

describe("needs checks", () => {
  it("counts what needs a check, the cost and what's already fine", () => {
    const m = model(view({ need: { total: 41, notChecked: 32, tooOld: 6, testChecker: 2, secondCheck: 1 }, estimate: estimate(41), waiting: 2 }));
    expect(m.main).toMatchObject({
      kind: "needs",
      heading: "41 addresses need a check",
      lines: [
        "32 were never checked",
        "6 were checked more than 90 days ago",
        "2 were only checked by the test checker",
        "1 needs its second check (the first got no answer)",
      ],
      costLine: "Cost: about $0.49 (41 checks × $0.012). Up to $0.04 more if some need a second check tomorrow.",
      notes: ["112 addresses are already checked.", "2 addresses wait for their second check; they're checked again after launch."],
      blocker: null,
      check: { count: 41, label: "Check 41 addresses", primary: true, disabled: false },
    });
    expect(m.footer).toBe("check");
    // A due second check still happens after launch: only the others are left out.
    expect(m.continueWithout).toEqual({ leaveOut: 40 });
    expect(continueWithoutText(40)).toBe(
      "The 40 people with unchecked addresses will be left out of this campaign. You can check them later from Contacts.",
    );
    expect(continueWithoutText(1)).toBe(
      "The 1 person with an unchecked address will be left out of this campaign. You can check them later from Contacts.",
    );
  });

  it("words one of each and the cost when part or all of it is included in the plan", () => {
    const one = model(
      view({ need: { total: 4, notChecked: 1, tooOld: 1, testChecker: 1, secondCheck: 1 }, fine: 1, waiting: 1, estimate: estimate(4) }),
    );
    expect(one.main?.heading).toBe("4 addresses need a check");
    expect(one.main?.lines).toEqual([
      "1 was never checked",
      "1 was checked more than 90 days ago",
      "1 was only checked by the test checker",
      "1 needs its second check (the first got no answer)",
    ]);
    expect(one.main?.notes).toEqual(["1 address is already checked.", "1 address waits for its second check; it's checked again after launch."]);
    const single = model(view({ need: { total: 1, notChecked: 1, tooOld: 0, testChecker: 0, secondCheck: 0 }, estimate: estimate(1) }));
    expect(single.main?.heading).toBe("1 address needs a check");
    expect(single.main?.check?.label).toBe("Check 1 address");

    const partly = model(view({ need: { total: 40, notChecked: 40, tooOld: 0, testChecker: 0, secondCheck: 0 }, estimate: estimate(40, { includedPerMonth: 10 }) }));
    expect(partly.main?.costLine).toBe(
      "Cost: about $0.36 (30 checks × $0.012; 10 are included in your plan). Up to $0.02 more if some need a second check tomorrow.",
    );
    const free = model(view({ practiceCopy: true, estimate: estimate(40, { provider: "fake" }) }));
    expect(free.main?.costLine).toBe("Cost: free (the test checker is used here).");
    // The days follow the setting.
    expect(model(view(), { maxAgeDays: 120 }).main?.lines).toContain("6 were checked more than 120 days ago");
  });

  it("checks 5,000 now and the rest in a second run when there are more (7,210)", () => {
    const m = model(view({ need: { total: 7_210, notChecked: 7_210, tooOld: 0, testChecker: 0, secondCheck: 0 }, tooMany: true, estimate: estimate(5_000) }));
    expect(m.main?.heading).toBe("7,210 addresses need a check");
    expect(m.main?.lines).toEqual(["7,210 were never checked", "That's 7,210 addresses. Check 5,000 now and the rest in a second run."]);
    expect(m.main?.costLine).toBe("Cost: about $60.00 (5,000 checks × $0.012). Up to $3.00 more if some need a second check tomorrow.");
    expect(m.main?.check).toEqual({ count: 5_000, label: "Check 5,000 addresses", primary: true, disabled: false });
    expect(m.continueWithout).toEqual({ leaveOut: 7_210 });
  });

  it("stops at this month's check limit, with the Owner's and the Member's words", () => {
    const v = view({ monthly: { limitUsd: 100, spentUsd: 91.2, wouldPass: true } });
    const owner = model(v);
    expect(owner.main?.blocker).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    expect(owner.main?.check?.disabled).toBe(true);
    expect(owner.main?.costLine).toMatch(/^Cost: about \$0\.48/);
    const member = model(v, { isOwner: false });
    expect(member.main?.blocker).toBe(
      "That would pass this month's check limit of $100 ($91.20 used so far). Ask the Owner to raise the limit in Settings › Deliverability.",
    );
    expect(verifyMonthlyText({ limitUsd: 12.5, spentUsd: 0 }, true)).toMatch(/^That would pass this month's check limit of \$12\.50 \(\$0 used so far\)\./);
  });

  it("says what's wrong when checks can't run: not ready, or paused without a run", () => {
    const notReady = model(view({ notReady: "Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun." }));
    expect(notReady.main).toMatchObject({
      kind: "not-ready",
      heading: "40 addresses need a check",
      lines: ["Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun."],
      check: null,
    });
    expect(notReady).toMatchObject({ footer: "check", continueWithout: { leaveOut: 40 } });

    const paused = model(view({ pause: { ...NOT_PAUSED_CHECKS, paused: true, kind: "payment", text: "Address checks paused: billing." } }));
    expect(paused.pause).toEqual({ text: "Address checks paused: billing." });
    expect(paused.main?.check?.disabled).toBe(true);
  });

  it("has nothing to check once everyone is checked", () => {
    const m = model(view({ need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 }, waiting: 2 }));
    expect(m.main).toMatchObject({
      kind: "nothing",
      heading: "No addresses need a check now",
      notes: ["112 addresses are already checked.", "2 addresses wait for their second check; they're checked again after launch."],
    });
    expect(m.footer).toBe("continue");
  });
});

describe("a run of this campaign", () => {
  it("shows a running run with its progress and Stop", () => {
    const v = view({ run: run() });
    const m = model(v);
    expect(m.active).toEqual({
      jobId: 7,
      state: "running",
      heading: "Checking addresses",
      text: "12 of 40 checked",
      note: "You can leave this page. The checks keep running, and you get a notification when they're done.",
      progress: { done: 12, total: 40 },
      stopText: "The 28 addresses not checked yet stay unchecked, and those people are left out when you launch.",
    });
    expect(m).toMatchObject({ main: null, done: null, leftOut: [], footer: "continue", continueWithout: null });
    // The poll's newer data wins; before the run has counted, it says it's starting.
    expect(model(v, { run: run({ done: 39 }) }).active?.stopText).toBe(
      "The 1 address not checked yet stays unchecked, and that person is left out when you launch.",
    );
    expect(model(view({ run: run({ status: "QUEUED", done: 0, total: 0 }) })).active).toMatchObject({
      state: "running",
      text: "Starting the checks…",
      stopText: "The addresses not checked yet stay unchecked, and those people are left out when you launch.",
    });
  });

  it("waits behind another run", () => {
    const m = model(view({ run: run({ status: "QUEUED", done: 0, total: 0, blockedByOtherRun: true }) }));
    expect(m.active).toMatchObject({ state: "queued", text: "Waiting to start: another address check run is going on.", heading: null });
  });

  it("says when a deferred run tries again, in the viewer's time", () => {
    const later = new Date(NOW.getTime() + 65 * 60_000).toISOString(); // 14:05 in Karachi
    const m = model(view({ run: run({ status: "QUEUED", waitingUntil: later, summary: "Waiting: some checks will be tried again at 09:05." }) }));
    expect(m.active).toMatchObject({ state: "waiting", text: "Waiting: some checks will be tried again at 14:05." });
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    expect(model(view({ run: run({ status: "QUEUED", waitingUntil: tomorrow }) })).active?.text).toBe(
      "Waiting: some checks will be tried again at 24 Sept at 13:00.",
    );
  });

  it("shows the pause text with Stop, for the Owner and for a Member", () => {
    const pause = { ...NOT_PAUSED_CHECKS, paused: true, kind: "auth" as const, text: "Address checks paused: Mailgun didn't accept the key." };
    const v = view({ pause, run: run({ status: "QUEUED", waitingUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }) });
    for (const isOwner of [true, false]) {
      const m = model(v, { isOwner });
      expect(m.active).toMatchObject({ state: "paused", text: "Address checks paused: Mailgun didn't accept the key." });
      expect(m.active?.stopText).toMatch(/^The 28 addresses not checked yet/);
      // The pause is on the run's card, not a second time above.
      expect(m.pause).toBeNull();
    }
  });
});

describe("after a run", () => {
  it("shows the finished run's lines, what still needs a check and who is left out", () => {
    const c = counts({ checked: 40, canEmail: 33, lowRiskCatchAll: 2, invalid: 2, doNotSend: 1, risky: 1, catchAllBlocked: 2, disposable: 1, unknown: 1, notReached: 2, mayBeCharged: 1, costUsd: 0.48 });
    const leftOut = [{ personId: 1, name: "Anna Berg", email: "anna@firma.de", companyName: "Firma GmbH", reason: "doesn't exist" }];
    const m = model(
      view({ need: { total: 2, notChecked: 2, tooOld: 0, testChecker: 0, secondCheck: 0 }, estimate: estimate(2), run: run({ status: "DONE", done: 40 }), leftOutByChecks: leftOut }),
      { lastRun: { status: "DONE", counts: c, error: null } },
    );
    expect(m.done).toEqual({
      heading: "Checks finished",
      error: null,
      lines: [
        "33 can be emailed (2 of them can't be confirmed but are low risk).",
        "2 don't exist. They're left out and on the do-not-email list now.",
        "1 shouldn't be emailed: the check says not to. It's left out and on the do-not-email list now.",
        "1 is rated high risk. Your check settings skip these.",
        "2 can't be confirmed. Your check settings skip these.",
        "1 is a throwaway address. Your check settings skip these.",
        "1 got no answer. It's checked again 24 hours after the first try, and emailed if it passes.",
        "2 couldn't be checked right now. They're left out at launch unless you check them again. Mailgun may have charged for some of them.",
        "Cost $0.48.",
      ],
    });
    // The two not reached still need a check: the step offers it again.
    expect(m.main?.heading).toBe("2 addresses need a check");
    expect(m.leftOut).toEqual(leftOut);
    expect(m.active).toBeNull();
  });

  it("goes straight on when nothing is left, and words a stopped or failed run", () => {
    const none = { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 };
    const done = model(view({ need: none, run: run({ status: "DONE" }) }), { lastRun: { status: "DONE", counts: counts({ checked: 3, canEmail: 3, costUsd: 0.036 }), error: null } });
    expect(done.main).toBeNull();
    expect(done.footer).toBe("continue");
    expect(done.done?.lines).toEqual(["3 can be emailed.", "Cost $0.04."]);

    const stopped = model(view({ need: none }), { lastRun: { status: "CANCELLED", counts: counts({}), error: null } });
    expect(stopped.done).toMatchObject({ heading: "Checks stopped", lines: ["No addresses were checked.", "Cost $0."] });
    const failed = model(view({ need: none }), {
      lastRun: { status: "FAILED", counts: null, error: "Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun." },
    });
    expect(failed.done).toMatchObject({ heading: "Checks didn't finish", error: expect.stringMatching(/^Address checks need a Mailgun key/), lines: [] });
  });

  it("hides a finished run before go-live", () => {
    const m = model(view({ mode: "TEST", goLive: false }), { lastRun: { status: "DONE", counts: counts({}), error: null } });
    expect(m.done).toBeNull();
    expect(m.main?.kind).toBe("before-go-live");
  });
});
