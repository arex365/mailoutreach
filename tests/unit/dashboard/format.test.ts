import { describe, expect, it } from "vitest";
import {
  activityGroupText,
  campaignMetaLine,
  campaignsMoreHref,
  countingSinceWords,
  healthTileView,
  repliesFooterLabel,
  sinceText,
  statusHref,
  todayView,
  warmupTodayFrom,
  type TodayCapFacts,
} from "@/components/dashboard/format";
import { noticeText } from "@/components/shell/notice-toast";

/** The dashboard tiles' words (M6-DESIGN §4.3), built from the loaders' plain numbers. */

const WARMUP = "Warm-up step 9 of 20: 177 a day. It goes up to 207 after a weekday with at least half the limit used and healthy numbers.";
const cap = (over: Partial<TodayCapFacts> = {}): TodayCapFacts => ({
  used: 37,
  cap: 50,
  left: 13,
  testSends: 0,
  override: null,
  aboveSchedule: false,
  ...over,
});

describe("todayView", () => {
  it("after go-live: the number, the bar and the warm-up line", () => {
    expect(todayView({ cap: cap(), warmupLine: WARMUP, practiceCopy: false, live: true, configured: true })).toEqual({
      used: 37,
      cap: 50,
      percent: 74,
      lines: [WARMUP],
      notConfigured: null,
    });
  });

  it("lists test sends, a hand-set limit and a reached limit before the warm-up line, in that order", () => {
    const v = todayView({
      cap: cap({ used: 400, cap: 400, left: 0, testSends: 2, override: { capDay: "2026-09-23", cap: 400 }, aboveSchedule: true }),
      warmupLine: WARMUP,
      practiceCopy: false,
      live: true,
      configured: true,
    });
    expect(v.lines).toEqual([
      "Includes 2 test emails.",
      "Today's limit was changed by hand. It's above the warm-up schedule.",
      "Today's limit is reached; the rest go out tomorrow.",
      WARMUP,
    ]);
    expect(v.percent).toBe(100);
    const one = todayView({ cap: cap({ testSends: 1, override: { capDay: "x", cap: 20 } }), warmupLine: null, practiceCopy: false, live: true, configured: true });
    expect(one.lines).toEqual(["Includes 1 test email.", "Today's limit was changed by hand."]);
  });

  it("calls test sends test emails, never only 'Send me a test' (the reply test's count too; review DASHBOARD-9)", () => {
    const v = todayView({ cap: cap({ testSends: 3 }), warmupLine: null, practiceCopy: false, live: true, configured: true });
    expect(v.lines).toEqual(["Includes 3 test emails."]);
    expect(v.lines.join(" ")).not.toContain("Send me a test");
  });

  it("before go-live with Mailgun set up: the ramp starts at go-live", () => {
    expect(todayView({ cap: cap({ used: 2 }), warmupLine: WARMUP, practiceCopy: false, live: false, configured: true }).lines).toEqual([
      "Warm-up starts when you go live.",
      "Until then, real email only reaches your test list.",
    ]);
  });

  it("real data without Mailgun: nothing goes through Mailgun yet, no warm-up line", () => {
    const v = todayView({ cap: cap({ used: 0, left: 50 }), warmupLine: WARMUP, practiceCopy: false, live: false, configured: false });
    expect(v.lines).toEqual([]);
    expect(v.notConfigured).toBe("Nothing goes through Mailgun yet: new campaigns run as dry runs.");
    expect(v.percent).toBe(0);
  });

  it("the practice copy: the warm-up line (its ramp runs like live), never the Mailgun sentence", () => {
    const v = todayView({ cap: cap({ used: 9 }), warmupLine: WARMUP, practiceCopy: true, live: false, configured: false });
    expect(v.lines).toEqual([WARMUP]);
    expect(v.notConfigured).toBeNull();
  });

  it("keeps the bar between 0 and 100", () => {
    expect(todayView({ cap: cap({ used: 5, cap: 0, left: 0 }), warmupLine: null, practiceCopy: false, live: true, configured: true }).percent).toBe(100);
    expect(todayView({ cap: cap({ used: 0, cap: 0, left: 0 }), warmupLine: null, practiceCopy: false, live: true, configured: true }).percent).toBe(0);
    expect(todayView({ cap: cap({ used: 1, cap: 3 }), warmupLine: null, practiceCopy: false, live: true, configured: true }).percent).toBe(33);
  });
});

