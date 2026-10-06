import { describe, expect, it } from "vitest";
import { catchUpFailing, catchUpStatusLine, oldDomainLines } from "@/core/mailgun/catch-up-status";
import { parseCatchUpState } from "@/core/system-state-parse";
import type { CatchUpState, CatchUpSummary } from "@/core/system-state";

/**
 * M6 step C move (M6-DESIGN §7.9): the "Check with Mailgun" line and failing rule moved from Settings › Sending &
 * Mailgun's loader into @/core/mailgun/catch-up-status, behaviour unchanged, plus the new old-domain lines (L10).
 */

const zone = "Asia/Karachi"; // UTC+5
const now = new Date("2026-09-27T12:00:00.000Z"); // 17:00 in Karachi

const state = (over: Partial<CatchUpState> = {}): CatchUpState => ({ ...parseCatchUpState(null), ...over });
const summary = (over: Partial<CatchUpSummary> = {}): CatchUpSummary => ({
  domains: ["send.example.com"],
  eventsApplied: 3,
  suppressionsAdded: 0,
  suppressionsPushed: 0,
  inboundStored: 0,
  duplicatesFound: 0,
  ...over,
});

describe("catchUpFailing", () => {
  it("is false without an error", () => {
    expect(catchUpFailing(state())).toBe(false);
    expect(catchUpFailing(state({ lastSuccessAt: "2026-09-27T11:00:00.000Z" }))).toBe(false);
  });

  it("is true with an error and no success ever", () => {
    expect(catchUpFailing(state({ lastError: "Mailgun didn't answer." }))).toBe(true);
  });

  it("is true only when the last finished run is newer than the last success", () => {
    const base = { lastError: "Mailgun didn't answer.", lastSuccessAt: "2026-09-27T10:00:00.000Z" };
    expect(catchUpFailing(state({ ...base, lastFinishedAt: "2026-09-27T11:00:00.000Z" }))).toBe(true);
    expect(catchUpFailing(state({ ...base, lastFinishedAt: "2026-09-27T10:00:00.000Z" }))).toBe(false);
    expect(catchUpFailing(state({ ...base, lastFinishedAt: "2026-09-27T09:00:00.000Z" }))).toBe(false);
    expect(catchUpFailing(state({ ...base, lastFinishedAt: null }))).toBe(false);
  });
});

describe("catchUpStatusLine", () => {
  it("says it hasn't checked yet since the app started", () => {
    expect(catchUpStatusLine(state(), zone, now)).toEqual({
      line: "Not checked with Mailgun yet since the app started.",
      failing: false,
      detail: null,
    });
  });

  it("says when it last checked today (time only) and what it found", () => {
    const r = catchUpStatusLine(
      state({ lastSuccessAt: "2026-09-27T11:55:00.000Z", lastSummary: summary({ suppressionsAdded: 2, inboundStored: 1 }) }),
      zone,
      now,
    );
    expect(r).toEqual({
      line: "Last checked with Mailgun at 16:55: 3 updates, 2 new on the do-not-email list, 1 reply stored.",
      failing: false,
      detail: null,
    });
  });

  it("uses singular and plural words and leaves out zero parts", () => {
    const one = catchUpStatusLine(state({ lastSuccessAt: "2026-09-27T11:55:00.000Z", lastSummary: summary({ eventsApplied: 1, inboundStored: 2 }) }), zone, now);
    expect(one.line).toBe("Last checked with Mailgun at 16:55: 1 update, 2 replies stored.");
    const none = catchUpStatusLine(state({ lastSuccessAt: "2026-09-27T11:55:00.000Z" }), zone, now);
    expect(none.line).toBe("Last checked with Mailgun at 16:55.");
  });

  it("adds the date when the last check wasn't today", () => {
    const r = catchUpStatusLine(state({ lastSuccessAt: "2026-09-25T09:05:00.000Z" }), zone, now);
    expect(r.line).toBe(`Last checked with Mailgun at 25 ${shortMonth(9)} 14:05.`);
  });

  it("says since when it couldn't check while failing, with Mailgun's error for Details", () => {
    const r = catchUpStatusLine(
      state({
        lastError: "Mailgun didn't answer.",
        lastSuccessAt: "2026-09-27T09:30:00.000Z",
        lastFinishedAt: "2026-09-27T11:30:00.000Z",
      }),
      zone,
      now,
    );
    expect(r).toEqual({
      line: "The app hasn't been able to check Mailgun since 14:30. Bounces and unsubscribes may be late.",
      failing: true,
      detail: "Mailgun didn't answer.",
    });
    expect(catchUpStatusLine(state({ lastError: "Mailgun didn't answer." }), zone, now).line).toBe(
      "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late.",
    );
  });
});

describe("oldDomainLines (M6 L10)", () => {
  it("is empty without old-domain problems", () => {
    expect(oldDomainLines(state(), zone, now)).toEqual([]);
    expect(oldDomainLines(state({ oldDomains: [] }), zone, now)).toEqual([]);
  });

  it("writes one line per old domain, dated in the viewer's zone", () => {
    const parsed = parseCatchUpState({
      oldDomains: [
        { domain: "mail.example.com", since: "2026-09-24T20:00:00.000Z", lastAt: "2026-09-27T11:00:00.000Z", text: "Forbidden" },
        { domain: "old.example.com", since: "2025-12-01T10:00:00.000Z", lastAt: "2026-09-27T11:00:00.000Z", text: "" },
      ],
    });
    expect(oldDomainLines(parsed, zone, now)).toEqual([
      `Mailgun's logs for the old domain mail.example.com haven't been checked since 25 ${shortMonth(9)}. Replies and bounces to its last emails may be missed.`,
      `Mailgun's logs for the old domain old.example.com haven't been checked since 1 ${shortMonth(12)} 2025. Replies and bounces to its last emails may be missed.`,
    ]);
  });
});

/** The short month name this Node's ICU writes for en-GB ("Sep" or "Sept"), so the test holds on either version. */
function shortMonth(month: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 15)));
}
