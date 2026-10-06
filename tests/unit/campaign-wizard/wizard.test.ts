import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WIZARD_STEPS,
  canOpenStep,
  isWizardStepKey,
  nextStepKey,
  previousStepKey,
  stepKeyFor,
  stepNumber,
  wizardHref,
} from "@/components/campaign-wizard/steps";
import {
  addedMessage,
  audienceSummary,
  isTypingTarget,
  launchSentences,
  localDateTimeWords,
  moveIndex,
  parseLocalDateTime,
  personDisplayName,
  timeUntil,
  toLocalInputValue,
} from "@/components/campaign-wizard/format";
import { localDateTimeToUtc } from "@/components/campaign-wizard/schedule-time";
import { cleanRenumberMap, isEmptyRenumber, renumberMap } from "@/components/campaign-wizard/message-state";
import { moveTotals, nobodyTickedText, withTick } from "@/components/campaign-wizard/audience-state";
import { WizardStepper } from "@/components/campaign-wizard/stepper";
import type { AudienceCompanyView, AudiencePersonView, AudienceTotals } from "@/server/services/campaigns/audience";

describe("wizard steps", () => {
  it("are Audience, Sender, Message, Verify, Review, Schedule", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual(["Audience", "Sender", "Message", "Verify", "Review", "Schedule"]);
    expect(stepNumber("message")).toBe(3);
    expect(nextStepKey("audience")).toBe("sender");
    expect(nextStepKey("schedule")).toBeNull();
    expect(previousStepKey("audience")).toBeNull();
    expect(previousStepKey("review")).toBe("verify");
    expect(isWizardStepKey("review")).toBe(true);
    expect(isWizardStepKey("launch")).toBe(false);
  });

  it("maps the stored progress to a step, clamped", () => {
    expect(stepKeyFor(1)).toBe("audience");
    expect(stepKeyFor(5)).toBe("review");
    expect(stepKeyFor(0)).toBe("audience");
    expect(stepKeyFor(42)).toBe("schedule");
    expect(stepKeyFor(null)).toBe("audience");
  });

  it("opens steps up to the furthest reached (you can always go back)", () => {
    expect(canOpenStep("audience", 1)).toBe(true);
    expect(canOpenStep("sender", 1)).toBe(false);
    expect(canOpenStep("review", 5)).toBe(true);
    expect(canOpenStep("schedule", 5)).toBe(false);
  });

  it("builds wizard links, leaving out empty values", () => {
    expect(wizardHref(12, "audience")).toBe("/campaigns/12/setup/audience");
    expect(wizardHref(12, "review", { filter: "missing", q: "", page: null })).toBe("/campaigns/12/setup/review?filter=missing");
    expect(wizardHref(3, "audience", { section: "excluded", q: "acme gmbh", page: 2 })).toBe(
      "/campaigns/3/setup/audience?section=excluded&q=acme+gmbh&page=2",
    );
  });

  it("marks the current step with the orange marker and links only reached steps", () => {
    const html = renderToStaticMarkup(createElement(WizardStepper, { campaignId: 7, current: "message", furthest: 4 }));
    expect(html).toContain('aria-current="step"');
    expect(html.match(/bg-primary/g)?.length).toBe(1);
    expect(html).toContain('href="/campaigns/7/setup/audience"');
    expect(html).toContain('href="/campaigns/7/setup/verify"');
    expect(html).not.toContain('href="/campaigns/7/setup/message"');
    expect(html).not.toContain('href="/campaigns/7/setup/review"');
    expect(html).toContain("(not reached yet)");
  });
});