describe("warmupTodayFrom", () => {
  const thresholds = { bounceWindow: 200, complaintWindow: 1000, healthyBouncePercent: 2, healthyComplaintPercent: 0.05 };
  const window = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

  it("builds the facts warmupLine needs: sending day, use against the step's limit, healthy numbers", () => {
    // 23 Sep 2026 is a Wednesday.
    expect(
      warmupTodayFrom({ used: 30, warmupCap: 50, capDay: "2026-09-23", window, minUsePercent: 50, counts: { bounces: 1, complaints: 0 }, thresholds }),
    ).toEqual({ sendingDay: true, used: 30, cap: 50, minUsePercent: 50, healthy: true, weekdaysOnly: true });
    // A Saturday isn't a sending day; too many bounces aren't healthy.
    const saturday = warmupTodayFrom({ used: 30, warmupCap: 50, capDay: "2026-09-26", window, minUsePercent: 50, counts: { bounces: 9, complaints: 0 }, thresholds });
    expect(saturday).toMatchObject({ sendingDay: false, healthy: false });
    // An unreadable window falls back to the default (weekdays).
    expect(warmupTodayFrom({ used: 0, warmupCap: 50, capDay: "2026-09-23", window: "nonsense", minUsePercent: 50, counts: { bounces: 0, complaints: 0 }, thresholds }).sendingDay).toBe(true);
  });

  it("says whether the sending days are Monday to Friday, for the warm-up line's words (review SCREENS-10)", () => {
    const six = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" };
    const today = warmupTodayFrom({ used: 30, warmupCap: 50, capDay: "2026-09-26", window: six, minUsePercent: 80, counts: { bounces: 0, complaints: 0 }, thresholds });
    expect(today).toMatchObject({ sendingDay: true, weekdaysOnly: false, minUsePercent: 80 });
  });
});

const health = {
  practiceCopy: false,
  counts: { bounces: 2, bounceSample: 180, complaints: 0, complaintSample: 180, bounceEmailIds: [11, 12], complaintEmailIds: [] },
  bounceLine: "2 of the last 180 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
  complaintLine: "0 of the last 180 emails marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.1%.",
  bounceLimit: 6,
  complaintLimit: 1,
  bounceNote: "Only 180 live emails since 24 Sept; the limit is counted per 200.",
  complaintNote: null,
  sinceNote: "Counting since you went live on 24 Sept.",
};

describe("healthTileView", () => {
  it("passes the numbers and strings, never the ids of the emails behind them", () => {
    const v = healthTileView(health);
    expect(v).toEqual({
      empty: null,
      bounce: { label: "Bounces toward the automatic pause", line: health.bounceLine, count: 2, limit: 6, note: health.bounceNote },
      complaint: { label: "Spam complaints toward the automatic pause", line: health.complaintLine, count: 0, limit: 1, note: null },
      sinceNote: "Counting since you went live on 24 Sept.",
    });
    expect(JSON.stringify(v)).not.toContain("EmailIds");
    expect(v.bounce).not.toHaveProperty("href");
  });

  it("says there's nothing to measure before anything was sent", () => {
    const counts = { ...health.counts, bounceSample: 0, complaintSample: 0, bounces: 0 };
    expect(healthTileView({ ...health, counts, sinceNote: null }).empty).toBe("No emails sent through Mailgun yet, so there's nothing to measure.");
    expect(healthTileView({ ...health, counts, sinceNote: null, practiceCopy: true }).empty).toBe("No emails sent yet, so there's nothing to measure.");
  });

  it("after a resume or go-live, says nothing was sent since then, not 'nothing sent yet' (review DASHBOARD-6)", () => {
    const counts = { ...health.counts, bounceSample: 0, complaintSample: 0, bounces: 0 };
    expect(healthTileView({ ...health, counts, sinceNote: "Counting since you resumed on 27 Sept." }).empty).toBe(
      "Nothing sent since you resumed on 27 Sept, so there's nothing to measure yet.",
    );
    expect(healthTileView({ ...health, counts }).empty).toBe("Nothing sent since you went live on 24 Sept, so there's nothing to measure yet.");
    expect(healthTileView({ ...health, counts, practiceCopy: true, sinceNote: "Counting since you resumed on 27 Sept." }).empty).toBe(
      "Nothing sent since you resumed on 27 Sept, so there's nothing to measure yet.",
    );
    // A note worded some other way keeps the plain sentence.
    expect(healthTileView({ ...health, counts, sinceNote: "Something else." }).empty).toBe("No emails sent through Mailgun yet, so there's nothing to measure.");
  });

  it("countingSinceWords reads Domain health's own note", () => {
    expect(countingSinceWords("Counting since you resumed on 27 Sept.")).toBe("you resumed on 27 Sept");
    expect(countingSinceWords("Counting since you went live on 27 Sep.")).toBe("you went live on 27 Sep");
    expect(countingSinceWords(null)).toBeNull();
    expect(countingSinceWords("Counting since .")).toBeNull();
  });
});

