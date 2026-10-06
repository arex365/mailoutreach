import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/settings/deliverability",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/settings/deliverability/actions", () => ({ saveHealthThresholdsAction: vi.fn() }));
vi.mock("@/app/(app)/settings/deliverability/check-actions", () => ({
  resumeChecksAction: vi.fn(),
  saveCheckSettingsAction: vi.fn(),
  saveVerificationKeyAction: vi.fn(),
  removeVerificationKeyAction: vi.fn(),
  testCheckAction: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/check-actions", () => ({ checkRunViewAction: vi.fn() }));

const { ThresholdsForm } = await import("@/components/settings/deliverability/thresholds-form");
const { ChecksPausedCard } = await import("@/components/settings/checks/checks-paused-card");
const { CheckSettingsForm } = await import("@/components/settings/checks/check-settings-form");
const { CheckKeyCard } = await import("@/components/settings/checks/check-key-card");
const { TestChecksCard } = await import("@/components/settings/checks/test-checks-card");
const { checkSettingsValuesFrom } = await import("@/components/settings/checks/check-settings");

/**
 * Settings › Deliverability keeps one orange button (PLAN.md A6, M5-DESIGN §6.6; M5 review SCREENS-02): "Save
 * thresholds" normally, "Resume checks" while address checks are paused, when the Thresholds form's button turns
 * outline.
 */

const THRESHOLDS = {
  bounceWindow: 200,
  bouncePercent: 3,
  complaintWindow: 1_000,
  complaintPercent: 0.1,
  healthyBouncePercent: 2,
  healthyComplaintPercent: 0.05,
};

/** The orange (default variant) buttons in some markup, by their text. */
function orangeButtons(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<button[^>]*data-variant="default"[^>]*>([\s\S]*?)<\/button>/g)) {
    out.push(m[1]!.replace(/<[^>]+>/g, "").trim());
  }
  return out;
}

/** The page's forms and cards as they render (without the tables and the do-not-email list, which have no primary). */
function page(paused: boolean): string {
  const values = checkSettingsValuesFrom({
    "verification.policy": null,
    "verification.pricePerCheck": 0.012,
    "verification.includedPerMonth": 0,
    "verification.maxAgeDays": 90,
    "verification.monthlyLimitUsd": 100,
    "verification.concurrency": 2,
  });
  return renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(ThresholdsForm, { initial: THRESHOLDS, primary: !paused }),
      paused ? createElement(ChecksPausedCard, { text: "Address checks paused: Mailgun didn't accept the key.", detail: null }) : null,
      createElement(CheckSettingsForm, { view: { values, thisMonth: "This month: 0 checks, $0 of your $100 limit." } }),
      createElement(CheckKeyCard, { view: { statusLine: "Uses your Mailgun key.", hasOwnKey: false, practiceCopy: false } }),
      createElement(TestChecksCard, { view: { defaultEmail: "arslan@polygonparadise.test", practiceCopy: false, pricePerCheck: 0.012 } }),
    ),
  );
}

describe("Settings › Deliverability has one orange button", () => {
  it("is Save thresholds while checks run", () => {
    expect(orangeButtons(page(false))).toEqual(["Save thresholds"]);
  });

  it("is Resume checks while checks are paused; Save thresholds is outline then", () => {
    const out = page(true);
    expect(orangeButtons(out)).toEqual(["Resume checks"]);
    expect(out).toMatch(/<button[^>]*data-variant="outline"[^>]*>Save thresholds<\/button>/);
  });

  it("keeps Save thresholds orange when nothing says otherwise", () => {
    const out = renderToStaticMarkup(createElement(ThresholdsForm, { initial: THRESHOLDS }));
    expect(orangeButtons(out)).toEqual(["Save thresholds"]);
  });
});
