import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { NOT_PAUSED_CHECKS } from "@/core/system-state-parse";
import type { ChecksDialogView } from "@/components/checks/types";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/contacts/check-actions", () => ({
  checkPersonAction: vi.fn(),
  checkRunViewAction: vi.fn(),
  estimateChecksAction: vi.fn(),
  startChecksAction: vi.fn(),
  stopChecksAction: vi.fn(),
}));

const { ChecksDialogReady, STARTING_NOTE, checksDialogClose, checksDialogDoneLines, checksStartedOutcome } = await import(
  "@/components/checks/check-emails-dialog"
);

/**
 * The "Check email addresses" dialog while its start is on its way (M5 review SCREENS-05): it can't be closed then
 * (Esc, the X, a click outside and Cancel are all ignored), it says so, and a start that answers after the dialog went
 * away still says it started. React escapes every text, so apostrophes read &#x27;.
 */

const html = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const view: ChecksDialogView = {
  companies: 37,
  addresses: 52,
  need: 40,
  recent: 8,
  wait: 2,
  cannot: 2,
  estimate: estimateChecks({ count: 40, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" }),
  allEstimate: estimateChecks({ count: 50, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" }),
  monthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
  allMonthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
  notReady: null,
  pause: { ...NOT_PAUSED_CHECKS },
  listName: null,
  maxAgeDays: 90,
  practiceCopy: false,
  isOwner: true,
  timeZone: "Asia/Karachi",
};

describe("closing the check dialog", () => {
  it("is ignored while the start is on its way", () => {
    expect(checksDialogClose({ kind: "ready", view }, true)).toEqual({ close: false, toast: null });
  });

  it("closes before a start, and says the run goes on when it's running", () => {
    expect(checksDialogClose({ kind: "ready", view }, false)).toEqual({ close: true, toast: null });
    expect(checksDialogClose({ kind: "running", jobId: 9, count: 40, timeZone: "Asia/Karachi", job: null }, false)).toEqual({
      close: true,
      toast: "Checking 40 addresses. You'll get a notification when it's done.",
    });
    expect(checksDialogClose({ kind: "done", heading: "Checks finished", lines: [], error: null }, false)).toEqual({ close: true, toast: null });
  });
});

describe("a start that answers", () => {
  it("shows the running run while the dialog is open", () => {
    expect(checksStartedOutcome(true, 40)).toEqual({ show: "running" });
  });

  it("says it started when the dialog went away meanwhile", () => {
    expect(checksStartedOutcome(false, 1)).toEqual({ show: "toast", toast: "Checking 1 address. You'll get a notification when it's done." });
  });
});

describe("the finished run's lines (M5 review SCREENS-04)", () => {
  it("never promise a re-check, an email or a launch: a Contacts or list run belongs to no campaign", () => {
    const counts = {
      checked: 3,
      canEmail: 1,
      lowRiskCatchAll: 0,
      invalid: 1,
      doNotSend: 0,
      risky: 0,
      catchAllBlocked: 0,
      disposable: 0,
      unknown: 1,
      refused: 0,
      notReached: 0,
      mayBeCharged: 0,
      skipped: { fresh: 0, suppressed: 0, noEmail: 0, neverEmailed: 0 },
      costUsd: 0.036,
    };
    const lines = checksDialogDoneLines(counts);
    expect(lines).toContain("1 got no answer. It's tried again after 24 hours when this person is in a campaign.");
    for (const line of lines) expect(line).not.toMatch(/emailed if|left out|at launch/);
    expect(checksDialogDoneLines(null)).toEqual([]);
  });
});

describe("the dialog while starting", () => {
  const render = (pending: boolean) =>
    html(
      renderToStaticMarkup(
        createElement(ChecksDialogReady, {
          view,
          recheck: false,
          onRecheck: () => undefined,
          error: null,
          pending,
          onCancel: () => undefined,
          onStart: () => undefined,
        }),
      ),
    );

  it("says it's starting, with Cancel and the start button off", () => {
    const out = render(true);
    expect(out).toContain(STARTING_NOTE);
    expect(out).toContain("Starting the checks. You can close this window once they've started.");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Starting…<\/button>/);
  });

  it("says nothing extra before the start", () => {
    const out = render(false);
    expect(out).not.toContain(STARTING_NOTE);
    expect(out).toContain("Check 40 addresses");
  });
});