describe("campaignsMoreHref (review DASHBOARD-7)", () => {
  it("leads to the tab the campaigns left out are on, else to the Campaigns page", () => {
    expect(campaignsMoreHref(3, 0)).toBe("/campaigns?tab=running");
    expect(campaignsMoreHref(0, 3)).toBe("/campaigns?tab=scheduled");
    expect(campaignsMoreHref(2, 3)).toBe("/campaigns");
    expect(campaignsMoreHref(0, 0)).toBe("/campaigns");
  });
});

describe("activityGroupText (review DASHBOARD-4)", () => {
  it("counts companies, or times when the rows aren't one company each; 'at least' when there may be more", () => {
    expect(activityGroupText({ count: 12, companies: true, atLeast: false })).toBe("12 companies");
    expect(activityGroupText({ count: 1_200, companies: true, atLeast: true })).toBe("at least 1,200 companies");
    expect(activityGroupText({ count: 3, companies: false, atLeast: false })).toBe("3 times");
    expect(activityGroupText({ count: 200, companies: false, atLeast: true })).toBe("at least 200 times");
  });
});

describe("small helpers", () => {
  it("statusHref builds the Contacts status link", () => {
    expect(statusHref("NOT_CONTACTED")).toBe("/contacts?status=NOT_CONTACTED");
    expect(statusHref("DO_NOT_CONTACT")).toBe("/contacts?status=DO_NOT_CONTACT");
  });

  it("campaignMetaLine: 'Ali · Live', or the mode alone", () => {
    expect(campaignMetaLine({ senderName: "Ali", modeLabel: "Live" })).toBe("Ali · Live");
    expect(campaignMetaLine({ senderName: null, modeLabel: "Dry run" })).toBe("Dry run");
  });

  it("repliesFooterLabel: '(3 more)' only when more wait than shown", () => {
    expect(repliesFooterLabel(8, 5)).toBe("All replies (3 more)");
    expect(repliesFooterLabel(1_205, 5)).toBe("All replies (1,200 more)");
    expect(repliesFooterLabel(5, 5)).toBe("All replies");
    expect(repliesFooterLabel(0, 0)).toBe("All replies");
  });

  it("sinceText: the time today, the short date and time another day (viewer's zone)", () => {
    const now = new Date("2026-09-23T10:00:00.000Z");
    expect(sinceText("2026-09-23T09:02:00.000Z", "Asia/Karachi", now)).toBe("14:02");
    expect(sinceText("2026-09-22T09:02:00.000Z", "Asia/Karachi", now)).toMatch(/^22 Sept?, 14:02$/);
    // 23:30 UTC on the 22nd is already the 23rd in Karachi.
    expect(sinceText("2026-09-22T23:30:00.000Z", "Asia/Karachi", now)).toBe("04:30");
  });

  it("the moved notice toast keeps its sentence", () => {
    expect(noticeText("owner-only")).toBe("Only the Owner can open that page.");
    expect(noticeText("something-else")).toBeNull();
    expect(noticeText(null)).toBeNull();
  });
});
