import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecipientTimeline,
  campaignDateParts,
  campaignHref,
  campaignPageHref,
  campaignProgress,
  campaignsHref,
  companySequenceLabel,
  defaultCampaignTab,
  delayText,
  emptyTabCounts,
  lowerFirst,
  outboxHref,
  parseCampaignTab,
  parseRecipientFilter,
  pausedText,
  percentDone,
  progressDoneText,
  recipientEmptyText,
  recipientName,
  recipientStateText,
  recipientStepViews,
  resultsNote,
  shortStopReason,
  stepProgressText,
  stepsSummary,
  tabForStatus,
  theStep,
  toCampaignListView,
  toRecipientRowView,
  wizardHref,
  type CompanySequence,
  type StepProgress,
  type StepViewInput,
} from "@/components/campaigns/format";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-10T10:00:00Z");
const at = (iso: string) => new Date(iso);

function step(over: Partial<StepProgress>): StepProgress {
  return {
    step: 0,
    delayDays: 0,
    planned: 0,
    sent: 0,
    waiting: 0,
    sending: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    unsure: 0,
    nextDueAt: null,
    ...over,
  };
}

describe("small helpers", () => {
  it("lower-cases only an ordinary first letter", () => {
    expect(lowerFirst("Emailed by Ali")).toBe("emailed by Ali");
    expect(lowerFirst("OK then")).toBe("OK then");
    expect(lowerFirst("already lower")).toBe("already lower");
    expect(lowerFirst("  Skipped by Sara ")).toBe("skipped by Sara");
  });

  it("names people: their name, General inbox, or the address", () => {
    expect(recipientName({ name: "Anna Berg", email: "anna@x.de" })).toBe("Anna Berg");
    expect(recipientName({ name: "General inbox", email: "info@x.de", isGeneric: true })).toBe("General inbox");
    expect(recipientName({ name: "", email: "anna@x.de" })).toBe("anna@x.de");
    expect(recipientName({ name: "", email: null }, "fallback@x.de")).toBe("fallback@x.de");
  });

  it("names a step inside a sentence", () => {
    expect(theStep(0)).toBe("the first email");
    expect(theStep(2)).toBe("follow-up 2");
  });
});

describe("tabs and links", () => {
  it("parses tabs and picks a useful default", () => {
    expect(parseCampaignTab("running")).toBe("running");
    expect(parseCampaignTab("RUNNING")).toBeNull();
    expect(parseCampaignTab(undefined)).toBeNull();
    const counts = emptyTabCounts();
    expect(defaultCampaignTab(counts)).toBeNull();
    counts.drafts = 2;
    expect(defaultCampaignTab(counts)).toBe("drafts");
    counts.paused = 1;
    expect(defaultCampaignTab(counts)).toBe("paused");
    counts.running = 1;
    expect(defaultCampaignTab(counts)).toBe("running");
    expect(tabForStatus("FINISHED")).toBe("finished");
    expect(tabForStatus("DRAFT")).toBe("drafts");
  });

  it("sends drafts into the wizard at their step (1 to 6, by the wizard's route names)", () => {
    expect(wizardHref(7, 3)).toBe("/campaigns/7/setup/message");
    expect(wizardHref(7, 0)).toBe("/campaigns/7/setup/audience");
    expect(wizardHref(7, 99)).toBe("/campaigns/7/setup/schedule");
    expect(wizardHref(7, null)).toBe("/campaigns/7/setup/audience");
    expect(campaignHref({ id: 7, status: "DRAFT", wizardStep: 5 })).toBe("/campaigns/7/setup/review");
    expect(campaignHref({ id: 7, status: "RUNNING", wizardStep: 6 })).toBe("/campaigns/7");
  });

  it("only links drafts to wizard pages that exist", () => {
    const setupDir = path.resolve(process.cwd(), "src", "app", "(app)", "campaigns", "[id]", "setup");
    for (let n = 1; n <= 6; n += 1) {
      const m = wizardHref(7, n).match(/^\/campaigns\/7\/setup\/([a-z]+)$/);
      expect(m, `wizardHref(7, ${n})`).not.toBeNull();
      expect(fs.existsSync(path.join(setupDir, m![1]!, "page.tsx")), `setup/${m![1]}/page.tsx`).toBe(true);
    }
  });

  it("builds list, campaign page and outbox addresses", () => {
    expect(campaignsHref()).toBe("/campaigns");
    expect(campaignsHref("paused")).toBe("/campaigns?tab=paused");
    expect(campaignsHref("paused", 1)).toBe("/campaigns?tab=paused");
    expect(campaignsHref("paused", 3)).toBe("/campaigns?tab=paused&page=3");
    expect(campaignPageHref(4)).toBe("/campaigns/4");
    expect(campaignPageHref(4, { filter: "all", q: "  ", page: 1 })).toBe("/campaigns/4");
    expect(campaignPageHref(4, { filter: "stopped", q: " anna ", page: 2, recipient: 9 })).toBe(
      "/campaigns/4?filter=stopped&q=anna&page=2&recipient=9",
    );
    expect(outboxHref()).toBe("/campaigns/outbox");
    expect(outboxHref({ campaignId: 3, page: 2, open: 55 })).toBe("/campaigns/outbox?campaign=3&page=2&open=55");
  });

  it("parses the recipient filter (anything unknown shows everyone)", () => {
    expect(parseRecipientFilter("problems")).toBe("problems");
    expect(parseRecipientFilter("nonsense")).toBe("all");
    expect(parseRecipientFilter(undefined)).toBe("all");
    expect(recipientEmptyText("excluded")).toBe("Nobody was left out.");
    expect(recipientEmptyText("all", "anna")).toBe("Nobody in this campaign matches your search.");
  });
});

