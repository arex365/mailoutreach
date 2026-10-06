import { describe, expect, it } from "vitest";
import { PACING_JITTER, jitterFactor, paceGapMs, targetGapMs } from "@/core/sending/pacing";

/** A small seeded random source (mulberry32), so the jitter test is repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const middle = () => 0.5;

describe("targetGapMs", () => {
  it("spreads the emails evenly over the open time left, N emails over N + 1 intervals", () => {
    // 3,300 s for 10 emails: 11 intervals of 5 minutes.
    expect(targetGapMs({ openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random: middle })).toBe(300_000);
    // Only 5 may still go today: 6 intervals of 550 s.
    expect(targetGapMs({ openSecondsLeft: 3300, capacityLeft: 5, dueCount: 50, minGapSeconds: 20, random: middle })).toBe(550_000);
  });

  it("uses the due count alone when there is no counted limit", () => {
    expect(
      targetGapMs({ openSecondsLeft: 3000, capacityLeft: Number.POSITIVE_INFINITY, dueCount: 4, minGapSeconds: 20, random: middle }),
    ).toBe(600_000);
  });

  it("varies by ±50 % with a seeded random source", () => {
    expect(PACING_JITTER).toBe(0.5);
    const random = seeded(42);
    const base = 300_000;
    const gaps = Array.from({ length: 1000 }, () =>
      targetGapMs({ openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random })!,
    );
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(base * 0.5);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(base * 1.5);
    expect(Math.min(...gaps)).toBeLessThan(base * 0.6);
    expect(Math.max(...gaps)).toBeGreaterThan(base * 1.4);
    expect(new Set(gaps).size).toBeGreaterThan(500);
    // The same seed gives the same gaps.
    const again = seeded(42);
    expect(targetGapMs({ openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random: again })).toBe(gaps[0]);
  });

  it("hits the edges of the jitter exactly", () => {
    expect(targetGapMs({ openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random: () => 0 })).toBe(150_000);
    expect(targetGapMs({ openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random: () => 1 })).toBe(450_000);
  });

  it("never goes below the smallest gap", () => {
    // 60 seconds for 100 emails would be 0.6 s each; the minimum of 20 s wins.
    expect(targetGapMs({ openSecondsLeft: 60, capacityLeft: 100, dueCount: 100, minGapSeconds: 20, random: middle })).toBe(20_000);
    expect(targetGapMs({ openSecondsLeft: 60, capacityLeft: 100, dueCount: 100, minGapSeconds: 45, random: () => 0.99 })).toBe(45_000);
  });

  it("returns null when there is nothing to pace", () => {
    const base = { openSecondsLeft: 3600, capacityLeft: 100, dueCount: 10, minGapSeconds: 20, random: middle };
    expect(targetGapMs({ ...base, dueCount: 0 })).toBeNull();
    expect(targetGapMs({ ...base, dueCount: -1 })).toBeNull();
    expect(targetGapMs({ ...base, capacityLeft: 0 })).toBeNull();
    expect(targetGapMs({ ...base, openSecondsLeft: 0 })).toBeNull();
    expect(targetGapMs({ ...base, openSecondsLeft: Number.NaN })).toBeNull();
  });
});

describe("paceGapMs: the last email of the day stays inside the window (GATES-01)", () => {
  it("never plans the last email on or after the close, whatever the factor", () => {
    // Wed 16:42 in Berlin, 18 minutes left, one email left after this one: at most 3/4 of the time left.
    for (const jitter of [0.5, 0.94 + 0.5, 1, 1.5]) {
      const gap = paceGapMs({ openSecondsLeft: 18 * 60, capacityLeft: 49, dueCount: 1, minGapSeconds: 20, jitter })!;
      expect(gap).toBeLessThanOrEqual(0.75 * 18 * 60_000);
      expect(gap).toBeLessThan(18 * 60_000);
    }
    // Several emails left: the last one of them is still one interval before the close.
    const open = 7 * 3600;
    for (const n of [1, 2, 5, 40]) {
      const gap = paceGapMs({ openSecondsLeft: open, capacityLeft: 1000, dueCount: n, minGapSeconds: 20, jitter: 1 })!;
      expect(gap * n).toBeLessThan(open * 1000);
      expect(gap).toBe(Math.round((open / (n + 1)) * 1000));
    }
  });

  it("treats a stored factor outside 0.5–1.5 as the even spacing", () => {
    const base = { openSecondsLeft: 3300, capacityLeft: 100, dueCount: 10, minGapSeconds: 20 };
    expect(paceGapMs({ ...base, jitter: 1 })).toBe(300_000);
    expect(paceGapMs({ ...base, jitter: 9 })).toBe(300_000);
    expect(paceGapMs({ ...base, jitter: Number.NaN })).toBe(300_000);
    expect(paceGapMs({ ...base, jitter: 1.5 })).toBe(450_000);
  });

  it("draws the factor in [0.5, 1.5]", () => {
    expect(jitterFactor(() => 0)).toBe(0.5);
    expect(jitterFactor(() => 0.5)).toBe(1);
    expect(jitterFactor(() => 1)).toBe(1.5);
    expect(jitterFactor(() => Number.NaN)).toBe(1);
    expect(jitterFactor(() => 7)).toBe(1.5);
  });
});
