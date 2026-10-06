import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { LONG_VALUES } from "../../scripts/lib/seed-m6-values";
import { ROOT } from "./instances";
import { expectAccessible, expectNoHorizontalScroll, mainOf, manifest, onlyIn, open, shot, signIn } from "./helpers";

/**
 * The other main screens (M6-DESIGN §9.4 screens.spec). Live: axe, a screenshot and the no-sideways-scroll check of
 * each at both widths (Contacts,
 * the Missing email view, a company panel, Campaigns (Running and Drafts), a campaign page, the dry-run outbox, the six
 * wizard steps of a draft, Templates and the template editor, AI lines (Waiting and Approved), Import steps 1–4 with the
 * M5 fixture file up to the Check step and its Import button, Activity, Notifications). The seed puts a long company
 * name, website host, address and campaign names on these screens (scripts/lib/seed-m6-values.ts). Nothing is
 * committed: the import is started over at the end. Empty: each list's empty state.
 */

const IMPORT_FIXTURE = path.join(ROOT, "tests", "fixtures", "import", "m5-companies.csv");
const WIZARD_STEPS = ["audience", "sender", "message", "verify", "review", "schedule"] as const;

/**
 * axe, a screenshot, and no sideways scrolling (§4.1, §5.1 R10) on every scanned screen at both widths. The screenshot
 * comes before the width check, so a screen that fails it still leaves its picture in test-results/shots.
 */
async function scan(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectAccessible(page, name);
  await shot(page, testInfo, name);
  await expectNoHorizontalScroll(page, name);
}

test.describe("live screens", () => {
  onlyIn("live");

  test("Contacts, the Missing email view and a company panel", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const s = manifest().screens!;
    await signIn(page, "owner");
    await open(page, "/contacts");
    await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
    await scan(page, testInfo, "contacts");
    await open(page, "/contacts?view=missing-email");
    await scan(page, testInfo, "contacts-missing-email");
    await open(page, `/contacts?company=${s.company.id}`);
    const panel = page.getByRole("dialog");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(s.company.name);
    await scan(page, testInfo, "company-panel");
  });

  test("Campaigns, a campaign page and the dry-run outbox", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const s = manifest().screens!;
    await signIn(page, "owner");
    await open(page, "/campaigns");
    await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
    // The Running tab holds the dry run with a long name, the Drafts tab a draft with one (the seed's LONG_VALUES).
    await expect(mainOf(page)).toContainText(LONG_VALUES.runningCampaign);
    await scan(page, testInfo, "campaigns");
    await open(page, "/campaigns?tab=drafts");
    await expect(mainOf(page)).toContainText(LONG_VALUES.draftCampaign);
    await scan(page, testInfo, "campaigns-drafts");
    await open(page, `/campaigns/${s.campaign.id}`);
    await expect(mainOf(page)).toContainText(s.campaign.name);
    await scan(page, testInfo, "campaign-page");
    await open(page, "/campaigns/outbox");
    await expect(page.getByRole("heading", { level: 1, name: "Dry-run outbox" })).toBeVisible();
    await scan(page, testInfo, "dry-run-outbox");
  });

  test("the six wizard steps of a draft", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const s = manifest().screens!;
    await signIn(page, "owner");
    for (const step of WIZARD_STEPS) {
      await open(page, `/campaigns/${s.draft.id}/setup/${step}`);
      await expect(page, `the ${step} step`).toHaveURL(new RegExp(`/campaigns/${s.draft.id}/setup/${step}`));
      await expect(mainOf(page)).toContainText(s.draft.name);
      await scan(page, testInfo, `wizard-${step}`);
    }
  });

  test("Templates and the template editor", async ({ page }, testInfo) => {
    const s = manifest().screens!;
    await signIn(page, "owner");
    await open(page, "/templates");
    await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
    await scan(page, testInfo, "templates");
    await open(page, `/templates/${s.masterTemplateId}`);
    await scan(page, testInfo, "template-editor");
  });

  test("AI lines, Activity and Notifications", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await signIn(page, "owner");
    await open(page, "/ai-lines");
    await scan(page, testInfo, "ai-lines");
    // The approved line of the company with the long name and website host (the seed's LONG_VALUES).
    await open(page, "/ai-lines?tab=approved");
    await expect(mainOf(page)).toContainText(LONG_VALUES.company.domain);
    await scan(page, testInfo, "ai-lines-approved");
    await open(page, "/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await scan(page, testInfo, "activity");
    await open(page, "/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    await scan(page, testInfo, "notifications");
  });

  test("Import steps 1–4 up to the Import button, then started over", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await signIn(page, "owner");
    await open(page, "/import");
    await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
    await scan(page, testInfo, "import-1-upload");

    await page.locator('input[type="file"]').setInputFiles(IMPORT_FIXTURE);
    await page.waitForURL(/\/import\/\d+/, { timeout: 30_000 });
    const next = (name: string) => page.getByRole("button", { name, exact: true });
    await expect(next("Next: options")).toBeVisible();
    await scan(page, testInfo, "import-2-columns");

    await next("Next: options").click();
    await expect(next("Next: check the rows")).toBeVisible();
    await scan(page, testInfo, "import-3-options");

    await next("Next: check the rows").click();
    const importButton = page.getByRole("button", { name: /^Import \d+ new compan(y|ies)/ });
    await expect(importButton).toBeVisible({ timeout: 30_000 });
    await scan(page, testInfo, "import-4-check");

    // Never committed: back to the first step, then Start over.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(next("Next: check the rows")).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Start over", exact: true }).click();
    await page.waitForURL(/\/import$/);
  });
});

test.describe("empty lists", () => {
  onlyIn("empty");

  test("each main list says it is empty and what to do next", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await signIn(page, "owner");
    const lists: Array<{ url: string; text: string; name: string }> = [
      { url: "/contacts", text: "No companies yet.", name: "contacts-empty" },
      {
        url: "/campaigns",
        text: "No campaigns yet. Go to Contacts, tick the companies you want to email and click Email these companies.",
        name: "campaigns-empty",
      },
      { url: "/ai-lines", text: "Nothing to review.", name: "ai-lines-empty" },
      { url: "/activity", text: "Nothing yet. Changes you and your team make will show here.", name: "activity-empty" },
      { url: "/notifications", text: "You're all caught up.", name: "notifications-empty" },
    ];
    for (const l of lists) {
      await open(page, l.url);
      await expect(mainOf(page), l.url).toContainText(l.text);
      await scan(page, testInfo, l.name);
    }
    // A database always has the default sequences (the seed adds them, as the Templates page does on first open), so
    // Templates is never empty: the master sequence is listed.
    await open(page, "/templates");
    await expect(mainOf(page)).toContainText("Master sequence");
    await scan(page, testInfo, "templates-default");
  });
});
