import { describe, expect, it } from "vitest";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { recipientStepViews, type PanelEmail, type StepViewInput } from "@/components/campaigns/format";

/**
 * The campaign person panel's lines for own-mailbox mode's sender-check outcomes (MAIN-DOMAIN-DESIGN O35): the first
 * block puts the email back in the queue with `senderBlocked`; the second fails it for good with `senderBlockedTwice`,
 * which already starts with "Didn't send", so the line shows it as it is (never "Didn't send: didn't send: …").
 */

const TZ = "Europe/Berlin";
const NOW = new Date("2026-09-28T10:00:00Z");

const input = (email: Partial<PanelEmail>): StepViewInput => ({
  campaignStatus: "RUNNING",
  recipient: { state: "SCHEDULED", included: true, stopReason: null },
  steps: [{ step: 0, enabled: true, delayDays: 0 }],
  emails: [{ id: 1, step: 0, status: "QUEUED", dueAt: NOW, sentAt: null, lastError: null, ...email }],
});

describe("own-mailbox sender-check lines on the person panel", () => {
  it("a row blocked twice reads once: Didn't send: this email doesn't fit …", () => {
    const [v] = recipientStepViews(input({ status: "FAILED", lastError: OWN_MAILBOX_TEXTS.senderBlockedTwice }), TZ, NOW);
    expect(v!.note).toBe(OWN_MAILBOX_TEXTS.senderBlockedTwice);
    expect(v!.note).not.toMatch(/didn't send:.*didn't send/i);
  });

  it("a row blocked once waits for the next try with the reason", () => {
    const [v] = recipientStepViews(input({ status: "QUEUED", lastError: OWN_MAILBOX_TEXTS.senderBlocked }), TZ, NOW);
    expect(v!.note).toBe(
      "Waiting to send. The last try didn't work (this email didn't fit your From address, so sending paused once); it will be tried again",
    );
  });

  it("other reasons keep today's label (unchanged)", () => {
    const [v] = recipientStepViews(input({ status: "FAILED", lastError: "The address bounced" }), TZ, NOW);
    expect(v!.note).toBe("Didn't send: the address bounced");
    const [m] = recipientStepViews(input({ status: "FAILED", lastError: "Mailgun refused this address" }), TZ, NOW);
    expect(m!.note).toBe("Mailgun refused this address");
  });
});
