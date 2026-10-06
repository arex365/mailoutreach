import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARMUP_TABLE,
  capacityLeft,
  domainCapFor,
  senderCapacityLeft,
  warmupCapFor,
  warmupTable,
} from "@/core/sending/caps";
import type { CapOverride } from "@/core/setting-types";

const PLAN_TABLE = [50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1000];

function nonDecreasing(list: readonly number[]): boolean {
  return list.every((v, i) => i === 0 || v >= list[i - 1]!);
}

describe("warmupTable", () => {
  it("is PLAN's own list for the default settings, as a copy", () => {
    const t = warmupTable(50, 1000, 20);
    expect(t).toEqual(PLAN_TABLE);
    expect(DEFAULT_WARMUP_TABLE).toEqual(PLAN_TABLE);
    t[0] = 1;
    expect(DEFAULT_WARMUP_TABLE[0]).toBe(50);
  });

  it("never decreases and ends exactly at the maximum for other settings", () => {
    for (const [start, max, steps] of [
      [10, 500, 10],
      [50, 60, 20],
      [100, 100, 5],
      [30, 10_000, 60],
      [50, 1000, 19],
    ] as const) {
      const t = warmupTable(start, max, steps);
      expect(t).toHaveLength(steps);
      expect(t[0]).toBe(start);
      expect(t[t.length - 1]).toBe(max);
      expect(nonDecreasing(t)).toBe(true);
    }
  });

  it("clamps odd input instead of failing", () => {
    expect(warmupTable(500, 100, 5)).toEqual([500, 500, 500, 500, 500]); // start above the maximum
    expect(warmupTable(50, 1000, 1)).toHaveLength(2);
  });
});

describe("warmupCapFor", () => {
  it("reads the table and stays inside it", () => {
    expect(warmupCapFor(0, DEFAULT_WARMUP_TABLE)).toBe(50);
    expect(warmupCapFor(6, DEFAULT_WARMUP_TABLE)).toBe(129);
    expect(warmupCapFor(19, DEFAULT_WARMUP_TABLE)).toBe(1000);
    expect(warmupCapFor(25, DEFAULT_WARMUP_TABLE)).toBe(1000);
    expect(warmupCapFor(-3, DEFAULT_WARMUP_TABLE)).toBe(50);
  });
});

describe("domainCapFor", () => {
  const override = (capDay: string, cap: number): CapOverride => ({ capDay, cap, byUserId: 1, at: "2026-09-23T09:02:00Z" });

  it("uses the warm-up limit without an override", () => {
    expect(domainCapFor({ capDay: "2026-09-23", warmupCap: 129, maxCap: 1000, override: null })).toEqual({
      cap: 129,
      source: "warmup",
      warmupCap: 129,
      maxCap: 1000,
      aboveSchedule: false,
    });
  });

  it("uses today's override, marked when it is above the schedule", () => {
    expect(domainCapFor({ capDay: "2026-09-23", warmupCap: 129, maxCap: 1000, override: override("2026-09-23", 300) })).toEqual({
      cap: 300,
      source: "override",
      warmupCap: 129,
      maxCap: 1000,
      aboveSchedule: true,
    });
    const below = domainCapFor({ capDay: "2026-09-23", warmupCap: 129, maxCap: 1000, override: override("2026-09-23", 20) });
    expect(below).toMatchObject({ cap: 20, source: "override", aboveSchedule: false });
  });

  it("ignores an override made for another day", () => {
    const r = domainCapFor({ capDay: "2026-09-24", warmupCap: 129, maxCap: 1000, override: override("2026-09-23", 300) });
    expect(r).toMatchObject({ cap: 129, source: "warmup" });
  });

  it("never goes above the maximum", () => {
    expect(domainCapFor({ capDay: "2026-09-23", warmupCap: 129, maxCap: 1000, override: override("2026-09-23", 5000) }).cap).toBe(1000);
    expect(domainCapFor({ capDay: "2026-09-23", warmupCap: 1000, maxCap: 500, override: null }).cap).toBe(500);
  });
});

describe("capacity", () => {
  it("counts what is left, never below zero", () => {
    expect(capacityLeft(50, 37)).toBe(13);
    expect(capacityLeft(50, 60)).toBe(0);
    expect(senderCapacityLeft(100, 30)).toBe(70);
    expect(senderCapacityLeft(10, 12)).toBe(0);
  });

  it("is unlimited for a sender without a limit of their own", () => {
    expect(senderCapacityLeft(null, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(senderCapacityLeft(undefined, 5)).toBe(Number.POSITIVE_INFINITY);
  });
});