describe("dates", () => {
  const base = {
    startAt: at("2026-10-03T12:05:00Z"),
    launchedAt: at("2026-10-01T08:00:00Z"),
    finishedAt: at("2026-10-05T09:30:00Z"),
    pausedAt: at("2026-10-04T07:00:00Z"),
    updatedAt: at("2026-10-10T08:00:00Z"),
  };

  it("words each status in the viewer's time zone", () => {
    expect(campaignDateParts({ ...base, status: "DRAFT" }, TZ, NOW)).toEqual(["Last changed 2 hours ago"]);
    expect(campaignDateParts({ ...base, status: "SCHEDULED" }, TZ, NOW)).toEqual(["Starts 3 Oct 2026, 14:05"]);
    expect(campaignDateParts({ ...base, status: "RUNNING" }, TZ, NOW)).toEqual(["Started 3 Oct 2026, 14:05"]);
    expect(campaignDateParts({ ...base, status: "PAUSED" }, TZ, NOW)).toEqual(["Started 3 Oct 2026, 14:05", "Paused 4 Oct 2026, 09:00"]);
    expect(campaignDateParts({ ...base, status: "FINISHED" }, TZ, NOW)).toEqual([
      "Started 3 Oct 2026, 14:05",
      "Finished 5 Oct 2026, 11:30",
    ]);
    expect(campaignDateParts({ ...base, status: "CANCELLED" }, "Asia/Karachi", NOW)).toEqual([
      "Started 3 Oct 2026, 17:05",
      "Cancelled 5 Oct 2026, 14:30",
    ]);
    expect(campaignDateParts({ ...base, startAt: null, status: "RUNNING" }, TZ, NOW)).toEqual(["Started 1 Oct 2026, 10:00"]);
  });
});

