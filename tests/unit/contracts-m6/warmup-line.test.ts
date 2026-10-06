import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_TABLE } from "@/core/sending/caps";
import { warmupLine, type WarmupToday } from "@/core/sending/warmup-line";

/** M6 step C contract (M6-DESIGN §2.6, §7.8): the warm-up line on every screen. */

const GOES_UP = "after a weekday with at least half the limit used and healthy numbers.";

/** Step 3 (index 2) of the default table: 69 a day, 50% = 34.5, so 35 sends qualify and 34 don't. */
const today = (over: Partial<WarmupToday> = {}): WarmupToday => ({
  sendingDay: true,
  used: 35,
  cap: 69,
  minUsePercent: 50,
  healthy: true,
  ...over,
});

describe("warmupLine", () => {
  it("says how the limit goes up when today isn't known (always true)", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, null)).toBe(`Warm-up step 3 of 20: 69 a day. It goes up to 80 ${GOES_UP}`);
    expect(warmupLine(0, DEFAULT_WARMUP_TABLE, null)).toBe(`Warm-up step 1 of 20: 50 a day. It goes up to 59 ${GOES_UP}`);
  });

  it("promises tomorrow's limit only while today qualifies so far", () => {
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today())).toBe(
      "Warm-up step 3 of 20: 69 a day. Tomorrow 80, if today's numbers stay healthy.",
    );
    // Exactly half used counts.
    expect(warmupLine(0, DEFAULT_WARMUP_TABLE, today({ used: 25, cap: 50 }))).toBe(
      "Warm-up step 1 of 20: 50 a day. Tomorrow 59, if today's numbers stay healthy.",
    );
  });

  it("falls back to the 'how it goes up' form when today doesn't qualify", () => {
    const otherwise = `Warm-up step 3 of 20: 69 a day. It goes up to 80 ${GOES_UP}`;
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ used: 34 }))).toBe(otherwise);
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ sendingDay: false }))).toBe(otherwise);
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ healthy: false }))).toBe(otherwise);
    expect(warmupLine(2, DEFAULT_WARMUP_TABLE, today({ used: 0, cap: 69 }))).toBe(otherwise);
  });

  it("says finished on the last step, and past it", () => {
    expect(warmupLine(19, DEFAULT_WARMUP_TABLE, today())).toBe("Warm-up finished: 1,000 a day.");
    expect(warmupLine(40, DEFAULT_WARMUP_TABLE, null)).toBe("Warm-up finished: 1,000 a day.");
    expect(warmupLine(0, [50], null)).toBe("Warm-up finished: 50 a day.");
    expect(warmupLine(3, [], null)).toBe("Warm-up finished.");
  });

  it("clamps a negative or fractional step to a whole step of the table", () => {
    expect(warmupLine(-3, DEFAULT_WARMUP_TABLE, null)).toBe(`Warm-up step 1 of 20: 50 a day. It goes up to 59 ${GOES_UP}`);
    expect(warmupLine(2.7, DEFAULT_WARMUP_TABLE, null)).toBe(`Warm-up step 3 of 20: 69 a day. It goes up to 80 ${GOES_UP}`);
  });

  it("treats a step that isn't a number as the first step instead of throwing", () => {
    expect(warmupLine(Number.NaN, DEFAULT_WARMUP_TABLE, null)).toBe(`Warm-up step 1 of 20: 50 a day. It goes up to 59 ${GOES_UP}`);
    expect(warmupLine(Number.POSITIVE_INFINITY, DEFAULT_WARMUP_TABLE, null)).toBe("Warm-up finished: 1,000 a day.");
  });

  it("writes numbers with thousands separators", () => {
    expect(warmupLine(1, [900, 1200, 2500], null)).toBe(`Warm-up step 2 of 3: 1,200 a day. It goes up to 2,500 ${GOES_UP}`);
    expect(warmupLine(2, [900, 1200, 2500], null)).toBe("Warm-up finished: 2,500 a day.");
  });
});
