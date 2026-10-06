import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { checklistTitle } from "@/core/dns/checklist";
import { MAILGUN_PLAN_FACTS, PLAN_TEXTS } from "@/core/mailgun/plan";
import { TEAM_FROM_TEXTS, senderAddressWords } from "@/core/sending/from-address";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { CHECKLIST_ROW_TITLES, MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";
import type { OwnFacts } from "./manifest";
import {
  expectAccessible,
  expectAtMostOnePrimary,
  expectNoHorizontalScroll,
  isPhone,
  mainOf,
  manifest,
  onlyIn,
  open,
  region,
  sendingPill,
  shot,
  signIn,
} from "./helpers";

/**
 * Own-mailbox mode on the screens (docs/dev/MAIN-DOMAIN-DESIGN.md §3, §9.4), in the own state only: the app sends through
 * example.com itself (standing for polygonparadise.com) on Mailgun's Free plan, every email From contact@example.com,
 * and the instance has no public address (like the owner's PC). Settings › Sending & Mailgun ("How the app sends" with
 * the own-mailbox choice, "Your Mailgun plan" = Free, the own From card with "Good to know"), the Domain checklist (no
 * "Replies reach the app (MX)", the MX guard and SPF rows done, the https, webhooks and remote-access rows information
 * only, the own-mailbox Apply hint, the by-hand reply test with the unsubscribe-by-email question and no Setup switch),
 * the go-live dialog (its ticks; closed without going live), a company panel's They replied and its confirmation
 * (closed without confirming), a campaign page's reminder and its link to the inbox check, the wizard's Sender step, My
 * profile, the dashboard's inbox-check item and replies tile, and the Notifications page's inbox check card (its button
 * not clicked). axe on each, a screenshot in test-results/shots/, no sideways scrolling. Nothing is saved.
 *
 * The go-live card is ready only while the checklist's check is less than an hour old: reseed own right before this
 * spec (node --import tsx scripts/seed-m6-manual.ts --state own). That is the only reason the go-live test may skip:
 * any other blocker fails it with the card's list, and no own screen may show a pause (review SCREENS-12, SECURITY-01:
 * the fake starts with the tracking settings the seeded Apply run left, `--settings-applied`, so nothing pauses).
 */

/** The own state's facts (seeded by scripts/seed-m6-manual.ts --state own). */
function own(): OwnFacts {
  const m = manifest();
  expect(m.replies, "the own state is seeded in own-mailbox mode").toBe("own-mailbox");
  expect(m.own, "the own state's facts").toBeTruthy();
  return m.own!;
}

/** axe, a screenshot, and no sideways scrolling. */
async function scan(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectAccessible(page, name);
  await shot(page, testInfo, name);
  await expectNoHorizontalScroll(page, name);
}

/** On a phone a dialog opens full screen (SETTINGS_DIALOG_CLASS); polled, because it zooms in from 95 %. */
async function expectFullScreen(page: Page, dialog: Locator, testInfo: TestInfo): Promise<void> {
  if (!isPhone(testInfo)) return;
  const viewport = page.viewportSize()!;
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0, { message: "the dialog's width" }).toBeGreaterThanOrEqual(viewport.width - 2);
  await expect.poll(async () => (await dialog.boundingBox())?.height ?? 0, { message: "the dialog's height" }).toBeGreaterThanOrEqual(viewport.height - 2);
}

function row(page: Page, key: string): Locator {
  return page.locator(`li[data-row="${key}"]`);
}

