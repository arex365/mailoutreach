import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { emptyCheckRunCounts } from "@/core/verification/policy";
import { NOT_PAUSED_CHECKS } from "@/core/system-state-parse";
import type { CampaignCheckView } from "@/server/services/verification/select";
import type { ChecksDialogView } from "@/components/checks/types";
import type { PersonView } from "@/components/company-panel/types";
import type { ScheduleSummary } from "@/components/campaign-wizard/schedule-step";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  continueAction: vi.fn(),
  launchAction: vi.fn(),
  setScheduleAction: vi.fn(),
}));
vi.mock("@/app/(app)/campaigns/[id]/setup/verify-actions", () => ({ startCampaignChecksAction: vi.fn(), stopChecksAction: vi.fn() }));
vi.mock("@/app/(app)/contacts/check-actions", () => ({
  checkPersonAction: vi.fn(),
  checkRunViewAction: vi.fn(),
  estimateChecksAction: vi.fn(),
  startChecksAction: vi.fn(),
  stopChecksAction: vi.fn(),
}));
vi.mock("@/components/company-panel/actions", () => ({
  addPersonAction: vi.fn(),
  markPersonUnsubscribedAction: vi.fn(),
  removePersonAction: vi.fn(),
  setPersonNotesAction: vi.fn(),
  setPersonPersonalLineAction: vi.fn(),
  updatePersonAction: vi.fn(),
}));

const { VerifyStep } = await import("@/components/campaign-wizard/verify-step");
const { ChecksDialogReady, CheckEmailsButton } = await import("@/components/checks/check-emails-dialog");
const { ScheduleStep } = await import("@/components/campaign-wizard/schedule-step");
const { PeopleSection } = await import("@/components/company-panel/people-section");
const { VerificationBadge } = await import("@/components/badges");
const { TooltipProvider } = await import("@/components/ui/tooltip");

/**
 * The check screens as they render (M5-DESIGN §6.1, §6.3, §6.5): the Verify step's cards and footer per state, the
 * Contacts dialog before a start, the Schedule step's check note and launch-phase counts, and the panel's people rows
 * (Check button, reason line, "Did you mean", the 24-hour rule). React escapes every text, so apostrophes read &#x27;.
 */

const html = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const NOW_ISO = "2026-09-23T08:00:00.000Z";

