import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capDayText, warmupExplanation, warmupHistoryLine } from "@/components/settings/limits/limits-format";
import { DEFAULT_WARMUP_TABLE, warmupTable } from "@/core/sending/caps";
import type { WarmupDay } from "@/core/system-state";

/** Settings › Limits & warm-up: sentences that follow the Owner's settings and small samples (review SPEC-17, SPEC-13, SPEC-03). */

describe("warmupExplanation (SPEC-17)", () => {
  it("says what the default schedule does", () => {
    expect(warmupExplanation(DEFAULT_WARMUP_TABLE, 50)).toBe(
      "The limit rises about 17% after each sending day on which at least half of it was used, while bounces and complaints stay low.",
    );
  });

  it("follows the Owner's own steps and use rule", () => {
    // 10 steps from 50 to 1,000: about 39% a day; 80% use needed.
    expect(warmupExplanation(warmupTable(50, 1000, 10), 80)).toBe(
      "The limit rises about 39% after each sending day on which at least 80% of it was used, while bounces and complaints stay low.",
    );
    expect(warmupExplanation(warmupTable(100, 2000, 30), 100)).toBe(
      "The limit rises about 11% after each sending day on which all of it was used, while bounces and complaints stay low.",
    );
    expect(warmupExplanation(warmupTable(50, 1000, 20), 25)).toContain("at least 25% of it was used");
  });

  it("says so when the warm-up starts at the maximum", () => {
    expect(warmupExplanation(warmupTable(500, 500, 20), 50)).toBe("The limit stays at 500 a day: the warm-up starts at the maximum daily limit.");
  });
});

describe("warm-up history with a small sample (SPEC-13)", () => {
  const d = (over: Partial<WarmupDay>): WarmupDay => ({
    day: "2026-09-22",
    cap: 50,
    used: 1,
    result: "hold-unhealthy",
    bounces: 0,
    bounceSample: 1,
    complaints: 0,
    complaintSample: 1,
    stepAfter: 0,
    ...over,
  });

  it("never says 'in the last 1 emails'", () => {
    const day = capDayText("2026-09-22");
    expect(warmupHistoryLine(d({ complaints: 1 }), [50, 59])).toBe(`${day}: 1 spam complaint in 1 email so far, the limit stays`);
    expect(warmupHistoryLine(d({ bounces: 1 }), [50, 59])).toBe(`${day}: 1 bounce in 1 email so far, the limit stays`);
    expect(warmupHistoryLine(d({ bounces: 2, bounceSample: 2 }), [50, 59])).toBe(`${day}: 2 bounces in the last 2 emails, the limit stays`);
  });
});

describe("the warm-up table's scroll box (SPEC-03)", () => {
  it("can be reached and scrolled with the keyboard", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "settings", "limits", "page.tsx"), "utf8");
    const box = /<div\s[^>]*className="max-h-80 overflow-y-auto[^"]*"[^>]*>/.exec(page)?.[0] ?? "";
    expect(box).not.toBe("");
    expect(box).toContain("tabIndex={0}");
    expect(box).toContain('role="region"');
    expect(box).toContain('aria-label="Warm-up schedule"');
  });
});
