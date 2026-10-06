import type { WarmupDay } from "@/core/system-state";
import type { CapDay } from "./capday";
import { warmupCapFor } from "./caps";

/**
 * Warm-up (PLAN A5.13, B6.6, M3-DESIGN §4.1.3): the daily limit starts low and moves one step up the warm-up table
 * after each closed sending day on which enough of the limit was used while bounces and complaints stayed low.
 * Pure; the server side (warmup-days.ts, P3) collects the numbers and stores the result in SystemState "warmup".
 */

/** Everything needed to judge one closed cap day (the counts come from warmup-days.ts, P3). */
export type WarmupDayInput = {
  day: CapDay;
  /** The day's weekday is one of the sending window's days. */
  isSendingDay: boolean;
  /** 0-based step on the warm-up table during that day. */
  step: number;
  table: readonly number[];
  /** Counted sends of that cap day (campaign sends plus test sends). */
  used: number;
  /** Setting "warmup.minUsePercent" (default 50). */
  minUsePercent: number;
  bounces: number;
  bounceSample: number;
  /** Setting "health.bounceWindow" (default 200): the fixed denominator. */
  bounceWindow: number;
  /** Setting "warmup.healthyBouncePercent" (default 2). */
  healthyBouncePercent: number;
  complaints: number;
  complaintSample: number;
  /** Setting "health.complaintWindow" (default 1,000): the fixed denominator. */
  complaintWindow: number;
  /** Setting "warmup.healthyComplaintPercent" (default 0.05). */
  healthyComplaintPercent: number;
};

/** A percentage in thousandths of a percent, so 0.05 % compares exactly (no floating-point drift). */
function milliPercent(p: number): number {
  return Number.isFinite(p) ? Math.round(p * 1000) : 0;
}

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** `count × 100 < window × percent`, in integers. */
function belowShare(count: number, window: number, percent: number): boolean {
  return whole(count) * 100 * 1000 < whole(window) * milliPercent(percent);
}

/**
 * Healthy enough to raise the limit, with FIXED denominators (the window sizes, not the number of emails sent so
 * far): `bounces × 100 < bounceWindow × healthyBouncePercent` (200 × 2 % → at most 3 bounces) and
 * `complaints × 100 < complaintWindow × healthyComplaintPercent` (1,000 × 0.05 % → no complaint at all).
 */
export function isHealthyForWarmup(input: {
  bounces: number;
  bounceWindow: number;
  healthyBouncePercent: number;
  complaints: number;
  complaintWindow: number;
  healthyComplaintPercent: number;
}): boolean {
  return (
    belowShare(input.bounces, input.bounceWindow, input.healthyBouncePercent) &&
    belowShare(input.complaints, input.complaintWindow, input.healthyComplaintPercent)
  );
}

/**
 * Judges one closed cap day. In this order: not a sending day → "hold-not-sending-day"; already on the last step →
 * "hold-at-max"; less than `minUsePercent` of the day's scheduled limit used → "hold-low-use"; not healthy →
 * "hold-unhealthy"; otherwise "up" (one step). `cap` is the scheduled warm-up limit of that step, never an override.
 */
export function evaluateWarmupDay(input: WarmupDayInput): WarmupDay {
  const last = Math.max(0, input.table.length - 1);
  const step = Math.min(whole(input.step), last);
  const cap = input.table.length > 0 ? warmupCapFor(step, input.table) : 0;
  const used = whole(input.used);
  const base = {
    day: input.day,
    cap,
    used,
    bounces: whole(input.bounces),
    bounceSample: whole(input.bounceSample),
    complaints: whole(input.complaints),
    complaintSample: whole(input.complaintSample),
  };
  const hold = (result: WarmupDay["result"]): WarmupDay => ({ ...base, result, stepAfter: step });
  if (!input.isSendingDay) return hold("hold-not-sending-day");
  if (step >= last) return hold("hold-at-max");
  if (used * 100 * 1000 < cap * milliPercent(input.minUsePercent)) return hold("hold-low-use");
  if (!isHealthyForWarmup(input)) return hold("hold-unhealthy");
  return { ...base, result: "up", stepAfter: step + 1 };
}

// The warm-up line every screen shows is warmupLine (@/core/sending/warmup-line, M6-DESIGN §2.6): "Warm-up step 9 of
// 20: 177 a day. …". M3's "Day 9 of 20 · tomorrow's limit 207" (warmupProgressText) was removed in M6: a step can last
// several days, and tomorrow's limit is only sure once today qualifies.
