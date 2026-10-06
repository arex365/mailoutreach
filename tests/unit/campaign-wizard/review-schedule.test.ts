import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  defaultZoneNote,
  editedTextProblemSentence,
  launchSentences,
  recipientTimesText,
  textProblemSentence,
  zoneCity,
} from "@/components/campaign-wizard/format";

// The Server Actions module can't load outside Next (it's server-only); nothing here calls it while rendering.
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  continueAction: vi.fn(),
  editRecipientEmailAction: vi.fn(),
  resetRecipientEmailAction: vi.fn(),
  reviewDetailAction: vi.fn(),
  setCompanyLineAction: vi.fn(),
  setIncludedAction: vi.fn(),
  setPersonLineAction: vi.fn(),
}));

const { PersonInclusion, TextProblems, editChanged } = await import("@/components/campaign-wizard/review-step");

describe("text problems are counted apart from missing details (PLAN B6.3)", () => {
  it("says what's wrong with a step's text in plain words", () => {
    expect(textProblemSentence({ step: 2, unknown: ["frist_name"], syntax: false })).toBe(
      "Follow-up 2 uses {{frist_name}}, which isn't a variable we know.",
    );
    expect(textProblemSentence({ step: 0, unknown: ["frist_name", "compnay"], syntax: true })).toBe(
      "The first email uses {{frist_name}} and {{compnay}}, which aren't variables we know, and has { } braces that don't match.",
    );
    expect(textProblemSentence({ step: 1, unknown: [], syntax: true })).toBe("Follow-up 1 has { } braces that don't match.");
    expect(editedTextProblemSentence(0)).toBeNull();
    expect(editedTextProblemSentence(1)).toBe("1 email edited for one person has a variable we don't know or braces that don't match.");
    expect(editedTextProblemSentence(3)).toBe("3 emails edited for single people have variables we don't know or braces that don't match.");
  });

  it("adds them to the launch confirmation, which then says Launch anyway", () => {
    const s = launchSentences({
      mode: "DRY_RUN",
      people: 150,
      followUps: 2,
      missingEmails: 0,
      textProblems: [{ step: 2, unknown: ["frist_name"], syntax: false }],
      editedTextProblems: 2,
    });
    expect(s.missing).toBeNull();
    expect(s.text).toBe("Follow-up 2 uses {{frist_name}}, which isn't a variable we know. Check the Message step.");
    expect(s.editedText).toBe(
      "2 emails edited for single people have variables we don't know or braces that don't match. Check them in Review.",
    );
    expect(s.anyWarning).toBe(true);

    const one = launchSentences({ mode: "DRY_RUN", people: 1, followUps: 0, missingEmails: 0, editedTextProblems: 1 });
    expect(one.editedText).toMatch(/Check it in Review\.$/);
    expect(one.text).toBeNull();
    // Nobody gets it: nothing to warn about.
    const nobody = launchSentences({ mode: "DRY_RUN", people: 0, followUps: 0, missingEmails: 0, textProblems: [{ step: 0, unknown: ["x"], syntax: false }] });
    expect(nobody).toMatchObject({ text: null, anyWarning: false });
  });
});

describe("the start in the recipients' own time (PLAN B6.4 Schedule)", () => {
  it("names a zone by its city", () => {
    expect(zoneCity("Europe/Berlin")).toBe("Berlin");
    expect(zoneCity("America/New_York")).toBe("New York");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCity("UTC")).toBe("UTC");
    expect(zoneCity("Etc/UTC")).toBe("UTC");
  });

  it("shows the three zones with the most people, and sums up the rest", () => {
    // 10:00 in Karachi (the viewer).
    const start = new Date("2026-09-24T05:00:00Z");
    const zones = [
      { timeZone: "Europe/Berlin", people: 120, defaulted: 30 },
      { timeZone: "Europe/London", people: 20, defaulted: 0 },
      { timeZone: "America/New_York", people: 4, defaulted: 0 },
      { timeZone: "Asia/Tokyo", people: 2, defaulted: 0 },
    ];
    expect(recipientTimesText(start, "Asia/Karachi", zones)).toBe(
      "In the recipients' time: 07:00 in Berlin for 120 people, 06:00 in London for 20 people, 01:00 in New York for 4 people and 2 more people in 1 other time zone.",
    );
    expect(recipientTimesText(start, "Asia/Karachi", zones.slice(0, 1))).toBe("In the recipients' time: 07:00 in Berlin for 120 people.");
  });

  it("names the day when it isn't the viewer's day", () => {
    // 07:00 on Thursday in Karachi is 22:00 on Wednesday in New York.
    const start = new Date("2026-09-24T02:00:00Z");
    expect(recipientTimesText(start, "Asia/Karachi", [{ timeZone: "America/New_York", people: 1, defaulted: 0 }])).toBe(
      "In the recipients' time: 22:00 on Wednesday in New York for 1 person.",
    );
  });

  it("never breaks on an unknown zone, and says nothing when nobody gets it", () => {
    const start = new Date("2026-09-24T02:00:00Z");
    expect(
      recipientTimesText(start, "Asia/Karachi", [
        { timeZone: "Not/AZone", people: 3, defaulted: 0 },
        { timeZone: "Europe/Berlin", people: 1, defaulted: 0 },
      ]),
    ).toBe("In the recipients' time: 04:00 in Berlin for 1 person and 3 more people in 1 other time zone.");
    expect(recipientTimesText(start, "Asia/Karachi", [])).toBeNull();
  });

  it("says plainly which zone companies without one count as", () => {
    expect(defaultZoneNote([{ timeZone: "Europe/Berlin", people: 120, defaulted: 30 }], "Europe/Berlin")).toBe(
      "30 people are at companies with no country or time zone set, so Berlin time (the default time zone) is used for them.",
    );
    expect(defaultZoneNote([{ timeZone: "Europe/Berlin", people: 1, defaulted: 1 }], "Europe/Berlin")).toBe(
      "1 person is at a company with no country or time zone set, so Berlin time (the default time zone) is used for them.",
    );
    expect(defaultZoneNote([{ timeZone: "Europe/Oslo", people: 5, defaulted: 0 }], "Europe/Berlin")).toBeNull();
  });
});

