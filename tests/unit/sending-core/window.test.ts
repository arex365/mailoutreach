import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW,
  isWindowOpen,
  nextWindowOpen,
  openIntervals,
  openSecondsBetween,
  parseWindow,
  resolveZone,
  validateWindow,
  windowCloseAfter,
  windowSentence,
  type SendingWindow,
} from "@/core/sending/window";

const W = DEFAULT_WINDOW;
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";
const at = (iso: string) => new Date(iso);

describe("isWindowOpen", () => {
  it("opens at 09:00 and closes at 17:00 local time (Berlin summer time, UTC+2)", () => {
    // Wednesday 23 Sep 2026.
    expect(isWindowOpen(at("2026-09-23T06:59:59Z"), BERLIN, W)).toBe(false); // 08:59:59
    expect(isWindowOpen(at("2026-09-23T07:00:00Z"), BERLIN, W)).toBe(true); // 09:00
    expect(isWindowOpen(at("2026-09-23T14:59:59Z"), BERLIN, W)).toBe(true); // 16:59:59
    expect(isWindowOpen(at("2026-09-23T15:00:00Z"), BERLIN, W)).toBe(false); // 17:00
  });

  it("is closed at the weekend with the Monday-to-Friday default", () => {
    expect(isWindowOpen(at("2026-09-26T10:00:00Z"), BERLIN, W)).toBe(false); // Saturday noon
    expect(isWindowOpen(at("2026-09-27T10:00:00Z"), BERLIN, W)).toBe(false); // Sunday noon
    expect(isWindowOpen(at("2026-09-28T10:00:00Z"), BERLIN, W)).toBe(true); // Monday noon
  });

  it("follows Berlin's spring-forward weekend (29 Mar 2026)", () => {
    // Friday 27 Mar: CET, UTC+1.
    expect(isWindowOpen(at("2026-03-27T07:59:59Z"), BERLIN, W)).toBe(false);
    expect(isWindowOpen(at("2026-03-27T08:00:00Z"), BERLIN, W)).toBe(true);
    expect(isWindowOpen(at("2026-03-27T16:00:00Z"), BERLIN, W)).toBe(false);
    // Monday 30 Mar: CEST, UTC+2.
    expect(isWindowOpen(at("2026-03-30T06:59:59Z"), BERLIN, W)).toBe(false);
    expect(isWindowOpen(at("2026-03-30T07:00:00Z"), BERLIN, W)).toBe(true);
    expect(isWindowOpen(at("2026-03-30T15:00:00Z"), BERLIN, W)).toBe(false);
  });

  it("follows Berlin's fall-back weekend (25 Oct 2026)", () => {
    expect(isWindowOpen(at("2026-10-23T07:00:00Z"), BERLIN, W)).toBe(true); // Fri 09:00 CEST
    expect(isWindowOpen(at("2026-10-26T07:00:00Z"), BERLIN, W)).toBe(false); // Mon 08:00 CET
    expect(isWindowOpen(at("2026-10-26T08:00:00Z"), BERLIN, W)).toBe(true); // Mon 09:00 CET
    expect(isWindowOpen(at("2026-10-26T16:00:00Z"), BERLIN, W)).toBe(false); // Mon 17:00 CET
  });

  it("follows New York's switches (8 Mar and 1 Nov 2026)", () => {
    expect(isWindowOpen(at("2026-03-06T14:00:00Z"), NEW_YORK, W)).toBe(true); // Fri 09:00 EST
    expect(isWindowOpen(at("2026-03-09T12:59:59Z"), NEW_YORK, W)).toBe(false); // Mon 08:59:59 EDT
    expect(isWindowOpen(at("2026-03-09T13:00:00Z"), NEW_YORK, W)).toBe(true); // Mon 09:00 EDT
    expect(isWindowOpen(at("2026-10-30T13:00:00Z"), NEW_YORK, W)).toBe(true); // Fri 09:00 EDT
    expect(isWindowOpen(at("2026-11-02T13:30:00Z"), NEW_YORK, W)).toBe(false); // Mon 08:30 EST
    expect(isWindowOpen(at("2026-11-02T14:00:00Z"), NEW_YORK, W)).toBe(true); // Mon 09:00 EST
  });

  it("moves an edge inside a DST gap forward ('compatible')", () => {
    const night: SendingWindow = { days: [7], start: "02:30", end: "04:00" };
    // Sunday 29 Mar 2026: 02:00–03:00 doesn't exist in Berlin, so 02:30 means 03:30 CEST (01:30Z).
    expect(isWindowOpen(at("2026-03-29T01:15:00Z"), BERLIN, night)).toBe(false); // 03:15 CEST
    expect(isWindowOpen(at("2026-03-29T01:30:00Z"), BERLIN, night)).toBe(true); // 03:30 CEST
    expect(isWindowOpen(at("2026-03-29T01:59:59Z"), BERLIN, night)).toBe(true); // 03:59:59 CEST
    expect(isWindowOpen(at("2026-03-29T02:00:00Z"), BERLIN, night)).toBe(false); // 04:00 CEST
  });

  it("treats an invalid zone as Berlin instead of throwing", () => {
    expect(isWindowOpen(at("2026-09-23T07:00:00Z"), "Mars/Olympus_Mons", W)).toBe(true);
    expect(isWindowOpen(at("2026-09-23T06:00:00Z"), "Mars/Olympus_Mons", W)).toBe(false);
  });
});

