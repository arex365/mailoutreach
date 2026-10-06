import { describe, expect, it } from "vitest";
import {
  HOLD_REASONS,
  formatHoldReasons,
  heldReasonsOf,
  outageGapCovered,
  parseHoldReasons,
  withHoldReason,
} from "@/core/sequences/hold-reasons";

/** Tests for the step-C contract file (M4-DESIGN §8.6; P1 owns them). */

describe("parseHoldReasons / formatHoldReasons", () => {
  it("round-trips in the fixed order", () => {
    expect(HOLD_REASONS).toEqual(["outage", "possible-reply"]);
    expect(parseHoldReasons("possible-reply,outage")).toEqual(["outage", "possible-reply"]);
    expect(formatHoldReasons(["possible-reply", "outage"])).toBe("outage,possible-reply");
    expect(formatHoldReasons(parseHoldReasons("outage,possible-reply"))).toBe("outage,possible-reply");
  });

  it("drops junk, spaces and duplicates", () => {
    expect(parseHoldReasons(" outage , junk,possible-reply,outage")).toEqual(["outage", "possible-reply"]);
    expect(parseHoldReasons("junk")).toEqual([]);
    expect(formatHoldReasons(["outage", "outage"])).toBe("outage");
  });

  it("empty gives [] and null", () => {
    expect(parseHoldReasons(null)).toEqual([]);
    expect(parseHoldReasons(undefined)).toEqual([]);
    expect(parseHoldReasons("")).toEqual([]);
    expect(formatHoldReasons([])).toBeNull();
  });
});

describe("withHoldReason", () => {
  it("adds and removes one reason", () => {
    expect(withHoldReason(null, "outage", true)).toBe("outage");
    expect(withHoldReason("outage", "possible-reply", true)).toBe("outage,possible-reply");
    expect(withHoldReason("possible-reply", "outage", true)).toBe("outage,possible-reply");
    expect(withHoldReason("outage,possible-reply", "possible-reply", false)).toBe("outage");
    expect(withHoldReason("outage,possible-reply", "outage", true)).toBe("outage,possible-reply");
  });

  it("removing the last reason gives null", () => {
    expect(withHoldReason("outage", "outage", false)).toBeNull();
    expect(withHoldReason(null, "outage", false)).toBeNull();
    expect(withHoldReason("junk", "possible-reply", false)).toBeNull();
  });
});

describe("heldReasonsOf", () => {
  it("reads the reasons only while the recipient is HELD", () => {
    expect(heldReasonsOf({ state: "HELD", holdReason: "possible-reply,outage" })).toEqual(["outage", "possible-reply"]);
    for (const state of ["SCHEDULED", "WAITING", "STOPPED", "FINISHED", "RECHECK"]) {
      expect(heldReasonsOf({ state, holdReason: "outage" })).toEqual([]);
    }
    expect(heldReasonsOf({ state: "HELD", holdReason: null })).toEqual([]);
  });
});

describe("outageGapCovered (M4-DESIGN §2.8.3)", () => {
  const held = { heldFor: "2026-10-03T08:00:00.000Z", heldTo: "2026-10-09T08:00:00.000Z" };

  it("covers a gap starting at or inside the held window", () => {
    expect(outageGapCovered(held, { from: "2026-10-03T08:00:00.000Z" })).toBe(true);
    expect(outageGapCovered(held, { from: "2026-10-05T12:00:00.000Z" })).toBe(true);
  });

  it("doesn't cover a gap starting before it (an older domain's longer gap) or at/after its end (a new outage)", () => {
    expect(outageGapCovered(held, { from: "2026-10-01T00:00:00.000Z" })).toBe(false);
    expect(outageGapCovered(held, { from: "2026-10-09T08:00:00.000Z" })).toBe(false);
    expect(outageGapCovered(held, { from: "2026-10-12T00:00:00.000Z" })).toBe(false);
  });

  it("never covers anything without a held window or with unreadable dates", () => {
    expect(outageGapCovered({ heldFor: null, heldTo: null }, { from: "2026-10-05T12:00:00.000Z" })).toBe(false);
    expect(outageGapCovered({ heldFor: held.heldFor, heldTo: null }, { from: "2026-10-05T12:00:00.000Z" })).toBe(false);
    expect(outageGapCovered({ heldFor: null, heldTo: held.heldTo }, { from: "2026-10-05T12:00:00.000Z" })).toBe(false);
    expect(outageGapCovered(held, { from: "not a date" })).toBe(false);
    expect(outageGapCovered({ heldFor: "x", heldTo: held.heldTo }, { from: "2026-10-05T12:00:00.000Z" })).toBe(false);
  });
});