/** The go-live card's "Before going live:" list, item by item (empty when the card has none). */
async function goLiveBlockers(card: Locator): Promise<string[]> {
  const items = card.locator(`xpath=.//p[normalize-space()="${GO_LIVE_COPY.blockersHeading}"]/following-sibling::ul[1]/li`);
  return (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

/**
 * The owner's normal, unpaused screens (review SCREENS-12): no red pause card, and the top bar says "Test list only"
 * (the own state is live with the test list only, go-live off), never "Paused: …".
 */
async function expectNotPaused(page: Page, where: string): Promise<void> {
  await expect(page.locator("#pause-title"), `${where}: the pause card`).toHaveCount(0);
  await expect(sendingPill(page, "Test list only"), `${where}: the top bar`).toBeVisible();
}

test.describe("own-mailbox mode", () => {
  onlyIn("own");

  test("Settings › Sending & Mailgun: how the app sends, the Free plan, the own From card", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/settings/sending");
    const main = mainOf(page);

    // "How the app sends": From <domain> itself is chosen.
    await expect(main.getByText(OWN_MAILBOX_TEXTS.repliesLegend, { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: OWN_MAILBOX_TEXTS.repliesOwnLabel, exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: OWN_MAILBOX_TEXTS.repliesAppLabel, exact: true })).not.toBeChecked();
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.repliesOwnHint);
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.statusSuffix.trim());

    // Advanced: "Your Mailgun plan" = Free.
    const advanced = main.locator("details").filter({ has: page.locator("summary", { hasText: /^Advanced$/ }) });
    await advanced.locator("summary").click();
    await expect(advanced.getByText(PLAN_TEXTS.planLabel, { exact: true })).toBeVisible();
    await expect(page.locator("#mg-plan")).toContainText(MAILGUN_PLAN_FACTS.free.label);
    await expect(advanced).toContainText(PLAN_TEXTS.retentionHint);

    // The own From card, with its "Good to know" list (closed, then opened).
    const card = page.locator("#from-address");
    await expect(card).toContainText(OWN_MAILBOX_TEXTS.cardDescription);
    await expect(card.getByLabel(OWN_MAILBOX_TEXTS.fieldLabel)).toHaveValue(o.from);
    const details = card.locator("details");
    await expect(details.locator("summary")).toHaveText(TEAM_FROM_TEXTS.goodToKnowHeading);
    await expect(details).not.toHaveAttribute("open");
    await details.locator("summary").click();
    for (const line of OWN_MAILBOX_TEXTS.goodToKnow(o.from, o.domain)) await expect(details).toContainText(line);
    // The page the owner normally sees: nothing paused (review SCREENS-12), so the one orange button is checked there.
    await expectNotPaused(page, "Settings › Sending & Mailgun (own mailbox)");
    await expectAtMostOnePrimary(page, "Settings › Sending & Mailgun (own mailbox)");
    await scan(page, testInfo, "own-sending");
  });

  test("the Domain checklist: the MX guard and SPF done, the info rows, the Apply hint, the reply test by hand", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/settings/domain");
    const main = mainOf(page);
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.checklistLine(o.from, o.domain));
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.applyHint);

    // No "Replies reach the app (MX)": the MX guard for the domain itself instead.
    await expect(row(page, "mx")).toHaveCount(0);
    await expect(main.getByText(CHECKLIST_ROW_TITLES.mx, { exact: true })).toHaveCount(0);
    await expect(main.getByText(checklistTitle("mx", o.domain), { exact: true })).toHaveCount(0);
    for (const key of ["spam-filter", "retention", "reply-routes", "from-spf"]) await expect(row(page, key), key).toHaveCount(0);
    const mx = row(page, "from-mx");
    await expect(mx.getByRole("heading", { name: checklistTitle("from-mx", o.domain), exact: true })).toBeVisible();
    await expect(mx).toContainText("Done");
    const spf = row(page, "spf");
    await expect(spf.getByRole("heading", { name: checklistTitle("spf", o.domain), exact: true })).toBeVisible();
    await expect(spf).toContainText("Done");
    // The Free plan's https links and no public address: information only (grey), never red.
    for (const key of ["https-links", "webhooks", "remote-access"]) await expect(row(page, key), key).toContainText("For your information");

    // The reply test by hand: the reply arrives in the own mailbox, the unsubscribe-by-email question, no Setup switch.
    const replyTest = page.getByRole("region", { name: "Reply test", exact: true });
    await expect(replyTest).toContainText(OWN_REPLY_TEST_TEXTS.replyQuestion(o.from));
    await expect(replyTest).toContainText(OWN_REPLY_TEST_TEXTS.mailtoQuestion(o.mailtoAddress, o.from));
    await expect(replyTest).toContainText(OWN_REPLY_TEST_TEXTS.logsNote);
    for (const name of ["Try Setup B (check only)", "Back to Setup A", OWN_MAILBOX_TEXTS.backToNormal]) {
      await expect(replyTest.getByRole("button", { name, exact: true }), name).toHaveCount(0);
    }
    await expect(replyTest).not.toContainText("Setup A");
    await expectAtMostOnePrimary(page, "Settings › Domain checklist (own mailbox)");
    await scan(page, testInfo, "own-domain-checklist");
  });

  test("going live asks for the ticks about replies and http links (closed without going live)", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/settings/sending#go-live");
    const card = page.locator("#go-live");
    await expect(card).toBeVisible();
    const toggle = card.getByRole("switch", { name: "Go live" });
    // Review SECURITY-01: the two ticks must really be checked on screen. Only a check more than an hour old (the seed
    // ran too long ago) may skip this test; any other blocker (a pause, above all) fails it with the card's own list.
    const blockers = await goLiveBlockers(card);
    const staleOnly = blockers.length === 1 && blockers[0] === MODE_GATE_TEXTS.checkStale;
    test.skip(staleOnly, "The Domain checklist's check is more than an hour old: reseed the own state right before this spec.");
    expect(blockers, "the go-live card must be ready in the own state; it says Before going live:").toEqual([]);
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    const d = page.getByRole("dialog", { name: GO_LIVE_COPY.dialogTitle });
    await expect(d).toBeVisible();
    await expect(d).toContainText(GO_LIVE_COPY.dialogOwnMailboxItem(o.from, o.domain));
    const repliesTick = d.getByRole("checkbox", { name: GO_LIVE_COPY.ownMailboxTick(o.from) });
    const httpTick = d.getByRole("checkbox", { name: GO_LIVE_COPY.httpLinksTick });
    const understood = d.getByRole("checkbox", { name: GO_LIVE_COPY.confirmLabel });
    const go = d.getByRole("button", { name: GO_LIVE_COPY.confirmButton, exact: true });
    await expect(repliesTick).toBeVisible();
    await expect(httpTick).toBeVisible();
    await expect(go).toBeDisabled();
    await expectFullScreen(page, d, testInfo);

    // Each tick is required: Go live says which one is missing (checked in the browser first, and again by the server),
    // and nothing is sent until both are ticked. The run never goes live.
    await understood.click();
    await expect(go).toBeEnabled();
    await go.click();
    await expect(d.getByRole("alert")).toHaveText(GO_LIVE_COPY.ownMailboxRequired);
    await repliesTick.click();
    await go.click();
    await expect(d.getByRole("alert")).toHaveText(GO_LIVE_COPY.httpLinksRequired);
    await httpTick.click();
    await expect(repliesTick).toBeChecked();
    await expect(httpTick).toBeChecked();
    await expectAccessible(page, "the own-mailbox go-live dialog");
    await shot(page, testInfo, "own-go-live-dialog");

    // Not yet: closed, nothing changed.
    await d.getByRole("button", { name: GO_LIVE_COPY.cancelButton, exact: true }).click();
    await expect(d).toBeHidden();
    await expect(toggle).not.toBeChecked();
    await expect(sendingPill(page, "Sending live")).toHaveCount(0);
  });

  test("a company panel: They replied and its confirmation (closed without confirming)", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, `/contacts?company=${o.company.id}`);
    const panel = page.getByRole("dialog").filter({ hasText: o.company.name }).first();
    await expect(panel).toBeVisible();
    // Its accessible name is its visible label (WCAG 2.5.3, review SCREENS-09): "click They replied" by voice works; the
    // explanation is the description.
    const button = panel.getByRole("button", { name: THEY_REPLIED_TEXTS.button, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveText(THEY_REPLIED_TEXTS.button);
    await expect(button).toHaveAccessibleDescription(THEY_REPLIED_TEXTS.ariaLabel);
    await scan(page, testInfo, "own-company-panel");

    await button.click();
    const confirm = page.getByRole("alertdialog", { name: THEY_REPLIED_TEXTS.confirmTitleCompany(o.company.name) });
    await expect(confirm).toBeVisible();
    // Before going live a test company only had test emails: its status stays as it is.
    await expect(confirm).toContainText(THEY_REPLIED_TEXTS.bodyTestOnly(o.company.name));
    await expect(confirm.getByRole("button", { name: THEY_REPLIED_TEXTS.confirm, exact: true })).toBeVisible();
    await expectFullScreen(page, confirm, testInfo);
    await expectAccessible(page, "the They replied confirmation");
    await shot(page, testInfo, "own-they-replied-confirm");
    await confirm.getByRole("button", { name: THEY_REPLIED_TEXTS.cancel, exact: true }).click();
    await expect(confirm).toBeHidden();
  });

  test("a campaign page: sent From the own From, the reminder and the link to the inbox check", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, `/campaigns/${o.campaign.id}`);
    const main = mainOf(page);
    await expect(main).toContainText(o.campaign.name);
    // "Sent by Arslan as Arslan from Polygon Paradise <contact@example.com>", with no ", replies to …".
    await expect(main).toContainText(`<${o.from}>`);
    await expect(main).not.toContainText(`<${o.from}>, replies to`);
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.followUpReminder(o.from));
    const link = main.getByRole("link", { name: OWN_MAILBOX_TEXTS.openInboxCheck, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/notifications#inbox-check");
    await scan(page, testInfo, "own-campaign");
  });

  test("the wizard's Sender step: the From line, no address", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, `/campaigns/${o.draft.id}/setup/sender`);
    const main = mainOf(page);
    await expect(main).toContainText(`<${o.from}>`);
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.senderStepInfo(o.from));
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.followUpReminder(o.from));
    for (const teamFrom of [false, true]) await expect(main.getByText(senderAddressWords(teamFrom).label, { exact: true })).toHaveCount(0);
    await scan(page, testInfo, "own-wizard-sender");
  });

  test("My profile: no address field, the inbox for test emails", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/settings/profile");
    const main = mainOf(page);
    await expect(main.getByLabel(OWN_MAILBOX_TEXTS.testInboxLabel)).toBeVisible();
    await expect(main).toContainText(OWN_MAILBOX_TEXTS.testInboxHint(o.from));
    for (const teamFrom of [false, true]) await expect(main.getByText(senderAddressWords(teamFrom).label, { exact: true })).toHaveCount(0);
    await expect(main).toContainText(`<${o.from}>`);
    await scan(page, testInfo, "own-profile");
  });

  test("the dashboard: the inbox-check item (warning) and the own-mailbox replies tile", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/dashboard");
    const attention = region(page, "Needs your attention");
    await expect(attention).toContainText(INBOX_CHECK_TEXTS.item(o.followUpsDue, o.from));
    await expect(attention.getByRole("link", { name: INBOX_CHECK_TEXTS.itemLink })).toBeVisible();
    // No pause item: the owner's normal dashboard (review SCREENS-12).
    await expect(attention).not.toContainText("Sending is paused");
    await expectNotPaused(page, "the own-mailbox dashboard");
    await expect(region(page, "Replies waiting for an answer")).toContainText(OWN_MAILBOX_TEXTS.repliesEmpty(o.from));
    await expectAtMostOnePrimary(page, "the own-mailbox dashboard");
    await scan(page, testInfo, "own-dashboard");
  });

  test("Notifications: the inbox check card with the companies and its button (not clicked)", async ({ page }, testInfo) => {
    const o = own();
    await signIn(page, "owner");
    await open(page, "/notifications");
    const card = page.locator("#inbox-check");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: INBOX_CHECK_TEXTS.title, exact: true })).toBeVisible();
    await expect(card).toContainText(INBOX_CHECK_TEXTS.intro(o.from));
    await expect(card).toContainText(INBOX_CHECK_TEXTS.waitingHeading);
    for (const c of o.waitingCompanies) await expect(card.getByRole("link", { name: c.name })).toHaveAttribute("href", `/contacts?company=${c.id}`);
    await expect(card).toContainText(INBOX_CHECK_TEXTS.notToday);
    await expect(card.getByRole("button", { name: INBOX_CHECK_TEXTS.button(o.from), exact: true })).toBeVisible();
    await scan(page, testInfo, "own-notifications");
  });
});
