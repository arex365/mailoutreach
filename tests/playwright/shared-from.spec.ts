import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { checklistTitle } from "@/core/dns/checklist";
import { REPLY_TEST_TEAM_TEXTS } from "@/core/reply-test";
import { TEAM_FROM_TEXTS, domainOfAddress, senderAddressWords } from "@/core/sending/from-address";
import { expectAccessible, expectNoHorizontalScroll, isPhone, mainOf, manifest, onlyIn, open, shot, signIn } from "./helpers";

/**
 * The shared From address on the screens (docs/dev/SHARED-FROM-DESIGN.md §3, §8 P6, §9.4), in the ready and live states,
 * which are seeded in shared-From mode (contact@example.com): Settings › Sending & Mailgun's From address card (the
 * address, the risk note, the closed "Good to know" list; on a phone the Save button shows without opening the list;
 * while live, a change asks first in a full-screen dialog, closed here without confirming), the Domain checklist (the
 * header's second line and the main domain's MX row done), the wizard's Sender step (the From line, "Reply address" and
 * the reminder), My profile ("Reply address") and a campaign page ("replies to …" and the reminder). axe on each, and a
 * screenshot in test-results/shots/. Nothing is saved. A ready or live state seeded `--per-person` skips all of it.
 */

type Team = { from: string; org: string; domain: string; ownerReplyTo: string; draftId: number; campaignId: number };

/** The shared-From facts of this run; skips the test when the state was seeded per person. */
function team(): Team {
  const m = manifest();
  // The own state's From address is the own From, not a shared one (MAIN-DOMAIN-DESIGN §9.4): own-mailbox.spec.ts checks it.
  test.skip(m.replies !== "app", "Own-mailbox mode: its screens are checked by own-mailbox.spec.ts.");
  test.skip(!m.fromAddress || !m.sharedFrom, "Seeded --per-person: no shared From address to check.");
  const from = m.fromAddress!;
  return {
    from,
    org: domainOfAddress(from)!,
    domain: m.sendingDomain!,
    ownerReplyTo: m.sharedFrom!.ownerReplyTo,
    draftId: m.sharedFrom!.draft.id,
    campaignId: m.sharedFrom!.campaign.id,
  };
}

/** axe, a screenshot, and no sideways scrolling. */
async function scan(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectAccessible(page, name);
  await shot(page, testInfo, name);
  await expectNoHorizontalScroll(page, name);
}

function fromCard(page: Page): Locator {
  return page.locator("#from-address");
}

