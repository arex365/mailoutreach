import { describe, expect, it } from "vitest";
import { countsAsEmailed, countsAsReal, testListOnly, type SendModeValue } from "@/core/rules/mode";

/**
 * M6 step C contract (M6-DESIGN §2.2, §2.3, §7.8): "emailed" is judged per campaign by its launch flag; `testListOnly`
 * is new. (The step-C `goLive` bridge and `emailedModes` were removed once every caller passed the launch flag.)
 */

const MODES: readonly (SendModeValue | null | undefined)[] = ["DRY_RUN", "TEST", "LIVE", null, undefined];

describe("countsAsEmailed with the campaign's launch flag (M6-DESIGN §2.2)", () => {
  it("counts a LIVE send only when its campaign was launched after go-live", () => {
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: true })).toBe(true);
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: false })).toBe(false);
    // A draft (null) or an unknown flag never counts as emailed: only an explicit true does.
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: null })).toBe(false);
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: undefined })).toBe(false);
  });

  it("never counts test mode or a campaign without a mode; dry runs only in the practice copy", () => {
    for (const launchedGoLive of [true, false, null]) {
      for (const practiceCopy of [false, true]) {
        expect(countsAsEmailed("TEST", { practiceCopy, launchedGoLive })).toBe(false);
        expect(countsAsEmailed(null, { practiceCopy, launchedGoLive })).toBe(false);
        expect(countsAsEmailed("DRY_RUN", { practiceCopy, launchedGoLive })).toBe(practiceCopy);
      }
    }
  });

  it("is always a part of countsAsReal", () => {
    for (const mode of MODES) {
      for (const practiceCopy of [false, true]) {
        for (const launchedGoLive of [true, false, null]) {
          if (countsAsEmailed(mode, { practiceCopy, launchedGoLive })) expect(countsAsReal(mode, practiceCopy)).toBe(true);
        }
      }
    }
  });
});

describe("testListOnly (M6-DESIGN §2.3)", () => {
  it("keeps Mailgun's test mode on the test list for good, before and after go-live (G3)", () => {
    expect(testListOnly("TEST", false)).toBe(true);
    expect(testListOnly("TEST", true)).toBe(true);
  });

  it("keeps live sends on the test list only before go-live", () => {
    expect(testListOnly("LIVE", false)).toBe(true);
    expect(testListOnly("LIVE", true)).toBe(false);
  });

  it("never applies to dry runs or a campaign without a mode (they reach nobody)", () => {
    for (const goLive of [false, true]) {
      expect(testListOnly("DRY_RUN", goLive)).toBe(false);
      expect(testListOnly(null, goLive)).toBe(false);
      expect(testListOnly(undefined, goLive)).toBe(false);
    }
  });
});
