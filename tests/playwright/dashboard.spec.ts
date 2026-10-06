import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { catchUpStatusLine, oldDomainLines } from "@/core/mailgun/catch-up-status";
import { pausedWithReason } from "@/core/sending/label";
import { formatShortDate } from "@/core/time/format";
import {
  NO_ATTENTION_TEXT,
  STATE,
  expectAccessible,
  expectAtMostOnePrimary,
  expectLinksNavigate,
  expectNoHorizontalScroll,
  expectOneColumn,
  expectTabReachesLinks,
  isPhone,
  mainOf,
  manifest,
  onlyIn,
  open,
  region,
  seededAttentionTexts,
  sendingPill,
  shot,
  signIn,
  type Role,
} from "./helpers";

/**
 * The dashboard (M6-DESIGN §4, §9.4 dashboard.spec) in every seeded state: "Get started", "Needs your attention" with
 * its exact sentences (Owner links, "Ask the Owner to fix this." for Members), the viewer's replies waiting for an
 * answer, the tiles and their empty texts; every link works, Tab reaches every link with a focus ring, axe finds
 * nothing, at most one orange button, one column and no sideways scrolling on a phone.
 */

const TEXT = {
  noAttention: NO_ATTENTION_TEXT,
  noReplies: "No replies are waiting for you.",
  noCompanies: "No companies yet. Import a spreadsheet or paste rows from Excel to get started.",
  noMailgun: "Nothing goes through Mailgun yet: new campaigns run as dry runs.",
  nothingToMeasure: "No emails sent through Mailgun yet, so there's nothing to measure.",
  noCampaigns: "No campaigns are sending right now.",
  noActivity: "Nothing yet. Changes you and your team make will show here.",
  askOwner: "Ask the Owner to fix this.",
  workerNeverSeen: "The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.",
  backupNever: "No backup has been made yet. Click Back up now in Settings › Backups.",
} as const;

/** The tiles every state shows (the dry-run tile only when it has numbers). */
const TILES = ["Companies", "Today", "Active campaigns", "Domain health", "Recent team activity"] as const;

/** "Get started": a section with that heading, or the card titled so. */
function getStarted(page: Page): Locator {
  return region(page, "Get started")
    .or(mainOf(page).locator('[data-slot="card"]').filter({ has: page.getByText("Get started", { exact: true }) }))
    .first();
}

/** The checks every dashboard gets: title and description, the tiles, one orange button at most, axe, phone layout. */
async function commonChecks(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
  await expect(mainOf(page)).toContainText("What needs your attention first, then how sending is going.");
  await expect(page).toHaveTitle(/^Dashboard/);
  await expect(region(page, "Needs your attention")).toBeVisible();
  await expect(region(page, "Replies waiting for an answer")).toBeVisible();
  for (const tile of TILES) await expect(region(page, tile), `the ${tile} tile`).toBeVisible();
  await expectAtMostOnePrimary(page, name);
  await expectAccessible(page, name);
  await expectNoHorizontalScroll(page, name);
  if (isPhone(testInfo)) {
    await expectOneColumn(page, [region(page, "Needs your attention"), region(page, "Replies waiting for an answer"), ...TILES.map((t) => region(page, t))], name);
  }
  await shot(page, testInfo, name);
}

/**
 * The empty state's attention list: exactly one item, `backup-never`. The seed makes no backup, so Settings › Backups
 * can say "No backup has been made yet." (§9.4), and the dashboard says the same (§4.2 item 11); a machine with an
 * almost full disk adds `disk-low`, which is left out here.
 */
async function expectOnlyBackupNever(page: Page): Promise<void> {
  const items = await seededAttentionTexts(page);
  expect(items, `attention items: ${JSON.stringify(items)}`).toHaveLength(1);
  expect(items[0]).toContain(TEXT.backupNever);
}

