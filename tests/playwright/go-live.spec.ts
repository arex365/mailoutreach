import { expect, test, type Locator, type Page } from "@playwright/test";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { expectAccessible, expectNoHorizontalScroll, isPhone, manifest, onlyIn, open, sendingPill, shot, signIn } from "./helpers";

/**
 * The go-live switch on Settings › Sending & Mailgun (M6-DESIGN §2.5, §9.4 go-live.spec), in the ready state only. It
 * MUTATES the database (the laptop run goes live): reseed ready right before this spec (the checklist's check must be
 * less than an hour old) and again afterwards.
 *
 * The phone project runs first (see playwright.config.ts): it checks the card and the dialog at 390 px, full screen,
 * without changing anything. The laptop run checks them again, then goes live and checks the live card. Whichever
 * project finds the app already live checks the live card only.
 *
 * The dialog names the From address in both modes (SHARED-FROM-DESIGN F21). ready is seeded in shared-From mode
 * (contact@example.com): the dialog's item and the live card's From line are the shared address's, and the shots are
 * "go-live-dialog" and "go-live-card-live". For the per-person dialog ("…From the sender's own address, for example
 * Arslan from Polygon Paradise <arslan@send.example.com>.", shot "go-live-dialog-per-person"), reseed ready per person
 * and run this spec again, then reseed it as usual:
 *
 *   node --import tsx scripts/seed-m6-manual.ts --state ready --per-person
 *   $env:PP_E2E_STATE = "ready"; npx playwright test tests/playwright/go-live.spec.ts
 *   node --import tsx scripts/seed-m6-manual.ts --state ready
 */

/** "-per-person" on the shots of a ready state seeded without the shared From address. */
function modeSuffix(): string {
  return manifest().fromAddress ? "" : "-per-person";
}

const COPY = {
  before: "Before going live:",
  recommended: "Recommended first:",
  dialogTitle: "Go live?",
  confirmLabel: "I understand that real prospects will get emails from now on.",
  confirm: "Go live",
  cancel: "Not yet",
  cantSwitchOff: "This can't be switched off. To stop sending at any time, use Pause all sending.",
} as const;

function card(page: Page): Locator {
  return page.locator("#go-live");
}

function goLiveSwitch(page: Page): Locator {
  return card(page).getByRole("switch", { name: "Go live" });
}

function dialog(page: Page): Locator {
  return page.getByRole("dialog", { name: COPY.dialogTitle });
}

/** Whether the card already says "Live on … since …". */
async function alreadyLive(page: Page): Promise<boolean> {
  return (await card(page).getByText(/^Live on .* since /).count()) > 0;
}

async function openGoLive(page: Page): Promise<void> {
  await signIn(page, "owner");
  await open(page, "/settings/sending#go-live");
  await expect(card(page)).toBeVisible();
}

test.describe("go live", () => {
  onlyIn("ready");

  test("the card is ready and the dialog asks first (no change)", async ({ page }, testInfo) => {
    await openGoLive(page);
    test.skip(await alreadyLive(page), "Already live: reseed the ready state to see the dialog at this width.");
    const m = manifest();
    const ready = m.ready!;

    await expect(card(page).getByText(COPY.before, { exact: true })).toHaveCount(0);
    await expect(card(page).getByText(COPY.recommended, { exact: true })).toBeVisible();
    await expect(card(page)).toContainText(ready.restoreRecommendation);
    await expect(goLiveSwitch(page)).toBeEnabled();
    await expect(goLiveSwitch(page)).not.toBeChecked();
    await shot(page, testInfo, `go-live-card-ready${modeSuffix()}`);

    // Turning the switch on opens the dialog; it lists the draft made before going live and names the From address.
    await goLiveSwitch(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d).toContainText(`These drafts will send real email when launched: "${ready.draft.name}" (${ready.draft.people} people).`);
    await expect(d).toContainText(ready.dialogFromItem);
    await expect(d).toContainText(COPY.cantSwitchOff);
    const confirm = d.getByRole("button", { name: COPY.confirm, exact: true });
    await expect(confirm).toBeDisabled();
    await d.getByRole("checkbox", { name: COPY.confirmLabel }).click();
    await expect(confirm).toBeEnabled();
    await expectAccessible(page, "the go-live dialog");
    if (isPhone(testInfo)) {
      // Full screen below 640 px.
      const box = await d.boundingBox();
      const viewport = page.viewportSize()!;
      expect(box, "the dialog's box").not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2);
      expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2);
    }
    await shot(page, testInfo, `go-live-dialog${modeSuffix()}`);

    // Escape closes it without change, and so does Not yet.
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await expect(goLiveSwitch(page)).not.toBeChecked();
    await goLiveSwitch(page).click();
    await expect(d).toBeVisible();
    await expect(d.getByRole("button", { name: COPY.confirm, exact: true })).toBeDisabled();
    await d.getByRole("button", { name: COPY.cancel, exact: true }).click();
    await expect(d).toBeHidden();
    await expect(goLiveSwitch(page)).not.toBeChecked();
    await expect(sendingPill(page, "Sending live")).toHaveCount(0);
  });

  test("going live switches the app to live", async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), "The laptop run goes live (the phone run only looks).");
    await openGoLive(page);
    expect(await alreadyLive(page), "The app is already live: reseed the ready state first.").toBe(false);
    await goLiveSwitch(page).click();
    const d = dialog(page);
    await d.getByRole("checkbox", { name: COPY.confirmLabel }).click();
    await d.getByRole("button", { name: COPY.confirm, exact: true }).click();
    await expect(page.getByText(/^You're live\. /)).toBeVisible({ timeout: 20_000 });
    await expect(d).toBeHidden();
    await expect(sendingPill(page, "Sending live")).toBeVisible();
    await expect(card(page)).toContainText(`Live on ${manifest().sendingDomain} since `);
    await expect(goLiveSwitch(page)).toBeChecked();
    await expect(goLiveSwitch(page)).toBeDisabled();
    await shot(page, testInfo, `go-live-card-live${modeSuffix()}`);
  });

  test("once live, the card says so and can't be switched off", async ({ page }, testInfo) => {
    await openGoLive(page);
    test.skip(!(await alreadyLive(page)), "Not live yet at this point of the run.");
    await expect(card(page)).toContainText(`Live on ${manifest().sendingDomain} since `);
    await expect(card(page)).toContainText(COPY.cantSwitchOff);
    await expect(card(page)).toContainText(/Warm-up step 1 of 20: 50 a day\./);
    // Shared-From mode: the From line under the live line (SHARED-FROM-DESIGN §3.3); none per person.
    const from = manifest().fromAddress;
    if (from) await expect(card(page)).toContainText(GO_LIVE_COPY.liveFromLine(from));
    else await expect(card(page).getByText(/^Emails show From /)).toHaveCount(0);
    await expect(goLiveSwitch(page)).toBeChecked();
    await expect(goLiveSwitch(page)).toBeDisabled();
    await expect(sendingPill(page, "Sending live")).toBeVisible();
    await expectAccessible(page, "the live go-live card");
    await expectNoHorizontalScroll(page, "Settings › Sending & Mailgun after going live");
    await shot(page, testInfo, `go-live-card-after${modeSuffix()}`);
  });
});