describe("Review: getting the campaign or not", () => {
  const base = {
    personId: 5,
    name: "Rita Replied",
    email: "rita@replied.de",
    companyId: 9,
    companyName: "Replied Co",
    willGet: false,
    ticked: false,
    canInclude: false,
    reason: "Company status is Replied (you can include it by hand)" as string | null,
    companyCanPutBack: true,
  };
  const render = (detail: Partial<typeof base>) =>
    renderToStaticMarkup(createElement(PersonInclusion, { campaignId: 7, detail: { ...base, ...detail }, busy: false, onSetIncluded: () => {} }));

  it("points to the Audience step when the company's reply is the only thing in the way", () => {
    const html = render({});
    expect(html).toContain("Company status is Replied (you can include it by hand).");
    expect(html).toContain("Put the company back in on the Audience step");
    expect(html).toContain('href="/campaigns/7/setup/audience?section=excluded&amp;q=Replied+Co"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);

    const other = render({ reason: "Unsubscribed", companyCanPutBack: false });
    expect(other).not.toContain("Put the company back in");
  });

  it("never shows a switch that looks on next to Left out: someone ticked who can't be emailed gets Untick", () => {
    const html = render({ ticked: true, reason: "Emailed by Ali 12 days ago (Germany Q4)", companyCanPutBack: false });
    expect(html).toContain("Ticked, but left out");
    expect(html).toContain("Untick");
    expect(html).toContain("Emailed by Ali 12 days ago (Germany Q4).");
    expect(html).not.toContain('role="switch"');
  });

  it("shows the switch on for someone who gets it, and invites switching on someone who's only unticked", () => {
    const on = render({ willGet: true, ticked: true, canInclude: true, reason: null, companyCanPutBack: false });
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain("Gets this campaign");

    const off = render({ canInclude: true, reason: "Not ticked", companyCanPutBack: false });
    expect(off).toContain("Not ticked. Switch it on to include them.");
    expect(off).toContain("Left out");
  });
});

describe("Review: text problems at the top", () => {
  it("lists the campaign's text problems with a link to fix them, and the edited emails with their own", () => {
    const html = renderToStaticMarkup(
      createElement(TextProblems, {
        campaignId: 7,
        page: { textProblems: [{ step: 2, unknown: ["frist_name"], syntax: false }], editedTextProblems: 1 },
        showEditedHref: "/campaigns/7/setup/review?filter=text",
      }),
    );
    expect(html).toContain("Follow-up 2 uses {{frist_name}}, which isn&#x27;t a variable we know.");
    expect(html).toContain('href="/campaigns/7/setup/message"');
    expect(html).toContain("1 email edited for one person has a variable we don&#x27;t know or braces that don&#x27;t match.");
    expect(html).toContain('href="/campaigns/7/setup/review?filter=text"');
    expect(html).toContain("Show it");
  });

  it("shows nothing when the text is fine", () => {
    const html = renderToStaticMarkup(
      createElement(TextProblems, { campaignId: 7, page: { textProblems: [], editedTextProblems: 0 }, showEditedHref: null }),
    );
    expect(html).toBe("");
  });
});

describe("Review: editing one person's email never loses typed text silently", () => {
  it("knows when the text was changed", () => {
    const first = { step: 0, source: { subject: "Hi {{company}}", body: "Hello" } };
    expect(editChanged(first, { subject: "Hi {{company}}", body: "Hello" })).toBe(false);
    expect(editChanged(first, { subject: "Hi {{company}}", body: "Hello!" })).toBe(true);
    expect(editChanged(first, { subject: "Hello {{company}}", body: "Hello" })).toBe(true);
    const followUp = { step: 1, source: { subject: null, body: "Again" } };
    expect(editChanged(followUp, { subject: "", body: "Again" })).toBe(false);
    expect(editChanged(followUp, { subject: "", body: "Again, Anna" })).toBe(true);
  });
});