/** The sentences the busy state's attention list shows this viewer (§4.2, §9.4 "Busy keys"), in display order. */
function busyAttention(viewer: Role): string[] {
  const m = manifest();
  const b = m.busy!;
  const me = viewer === "owner" ? m.users.owner : m.users.member;
  const other = viewer === "owner" ? m.users.member : m.users.owner;
  const mine = viewer === "owner" ? b.waiting.owner : b.waiting.member;
  const theirs = viewer === "owner" ? b.waiting.member : b.waiting.owner;
  const zone = me.timeZone;
  const now = new Date();
  return [
    `${pausedWithReason("Sending is paused", b.pause.reason)}.`,
    TEXT.workerNeverSeen,
    `Replies waiting for an answer: You ${mine} · ${other.name} ${theirs}`,
    `${b.aiLinesWaiting} AI lines to review`,
    ...b.pausedCampaigns.map((c) => `“${c.name}” is paused.`),
    `${b.unconfirmed} emails need a decision: the app isn't sure they were sent. Choose Retry or Skip.`,
    `${b.missingEmails} companies have no email address.`,
    `The last backup is from ${formatShortDate(b.newestBackup.at, zone, now)}, more than 36 hours ago. Check that the office PC and the background sender are on, or click Back up now.`,
    `The last backup couldn't be copied to the second folder (${b.secondFolder}). Check that the drive is plugged in. For a folder on this PC, run install-services.bat on the office PC, then click Back up now.`,
    catchUpStatusLine(b.catchUp, zone, now).line,
    ...oldDomainLines(b.catchUp, zone, now),
    b.checksPauseText,
    b.aiPauseText,
  ];
}

test.describe("empty", () => {
  onlyIn("empty");

  test("Owner: five steps to get started and every tile's empty text", async ({ page }, testInfo) => {
    await signIn(page, "owner");
    await open(page, "/dashboard");
    const steps = getStarted(page);
    await expect(steps).toBeVisible();
    await expect(steps.getByRole("listitem")).toHaveCount(5);
    for (const title of ["Import companies", "Connect Mailgun", "Protect your data", "Go live"]) await expect(steps).toContainText(title);
    await expect(steps).toContainText(/Invite your team|Team invited/);

    await expectOnlyBackupNever(page);
    await expect(region(page, "Replies waiting for an answer")).toContainText(TEXT.noReplies);
    await expect(region(page, "Companies")).toContainText(TEXT.noCompanies);
    await expect(region(page, "Companies").getByRole("link", { name: "Import companies" })).toBeVisible();
    await expect(region(page, "Today")).toContainText(TEXT.noMailgun);
    await expect(region(page, "Today").getByRole("link", { name: "Connect Mailgun" })).toBeVisible();
    await expect(region(page, "Domain health")).toContainText(TEXT.nothingToMeasure);
    await expect(region(page, "Active campaigns")).toContainText(TEXT.noCampaigns);
    await expect(region(page, "Recent team activity")).toContainText(TEXT.noActivity);
    await expect(region(page, "Dry runs and test mode")).toHaveCount(0);
    await commonChecks(page, testInfo, "dashboard-owner");
  });

  test("Member: two steps, and no Owner links", async ({ page }, testInfo) => {
    await signIn(page, "member");
    await open(page, "/dashboard");
    const steps = getStarted(page);
    await expect(steps.getByRole("listitem")).toHaveCount(2);
    await expect(steps).toContainText("Import companies");
    await expect(steps).toContainText("Connect Mailgun");
    // The Member's Mailgun step is muted: only the Owner can connect Mailgun.
    await expect(steps.getByRole("link", { name: /Connect Mailgun/ })).toHaveCount(0);
    await expectOnlyBackupNever(page);
    await expect(region(page, "Replies waiting for an answer")).toContainText(TEXT.noReplies);
    await expect(region(page, "Today")).toContainText(TEXT.noMailgun);
    await expect(region(page, "Today").getByRole("link", { name: "Connect Mailgun" })).toHaveCount(0);
    await expect(region(page, "Recent team activity")).toContainText(TEXT.noActivity);
    await commonChecks(page, testInfo, "dashboard-member");
  });
});

