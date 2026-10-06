import { expect, test } from "@playwright/test";
import { credentials, expectAccessible, expectNoHorizontalScroll, mainOf, shot } from "./helpers";

/**
 * The signed-out pages (M6-DESIGN §9.4 auth.spec, B12 "signed-out pages included"), in any seeded state (the own state
 * too, MAIN-DOMAIN-DESIGN §9.4): sign-in with
 * its error and its landing on the dashboard, invite and reset links that don't work, the first-run setup page once
 * users exist, and the not-found page. Each is scanned by axe and never scrolls sideways.
 */

/** The one message for an unknown email and a wrong password (src/lib/auth/throttle-rules.ts). */
const MISMATCH = "That email and password don't match. Check them and try again.";

test.describe("signed-out pages", () => {
  test("sign in: a wrong password is refused, then the Owner lands on the dashboard", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(mainOf(page)).toContainText("Use the email and password from your invite.");
    await expectAccessible(page, "the sign-in page");
    await expectNoHorizontalScroll(page, "the sign-in page");
    await shot(page, testInfo, "sign-in");

    // An address nobody has, so no seeded account collects a wrong try (they slow down its next sign-in).
    await page.getByLabel("Email").fill(`nobody-${Date.now()}@example.com`);
    await page.getByLabel("Password").fill("not-the-password-1");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(MISMATCH)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await shot(page, testInfo, "sign-in-error");

    const owner = credentials("owner");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard(\?|$)/);
  });

  test("an invite link that doesn't work says so", async ({ page }, testInfo) => {
    await page.goto(`/invite/not-a-real-invite-${Date.now()}`);
    await expect(page.getByText("This link doesn't work", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();
    await expectAccessible(page, "a broken invite link");
    await expectNoHorizontalScroll(page, "a broken invite link");
    await shot(page, testInfo, "invite-broken");
  });

  test("a reset link that doesn't work says so", async ({ page }, testInfo) => {
    await page.goto(`/reset/not-a-real-reset-${Date.now()}`);
    await expect(page.getByText("This link doesn't work", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();
    await expectAccessible(page, "a broken reset link");
    await expectNoHorizontalScroll(page, "a broken reset link");
    await shot(page, testInfo, "reset-broken");
  });

  test("the first-run setup page sends everyone to sign-in once users exist", async ({ page }) => {
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("an address the app doesn't know shows the not-found page", async ({ page }, testInfo) => {
    // Under a signed-out path, so it isn't sent to sign-in first.
    const res = await page.goto("/login/no-such-page");
    expect(res?.status()).toBe(404);
    await expect(page.getByText("This page doesn't exist.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to the dashboard" })).toBeVisible();
    await expectAccessible(page, "the not-found page");
    await expectNoHorizontalScroll(page, "the not-found page");
    await shot(page, testInfo, "not-found");
  });
});
