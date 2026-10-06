import { describe, expect, it } from "vitest";
import {
  FALLBACK_CAP_ZONE,
  addCapDays,
  capDayBounds,
  capDayOf,
  capDayOfWeek,
  closedCapDaysAfter,
  compareCapDays,
  isCapDay,
  safeZone,
} from "@/core/sending/capday";

const KARACHI = "Asia/Karachi";
const BERLIN = "Europe/Berlin";

describe("capDayOf", () => {
  it("switches at midnight Pakistan time (UTC+5, no DST)", () => {
    expect(capDayOf(new Date("2026-09-23T18:59:59Z"), KARACHI)).toBe("2026-09-23"); // 23:59:59 PKT
    expect(capDayOf(new Date("2026-09-23T19:00:00Z"), KARACHI)).toBe("2026-09-24"); // 00:00 PKT
  });

  it("uses the Karachi fallback for an invalid zone", () => {
    expect(safeZone("Not/AZone")).toBe(FALLBACK_CAP_ZONE);
    expect(safeZone(null)).toBe(FALLBACK_CAP_ZONE);
    expect(safeZone("Europe/Oslo")).toBe("Europe/Oslo");
    expect(capDayOf(new Date("2026-09-23T19:00:00Z"), "Not/AZone")).toBe("2026-09-24");
  });
});

describe("capDayBounds", () => {
  it("is 24 hours in Karachi", () => {
    const b = capDayBounds("2026-09-24", KARACHI);
    expect(b.start.toISOString()).toBe("2026-09-23T19:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-24T19:00:00.000Z");
  });

  it("is 23 hours on Berlin's spring-forward day and 25 on its fall-back day", () => {
    const spring = capDayBounds("2026-03-29", BERLIN);
    expect(spring.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    const fall = capDayBounds("2026-10-25", BERLIN);
    expect(fall.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(fall.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3_600_000);
  });

  it("agrees with capDayOf at both edges", () => {
    const b = capDayBounds("2026-09-23", KARACHI);
    expect(capDayOf(b.start, KARACHI)).toBe("2026-09-23");
    expect(capDayOf(new Date(b.end.getTime() - 1), KARACHI)).toBe("2026-09-23");
    expect(capDayOf(b.end, KARACHI)).toBe("2026-09-24");
  });
});

describe("cap-day arithmetic", () => {
  it("adds, compares and names weekdays", () => {
    expect(addCapDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addCapDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(compareCapDays("2026-09-23", "2026-09-24")).toBeLessThan(0);
    expect(compareCapDays("2026-09-24", "2026-09-24")).toBe(0);
    expect(compareCapDays("2026-10-01", "2026-09-30")).toBeGreaterThan(0);
    expect(capDayOfWeek("2026-09-23")).toBe(3); // Wednesday
    expect(capDayOfWeek("2026-09-27")).toBe(7); // Sunday
    expect(isCapDay("2026-09-23")).toBe(true);
    expect(isCapDay("2026-9-23")).toBe(false);
    expect(isCapDay(null)).toBe(false);
    // A damaged stored day must never reach the date functions (they throw on impossible dates).
    expect(isCapDay("2026-02-30")).toBe(false);
    expect(isCapDay("2026-13-01")).toBe(false);
    expect(isCapDay("2028-02-29")).toBe(true);
  });
});

describe("closedCapDaysAfter", () => {
  const now = new Date("2026-09-23T10:00:00Z"); // 15:00 PKT on 23 Sep

  it("lists the closed days after the last evaluated one, oldest first, never today", () => {
    expect(closedCapDaysAfter("2026-09-20", now, KARACHI)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(closedCapDaysAfter("2026-09-22", now, KARACHI)).toEqual([]);
    expect(closedCapDaysAfter("2026-09-23", now, KARACHI)).toEqual([]);
  });

  it("closes a day exactly at midnight Pakistan time", () => {
    expect(closedCapDaysAfter("2026-09-22", new Date("2026-09-23T18:59:59Z"), KARACHI)).toEqual([]);
    expect(closedCapDaysAfter("2026-09-22", new Date("2026-09-23T19:00:00Z"), KARACHI)).toEqual(["2026-09-23"]);
  });

  it("stops at `max`", () => {
    const days = closedCapDaysAfter("2026-01-01", now, KARACHI, 5);
    expect(days).toEqual(["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"]);
    expect(closedCapDaysAfter("2026-01-01", now, KARACHI)).toHaveLength(60);
  });
});