describe("progress", () => {
  it("counts every step for people still in progress", () => {
    // 10 people, first email + 3 follow-ups, every first email sent.
    const p = campaignProgress({ openRecipients: 10, enabledSteps: 4, sentAll: 10, sentClosed: 0, resolvedClosed: 0 });
    expect(p).toEqual({ done: 10, total: 40 });
    expect(percentDone(p)).toBe(25);
  });

  it("counts only what was dealt with for people who finished or stopped", () => {
    // 8 still waiting (first email sent), 1 finished (4 sent), 1 skipped before anything (1 skipped email).
    const p = campaignProgress({ openRecipients: 8, enabledSteps: 4, sentAll: 12, sentClosed: 4, resolvedClosed: 5 });
    expect(p).toEqual({ done: 13, total: 37 });
  });

  it("says how far along a campaign is, and why it's paused", () => {
    expect(progressDoneText({ done: 120, total: 450 })).toBe("26% · 120 of 450 emails done");
    expect(progressDoneText({ done: 1, total: 1 })).toBe("100% · 1 of 1 email done");
    const when = at("2026-10-04T07:00:00Z");
    expect(pausedText(when, "Paused by Ali", TZ)).toBe("Paused by Ali on 4 Oct 2026, 09:00. Nothing is sent until you resume it.");
    expect(pausedText(when, "Too many bounces.", TZ)).toBe("Paused on 4 Oct 2026, 09:00: too many bounces. Nothing is sent until you resume it.");
    expect(pausedText(null, null, TZ)).toBe("Paused. Nothing is sent until you resume it.");
  });

  it("is 100% only when everything is done, and never divides by zero", () => {
    expect(percentDone({ done: 0, total: 0 })).toBe(0);
    expect(percentDone({ done: 199, total: 200 })).toBe(99);
    expect(percentDone({ done: 200, total: 200 })).toBe(100);
    const finished = campaignProgress({ openRecipients: 0, enabledSteps: 1, sentAll: 3, sentClosed: 3, resolvedClosed: 5 });
    expect(percentDone(finished)).toBe(100);
  });

  it("words each step like the plan: first email, then follow-ups", () => {
    const first = step({ step: 0, planned: 150, sent: 120 });
    const follow = step({ step: 1, delayDays: 3, waiting: 40, nextDueAt: at("2026-10-14T07:00:00Z") });
    expect(stepProgressText(first, TZ, NOW)).toBe("First email 120 of 150 sent");
    expect(stepProgressText(follow, TZ, NOW)).toBe("Follow-up 1: 40 waiting, next on 14 Oct");
    expect(stepsSummary([first, follow], TZ, NOW)).toBe("First email 120 of 150 sent · Follow-up 1: 40 waiting, next on 14 Oct");
  });

  it("adds skipped, didn't send, not sure and cancelled counts", () => {
    expect(stepProgressText(step({ step: 0, planned: 150, sent: 1200, skipped: 2, failed: 1, unsure: 1, sending: 3 }), TZ, NOW)).toBe(
      "First email 1,200 of 150 sent, 3 sending now, 2 skipped, 1 didn't send, 1 not sure it was sent",
    );
    expect(stepProgressText(step({ step: 2, sent: 12, waiting: 5, nextDueAt: at("2026-10-08T07:00:00Z"), cancelled: 4 }), TZ, NOW)).toBe(
      "Follow-up 2: 12 sent, 5 waiting, due 8 Oct, 4 cancelled",
    );
    expect(stepProgressText(step({ step: 3 }), TZ, NOW)).toBe("Follow-up 3: nothing yet");
  });

  it("says when a follow-up goes", () => {
    expect(delayText(3, 0)).toBe("3 days after the first email if there's no reply");
    expect(delayText(1, 2)).toBe("1 day after follow-up 2 if there's no reply");
    expect(delayText(4, null)).toBe("4 days after the previous email if there's no reply");
    expect(delayText(3, 0, true)).toBe("3 minutes after the first email if there's no reply");
  });

  it("explains the counts per mode", () => {
    expect(resultsNote("DRY_RUN")).toBe("Dry run: delivery results appear only when you simulate them in the dry-run outbox.");
    expect(resultsNote(null)).toBe(resultsNote("DRY_RUN"));
    expect(resultsNote("TEST")).toBe("Test mode: Mailgun reports every email as delivered without delivering it.");
    expect(resultsNote("LIVE")).toBeNull();
  });
});

