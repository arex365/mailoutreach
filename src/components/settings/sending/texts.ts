/**
 * Wording shared by Settings › Sending & Mailgun (M3-DESIGN §5.2) and its actions. Pure and browser-safe. The mode and
 * test-list words know about go-live (M6-DESIGN §2.7): before it, Live only reaches the test list; after it, Live
 * emails everyone eligible, while Test mode still only emails the test list (G3).
 */

type ModeKey = "DRY_RUN" | "TEST" | "LIVE";

/** The mode in a sentence (toasts, activity), before go-live: "live (test list only)". */
export const MODE_WORDS: Record<ModeKey, string> = {
  DRY_RUN: "dry run",
  TEST: "test mode",
  LIVE: "live (test list only)",
};

/** The mode in a sentence after go-live: "live". */
export const MODE_WORDS_AFTER_GO_LIVE: Record<ModeKey, string> = { ...MODE_WORDS, LIVE: "live" };

/** "Sending is set to live (test list only)." before go-live, "… to live." after it. */
export function modeWords(goLive: boolean): Record<ModeKey, string> {
  return goLive ? MODE_WORDS_AFTER_GO_LIVE : MODE_WORDS;
}

/** The Sending mode choices, before go-live. */
export const MODE_OPTION_TEXTS: Record<ModeKey, { title: string; text: string }> = {
  DRY_RUN: {
    title: "Dry run",
    text: "Nothing leaves this PC. Campaigns fill the dry-run outbox so you can read every email.",
  },
  TEST: {
    title: "Test mode",
    text: "Emails go to Mailgun's test mode, only to your test list: accepted, never delivered, and billed like normal emails. Use it only to check the connection.",
  },
  LIVE: {
    title: "Live (test list only)",
    text: "Real emails from your sending domain, inside sending hours and under the daily limit, but only to the addresses on your test list until you go live. Live campaigns start once the reply test has passed.",
  },
};

/** The Sending mode choices after go-live: Live emails everyone eligible; Test mode still only the test list. */
export const MODE_OPTION_TEXTS_AFTER_GO_LIVE: Record<ModeKey, { title: string; text: string }> = {
  ...MODE_OPTION_TEXTS,
  LIVE: {
    title: "Live",
    text: "Real emails from your sending domain to everyone eligible, inside sending hours and under the daily limit.",
  },
};

export function modeOptionTexts(goLive: boolean): Record<ModeKey, { title: string; text: string }> {
  return goLive ? MODE_OPTION_TEXTS_AFTER_GO_LIVE : MODE_OPTION_TEXTS;
}

/**
 * "1 live campaign is still sending: <names>. New campaigns use the new mode; pause that campaign, or use Pause all
 * sending, to stop it." (§2.1: shown, never blocking, when switching away while such campaigns are scheduled or running.)
 */
export function stillSendingWarning(campaigns: ReadonlyArray<{ name: string; mode: string }>): string | null {
  const n = campaigns.length;
  if (n === 0) return null;
  const kind = campaigns.every((c) => c.mode === "LIVE") ? "live" : campaigns.every((c) => c.mode === "TEST") ? "test-mode" : "test or live";
  const names = campaigns.map((c) => `“${c.name}”`).join(", ");
  return n === 1
    ? `1 ${kind} campaign is still sending: ${names}. New campaigns use the new mode; pause that campaign, or use Pause all sending, to stop it.`
    : `${n} ${kind} campaigns are still sending: ${names}. New campaigns use the new mode; pause those campaigns, or use Pause all sending, to stop them.`;
}

/**
 * Where "Send me a test" goes, in the words of the way of sending (review SCREENS-11): "your own reply inbox" in app mode;
 * in own-mailbox mode there is no reply inbox (replies go to the From mailbox), and My profile calls the field "Inbox for
 * your test emails" (`OWN_MAILBOX_TEXTS.testInboxLabel`).
 */
function selfTestInbox(ownMailbox: boolean): string {
  return ownMailbox ? "your inbox for test emails (My profile)" : "your own reply inbox";
}

/**
 * The Live confirmation (§5.2): who real email reaches before go-live, and after it. `ownMailbox` (review SCREENS-11):
 * own-mailbox mode's words for where "Send me a test" goes; absent = app mode, unchanged.
 */
export function liveConfirmText(testList: readonly string[], goLive = false, ownMailbox = false): string {
  if (goLive) return "New campaigns will send real email to everyone eligible, inside sending hours and under the daily limit. Switch to live?";
  const who = testList.length > 0 ? testList.join(", ") : "(you haven't added any yet)";
  return `Real emails will go to your test-list addresses only: ${who}, and to ${selfTestInbox(ownMailbox)} when you click Send me a test. Everyone else is left out until you go live. Switch to live?`;
}

/**
 * The connection status on Settings › Sending & Mailgun itself when a domain is saved but no usable key: the app-wide
 * sentences say "Open Settings › Sending & Mailgun", which is where the Owner already is.
 */
export const CONNECTION_STATUS_TEXTS = {
  noKey: "Not connected: paste your API key below and click Save and connect.",
  mismatch:
    "Not connected: the saved key doesn't fit this server (a test key on the real Mailgun, or the other way round). Paste the right key below and click Save and connect.",
  unreadable:
    "Not connected: the saved key can't be read because the app's encryption key changed. Paste the key again below and click Save and connect.",
  notYet: "Not connected yet.",
} as const;

/** The Test list card, before go-live. */
export const TEST_LIST_TEXTS = {
  description: "The mailboxes that can receive real email before you go live.",
  empty: "No test addresses yet. Add two or three mailboxes that aren't your reply inbox, ideally one Gmail and one Outlook.com.",
  hint: "Until you go live, real email only reaches these addresses, and your own reply inbox when you click Send me a test. Until then they also count as checked, so test campaigns don't need address checks. Emails to them don't count as 'emailed', so you can test again at any time.",
} as const;

/** The Test list card after go-live: Test mode and the reply test still use it (G9). */
export const TEST_LIST_TEXTS_AFTER_GO_LIVE = {
  ...TEST_LIST_TEXTS,
  description: "The mailboxes Test mode and the reply test use.",
  hint: "Test mode only emails these addresses, and the reply test uses them. Emails to them in a live campaign now count as emailed.",
} as const;

/**
 * The Test list card in own-mailbox mode, before go-live (review SCREENS-11): no "reply inbox" in this mode; "Send me a
 * test" goes to each person's inbox for test emails (My profile).
 */
export const TEST_LIST_TEXTS_OWN = {
  ...TEST_LIST_TEXTS,
  empty: "No test addresses yet. Add two or three mailboxes that aren't your inbox for test emails, ideally one Gmail and one Outlook.com.",
  hint: `Until you go live, real email only reaches these addresses, and ${selfTestInbox(true)} when you click Send me a test. Until then they also count as checked, so test campaigns don't need address checks. Emails to them don't count as 'emailed', so you can test again at any time.`,
} as const;

/** The Test list card's texts: before or after go-live; `ownMailbox` (review SCREENS-11) picks own-mailbox mode's words. */
export function testListTexts(goLive: boolean, opts: { ownMailbox?: boolean } = {}): { description: string; empty: string; hint: string } {
  if (goLive) return opts.ownMailbox ? { ...TEST_LIST_TEXTS_AFTER_GO_LIVE, empty: TEST_LIST_TEXTS_OWN.empty } : TEST_LIST_TEXTS_AFTER_GO_LIVE;
  return opts.ownMailbox ? TEST_LIST_TEXTS_OWN : TEST_LIST_TEXTS;
}