test.describe("shared From address", () => {
  onlyIn("ready", "live");

  test("Settings › Sending & Mailgun: the From address card", async ({ page }, testInfo) => {
    const t = team();
    await signIn(page, "owner");
    await open(page, "/settings/sending#from-address");
    const card = fromCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByText(TEAM_FROM_TEXTS.cardTitle, { exact: true })).toBeVisible();
    await expect(card.getByText(TEAM_FROM_TEXTS.cardDescription)).toBeVisible();
    const field = card.getByLabel(TEAM_FROM_TEXTS.fieldLabel);
    await expect(field).toHaveValue(t.from);
    await expect(card).toContainText(TEAM_FROM_TEXTS.riskNote(t.org));

    // "Good to know" is a closed list; the Save button above it shows without opening it (on a phone too).
    const details = card.locator("details");
    await expect(details.locator("summary")).toHaveText(TEAM_FROM_TEXTS.goodToKnowHeading);
    await expect(details).not.toHaveAttribute("open");
    const save = card.getByRole("button", { name: TEAM_FROM_TEXTS.saveButton, exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await expect(save).toBeInViewport();
    const saveBox = await save.boundingBox();
    const detailsBox = await details.boundingBox();
    expect(saveBox && detailsBox && saveBox.y < detailsBox.y, "the Save button comes before Good to know").toBe(true);
    await scan(page, testInfo, "shared-from-card");

    if (manifest().state === "live") {
      // While live, a change asks first (going live would end); "Keep it" closes the dialog and nothing is saved.
      await field.fill(`info@${t.org}`);
      await save.click();
      const confirm = page.getByRole("alertdialog", { name: TEAM_FROM_TEXTS.confirmTitle });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(TEAM_FROM_TEXTS.confirmBody);
      await expect(confirm.getByRole("button", { name: TEAM_FROM_TEXTS.confirmButton, exact: true })).toBeVisible();
      if (isPhone(testInfo)) {
        // Full screen below 640 px (SETTINGS_DIALOG_CLASS).
        // Polled: the dialog zooms in from 95 %, so a box read at once is still slightly small.
        const viewport = page.viewportSize()!;
        await expect.poll(async () => (await confirm.boundingBox())?.width ?? 0, { message: "the dialog's width" }).toBeGreaterThanOrEqual(viewport.width - 2);
        await expect.poll(async () => (await confirm.boundingBox())?.height ?? 0, { message: "the dialog's height" }).toBeGreaterThanOrEqual(viewport.height - 2);
      }
      await expectAccessible(page, "the Change the From address dialog");
      await shot(page, testInfo, "shared-from-confirm");
      await confirm.getByRole("button", { name: TEAM_FROM_TEXTS.cancelButton, exact: true }).click();
      await expect(confirm).toBeHidden();
      await page.reload();
      await expect(fromCard(page).getByLabel(TEAM_FROM_TEXTS.fieldLabel)).toHaveValue(t.from);
    }
  });

  test("the Domain checklist: the header names the From address, and the main domain's MX row is done", async ({ page }, testInfo) => {
    const t = team();
    await signIn(page, "owner");
    await open(page, "/settings/domain");
    await expect(mainOf(page)).toContainText(TEAM_FROM_TEXTS.checklistLine(t.from, t.domain));
    const mx = page.locator('li[data-row="from-mx"]');
    await expect(mx.getByRole("heading", { name: checklistTitle("from-mx", t.org), exact: true })).toBeVisible();
    await expect(mx).toContainText("Done");
    const spf = page.locator('li[data-row="from-spf"]');
    await expect(spf.getByRole("heading", { name: checklistTitle("from-spf", t.org), exact: true })).toBeVisible();
    // The reply test asks the shared-From questions and takes one pasted original (§3.4).
    const replyTest = page.getByRole("region", { name: "Reply test", exact: true });
    await expect(replyTest).toContainText(REPLY_TEST_TEAM_TEXTS.placementQuestion);
    await expect(replyTest.getByRole("heading", { name: REPLY_TEST_TEAM_TEXTS.originalHeading, exact: true })).toBeVisible();
    await expect(replyTest.getByRole("button", { name: REPLY_TEST_TEAM_TEXTS.readOriginalButton, exact: true })).toBeVisible();
    await scan(page, testInfo, "shared-from-domain-checklist");
  });

  test("the wizard's Sender step: the From line, the reply address and the reminder", async ({ page }, testInfo) => {
    const t = team();
    await signIn(page, "owner");
    await open(page, `/campaigns/${t.draftId}/setup/sender`);
    const main = mainOf(page);
    await expect(main).toContainText(`<${t.from}>`);
    await expect(main.getByText(senderAddressWords(true).label, { exact: true }).first()).toBeVisible();
    await expect(main).toContainText(t.ownerReplyTo);
    await expect(main).toContainText(TEAM_FROM_TEXTS.followUpReminder(t.from));
    await expect(main.getByText(senderAddressWords(false).label, { exact: true })).toHaveCount(0);
    await scan(page, testInfo, "shared-from-wizard-sender");
  });

  test("My profile: the address is the reply address", async ({ page }, testInfo) => {
    team();
    await signIn(page, "owner");
    await open(page, "/settings/profile");
    const main = mainOf(page);
    await expect(main.getByText(senderAddressWords(true).label, { exact: true }).first()).toBeVisible();
    await expect(main.getByText(senderAddressWords(false).label, { exact: true })).toHaveCount(0);
    await scan(page, testInfo, "shared-from-profile");
  });

  test("a campaign page: replies to the sender's own address, and the reminder", async ({ page }, testInfo) => {
    const t = team();
    await signIn(page, "owner");
    await open(page, `/campaigns/${t.campaignId}`);
    const main = mainOf(page);
    await expect(main).toContainText(`<${t.from}>, replies to ${t.ownerReplyTo}`);
    await expect(main).toContainText(TEAM_FROM_TEXTS.followUpReminder(t.from));
    await scan(page, testInfo, "shared-from-campaign");
  });
});