describe("stop reasons and states", () => {
  it("says why someone stopped in a few words", () => {
    expect(shortStopReason("replied")).toBe("replied");
    expect(shortStopReason("Skipped by Ali")).toBe("skipped by Ali");
    expect(shortStopReason("status:CLIENT")).toBe("marked Client");
    expect(shortStopReason("status:DO_NOT_CONTACT")).toBe("marked Do not contact");
    expect(shortStopReason("failed")).toBe("didn't send");
    expect(shortStopReason("campaign_cancelled")).toBe("campaign cancelled");
    expect(shortStopReason("unsubscribed")).toBe("unsubscribed");
    expect(shortStopReason("company_deleted")).toBe("company deleted");
    expect(shortStopReason("Emailed by Ali 12 days ago (Germany Q4, first email).")).toBe("emailed by Ali 12 days ago (Germany Q4, first email)");
    expect(shortStopReason("some_new_code")).toBe("some new code");
    expect(shortStopReason(null)).toBe("");
  });

  const base = { currentStep: 0, nextDueAt: null, stopReason: null, campaignStatus: "RUNNING" as const };

  it("words every state", () => {
    expect(recipientStateText({ ...base, state: "SCHEDULED", nextDueAt: at("2026-10-12T08:00:00Z") }, TZ, NOW)).toBe("Scheduled for 12 Oct");
    expect(recipientStateText({ ...base, state: "SCHEDULED", nextDueAt: at("2026-10-10T09:00:00Z") }, TZ, NOW)).toBe("First email waiting to send");
    expect(recipientStateText({ ...base, state: "WAITING", currentStep: 1, nextDueAt: at("2026-10-14T08:00:00Z") }, TZ, NOW)).toBe(
      "Waiting for follow-up 1 on 14 Oct",
    );
    expect(recipientStateText({ ...base, state: "WAITING", currentStep: 2, nextDueAt: at("2026-10-08T08:00:00Z") }, TZ, NOW)).toBe(
      "Follow-up 2 waiting to send since 8 Oct",
    );
    expect(recipientStateText({ ...base, state: "FINISHED" }, TZ, NOW)).toBe("Finished");
    expect(recipientStateText({ ...base, state: "STOPPED", stopReason: "Skipped by Ali" }, TZ, NOW)).toBe("Stopped: skipped by Ali");
    expect(recipientStateText({ ...base, state: "STOPPED", stopReason: "replied" }, TZ, NOW)).toBe("Stopped: they replied");
    expect(recipientStateText({ ...base, state: "STOPPED" }, TZ, NOW)).toBe("Stopped");
    expect(recipientStateText({ ...base, state: "HELD", holdReason: "outage" }, TZ, NOW)).toBe(
      "On hold: replies may have been missed while the PC was off",
    );
    expect(recipientStateText({ ...base, state: "RECHECK" }, TZ, NOW)).toBe("Waiting for re-check");
    expect(recipientStateText({ ...base, state: "PENDING", campaignStatus: "DRAFT" }, TZ, NOW)).toBe("Not launched yet");
  });

  it("says when a person waiting for a second address check is checked again (M5, viewer's zone)", () => {
    const recheckAt = at("2026-10-11T12:05:00Z");
    expect(recipientStateText({ ...base, state: "RECHECK", recheckAt }, TZ, NOW)).toBe("Waiting for re-check on 11 Oct at 14:05");
    expect(recipientStateText({ ...base, state: "RECHECK", recheckAt: "2026-10-11T12:05:00.000Z" }, "Asia/Karachi", NOW)).toBe(
      "Waiting for re-check on 11 Oct at 17:05",
    );
    // Another year: the date says so (the shared short-date rule).
    expect(recipientStateText({ ...base, state: "RECHECK", recheckAt: at("2027-01-02T08:30:00Z") }, TZ, NOW)).toMatch(
      /^Waiting for re-check on 2 Jan 2027 at 09:30$/,
    );
    expect(recipientStateText({ ...base, state: "RECHECK", recheckAt: null }, TZ, NOW)).toBe("Waiting for re-check");
    // A recheckAt kept after the release is never read in another state.
    expect(recipientStateText({ ...base, state: "SCHEDULED", recheckAt, nextDueAt: at("2026-10-12T08:00:00Z") }, TZ, NOW)).toBe(
      "Scheduled for 12 Oct",
    );
  });

  it("words the address check's stop code (M5)", () => {
    expect(shortStopReason("invalid")).toBe("the address check said not to email it");
    expect(recipientStateText({ ...base, state: "STOPPED", stopReason: "invalid" }, TZ, NOW)).toBe(
      "Stopped: the address check said not to email it",
    );
    expect(recipientStateText({ ...base, state: "EXCLUDED", included: false, exclusionReason: "Address couldn't be checked" }, TZ, NOW)).toBe(
      "Left out: address couldn't be checked",
    );
  });

  it("says who was left out and why", () => {
    expect(recipientStateText({ ...base, state: "EXCLUDED", included: false, exclusionReason: "Unsubscribed" }, TZ, NOW)).toBe(
      "Left out: unsubscribed",
    );
    expect(recipientStateText({ ...base, state: "PENDING", included: false }, TZ, NOW)).toBe("Left out");
  });

  it("uses the email's own state and the campaign's", () => {
    const due = at("2026-10-12T08:00:00Z");
    expect(recipientStateText({ ...base, state: "SCHEDULED", email: { status: "SENDING", dueAt: due } }, TZ, NOW)).toBe(
      "Sending the first email now",
    );
    expect(recipientStateText({ ...base, state: "WAITING", currentStep: 1, email: { status: "UNCONFIRMED", dueAt: due } }, TZ, NOW)).toBe(
      "Not sure follow-up 1 was sent",
    );
    expect(recipientStateText({ ...base, state: "SCHEDULED", email: { status: "FAILED", dueAt: due } }, TZ, NOW)).toBe(
      "First email didn't send",
    );
    expect(recipientStateText({ ...base, state: "SCHEDULED", email: { status: "QUEUED", dueAt: due, lastError: "Oops" } }, TZ, NOW)).toBe(
      "Trying the first email again soon",
    );
    expect(recipientStateText({ ...base, state: "SCHEDULED", campaignStatus: "PAUSED", nextDueAt: due }, TZ, NOW)).toBe(
      "Paused before the first email",
    );
    expect(recipientStateText({ ...base, state: "WAITING", currentStep: 1, campaignStatus: "CANCELLED" }, TZ, NOW)).toBe(
      "Stopped: campaign cancelled",
    );
  });
});

