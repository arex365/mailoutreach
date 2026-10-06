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

const { ScheduleStep } = await import("@/components/campaign-wizard/schedule-step");

/**
 * The Schedule step after go-live (M6-DESIGN §2.7, G11): the Live line says everyone in the campaign gets real email,
 * and a LIVE draft made before go-live needs a tick ("This draft was made before you went live. …") before Launch works.
 */

const html = (s: string) => s.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const summary: ScheduleSummary = {
  mode: "LIVE",
  modeBlockers: [],
  modeReady: true,
  today: { cap: 50, used: 0, left: 50 },
  windowText: "Monday to Friday, 9:00–17:00",
  fits: { today: 12, later: 400 },
  ignoreWindowDefault: true,
  practiceCopy: false,
  people: 412,
  companies: 400,
  excludedCompanies: 0,
  followUps: 0,
  missingEmails: 0,
  missingPeople: 0,
  textProblems: [],
  editedTextProblems: 0,
  recipientZones: [{ timeZone: "Europe/Berlin", people: 412, defaulted: 0 }],
  defaultTimeZone: "Europe/Berlin",
  senderName: "Ali",
  problems: [],
};

function render(s: ScheduleSummary): string {
  return html(
    renderToStaticMarkup(
      createElement(ScheduleStep, {
        campaignId: 5,
        timeZone: "Europe/Berlin",
        initialLocal: "",
        initialStartIso: null,
        initialDaysAsMinutes: false,
        summary: s,
        nowIso: "2026-09-23T08:00:00.000Z",
      }),
    ),
  );
}

/** The footer's "Launch campaign" button (the page's one primary button). */
function launchButton(out: string): string {
  const m = /<button[^>]*>(?:(?!<\/button>).)*Launch campaign(?:(?!<\/button>).)*<\/button>/.exec(out);
  if (!m) throw new Error("no Launch campaign button");
  return m[0];
}

describe("the Schedule step and go-live", () => {
  it("before go-live: the test-list line, no tick", () => {
    const out = render(summary);
    expect(out).toContain("It sends real email, but only to the addresses on your test list until you go live.");
    expect(out).not.toContain("This draft was made before you went live.");
    expect(launchButton(out)).not.toMatch(/\sdisabled=""/);
  });

  it("after go-live: the everyone line; a draft made later needs no tick", () => {
    const out = render({ ...summary, goLive: true, madeBeforeGoLive: false });
    expect(out).toContain("It sends real email to everyone in this campaign, inside their working hours and under the daily limit.");
    expect(out).not.toContain("This draft was made before you went live.");
    expect(launchButton(out)).not.toMatch(/\sdisabled=""/);
  });

  it("a LIVE draft made before go-live: the required tick with the people count, and Launch off until it is ticked", () => {
    const out = render({ ...summary, goLive: true, madeBeforeGoLive: true });
    expect(out).toContain("This draft was made before you went live. It now sends real email to 412 people.");
    expect(out).toMatch(/role="checkbox"[^>]*aria-checked="false"/);
    expect(launchButton(out)).toMatch(/\sdisabled=""/);
  });

  it("no tick for a draft made before go-live that launches in Test mode or as a dry run", () => {
    for (const mode of ["TEST", "DRY_RUN"] as const) {
      const out = render({ ...summary, mode, goLive: true, madeBeforeGoLive: true });
      expect(out).not.toContain("This draft was made before you went live.");
    }
  });
});
