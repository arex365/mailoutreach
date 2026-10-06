import { describe, expect, it } from "vitest";
import { restoreReportLines, shortDateTime } from "@/core/sending/restore-report";
import { parseRestoreState } from "@/core/system-state-parse";
import type { RestoreReport, RestoreState } from "@/core/system-state";

/**
 * M6 step C move (M6-DESIGN §7.9): the restore report's lines moved from Settings › Sending & Mailgun's loader into
 * @/core/sending/restore-report, behaviour unchanged.
 */

const zone = "Asia/Karachi";
const now = new Date("2026-09-27T12:00:00.000Z");

const report = (over: Partial<RestoreReport> = {}): RestoreReport => ({
  finishedAt: "2026-09-27T10:00:00.000Z",
  mailgunChecked: true,
  passes: 2,
  windowFrom: "2026-09-26T08:00:00.000Z",
  windowTo: "2026-09-27T09:30:00.000Z",
  olderThanRetention: false,
  acceptedEvents: 12,
  matchedByMessageId: 3,
  matchedBySendId: 2,
  matchedByRecipient: 1,
  rowsCreated: 1,
  externalSends: 1,
  madeUnconfirmed: 4,
  error: null,
  ...over,
});

const state = (over: Partial<RestoreState> = {}): RestoreState => ({ ...parseRestoreState(null), ...over });

describe("shortDateTime", () => {
  it("writes a short date and a 24-hour time in the zone, with the year only when it isn't this year", () => {
    expect(shortDateTime("2026-09-26T08:00:00.000Z", zone, now)).toBe(`26 ${shortMonth(9)} 13:00`);
    expect(shortDateTime(new Date("2025-06-10T07:00:00.000Z"), zone, now)).toBe(`10 ${shortMonth(6)} 2025 12:00`);
    expect(shortDateTime(null, zone, now)).toBe("");
    expect(shortDateTime(undefined, zone, now)).toBe("");
  });
});

describe("restoreReportLines", () => {
  it("says nothing without a restore", () => {
    expect(restoreReportLines(state(), zone, now)).toEqual({ text: null, risk: false, running: false, details: [] });
  });

  it("says the check is running while it is pending or scanning", () => {
    for (const status of ["pending", "scanning"] as const) {
      expect(restoreReportLines(state({ status }), zone, now)).toEqual({
        text: "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore.",
        risk: false,
        running: true,
        details: [],
      });
    }
  });

  it("flags a failed check, with why behind Details", () => {
    expect(restoreReportLines(state({ status: "failed", report: report({ error: "Mailgun refused the key." }) }), zone, now)).toEqual({
      text: "The app couldn't check Mailgun for emails sent after the backup.",
      risk: true,
      running: false,
      details: ["Why: Mailgun refused the key."],
    });
    expect(restoreReportLines(state({ status: "failed" }), zone, now).details).toEqual([]);
  });

  it("flags a finished check that couldn't reach Mailgun", () => {
    // Without Mailgun nothing was walked: no window.
    const r = restoreReportLines(state({ status: "done", report: report({ mailgunChecked: false, windowFrom: null, windowTo: null }) }), zone, now);
    expect(r.risk).toBe(true);
    expect(r.text).toBe("The app couldn't check Mailgun for emails sent after the backup.");
  });

  it("flags a finished check that walked Mailgun but not every sending domain (review BACKUPS-7), saying what it found", () => {
    const why = "The app couldn't read which Mailgun domains were in use just before the restore, so emails sent through another sending domain may not have been found.";
    const r = restoreReportLines(state({ status: "done", report: report({ mailgunChecked: false, error: why }) }), zone, now);
    expect(r).toEqual({
      text: `Checked Mailgun for sends after the backup (26 ${shortMonth(9)} 13:00 → 27 ${shortMonth(9)} 14:30), but not through every sending domain: 6 confirmed as sent, 2 found that the backup didn't know about, 4 marked 'Not sure it was sent'.`,
      risk: true,
      running: false,
      details: [`Why: ${why}`],
    });
  });

  it("sums what the finished check found, with the window in the viewer's zone", () => {
    const r = restoreReportLines(state({ status: "done", report: report() }), zone, now);
    expect(r).toEqual({
      text: `Checked Mailgun for sends after the backup (26 ${shortMonth(9)} 13:00 → 27 ${shortMonth(9)} 14:30): 6 confirmed as sent, 2 found that the backup didn't know about, 4 marked 'Not sure it was sent'.`,
      risk: false,
      running: false,
      details: [],
    });
  });

  it("names the backup and now when the window is unknown, and warns about an old backup", () => {
    const r = restoreReportLines(
      state({ status: "done", report: report({ windowFrom: null, windowTo: null, olderThanRetention: true }) }),
      zone,
      now,
    );
    expect(r.text).toContain("(the backup → now)");
    expect(r.details).toEqual(["The backup is older than Mailgun keeps its logs, so some sends couldn't be checked."]);
  });

  it("says nothing for a done state without a report", () => {
    expect(restoreReportLines(state({ status: "done" }), zone, now).text).toBeNull();
  });
});

describe("the sending domains from before the restore in the restore state (review BACKUPS-7)", () => {
  it("parse leniently: absent stays absent, a list is cleaned, anything else is 'couldn't be read'", () => {
    expect("domainsBefore" in parseRestoreState({ status: "pending" })).toBe(false);
    expect(parseRestoreState({ status: "pending", domainsBefore: null }).domainsBefore).toBeNull();
    expect(parseRestoreState({ status: "pending", domainsBefore: "mg.example.com" }).domainsBefore).toBeNull();
    expect(
      parseRestoreState({
        status: "pending",
        domainsBefore: [
          { name: " MG.Studio.example ", region: "US" },
          { name: "mg.studio.example", region: "EU" },
          { name: "send.other.example" },
          { name: "" },
          { name: "not a domain!" },
          "junk",
        ],
      }).domainsBefore,
    ).toEqual([
      { name: "mg.studio.example", region: "US" },
      { name: "send.other.example", region: "EU" },
    ]);
  });
});

/** The short month name this Node's ICU writes for en-GB ("Sep" or "Sept"), so the test holds on either version. */
function shortMonth(month: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 15)));
}
