import { describe, expect, it } from "vitest";
import { GO_LIVE_COPY, goLiveWarmupItem } from "@/core/sending/go-live-copy";
import { CHECKLIST_ROW_TITLES, GO_LIVE_RECOMMENDATION_TEXTS, GO_LIVE_ROW_KEYS, MODE_GATE_TEXTS, goLiveRowKeys } from "@/core/sending/mode-gates";
import { ACCESS_OFF_TEXT, APPLY_STEP_TEXTS, applyStepStatus, checklistTitle } from "@/core/dns/checklist";
import { ATTENTION_TEXTS } from "@/core/dashboard/attention";
import { DEFAULT_WARMUP_TABLE } from "@/core/sending/caps";
import { warmupLine } from "@/core/sending/warmup-line";
import { TEAM_FROM_TEXTS, senderAddressWords } from "@/core/sending/from-address";
import { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";
import { MAILGUN_PLAN_FACTS, PLAN_TEXTS } from "@/core/mailgun/plan";
import { REPLY_TEST_TEAM_TEXTS, REPLY_TEST_TEXTS, testOriginalTexts } from "@/core/reply-test";
import { SENDING_DOMAIN_TEXTS } from "@/core/sender-address";
import { DASHBOARD_TEXTS } from "@/components/dashboard/texts";
import { MODE_OPTION_TEXTS, MODE_OPTION_TEXTS_AFTER_GO_LIVE, liveConfirmText } from "@/components/settings/sending/texts";
import { OWNER_DOCS, readRel } from "./markdown";

/**
 * The owner's docs quote the screens (M6-DESIGN §6, "every quoted label is copied from §2–§5 or from src/"). This test
 * keeps the most important quotes tied to the code that shows them: the settings pages the docs send the owner to, the
 * go-live card and dialog, the go-live checklist rows, the Live confirmation, the Access switch, and the team, backup,
 * wizard and top-bar labels. When a screen's words change, this test names the doc that has to change with them.
 *
 * The shared From address (SHARED-FROM-DESIGN §6): the docs use the owner's real names (From contact@polygonparadise.com,
 * sent through mail.polygonparadise.com), so their quotes are the app's sentences filled in with those names: the From
 * address card, the two new checklist rows (titled with the From domain, as the screen shows them), the reply test's new
 * questions and the pasted original, the words "Reply address", the sending-domain refusals and the go-live dialog's
 * From line. Guide 2 never asks for an MX or SPF record at "@", for Automatic Sender Security or for the EU region.
 */

const DOCS = Object.fromEntries(OWNER_DOCS.map((rel) => [rel, readRel(rel)])) as Record<(typeof OWNER_DOCS)[number], string>;
const README = DOCS["README.md"];
const INSTALL = DOCS["docs/setup/1-install.md"];
const MAILGUN = DOCS["docs/setup/2-mailgun-and-dns.md"];
const OWN = DOCS["docs/setup/2-own-mailbox.md"];
const CLOUDFLARE = DOCS["docs/setup/3-cloudflare.md"];
const GO_LIVE = DOCS["docs/setup/4-going-live.md"];

/** JSX text as it reads on screen. */
function screenText(source: string): string {
  return source.replace(/&apos;/g, "'").replace(/&ldquo;|&rdquo;|&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The settings pages, by their labels in the settings menu (src/components/settings/settings-nav.tsx). */
function settingsPages(): string[] {
  const nav = readRel("src/components/settings/settings-nav.tsx");
  return [...nav.matchAll(/href: "\/settings\/[a-z-]+", label: "([^"]+)"/g)].map((m) => m[1]!);
}

describe("settings paths in the docs", () => {
  const pages = settingsPages();

  it("reads the eleven settings pages from the menu", () => {
    expect(pages).toEqual([
      "My profile",
      "Notifications",
      "Backups",
      "Sending & Mailgun",
      "Domain checklist",
      "Limits & warm-up",
      "Deliverability",
      "Email footer",
      "AI",
      "Team",
      "System",
    ]);
  });

  it.each(OWNER_DOCS.map((rel) => [rel]))("%s: every \"Settings › …\" names a real settings page", (rel) => {
    const text = DOCS[rel as (typeof OWNER_DOCS)[number]];
    const wrong: string[] = [];
    for (const m of text.matchAll(/Settings › ([^\n]+)/g)) {
      const after = m[1]!;
      // Windows' own Settings app (Install guide, step 7) is the one other "Settings" the docs name.
      if (after.startsWith("Windows Update")) continue;
      if (!pages.some((p) => after.startsWith(p))) wrong.push(`Settings › ${after.slice(0, 40)}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("the go-live words (Going-live guide, step 8; Settings › Sending & Mailgun)", () => {
  it("quotes the Go live dialog word for word", () => {
    expect(GO_LIVE).toContain(`**${GO_LIVE_COPY.dialogTitle}**`);
    for (const item of GO_LIVE_COPY.dialogItems) expect(GO_LIVE, item).toContain(`"${item}"`);
    expect(GO_LIVE).toContain(`**${GO_LIVE_COPY.confirmLabel}**`);
    expect(GO_LIVE).toContain(`click **${GO_LIVE_COPY.confirmButton}**`);
    expect(GO_LIVE).toContain(`**${GO_LIVE_COPY.cancelButton}**`);
    expect(GO_LIVE).toContain(GO_LIVE_COPY.toast);
    expect(GO_LIVE).toContain(`"${GO_LIVE_COPY.notificationTitle}"`);
    expect(GO_LIVE).toContain(GO_LIVE_COPY.blockersHeading);
    expect(GO_LIVE).toContain(GO_LIVE_COPY.recommendationsHeading);
  });

  it("lists the rows going live needs, in the checklist's order and words", () => {
    const step2 = GO_LIVE.slice(GO_LIVE.indexOf("## 2."), GO_LIVE.indexOf("## 3."));
    const listed = [...step2.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
    expect(listed).toEqual(GO_LIVE_ROW_KEYS.map((k) => CHECKLIST_ROW_TITLES[k]));
  });

  it("quotes the live-test blocker the rehearsal waits for", () => {
    expect(GO_LIVE).toContain(MODE_GATE_TEXTS.liveTestSent);
  });

  it("the Cloudflare guide quotes the Access-off row and the go-live reminder", () => {
    expect(CLOUDFLARE).toContain(ACCESS_OFF_TEXT);
    expect(CLOUDFLARE).toContain(GO_LIVE_RECOMMENDATION_TEXTS.accessOff);
  });

  it("the Mailgun guide quotes the Live confirmation before going live, and the mode's names", () => {
    expect(MAILGUN).toContain(`"${liveConfirmText(["…"])}"`);
    expect(MAILGUN).toContain(`**${MODE_OPTION_TEXTS.LIVE.title}**`);
    expect(MAILGUN).toContain(`called just **${MODE_OPTION_TEXTS_AFTER_GO_LIVE.LIVE.title}**`);
  });
});

describe("the dashboard's words (README \"The dashboard\"; Going-live guide, steps 4, 9, 10 and 11)", () => {
  it("names the dashboard's sections and tiles as the screen does", () => {
    const headings = [
      DASHBOARD_TEXTS.getStarted.heading,
      ATTENTION_TEXTS.heading,
      DASHBOARD_TEXTS.replies.heading,
      DASHBOARD_TEXTS.companies.heading,
      DASHBOARD_TEXTS.today.heading,
      DASHBOARD_TEXTS.campaigns.heading,
      DASHBOARD_TEXTS.health.heading,
      DASHBOARD_TEXTS.activity.heading,
      DASHBOARD_TEXTS.dryRun.heading,
    ];
    for (const heading of headings) expect(README, heading).toContain(`**${heading}**`);
    for (const heading of [ATTENTION_TEXTS.heading, DASHBOARD_TEXTS.replies.heading, DASHBOARD_TEXTS.today.heading, DASHBOARD_TEXTS.health.heading]) {
      expect(GO_LIVE, heading).toContain(`**${heading}**`);
    }
    expect(GO_LIVE).toContain(`**${DASHBOARD_TEXTS.dryRun.heading}**`);
  });

  it("quotes the attention list's fixed sentences", () => {
    expect(README).toContain(`"${ATTENTION_TEXTS.empty}"`);
    expect(README).toContain(`"${ATTENTION_TEXTS.askOwner}"`);
    expect(README).toContain("No backup has been made yet");
    expect(ATTENTION_TEXTS.backupNever).toMatch(/^No backup has been made yet\./);
    // The copy-failed item and README "Warnings" give the same two fixes (review SCREENS-03).
    const copyFailed = ATTENTION_TEXTS.backupCopyFailed("D:\\Backups");
    expect(copyFailed).toContain("The last backup couldn't be copied to the second folder");
    expect(copyFailed).toContain("Check that the drive is plugged in. For a folder on this PC, run install-services.bat on the office PC, then click Back up now.");
    expect(README).toContain("**The last backup couldn't be copied to the second folder**: check that the drive is plugged in.");
    expect(README).toContain("double-click `install-services.bat` on the office PC, then click **Back up now**.");
  });

  it("quotes the warm-up line in both of its forms (Going-live guide, step 9)", () => {
    // Step 9 of the standard table: 177 a day, 207 next.
    const goesUp = warmupLine(8, DEFAULT_WARMUP_TABLE, null);
    expect(GO_LIVE).toContain(`"${goesUp}"`);
    const qualifying = warmupLine(8, DEFAULT_WARMUP_TABLE, { sendingDay: true, used: 100, cap: 177, minUsePercent: 50, healthy: true });
    expect(GO_LIVE).toContain(qualifying.slice(qualifying.indexOf("Tomorrow")));
  });
});

/** A quote the docs make, and the source file whose screen shows it. */
const QUOTES: ReadonlyArray<{ quote: string; source: string; docs: string[] }> = [
  // The Access switch (Settings › System), G7.
  { quote: "We don't use Cloudflare Access", source: "src/components/settings/access-off-switch.tsx", docs: [README, CLOUDFLARE] },
  { quote: "Turn off the Access check?", source: "src/components/settings/access-off-switch.tsx", docs: [CLOUDFLARE] },
  { quote: "Turn it off", source: "src/components/settings/access-off-switch.tsx", docs: [CLOUDFLARE] },
  // Settings › Team and My profile.
  { quote: "Invite a teammate", source: "src/components/settings/team-text.ts", docs: [README] },
  { quote: "Create invite link", source: "src/components/settings/team-manager.tsx", docs: [README] },
  { quote: "New invite link", source: "src/components/settings/team-manager.tsx", docs: [README] },
  { quote: "Reset password link", source: "src/components/settings/team-manager.tsx", docs: [README, INSTALL] },
  { quote: "Make Owner", source: "src/components/settings/team-manager.tsx", docs: [README] },
  { quote: "Switch back on", source: "src/components/settings/team-manager.tsx", docs: [README] },
  { quote: "Save profile", source: "src/components/settings/profile-form.tsx", docs: [README, OWN] },
  { quote: "Reply route: Being set up…", source: "src/app/(app)/settings/profile/page.tsx", docs: [README] },
  // Settings › Backups and restore.bat.
  { quote: "Second folder", source: "src/app/(app)/settings/backups/second-folder-form.tsx", docs: [README, GO_LIVE] },
  { quote: "Save folder", source: "src/app/(app)/settings/backups/second-folder-form.tsx", docs: [README, GO_LIVE] },
  { quote: "Stop copying", source: "src/app/(app)/settings/backups/second-folder-form.tsx", docs: [README] },
  { quote: "Last restore", source: "src/app/(app)/settings/backups/page.tsx", docs: [README, GO_LIVE] },
  { quote: "Daily backup", source: "src/server/services/backups.ts", docs: [README, INSTALL] },
  { quote: "Before a database upgrade", source: "src/server/services/backups.ts", docs: [README, INSTALL] },
  { quote: "Before a restore", source: "src/server/services/backups.ts", docs: [README, INSTALL, GO_LIVE] },
  { quote: "Before an update", source: "src/server/services/backups.ts", docs: [README, INSTALL] },
  {
    quote: "Open the app: sending stays paused while it checks Mailgun for emails sent after the backup (about 35",
    source: "src/app/(app)/settings/backups/page.tsx",
    docs: [README],
  },
  {
    quote: "This backup comes from another database (expected when moving to a new PC). Type yes to go on:",
    source: "scripts/restore.mjs",
    docs: [README],
  },
  { quote: "The last backup is more than 36 hours old", source: "src/app/(app)/settings/backups/load.ts", docs: [README] },
  { quote: "No backup has been made yet", source: "src/app/(app)/settings/backups/load.ts", docs: [README] },
  // The Saved backups table's "Second copy" column (README "The second copy", Going-live guide, step 5; SCREENS-03).
  { quote: "Second copy", source: "src/app/(app)/settings/backups/page.tsx", docs: [README, GO_LIVE] },
  { quote: "Not copied", source: "src/app/(app)/settings/backups/load.ts", docs: [README, GO_LIVE] },
  { quote: "Copied", source: "src/app/(app)/settings/backups/load.ts", docs: [README, GO_LIVE, INSTALL] },
  // The Last restore card while the second check runs, and after it (Going-live guide, step 8; SCREENS-09).
  { quote: "Restored on", source: "src/server/services/sending/restore.ts", docs: [GO_LIVE] },
  {
    quote: "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore.",
    source: "src/core/sending/restore-report.ts",
    docs: [GO_LIVE],
  },
  {
    quote: "Sending was resumed while the check is still running; emails through Mailgun wait until it finishes.",
    source: "src/server/services/sending/restore.ts",
    docs: [GO_LIVE],
  },
  { quote: "Checked Mailgun for sends after the backup", source: "src/core/sending/restore-report.ts", docs: [GO_LIVE] },
  { quote: "Sending was resumed", source: "src/server/services/sending/restore.ts", docs: [GO_LIVE] },
  // restore.bat's "Please check" lines (README "Moving to a new PC", step 4; SCREENS-02).
  { quote: "From:", source: "scripts/restore.mjs", docs: [README] },
  // Limits & warm-up, the wizard, Contacts and the top bar.
  { quote: "The 30-day rule", source: "src/components/settings/limits/rules-text.ts", docs: [README, GO_LIVE] },
  { quote: "Change today's limit", source: "src/components/settings/limits/today-cap-form.tsx", docs: [GO_LIVE] },
  // The warm-up sentences follow the Owner's own settings (Going-live guide, step 9; review SCREENS-10).
  { quote: "Rises after using (%)", source: "src/components/settings/limits/limits-form.tsx", docs: [GO_LIVE] },
  { quote: "sending day", source: "src/core/sending/warmup-line.ts", docs: [GO_LIVE] },
  { quote: "% of the limit used", source: "src/core/sending/warmup-line.ts", docs: [GO_LIVE] },
  { quote: "Per-sender limits", source: "src/app/(app)/settings/limits/page.tsx", docs: [README, GO_LIVE] },
  { quote: "This draft was made before you went live. It now sends real email to", source: "src/components/campaign-wizard/format.ts", docs: [GO_LIVE] },
  { quote: "Test emails before going live don't count as emailed.", source: "src/components/contacts/format.ts", docs: [README, GO_LIVE] },
  { quote: "Status unavailable", source: "src/components/shell/sending-pill.tsx", docs: [README] },
  { quote: "Sending live", source: "src/core/sending/label.ts", docs: [README, GO_LIVE] },
  { quote: "Test list only", source: "src/core/sending/label.ts", docs: [README, MAILGUN, OWN] },
  { quote: "Save model", source: "src/components/settings/ai/ai-model-form.tsx", docs: [GO_LIVE] },
  { quote: "Continue follow-ups", source: "src/components/settings/sending/check-with-mailgun.tsx", docs: [README, GO_LIVE] },
  // The shared From address (SHARED-FROM-DESIGN §2.4, §3.2, §3.4, §3.7, §3.8).
  {
    quote: "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost.",
    source: "src/components/campaigns/format.ts",
    docs: [README, MAILGUN],
  },
  {
    quote:
      "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then click Resume.",
    source: "src/server/services/sending/mailgun-transport.ts",
    docs: [MAILGUN],
  },
  {
    quote:
      "If this started after the From address was set, remove the domain sending key (Settings › Sending & Mailgun › Advanced › Remove the sending key) and click Resume: the API key sends then.",
    source: "src/server/services/sending/mailgun-transport.ts",
    docs: [MAILGUN],
  },
  // The button that pause sentence names (review SCREENS-01).
  { quote: "Remove the sending key", source: "src/components/settings/sending/connection-form.tsx", docs: [MAILGUN] },
  {
    quote: "The domain sending key is removed. Emails now go out with the API key. If sending is paused, click Resume sending.",
    source: "src/server/services/mailgun/connect.ts",
    docs: [MAILGUN],
  },
  { quote: "(1024-bit; it works, 2048-bit is stronger)", source: "src/core/dns/checklist.ts", docs: [MAILGUN] },
  {
    quote: "You changed the From address. Live campaigns only reach your test list until you run the reply test and go live again.",
    source: "src/core/dashboard/attention.ts",
    docs: [GO_LIVE],
  },
  { quote: "Send test emails to my test list", source: "src/components/settings/domain/reply-test-section.tsx", docs: [MAILGUN, OWN] },
  { quote: "Save the result", source: "src/components/settings/domain/reply-test-section.tsx", docs: [MAILGUN, OWN] },
  { quote: "Reply reached the app", source: "src/components/settings/domain/reply-test-section.tsx", docs: [MAILGUN] },
  { quote: "Sender display name", source: "src/components/settings/profile-form.tsx", docs: [README, MAILGUN, OWN] },
  // The own-mailbox setup (MAIN-DOMAIN-DESIGN §3, §6): the screens the own-mailbox guide, the README and guides 2–4 quote.
  { quote: "Unsubscribe reached the app", source: "src/components/settings/domain/reply-test-section.tsx", docs: [MAILGUN, OWN] },
  { quote: "Check with Mailgun now", source: "src/components/settings/sending/check-with-mailgun.tsx", docs: [MAILGUN, OWN] },
  { quote: "Save and connect", source: "src/components/settings/sending/connection-form.tsx", docs: [MAILGUN, OWN] },
  { quote: "Save these numbers", source: "src/components/settings/sending/connection-form.tsx", docs: [MAILGUN, OWN] },
  { quote: "Mark unsubscribed", source: "src/components/company-panel/people-section.tsx", docs: [README, OWN, GO_LIVE] },
  { quote: "Person in this campaign", source: "src/app/(app)/campaigns/[id]/page.tsx", docs: [OWN, GO_LIVE] },
  {
    quote: "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here.",
    source: "src/server/mailgun/errors.ts",
    docs: [MAILGUN, OWN],
  },
  { quote: "Couldn't reach Mailgun. Check this PC's internet connection and try again.", source: "src/server/mailgun/errors.ts", docs: [MAILGUN, OWN] },
  {
    // Apply's certificate step; its words live with the card's step words since review DOMAIN-3 (APPLY_STEP_TEXTS).
    quote: "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.",
    source: "src/core/dns/checklist.ts",
    docs: [MAILGUN, OWN],
  },
  { quote: "Waiting for today's inbox check (Notifications › Inbox check).", source: "src/components/campaigns/format.ts", docs: [README, OWN, GO_LIVE] },
  {
    quote: "Waiting: your Mailgun plan's daily limit is used up. The next email can go at",
    source: "src/components/campaigns/format.ts",
    docs: [README, OWN],
  },
  // Own-mailbox mode's waiting line (review SCREENS-11, DOMAIN-8: nothing is forwarded, and Cloudflare Email Routing is red too).
  {
    quote: "Waiting: mail for your domain doesn't go to your mail provider (it points to Mailgun or Cloudflare Email Routing, or is missing)",
    source: "src/components/campaigns/format.ts",
    docs: [OWN],
  },
  { quote: "Policy found: monitor only. Right for now.", source: "src/core/dns/checklist.ts", docs: [OWN] },
  {
    quote:
      "Your Mailgun plan doesn't include secure (https) unsubscribe links, so they use http. They still work when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https, so it may not show. That is required only above 5,000 emails a day to Gmail.",
    source: "src/core/dns/checklist.ts",
    docs: [OWN],
  },
  {
    quote: "No public address yet, so Mailgun can't tell the app at once. The app reads Mailgun's logs every hour instead, while the background sender runs.",
    source: "src/core/dns/checklist.ts",
    docs: [OWN],
  },
  { quote: "Remote access isn't set up: the app works on this PC and your office network only.", source: "src/core/dns/checklist.ts", docs: [OWN] },
  // The reply test's own-mailbox question about the headers (review SCREENS-04) is checked with the own guide below.
  { quote: "is already in use", source: "scripts/lib/supervisor.mjs", docs: [README, OWN] },
];

describe("quoted labels exist in the app", () => {
  it.each(QUOTES.map((q) => [q.quote, q]))('"%s"', (_label, q) => {
    expect(screenText(readRel(q.source)), q.source).toContain(q.quote);
    for (const doc of q.docs) {
      const name = OWNER_DOCS.find((rel) => DOCS[rel] === doc)!;
      expect(doc, name).toContain(q.quote);
    }
  });
});

// ── The shared From address (SHARED-FROM-DESIGN §6) ──

/** The owner's real names, which the docs use throughout (SHARED-FROM-DESIGN §6). */
const ORG = "polygonparadise.com";
const D = "mail.polygonparadise.com";
const FROM = "contact@polygonparadise.com";
const OWNER_NAME = "Arslan from Polygon Paradise";
const OWNER_ADDRESS = "arslan@mail.polygonparadise.com";

/**
 * A sentence the app builds with a template literal: the literal in `source` whose text starts with `start` (right after
 * its opening backtick), with every `${…}` filled in from `values` by its expression. It ties a doc's quote to the
 * source file without importing server code into this test; a template that changes shape fails here by name.
 */
function filledTemplate(source: string, start: string, values: Record<string, string>): string {
  const text = readRel(source);
  const at = text.indexOf("`" + start);
  if (at < 0) throw new Error(`${source} has no template literal starting with "${start}"`);
  const end = text.indexOf("`", at + 1);
  return text
    .slice(at + 1, end)
    .replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
      const value = values[expr.trim()];
      if (value === undefined) throw new Error(`${source}: no value for the expression ${expr.trim()}`);
      return value;
    })
    .trim();
}

/** The text of one guide step, from "## N." up to the next "## ". */
function stepOf(doc: string, n: number): string {
  const start = doc.indexOf(`\n## ${n}. `);
  expect(start, `step ${n}`).toBeGreaterThan(-1);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

describe("the shared From address in the docs (SHARED-FROM-DESIGN §6)", () => {
  const fromMxTitle = checklistTitle("from-mx", ORG);
  const fromSpfTitle = checklistTitle("from-spf", ORG);

  it("names the two new checklist rows by the titles the screen shows, with the From domain", () => {
    expect(fromMxTitle).toBe("Mail for polygonparadise.com stays with your mail provider (MX)");
    expect(fromSpfTitle).toBe("polygonparadise.com's SPF record (your everyday email)");
    for (const [name, doc] of [
      ["README", README],
      ["Mailgun guide", MAILGUN],
      ["Own-mailbox guide", OWN],
      ["Cloudflare guide", CLOUDFLARE],
      ["Going-live guide", GO_LIVE],
    ] as const) {
      expect(doc, name).toContain(fromMxTitle);
      // Never titled with the sending domain (critique C2-7), and never the generic never-checked title.
      expect(doc, name).not.toContain(checklistTitle("from-mx", D));
      expect(doc, name).not.toContain(checklistTitle("from-spf", D));
      expect(doc, name).not.toContain(CHECKLIST_ROW_TITLES["from-mx"]);
    }
    for (const doc of [MAILGUN, CLOUDFLARE, GO_LIVE]) expect(doc).toContain(fromSpfTitle);
    expect(MAILGUN).toContain(checklistTitle("spf", D));
    expect(CLOUDFLARE).toContain(`"${CHECKLIST_ROW_TITLES.dkim}"`);
  });

  it("guide 4 adds the from-mx row to going live in an un-numbered sentence after the pinned list", () => {
    // In shared-From mode going live needs exactly one row more than the pinned list of step 2.
    expect(goLiveRowKeys(true).filter((k) => !GO_LIVE_ROW_KEYS.includes(k))).toEqual(["from-mx"]);
    const step2 = stepOf(GO_LIVE, 2);
    const line = step2.split(/\r?\n/).find((l) => l.includes(`**${fromMxTitle}**`));
    expect(line).toBeDefined();
    expect(line!).toMatch(/^With a From address \(contact@polygonparadise\.com\), going live also needs /);
    expect(line!).not.toMatch(/^\d+\. /);
    expect(step2).toContain(MODE_GATE_TEXTS.checkBeforeFromChange);
  });

  it("the Mailgun guide quotes the From address card and what saving it shows", () => {
    expect(MAILGUN).toContain(`**${TEAM_FROM_TEXTS.cardTitle}**`);
    expect(MAILGUN).toContain(`**${TEAM_FROM_TEXTS.fieldLabel}**`);
    expect(MAILGUN).toContain(`**${TEAM_FROM_TEXTS.saveButton}**`);
    expect(MAILGUN).toContain(`**${TEAM_FROM_TEXTS.goodToKnowHeading}**`);
    expect(MAILGUN).toContain(TEAM_FROM_TEXTS.hint(OWNER_NAME, FROM, ORG, D));
    expect(MAILGUN).toContain(TEAM_FROM_TEXTS.savedOn(FROM, D));
    expect(MAILGUN).toContain(TEAM_FROM_TEXTS.wrongDomain(D, ORG));
    expect(MAILGUN).toContain(TEAM_FROM_TEXTS.onSendingDomain(D, ORG));
    expect(MAILGUN).toContain(TEAM_FROM_TEXTS.checklistLine(FROM, D));
    // The last "Good to know" line, word for word (§2.5 point 6).
    const goodToKnow = TEAM_FROM_TEXTS.goodToKnow(FROM, ORG, D);
    expect(MAILGUN).toContain(goodToKnow[goodToKnow.length - 1]!);
    expect(README).toContain(`**${TEAM_FROM_TEXTS.cardTitle}**`);
    expect(README).toContain(`**${TEAM_FROM_TEXTS.saveButton}**`);
  });

  it("the Mailgun guide quotes the sending-domain refusals and the subdomain's wrong-region sentence", () => {
    expect(MAILGUN).toContain(`"${SENDING_DOMAIN_TEXTS.website}"`);
    expect(MAILGUN).toContain(`"${SENDING_DOMAIN_TEXTS.sandbox}"`);
    const wrongRegion = filledTemplate("src/server/services/mailgun/connect.ts", "Mailgun can't find ${domain} in the ${region} region, only in", {
      domain: D,
      region: "US",
      other: "EU",
    });
    expect(MAILGUN).toContain(`"${wrongRegion}"`);
  });

  it("the Mailgun guide quotes the checklist rows as they read for the owner's domains", () => {
    const checklist = "src/core/dns/checklist.ts";
    const quotes = [
      filledTemplate(checklist, "Mailgun has your domain (${f.region}) and has confirmed", { "f.region": "US" }),
      filledTemplate(checklist, "Mailgun didn't list a DKIM record for ${d}. With a From address", { d: D, org: ORG }),
      filledTemplate(checklist, "Your emails carry ${org}'s digital signature${bits}, which matches", {
        org: ORG,
        bits: " (1024-bit; it works, 2048-bit is stronger)",
      }),
      filledTemplate(checklist, "Mail for ${org} goes to your mail provider (", { org: ORG, 'all.join(", ")': "…" }),
      filledTemplate(checklist, "${org}'s SPF record is almost full", { org: ORG, n: "9" }),
      filledTemplate(checklist, "${org}'s policy: monitor only", { org: ORG }),
      filledTemplate(checklist, "A Google verification record is on ${org}.", { org: ORG }),
      filledTemplate("src/components/settings/domain/domain-age-form.tsx", "When did you buy ${domain}?", { domain: ORG }),
      filledTemplate("src/components/settings/domain/checklist.tsx", "Nobody has a ${w.lower} yet.", {
        "w.lower": senderAddressWords(true).lower,
        "w.label": senderAddressWords(true).label,
      }),
    ];
    for (const q of quotes) expect(MAILGUN).toContain(`"${q}"`);
  });

  it("the Mailgun guide quotes the reply test's new questions, the pasted original and its lines", () => {
    const step13 = stepOf(MAILGUN, 13);
    const t = REPLY_TEST_TEAM_TEXTS;
    expect(step13).toContain(`"${t.intro(FROM, OWNER_ADDRESS)}"`);
    expect(step13).toContain(`"${t.placementQuestion}"`);
    expect(step13).toContain(`"${t.dmarcQuestion}"`);
    expect(step13).toContain(`"${t.dmarcPasteLabel}"`);
    expect(step13).toContain(`"${t.zohoHelp}"`);
    expect(step13).toContain(`**${t.originalHeading}**`);
    expect(step13).toContain(`**${t.readOriginalButton}**`);
    expect(step13).toContain(`"${t.mailtoNote(D, ORG)}"`);
    // The questions come in the screen's order: placement, the reply, dkim/arc, DMARC.
    const order = [t.placementQuestion, "Did the reply arrive in your reply inbox, not in spam?", "Does it say dkim=pass or arc=pass?", t.dmarcQuestion].map(
      (q) => step13.indexOf(q),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // What "Read the original" shows for a good test email, line by line.
    const good = { from: FROM, returnPathDomain: D, returnPathOk: true, dmarc: "pass" as const, dkimSigner: ORG };
    const lines = [
      ...testOriginalTexts({ ...good, mailtoDomain: D, mailtoOk: true }, { from: FROM, d: D, org: ORG }),
      ...testOriginalTexts({ ...good, mailtoDomain: null, mailtoOk: true }, { from: FROM, d: D, org: ORG }),
    ];
    expect(lines.every((l) => l.ok)).toBe(true);
    for (const l of lines) expect(step13).toContain(`"${l.text}"`);
    expect(step13).toContain(REPLY_TEST_TEXTS.notCurrentOriginal(FROM));
    expect(step13).toContain(REPLY_TEST_TEXTS.failedTeam(FROM, D));
    expect(step13).toContain(REPLY_TEST_TEXTS.spamWarning("…"));
    expect(step13).toContain(REPLY_TEST_TEXTS.notSentWithThisFrom);
    const passed = filledTemplate("src/app/(app)/settings/domain/load.ts", "Setup ${rt.setting.setup} passed${on} with the From address", {
      "rt.setting.setup": "A",
      on: " on …",
      teamFrom: FROM,
    });
    expect(step13).toContain(`"${passed}"`);
  });

  it("the words are \"Reply address\", from the one helper, and the practice copy's are explained", () => {
    const words = senderAddressWords(true);
    expect(words.label).toBe("Reply address");
    for (const doc of [README, MAILGUN, GO_LIVE]) expect(doc).toContain(`**${words.label}**`);
    expect(README).toContain(`it still says **${senderAddressWords(false).label}** and shows a placeholder From; the real app says Reply address.`);
    const step12 = stepOf(MAILGUN, 12);
    expect(step12).toContain(
      filledTemplate("src/components/settings/profile-form.tsx", "People see ${teamFrom} as the sender", { teamFrom: FROM }),
    );
    expect(step12).toContain(
      filledTemplate("src/components/settings/profile-form.tsx", "${SIGNATURE_HINT} If your signature", {
        SIGNATURE_HINT: "",
        which: `your reply address (${OWNER_ADDRESS})`,
      }),
    );
    expect(step12).toContain(
      filledTemplate("src/server/services/sender-addresses.ts", "Profile saved. Your ${senderAddressWords(teamFrom).lower} is now", {
        "senderAddressWords(teamFrom).lower": words.lower,
        address: OWNER_ADDRESS,
      }),
    );
  });

  it("the Mailgun guide's first campaign quotes the Send me a test note and the contact@ reminder", () => {
    const step14 = stepOf(MAILGUN, 14);
    expect(step14).toContain(`"${TEAM_FROM_TEXTS.selfTestNote(FROM).trim()}"`);
    expect(step14).toContain(`"${TEAM_FROM_TEXTS.followUpReminder(FROM)}"`);
  });

  it("the owner's docs quote the From change refusal, the notice about the main domain and the health sentence", () => {
    const blocked = filledTemplate("src/server/services/mailgun/connect.ts", "Finish or cancel ${joinNames(names)} first", {
      "joinNames(names)": "“Germany Q4”",
      'names.length === 1 ? "it sends" : "they send"': "it sends",
    });
    expect(blocked).toBe("Finish or cancel “Germany Q4” first: it sends with the current From address.");
    for (const doc of [MAILGUN, GO_LIVE]) expect(doc).toContain(blocked);
    const notice = filledTemplate("src/server/services/checks/domain-check.ts", "Mail for ${org} goes to the wrong place", { org: ORG });
    for (const doc of [README, MAILGUN, GO_LIVE]) expect(doc).toContain(`"${notice}"`);
    const health = filledTemplate("src/server/services/sending/health-check.ts", " Your emails come from ${from}", { from: FROM });
    expect(GO_LIVE).toContain(`"${health}"`);
  });

  it("the Going-live guide quotes the dialog's From line, the spam-placement tick and the From change", () => {
    expect(GO_LIVE).toContain(`"${GO_LIVE_COPY.dialogTeamFromItem(FROM, ORG)}"`);
    // The From item comes right after the warm-up item, as in goLiveDialogItems.
    const step8 = stepOf(GO_LIVE, 8);
    expect(step8.indexOf(GO_LIVE_COPY.dialogTeamFromItem(FROM, ORG))).toBeGreaterThan(step8.indexOf(GO_LIVE_COPY.dialogItems[1]!));
    expect(step8.indexOf(GO_LIVE_COPY.dialogTeamFromItem(FROM, ORG))).toBeLessThan(step8.indexOf(GO_LIVE_COPY.dialogItems[2]!));
    expect(step8).toContain(`"${GO_LIVE_COPY.spamPlacementTick("Outlook.com (…)")}"`);
    expect(step8).toContain(`"${GO_LIVE_COPY.spamPlacementRequired}"`);
    expect(step8).toContain(`"${GO_LIVE_COPY.liveLine("…", "…", D)}"`);
    expect(step8).toContain(`"${GO_LIVE_COPY.liveFromLine(FROM)}"`);
    const step13 = stepOf(GO_LIVE, 13);
    expect(step13).toMatch(/^\n## 13\. Changing the sending domain or the From address later\r?\n/);
    expect(step13).toContain(`**${TEAM_FROM_TEXTS.confirmTitle}**`);
    expect(step13).toContain(`"${TEAM_FROM_TEXTS.confirmBody}"`);
    expect(step13).toContain(`**${TEAM_FROM_TEXTS.confirmButton}**`);
    expect(step13).toContain(`**${TEAM_FROM_TEXTS.cancelButton}**`);
    expect(step13).toContain(`"${GO_LIVE_COPY.descriptionAfterFromChange(FROM, null)}"`);
    expect(step13).toContain(TEAM_FROM_TEXTS.domainMisfit(FROM, "<new domain>"));
  });

  it("guide 2 never asks for an MX or SPF record at @, for Automatic Sender Security or for the EU region", () => {
    const step7 = stepOf(MAILGUN, 7);
    const rows = step7
      .split(/\r?\n/)
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Row in the app"))
      .map((l) => l.split("|").map((c) => c.trim()));
    expect(rows).toHaveLength(5);
    for (const [, row, type, name, value] of rows) {
      if (/\bMX\b/.test(type!) || /v=spf1/.test(value!)) expect(name, row).toBe("`mail`");
      expect(name, row).not.toBe("`@`");
    }
    expect(step7).toContain("GoDaddy's form may fill Name with `@`: change it to `mail`");
    expect(step7).toContain("**Never add, delete or change the MX records or the SPF record of `@` (polygonparadise.com itself)");
    for (const record of ["`dc-…._spfm`", "`mx._domainkey`", "`zmail._domainkey`"]) expect(step7).toContain(record);
    expect(MAILGUN).not.toMatch(/switch on \*\*Automatic Sender Security\*\*/i);
    expect(MAILGUN).toContain("leave **Automatic Sender Security** off");
    expect(MAILGUN).not.toMatch(/\*\*Region: EU|\*\*Region:\*\* EU/);
    expect(MAILGUN).toContain("**Region: US**");
    expect(MAILGUN).toContain("**Region:** US.");
    expect(MAILGUN).not.toContain("mxa.eu.mailgun.org");
    // The owner's real names replace the placeholders of the earlier guide.
    expect(MAILGUN).not.toContain("send.example.com");
    expect(GO_LIVE).not.toContain("send.example.com");
  });

  it("the Cloudflare guide lists every record a move to Cloudflare must keep, and forbids Email Routing", () => {
    const step1 = stepOf(CLOUDFLARE, 1);
    for (const record of ["`dc-…._spfm`", "`mx._domainkey`", "`zmail._domainkey`", "`_dmarc`", "`email.mail`", "`mail`"]) {
      expect(step1, record).toContain(record);
    }
    expect(step1).toContain("**Never switch on Email Routing for polygonparadise.com**");
    expect(step1).toContain("`email` and `email.mail` must be **DNS only** (grey cloud)");
    expect(CLOUDFLARE).toContain("Never use mail.polygonparadise.com (the Mailgun guide's sending subdomain) for the app");
    // The domain-buying steps moved here from the Mailgun guide.
    expect(step1).toContain("**Complete purchase**");
    expect(step1).toContain("**Open the verification email from ICANN**");
  });

  it("the README says what doesn't reach the app, and what to watch", () => {
    expect(README).toContain("**Replies sent straight to contact@polygonparadise.com don't reach the app.**");
    const reputation = readmeReputation();
    expect(reputation).toContain("Gmail and Google Workspace never report complaints");
    expect(reputation).toContain("**Settings › Deliverability** › **Thresholds** as they are");
    expect(README).toContain("#13-changing-the-sending-domain-or-the-from-address-later");
  });
});

/** README "Sending safely", the bullet "Your main address's reputation" (it ends where "Going live." starts). */
function readmeReputation(): string {
  const safely = README.slice(README.indexOf("## Sending safely"), README.indexOf("## When the PC is off"));
  return safely.slice(safely.indexOf("**Your main address's reputation.**"), safely.indexOf("- **Going live.**"));
}

/** Each needle's position in `text`, failing by name when one is missing; the positions must rise. */
function expectInOrder(text: string, needles: readonly string[], where: string): void {
  const positions = needles.map((needle) => {
    const i = text.indexOf(needle);
    expect(i, `${where}: ${needle}`).toBeGreaterThan(-1);
    return i;
  });
  expect([...positions].sort((a, b) => a - b), where).toEqual(positions);
}

describe("a domain sending key refused in shared-From mode (review SCREENS-01)", () => {
  // The pause names Settings › Sending & Mailgun › Advanced › Remove the sending key; the Mailgun guide's troubleshooting
  // walks that exact path (a new API key doesn't help while the sending key sends), and step 6 offers the same button.
  it("the Mailgun guide, step 18, walks to Remove the sending key, then Resume sending", () => {
    const step18 = stepOf(MAILGUN, 18);
    const bullet = step18.split(/\r?\n/).find((l) => l.startsWith('- "Mailgun didn\'t accept the API key"'));
    expect(bullet).toBeDefined();
    expectInOrder(
      bullet!,
      [
        "Advanced › Remove the sending key",
        "a new API key doesn't help",
        "open **Settings › Sending & Mailgun**, open **Advanced**, click **Remove the sending key**",
        "then click **Resume sending**",
      ],
      "Mailgun guide, step 18",
    );
    expect(bullet!).not.toMatch(/Remove saved keys/);
  });

  it("the Mailgun guide, step 6, points a saved sending key to the same button", () => {
    expect(stepOf(MAILGUN, 6)).toContain("Only if a sending key was saved earlier: open **Advanced** and click **Remove the sending key** (step 18 says why).");
  });
});

describe("the way back to each person's own address (review SCREENS-02)", () => {
  // "Pause all sending" is global: campaigns stay Running and never finish while it lasts, the From address can't change
  // while a test or live campaign is scheduled, running or paused, and the reply test refuses while sending is paused.
  // So every doc gives one order that can actually be followed: pause, cancel (or resume and let them finish), empty the
  // From address, resume, then the reply test, a live test to the test list and going live again.
  const labels = {
    pauseAll: "Pause all sending",
    cancel: "Cancel campaign",
    resume: "Resume sending",
    saveFrom: TEAM_FROM_TEXTS.saveButton,
    changeIt: TEAM_FROM_TEXTS.confirmButton,
  };

  it("uses the buttons' own words", () => {
    // Both are a button's whole JSX text line.
    expect(screenText(readRel("src/components/settings/sending/pause-all-button.tsx"))).toMatch(new RegExp(`^\\s*${labels.pauseAll}\\s*$`, "m"));
    expect(screenText(readRel("src/components/campaigns/campaign-controls.tsx"))).toMatch(new RegExp(`^\\s*${labels.cancel}\\s*$`, "m"));
    expect(screenText(readRel("src/components/settings/sending/pause-card.tsx"))).toContain(`>${labels.resume}</Button>`);
    expect(labels.saveFrom).toBe("Save From address");
    expect(labels.changeIt).toBe("Change it");
    // Why the docs resume before the reply test: it refuses while sending is paused.
    expect(readRel("src/server/services/test-send.ts")).toContain("Tests go out again once it's resumed.");
  });

  const steps = [
    `**${labels.pauseAll}**`,
    "Cancel every test or live campaign that is scheduled, running or paused",
    `**${labels.cancel}**`,
    `**${labels.resume}**`,
    "Empty the From address",
    `**${labels.saveFrom}**`,
    `**${labels.changeIt}**`,
    `If sending is still paused, click **${labels.resume}**`,
    "Run the reply test again",
    "send a live campaign to your test list",
    "**Check again**",
    "go live again",
  ];

  it("README \"Sending safely\" gives the order, with Resume sending after the From address is emptied", () => {
    const reputation = readmeReputation();
    const wayBack = reputation.slice(reputation.indexOf("**The way back**"));
    expectInOrder(wayBack, steps, "README");
    // Letting a campaign finish needs sending resumed first, and the README says so.
    expect(wayBack).toContain(`To let a campaign finish instead, click **${labels.resume}** and wait until it has finished`);
    expect(wayBack).toContain("nothing finishes while sending is paused");
    expect(wayBack.match(/^ {2}\d\. /gm)).toHaveLength(5);
  });

  it("the Going-live guide, step 13, gives the same order", () => {
    const step13 = stepOf(GO_LIVE, 13);
    const wayBack = step13.slice(step13.indexOf("To go back to each person's own address, in this order:"));
    expect(wayBack.length).toBeLessThan(step13.length);
    expectInOrder(wayBack, steps, "Going-live guide, step 13");
    expect(wayBack).toContain(`To let a campaign finish instead, click **${labels.resume}** and wait until it has finished`);
    expect(step13).toContain("Campaigns don't finish while sending is paused.");
  });

  it("the Going-live guide, step 11, and the Mailgun guide, step 18, give the short form of the same order", () => {
    const step11 = stepOf(GO_LIVE, 11);
    const short = step11.slice(step11.indexOf("**The way back**"));
    expectInOrder(
      short,
      [`**${labels.pauseAll}**`, "cancel every test or live campaign that is scheduled, running or paused", "empty the From address", `click **${labels.resume}**`, "run the reply test", "send a live campaign to your test list", "go live again", "Step 13 has the full order"],
      "Going-live guide, step 11",
    );
    const step18 = stepOf(MAILGUN, 18);
    const changing = step18.slice(step18.indexOf("**Changing the From address.**"));
    expectInOrder(
      changing,
      ["scheduled, running or paused", "campaigns don't finish while sending is paused", `**${labels.pauseAll}**`, "cancel those campaigns", "empty the From address", `click **${labels.resume}**`, "run the reply test", "send a live campaign to your test list", "go live again"],
      "Mailgun guide, step 18",
    );
  });

  it("in the own-mailbox setup the way back never starts by emptying the From address (review SCREENS-08)", () => {
    // An empty From address stops every test and live campaign there: the way back goes through the full setup first.
    const toFull = "2-own-mailbox.md#15-switching-to-the-full-setup-later";
    const step11 = stepOf(GO_LIVE, 11);
    const short = step11.slice(step11.indexOf("**The way back**"));
    expectInOrder(short, ["Step 13 has the full order", "**In the own-mailbox setup, don't empty the From address**", "Foundation", "mail.polygonparadise.com", toFull], "Going-live guide, step 11");
    const step13 = stepOf(GO_LIVE, 13);
    const wayBack = step13.slice(step13.indexOf("To go back to each person's own address, in this order:"));
    expectInOrder(wayBack, ["Empty the From address", "In the own-mailbox setup an empty From address stops every test and live campaign", toFull], "Going-live guide, step 13");
    expect(readmeReputation()).toContain("In the own-mailbox setup an empty From address stops test and live campaigns altogether");
    // Postmaster Tools: the own-mailbox guide's step, next to the Mailgun guide's.
    expect(step11).toContain("in the own-mailbox setup [Own-mailbox guide, step 14](2-own-mailbox.md#14-optional-google-postmaster-tools-and-your-domains-age)");
  });

  it("no doc says to let running campaigns finish after pausing all sending, or leaves out scheduled campaigns", () => {
    for (const rel of OWNER_DOCS) {
      const text = DOCS[rel];
      expect(text, rel).not.toMatch(/let (the )?running campaigns finish,? or cancel them/i);
      expect(text, rel).not.toMatch(/From address can't change while a test or live campaign is running or paused/);
    }
  });
});

describe("bounce and complaint counting after a From address change (review REPLIES-02)", () => {
  // Going live again on the same sending domain keeps the health count of the first go-live there: a From change
  // doesn't wipe the complaints that brought the owner to change it. Only resuming (a fresh count) and a new sending
  // domain start again.
  it("the README says going live again after a From change doesn't start a fresh count", () => {
    const safely = README.slice(README.indexOf("## Sending safely"), README.indexOf("## When the PC is off"));
    const pause = safely.slice(safely.indexOf("**The automatic pause.**"), safely.indexOf("- **Pause all sending.**"));
    expect(pause).toContain("Resuming starts a fresh count.");
    expect(pause).toContain(
      "Going live again after a From address change doesn't start a fresh count: the emails still go through the same sending domain, so the bounces and complaints from before the change keep counting.",
    );
  });

  it("the Going-live guide says so in step 8 and step 13", () => {
    expect(stepOf(GO_LIVE, 8)).toContain(
      "When you go live again after changing the From address, they keep counting from your first go-live on mail.polygonparadise.com (step 13).",
    );
    const step13 = stepOf(GO_LIVE, 13);
    const fromChange = step13.slice(step13.indexOf("Changing the **From address**"));
    expect(fromChange).toContain("Bounces and complaints keep counting: going live again doesn't start a fresh count");
    expect(fromChange).toContain(`**${DASHBOARD_TEXTS.health.heading}**`);
  });

  it("no doc says a From change or going live again starts a fresh count", () => {
    for (const rel of OWNER_DOCS) {
      expect(DOCS[rel], rel).not.toMatch(/(From address change|going live again)[^.\n]*\b(starts|restarts) (a fresh|the) count/i);
      expect(DOCS[rel], rel).not.toMatch(/bounces and complaints (count|are counted) again from/i);
    }
    // The check above really catches the old wording.
    expect("Going live again starts a fresh count.").toMatch(/(From address change|going live again)[^.\n]*\b(starts|restarts) (a fresh|the) count/i);
  });
});

describe("moving polygonparadise.com's DNS to Cloudflare (review SCREENS-09)", () => {
  // After the nameserver move GoDaddy usually no longer shows the zone, so the guide has the owner write every record
  // down before the move, names the `_spfm` helper records Cloudflare's scan can't guess, and never says "copy it from
  // GoDaddy" afterwards.
  const optionB = (() => {
    const step1 = stepOf(CLOUDFLARE, 1);
    return step1.slice(step1.indexOf("**(b) Move polygonparadise.com to Cloudflare.**"));
  })();

  it("says to write every record down before the nameservers change", () => {
    const writeDown = optionB.indexOf("**Write down every record now, before you change the nameservers** (step 5)");
    const nameservers = optionB.indexOf("then replace the nameservers with Cloudflare's two");
    expect(writeDown).toBeGreaterThan(-1);
    expect(nameservers).toBeGreaterThan(writeDown);
    expect(optionB).toContain("GoDaddy usually stops showing polygonparadise.com's records");
  });

  it("gives the two `_spfm` records as the research recorded them", () => {
    const research = readRel("docs/dev/research/shared-from-mail-behaviour.md");
    const recorded = [...research.matchAll(/^\| `(dc-[0-9a-f]+\._spfm)\.polygonparadise\.com` \| TXT \| `(v=spf1 [^`]+)` \|$/gm)].map((m) => [m[1]!, m[2]!]);
    expect(recorded).toHaveLength(2);
    for (const [name, value] of recorded) expect(optionB).toContain(`\`${name}\` with the value \`${value}\``);
  });

  it("step 8 adds a missing record in Cloudflare from the notes, never from GoDaddy", () => {
    const step8 = optionB.slice(optionB.indexOf("\n8. "), optionB.indexOf("**What you should see:**"));
    expect(step8).toContain("with the name and value you wrote down in step 2");
    expect(step8).toContain("ask the person who set up the app");
    for (const rel of OWNER_DOCS) expect(DOCS[rel], rel).not.toMatch(/copy it from GoDaddy/i);
    // The Mailgun guide's red SPF row points to the same place.
    expect(stepOf(MAILGUN, 18)).toContain("[Cloudflare guide, step 1](3-cloudflare.md#1-put-the-apps-domain-on-cloudflare)");
  });
});

// ── The own-mailbox setup (MAIN-DOMAIN-DESIGN §6) ──

/**
 * The unsubscribe-by-email address as the docs write it: Mailgun's own `u+…@` address on the sending domain (the app
 * shows the whole address, read from the pasted original).
 */
const MAILTO = `u+…@${ORG}`;

describe("the own-mailbox setup in the docs (MAIN-DOMAIN-DESIGN §6)", () => {
  // The owner's own setup: every email From contact@polygonparadise.com, sent through polygonparadise.com itself on
  // Mailgun's Free plan, replies straight to contact@ and marked by hand. The quotes are the app's own-mailbox sentences
  // filled in with those names; the guide never shows a Mailgun MX record or an SPF value to add.

  it("README's Start here offers the own-mailbox guide next to the Mailgun guide, without a new ### heading", () => {
    const start = README.slice(README.indexOf("## Start here"), README.indexOf("### Install and first run"));
    const own = start.indexOf("](docs/setup/2-own-mailbox.md)");
    expect(own).toBeGreaterThan(start.indexOf("](docs/setup/1-install.md)"));
    expect(own).toBeLessThan(start.indexOf("](docs/setup/2-mailgun-and-dns.md)"));
    expect(start).toContain(
      "**Your setup:** the [Own-mailbox guide](docs/setup/2-own-mailbox.md): the app sends through polygonparadise.com and replies come to contact@polygonparadise.com, on Mailgun's Free plan.",
    );
    expect(start).toContain("The [Mailgun guide](docs/setup/2-mailgun-and-dns.md) is the full setup (Mailgun Foundation, replies through the app)");
    expect(start).toContain("optional in the own-mailbox setup)");
    expect(README).toContain("Close any window running `npm run dev` first; the first start builds for a few minutes.");
  });

  it("the README says where replies go in the own-mailbox setup, what to click, and names the new words", () => {
    expect(README).toContain(
      "**In your setup replies don't reach the app at all.** They land in contact@polygonparadise.com (look in its Spam folder too). When someone answers, open the company and click **They replied**: it stops every follow-up.",
    );
    expect(README).toContain(`Then click **${INBOX_CHECK_TEXTS.button(FROM)}** on the Notifications page: live follow-ups wait for that each day.`);
    expect(README).toContain(
      "In the practice copy (start-demo.bat) simulated replies stop follow-ups by themselves; in your real setup they don't: practise They replied there too.",
    );
    // The shared-From bullet stays, and names They replied too.
    expect(README).toContain("**Replies sent straight to contact@polygonparadise.com don't reach the app.**");
    expect(README).toContain(`click **${THEY_REPLIED_TEXTS.button}** on that company (or set its status to **Replied**) so the follow-ups stop`);
    // The one rule that protects the everyday email, word for word from the own-mailbox From card (§2.5 point 6).
    const goodToKnow = OWN_MAILBOX_TEXTS.goodToKnow(FROM, ORG);
    expect(README).toContain(goodToKnow[goodToKnow.length - 1]!);
    expect(README).toContain(`**${OWN_MAILBOX_TEXTS.repliesOwnLabel}**`);
    const glossary = README.slice(README.indexOf("### Words used here"), README.indexOf("### Getting help"));
    for (const word of [THEY_REPLIED_TEXTS.button, "Inbox check", OWN_MAILBOX_TEXTS.repliesLegend, PLAN_TEXTS.planLabel]) {
      expect(glossary, word).toContain(`- **${word}:**`);
    }
    expect(README).toContain(`"${OWN_MAILBOX_TEXTS.repliesEmpty(FROM)}"`);
  });

  it("the own-mailbox guide opens with the quick path and ends with the optional tidy-up", () => {
    const at = OWN.indexOf("> **Quick path**");
    expect(at).toBeGreaterThan(-1);
    const quick = OWN.slice(at, OWN.indexOf("\n## 1. "));
    const items = [...quick.matchAll(/^> (\d+)\. (.+)$/gm)];
    expect(items.map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Each line names the step that has the details.
    const cited = items.flatMap((m) =>
      [...m[2]!.matchAll(/\(steps? (\d+)(?:–(\d+))?\)/g)].flatMap((s) => (s[2] ? [Number(s[1]), Number(s[2])] : [Number(s[1])])),
    );
    expect(cited).toEqual([1, 3, 4, 5, 6, 7, 9, 9, 10, 11]);
    expect(quick).toContain("**From polygonparadise.com itself**");
    expect(quick).toContain(`**${MODE_OPTION_TEXTS.LIVE.title}**`);
    const tidy = OWN.indexOf("> **Tidy up (optional)**");
    expect(tidy).toBeGreaterThan(OWN.indexOf("\n## 16. "));
    expect(OWN.slice(tidy)).toContain("If a line starts with `MAILGUN_`, delete that line");
  });

  it("the own-mailbox guide quotes the Mailgun connection card and what connecting shows", () => {
    const step4 = stepOf(OWN, 4);
    expect(step4).toContain(`**${OWN_MAILBOX_TEXTS.repliesLegend}**: **${OWN_MAILBOX_TEXTS.repliesOwnLabel}**`);
    expect(step4).toContain(`**${PLAN_TEXTS.planLabel}**`);
    expect(step4).toContain(`**${MAILGUN_PLAN_FACTS.free.label}**`);
    expect(step4).toContain(`**${OWN_MAILBOX_TEXTS.websiteSwitch}**`);
    const connected = filledTemplate("src/server/services/mailgun/connect.ts", "Connected to ${domain} (${region}). ${lead}", {
      domain: ORG,
      region: "US",
      lead: OWN_MAILBOX_TEXTS.connectedNext,
      planNote: OWN_MAILBOX_TEXTS.planSetFree,
      keyNote: "",
      liveNote: "",
      regionNote: "",
    });
    expect(connected).toBe(`Connected to ${ORG} (US). ${OWN_MAILBOX_TEXTS.connectedNext}${OWN_MAILBOX_TEXTS.planSetFree}`);
    expect(step4).toContain(`"${connected}"`);
    expect(step4).toContain(`"Connected to ${ORG} (US)${OWN_MAILBOX_TEXTS.statusSuffix}"`);
    const wrongRegion = filledTemplate("src/server/mailgun/errors.ts", "Mailgun can't find ${domain} in the ${region} region. If", {
      domain: ORG,
      region: "EU",
      other: "US",
    });
    expect(step4).toContain(`"${wrongRegion}"`);
    const website = SENDING_DOMAIN_TEXTS.website;
    expect(step4).toContain(`"${website.slice(0, website.indexOf(" For replies through the app"))} …"`);
    expect(step4).toContain(`"${SENDING_DOMAIN_TEXTS.sandboxOwn}"`);
    expect(step4).toContain(`"${SENDING_DOMAIN_TEXTS.www}"`);
  });

  it("the own-mailbox guide quotes the From address card in own-mailbox mode", () => {
    const step5 = stepOf(OWN, 5);
    expect(step5).toContain(`**${TEAM_FROM_TEXTS.cardTitle}**`);
    expect(step5).toContain(`in **${OWN_MAILBOX_TEXTS.fieldLabel}** and click **${TEAM_FROM_TEXTS.saveButton}**`);
    expect(step5).toContain(`"${OWN_MAILBOX_TEXTS.hint(OWNER_NAME, FROM, ORG)}"`);
    expect(step5).toContain(`"${OWN_MAILBOX_TEXTS.savedOn(FROM)}"`);
    expect(step5).toContain(`**${TEAM_FROM_TEXTS.goodToKnowHeading}**`);
    const goodToKnow = OWN_MAILBOX_TEXTS.goodToKnow(FROM, ORG);
    expect(step5).toContain(`"${goodToKnow[goodToKnow.length - 1]}"`);
    expect(step5).toContain(`"${OWN_MAILBOX_TEXTS.fromWrongDomain(ORG)}"`);
  });

  it("the own-mailbox guide names the checklist rows as the screen shows them for polygonparadise.com", () => {
    const step7 = stepOf(OWN, 7);
    const checklist = "src/core/dns/checklist.ts";
    for (const key of goLiveRowKeys(false, { ownMailbox: true, publicAddress: false })) expect(step7, key).toContain(`"${checklistTitle(key, ORG)}"`);
    for (const key of ["https-links", "webhooks", "remote-access", "monthly-limit"] as const) {
      expect(step7, key).toContain(`**${checklistTitle(key, ORG)}**`);
    }
    const quotes = [
      OWN_MAILBOX_TEXTS.checklistLine(FROM, ORG),
      filledTemplate(checklist, "Mailgun has your domain (${f.region}) and has confirmed", { "f.region": "US" }),
      filledTemplate(checklist, "Mailgun may send for ${d} (through its SPF", { d: ORG, n: "9" }),
      filledTemplate(checklist, "Your emails carry ${d}'s digital signature", { d: ORG, "bitsText(keyBits)": " (1024-bit; it works, 2048-bit is stronger)" }),
      filledTemplate(checklist, "Mail for ${d} goes to your mail provider (", { d: ORG, 'all.join(", ")': "…" }),
      PLAN_TEXTS.monthlyNotNeeded(100),
      OWN_MAILBOX_TEXTS.applyNotNeeded,
      OWN_MAILBOX_TEXTS.applyNoPublicAddress,
    ];
    for (const q of quotes) expect(step7).toContain(`"${q}"`);
    // Rows that don't exist in this mode are never named in the guide.
    const absent = [
      checklistTitle("mx", ORG),
      CHECKLIST_ROW_TITLES["reply-routes"],
      CHECKLIST_ROW_TITLES["spam-filter"],
      CHECKLIST_ROW_TITLES.retention,
      checklistTitle("from-spf", ORG),
    ];
    for (const title of absent) expect(OWN, title).not.toContain(title);
  });

  it("the own-mailbox guide's profiles step quotes My profile in own-mailbox mode", () => {
    const step8 = stepOf(OWN, 8);
    expect(step8).toContain(`**${OWN_MAILBOX_TEXTS.testInboxLabel}:**`);
    expect(step8).toContain(`"${OWN_MAILBOX_TEXTS.profileFromLine(OWNER_NAME, FROM)}"`);
    expect(step8).not.toContain("**Reply address");
  });

  it("the own-mailbox guide walks the reply test by hand in the screen's order and words", () => {
    const step9 = stepOf(OWN, 9);
    const t = OWN_REPLY_TEST_TEXTS;
    expect(step9).toContain(`"${MODE_GATE_TEXTS.dmarcFirst}"`);
    expect(step9).toContain(`"${t.intro(FROM)}"`);
    expect(step9).toContain(`"${t.logsNote}"`);
    // The questions come in the screen's order: placement, the reply in contact@, DMARC.
    const order = [REPLY_TEST_TEAM_TEXTS.placementQuestion, t.replyQuestion(FROM), REPLY_TEST_TEAM_TEXTS.dmarcQuestion].map((q) => step9.indexOf(`"${q}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(step9).toContain(`"${REPLY_TEST_TEAM_TEXTS.dmarcPasteLabel}"`);
    expect(step9).toContain(`**${REPLY_TEST_TEAM_TEXTS.readOriginalButton}**`);
    // What "Read the original" shows for a good test email on the Free plan, line by line (here without a mailto:, so the
    // last line is "not offered"; a mailto: whose address can't be read is never "not offered", review SECURITY-03).
    const lines = testOriginalTexts(
      {
        from: FROM,
        returnPathDomain: ORG,
        returnPathOk: true,
        dmarc: "pass",
        dkimSigner: ORG,
        mailtoDomain: null,
        mailtoOk: true,
        unsubscribeScheme: "http",
        mailtoAddress: null,
      },
      { from: FROM, d: ORG, org: ORG, ownMailbox: true },
    );
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines[lines.length - 1]!.text).toBe(t.mailtoNone);
    for (const l of lines.slice(0, -1)) expect(step9).toContain(`"${l.text}"`);
    expect(step9).toContain(`"${t.linkHttps}"`);
    expect(step9).toContain(`"${t.mailtoOwn(MAILTO)}"`);
    expect(step9).toContain(`"${t.mailtoNote}"`);
    expect(step9).toContain(`"${t.mailtoQuestion(MAILTO, FROM)}"`);
    expect(step9).toContain(`"${t.mailtoAfter}"`);
    expect(step9).toContain(`"${t.passedRow(" on …", FROM)}"`);
    expect(step9).toContain(`"${t.sectionFailed(FROM)}"`);
    // Zoho's catch-all, on the path the fix sentence names.
    expect(t.mailtoFailed(MAILTO, ORG, FROM)).toContain(`Zoho Mail: Admin Console › Domains › ${ORG} › Catch-all Address, under Advanced Settings`);
    expectInOrder(step9, ["**Admin Console**", `**Domains** › ${ORG} › **Catch-all Address**`, "**Advanced Settings**", "**Update**"], "Own-mailbox guide, step 9");
    // The unsubscribed test mailbox is put back before the result is saved (review B5).
    const afterClick = step9.slice(step9.indexOf('"Unsubscribe reached the app ✓"'));
    expectInOrder(afterClick, ["**Settings › Deliverability**", "**Remove**", "**Save the result**"], "Own-mailbox guide, step 9");
    // One mode switch before going live, here (review B6), with own-mailbox mode's words for "Send me a test" (SCREENS-11).
    expect(step9).toContain(`choose **${MODE_OPTION_TEXTS.LIVE.title}** and click **Save mode**`);
    expect(OWN.split("**Save mode**")).toHaveLength(2);
    expect(step9).toContain(`"${liveConfirmText(["…"], false, true)}"`);
    expect(step9).not.toContain("your own reply inbox");
  });

  it("the own-mailbox guide's reply test: the headers question Free really answers, and only a mailbox you read proves unsubscribe by email", () => {
    const step9 = stepOf(OWN, 9);
    const t = OWN_REPLY_TEST_TEXTS;
    // Review SCREENS-04: the screen's own-mailbox question and note (a link, http on Free, no List-Unsubscribe-Post).
    const section = screenText(readRel("src/components/settings/domain/reply-test-section.tsx"));
    for (const key of ["headersQuestion", "headersNote", "mailtoNote", "mailtoAfter"]) expect(section, key).toContain(`OWN_REPLY_TEST_TEXTS.${key}`);
    expect(step9).toContain(`"${t.headersQuestion}"`);
    expect(step9).toContain(`"${t.headersNote}"`);
    expect(step9).not.toContain("Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?");
    // Reviews REPLIES-01, SCREENS-02: the address is on polygonparadise.com, so Settings › Deliverability never proves it
    // (it lists the test mailbox because of the link click); the link-click entry is removed before the question.
    expect(t.mailtoQuestion(MAILTO, FROM)).not.toContain("Deliverability");
    expect(step9).not.toMatch(/does Settings › Deliverability now list/);
    expect(step9).toContain("Settings › Deliverability never counts as a Yes here.");
    expectInOrder(step9, ['"Unsubscribe reached the app ✓"', "click **Remove**", `"${t.mailtoQuestion(MAILTO, FROM)}"`, `"${t.mailtoAfter}"`], "Own-mailbox guide, step 9");
    // Review REPLIES-03: the ways forward in order: the catch-all, the aliases, then leaving out unsubscribe by email.
    const bounced = step9.slice(step9.indexOf("**If it bounced back**"));
    expectInOrder(
      bounced,
      ["**Catch-all Address**", "`u@polygonparadise.com`", "`bounce@polygonparadise.com`", "**Email Alias**", `**${t.leaveOutButton}**`, `**${t.leaveOutConfirm}**`, `**${t.offerAgainButton}**`],
      "Own-mailbox guide, step 9 (a bounce)",
    );
    expect(step9).not.toMatch(/stop here/i);
    expect(t.mailtoFailed(MAILTO, ORG, FROM)).toContain(`click ${t.leaveOutButton} below`);
    expect(t.mailtoFailed(MAILTO, ORG, FROM)).toContain("Email Alias");
  });

  it("the own-mailbox guide, step 1: Zoho's catch-all first, the aliases without it, and what may cost money", () => {
    const step1 = stepOf(OWN, 1);
    const bullet = step1.slice(step1.indexOf("**A catch-all address in Zoho, turned on now.**"));
    expect(bullet.length).toBeLessThan(step1.length);
    // Zoho's own path (zoho.com/mail/help/adminconsole/catch-all-setup.html, zoho.com/mail/how-to/create-email-alias.html).
    expectInOrder(
      bullet,
      [
        "**Admin Console**",
        `**Domains** › ${ORG} › **Advanced Settings** › **Catch-all Address**`,
        FROM,
        "**Update**",
        "`u@polygonparadise.com`",
        "`bounce@polygonparadise.com`",
        "**Users** › the user of contact@ › **Mailbox Settings** › **Email Alias** › **Add**",
        "the reply test (step 9) shows whether that works",
        "last resort (step 9)",
      ],
      "Own-mailbox guide, step 1",
    );
    // Review SCREENS-01: no promise that nothing costs money, and no other address checker.
    expect(OWN).not.toContain("There is nothing to buy.");
    expect(step1).toContain("Only address checks may cost money");
    expect(GO_LIVE_RECOMMENDATION_TEXTS.checksFree).not.toMatch(/another checker/);
    for (const rel of OWNER_DOCS) expect(DOCS[rel], rel).not.toMatch(/choose another checker/);
    // Step 10 tries one check before going live (the Mailgun guide's step 19, items 1 and 2).
    const step10 = stepOf(OWN, 10);
    expectInOrder(step10, ["**Try one address check**", "**Validations**", "**Settings › Deliverability**", "**Test address checks**", "Email Validations"], "Own-mailbox guide, step 10");
  });

  it("the own-mailbox guide, step 7: the Apply steps that stay grey, with the words the card shows (review DOMAIN-3, SCREENS-06)", () => {
    const step7 = stepOf(OWN, 7);
    const expected = [
      APPLY_STEP_TEXTS.certNotInPlan,
      APPLY_STEP_TEXTS.httpsNotInPlanOwn,
      OWN_MAILBOX_TEXTS.applyNotNeeded,
      OWN_MAILBOX_TEXTS.applyNoPublicAddress,
      APPLY_STEP_TEXTS.webhooksOptionalOwn,
    ];
    for (const text of expected) {
      const { status, word } = applyStepStatus({ ok: null, text });
      expect(status, text).toBe("info");
      expect(step7, text).toContain(`"${text}"`);
      // The word in front of the step, before its sentence, on the same line.
      const line = step7.split(/\r?\n/).find((l) => l.includes(`"${text}"`))!;
      expect(line, text).toContain(`**${word}**`);
      expect(line.indexOf(`**${word}**`), text).toBeLessThan(line.indexOf(`"${text}"`));
    }
    expect(step7).not.toContain("(in red)");
    expect(step7).not.toMatch(/\bWaiting\b/);
  });

  it("the own-mailbox guide's troubleshooting quotes the reply test's new sentences", () => {
    const step16 = stepOf(OWN, 16);
    const t = OWN_REPLY_TEST_TEXTS;
    expect(step16).toContain(`"${t.reportGone("…")}"`);
    const prefix = (s: string, end: string) => s.slice(0, s.indexOf(end) + end.length);
    for (const [text, end] of [
      [t.unsubscribeGone, "couldn't read Mailgun's reports, "],
      [t.mailtoUnreadable, "can't read that address, "],
      [OWN_MAILBOX_TEXTS.liveTestGone, "only for a short time), "],
    ] as const) {
      expect(text).toContain(end);
      expect(step16, text).toContain(`"${prefix(text, end)}…"`);
    }
    expect(step16).toContain(`**${t.leaveOutButton}**`);
  });

  it("the own-mailbox guide sets up the test companies as the Mailgun guide does and practises the two daily clicks", () => {
    const step10 = stepOf(OWN, 10);
    for (const needle of ["**New list**", "**Test mailboxes**", "**Create list**", "**Add company**", "**Country:** Pakistan", "**Email these companies**", "**Launch campaign**"]) {
      expect(step10, needle).toContain(needle);
    }
    expect(step10).toContain(`"Sent by Arslan as ${OWNER_NAME} <${FROM}>"`);
    expect(step10).toContain(`"${OWN_MAILBOX_TEXTS.followUpReminder(FROM)}"`);
    expect(step10).toContain(`**${OWN_MAILBOX_TEXTS.openInboxCheck}**`);
    expectInOrder(
      step10,
      [`**${THEY_REPLIED_TEXTS.button}**`, `**${THEY_REPLIED_TEXTS.confirm}**`, "**Stopped: they replied**", `**${INBOX_CHECK_TEXTS.title}**`, `**${INBOX_CHECK_TEXTS.button(FROM)}**`],
      "Own-mailbox guide, step 10",
    );
    expect(step10).not.toContain("Save mode");
    const step12 = stepOf(OWN, 12);
    expectInOrder(
      step12,
      ["Spam folder", `**${THEY_REPLIED_TEXTS.button}**`, "**Mark unsubscribed**", `**${INBOX_CHECK_TEXTS.title}**`, `**${INBOX_CHECK_TEXTS.button(FROM)}**`],
      "Own-mailbox guide, step 12",
    );
    expect(step12).toContain(`"${INBOX_CHECK_TEXTS.notificationTitle}"`);
  });

  it("going live, in the own-mailbox guide and the Going-live guide: the dialog's own lines and the two ticks", () => {
    const warm90 = goLiveWarmupItem({ startCap: 50, maxCap: 90, steps: 20 });
    expect(warm90).toMatch(/, to 90 in about 4 weeks\.$/);
    for (const [name, text] of [
      ["Own-mailbox guide, step 11", stepOf(OWN, 11)],
      ["Going-live guide, step 8", stepOf(GO_LIVE, 8)],
    ] as const) {
      expect(text, name).toContain(`"${GO_LIVE_COPY.dialogOwnMailboxItem(FROM, ORG)}"`);
      expect(text, name).toContain(`"${warm90}"`);
      expect(text, name).toContain(`"${GO_LIVE_COPY.ownMailboxTick(FROM)}"`);
      expect(text, name).toContain(`"${GO_LIVE_COPY.httpLinksTick}"`);
      expect(text, name).toContain(`"${GO_LIVE_COPY.ownMailboxRequired}"`);
      expect(text, name).toContain(`"${GO_LIVE_COPY.httpLinksRequired}"`);
      expect(text, name).toContain(`"${GO_LIVE_COPY.liveOwnFromLine(FROM)}"`);
    }
    const step11 = stepOf(OWN, 11);
    expect(step11).toContain(`**${GO_LIVE_COPY.confirmLabel}**`);
    expect(step11).toContain(`"${GO_LIVE_RECOMMENDATION_TEXTS.authorizedCheck}"`);
    expect(step11).toContain(`"${GO_LIVE_COPY.liveLine("…", "…", ORG)}"`);
    // The warm-up item of the standard dialog stays pinned in the Going-live guide.
    expect(GO_LIVE).toContain(`"${GO_LIVE_COPY.dialogItems[1]}"`);
  });

  it("the own-mailbox guide quotes the Free plan's limits, the pauses and the reply test's failures", () => {
    const step13 = stepOf(OWN, 13);
    expect(step13).toContain(`"${PLAN_TEXTS.capLine(90, 100)}"`);
    expect(step13).toContain(`"${PLAN_TEXTS.testsFull(100)}"`);
    expect(step13).toContain(`"Paused: ${PLAN_TEXTS.limitReason}"`);
    expect(step13).toContain(`"${GO_LIVE_RECOMMENDATION_TEXTS.checksFree}"`);
    expect(stepOf(OWN, 1)).toContain(`"Paused: ${PLAN_TEXTS.authorizedReason}"`);
    const step16 = stepOf(OWN, 16);
    expect(step16).toContain(`"${checklistTitle("from-mx", ORG)}" is red`);
    expect(step16).toContain(`"${checklistTitle("spf", ORG)}" is red`);
    expect(step16).toContain(`"Paused: ${PLAN_TEXTS.limitReason}"`);
    expect(step16).toContain(`"Paused: ${PLAN_TEXTS.authorizedReason}"`);
    const prefix = `Emails to ${MAILTO} don't reach anyone`;
    expect(OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, ORG, FROM).startsWith(prefix)).toBe(true);
    expect(step16).toContain(`"${prefix}"`);
    const replyFailed = OWN_REPLY_TEST_TEXTS.replyFailed("…", FROM);
    expect(step16).toContain(`"${replyFailed.slice(0, replyFailed.indexOf(" Check the Spam folder"))}"`);
    const step14 = stepOf(OWN, 14);
    expect(step14).toContain(`"${filledTemplate("src/core/dns/checklist.ts", "A Google verification record is on ${d}.", { d: ORG })}"`);
    expect(step14).toContain(`"${filledTemplate("src/components/settings/domain/domain-age-form.tsx", "When did you buy ${domain}?", { domain: ORG })}"`);
  });

  it("a restore in the own-mailbox setup: the README and the Going-live guide say which clicks it undoes (review REPLIES-02)", () => {
    // The Last restore card's sentence (the backup is named by the card's first line), filled in from the server's text.
    const undone = filledTemplate("src/server/services/sending/restore.ts", "They replied clicks made after the backup${when}", { when: "", from: FROM });
    expect(undone).toMatch(/^They replied clicks made after the backup were undone by the restore\. /);
    expect(undone).toContain(`then click ${INBOX_CHECK_TEXTS.button(FROM)}. Live follow-ups wait until then.`);
    const restoring = README.slice(README.indexOf("### Restoring a backup"), README.indexOf("### Moving to a new PC"));
    expect(restoring).toContain(`"${undone}"`);
    expect(restoring).toMatch(/^5\. \*\*In the own-mailbox setup\*\*/m);
    const step5 = stepOf(GO_LIVE, 5);
    expect(step5).toContain(`"${undone}"`);
    expect(step5).toContain(`**${INBOX_CHECK_TEXTS.button(FROM)}**`);
  });

  it("the own-mailbox guide's way to the full setup follows the order that can be done", () => {
    expectInOrder(
      stepOf(OWN, 15),
      [
        "**Foundation**",
        "**Pause all sending**",
        "**Cancel campaign**",
        `**${OWN_MAILBOX_TEXTS.repliesAppLabel}**`,
        "**Save and connect**",
        `**${PLAN_TEXTS.planLabel}**`,
        "If sending is still paused, click **Resume sending**",
        "**Reply address**",
        "[step 7](2-mailgun-and-dns.md#7-add-the-dns-records)",
      ],
      "Own-mailbox guide, step 15",
    );
  });

  it("the own-mailbox guide never asks for a Mailgun MX record or an SPF value, and names _dmarc as the one record", () => {
    // Mailgun's MX hosts appear only in sentences that say never to add them.
    for (const line of OWN.split(/\r?\n/).filter((l) => /\bmx[ab]\.(eu\.)?mailgun\.org\b/i.test(l))) expect(line).toMatch(/\bnever\b/i);
    // No SPF value at all: only the record's first word, to say it stays as it is.
    expect(OWN).not.toMatch(/v=spf1(?!`)/);
    expect(OWN).not.toContain("include:");
    // The one DNS record to add, named once.
    expect(OWN.match(/v=DMARC1/g)).toHaveLength(1);
    expect(stepOf(OWN, 6)).toContain("**Value:** `v=DMARC1; p=none`");
    // The only MX values named are Zoho's, to put them back (step 16).
    const zoho = [...OWN.matchAll(/`(mx\d?\.zoho\.com)` \(priority (\d+)\)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(zoho).toEqual(["mx.zoho.com 10", "mx2.zoho.com 20", "mx3.zoho.com 50"]);
    expect(stepOf(OWN, 16)).toContain("Never add Mailgun's.");
  });

  it("the owner's docs name npm run dev only as the window to close, never as a way to start the app", () => {
    for (const rel of OWNER_DOCS) {
      for (const line of DOCS[rel].split(/\r?\n/).filter((l) => l.includes("npm run dev"))) expect(line, rel).toMatch(/\b(close|never)\b/i);
    }
    expect(stepOf(OWN, 1)).toContain("**Always start the app with start.bat, never `npm run dev`.**");
    expect(stepOf(OWN, 1)).toContain('"Port 3000 is already in use"');
  });

  it("no owner doc cites a section of a design file", () => {
    for (const rel of OWNER_DOCS) expect(DOCS[rel], rel).not.toContain("§");
  });

  it("the Mailgun guide points to the own-mailbox guide under its title, and step 6 names the choice and the plan", () => {
    const afterTitle = MAILGUN.split(/\r?\n/)
      .slice(1)
      .find((l) => l.trim() !== "");
    expect(afterTitle).toBe(
      "> Using polygonparadise.com itself on Mailgun's Free plan, with replies in contact@? Follow the [Own-mailbox guide](2-own-mailbox.md) instead.",
    );
    const step6 = stepOf(MAILGUN, 6);
    expect(step6).toContain(`**${OWN_MAILBOX_TEXTS.repliesLegend}:** **${OWN_MAILBOX_TEXTS.repliesAppLabel}**`);
    expect(step6).toContain(`"${SENDING_DOMAIN_TEXTS.website}"`);
    expect(step6).toContain(`Under **${PLAN_TEXTS.planLabel}** choose **${MAILGUN_PLAN_FACTS.foundation.label}**`);
    expect(step6).toContain("**Save these numbers**");
  });

  it("the Cloudflare guide is optional in the own-mailbox setup and forbids Email Routing there", () => {
    expect(CLOUDFLARE).toContain("**In the own-mailbox setup this guide is optional**");
    expect(stepOf(CLOUDFLARE, 1)).toContain(
      "In the own-mailbox setup, never switch on Cloudflare Email Routing for polygonparadise.com: your mail would stop reaching Zoho.",
    );
  });

  it("the Going-live guide adds the own-mailbox setup without renumbering: step 1, step 2's rows, the rehearsal and the switch", () => {
    const step1 = stepOf(GO_LIVE, 1);
    expect(step1).toContain(`**${OWN_MAILBOX_TEXTS.repliesLegend}** = **${OWN_MAILBOX_TEXTS.repliesOwnLabel}**`);
    expect(step1).toContain(`**${PLAN_TEXTS.planLabel}** = **${MAILGUN_PLAN_FACTS.free.label}**`);
    // Step 2: an un-numbered sentence after the pinned list, with the titles the Domain checklist shows for the domain.
    const step2 = stepOf(GO_LIVE, 2);
    const line = step2.split(/\r?\n/).find((l) => l.startsWith("In the own-mailbox setup the list is shorter: "));
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/^\d+\. /);
    const withRemote = line!.indexOf(" With remote access");
    expect(withRemote).toBeGreaterThan(-1);
    const titles = (publicAddress: boolean) => goLiveRowKeys(false, { ownMailbox: true, publicAddress }).map((k) => checklistTitle(k, ORG));
    expect([...line!.slice(0, withRemote).matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(titles(false));
    const extra = titles(true).filter((t) => !titles(false).includes(t));
    expect(extra).toEqual([CHECKLIST_ROW_TITLES.webhooks, CHECKLIST_ROW_TITLES["remote-access"]]);
    expect([...line!.slice(withRemote).matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(extra);
    expect(step2).toContain("the reply test passed by hand");
    // Step 3: the rehearsal by hand.
    const step3 = stepOf(GO_LIVE, 3);
    const own = step3.slice(step3.indexOf("**In the own-mailbox setup**"));
    expect(own.length).toBeLessThan(step3.length);
    expectInOrder(
      own,
      [FROM, `**${THEY_REPLIED_TEXTS.button}**`, "**Stopped: they replied**", "Waiting for today's inbox check (Notifications › Inbox check).", `**${INBOX_CHECK_TEXTS.button(FROM)}**`],
      "Going-live guide, step 3",
    );
    // Step 13: switching the way the app sends is a change of the sending domain (O2).
    expect(stepOf(GO_LIVE, 13)).toContain(`Changing **${OWN_MAILBOX_TEXTS.repliesLegend}**`);
  });
});
