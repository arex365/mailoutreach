import { describe, expect, it } from "vitest";
import { countsAsEmailed, countsAsReal, modeLabel, realModes, testListOnly, type SendModeValue } from "@/core/rules/mode";
import { possessive, stepName, stepTitle } from "@/core/rules/wording";

describe("countsAsReal", () => {
  it("counts live sends everywhere", () => {
    expect(countsAsReal("LIVE", false)).toBe(true);
    expect(countsAsReal("LIVE", true)).toBe(true);
  });

  it("counts dry runs only in the practice copy", () => {
    expect(countsAsReal("DRY_RUN", false)).toBe(false);
    expect(countsAsReal("DRY_RUN", true)).toBe(true);
  });

  it("never counts Mailgun test mode, or a campaign without a mode", () => {
    expect(countsAsReal("TEST", false)).toBe(false);
    expect(countsAsReal("TEST", true)).toBe(false);
    expect(countsAsReal(null, true)).toBe(false);
    expect(countsAsReal(undefined, false)).toBe(false);
  });

  it("lists the counted modes for database filters", () => {
    expect(realModes(false)).toEqual(["LIVE"]);
    expect(realModes(true).sort()).toEqual(["DRY_RUN", "LIVE"]);
  });
});

describe("countsAsEmailed (M3-DESIGN §1.7, M6-DESIGN §2.2: judged by the campaign's launch flag)", () => {
  const MODES: readonly (SendModeValue | null | undefined)[] = ["DRY_RUN", "TEST", "LIVE", null, undefined];
  const FLAGS: readonly (boolean | null | undefined)[] = [true, false, null, undefined];

  /** The whole table: mode × practice copy × launch flag. */
  const expected = (mode: SendModeValue | null | undefined, practiceCopy: boolean, launchedGoLive: boolean | null | undefined): boolean => {
    if (mode === "LIVE") return launchedGoLive === true;
    if (mode === "DRY_RUN") return practiceCopy;
    return false;
  };

  it("follows the table for every mode, practice copy and launch flag", () => {
    for (const mode of MODES) {
      for (const practiceCopy of [false, true]) {
        for (const launchedGoLive of FLAGS) {
          expect(countsAsEmailed(mode, { practiceCopy, launchedGoLive }), `${mode} ${practiceCopy} ${launchedGoLive}`).toBe(
            expected(mode, practiceCopy, launchedGoLive),
          );
        }
      }
    }
  });

  it("counts a live send only when its campaign was launched after go-live (only an explicit true)", () => {
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: true })).toBe(true);
    // Launched before go-live: it could only reach the test list, also once go-live is on.
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: false })).toBe(false);
    // A draft (null) or a missing flag never counts.
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: null })).toBe(false);
    expect(countsAsEmailed("LIVE", { practiceCopy: false, launchedGoLive: undefined })).toBe(false);
  });

  it("never counts test mode, a campaign without a mode, or a dry run outside the practice copy", () => {
    for (const launchedGoLive of FLAGS) {
      expect(countsAsEmailed("TEST", { practiceCopy: true, launchedGoLive })).toBe(false);
      expect(countsAsEmailed(null, { practiceCopy: true, launchedGoLive })).toBe(false);
      expect(countsAsEmailed("DRY_RUN", { practiceCopy: false, launchedGoLive })).toBe(false);
    }
  });

  it("counts dry runs in the practice copy, whatever the launch flag says", () => {
    for (const launchedGoLive of FLAGS) expect(countsAsEmailed("DRY_RUN", { practiceCopy: true, launchedGoLive })).toBe(true);
  });

  it("is always a part of countsAsReal", () => {
    for (const mode of MODES) {
      for (const practiceCopy of [false, true]) {
        for (const launchedGoLive of FLAGS) {
          if (countsAsEmailed(mode, { practiceCopy, launchedGoLive })) expect(countsAsReal(mode, practiceCopy)).toBe(true);
        }
      }
    }
  });
});

describe("testListOnly (M6-DESIGN §2.3)", () => {
  const table: Array<[SendModeValue | null | undefined, boolean, boolean]> = [
    // Mailgun's test mode stays on the test list for good (G3).
    ["TEST", false, true],
    ["TEST", true, true],
    // Live only until go-live (at send time: the campaign's launch flag).
    ["LIVE", false, true],
    ["LIVE", true, false],
    // Dry runs and a campaign without a mode reach nobody.
    ["DRY_RUN", false, false],
    ["DRY_RUN", true, false],
    [null, false, false],
    [undefined, true, false],
  ];
  it.each(table)("%s with go-live %s → %s", (mode, goLive, out) => {
    expect(testListOnly(mode, goLive)).toBe(out);
  });
});

describe("wording", () => {
  it("names steps", () => {
    expect(stepName(0)).toBe("first email");
    expect(stepName(2)).toBe("follow-up 2");
    expect(stepTitle(0)).toBe("First email");
    expect(stepTitle(1)).toBe("Follow-up 1");
  });

  it("labels modes and makes possessives", () => {
    expect(modeLabel("DRY_RUN")).toBe("Dry run");
    expect(modeLabel("TEST")).toBe("Test");
    expect(modeLabel("LIVE")).toBe("Live");
    expect(possessive("Sara")).toBe("Sara's");
    expect(possessive("Klaus")).toBe("Klaus'");
  });
});
