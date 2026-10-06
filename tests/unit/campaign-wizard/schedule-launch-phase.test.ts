import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ScheduleSummary } from "@/components/campaign-wizard/schedule-step";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/campaigns/5/setup/schedule",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  continueAction: vi.fn(),
  launchAction: vi.fn(),
  setScheduleAction: vi.fn(),
}));

const { ScheduleStep, launchPhaseSummary } = await import("@/components/campaign-wizard/schedule-step");

/**
 * The Schedule step counts only what the launch will really send (M5-DESIGN §6.1; M5 review SCREENS-09): people whose
 * addresses still need a check are left out at launch, so "N emails", "They're for N companies" and the recipients'
 * times leave them out too. React escapes every text (apostrophes read &#x27;) and marks text joins with <!-- -->.
 */

const html = (s: string) => s.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** 10 people at 10 companies: 6 in Berlin (2 of them at companies with no zone, so the default), 4 in Oslo. */
const summary: ScheduleSummary = {
  mode: "LIVE",
  modeBlockers: [],
  modeReady: true,
  today: { cap: 100, used: 0, left: 100 },
  windowText: "Monday to Friday, 9:00–17:00",
  fits: { today: 10, later: 0 },
  ignoreWindowDefault: true,
  practiceCopy: false,
  people: 10,
  companies: 10,
  excludedCompanies: 0,
  followUps: 0,
  missingEmails: 0,
  missingPeople: 0,
  textProblems: [],
  editedTextProblems: 0,
  recipientZones: [
    { timeZone: "Europe/Berlin", people: 6, defaulted: 2 },
    { timeZone: "Europe/Oslo", people: 4, defaulted: 0 },
  ],
  defaultTimeZone: "Europe/Berlin",
  senderName: "Ali",
  problems: [],
};

/** 4 of them were never checked, each at a company of their own: 1 in Berlin, 1 with no zone, 2 in Oslo. */
const note = {
  unchecked: 4,
  secondCheck: 0,
  companiesLeftOut: 4,
  uncheckedZones: [
    { timeZone: "Europe/Berlin", people: 1 },
    { timeZone: null, people: 1 },
    { timeZone: "Europe/Oslo", people: 2 },
  ],
};

describe("launchPhaseSummary", () => {
  it("leaves the unchecked people out of the people, today's fit, the companies and the time zones", () => {
    const s = launchPhaseSummary(summary, note);
    expect(s).toMatchObject({ people: 6, companies: 6, fits: { today: 6, later: 0 } });
    expect(s.recipientZones).toEqual([
      { timeZone: "Europe/Berlin", people: 4, defaulted: 1 },
      { timeZone: "Europe/Oslo", people: 2, defaulted: 0 },
    ]);
  });

  it("keeps a company when someone there is still emailed, and reorders the zones", () => {
    // 10 people at 6 companies: the 4 unchecked people are the whole of 2 companies, and share a third with others.
    const s = launchPhaseSummary(
      { ...summary, companies: 6 },
      { unchecked: 4, secondCheck: 1, companiesLeftOut: 2, uncheckedZones: [{ timeZone: "Europe/Berlin", people: 4 }] },
    );
    expect(s).toMatchObject({ people: 6, companies: 4 });
    expect(s.recipientZones).toEqual([
      { timeZone: "Europe/Oslo", people: 4, defaulted: 0 },
      { timeZone: "Europe/Berlin", people: 2, defaulted: 2 },
    ]);
  });

  it("counts nothing when everyone still needs a check", () => {
    const s = launchPhaseSummary(summary, {
      unchecked: 10,
      secondCheck: 0,
      companiesLeftOut: 10,
      uncheckedZones: [
        { timeZone: "Europe/Berlin", people: 4 },
        { timeZone: null, people: 2 },
        { timeZone: "Europe/Oslo", people: 4 },
      ],
    });
    expect(s).toMatchObject({ people: 0, companies: 0, recipientZones: [] });
  });

  it("with the bare counts, keeps the zones and never counts more companies than emails; changes nothing without unchecked people", () => {
    const bare = launchPhaseSummary(summary, { unchecked: 4, secondCheck: 0 });
    expect(bare).toMatchObject({ people: 6, companies: 6, fits: { today: 6, later: 0 }, recipientZones: summary.recipientZones });
    expect(launchPhaseSummary({ ...summary, companies: 3 }, { unchecked: 4, secondCheck: 0 }).companies).toBe(3);
    expect(launchPhaseSummary(summary, { unchecked: 0, secondCheck: 2, companiesLeftOut: 0, uncheckedZones: [] })).toEqual(summary);
  });
});

describe("the Schedule step in the launch phase", () => {
  it("says what the launch really sends: emails, companies and the recipients' times", () => {
    const out = html(
      renderToStaticMarkup(
        createElement(ScheduleStep, {
          campaignId: 5,
          timeZone: "Europe/Berlin",
          initialLocal: "2026-09-24T09:00",
          initialStartIso: "2026-09-24T07:00:00.000Z",
          initialDaysAsMinutes: false,
          summary,
          nowIso: "2026-09-23T08:00:00.000Z",
          checkNote: note,
        }),
      ),
    );
    expect(out).toContain("6 emails will be sent. They're for 6 companies, sent as Ali.");
    expect(out).toContain("4 people with unchecked addresses will be left out when you launch.");
    expect(out).toContain("In the recipients' time: 09:00 in Berlin for 4 people and 09:00 in Oslo for 2 people.");
    expect(out).toContain("1 person is at a company with no country or time zone set, so Berlin time (the default time zone) is used for them.");
    expect(out).toContain("Today's limit is 100; none has been used yet. All 6 emails fit in today's limit.");
    expect(out).not.toContain("for 10 companies");
    expect(out).not.toContain("for 6 people and");
  });
});
