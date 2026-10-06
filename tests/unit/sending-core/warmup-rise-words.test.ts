import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_TABLE } from "@/core/sending/caps";
import { GO_LIVE_COPY, goLiveDialogItems, goLiveWarmupItem } from "@/core/sending/go-live-copy";
import { isWeekdaysOnly, warmupLine, warmupRiseCondition, warmupUsePercent, type WarmupToday } from "@/core/sending/warmup-line";

/**
 * Review SCREENS-10: the warm-up sentences say how a step is earned in the Owner's own settings — "at least half" only
 * at the default 50 % (Setting "warmup.minUsePercent"), and "weekday" only while the sending days are Monday to Friday
 * (Setting "sending.window") — like the Limits page's explanation on the same card. With the defaults, the sentences
 * are the ones the docs quote.
 */

const DEFAULT_LINE = "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.";

const today = (over: Partial<WarmupToday> = {}): WarmupToday => ({
  sendingDay: true,
  used: 10,
  cap: 69,
  minUsePercent: 50,
  healthy: true,
  weekdaysOnly: true,
  ...over,
});

describe("warmupRiseCondition", () => {
  it("words the default rule as before", () => {
    expect(warmupRiseCondition(null)).toBe("weekday with at least half the limit used");
    expect(warmupRiseCondition({})).toBe("weekday with at least half the limit used");
    expect(warmupRiseCondition({ minUsePercent: 50, weekdaysOnly: true })).toBe("weekday with at least half the limit used");
  });

  it("follows the minimum use and the sending days", () => {
    expect(warmupRiseCondition({ minUsePercent: 80, weekdaysOnly: true })).toBe("weekday with at least 80% of the limit used");
    expect(warmupRiseCondition({ minUsePercent: 50, weekdaysOnly: false })).toBe("sending day with at least half the limit used");
    expect(warmupRiseCondition({ minUsePercent: 100, weekdaysOnly: false })).toBe("sending day with all of the limit used");
    expect(warmupRiseCondition({ minUsePercent: 33.4 })).toBe("weekday with at least 33% of the limit used");
  });

  it("reads the percent as the Limits page does: whole, 1–100, 50 when unreadable", () => {
    expect(warmupUsePercent(80)).toBe(80);
    expect(warmupUsePercent(250)).toBe(100);
    expect(warmupUsePercent(0)).toBe(50);
    expect(warmupUsePercent(Number.NaN)).toBe(50);
    expect(warmupUsePercent("nonsense")).toBe(50);
  });

  it("isWeekdaysOnly: exactly Monday to Friday", () => {
    expect(isWeekdaysOnly([1, 2, 3, 4, 5])).toBe(true);
    expect(isWeekdaysOnly([5, 4, 3, 2, 1])).toBe(true);
    expect(isWeekdaysOnly([1, 2, 3, 4, 5, 6])).toBe(false);
    expect(isWeekdaysOnly([1, 2, 3, 4])).toBe(false);
    expect(isWeekdaysOnly([])).toBe(false);
  });
});

describe("warmupLine with the Owner's rule", () => {
  it("keeps the defaults' sentence (docs and labels quote it)", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, null)).toBe(DEFAULT_LINE);
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today())).toBe(DEFAULT_LINE);
  });

  it("takes the rule from today's facts", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ minUsePercent: 80 }))).toBe(
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least 80% of the limit used and healthy numbers.",
    );
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ weekdaysOnly: false }))).toBe(
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a sending day with at least half the limit used and healthy numbers.",
    );
    // Facts written before `weekdaysOnly`: Monday to Friday.
    const older: WarmupToday = { sendingDay: true, used: 10, cap: 69, minUsePercent: 50, healthy: true };
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, older)).toBe(DEFAULT_LINE);
  });

  it("takes the rule given when today isn't known (the Limits page), and it wins over today's", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, null, { minUsePercent: 80, weekdaysOnly: false })).toBe(
      "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a sending day with at least 80% of the limit used and healthy numbers.",
    );
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ minUsePercent: 50 }), { minUsePercent: 70 })).toMatch(/at least 70% of the limit used/);
  });

  it("judges 'Tomorrow …' by today's minimum use, whatever the words", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ used: 56, minUsePercent: 80 }))).toBe(
      "Warm-up step 3 of 20: 69 a day. Tomorrow 80, if today's numbers stay healthy.",
    );
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ used: 55, minUsePercent: 80 }))).toMatch(/after a weekday with at least 80% of the limit used/);
  });
});

describe("the go-live dialog's warm-up item", () => {
  const WARMUP = { startCap: 50, maxCap: 1000, steps: 20 };

  it("keeps the defaults' sentence", () => {
    expect(goLiveWarmupItem(WARMUP)).toBe(GO_LIVE_COPY.dialogItems[1]);
    expect(goLiveWarmupItem({ ...WARMUP, minUsePercent: 50, weekdaysOnly: true })).toBe(GO_LIVE_COPY.dialogItems[1]);
  });

  it("follows the minimum use and the sending days", () => {
    expect(goLiveWarmupItem({ ...WARMUP, minUsePercent: 80, weekdaysOnly: false })).toBe(
      "Warm-up starts today: the daily limit starts at 50 and goes up one step after each sending day with at least 80% of the limit used and healthy numbers, to 1,000 in about 4 weeks.",
    );
    expect(goLiveDialogItems({ capOverrideToday: null, drafts: { items: [], more: 0 }, warmup: { ...WARMUP, minUsePercent: 60 } })[1]).toMatch(
      /after each weekday with at least 60% of the limit used/,
    );
  });
});