describe("wording", () => {
  it("sums up the audience", () => {
    expect(audienceSummary({ people: 148, companies: 131, excludedCompanies: 17 })).toBe(
      "148 people at 131 companies will get the email · 17 excluded",
    );
    expect(audienceSummary({ people: 1, companies: 1, excludedCompanies: 0 })).toBe("1 person at 1 company will get the email");
    expect(audienceSummary({ people: 0, companies: 0, excludedCompanies: 2 })).toBe("Nobody will get the email yet · 2 excluded");
    expect(audienceSummary({ people: 1200, companies: 1100, excludedCompanies: 0 })).toBe("1,200 people at 1,100 companies will get the email");
  });

  it("says what adding companies did", () => {
    expect(addedMessage({ added: 37, alreadyIn: 5, notFound: 0, capped: 0, ticked: 41 })).toBe(
      "Added 37 companies (41 people ticked). 5 companies were already in this campaign.",
    );
    expect(addedMessage({ added: 1, alreadyIn: 0, notFound: 1, capped: 2, ticked: 1 })).toBe(
      "Added 1 company (1 person ticked). 1 company was skipped because it has been deleted. 2 companies were left out: a campaign can have up to 10,000 companies.",
    );
    expect(addedMessage({ added: 0, alreadyIn: 3, notFound: 0, capped: 0, ticked: 0 })).toBe(
      "No companies were added. 3 companies were already in this campaign.",
    );
  });

  it("names people the way the app does", () => {
    expect(personDisplayName({ name: " Anna Berg ", email: "anna@x.de" })).toBe("Anna Berg");
    expect(personDisplayName({ name: "", isGeneric: true, email: "info@x.de" })).toBe("General inbox");
    expect(personDisplayName({ name: "", email: "anna@x.de" })).toBe("anna@x.de");
  });

  it("sums up the launch (PLAN A8 M2 wording)", () => {
    expect(launchSentences({ mode: "DRY_RUN", people: 148, followUps: 2, missingEmails: 3 })).toEqual({
      main: "148 emails will go to the dry-run outbox.",
      missing: "3 emails have missing details: fix, exclude or send anyway.",
      text: null,
      editedText: null,
      followUps: "Its 2 follow-ups go out in the same email thread, each after its wait, unless someone at the company replies.",
      anyWarning: true,
    });
    expect(launchSentences({ mode: "DRY_RUN", people: 1, followUps: 0, missingEmails: 1 })).toEqual({
      main: "1 email will go to the dry-run outbox.",
      missing: "1 email has missing details: fix, exclude or send anyway.",
      text: null,
      editedText: null,
      followUps: null,
      anyWarning: true,
    });
    expect(launchSentences({ mode: "DRY_RUN", people: 3, followUps: 0, missingEmails: 0 }).anyWarning).toBe(false);
    expect(launchSentences({ mode: "LIVE", people: 2, followUps: 1, missingEmails: 0 }).main).toBe("2 emails will be sent.");
  });
});

