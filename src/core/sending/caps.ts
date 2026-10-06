import type { CapOverride } from "@/core/setting-types";
import type { CapDay } from "./capday";

/**
 * Daily limits (PLAN B6.6). The warm-up table for the default settings is PLAN's own list; other settings use the
 * same geometric curve, rounded, never decreasing, ending exactly at the maximum.
 */
export const DEFAULT_WARMUP_TABLE: readonly number[] = [
  50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1000,
];

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export function warmupTable(startCap: number, maxCap: number, steps: number): number[] {
  const start = clampInt(startCap, 1, 100_000);
  const max = Math.max(start, clampInt(maxCap, 1, 100_000));
  const n = clampInt(steps, 2, 200);
  if (start === 50 && max === 1000 && n === 20) return [...DEFAULT_WARMUP_TABLE];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? max : Math.round(start * Math.pow(max / start, i / (n - 1)));
    out.push(Math.max(v, out[i - 1] ?? v));
  }
  return out;
}

export function warmupCapFor(step: number, table: readonly number[]): number {
  const i = Math.min(Math.max(0, Math.floor(step)), table.length - 1);
  return table[i]!;
}

export type DomainCap = {
  cap: number;
  source: "warmup" | "override";
  warmupCap: number;
  maxCap: number;
  /** An override above the warm-up schedule ("Above the warm-up schedule"). */
  aboveSchedule: boolean;
};

/** min(override, max) when the Owner confirmed an override for this cap day, else min(warm-up cap, max). */
export function domainCapFor(input: { capDay: CapDay; warmupCap: number; maxCap: number; override: CapOverride | null }): DomainCap {
  const maxCap = Math.max(0, Math.floor(input.maxCap));
  const warmupCap = Math.min(Math.max(0, Math.floor(input.warmupCap)), maxCap);
  const o = input.override;
  if (o && o.capDay === input.capDay && Number.isFinite(o.cap) && o.cap >= 0) {
    const cap = Math.min(Math.floor(o.cap), maxCap);
    return { cap, source: "override", warmupCap, maxCap, aboveSchedule: cap > warmupCap };
  }
  return { cap: warmupCap, source: "warmup", warmupCap, maxCap, aboveSchedule: false };
}

export function capacityLeft(cap: number, used: number): number {
  return Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(used)));
}

/** Infinity when the sender has no limit of their own (User.dailyCap null). */
export function senderCapacityLeft(senderCap: number | null | undefined, used: number): number {
  if (senderCap === null || senderCap === undefined || !Number.isFinite(senderCap)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(senderCap) - Math.max(0, Math.floor(used)));
}
