import { expect, test } from "@playwright/test";
import { expectAccessible, expectAtMostOnePrimary, expectNoHorizontalScroll, isPhone, mainOf, manifest, onlyIn, open, shot, signIn } from "./helpers";

/**
 * Settings › Backups (M6-DESIGN §3.2–§3.7, §9.4 backups.spec) in the empty, busy and live states: the warning banner
 * (never / older than 36 hours), the kinds of the saved backups, the second folder read-only for Members, Back up now
 * without a background sender, and no "Last restore" card before any restore.
 */

const TEXT = {
  never: "No backup has been made yet.",
  noBackups: "No backups yet.",
  stale: "The last backup is more than 36 hours old.",
  ownerOnly: "Only the Owner can change this.",
  workerDownWaiting: "The background sender isn't running, so the backup is waiting. Double-click start.bat on the office PC.",
  lastRestore: "Last restore",
} as const;

test.describe("backups", () => {
  onlyIn("empty", "busy", "live");

  test("the Owner's page", async ({ page }, testInfo) => {
    await signIn(page, "owner");
    await open(page, "/settings/backups");
    const main = mainOf(page);
    if (manifest().state === "empty") {
      await expect(page.getByRole("alert").filter({ hasText: TEXT.never })).toBeVisible();
      await expect(main).toContainText(TEXT.noBackups);
    }
    if (manifest().state === "busy") {
      await expect(page.getByRole("alert").filter({ hasText: TEXT.stale })).toBeVisible();
      const table = main.getByRole("table");
      for (const kind of manifest().busy!.backupKinds) await expect(table, `the kind "${kind}"`).toContainText(kind);
      // The newest daily backup wasn't copied to the (missing) second folder; the Second copy column shows from 640 px.
      if (!isPhone(testInfo)) await expect(table).toContainText("Not copied");
    }
    if (manifest().state === "live") {
      await expect(page.getByRole("alert").filter({ hasText: /^(No backup has been made yet\.|The last backup is more than 36 hours old\.)/ })).toHaveCount(0);
      await expect(main.getByRole("table")).toContainText("Daily backup");
      await expect(main.getByText(TEXT.lastRestore, { exact: true })).toHaveCount(0);
    }
    await expectAtMostOnePrimary(page, "Settings › Backups");
    await expectAccessible(page, "Settings › Backups");
    await expectNoHorizontalScroll(page, "Settings › Backups");
    await shot(page, testInfo, "backups-owner");
  });

  test("a Member sees the second folder read-only", async ({ page }, testInfo) => {
    await signIn(page, "member");
    await open(page, "/settings/backups");
    await expect(mainOf(page)).toContainText(TEXT.ownerOnly);
    await expect(page.getByLabel("Second folder")).toHaveCount(0);
    await expectAccessible(page, "Settings › Backups (Member)");
    await shot(page, testInfo, "backups-member");
  });
});

test.describe("Back up now without a background sender", () => {
  onlyIn("busy");

  test("a Member's Back up now waits and says why", async ({ page }) => {
    await signIn(page, "member");
    await open(page, "/settings/backups");
    const button = mainOf(page).getByRole("button", { name: "Back up now", exact: true });
    // The busy instance has no background sender, so a backup queued by an earlier run is still waiting (the button
    // then reads "Waiting to start…"); otherwise this click queues one.
    if ((await button.count()) > 0 && (await button.isEnabled())) await button.click();
    await expect(page.getByText(TEXT.workerDownWaiting)).toBeVisible();
  });
});