function view(over: Partial<CampaignCheckView> = {}): CampaignCheckView {
  return {
    mode: "LIVE",
    goLive: true,
    practiceCopy: false,
    notReady: null,
    pause: { ...NOT_PAUSED_CHECKS },
    need: { total: 40, notChecked: 40, tooOld: 0, testChecker: 0, secondCheck: 0 },
    tooMany: false,
    waiting: 0,
    fine: 0,
    estimate: estimateChecks({ count: 40, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" }),
    monthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
    run: null,
    leftOutByChecks: [],
    optional: null,
    ...over,
  };
}

function verify(v: CampaignCheckView, over: Partial<Parameters<typeof VerifyStep>[0]> = {}): string {
  return html(
    renderToStaticMarkup(
      createElement(VerifyStep, { campaignId: 5, view: v, lastRun: null, isOwner: true, maxAgeDays: 90, timeZone: "Asia/Karachi", nowIso: NOW_ISO, ...over }),
    ),
  );
}

describe("the Verify step renders every state", () => {
  it("needs checks: the counts, the cost, Continue without checking and the one primary button", () => {
    const out = verify(view());
    expect(out).toContain("Check the addresses");
    expect(out).toContain("Every address is checked before a live campaign emails it, so fewer emails bounce.");
    expect(out).toContain("40 addresses need a check");
    expect(out).toContain("40 were never checked");
    expect(out).toContain("Cost: about $0.48 (40 checks × $0.012). Up to $0.02 more if some need a second check tomorrow.");
    expect(out).toContain("Continue without checking");
    expect(out).toContain("Check 40 addresses");
    // No plain Continue next to them.
    expect(out).not.toMatch(/>Continue<!-- -->|>Continue</);
  });

  it("over the monthly limit, the check button is off", () => {
    const out = verify(view({ monthly: { limitUsd: 100, spentUsd: 99.8, wouldPass: true } }), { isOwner: false });
    expect(out).toContain("Ask the Owner to raise the limit in Settings › Deliverability.");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Check 40 addresses/);
  });

  it("running: heading, neutral progress bar, progress and Stop checking", () => {
    const out = verify(
      view({ run: { jobId: 9, status: "RUNNING", done: 12, total: 40, summary: null, waitingUntil: null, blockedByOtherRun: false } }),
    );
    expect(out).toContain("Checking addresses");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="30"');
    expect(out).toContain("12 of 40 checked");
    expect(out).toContain("You can leave this page. The checks keep running, and you get a notification when they're done.");
    expect(out).toContain("Stop checking");
    // The bar is neutral (never orange).
    const bar = out.slice(out.indexOf('role="progressbar"'), out.indexOf("12 of 40 checked"));
    expect(bar).toContain("bg-foreground/60");
    expect(bar).not.toContain("bg-primary");
  });

  it("paused: the text with the Owner's link or the Member's note, and Stop for both", () => {
    const paused = view({
      pause: { ...NOT_PAUSED_CHECKS, paused: true, kind: "auth", text: "Address checks paused: Mailgun didn't accept the key." },
      run: { jobId: 9, status: "QUEUED", done: 3, total: 40, summary: null, waitingUntil: "2026-09-23T09:00:00.000Z", blockedByOtherRun: false },
    });
    const owner = verify(paused);
    expect(owner).toContain("Address checks paused: Mailgun didn't accept the key.");
    expect(owner).toContain('href="/settings/deliverability#checks"');
    expect(owner).toContain("Open Settings › Deliverability");
    expect(owner).toContain("Stop checking");
    const member = verify(paused, { isOwner: false });
    expect(member).toContain("The Owner can fix this in Settings.");
    expect(member).not.toContain("Open Settings › Deliverability");
    expect(member).toContain("Stop checking");
  });

  it("done: the lines and who is left out", () => {
    const out = verify(
      view({
        need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 },
        leftOutByChecks: [{ personId: 1, name: "Anna Berg", email: "anna@firma.de", companyName: "Firma GmbH", reason: "doesn't exist" }],
      }),
      { lastRun: { status: "DONE", counts: { ...emptyCheckRunCounts(), checked: 2, canEmail: 1, invalid: 1, costUsd: 0.024 }, error: null } },
    );
    expect(out).toContain("Checks finished");
    expect(out).toContain("1 can be emailed.");
    expect(out).toContain("1 doesn't exist. It's left out and on the do-not-email list now.");
    expect(out).toContain("Cost $0.02.");
    expect(out).toContain("Who is left out (1)");
    expect(out).toContain("Anna Berg · anna@firma.de · Firma GmbH — doesn't exist");
    expect(out).toContain("Continue");
  });

  it("before go-live and a dry run", () => {
    expect(verify(view({ mode: "LIVE", goLive: false }))).toContain("Until you go live, only your test-list addresses get email, and they count as checked.");
    // Test mode only ever emails the test list (M6-DESIGN §2.7), before and after go-live.
    expect(verify(view({ mode: "TEST", goLive: false }))).toContain("Test mode only emails your test list, and those addresses count as checked.");
    const dry = verify(
      view({
        mode: "DRY_RUN",
        practiceCopy: true,
        need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 },
        optional: { count: 40, estimate: estimateChecks({ count: 40, pricePerCheck: 0, includedPerMonth: 0, usedThisMonth: 0, provider: "fake" }) },
      }),
    );
    expect(dry).toContain("This campaign is a dry run, so addresses don't need checking.");
    expect(dry).toContain("The practice copy uses the free test checker.");
    expect(dry).toContain("Check them anyway");
  });
});

