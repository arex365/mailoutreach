import { describe, expect, it } from "vitest";
import { COMPANY_REPLIED_STOP, REPLIED_STOP, holdStateText, sequenceSuffix, stopStateText } from "@/core/sequences/wording";
import { countsAsEmailed } from "@/core/rules/mode";

describe("holdStateText (M4-DESIGN §2.12)", () => {
  it("outage alone", () => {
    expect(holdStateText(["outage"], "campaign")).toBe("On hold: replies may have been missed while the PC was off");
    expect(holdStateText(["outage"], "panel")).toBe("on hold: replies may have been missed while the PC was off");
  });

  it("a possible reply, alone or with the outage", () => {
    for (const reasons of [["possible-reply"], ["outage", "possible-reply"]] as const) {
      expect(holdStateText(reasons, "campaign")).toBe("On hold: a possible reply needs checking");
      expect(holdStateText(reasons, "panel")).toBe("on hold: a possible reply needs checking");
    }
  });

  it("reads the stored holdReason text too, and says 'On hold' without a reason", () => {
    expect(holdStateText("outage,possible-reply", "campaign")).toBe("On hold: a possible reply needs checking");
    expect(holdStateText("outage", "panel")).toBe("on hold: replies may have been missed while the PC was off");
    expect(holdStateText(null, "campaign")).toBe("On hold");
    expect(holdStateText([], "panel")).toBe("on hold");
    expect(holdStateText("junk", "campaign")).toBe("On hold");
  });
});

describe("stopStateText (M4 stop codes, §2.12)", () => {
  it("replied and company_replied", () => {
    expect(REPLIED_STOP).toBe("replied");
    expect(COMPANY_REPLIED_STOP).toBe("company_replied");
    expect(stopStateText(REPLIED_STOP, "campaign")).toBe("Stopped: they replied");
    expect(stopStateText(REPLIED_STOP, "panel")).toBe("stopped because they replied");
    expect(stopStateText(COMPANY_REPLIED_STOP, "campaign")).toBe("Stopped: someone at the company replied");
    expect(stopStateText(COMPANY_REPLIED_STOP, "panel")).toBe("stopped because someone at the company replied");
  });

  it("status stops", () => {
    expect(stopStateText("status:CLIENT", "campaign")).toBe("Stopped: marked Client");
    expect(stopStateText("status:CLIENT", "panel")).toBe("stopped because the company was marked Client");
    expect(stopStateText("status:REPLIED", "campaign")).toBe("Stopped: marked Replied");
    expect(stopStateText("status:NOT_INTERESTED", "campaign")).toBe("Stopped: marked Not interested");
    expect(stopStateText("status:DO_NOT_CONTACT", "panel")).toBe("stopped because the company was marked Do not contact");
  });

  it("leaves every other code to the existing texts", () => {
    for (const code of ["bounced", "unsubscribed", "failed", "campaign_cancelled", "Skipped by Sara", "status:CONTACTED", null, ""]) {
      expect(stopStateText(code, "campaign")).toBeNull();
    }
  });
});

describe("sequenceSuffix (§2.12)", () => {
  /** The suffix of a campaign in `mode`, launched with go-live `launchedGoLive` (M6-DESIGN §2.2: its own flag decides). */
  const suffix = (mode: "DRY_RUN" | "TEST" | "LIVE", practiceCopy: boolean, launchedGoLive: boolean | null) =>
    sequenceSuffix({ mode, countsAsEmailed: countsAsEmailed(mode, { practiceCopy, launchedGoLive }) });

  it("' (dry run)' for a dry run that doesn't count as emailed; none in the practice copy", () => {
    expect(suffix("DRY_RUN", false, false)).toBe(" (dry run)");
    expect(suffix("DRY_RUN", false, true)).toBe(" (dry run)");
    expect(suffix("DRY_RUN", true, false)).toBe("");
  });

  it("' (test)' for Mailgun's test mode", () => {
    expect(suffix("TEST", false, true)).toBe(" (test)");
    expect(suffix("TEST", true, true)).toBe(" (test)");
  });

  it("' (test list)' for LIVE of a campaign launched before go-live, for good; none when launched after", () => {
    expect(suffix("LIVE", false, false)).toBe(" (test list)");
    expect(suffix("LIVE", false, null)).toBe(" (test list)");
    expect(suffix("LIVE", false, true)).toBe("");
  });

  it("nothing without a mode", () => {
    expect(sequenceSuffix({ mode: null, countsAsEmailed: false })).toBe("");
  });

  it("builds the §2.12 texts with the state words", () => {
    expect(`${stopStateText(REPLIED_STOP, "campaign")}${suffix("LIVE", false, false)}`).toBe("Stopped: they replied (test list)");
    expect(`Finished${suffix("LIVE", false, false)}`).toBe("Finished (test list)");
  });
});
