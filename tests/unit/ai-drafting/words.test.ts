import { describe, expect, it } from "vitest";
import {
  CLAUDE_TOO_SLOW_TEXT,
  draftRunSummary,
  draftsReadyBody,
  pausedSummary,
  progressSummary,
  runStoppedBody,
  stoppedAfterText,
} from "@/server/ai/words";

/** The drafting job's sentences (M5-DESIGN §3.10, §9.3 Part A step 2). */

describe("ai.draftsReady body", () => {
  it("the design's example", () => {
    expect(draftsReadyBody({ ready: 27, noLine: 5, failed: 1, costUsd: 0.16 })).toBe(
      "27 lines are waiting for you. 5 companies got no line and 1 failed. Cost $0.16.",
    );
  });

  it("the M5 end-to-end sentence (3 × $0.0036 is shown as $0.01)", () => {
    expect(draftsReadyBody({ ready: 3, noLine: 1, failed: 0, costUsd: 0.0108 })).toBe(
      "3 lines are waiting for you. 1 company got no line. Cost $0.01.",
    );
  });

  it("parts only when they aren't zero, singular and plural", () => {
    expect(draftsReadyBody({ ready: 1, noLine: 0, failed: 0, costUsd: 0.0036 })).toBe("1 line is waiting for you. Cost less than $0.01.");
    expect(draftsReadyBody({ ready: 0, noLine: 2, failed: 0, costUsd: 0 })).toBe("2 companies got no line.");
    expect(draftsReadyBody({ ready: 2, noLine: 0, failed: 1, costUsd: 0 })).toBe("2 lines are waiting for you. 1 company failed.");
    expect(draftsReadyBody({ ready: 1_200, noLine: 0, failed: 0, costUsd: 0 })).toBe("1,200 lines are waiting for you.");
    expect(draftsReadyBody({ ready: 0, noLine: 0, failed: 0, costUsd: 0 })).toBe("");
  });
});

describe("ai.runStopped body", () => {
  it("the design's example", () => {
    expect(runStoppedBody({ spentUsd: 3.33, atMostUsd: 2.7, done: 180, total: 300 })).toBe(
      "This run was about to cost more than expected ($3.33 so far; at most $2.70 was estimated), so it stopped after 180 of 300 companies. The drafted lines are waiting for review.",
    );
  });

  it("one company", () => {
    expect(runStoppedBody({ spentUsd: 0.02, atMostUsd: 0.01, done: 0, total: 1 })).toContain("stopped after 0 of 1 company.");
  });

  it("small amounts get three decimals, so they never read the same (AI-3)", () => {
    expect(runStoppedBody({ spentUsd: 0.013653, atMostUsd: 0.0112, done: 1, total: 1 })).toContain(
      "($0.014 so far; at most $0.011 was estimated)",
    );
    expect(runStoppedBody({ spentUsd: 0.0652, atMostUsd: 0.05625, done: 2, total: 5 })).toContain("($0.065 so far; at most $0.056 was estimated)");
  });
});

describe("FAILED sentences", () => {
  it("a company whose calls went unanswered twice (AI-2)", () => {
    expect(CLAUDE_TOO_SLOW_TEXT).toBe("Claude took too long to answer for this company. Click Try again.");
  });
});

describe("job summaries", () => {
  it("finished, stopped, waiting", () => {
    expect(draftRunSummary({ ready: 3, noLine: 3, failed: 0, costUsd: 0.0108 })).toBe(
      "3 lines are waiting for review. 3 companies got no line. Cost $0.01.",
    );
    expect(draftRunSummary({ ready: 0, noLine: 0, failed: 0, costUsd: 0 })).toBe("No lines were drafted.");
    expect(stoppedAfterText(12, 30)).toBe("Stopped after 12 of 30 companies.");
    expect(stoppedAfterText(0, 30)).toBe("Drafting stopped before it started.");
    expect(progressSummary(12, 30)).toBe("12 of 30 companies drafted so far.");
    expect(pausedSummary("AI drafting paused: x.")).toBe("Paused: AI drafting paused: x.");
  });
});