describe("start time", () => {
  it("reads the date-and-time field strictly", () => {
    expect(parseLocalDateTime("2026-09-24T10:05")).toEqual({ year: 2026, month: 9, day: 24, hour: 10, minute: 5 });
    expect(parseLocalDateTime("2026-09-24T10:05:30")).not.toBeNull();
    expect(parseLocalDateTime("2026-02-30T10:00")).toBeNull();
    expect(parseLocalDateTime("2026-09-24 10:00")).toBeNull();
    expect(parseLocalDateTime("")).toBeNull();
    expect(parseLocalDateTime("2026-09-24T24:00")).toBeNull();
  });

  it("says it in words without any time-zone maths", () => {
    expect(localDateTimeWords("2026-09-24T10:00")).toBe("Thursday 24 September 2026 at 10:00");
    expect(localDateTimeWords("2027-01-01T00:30")).toBe("Friday 1 January 2027 at 00:30");
    expect(localDateTimeWords("nope")).toBeNull();
  });

  it("turns a typed time in the viewer's zone into UTC, and back", () => {
    expect(localDateTimeToUtc("2026-09-24T10:00", "Asia/Karachi")?.toISOString()).toBe("2026-09-24T05:00:00.000Z");
    expect(localDateTimeToUtc("2026-09-24T10:00", "Europe/Berlin")?.toISOString()).toBe("2026-09-24T08:00:00.000Z");
    // 02:30 doesn't exist when the clocks go forward: "compatible" moves it to 03:30 summer time.
    expect(localDateTimeToUtc("2026-03-29T02:30", "Europe/Berlin")?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(localDateTimeToUtc("2026-09-24T10:00", "Not/AZone")?.toISOString()).toBe("2026-09-24T10:00:00.000Z");
    expect(localDateTimeToUtc("tomorrow", "Asia/Karachi")).toBeNull();
    expect(toLocalInputValue(new Date("2026-09-24T05:00:00Z"), "Asia/Karachi")).toBe("2026-09-24T10:00");
    expect(toLocalInputValue(new Date("2026-12-31T23:30:00Z"), "Asia/Karachi")).toBe("2027-01-01T04:30");
    expect(toLocalInputValue(null, "Asia/Karachi")).toBe("");
  });

  it("says how far ahead a start is", () => {
    const now = new Date("2026-09-23T10:00:00Z");
    expect(timeUntil(new Date("2026-09-23T10:05:00Z"), now)).toBe("in 5 minutes");
    expect(timeUntil(new Date("2026-09-23T13:00:00Z"), now)).toBe("in 3 hours");
    expect(timeUntil(new Date("2026-09-26T10:00:00Z"), now)).toBe("in 3 days");
    expect(timeUntil(new Date("2026-09-23T09:00:00Z"), now)).toBe("now");
  });
});

describe("keyboard", () => {
  it("never fires single-key shortcuts while typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("moves through the list without leaving it", () => {
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});

describe("follow-ups moving when one is removed", () => {
  it("maps old step numbers to new ones by key", () => {
    const saved = [
      { key: 1, step: 0 },
      { key: 2, step: 1 },
      { key: 3, step: 2 },
      { key: 4, step: 3 },
    ];
    // Follow-up 1 removed: 2 → 1, 3 → 2.
    expect(renumberMap(saved, [{ key: 1, step: 0 }, { key: 3, step: 1 }, { key: 4, step: 2 }])).toEqual({ 1: null, 2: 1, 3: 2 });
    // Only the last one removed.
    expect(renumberMap(saved, saved.slice(0, 3))).toEqual({ 3: null });
    // A new follow-up added: nothing moved.
    const added = [...saved.slice(0, 2), { key: 5, step: 2 }];
    expect(isEmptyRenumber(renumberMap(saved.slice(0, 2), added))).toBe(true);
  });

  it("checks the map from the browser", () => {
    expect(cleanRenumberMap(undefined)).toEqual(new Map());
    expect(cleanRenumberMap({ 1: null, 2: 1, 3: 2 })).toEqual(new Map([[1, null], [2, 1], [3, 2]]));
    expect(cleanRenumberMap({ 0: 1 })).toBeNull(); // the first email never moves
    expect(cleanRenumberMap({ 2: 1, 3: 1 })).toBeNull(); // two onto one
    expect(cleanRenumberMap({ 1: 7 })).toBeNull();
    expect(cleanRenumberMap([1, 2])).toBeNull();
    expect(cleanRenumberMap("x")).toBeNull();
  });
});

describe("audience totals without reloading", () => {
  const person = (id: number, over: Partial<AudiencePersonView> = {}): AudiencePersonView => ({
    personId: id,
    recipientId: id * 10,
    name: `P${id}`,
    email: `p${id}@x.de`,
    isGeneric: false,
    verificationStatus: null,
    ticked: false,
    eligible: true,
    willGet: false,
    canTick: true,
    reason: null,
    notes: [],
    edited: false,
    removed: false,
    ...over,
  });
  const company: AudienceCompanyView = {
    companyId: 1,
    code: "C-1",
    name: "Acme",
    status: "NOT_CONTACTED",
    country: "DE",
    countryName: "Germany",
    deleted: false,
    section: "included",
    blockedReason: null,
    canPutBack: false,
    putBack: false,
    people: [person(1, { ticked: true, willGet: true }), person(2), person(3, { eligible: false, canTick: false, reason: "Unsubscribed" })],
    ticked: 1,
    willGet: 1,
    warning: null,
    emptyReason: null,
  };
  const totals: AudienceTotals = { people: 10, companies: 8, excludedCompanies: 2, includedCompanies: 8, nobodyTicked: 0, all: 10 };

  it("ticks optimistically, with the engine's warning", () => {
    const two = withTick(company, 2, true);
    expect(two).toMatchObject({ ticked: 2, willGet: 2, warning: "2 people at this company are ticked. Each of them gets the emails." });
    const none = withTick(withTick(company, 1, false), 2, false);
    expect(none).toMatchObject({ ticked: 0, willGet: 0, warning: null });
  });

  it("moves the totals by the difference", () => {
    expect(moveTotals(totals, company, withTick(company, 2, true))).toMatchObject({ people: 11, companies: 8, nobodyTicked: 0 });
    const emptied = withTick(company, 1, false);
    expect(moveTotals(totals, company, emptied)).toMatchObject({ people: 9, companies: 7, nobodyTicked: 1 });
    const putBack = { ...company, section: "excluded" as const, willGet: 0, ticked: 0 };
    expect(moveTotals(totals, putBack, company)).toMatchObject({ excludedCompanies: 1, includedCompanies: 9, people: 11, companies: 9 });
    expect(moveTotals(totals, company, null)).toMatchObject({ all: 9, people: 9 });
  });

  it("counts companies where nobody is ticked", () => {
    expect(nobodyTickedText(0)).toBeNull();
    expect(nobodyTickedText(1)).toBe("1 company has nobody ticked.");
    expect(nobodyTickedText(1200)).toBe("1,200 companies have nobody ticked.");
  });
});
