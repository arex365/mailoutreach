import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectAccessible,
  expectAtMostOnePrimary,
  expectNoHorizontalScroll,
  mainOf,
  onlyIn,
  open,
  shot,
  signIn,
} from "./helpers";

/**
 * Settings (M6-DESIGN §5.1–§5.3, §9.4 settings.spec) in the empty, busy and live states: every page as the Owner and
 * the three everyone pages as a Member (heading = nav label = page title, at most one orange button, axe, no sideways
 * scrolling on a phone), the lists' empty states, a Member sent back from an Owner page, "The 30-day rule" card's
 * error and confirmation, and the Cloudflare Access switch's confirmation. Nothing is saved: every dialog is
 * cancelled.
 */

type SettingsPage = { href: string; label: string };

const EVERYONE_PAGES: SettingsPage[] = [
  { href: "/settings/profile", label: "My profile" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/backups", label: "Backups" },
];

const OWNER_PAGES: SettingsPage[] = [
  { href: "/settings/sending", label: "Sending & Mailgun" },
  { href: "/settings/domain", label: "Domain checklist" },
  { href: "/settings/limits", label: "Limits & warm-up" },
  { href: "/settings/deliverability", label: "Deliverability" },
  { href: "/settings/footer", label: "Email footer" },
  { href: "/settings/ai", label: "AI" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/system", label: "System" },
];

/** §5.1 R1, R2, R10 and axe on one settings page. */
async function checkPage(page: Page, testInfo: TestInfo, p: SettingsPage, who: string): Promise<void> {
  await open(page, p.href);
  await expect(mainOf(page).getByRole("heading", { level: 2, name: p.label, exact: true }), `${p.label}: heading`).toBeVisible();
  await expect(page, `${p.label}: page title`).toHaveTitle(`${p.label} · Outreach`);
  const name = `Settings › ${p.label} (${who})`;
  await expectAtMostOnePrimary(page, name);
  await expectAccessible(page, name);
  await expectNoHorizontalScroll(page, name);
  await shot(page, testInfo, `settings-${who}-${p.label}`);
}

test.describe("settings", () => {
  onlyIn("empty", "busy", "live");

  test("every settings page as the Owner", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(page, "owner");
    for (const p of [...EVERYONE_PAGES, ...OWNER_PAGES]) await checkPage(page, testInfo, p, "owner");
  });

  test("the three everyone pages as a Member", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await signIn(page, "member");
    for (const p of EVERYONE_PAGES) await checkPage(page, testInfo, p, "member");
    // A Member sees only these three in the settings navigation.
    for (const p of OWNER_PAGES) await expect(page.getByRole("link", { name: p.label, exact: true })).toHaveCount(0);
  });

  test("a Member opening an Owner page lands on the dashboard", async ({ page }) => {
    await signIn(page, "member");
    await page.goto("/settings/sending");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("Only the Owner can open that page.")).toBeVisible();
  });

  test("The 30-day rule: a wrong number is refused, a shorter rule asks first", async ({ page }, testInfo) => {
    await signIn(page, "owner");
    await open(page, "/settings/limits#rules");
    const days = page.getByLabel("Days a company stays with whoever emailed it");
    const save = page.getByRole("button", { name: "Save rules", exact: true });
    await expect(page.getByText("The 30-day rule", { exact: true }).first()).toBeVisible();

    await days.fill("0");
    await save.click();
    await expect(page.getByText("Use a whole number of days from 1 to 365.").first()).toBeVisible();
    await expect(days).toHaveValue("0");

    await days.fill("21");
    await save.click();
    const confirm = page.getByRole("alertdialog", { name: "Save these rules?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Companies become free for teammates after 21 days instead of 30");
    await expect(confirm.getByRole("button", { name: "Save anyway" })).toBeVisible();
    await shot(page, testInfo, "settings-rules-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();

    // Nothing was saved. (A goto to the same URL and #hash only scrolls, so reload for the saved value.)
    await page.reload();
    await expect(page.getByLabel("Days a company stays with whoever emailed it")).toHaveValue("30");
  });

  test("the Cloudflare Access switch asks before turning the check off", async ({ page }, testInfo) => {
    await signIn(page, "owner");
    await open(page, "/settings/system");
    const toggle = page.getByRole("switch", { name: "We don't use Cloudflare Access" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const confirm = page.getByRole("alertdialog", { name: "Turn off the Access check?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Turn it off" })).toBeVisible();
    await shot(page, testInfo, "settings-access-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(toggle).not.toBeChecked();
  });
});

test.describe("empty lists", () => {
  onlyIn("empty");

  test("each settings list says it is empty and what to do", async ({ page }) => {
    await signIn(page, "owner");
    await open(page, "/settings/sending");
    await expect(mainOf(page)).toContainText(
      "No test addresses yet. Add two or three mailboxes that aren't your reply inbox, ideally one Gmail and one Outlook.com.",
    );
    await open(page, "/settings/limits");
    await expect(mainOf(page)).toContainText("Nobody has a sending address yet. Each person adds one in Settings › My profile.");
    await open(page, "/settings/deliverability");
    await expect(mainOf(page)).toContainText("Nobody is on the do-not-email list.");
    await open(page, "/settings/backups");
    await expect(mainOf(page)).toContainText("No backups yet.");
  });
});
