import { describe, expect, it } from "vitest";
import { estimateChecks } from "@/core/verification/estimate";
import { NOT_PAUSED_CHECKS } from "@/core/system-state-parse";
import { TEST_LIST_ONLY_LINES, verifyStepModel } from "@/components/checks/verify-model";
import type { CampaignCheckView } from "@/server/services/verification/select";

/**
 * The Verify step before and after go-live (M6-DESIGN §2.7): Test mode only ever emails the test list (G3), so its
 * card says so and needs no checks, also after go-live; a live campaign needs checks after go-live and keeps the
 * "until you go live" card before it; a dry run is unchanged.
 */

const NOW = new Date("2026-09-23T08:00:00Z");

function view(over: Partial<CampaignCheckView>): CampaignCheckView {
  return {
    mode: "LIVE",
    goLive: true,
    practiceCopy: false,
    notReady: null,
    pause: { ...NOT_PAUSED_CHECKS },
    need: { total: 3, notChecked: 3, tooOld: 0, testChecker: 0, secondCheck: 0 },
    tooMany: false,
    waiting: 0,
    fine: 0,
    estimate: estimateChecks({ count: 3, pricePerCheck: 0.012, includedPerMonth: 0, usedThisMonth: 0, provider: "mailgun" }),
    monthly: { limitUsd: 100, spentUsd: 0, wouldPass: false },
    run: null,
    leftOutByChecks: [],
    optional: null,
    ...over,
  };
}

function main(v: CampaignCheckView) {
  return verifyStepModel({ view: v, run: null, lastRun: null, isOwner: true, maxAgeDays: 90, timeZone: "Europe/Berlin", now: NOW }).main;
}

describe("the Verify step and go-live", () => {
  it("Test mode: the test-list card and its own sentence, before and after go-live", () => {
    for (const goLive of [false, true]) {
      expect(main(view({ mode: "TEST", goLive }))).toMatchObject({
        kind: "before-go-live",
        heading: "Nothing to check yet.",
        lines: ["Test mode only emails your test list, and those addresses count as checked."],
        check: null,
      });
    }
    expect(TEST_LIST_ONLY_LINES.TEST).not.toMatch(/go live/);
  });

  it("Live: the 'until you go live' card before go-live, the checks after it", () => {
    expect(main(view({ mode: "LIVE", goLive: false }))).toMatchObject({
      kind: "before-go-live",
      lines: ["Until you go live, only your test-list addresses get email, and they count as checked."],
    });
    expect(main(view({ mode: "LIVE", goLive: true }))).toMatchObject({ kind: "needs", heading: "3 addresses need a check" });
  });

  it("a dry run is the same before and after go-live", () => {
    const none = { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 };
    expect(main(view({ mode: "DRY_RUN", goLive: true, need: none }))).toEqual(main(view({ mode: "DRY_RUN", goLive: false, need: none })));
  });
});
