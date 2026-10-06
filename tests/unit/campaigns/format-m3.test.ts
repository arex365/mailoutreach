import { describe, expect, it } from "vitest";
import {
  EMAIL_STATUS_LABELS,
  recipientStateText,
  recipientStepViews,
  resultsNote,
  waitingText,
  type PanelEmail,
  type StepViewInput,
} from "@/components/campaigns/format";

/**
 * The campaign page's Milestone 3 words (M3-DESIGN §5.8): why emails wait, "Checking whether it was sent" before
 * "Not sure it was sent", no Retry for an email Mailgun already has, and Mailgun's own words behind Details.
 */

const TZ = "Europe/Berlin";
const NOW = new Date("2026-09-23T08:00:00Z"); // 10:00 in Berlin

describe("waitingText", () => {
  const w = (reason: Parameters<typeof waitingText>[0]["reason"], until: Date | string | null = null) => waitingText({ reason, until }, { timeZone: TZ, now: NOW, senderName: "Ali" });

  it("says why the next email waits, in plain words", () => {
    expect(w("paused")).toBe("Waiting: sending is paused for everyone.");
    expect(w("restore-check")).toBe("Waiting for the restore check with Mailgun.");
    expect(w("mailgun-not-connected")).toBe("Waiting: Mailgun isn't connected. The Owner can connect it in Settings › Sending & Mailgun.");
    expect(w("catch-up")).toBe("Waiting for the check with Mailgun.");
    expect(w("live-not-ready")).toBe(
      "Waiting: Mailgun's unsubscribe handling or tracking settings changed. The Owner can fix them in Settings › Domain checklist.",
    );
    expect(w("reply-route")).toBe("Waiting: replies to Ali can't reach Ali yet.");
    expect(w("pending-events")).toBe("Waiting: a reply or a Mailgun report for one address hasn't been processed yet.");
    expect(w("cap-reached")).toBe("Today's limit is reached. Sending continues tomorrow.");
    expect(w("sender-cap")).toBe("Ali reached their own daily limit. Sending continues tomorrow.");
    expect(w("nothing-due")).toBeNull();
  });

  it("shows the time in the viewer's zone, with the date when it isn't today", () => {
    expect(w("rate-limited", new Date("2026-09-23T08:05:00Z"))).toBe("Waiting: Mailgun asked us to slow down; trying again at 10:05.");
    expect(w("rate-limited")).toBe("Waiting: Mailgun asked us to slow down.");
    expect(w("mailgun-unreachable", "2026-09-23T09:00:00.000Z")).toBe("Waiting: Mailgun didn't answer; trying again at 11:00.");
    expect(w("mailgun-unreachable")).toBe("Waiting: Mailgun didn't answer; trying again soon.");
    expect(w("outside-hours", new Date("2026-09-24T07:00:00Z"))).toMatch(/^Waiting for sending hours: the next window opens at 24 Sept?, 09:00\.$/);
    expect(w("outside-hours")).toBe("Waiting for sending hours.");
  });

  it("counts the pacer's gap in minutes", () => {
    expect(w("pacing")).toBe("Next email in a moment.");
    expect(w("pacing", new Date(NOW.getTime() + 30_000))).toBe("Next email in about a minute.");
    expect(w("pacing", new Date(NOW.getTime() + 4 * 60_000))).toBe("Next email in about 4 minutes.");
  });

  it("falls back to 'the sender' without a name", () => {
    expect(waitingText({ reason: "sender-cap", until: null }, { timeZone: TZ, now: NOW })).toBe(
      "The sender reached their own daily limit. Sending continues tomorrow.",
    );
  });
});

describe("emails whose outcome isn't known", () => {
  it("has two stages: checking first, then not sure", () => {
    expect(EMAIL_STATUS_LABELS.UNKNOWN).toBe("Checking whether it was sent");
    expect(EMAIL_STATUS_LABELS.UNCONFIRMED).toBe("Not sure it was sent");
    const base = { state: "SCHEDULED" as const, included: true, currentStep: 0, nextDueAt: null, stopReason: null, campaignStatus: "RUNNING" as const };
    expect(recipientStateText({ ...base, email: { status: "UNKNOWN", dueAt: NOW } }, TZ, NOW)).toBe("Checking whether the first email was sent");
    expect(recipientStateText({ ...base, email: { status: "UNCONFIRMED", dueAt: NOW } }, TZ, NOW)).toBe("Not sure the first email was sent");
  });

  const input = (email: Partial<PanelEmail>, over: Partial<StepViewInput> = {}): StepViewInput => ({
    campaignStatus: "RUNNING",
    recipient: { state: "SCHEDULED", included: true, stopReason: null },
    steps: [{ step: 0, enabled: true, delayDays: 0 }],
    emails: [{ id: 1, step: 0, status: "QUEUED", dueAt: NOW, sentAt: null, lastError: null, ...email }],
    ...over,
  });

  it("offers no button while the app is still checking with Mailgun", () => {
    const [v] = recipientStepViews(input({ status: "UNKNOWN" }), TZ, NOW);
    expect(v).toMatchObject({ kind: "problem", canRetry: false, canEdit: false, note: "Checking with Mailgun whether it was sent…", detail: null });
  });

  it("offers Retry for 'Not sure it was sent', unless Mailgun already has the email", () => {
    const [unsure] = recipientStepViews(input({ status: "UNCONFIRMED", lastError: "We couldn't confirm with Mailgun whether this email was sent" }), TZ, NOW);
    expect(unsure).toMatchObject({
      kind: "problem",
      canRetry: true,
      note: "Not sure it was sent: we couldn't confirm with Mailgun whether this email was sent",
    });
    const [has] = recipientStepViews(input({ status: "UNCONFIRMED", providerId: "pp.x@send.example.com" }), TZ, NOW);
    expect(has.canRetry).toBe(false);
    const [failedHas] = recipientStepViews(input({ status: "FAILED", providerId: "pp.x@send.example.com" }), TZ, NOW);
    expect(failedHas.canRetry).toBe(false);
  });

  it("shows Mailgun's refusal as it is, with Mailgun's own words behind Details", () => {
    const [v] = recipientStepViews(
      input({ status: "FAILED", lastError: "Mailgun refused this address", failureDetail: "  'to' parameter is not a valid address  " }),
      TZ,
      NOW,
    );
    expect(v).toMatchObject({ kind: "problem", canRetry: true, note: "Mailgun refused this address", detail: "'to' parameter is not a valid address" });
    const [plain] = recipientStepViews(input({ status: "FAILED", lastError: "The address bounced" }), TZ, NOW);
    expect(plain).toMatchObject({ note: "Didn't send: the address bounced", detail: null });
  });
});

describe("resultsNote", () => {
  it("explains dry-run and test-mode results; live needs no note", () => {
    expect(resultsNote("DRY_RUN")).toBe("Dry run: delivery results appear only when you simulate them in the dry-run outbox.");
    expect(resultsNote("TEST")).toBe("Test mode: Mailgun reports every email as delivered without delivering it.");
    expect(resultsNote("LIVE")).toBeNull();
  });
});
