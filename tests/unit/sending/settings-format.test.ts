import { describe, expect, it } from "vitest";
import {
  WEEKDAY_CHOICES,
  capDaySentence,
  capDayText,
  overrideLine,
  parseSenderCap,
  quarterHours,
  todayCapLine,
  todayCapQuestion,
  usedLine,
  validateLimits,
  validateTodayCap,
  warmupHistoryLine,
  warmupRows,
} from "@/components/settings/limits/limits-format";
import { footerPreview, validateFooter } from "@/components/settings/footer/footer-format";
import type { WarmupDay } from "@/core/system-state";

/** Settings › Limits & warm-up and Settings › Email footer (M3-DESIGN §5.4, §5.6): the form rules and the sentences. */

const GOOD = {
  window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  defaultTimeZone: "Europe/Berlin",
  maxDailyCap: 1000,
  minGapSeconds: 20,
  capDayTimeZone: "Asia/Karachi",
  warmupStartCap: 50,
  warmupSteps: 20,
  warmupMinUsePercent: 50,
};

describe("validateLimits", () => {
  it("accepts good values (numbers typed as text too) and trims the zones", () => {
    const res = validateLimits({ ...GOOD, maxDailyCap: "800", capDayTimeZone: " Asia/Karachi " });
    expect(res).toEqual({ ok: true, value: { ...GOOD, maxDailyCap: 800 } });
  });

  it("checks every range and the time zones", () => {
    const res = validateLimits({
      ...GOOD,
      maxDailyCap: 49,
      minGapSeconds: 19.5,
      defaultTimeZone: "Nowhere/Town",
      warmupStartCap: 9,
      warmupSteps: 61,
      warmupMinUsePercent: 101,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual({
      maxDailyCap: "The maximum daily limit must be a whole number from 50 to 10,000.",
      minGapSeconds: "The smallest gap must be a whole number of seconds from 20 to 3,600.",
      defaultTimeZone: "Pick a time zone from the list, for example Europe/Berlin.",
      warmupStartCap: "The warm-up starts at a whole number from 10 to 500, and no higher than the maximum daily limit.",
      warmupSteps: "The warm-up needs a whole number of steps from 5 to 60.",
      warmupMinUsePercent: "Use a whole percentage from 10 to 100.",
    });
  });

  it("refuses a warm-up start above the maximum, and a bad window", () => {
    const res = validateLimits({ ...GOOD, maxDailyCap: 60, warmupStartCap: 100, window: { days: [], start: "09:00", end: "08:00" } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(Object.keys(res.errors).sort()).toEqual(["warmupStartCap", "window"]);
    expect(res.errors.window).toBeTruthy();
  });
});

describe("today's limit", () => {
  it("is a whole number from 0 to the maximum", () => {
    expect(validateTodayCap(0, 1000)).toEqual({ ok: true, value: 0 });
    expect(validateTodayCap("300", 1000)).toEqual({ ok: true, value: 300 });
    expect(validateTodayCap(1001, 1000)).toEqual({ ok: false, error: "Today's limit must be a whole number from 0 to 1,000." });
    expect(validateTodayCap(2.5, 1000).ok).toBe(false);
    expect(validateTodayCap(-1, 1000).ok).toBe(false);
  });

  it("warns about the new domain's reputation only above the warm-up schedule", () => {
    expect(todayCapQuestion(300, 129)).toEqual({
      title: "Change today's limit to 300?",
      body: "Today's limit becomes 300, above the warm-up schedule (129). Sending more than the schedule can hurt how inbox providers see your new domain. Change today's limit to 300?",
      aboveSchedule: true,
    });
    expect(todayCapQuestion(20, 129)).toEqual({
      title: "Change today's limit to 20?",
      body: "Today's limit becomes 20 for today only. Change it?",
      aboveSchedule: false,
    });
  });

  it("describes today's limit, its use and a change", () => {
    // M6-DESIGN §2.6: the ramp's step, never "day" (a step holds on a day that doesn't qualify).
    expect(todayCapLine({ cap: 129, source: "warmup", warmupStep: 6, warmupSteps: 20 })).toBe("Today's limit: 129 (warm-up step 7 of 20)");
    expect(todayCapLine({ cap: 1000, source: "warmup", warmupStep: 19, warmupSteps: 20 })).toBe("Today's limit: 1,000 (warm-up finished)");
    expect(todayCapLine({ cap: 300, source: "override", warmupStep: 6, warmupSteps: 20 })).toBe("Today's limit: 300 (changed for today)");
    expect(usedLine({ used: 37, left: 1092 })).toBe("Used 37 · 1,092 left");
    expect(overrideLine({ byName: "Arslan", atText: "14:02", cap: 300, aboveSchedule: true })).toBe(
      "Changed by Arslan at 14:02 to 300 (above the warm-up schedule).",
    );
    expect(overrideLine({ byName: "Arslan", atText: "14:02", cap: 30, aboveSchedule: false })).toBe("Changed by Arslan at 14:02 to 30.");
    expect(capDaySentence("Asia/Karachi")).toMatch(/^The day runs midnight to midnight .+ time \(Asia\/Karachi\)\.$/);
  });
});

describe("the warm-up table and history", () => {
  it("marks done, today and next", () => {
    expect(warmupRows([50, 59, 69, 80], 1)).toEqual([
      { day: 1, cap: 50, state: "done" },
      { day: 2, cap: 59, state: "today" },
      { day: 3, cap: 69, state: "next" },
      { day: 4, cap: 80, state: null },
    ]);
    expect(warmupRows([50, 59], 9).map((r) => r.state)).toEqual(["done", "today"]);
  });

  it("says what each evaluated day did", () => {
    const table = [50, 59, 69];
    const d = (over: Partial<WarmupDay>): WarmupDay => ({
      day: "2026-09-22",
      cap: 50,
      used: 48,
      result: "up",
      bounces: 0,
      bounceSample: 200,
      complaints: 0,
      complaintSample: 1000,
      stepAfter: 1,
      ...over,
    });
    // The browser's own month names, as everywhere in the app ("Sep" or "Sept", depending on the ICU version).
    const day = capDayText("2026-09-22");
    expect(day).toMatch(/^Tue 22 Sept?$/);
    expect(capDayText("not a day")).toBe("not a day");
    expect(warmupHistoryLine(d({}), table)).toBe(`${day}: 48 of 50 used, healthy → the limit rose to 59`);
    expect(warmupHistoryLine(d({ day: "2026-09-26", result: "hold-not-sending-day", stepAfter: 0 }), table)).toBe(
      `${capDayText("2026-09-26")}: not a sending day, the limit stays`,
    );
    expect(warmupHistoryLine(d({ used: 12, result: "hold-low-use", stepAfter: 0 }), table)).toBe(`${day}: only 12 of 50 used, the limit stays`);
    expect(warmupHistoryLine(d({ result: "hold-unhealthy", bounces: 4, stepAfter: 0 }), table)).toBe(
      `${day}: 4 bounces in the last 200 emails, the limit stays`,
    );
    expect(warmupHistoryLine(d({ result: "hold-unhealthy", complaints: 1, stepAfter: 0 }), table)).toBe(
      `${day}: 1 spam complaint in the last 1,000 emails, the limit stays`,
    );
    expect(warmupHistoryLine(d({ cap: 69, result: "hold-at-max", stepAfter: 2 }), table)).toBe(
      `${day}: the warm-up is finished, the limit stays at 69`,
    );
  });
});

describe("form helpers", () => {
  it("offers quarter hours and the seven weekdays", () => {
    const q = quarterHours();
    expect(q).toHaveLength(96);
    expect(q[0]).toBe("00:00");
    expect(q[37]).toBe("09:15");
    expect(q[95]).toBe("23:45");
    expect(WEEKDAY_CHOICES.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("reads a teammate's own limit: empty is none, 1–10,000 otherwise", () => {
    expect(parseSenderCap("")).toBeNull();
    expect(parseSenderCap("  ")).toBeNull();
    expect(parseSenderCap("100")).toBe(100);
    expect(parseSenderCap("0")).toBeUndefined();
    expect(parseSenderCap("10001")).toBeUndefined();
    expect(parseSenderCap("1.5")).toBeUndefined();
    expect(parseSenderCap("ten")).toBeUndefined();
  });
});

describe("the email footer", () => {
  const FOOTER = {
    companyName: "Polygon Paradise",
    address: "55th Avenue, Lahore",
    unsubscribeText: "If you'd rather not hear from us, unsubscribe here:",
    portfolioUrl: "https://www.polygonparadise.com",
  };

  it("accepts good values, trimmed and on one line", () => {
    expect(validateFooter({ ...FOOTER, companyName: " Polygon   Paradise ", address: "  55th  Avenue, Lahore " })).toEqual({
      ok: true,
      value: FOOTER,
    });
  });

  it("checks every field", () => {
    const res = validateFooter({ companyName: "", address: "a\nb", unsubscribeText: "100% sure", portfolioUrl: "https://user:pw@x.com" });
    expect(res).toEqual({
      ok: false,
      errors: {
        companyName: "Enter the company name, up to 100 characters.",
        address: "Enter the postal address on one line, up to 200 characters.",
        unsubscribeText: "Write the unsubscribe line, up to 150 characters, without a % sign.",
        portfolioUrl: "Enter the full link, starting with https://.",
      },
    });
    expect(validateFooter({ ...FOOTER, companyName: "x".repeat(101) }).ok).toBe(false);
    expect(validateFooter({ ...FOOTER, portfolioUrl: "www.polygonparadise.com" }).ok).toBe(false);
  });

  it("previews the footer with a stand-in for each person's unsubscribe link", () => {
    const p = footerPreview(FOOTER);
    expect(p.text).toBe("--\nPolygon Paradise · 55th Avenue, Lahore\nIf you'd rather not hear from us, unsubscribe here: [unsubscribe link]");
    expect(p.html).toContain("[unsubscribe link]");
    expect(p.html).not.toContain("%unsubscribe_url%");
    expect(p.html).toContain("If you&#39;d rather not hear from us");
  });
});
