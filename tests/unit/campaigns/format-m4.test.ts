import { describe, expect, it } from "vitest";
import {
  buildRecipientTimeline,
  companySequenceLabel,
  isTestListSequence,
  outageHoldNotice,
  possibleReplyNotice,
  recipientStateText,
  recipientStepViews,
  stepProgressText,
  toRecipientRowView,
  waitingText,
  WAITING_REPLIES_HREF,
  type CompanySequence,
  type PanelEmail,
  type StepProgress,
  type StepViewInput,
} from "@/components/campaigns/format";

/**
 * The campaign screens' Milestone 4 words (M4-DESIGN §2.11, §2.12, §9.3): held and reply-stopped people, emails of
 * people on hold counted apart, the " (test list)" suffix, the hold notices and the two new waiting lines.
 */

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-10T10:00:00Z");
const at = (iso: string) => new Date(iso);

function step(over: Partial<StepProgress>): StepProgress {
  return { step: 0, delayDays: 0, planned: 0, sent: 0, waiting: 0, sending: 0, skipped: 0, failed: 0, cancelled: 0, unsure: 0, nextDueAt: null, ...over };
}

describe("recipient state texts (§2.12, campaign page and Sequence column)", () => {
  const base = { currentStep: 1, nextDueAt: null, stopReason: null, campaignStatus: "RUNNING" as const };

  it("words every row of the table", () => {
    const text = (over: Parameters<typeof recipientStateText>[0]) => recipientStateText(over, TZ, NOW);
    expect(text({ ...base, state: "PENDING", campaignStatus: "DRAFT" })).toBe("Not launched yet");
    expect(text({ ...base, state: "SCHEDULED", currentStep: 0, nextDueAt: at("2026-10-12T08:00:00Z") })).toBe("Scheduled for 12 Oct");
    expect(text({ ...base, state: "SCHEDULED", currentStep: 0, nextDueAt: at("2026-10-09T08:00:00Z") })).toBe("First email waiting to send");
    expect(text({ ...base, state: "WAITING", currentStep: 2, nextDueAt: at("2026-10-12T08:00:00Z") })).toBe("Waiting for follow-up 2 on 12 Oct");
    expect(text({ ...base, state: "WAITING", currentStep: 2, nextDueAt: at("2026-10-08T08:00:00Z") })).toBe("Follow-up 2 waiting to send since 8 Oct");
    expect(text({ ...base, state: "HELD", holdReason: "outage" })).toBe("On hold: replies may have been missed while the PC was off");
    expect(text({ ...base, state: "HELD", holdReason: "possible-reply" })).toBe("On hold: a possible reply needs checking");
    expect(text({ ...base, state: "HELD", holdReason: "outage,possible-reply" })).toBe("On hold: a possible reply needs checking");
    expect(text({ ...base, state: "HELD", holdReason: null })).toBe("On hold");
    expect(text({ ...base, state: "RECHECK" })).toBe("Waiting for re-check");
    expect(text({ ...base, state: "RECHECK", recheckAt: at("2026-10-11T12:05:00Z") })).toBe("Waiting for re-check on 11 Oct at 14:05");
    expect(text({ ...base, state: "FINISHED" })).toBe("Finished");
    expect(text({ ...base, state: "STOPPED", stopReason: "replied" })).toBe("Stopped: they replied");
    expect(text({ ...base, state: "STOPPED", stopReason: "company_replied" })).toBe("Stopped: someone at the company replied");
    expect(text({ ...base, state: "STOPPED", stopReason: "status:CLIENT" })).toBe("Stopped: marked Client");
    expect(text({ ...base, state: "STOPPED", stopReason: "status:NOT_INTERESTED" })).toBe("Stopped: marked Not interested");
    expect(text({ ...base, state: "STOPPED", stopReason: "status:DO_NOT_CONTACT" })).toBe("Stopped: marked Do not contact");
    expect(text({ ...base, state: "STOPPED", stopReason: "status:REPLIED" })).toBe("Stopped: marked Replied");
    // M3 codes keep their words.
    expect(text({ ...base, state: "STOPPED", stopReason: "bounced" })).toBe("Stopped: bounced");
    expect(text({ ...base, state: "STOPPED", stopReason: "failed" })).toBe("Stopped: didn't send");
    expect(text({ ...base, state: "STOPPED", stopReason: "Skipped by Sara" })).toBe("Stopped: skipped by Sara");
  });

  it("never reads a hold reason left on a recipient that isn't held", () => {
    expect(recipientStateText({ ...base, state: "WAITING", holdReason: "possible-reply", nextDueAt: at("2026-10-12T08:00:00Z") }, TZ, NOW)).toBe(
      "Waiting for follow-up 1 on 12 Oct",
    );
  });

  it("shows the hold reason in the people table", () => {
    const row = toRecipientRowView(
      {
        id: 7,
        name: "Anna Berg",
        email: "anna@firma.de",
        companyId: 3,
        companyName: "Firma GmbH",
        companyDeleted: false,
        state: "HELD",
        included: true,
        currentStep: 1,
        nextDueAt: null,
        stopReason: null,
        holdReason: "possible-reply",
        exclusionReason: null,
        hasEdits: false,
        emails: [],
      },
      { campaignId: 4, campaignStatus: "RUNNING", query: {} },
      TZ,
      NOW,
    );
    expect(row.stateText).toBe("On hold: a possible reply needs checking");
  });
});

