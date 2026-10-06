import { describe, expect, it } from "vitest";
import { secondsAgoText, workerDownText, workerStatusText } from "@/components/settings/worker-status-text";

const now = new Date("2026-09-23T12:00:00Z"); // 17:00 in Pakistan

describe("background sender status text", () => {
  it("says it's running and when it last checked in", () => {
    const s = workerStatusText({ running: true, lastSeen: new Date(now.getTime() - 10_000) }, now, "Asia/Karachi");
    expect(s).toEqual({ running: true, text: "Running, last check 10 seconds ago", hint: null });
    expect(workerStatusText({ running: true, lastSeen: now }, now, "UTC").text).toBe("Running, last check just now");
  });

  it("says since when it stopped, in the viewer's time zone", () => {
    const s = workerStatusText({ running: false, lastSeen: new Date("2026-09-23T09:02:00Z") }, now, "Asia/Karachi");
    expect(s.running).toBe(false);
    expect(s.text).toBe("Not running since 14:02 — double-click start.bat");
    expect(s.hint).toMatch(/start\.bat/);
  });

  it("adds the date when it stopped on another day", () => {
    const s = workerStatusText({ running: false, lastSeen: new Date("2026-09-20T09:02:00Z") }, now, "Asia/Karachi");
    expect(s.text).toBe("Not running since 20 Sept 2026, 14:02 — double-click start.bat");
  });

  it("handles a PC where it never ran", () => {
    expect(workerStatusText({ running: false, lastSeen: null }, now, "UTC").text).toBe(
      "Not running yet — double-click start.bat",
    );
  });

  it("counts seconds, then minutes", () => {
    expect(secondsAgoText(new Date(now.getTime() - 2_000), now)).toBe("just now");
    expect(secondsAgoText(new Date(now.getTime() - 42_000), now)).toBe("42 seconds ago");
    expect(secondsAgoText(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 minutes ago");
  });
});

/** The dashboard's "background sender" item (M6-DESIGN §4.2 item 2, PLAN A6 wording). */
describe("workerDownText", () => {
  it("is null while the background sender runs", () => {
    expect(workerDownText({ running: true, lastSeen: new Date(now.getTime() - 10_000) }, now, "Asia/Karachi")).toBeNull();
  });

  it("gives the time only when it stopped today, in the viewer's zone", () => {
    expect(workerDownText({ running: false, lastSeen: new Date("2026-09-23T09:02:00Z") }, now, "Asia/Karachi")).toBe(
      "The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click start.bat.",
    );
    // The same moment is 11:02 in Berlin.
    expect(workerDownText({ running: false, lastSeen: new Date("2026-09-23T09:02:00Z") }, now, "Europe/Berlin")).toContain("since 11:02,");
  });

  it("puts the short date in front when it stopped on another day", () => {
    expect(workerDownText({ running: false, lastSeen: new Date("2026-09-20T09:02:00Z") }, now, "Asia/Karachi")).toBe(
      "The background sender hasn't checked in since 20 Sept, 14:02, so no emails are going out. Restart the PC or double-click start.bat.",
    );
    // "Today" is the viewer's day: 23:30 UTC on the 22nd is already the 23rd in Pakistan.
    expect(workerDownText({ running: false, lastSeen: new Date("2026-09-22T23:30:00Z") }, now, "Asia/Karachi")).toContain("since 04:30,");
    expect(workerDownText({ running: false, lastSeen: new Date("2026-09-22T23:30:00Z") }, now, "UTC")).toContain("since 22 Sept, 23:30,");
    // Another year adds the year.
    expect(workerDownText({ running: false, lastSeen: new Date("2025-12-30T09:02:00Z") }, now, "UTC")).toContain("since 30 Dec 2025, 09:02,");
  });

  it("says it isn't running when it was never seen", () => {
    expect(workerDownText({ running: false, lastSeen: null }, now, "UTC")).toBe(
      "The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.",
    );
  });
});
