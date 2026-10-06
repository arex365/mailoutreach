import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_TABLE, warmupCapFor } from "@/core/sending/caps";
import { evaluateWarmupDay, isHealthyForWarmup, type WarmupDayInput } from "@/core/sending/warmup";

/** A good day on step 0: half of the 50 limit used, no problems. Settings are the defaults. */
function day(overrides: Partial<WarmupDayInput> = {}): WarmupDayInput {
  return {
    day: "2026-09-22",
    isSendingDay: true,
    step: 0,
    table: DEFAULT_WARMUP_TABLE,
    used: 25,
    minUsePercent: 50,
    bounces: 0,
    bounceSample: 25,
    bounceWindow: 200,
    healthyBouncePercent: 2,
    complaints: 0,
    complaintSample: 25,
    complaintWindow: 1000,
    healthyComplaintPercent: 0.05,
    ...overrides,
  };
}

describe("evaluateWarmupDay", () => {
  it("moves up one step after a good sending day", () => {
    expect(evaluateWarmupDay(day())).toEqual({
      day: "2026-09-22",
      cap: 50,
      used: 25,
      result: "up",
      bounces: 0,
      bounceSample: 25,
      complaints: 0,
      complaintSample: 25,
      stepAfter: 1,
    });
  });

  it("holds on a day that isn't a sending day, whatever else happened", () => {
    expect(evaluateWarmupDay(day({ isSendingDay: false, used: 50 }))).toMatchObject({ result: "hold-not-sending-day", stepAfter: 0 });
    expect(evaluateWarmupDay(day({ isSendingDay: false, step: 19 }))).toMatchObject({ result: "hold-not-sending-day" });
  });

  it("holds at the last step", () => {
    expect(evaluateWarmupDay(day({ step: 19, used: 1000 }))).toMatchObject({ result: "hold-at-max", cap: 1000, stepAfter: 19 });
    // A step beyond a shortened table counts as the last step.
    expect(evaluateWarmupDay(day({ step: 40, used: 1000 }))).toMatchObject({ result: "hold-at-max", stepAfter: 19 });
  });

  it("holds when less than half of the limit was used", () => {
    expect(evaluateWarmupDay(day({ used: 24 }))).toMatchObject({ result: "hold-low-use", stepAfter: 0 });
    expect(evaluateWarmupDay(day({ used: 25 })).result).toBe("up");
    // The scheduled limit counts, even when the Owner raised today's limit.
    expect(evaluateWarmupDay(day({ step: 6, used: 64 }))).toMatchObject({ cap: 129, result: "hold-low-use" });
    expect(evaluateWarmupDay(day({ step: 6, used: 65 })).result).toBe("up");
  });

  it("holds when bounces or complaints are too high, with fixed denominators", () => {
    // 200 × 2 % = 4: at most 3 bounces, however few emails went out.
    expect(evaluateWarmupDay(day({ bounces: 3 })).result).toBe("up");
    expect(evaluateWarmupDay(day({ bounces: 4 }))).toMatchObject({ result: "hold-unhealthy", stepAfter: 0, bounces: 4 });
    // 1,000 × 0.05 % = 0.5: a single complaint holds.
    expect(evaluateWarmupDay(day({ complaints: 1 }))).toMatchObject({ result: "hold-unhealthy", complaints: 1 });
  });

  it("reaches 1,000 a day after 19 qualifying days on the 20-step table", () => {
    let step = 0;
    let days = 0;
    while (step < DEFAULT_WARMUP_TABLE.length - 1) {
      const cap = warmupCapFor(step, DEFAULT_WARMUP_TABLE);
      const r = evaluateWarmupDay(day({ step, used: cap, bounceSample: Math.min(cap, 200), complaintSample: cap }));
      expect(r.result).toBe("up");
      step = r.stepAfter;
      days++;
    }
    expect(days).toBe(19);
    expect(warmupCapFor(step, DEFAULT_WARMUP_TABLE)).toBe(1000);
    expect(evaluateWarmupDay(day({ step, used: 1000 })).result).toBe("hold-at-max");
  });
});

describe("isHealthyForWarmup", () => {
  const base = { bounces: 0, bounceWindow: 200, healthyBouncePercent: 2, complaints: 0, complaintWindow: 1000, healthyComplaintPercent: 0.05 };

  it("uses the window sizes, not the number of emails sent", () => {
    expect(isHealthyForWarmup(base)).toBe(true);
    expect(isHealthyForWarmup({ ...base, bounces: 3 })).toBe(true);
    expect(isHealthyForWarmup({ ...base, bounces: 4 })).toBe(false);
    expect(isHealthyForWarmup({ ...base, complaints: 1 })).toBe(false);
  });

  it("compares percentages exactly", () => {
    // 1,000 × 0.1 % = 1 complaint: 0 is below it, 1 is not.
    expect(isHealthyForWarmup({ ...base, healthyComplaintPercent: 0.1, complaints: 0 })).toBe(true);
    expect(isHealthyForWarmup({ ...base, healthyComplaintPercent: 0.1, complaints: 1 })).toBe(false);
    // 300 × 0.3 % = 0.9.
    expect(isHealthyForWarmup({ ...base, bounceWindow: 300, healthyBouncePercent: 0.3, bounces: 0 })).toBe(true);
  });
});
