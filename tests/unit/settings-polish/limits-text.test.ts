import { describe, expect, it } from "vitest";
import { todayCapLine, warmupScheduleLines } from "@/components/settings/limits/limits-format";
import { builtInSummary, rulesCardDescription } from "@/components/settings/limits/rules-text";
import { DEFAULT_WARMUP_TABLE } from "@/core/sending/caps";

/**
 * Settings › Limits & warm-up wording (M6-DESIGN §2.6, §5.3): the warm-up lines before and after go-live and in the
 * practice copy, today's limit by step (never "day"), and "The 30-day rule" card's description and built-in list.
 */

const NOW = new Date("2026-09-30T08:00:00Z");
const TABLE = DEFAULT_WARMUP_TABLE;

describe("the warm-up schedule's lines", () => {
  it("real data before go-live: the ramp starts at go-live", () => {
    expect(
      warmupScheduleLines({ practiceCopy: false, goLive: false, goLiveAt: null, step: 0, table: TABLE, timeZone: "Asia/Karachi", now: NOW }),
    ).toEqual(["Warm-up starts when you go live. Until then only emails to your test list count, so the limit usually stays at 50."]);
  });

  it("before go-live, the limit named is the table's own start", () => {
    expect(
      warmupScheduleLines({ practiceCopy: false, goLive: false, goLiveAt: null, step: 0, table: [80, 90, 100], timeZone: "UTC", now: NOW })[0],
    ).toContain("so the limit usually stays at 80.");
  });

  it("after a domain change ended go-live, it waits for go-live again", () => {
    expect(
      warmupScheduleLines({
        practiceCopy: false,
        goLive: false,
        goLiveAt: "2026-09-27T09:05:00Z",
        step: 3,
        table: TABLE,
        timeZone: "UTC",
        now: NOW,
      })[0],
    ).toMatch(/^Warm-up starts when you go live\./);
  });

  it("after go-live: when it started, in the viewer's zone, then the warm-up line", () => {
    expect(
      warmupScheduleLines({
        practiceCopy: false,
        goLive: true,
        goLiveAt: "2026-09-27T20:30:00Z",
        step: 2,
        table: TABLE,
        timeZone: "Asia/Karachi",
        now: NOW,
      }),
    ).toEqual([
      "Warm-up started when you went live on 28 Sept.",
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.",
    ]);
  });

  it("after go-live without a recorded time: only the warm-up line", () => {
    expect(
      warmupScheduleLines({ practiceCopy: false, goLive: true, goLiveAt: null, step: 19, table: TABLE, timeZone: "UTC", now: NOW }),
    ).toEqual(["Warm-up finished: 1,000 a day."]);
    expect(
      warmupScheduleLines({ practiceCopy: false, goLive: true, goLiveAt: "not a date", step: 0, table: TABLE, timeZone: "UTC", now: NOW }),
    ).toEqual(["Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the limit used and healthy numbers."]);
  });

  it("follows the Owner's own warm-up settings, like the card's description (review SCREENS-10)", () => {
    const at = (rule: { minUsePercent?: number; weekdaysOnly?: boolean }) =>
      warmupScheduleLines({ practiceCopy: false, goLive: true, goLiveAt: null, step: 2, table: TABLE, timeZone: "UTC", now: NOW, rule });
    expect(at({ minUsePercent: 80, weekdaysOnly: false })).toEqual([
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a sending day with at least 80% of the limit used and healthy numbers.",
    ]);
    expect(at({ minUsePercent: 100, weekdaysOnly: true })).toEqual([
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with all of the limit used and healthy numbers.",
    ]);
    // The defaults read exactly as before.
    expect(at({ minUsePercent: 50, weekdaysOnly: true })).toEqual([
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.",
    ]);
  });

  it("the practice copy: the warm-up line, whatever go-live says", () => {
    for (const goLive of [false, true]) {
      expect(
        warmupScheduleLines({ practiceCopy: true, goLive, goLiveAt: null, step: 8, table: TABLE, timeZone: "UTC", now: NOW }),
      ).toEqual(["Warm-up step 9 of 20: 177 a day. It goes up to 207 after a weekday with at least half the limit used and healthy numbers."]);
    }
  });
});

describe("today's limit line", () => {
  it("names the ramp's step, not a day", () => {
    expect(todayCapLine({ cap: 129, source: "warmup", warmupStep: 6, warmupSteps: 20 })).toBe("Today's limit: 129 (warm-up step 7 of 20)");
    expect(todayCapLine({ cap: 1000, source: "warmup", warmupStep: 19, warmupSteps: 20 })).toBe("Today's limit: 1,000 (warm-up finished)");
    expect(todayCapLine({ cap: 300, source: "override", warmupStep: 6, warmupSteps: 20 })).toBe("Today's limit: 300 (changed for today)");
  });
});

describe("The 30-day rule card", () => {
  it("keeps its name and adds the length when it isn't 30", () => {
    expect(rulesCardDescription(30)).toBe("Who may email a company that a teammate emailed recently.");
    expect(rulesCardDescription(21)).toBe("Who may email a company that a teammate emailed recently. Now 21 days.");
    expect(rulesCardDescription(1)).toBe("Who may email a company that a teammate emailed recently. Now 1 day.");
    expect(rulesCardDescription(365)).toBe("Who may email a company that a teammate emailed recently. Now 365 days.");
  });

  it("collapses the built-in list to two names and the count", () => {
    expect(builtInSummary(["gmail.com", "googlemail.com", "outlook.com", "instagram.com"])).toBe("Built in: gmail.com, outlook.com, … (4).");
    expect(builtInSummary(["gmail.com", "outlook.com"])).toBe("Built in: gmail.com, outlook.com (2).");
    expect(builtInSummary(["a.example", "b.example", "c.example"])).toBe("Built in: a.example, b.example, … (3).");
  });
});
