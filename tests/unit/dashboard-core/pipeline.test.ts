import { describe, expect, it } from "vitest";
import { percentText, replyRate30Text, replyRateText, type ReplyRate } from "@/core/dashboard/pipeline";

/** The Companies tile's reply rate in words (M6-DESIGN §4.3, D8). */

const rate = (replied: number, emailed: number, last30 = { replied: 0, emailed: 0 }): ReplyRate => ({ replied, emailed, last30 });

describe("percentText", () => {
  it("is a whole number from 10 %, one decimal below, 0% for none", () => {
    expect(percentText(1, 5)).toBe("20%");
    expect(percentText(9, 200)).toBe("4.5%");
    expect(percentText(0, 5)).toBe("0%");
    expect(percentText(5, 5)).toBe("100%");
    expect(percentText(1, 3)).toBe("33%");
    expect(percentText(2, 3)).toBe("67%");
    expect(percentText(1, 10)).toBe("10%");
    expect(percentText(5, 60)).toBe("8.3%");
  });

  it("drops a trailing .0 and never shows 10.0%", () => {
    expect(percentText(1, 25)).toBe("4%");
    expect(percentText(999, 10_005)).toBe("10%");
  });

  it("says 'under 0.1%' for a share too small to show", () => {
    expect(percentText(1, 2_500)).toBe("under 0.1%");
    expect(percentText(1, 1_000)).toBe("0.1%");
  });

  it("is null when there is nothing to divide by", () => {
    expect(percentText(3, 0)).toBeNull();
    expect(percentText(0, 0)).toBeNull();
    expect(percentText(1, Number.NaN)).toBeNull();
    expect(percentText(1, -4)).toBeNull();
  });
});

describe("replyRateText", () => {
  it("says the share and the counts", () => {
    expect(replyRateText(rate(1, 5))).toBe("Reply rate: 20% (1 of 5 companies you emailed replied)");
    expect(replyRateText(rate(0, 5))).toBe("Reply rate: 0% (0 of 5 companies you emailed replied)");
    expect(replyRateText(rate(90, 1_240))).toBe("Reply rate: 7.3% (90 of 1,240 companies you emailed replied)");
  });

  it("is singular for one company", () => {
    expect(replyRateText(rate(0, 1))).toBe("Reply rate: 0% (0 of 1 company you emailed replied)");
    expect(replyRateText(rate(1, 1))).toBe("Reply rate: 100% (1 of 1 company you emailed replied)");
  });

  it("says so when no company was emailed yet", () => {
    expect(replyRateText(rate(0, 0))).toBe("No companies emailed yet.");
  });
});

describe("replyRate30Text", () => {
  it("shows the last 30 days only when a company was first emailed in them", () => {
    expect(replyRate30Text(rate(5, 60, { replied: 5, emailed: 60 }))).toBe("Last 30 days: 8.3% (5 of 60)");
    expect(replyRate30Text(rate(1, 5, { replied: 1, emailed: 5 }))).toBe("Last 30 days: 20% (1 of 5)");
    expect(replyRate30Text(rate(0, 1_500, { replied: 0, emailed: 1_200 }))).toBe("Last 30 days: 0% (0 of 1,200)");
    expect(replyRate30Text(rate(3, 40))).toBeNull();
  });
});
