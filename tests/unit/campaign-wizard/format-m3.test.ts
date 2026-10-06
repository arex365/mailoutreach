import { describe, expect, it } from "vitest";
import {
  DAYS_AS_MINUTES_HINT,
  followUpsSentence,
  ignoreWindowText,
  launchSentences,
  limitSentence,
  modeLine,
  type LaunchSummaryLike,
} from "@/components/campaign-wizard/format";

/**
 * The Schedule step's sentences (M3-DESIGN §5.8, M4-DESIGN §9.4): sending hours, today's limit, the mode, and the
 * follow-ups (sent in every mode from Milestone 4 on; nothing is switched off at launch any more).
 */

describe("ignoreWindowText", () => {
  it("explains both positions of the switch", () => {
    expect(ignoreWindowText(true)).toBe("Sends as fast as possible, day or night, ignoring sending hours and gaps.");
    expect(ignoreWindowText(false)).toBe(
      "Waits for each recipient's sending hours and takes turns with real emails, so you see when each email would really go out.",
    );
  });
});

describe("limitSentence", () => {
  it("is null when no limit applies", () => {
    expect(limitSentence({ people: 10, today: null, fits: null })).toBeNull();
    expect(limitSentence({ people: 0, today: { cap: 50, used: 0, left: 50 }, fits: { today: 0, later: 0 } })).toBeNull();
  });

  it("says how much of the campaign fits today", () => {
    expect(limitSentence({ people: 120, today: { cap: 50, used: 12, left: 38 }, fits: { today: 38, later: 82 } })).toBe(
      "Today's limit is 50; 12 are already used. About 38 of these 120 emails can go out today; the rest follow on the next sending days.",
    );
    expect(limitSentence({ people: 20, today: { cap: 1000, used: 0, left: 1000 }, fits: { today: 20, later: 0 } })).toBe(
      "Today's limit is 1,000; none has been used yet. All 20 emails fit in today's limit.",
    );
    // Two people: "Both", never "All 2 of these emails".
    expect(limitSentence({ people: 2, today: { cap: 50, used: 0, left: 50 }, fits: { today: 2, later: 0 } })).toBe(
      "Today's limit is 50; none has been used yet. Both emails fit in today's limit.",
    );
    expect(limitSentence({ people: 5, today: { cap: 50, used: 3, left: 47 }, fits: { today: 5, later: 0 } })).toBe(
      "Today's limit is 50; 3 are already used. All 5 emails fit in today's limit.",
    );
    expect(limitSentence({ people: 1, today: { cap: 50, used: 1, left: 49 }, fits: { today: 1, later: 0 } })).toBe(
      "Today's limit is 50; 1 is already used. This email fits in today's limit.",
    );
    expect(limitSentence({ people: 5, today: { cap: 50, used: 50, left: 0 }, fits: { today: 0, later: 5 } })).toBe(
      "Today's limit of 50 is used up, so these emails start on the next sending day.",
    );
  });
});

describe("modeLine", () => {
  it("says what each mode does to the data", () => {
    expect(modeLine({ mode: "DRY_RUN", practiceCopy: false })).toBe(
      "It's a dry run on your real data: nothing is sent, and company statuses and the 30-day rule don't change.",
    );
    expect(modeLine({ mode: "DRY_RUN", practiceCopy: true })).toBe(
      "This is the practice copy: companies are marked Contacted and the 30-day rule counts these emails, as if they were real.",
    );
    expect(modeLine({ mode: "TEST", practiceCopy: false })).toMatch(/^It's in Mailgun's test mode: /);
    expect(modeLine({ mode: "LIVE", practiceCopy: false })).toBe(
      "It sends real email, but only to the addresses on your test list until you go live. Emails to test mailboxes don't count as emailed, so you can test again at any time.",
    );
  });
});

describe("launchSentences", () => {
  const base: LaunchSummaryLike = { mode: "LIVE", people: 3, missingEmails: 0, followUps: 2 };

  it("says the follow-ups go out in the same thread unless someone at the company replies, in every mode", () => {
    for (const mode of ["LIVE", "TEST", "DRY_RUN"] as const) {
      expect(launchSentences({ ...base, mode }).followUps).toBe(
        "Its 2 follow-ups go out in the same email thread, each after its wait, unless someone at the company replies.",
      );
    }
    expect(launchSentences({ ...base, followUps: 1 }).followUps).toBe(
      "Its follow-up goes out in the same email thread after its wait, unless someone at the company replies.",
    );
    expect(launchSentences({ ...base, followUps: 0 }).followUps).toBeNull();
    expect(followUpsSentence(3)).toBe("Its 3 follow-ups go out in the same email thread, each after its wait, unless someone at the company replies.");
    // No sentence mentions a milestone any more.
    for (const n of [0, 1, 2, 3]) expect(followUpsSentence(n) ?? "").not.toMatch(/Milestone/);
  });

  it("explains 'Treat follow-up days as minutes' without a milestone, and that it needs 'Ignore sending hours' to be quick", () => {
    expect(DAYS_AS_MINUTES_HINT).toBe(
      "“3 days after” becomes 3 minutes after. Switch on Ignore sending hours too, so you can watch a whole sequence in minutes.",
    );
    // Days as minutes alone still waits for sending hours (practice copy default): the hint must name the other switch.
    expect(DAYS_AS_MINUTES_HINT).toMatch(/Ignore sending hours/);
    expect(DAYS_AS_MINUTES_HINT).not.toMatch(/Milestone/);
  });

  it("live emails 'will be sent', dry runs go to the outbox", () => {
    expect(launchSentences(base).main).toBe("3 emails will be sent.");
    expect(launchSentences({ ...base, mode: "DRY_RUN", people: 1 }).main).toBe("1 email will go to the dry-run outbox.");
  });
});