describe("the Contacts dialog before a start", () => {
  const dialogView: ChecksDialogView = {
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

  it("shows the lines, Check these again too, the cost and the buttons", () => {
    const out = html(
      renderToStaticMarkup(
        createElement(ChecksDialogReady, {
          view: dialogView,
          recheck: false,
          onRecheck: () => undefined,
          error: "The number of addresses changed. Open the dialog again to see the new count and cost.",
          pending: false,
          onCancel: () => undefined,
          onStart: () => undefined,
        }),
      ),
    );
    expect(out).toContain("40 need a check");
    expect(out).toContain("8 were checked in the last 90 days");
    expect(out).toContain("Check these again too (10)");
    expect(out).toContain("Cost: about $0.48 (40 checks × $0.012).");
    expect(out).toContain("The number of addresses changed. Open the dialog again to see the new count and cost.");
    expect(out).toContain("Cancel");
    expect(out).toContain("Check 40 addresses");
  });

  it("the bulk bar's button opens it (outline)", () => {
    const out = renderToStaticMarkup(createElement(CheckEmailsButton, { companyIds: [1, 2] }));
    expect(out).toContain("Check emails");
    expect(out).toContain('data-variant="outline"');
  });
});

describe("the Schedule step's address-check note", () => {
  const summary: ScheduleSummary = {
    mode: "LIVE",
    modeBlockers: [],
    modeReady: true,
    today: { cap: 100, used: 0, left: 100 },
    windowText: "Monday to Friday, 9:00–17:00",
    fits: { today: 100, later: 20 },
    ignoreWindowDefault: true,
    practiceCopy: false,
    people: 120,
    companies: 110,
    excludedCompanies: 0,
    followUps: 0,
    missingEmails: 0,
    missingPeople: 0,
    textProblems: [],
    editedTextProblems: 0,
    recipientZones: [],
    defaultTimeZone: "Europe/Berlin",
    senderName: "Ali",
    problems: [],
  };

  it("counts without the unchecked people and says how many launch leaves out", () => {
    const out = html(
      renderToStaticMarkup(
        createElement(ScheduleStep, {
          campaignId: 5,
          timeZone: "Asia/Karachi",
          initialLocal: "",
          initialStartIso: null,
          initialDaysAsMinutes: false,
          summary,
          nowIso: NOW_ISO,
          checkNote: { unchecked: 40, secondCheck: 2 },
        }),
      ),
    );
    expect(out).toContain("80 emails will be sent.");
    expect(out).toContain("40 people with unchecked addresses will be left out when you launch.");
    expect(out).toContain('href="/campaigns/5/setup/verify"');
    expect(out).toContain("2 people wait for a second address check. Their first email goes out once it passes.");
    // "Fits today's limit" without the 40: all 80 fit in the 100 left today.
    expect(out).toContain("Today's limit is 100; none has been used yet. All 80 emails fit in today's limit.");
  });

  it("says nothing extra without a note", () => {
    const out = html(
      renderToStaticMarkup(
        createElement(ScheduleStep, {
          campaignId: 5,
          timeZone: "Asia/Karachi",
          initialLocal: "",
          initialStartIso: null,
          initialDaysAsMinutes: false,
          summary,
          nowIso: NOW_ISO,
        }),
      ),
    );
    expect(out).toContain("120 emails will be sent.");
    expect(out).not.toContain("unchecked addresses");
  });
});

describe("the panel's people rows", () => {
  const person = (over: Partial<PersonView> = {}): PersonView => ({
    id: 3,
    displayName: "Anna Berg",
    name: "Anna Berg",
    role: null,
    email: "anna@yaho.test",
    isGeneric: false,
    verificationStatus: "INVALID",
    checkedText: "checked 3 Mar",
    flags: [],
    emailedText: "Never emailed",
    emailed: false,
    personalLineOverride: null,
    notes: "",
    canUnsubscribe: true,
    lastCheck: { reasons: ["no_mx"], didYouMean: "anna@yahoo.test", isRole: false, checkedByRealProvider: true, checkedWithin24h: false },
    ...over,
  });
  const render = (people: PersonView[], opts: { readOnly?: boolean; practiceCopy?: boolean } = {}) =>
    html(
      renderToStaticMarkup(
        createElement(
          TooltipProvider,
          null,
          createElement(PeopleSection, {
            companyId: 1,
            people,
            readOnly: opts.readOnly ?? false,
            checker: { practiceCopy: opts.practiceCopy ?? false, pricePerCheck: 0.012 },
          }),
        ),
      ),
    );

  it("has a Check button, the reason line and Did you mean", () => {
    const out = render([person()]);
    expect(out).toContain('aria-label="Check anna@yaho.test"');
    expect(out).toContain("This domain can't receive email.");
    expect(out).toContain("Did you mean anna@yahoo.test?");
    expect(out).toContain("Use this address");
    expect(out).toContain('title="The address check says this address doesn\'t exist."');
  });

  it("turns Check off within 24 hours of a real check, and hides it without an email or in a deleted company", () => {
    const today = render([person({ verificationStatus: "VALID", lastCheck: { reasons: [], didYouMean: null, isRole: false, checkedByRealProvider: true, checkedWithin24h: true } })]);
    expect(today).toContain('aria-disabled="true"');
    expect(today).toContain("anna@yaho.test was checked today already.");
    expect(today).not.toContain("Did you mean");
    expect(render([person({ email: null, verificationStatus: null, lastCheck: null })])).not.toContain("Check anna");
    const deleted = render([person()], { readOnly: true });
    expect(deleted).not.toContain('aria-label="Check anna@yaho.test"');
    expect(deleted).not.toContain("Use this address");
    // The reason stays visible.
    expect(deleted).toContain("This domain can't receive email.");
  });

  it("shows no reason line under a valid result", () => {
    const out = render([person({ verificationStatus: "VALID", lastCheck: { reasons: ["mailbox_is_role_address"], didYouMean: null, isRole: true, checkedByRealProvider: true, checkedWithin24h: false } })]);
    expect(out).not.toContain("A shared inbox.");
  });
});

describe("the check badge", () => {
  it("explains each result in its tooltip", () => {
    expect(renderToStaticMarkup(createElement(VerificationBadge, { status: null }))).toContain('title="This address hasn&#x27;t been checked yet."');
    expect(renderToStaticMarkup(createElement(VerificationBadge, { status: "VALID" }))).toContain('title="The address check says this mailbox exists."');
  });
});
