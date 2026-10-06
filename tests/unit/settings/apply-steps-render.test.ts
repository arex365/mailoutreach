import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { APPLY_STEP_TEXTS } from "@/core/dns/checklist";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { SetupStepView } from "@/components/settings/types";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings/domain",
}));
vi.mock("@/app/(app)/settings/domain/actions", () => ({
  applyRecommendedSettingsAction: vi.fn(),
  checkDomainAgainAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));

const { SetupSteps } = await import("@/components/settings/domain/checklist");

/**
 * The Recommended settings card's step list (reviews DOMAIN-3, SCREENS-06): in the owner's own-mailbox setup on the Free
 * plan without a public address, the steps that have no result say "Not needed", "Optional" or "Not in your plan" in
 * grey, never "Waiting" or red; app mode's waiting steps keep "Waiting" and a failed step stays red.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const step = (key: string, ok: boolean | null, t: string): SetupStepView => ({ key, ok, text: t, detail: null });

/** The owner's Apply run: what apply-settings records in own-mailbox mode on the Free plan, no public address. */
const OWN_FREE: SetupStepView[] = [
  step("public-address", null, OWN_MAILBOX_TEXTS.applyNoPublicAddress),
  step("tracking-open", true, "Open tracking is off."),
  step("tracking-click", true, "Click tracking is off."),
  step("unsubscribe", true, "Mailgun's unsubscribe handling is on, with its own footers blank."),
  step("spam-filter", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
  step("retention", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
  step("certificate", null, APPLY_STEP_TEXTS.certNotInPlan),
  step("https", null, APPLY_STEP_TEXTS.httpsNotInPlanOwn),
  step("signing-key", true, "Webhook signing key saved."),
  step("webhooks", null, APPLY_STEP_TEXTS.webhooksOptionalOwn),
  step("routes", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
];

function render(steps: SetupStepView[]): string {
  return renderToStaticMarkup(createElement(SetupSteps, { line: "Applied today at 10:00 by Arslan.", steps, bare: true }));
}

describe("SetupSteps (Recommended settings)", () => {
  it("own-mailbox mode on Free: Not needed, Optional, Not in your plan; nothing Waiting, nothing red", () => {
    const html = render(OWN_FREE);
    const t = text(html);
    expect(t).not.toContain("Waiting");
    expect(t).not.toContain("Not done");
    expect(html).not.toContain("text-destructive");
    expect(t).toContain(`Not needed ${OWN_MAILBOX_TEXTS.applyNotNeeded}`);
    expect(t).toContain(`Optional ${OWN_MAILBOX_TEXTS.applyNoPublicAddress}`);
    expect(t).toContain(`Optional ${APPLY_STEP_TEXTS.webhooksOptionalOwn}`);
    expect(t).toContain(`Not in your plan ${APPLY_STEP_TEXTS.certNotInPlan}`);
    expect(t).toContain(`Not in your plan ${APPLY_STEP_TEXTS.httpsNotInPlanOwn}`);
    expect(t.match(/Done/g)?.length).toBe(4);
  });

  it("app mode as before: a step that waits says Waiting, a failed one is red (the certificate not in the plan too)", () => {
    const t = text(
      render([
        step("webhooks", null, "Skipped until the public address works."),
        step("https", null, "Secure unsubscribe links need the certificate first."),
        step("certificate", false, APPLY_STEP_TEXTS.certNotInPlan),
      ]),
    );
    expect(t).toContain("Waiting Skipped until the public address works.");
    expect(t).toContain("Waiting Secure unsubscribe links need the certificate first.");
    expect(t).toContain(`Not done ${APPLY_STEP_TEXTS.certNotInPlan}`);
  });
});