describe("the Contacts Sequence column", () => {
  function seq(over: Partial<CompanySequence>): CompanySequence {
    return {
      id: 1,
      companyId: 5,
      campaignId: 1,
      campaignName: "Germany Q4",
      campaignStatus: "RUNNING",
      campaignMode: "DRY_RUN",
      countsAsEmailed: false,
      personId: 9,
      state: "WAITING",
      currentStep: 1,
      nextDueAt: at("2026-10-14T08:00:00Z"),
      stopReason: null,
      updatedAt: at("2026-10-09T08:00:00Z"),
      ...over,
    };
  }

  it("marks dry runs on the real data, but not in the practice copy", () => {
    expect(companySequenceLabel([seq({})], TZ, NOW)).toEqual({
      text: "Waiting for follow-up 1 on 14 Oct (dry run)",
      title: "Germany Q4 · a dry run: nothing was really sent",
    });
    expect(companySequenceLabel([seq({ countsAsEmailed: true })], TZ, NOW)).toEqual({
      text: "Waiting for follow-up 1 on 14 Oct",
      title: "Germany Q4",
    });
    expect(companySequenceLabel([seq({ campaignMode: "LIVE", countsAsEmailed: true, state: "FINISHED" })], TZ, NOW)?.text).toBe("Finished");
    expect(companySequenceLabel([seq({ campaignMode: "TEST", state: "STOPPED", stopReason: "replied" })], TZ, NOW)?.text).toBe(
      "Stopped: they replied (test)",
    );
  });

  it("prefers a sequence still in progress over a newer finished one", () => {
    const active = seq({ id: 2, campaignId: 1, state: "SCHEDULED", currentStep: 0, nextDueAt: at("2026-10-12T08:00:00Z") });
    const done = seq({ id: 3, campaignId: 2, campaignName: "Norway", state: "FINISHED", countsAsEmailed: true, campaignMode: "LIVE" });
    expect(companySequenceLabel([done, active], TZ, NOW)?.text).toBe("Scheduled for 12 Oct (dry run)");
    expect(companySequenceLabel([done], TZ, NOW)?.title).toBe("Norway");
    expect(companySequenceLabel([], TZ, NOW)).toBeNull();
  });

  it("says Paused when the campaign is paused", () => {
    expect(companySequenceLabel([seq({ campaignStatus: "PAUSED", countsAsEmailed: true })], TZ, NOW)?.text).toBe("Paused before follow-up 1");
  });
});