test.describe("busy", () => {
  onlyIn("busy");

  test("Owner: every attention item, the replies list and the dry-run tile", async ({ page }, testInfo) => {
    await signIn(page, "owner");
    await open(page, "/dashboard");
    const attention = region(page, "Needs your attention");
    const expected = busyAttention("owner");
    for (const text of expected) await expect(attention, `the item "${text}"`).toContainText(text);
    expect(await seededAttentionTexts(page)).toHaveLength(expected.length);
    await expect(attention.getByRole("link", { name: "Open Sending & Mailgun" }).first()).toBeVisible();
    await expect(attention).not.toContainText(TEXT.askOwner);

    const replies = region(page, "Replies waiting for an answer");
    await expect(replies.getByRole("button", { name: "Answered", exact: true })).toHaveCount(manifest().busy!.waiting.owner);

    const dryRun = region(page, "Dry runs and test mode");
    await expect(dryRun).toContainText(/Dry run today: .*1 campaign running/);
    await expect(dryRun).toContainText(`Dry-run replies waiting: ${manifest().busy!.waiting.dryRun}`);
    await commonChecks(page, testInfo, "dashboard-owner");
  });

  test("Member: the same items with Member wording", async ({ page }, testInfo) => {
    await signIn(page, "member");
    await open(page, "/dashboard");
    const attention = region(page, "Needs your attention");
    const expected = busyAttention("member");
    for (const text of expected) await expect(attention, `the item "${text}"`).toContainText(text);
    await expect(attention).toContainText(TEXT.askOwner);
    await expect(attention.getByRole("link", { name: "Open Sending & Mailgun" })).toHaveCount(0);
    await commonChecks(page, testInfo, "dashboard-member");
  });
});

test.describe("live", () => {
  onlyIn("live");

  test("Owner: sending live, the warm-up line, health numbers and campaign progress", async ({ page }, testInfo) => {
    const live = manifest().live!;
    await signIn(page, "owner");
    await open(page, "/dashboard");
    await expect(sendingPill(page, "Sending live")).toBeVisible();
    await expect(region(page, "Today")).toContainText(`Warm-up step ${live.warmupStep + 1} of 20: ${live.warmupCap} a day.`);
    await expect(region(page, "Domain health")).toContainText(/\d[\d,]* of (the last [\d,]+ emails|1 email so far) bounced/);
    expect(await region(page, "Active campaigns").getByRole("progressbar").count()).toBeGreaterThanOrEqual(2);
    for (const c of live.campaigns) await expect(region(page, "Active campaigns")).toContainText(c.name);
    await expect(getStarted(page)).toHaveCount(0);
    await expect(region(page, "Dry runs and test mode")).toContainText("Dry run today:");
    await commonChecks(page, testInfo, "dashboard-owner");
  });

  test("Member: nothing needs attention", async ({ page }, testInfo) => {
    await signIn(page, "member");
    await open(page, "/dashboard");
    await expect(sendingPill(page, "Sending live")).toBeVisible();
    expect(await seededAttentionTexts(page)).toEqual([]);
    // With nothing else to say, the list shows its empty text (unless the test machine's disk is almost full).
    if ((await region(page, "Needs your attention").getByRole("listitem").filter({ hasNotText: TEXT.noAttention }).count()) === 0) {
      await expect(region(page, "Needs your attention")).toContainText(TEXT.noAttention);
    }
    await expect(getStarted(page)).toHaveCount(0);
    await commonChecks(page, testInfo, "dashboard-member");
  });
});

// Every state, the own one included (MAIN-DOMAIN-DESIGN §9.4: its dashboard's own items are checked by
// own-mailbox.spec.ts; the links and the keyboard are the same rules everywhere).
test.describe("links and keyboard", () => {
  test("every link on the Owner's dashboard opens a working page", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, "owner");
    await open(page, "/dashboard");
    await expectLinksNavigate(page, mainOf(page), "owner");
  });

  test("every link on the Member's dashboard opens a page the Member may see", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, "member");
    await open(page, "/dashboard");
    await expectLinksNavigate(page, mainOf(page), "member");
  });

  test("Tab reaches every link in order, with a visible focus ring", async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), "Keyboard checks run at laptop width.");
    test.setTimeout(90_000);
    await signIn(page, "owner");
    await open(page, "/dashboard");
    await expectTabReachesLinks(page, mainOf(page), `the ${STATE} dashboard`);
  });
});