describe("the recipient panel of a person on hold (review NOTIFY-04)", () => {
  const emails: PanelEmail[] = [
    { id: 11, step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
    // Overdue: it would have gone on 8 Oct.
    { id: 12, step: 1, status: "QUEUED", dueAt: at("2026-10-08T08:00:00Z"), sentAt: null, lastError: null },
  ];
  const input = (recipient: StepViewInput["recipient"]): StepViewInput => ({
    campaignStatus: "RUNNING",
    recipient,
    steps: [
      { step: 0, enabled: true, delayDays: 0 },
      { step: 1, enabled: true, delayDays: 3 },
    ],
    emails,
  });

  it("words the waiting email's card as the hold, with no due date", () => {
    const held = recipientStepViews(input({ state: "HELD", included: true, stopReason: null, holdReason: "possible-reply" }), TZ, NOW);
    expect(held[1]).toMatchObject({ kind: "waiting", canEdit: true, note: "On hold: a possible reply needs checking" });
    const outage = recipientStepViews(input({ state: "HELD", included: true, stopReason: null, holdReason: "outage" }), TZ, NOW);
    expect(outage[1]!.note).toBe("On hold: replies may have been missed while the PC was off");
    // Without the reason (an older caller): still "On hold", never "Waiting to send".
    expect(recipientStepViews(input({ state: "HELD", included: true, stopReason: null }), TZ, NOW)[1]!.note).toBe("On hold");
    // Not held: as before.
    expect(recipientStepViews(input({ state: "WAITING", included: true, stopReason: null, holdReason: "outage" }), TZ, NOW)[1]!.note).toBe(
      "Waiting to send",
    );
  });

  it("words a waiting first email of a person waiting for a second address check (M5)", () => {
    const first: PanelEmail[] = [{ id: 21, step: 0, status: "QUEUED", dueAt: at("2026-10-09T08:00:00Z"), sentAt: null, lastError: null }];
    const view = (recipient: StepViewInput["recipient"]) =>
      recipientStepViews({ campaignStatus: "RUNNING", recipient, steps: [{ step: 0, enabled: true, delayDays: 0 }], emails: first }, TZ, NOW);
    expect(view({ state: "RECHECK", included: true, stopReason: null, recheckAt: at("2026-10-11T12:05:00Z") })[0]).toMatchObject({
      kind: "waiting",
      canEdit: true,
      note: "Waiting for re-check on 11 Oct at 14:05",
    });
    expect(view({ state: "RECHECK", included: true, stopReason: null })[0]!.note).toBe("Waiting for re-check");
    expect(view({ state: "SCHEDULED", included: true, stopReason: null, recheckAt: at("2026-10-11T12:05:00Z") })[0]!.note).toBe("Waiting to send");
  });

  it("lists the email to come as on hold in the timeline, not as due or waiting to send", () => {
    const held = buildRecipientTimeline({ emails, activity: [], recipient: { state: "HELD" } }, TZ, NOW);
    expect(held[0]).toMatchObject({ text: "Follow-up 1 is on hold", upcoming: true, ago: "" });
    const waiting = buildRecipientTimeline({ emails, activity: [], recipient: { state: "WAITING" } }, TZ, NOW);
    expect(waiting[0]).toMatchObject({ text: "Follow-up 1 is waiting to send", upcoming: true });
    expect(waiting[0]!.ago).not.toBe("");
  });

  it("lists the first email of a person waiting for a second address check with the one RECHECK phrase (M5)", () => {
    const first: PanelEmail[] = [{ id: 21, step: 0, status: "QUEUED", dueAt: at("2026-10-09T08:00:00Z"), sentAt: null, lastError: null }];
    const rechecking = buildRecipientTimeline({ emails: first, activity: [], recipient: { state: "RECHECK", recheckAt: at("2026-10-11T12:05:00Z") } }, TZ, NOW);
    expect(rechecking[0]).toMatchObject({ text: "Waiting for re-check on 11 Oct at 14:05", upcoming: true, ago: "" });
    const noTime = buildRecipientTimeline({ emails: first, activity: [], recipient: { state: "RECHECK" } }, TZ, NOW);
    expect(noTime[0]!.text).toBe("Waiting for re-check");
  });
});

describe("step progress with people on hold (§2.11)", () => {
  it("counts held emails apart, after the others", () => {
    const follow = step({ step: 1, waiting: 12, held: 5, nextDueAt: at("2026-10-14T07:00:00Z") });
    expect(stepProgressText(follow, TZ, NOW)).toBe("Follow-up 1: 12 waiting, next on 14 Oct · 5 on hold");
    expect(stepProgressText(step({ step: 2, held: 3 }), TZ, NOW)).toBe("Follow-up 2: 3 on hold");
    expect(stepProgressText(step({ step: 0, planned: 10, sent: 8, held: 2 }), TZ, NOW)).toBe("First email 8 of 10 sent · 2 on hold");
    expect(stepProgressText(step({ step: 1, sent: 4, held: 0 }), TZ, NOW)).toBe("Follow-up 1: 4 sent");
  });
});

describe("the Sequence column's suffix (§2.12)", () => {
  function seq(over: Partial<CompanySequence>): CompanySequence {
    return {
      id: 1,
      companyId: 5,
      campaignId: 1,
      campaignName: "Test list run",
      campaignStatus: "RUNNING",
      campaignMode: "LIVE",
      countsAsEmailed: true,
      personId: 9,
      state: "WAITING",
      currentStep: 1,
      nextDueAt: at("2026-10-14T08:00:00Z"),
      stopReason: null,
      updatedAt: at("2026-10-09T08:00:00Z"),
      ...over,
    };
  }

  it("marks live emails to the test list before go-live, dry runs and test mode", () => {
    expect(companySequenceLabel([seq({ countsAsEmailed: false, state: "FINISHED" })], TZ, NOW)).toEqual({
      text: "Finished (test list)",
      title: "Test list run · sent to your test list before going live",
    });
    expect(companySequenceLabel([seq({ countsAsEmailed: true, state: "FINISHED" })], TZ, NOW)?.text).toBe("Finished");
    expect(companySequenceLabel([seq({ campaignMode: "DRY_RUN", countsAsEmailed: false })], TZ, NOW)?.text).toBe(
      "Waiting for follow-up 1 on 14 Oct (dry run)",
    );
    expect(companySequenceLabel([seq({ campaignMode: "DRY_RUN", countsAsEmailed: true })], TZ, NOW)?.text).toBe(
      "Waiting for follow-up 1 on 14 Oct",
    );
    expect(companySequenceLabel([seq({ campaignMode: "TEST", countsAsEmailed: false })], TZ, NOW)?.text).toBe(
      "Waiting for follow-up 1 on 14 Oct (test)",
    );
  });

  it("words held and reply-stopped people", () => {
    expect(companySequenceLabel([seq({ state: "HELD", holdReason: "outage", countsAsEmailed: true })], TZ, NOW)?.text).toBe(
      "On hold: replies may have been missed while the PC was off",
    );
    expect(companySequenceLabel([seq({ state: "STOPPED", stopReason: "company_replied", countsAsEmailed: false })], TZ, NOW)?.text).toBe(
      "Stopped: someone at the company replied (test list)",
    );
  });

  it("words people waiting for a second address check, with the time when it is known (M5)", () => {
    const recheckAt = at("2026-10-11T12:05:00Z");
    expect(companySequenceLabel([seq({ state: "RECHECK", currentStep: 0, recheckAt, countsAsEmailed: true })], TZ, NOW)?.text).toBe(
      "Waiting for re-check on 11 Oct at 14:05",
    );
    expect(companySequenceLabel([seq({ state: "RECHECK", currentStep: 0, countsAsEmailed: true })], TZ, NOW)?.text).toBe("Waiting for re-check");
  });

  it("M6-DESIGN §2.2, L18: tells whether the company's current sequence is a test-list send", () => {
    expect(isTestListSequence([seq({ countsAsEmailed: false, state: "FINISHED" })])).toBe(true);
    // A live campaign launched after go-live, a dry run and test mode aren't test-list sends.
    expect(isTestListSequence([seq({ countsAsEmailed: true, state: "FINISHED" })])).toBe(false);
    expect(isTestListSequence([seq({ campaignMode: "DRY_RUN", countsAsEmailed: false })])).toBe(false);
    expect(isTestListSequence([seq({ campaignMode: "TEST", countsAsEmailed: false })])).toBe(false);
    expect(isTestListSequence([])).toBe(false);
    // The same pick as the Sequence column: a sequence still in progress wins over a finished test-list one.
    const oldTest = seq({ id: 2, campaignId: 1, countsAsEmailed: false, state: "FINISHED" });
    const running = seq({ id: 3, campaignId: 2, countsAsEmailed: true, state: "WAITING" });
    expect(isTestListSequence([oldTest, running])).toBe(false);
    expect(isTestListSequence([oldTest])).toBe(true);
  });
});

describe("the people table row of a person waiting for a second address check (M5)", () => {
  it("shows when the re-check is due", () => {
    const row = toRecipientRowView(
      {
        id: 8,
        name: "Greta Grau",
        email: "g@greylist.test",
        companyId: 4,
        companyName: "Grau AG",
        companyDeleted: false,
        state: "RECHECK",
        included: true,
        currentStep: 0,
        nextDueAt: at("2026-10-10T08:00:00Z"),
        stopReason: null,
        recheckAt: at("2026-10-11T12:05:00Z"),
        exclusionReason: null,
        hasEdits: false,
        emails: [{ step: 0, status: "QUEUED", dueAt: at("2026-10-10T08:00:00Z"), sentAt: null, lastError: null }],
      },
      { campaignId: 4, campaignStatus: "RUNNING", query: {} },
      TZ,
      NOW,
    );
    expect(row.stateText).toBe("Waiting for re-check on 11 Oct at 14:05");
    expect(row.leftOut).toBe(false);
  });
});

describe("the campaign page's hold notices (§9.3)", () => {
  it("counts companies waiting for a possible reply to be checked", () => {
    expect(possibleReplyNotice(0)).toBeNull();
    expect(possibleReplyNotice(1)).toBe("Follow-ups to 1 company are on hold until someone checks a possible reply.");
    expect(possibleReplyNotice(2)).toBe("Follow-ups to 2 companies are on hold until someone checks a possible reply.");
    expect(WAITING_REPLIES_HREF).toBe("/notifications#replies");
  });

  const hold = { outage: { followUps: 5, firstEmails: 0 }, outageFrom: "2026-10-03T06:00:00.000Z", outageTo: "2026-10-09T06:00:00.000Z" };
  const ctx = { senderName: "Ali", viewerIsSender: false, viewerIsOwner: false, timeZone: TZ, now: NOW };

  // The dates are the window the app couldn't check, worded as replies that may have been missed (review SPEC-03).
  it("says who can continue the follow-ups held after the PC was off, in the viewer's zone", () => {
    expect(outageHoldNotice(hold, ctx)).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali can continue them from Notifications after checking their inbox.",
    );
    expect(outageHoldNotice(hold, { ...ctx, viewerIsOwner: true })).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali can continue them from Notifications after checking their inbox. You can also continue them in Settings › Sending & Mailgun.",
    );
    expect(outageHoldNotice(hold, { ...ctx, viewerIsSender: true })).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. You can continue them from Notifications after checking your inbox.",
    );
    // Another zone reads other dates.
    expect(outageHoldNotice({ ...hold, outageFrom: "2026-10-03T02:00:00.000Z", outageTo: "2026-10-09T02:00:00.000Z" }, { ...ctx, timeZone: "America/New_York" })).toMatch(
      /from 2 Oct to 8 Oct/,
    );
  });

  it("names colleagues' first emails, a sender that's gone, and nothing held", () => {
    expect(outageHoldNotice({ ...hold, outage: { followUps: 1, firstEmails: 2 } }, ctx)).toBe(
      "Follow-ups of 1 person are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali can continue them from Notifications after checking their inbox. First emails to 2 other people at those companies wait too.",
    );
    expect(outageHoldNotice(hold, { ...ctx, senderName: null })).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. The Owner can continue them in Settings › Sending & Mailgun.",
    );
    expect(outageHoldNotice({ ...hold, outage: { followUps: 0, firstEmails: 3 } }, ctx)).toBe(
      "First emails to 3 people are on hold because replies from 3 Oct to 9 Oct may have been missed. They go once everyone who emailed their company has checked their inbox.",
    );
    expect(outageHoldNotice({ ...hold, outage: { followUps: 0, firstEmails: 0 } }, ctx)).toBeNull();
    expect(outageHoldNotice({ ...hold, outageFrom: null, outageTo: null }, ctx)).toMatch(/because the PC was off too long to check for replies\./);
  });

  it("says only the Owner can continue the follow-ups of a switched-off sender (review SPEC-04)", () => {
    expect(outageHoldNotice(hold, { ...ctx, senderActive: false })).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali is switched off, so only the Owner can continue them in Settings › Sending & Mailgun.",
    );
    expect(outageHoldNotice(hold, { ...ctx, senderActive: false, viewerIsOwner: true })).toBe(
      "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali is switched off. You can continue them in Settings › Sending & Mailgun.",
    );
    expect(outageHoldNotice({ ...hold, outage: { followUps: 2, firstEmails: 1 } }, { ...ctx, senderActive: false })).toBe(
      "Follow-ups of 2 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali is switched off, so only the Owner can continue them in Settings › Sending & Mailgun. First emails to 1 other person at those companies wait too.",
    );
    // An active sender keeps the usual words.
    expect(outageHoldNotice(hold, { ...ctx, senderActive: true })).toBe(outageHoldNotice(hold, ctx));
  });

  it("explains the two new waiting reasons", () => {
    // "outage-hold": while the app puts the hold in place, and while the hold covers someone it doesn't hold (a Retry).
    expect(waitingText({ reason: "outage-hold", until: null }, { timeZone: TZ, now: NOW })).toBe(
      "Waiting: replies may have been missed while the PC was off. These emails go once that has been checked.",
    );
    expect(waitingText({ reason: "possible-reply", until: null }, { timeZone: TZ, now: NOW })).toBe(
      "Waiting: someone needs to decide whether a message from this company is a real reply (Notifications page).",
    );
  });
});