describe("the recipient panel", () => {
  const steps = [
    { step: 0, enabled: true, delayDays: 0 },
    { step: 1, enabled: true, delayDays: 3 },
    { step: 2, enabled: false, delayDays: 4 },
    { step: 3, enabled: true, delayDays: 7 },
  ];
  function input(over: Partial<StepViewInput>): StepViewInput {
    return {
      campaignStatus: "RUNNING",
      recipient: { state: "WAITING", included: true, stopReason: null },
      steps,
      emails: [
        { id: 11, step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
        { id: 12, step: 1, status: "QUEUED", dueAt: at("2026-10-14T08:00:00Z"), sentAt: null, lastError: null },
      ],
      ...over,
    };
  }

  it("shows each email that's switched on or already exists, with what can be done", () => {
    const views = recipientStepViews(input({}), TZ, NOW);
    expect(views.map((v) => [v.step, v.kind, v.canEdit, v.canRetry])).toEqual([
      [0, "sent", false, false],
      [1, "waiting", true, false],
      [3, "planned", true, false],
    ]);
    expect(views[0]!.note).toBe("Sent 3 Oct 2026, 10:00");
    expect(views[1]!.note).toBe("Waiting to send, due 14 Oct 2026, 10:00");
    expect(views[2]!.note).toBe("Goes 7 days after follow-up 1 if there's no reply");
  });

  it("offers nothing to edit once the campaign has ended or the person stopped", () => {
    expect(recipientStepViews(input({ campaignStatus: "FINISHED" }), TZ, NOW).some((v) => v.canEdit)).toBe(false);
    const stopped = recipientStepViews(
      input({
        recipient: { state: "STOPPED", included: true, stopReason: "Skipped by Ali" },
        emails: [
          { id: 11, step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
          { id: 12, step: 1, status: "SKIPPED", dueAt: at("2026-10-14T08:00:00Z"), sentAt: null, lastError: "Skipped by Ali" },
        ],
      }),
      TZ,
      NOW,
    );
    expect(stopped.map((v) => [v.kind, v.note])).toEqual([
      ["sent", "Sent 3 Oct 2026, 10:00"],
      ["skipped", "Skipped by Ali"],
      ["not-sent", "Won't be sent"],
    ]);
  });

  it("offers Try again for an email that didn't send", () => {
    const failed = recipientStepViews(
      input({
        recipient: { state: "STOPPED", included: true, stopReason: "failed" },
        emails: [{ id: 11, step: 0, status: "FAILED", dueAt: at("2026-10-03T08:00:00Z"), sentAt: null, lastError: "Couldn't prepare this email: the template is broken." }],
      }),
      TZ,
      NOW,
    );
    expect(failed[0]).toMatchObject({ kind: "problem", canRetry: true, note: "Didn't send: couldn't prepare this email: the template is broken." });
    const cancelled = recipientStepViews(
      input({
        campaignStatus: "CANCELLED",
        recipient: { state: "STOPPED", included: true, stopReason: "failed" },
        emails: [{ id: 11, step: 0, status: "FAILED", dueAt: at("2026-10-03T08:00:00Z"), sentAt: null, lastError: null }],
      }),
      TZ,
      NOW,
    );
    expect(cancelled[0]!.canRetry).toBe(false);
  });

  it("keeps a sent email whose step was switched off later, and says when a waiting one had trouble", () => {
    const views = recipientStepViews(
      input({
        emails: [
          { id: 11, step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
          { id: 13, step: 2, status: "QUEUED", dueAt: at("2026-10-09T08:00:00Z"), sentAt: null, lastError: "Mailgun said no." },
        ],
      }),
      TZ,
      NOW,
    );
    expect(views.map((v) => v.step)).toEqual([0, 1, 2, 3]);
    expect(views[2]!.note).toBe("Waiting to send. The last try didn't work (mailgun said no); it will be tried again");
  });

  it("builds the timeline: emails to come first, then what happened, newest first", () => {
    const items = buildRecipientTimeline(
      {
        emails: [
          { id: 12, step: 1, status: "QUEUED", dueAt: at("2026-10-14T08:00:00Z"), sentAt: null, lastError: null },
          { id: 11, step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
        ],
        activity: [
          { id: 1, at: at("2026-10-03T08:00:05Z"), summary: "First email sent to anna@x.de (Germany Q4)", actorName: "Ali", mode: "DRY_RUN" },
          { id: 2, at: at("2026-10-05T08:00:00Z"), summary: "Sara edited the follow-up 1 to Anna (Germany Q4)", actorName: "Sara", mode: "DRY_RUN" },
        ],
      },
      TZ,
      NOW,
    );
    expect(items.map((i) => [i.text, i.upcoming, i.modeLabel])).toEqual([
      ["Follow-up 1 is due", true, null],
      ["Sara edited the follow-up 1 to Anna (Germany Q4)", false, "Dry run"],
      ["First email sent to anna@x.de (Germany Q4)", false, "Dry run"],
    ]);
    expect(items[0]!.exact).toBe("14 Oct 2026, 10:00");
  });
});

describe("list and table rows", () => {
  const listBase = {
    id: 3,
    name: "Germany Q4",
    mode: "DRY_RUN" as const,
    wizardStep: 6,
    senderName: "Ali",
    audience: 150,
    firstEmail: { sent: 120, planned: 150 },
    enabledSteps: 3,
    progress: { done: 120, total: 450 },
    startAt: at("2026-10-03T12:05:00Z"),
    launchedAt: at("2026-10-03T12:05:00Z"),
    finishedAt: null,
    pausedAt: null,
    pauseReason: null,
    updatedAt: at("2026-10-03T12:05:00Z"),
  };

  it("pre-formats a running campaign", () => {
    const v = toCampaignListView({ ...listBase, status: "RUNNING" }, TZ, NOW);
    expect(v).toMatchObject({
      href: "/campaigns/3",
      statusLabel: "Running",
      mode: "DRY_RUN",
      modeLabel: "Dry run",
      sender: "Sent by Ali",
      audience: "150 people",
      percent: 26,
      progressText: "First email 120 of 150 sent · 2 follow-ups",
      progressTitle: "26% · 120 of 450 emails done (sent, skipped, or won't be sent)",
      dates: ["Started 3 Oct 2026, 14:05"],
    });
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });

  it("pre-formats a draft and a paused campaign", () => {
    const draft = toCampaignListView({ ...listBase, status: "DRAFT", mode: null, senderName: null, audience: 12 }, TZ, NOW);
    expect(draft).toMatchObject({
      href: "/campaigns/3/setup/schedule",
      isDraft: true,
      mode: null,
      sender: "No sender chosen yet",
      audience: "12 people ticked",
      percent: null,
      progressText: null,
    });
    const paused = toCampaignListView({ ...listBase, status: "PAUSED", pausedAt: at("2026-10-04T07:00:00Z"), pauseReason: "Paused by Sara" }, TZ, NOW);
    expect(paused.pauseReason).toBe("Paused by Sara");
    expect(paused.dates).toEqual(["Started 3 Oct 2026, 14:05", "Paused 4 Oct 2026, 09:00"]);
  });

  it("pre-formats a person in the table", () => {
    const view = toRecipientRowView(
      {
        id: 21,
        name: "Anna Berg",
        email: "anna@acme.de",
        companyId: 5,
        companyName: "Acme",
        companyDeleted: false,
        state: "WAITING",
        included: true,
        currentStep: 1,
        nextDueAt: at("2026-10-14T08:00:00Z"),
        stopReason: null,
        exclusionReason: null,
        hasEdits: true,
        emails: [
          { step: 0, status: "SENT", dueAt: at("2026-10-03T08:00:00Z"), sentAt: at("2026-10-03T08:00:05Z"), lastError: null },
          { step: 1, status: "QUEUED", dueAt: at("2026-10-14T08:00:00Z"), sentAt: null, lastError: null },
        ],
      },
      { campaignId: 3, campaignStatus: "RUNNING", query: { filter: "active", q: "acme", page: 2 } },
      TZ,
      NOW,
    );
    expect(view).toEqual({
      id: 21,
      href: "/campaigns/3?filter=active&q=acme&page=2&recipient=21",
      name: "Anna Berg",
      email: "anna@acme.de",
      companyName: "Acme",
      companyHref: "/contacts?company=5",
      stateText: "Waiting for follow-up 1 on 14 Oct",
      lastSent: "First email sent 3 Oct",
      edited: true,
      problem: false,
      leftOut: false,
    });
  });

  it("flags problems and deleted companies", () => {
    const view = toRecipientRowView(
      {
        id: 22,
        name: "info@acme.de",
        email: "info@acme.de",
        companyId: 6,
        companyName: "Gone GmbH",
        companyDeleted: true,
        state: "STOPPED",
        included: true,
        currentStep: 0,
        nextDueAt: null,
        stopReason: "failed",
        exclusionReason: null,
        hasEdits: false,
        emails: [{ step: 0, status: "FAILED", dueAt: at("2026-10-03T08:00:00Z"), sentAt: null, lastError: "Broken" }],
      },
      { campaignId: 3, campaignStatus: "RUNNING", query: {} },
      TZ,
      NOW,
    );
    expect(view).toMatchObject({
      companyName: "Gone GmbH (deleted)",
      companyHref: null,
      stateText: "Stopped: didn't send",
      lastSent: null,
      problem: true,
    });
  });
});