describe("nextWindowOpen", () => {
  it("returns the instant itself while the window is open", () => {
    const now = at("2026-09-23T10:00:00Z");
    expect(nextWindowOpen(now, BERLIN, W).toISOString()).toBe(now.toISOString());
  });

  it("returns today's start before the window opens", () => {
    expect(nextWindowOpen(at("2026-09-23T05:00:00Z"), BERLIN, W).toISOString()).toBe("2026-09-23T07:00:00.000Z");
  });

  it("skips the weekend, including across both DST switches", () => {
    // Friday 17:00 → Monday 09:00 with the new offset.
    expect(nextWindowOpen(at("2026-03-27T16:00:00Z"), BERLIN, W).toISOString()).toBe("2026-03-30T07:00:00.000Z");
    expect(nextWindowOpen(at("2026-10-23T15:00:00Z"), BERLIN, W).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    expect(nextWindowOpen(at("2026-03-06T22:00:00Z"), NEW_YORK, W).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(nextWindowOpen(at("2026-10-30T21:00:00Z"), NEW_YORK, W).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // Saturday → Monday.
    expect(nextWindowOpen(at("2026-09-26T10:00:00Z"), BERLIN, W).toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("finds a once-a-week window a week later", () => {
    const mondays: SendingWindow = { days: [1], start: "09:00", end: "10:00" };
    // Monday 28 Sep 10:30 Berlin → Monday 5 Oct 09:00.
    expect(nextWindowOpen(at("2026-09-28T08:30:00Z"), BERLIN, mondays).toISOString()).toBe("2026-10-05T07:00:00.000Z");
  });
});

describe("windowCloseAfter", () => {
  it("gives the end of the open window, or null when closed", () => {
    expect(windowCloseAfter(at("2026-09-23T10:00:00Z"), BERLIN, W)?.toISOString()).toBe("2026-09-23T15:00:00.000Z");
    expect(windowCloseAfter(at("2026-09-23T16:00:00Z"), BERLIN, W)).toBeNull();
  });
});

describe("openIntervals and openSecondsBetween", () => {
  const from = at("2026-09-23T00:00:00Z");
  const to = at("2026-09-24T00:00:00Z");

  it("clips each local window to the range", () => {
    // Sydney is UTC+10 in September: Wednesday's window started the day before in UTC, Thursday's starts at 23:00Z.
    expect(openIntervals(from, to, SYDNEY, W).map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ["2026-09-23T00:00:00.000Z", "2026-09-23T07:00:00.000Z"],
      ["2026-09-23T23:00:00.000Z", "2026-09-24T00:00:00.000Z"],
    ]);
    expect(openIntervals(to, from, SYDNEY, W)).toEqual([]);
  });

  it("counts the union of Berlin, New York and Sydney once", () => {
    // Berlin 07–15Z, New York 13–21Z, Sydney 00–07Z and 23–24Z: 00–21Z plus 23–24Z = 22 hours.
    expect(openSecondsBetween(from, to, [BERLIN, NEW_YORK, SYDNEY], W)).toBe(22 * 3600);
    // Berlin and New York overlap 13–15Z: 07–21Z = 14 hours, not 16.
    expect(openSecondsBetween(from, to, [BERLIN, NEW_YORK], W)).toBe(14 * 3600);
    expect(openSecondsBetween(from, to, [BERLIN, BERLIN], W)).toBe(8 * 3600);
    expect(openSecondsBetween(from, to, [], W)).toBe(0);
  });

  it("counts partial windows in seconds", () => {
    expect(openSecondsBetween(at("2026-09-23T14:59:30Z"), to, [BERLIN], W)).toBe(30);
  });

  it("counts the real length of a window on DST nights", () => {
    // Every day 01:00–04:00 Berlin: 2 hours on 29 Mar (23-hour day), 4 hours on 25 Oct (25-hour day).
    const night: SendingWindow = { days: [1, 2, 3, 4, 5, 6, 7], start: "01:00", end: "04:00" };
    expect(openSecondsBetween(at("2026-03-28T23:00:00Z"), at("2026-03-29T22:00:00Z"), [BERLIN], night)).toBe(2 * 3600);
    expect(openSecondsBetween(at("2026-10-24T22:00:00Z"), at("2026-10-25T23:00:00Z"), [BERLIN], night)).toBe(4 * 3600);
  });
});

describe("resolveZone", () => {
  it("uses the company's zone, then the default zone, then Berlin", () => {
    expect(resolveZone("America/New_York", "Europe/Oslo")).toBe("America/New_York");
    expect(resolveZone(null, "Europe/Oslo")).toBe("Europe/Oslo");
    expect(resolveZone("", "Europe/Oslo")).toBe("Europe/Oslo");
    expect(resolveZone("Mars/Base", "Europe/Oslo")).toBe("Europe/Oslo");
    expect(resolveZone(undefined, "Not/AZone")).toBe("Europe/Berlin");
    expect(resolveZone("Nope", "")).toBe("Europe/Berlin");
  });
});

describe("validateWindow and parseWindow", () => {
  it("accepts a valid window and tidies the days", () => {
    expect(validateWindow({ days: [5, 1, 3, 3], start: "09:30", end: "16:00" })).toEqual({
      ok: true,
      value: { days: [1, 3, 5], start: "09:30", end: "16:00" },
    });
  });

  it("refuses bad input with a plain message", () => {
    expect(validateWindow({ days: [1], start: "17:00", end: "09:00" })).toEqual({
      ok: false,
      error: "The end time must be after the start time.",
    });
    expect(validateWindow({ days: [1], start: "09:00", end: "09:00" })).toMatchObject({ ok: false });
    expect(validateWindow({ days: [1], start: "09:10", end: "17:00" })).toEqual({
      ok: false,
      error: "Pick times on the quarter hour, such as 09:00 or 17:30.",
    });
    expect(validateWindow({ days: [1], start: "9:00", end: "17:00" })).toMatchObject({ ok: false });
    expect(validateWindow({ days: [1], start: "24:00", end: "24:15" })).toMatchObject({ ok: false });
    expect(validateWindow({ days: [], start: "09:00", end: "17:00" })).toEqual({
      ok: false,
      error: "Pick at least one sending day.",
    });
    expect(validateWindow({ days: [0, 8], start: "09:00", end: "17:00" })).toMatchObject({ ok: false });
    expect(validateWindow(null)).toMatchObject({ ok: false });
  });

  it("falls back to a copy of the default for anything invalid", () => {
    const parsed = parseWindow({ days: "weekdays" });
    expect(parsed).toEqual(DEFAULT_WINDOW);
    parsed.days.push(6);
    expect(DEFAULT_WINDOW.days).toEqual([1, 2, 3, 4, 5]);
    expect(parseWindow({ days: [6, 7], start: "10:00", end: "14:00" })).toEqual({ days: [6, 7], start: "10:00", end: "14:00" });
  });
});

describe("windowSentence", () => {
  it("says the days and hours in plain words", () => {
    expect(windowSentence(DEFAULT_WINDOW)).toBe("Monday to Friday, 9:00–17:00");
    expect(windowSentence({ days: [1, 3, 5], start: "09:30", end: "16:00" })).toBe("Mon, Wed and Fri, 9:30–16:00");
    expect(windowSentence({ days: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "20:00" })).toBe("Every day, 8:00–20:00");
    expect(windowSentence({ days: [6], start: "10:00", end: "14:00" })).toBe("Saturday, 10:00–14:00");
    expect(windowSentence({ days: [6, 7], start: "10:00", end: "14:00" })).toBe("Sat and Sun, 10:00–14:00");
    expect(windowSentence({ days: [5, 6, 7], start: "00:00", end: "23:45" })).toBe("Friday to Sunday, 0:00–23:45");
  });
});
