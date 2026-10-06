import { describe, expect, it } from "vitest";
import { pausedWithReason, sendingLabel } from "@/core/sending/label";
import type { PauseState } from "@/core/system-state";

const NOT_PAUSED: PauseState = {
  paused: false,
  reason: "",
  kind: null,
  fixText: "",
  since: null,
  byUserId: null,
  detail: null,
  also: [],
};

const HEALTH_PAUSE: PauseState = {
  ...NOT_PAUSED,
  paused: true,
  kind: "health-bounce",
  reason: "7 of the last 200 emails bounced",
  fixText: "Your limit is 6. Open the bounced list in Settings › Deliverability, then click Resume.",
  since: "2026-09-23T09:00:00Z",
};

const none = { live: 0, test: 0 };

describe("sendingLabel", () => {
  it("shows a pause first, whatever else is going on", () => {
    expect(sendingLabel({ pause: HEALTH_PAUSE, mode: "LIVE", goLive: true, activeRealCampaigns: { live: 3, test: 1 } })).toEqual({
      kind: "paused",
      text: "Paused: 7 of the last 200 emails bounced",
      title: "Sending is paused. Your limit is 6. Open the bounced list in Settings › Deliverability, then click Resume.",
      tone: "danger",
    });
    const bare = { ...NOT_PAUSED, paused: true, kind: "manual" as const };
    expect(sendingLabel({ pause: bare, mode: "DRY_RUN", goLive: false, activeRealCampaigns: none })).toMatchObject({
      text: "Paused by the Owner",
      title: "Sending is paused.",
    });
  });

  it("names who paused by hand without a colon ('Paused by Demo Owner')", () => {
    const manual: PauseState = {
      ...NOT_PAUSED,
      paused: true,
      kind: "manual",
      reason: "by Demo Owner",
      fixText: "Click Resume sending in Settings › Sending & Mailgun when you're ready.",
    };
    expect(sendingLabel({ pause: manual, mode: "LIVE", goLive: false, activeRealCampaigns: none }).text).toBe("Paused by Demo Owner");
    // A reason typed in "Why" keeps the colon.
    expect(sendingLabel({ pause: { ...manual, reason: "Checking the new list" }, mode: "LIVE", goLive: false, activeRealCampaigns: none }).text).toBe(
      "Paused: Checking the new list",
    );
    expect(pausedWithReason("Sending is paused", "by Demo Owner")).toBe("Sending is paused by Demo Owner");
    expect(pausedWithReason("Sending is paused", "7 of the last 200 emails bounced.")).toBe("Sending is paused: 7 of the last 200 emails bounced");
    expect(pausedWithReason("Paused", "  ")).toBe("Paused by the Owner");
  });

  it("says 'Sending live' after go-live with live mode", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "LIVE", goLive: true, activeRealCampaigns: none })).toEqual({
      kind: "live",
      text: "Sending live",
      title: "Campaigns send real email.",
      tone: "success",
    });
  });

  it("keeps 'Sending live' after go-live while a live campaign still sends, even in dry run or test mode", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: true, activeRealCampaigns: { live: 1, test: 0 } })).toEqual({
      kind: "live",
      text: "Sending live",
      title: "New campaigns use dry run; 1 live campaign still sends real email. Pause it, or use Pause all sending.",
      tone: "success",
    });
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: { live: 2, test: 1 } }).title).toBe(
      "New campaigns use test mode; 2 live campaigns still send real email. Pause them, or use Pause all sending.",
    );
  });

  it("says 'Test list only' for Live before go-live", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "LIVE", goLive: false, activeRealCampaigns: { live: 2, test: 0 } })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "Real emails go only to the addresses on your test list, and to your own reply inbox when you click Send me a test.",
      tone: "neutral",
    });
  });

  it("own-mailbox mode names the inbox for test emails, not a reply inbox (review SCREENS-11)", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "LIVE", goLive: false, activeRealCampaigns: none, ownMailbox: true })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "Real emails go only to the addresses on your test list, and to your inbox for test emails when you click Send me a test.",
      tone: "neutral",
    });
    // Absent or false: app mode's words, unchanged.
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "LIVE", goLive: false, activeRealCampaigns: none, ownMailbox: false }).title).toContain(
      "your own reply inbox",
    );
  });

  it("says 'Test list only' for Mailgun's test mode, before and after go-live", () => {
    const expected = {
      kind: "test-list",
      text: "Test list only",
      title: "New campaigns use Mailgun's test mode: emails to your test list are accepted but never delivered.",
      tone: "neutral",
    };
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: false, activeRealCampaigns: none })).toEqual(expected);
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: { live: 0, test: 2 } })).toEqual(expected);
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: false, activeRealCampaigns: { live: 1, test: 0 } }).text).toBe(
      "Test list only",
    );
  });

  it("in test mode, never says 'never delivered' while a live campaign still delivers to the test list", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: false, activeRealCampaigns: { live: 1, test: 2 } })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "New campaigns use Mailgun's test mode; 1 live campaign still sends real email to your test list. Pause it, or use Pause all sending.",
      tone: "neutral",
    });
    const two = sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: false, activeRealCampaigns: { live: 2, test: 0 } }).title;
    expect(two).toBe("New campaigns use Mailgun's test mode; 2 live campaigns still send real email to your test list. Pause them, or use Pause all sending.");
    expect(two).not.toContain("never delivered");
  });

  it("never says 'Dry run' while campaigns still send through Mailgun", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: false, activeRealCampaigns: { live: 1, test: 0 } })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "New campaigns use dry run; 1 campaign still sends through Mailgun. Pause it, or use Pause all sending.",
      tone: "neutral",
    });
    expect(
      sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: false, activeRealCampaigns: { live: 1, test: 2 } }).title,
    ).toBe("New campaigns use dry run; 3 campaigns still send through Mailgun. Pause them, or use Pause all sending.");
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: true, activeRealCampaigns: { live: 0, test: 1 } }).text).toBe(
      "Test list only",
    );
  });

  it("after go-live, every mode with and without live and test campaigns keeps A6's rules (M6-DESIGN G6)", () => {
    const cases: Array<[mode: "DRY_RUN" | "TEST" | "LIVE", live: number, test: number, text: string]> = [
      ["LIVE", 0, 0, "Sending live"],
      ["LIVE", 2, 1, "Sending live"],
      ["LIVE", 0, 3, "Sending live"],
      ["TEST", 0, 0, "Test list only"],
      ["TEST", 0, 2, "Test list only"],
      ["TEST", 1, 0, "Sending live"],
      ["DRY_RUN", 0, 0, "Dry run"],
      ["DRY_RUN", 0, 1, "Test list only"],
      ["DRY_RUN", 1, 0, "Sending live"],
      ["DRY_RUN", 3, 2, "Sending live"],
    ];
    for (const [mode, live, test, text] of cases) {
      const label = sendingLabel({ pause: NOT_PAUSED, mode, goLive: true, activeRealCampaigns: { live, test } });
      expect([mode, live, test, label.text]).toEqual([mode, live, test, text]);
      expect(label.tone).toBe(text === "Sending live" ? "success" : "neutral");
    }
    // Test mode with no live campaign stays "Test list only" after go-live, and says so truthfully (G3).
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: none }).title).toBe(
      "New campaigns use Mailgun's test mode: emails to your test list are accepted but never delivered.",
    );
    // A pause still wins after go-live.
    expect(sendingLabel({ pause: HEALTH_PAUSE, mode: "TEST", goLive: true, activeRealCampaigns: none }).kind).toBe("paused");
  });

  it("after go-live, a live campaign launched before go-live (test list only for good) never makes it 'Sending live' (review GOLIVE-03)", () => {
    const beforeOnly = { live: 1, test: 0, liveAfterGoLive: 0 };
    // Test mode: "Test list only", and the tooltip still says the live campaign delivers real email to the test list.
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: beforeOnly })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "New campaigns use Mailgun's test mode; 1 live campaign still sends real email to your test list. Pause it, or use Pause all sending.",
      tone: "neutral",
    });
    // Dry run: "Test list only", still sending through Mailgun.
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: true, activeRealCampaigns: { live: 2, test: 1, liveAfterGoLive: 0 } })).toEqual({
      kind: "test-list",
      text: "Test list only",
      title: "New campaigns use dry run; 3 campaigns still send through Mailgun. Pause them, or use Pause all sending.",
      tone: "neutral",
    });
    // Live mode is "Sending live" whatever the campaigns.
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "LIVE", goLive: true, activeRealCampaigns: beforeOnly }).text).toBe("Sending live");
  });

  it("after go-live, counts only the live campaigns launched after go-live as real email, and names the rest", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: { live: 2, test: 0, liveAfterGoLive: 1 } })).toEqual({
      kind: "live",
      text: "Sending live",
      title: "New campaigns use test mode; 1 live campaign still sends real email (and 1 more to your test list only). Pause them, or use Pause all sending.",
      tone: "success",
    });
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: true, activeRealCampaigns: { live: 3, test: 0, liveAfterGoLive: 3 } }).title).toBe(
      "New campaigns use dry run; 3 live campaigns still send real email. Pause them, or use Pause all sending.",
    );
    // Before go-live the launch flag changes nothing (every live campaign then is test list only).
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: false, activeRealCampaigns: { live: 1, test: 0, liveAfterGoLive: 0 } }).text).toBe("Test list only");
    // Without the split, every live campaign counts as launched after go-live (never says less).
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "TEST", goLive: true, activeRealCampaigns: { live: 1, test: 0 } }).text).toBe("Sending live");
  });

  it("after go-live, every mode × pre- and post-go-live live campaigns", () => {
    const cases: Array<[mode: "DRY_RUN" | "TEST" | "LIVE", live: number, after: number, text: string]> = [
      ["LIVE", 1, 0, "Sending live"],
      ["LIVE", 1, 1, "Sending live"],
      ["TEST", 1, 0, "Test list only"],
      ["TEST", 1, 1, "Sending live"],
      ["DRY_RUN", 1, 0, "Test list only"],
      ["DRY_RUN", 2, 1, "Sending live"],
    ];
    for (const [mode, live, after, text] of cases) {
      const label = sendingLabel({ pause: NOT_PAUSED, mode, goLive: true, activeRealCampaigns: { live, test: 0, liveAfterGoLive: after } });
      expect([mode, live, after, label.text]).toEqual([mode, live, after, text]);
    }
  });

  it("says 'Dry run' when nothing goes through Mailgun", () => {
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: false, activeRealCampaigns: none })).toEqual({
      kind: "dry-run",
      text: "Dry run",
      title: "Nothing is sent: campaigns only fill the dry-run outbox.",
      tone: "neutral",
    });
    expect(sendingLabel({ pause: NOT_PAUSED, mode: "DRY_RUN", goLive: true, activeRealCampaigns: none }).text).toBe("Dry run");
  });
});
