import { backupAge } from "@/core/backups/age";
import { domainOfAddress } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { UnsubscribeSetup } from "@/core/setting-types";
import type { ChecklistRow, ChecklistRowKey } from "@/core/system-state";

/**
 * Mode gates (PLAN B6.5, B6.8, M3-DESIGN §1.5 step 0, §4.5.7): what must be true before sending may use Mailgun.
 * Each function returns plain sentences ("blockers"), in display order; an empty list means "allowed". Pure; built in
 * wave 1 so the launch code (P3) and the settings pages and reply test (P5) share one set of rules and texts.
 *
 * The rows are SystemState "domain.check" rows (P4). A row blocks only when its status is "bad" or when it has never
 * been checked (no row with that key); "warn" ("still spreading"), "unknown" ("couldn't check right now"), "info"
 * and "off" never block. Go-live is stricter: every row it needs must be "ok".
 *
 * Shared From address (SHARED-FROM-DESIGN §3.3): every new input (`teamFrom`, `checkBeforeFromChange`,
 * `spamPlacements`) is optional; absent means per-person mode and gives exactly the sentences of before.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, §7.5): every new input (`ownMailbox`, `publicAddress`, `planDailyLimit`)
 * is optional too; absent means app mode and gives exactly the sentences of before.
 */

/** Every sentence these gates can return, so pages and tests can refer to them. */
export const MODE_GATE_TEXTS = {
  practiceCopy: "The practice copy never sends real email.",
  connect: "Connect Mailgun first.",
  dns: "Mailgun hasn't confirmed your DNS records yet (Domain checklist).",
  trackingOff: "Open and click tracking must be off (Domain checklist › Apply recommended settings).",
  unsubscribe: "Mailgun's unsubscribe handling must be on (Domain checklist › Apply recommended settings).",
  webhooks:
    "Mailgun must be told where to send bounces and unsubscribes (Domain checklist › Apply recommended settings).",
  signingKey: "The webhook signing key isn't saved yet (Domain checklist › Apply recommended settings).",
  sendingAllowed: "Mailgun isn't accepting emails from your domain right now (Domain checklist).",
  /** Non-blocking warning shown with Test mode and Live (see `modeWarnings`). */
  emptyTestListWarning: "Your test list is empty, so nothing can be sent yet.",
  setupA: "Live campaigns need Setup A (Mailgun's unsubscribe handling). Settings › Domain checklist › Reply test.",
  replyTestPass: "Live campaigns start once the reply test has passed (Settings › Domain checklist › Reply test).",
  emptyTestListLaunch: "Your test list is empty, so a live campaign can't reach anyone yet.",
  modeForReplyTest: "Set sending to Test mode or Live first: the test emails go through Mailgun.",
  ownerRoute: "Your reply route isn't working yet. Click Apply recommended settings.",
  publicAddress: "Remote access doesn't work yet. Finish the Cloudflare guide.",
  testMailboxes: "Add your test mailboxes first in Settings › Sending & Mailgun.",
  setupForReplyTest: "Setup C isn't built yet, so the reply test runs with Setup A or B. Click Back to Setup A.",
  replyTestNotPassed: "The reply test hasn't passed yet.",
  paused: "Sending is paused.",
  // Go live (M6-DESIGN §2.4).
  checkStale:
    "The Domain checklist was last checked more than an hour ago. Click Check again on the Domain checklist, then come back.",
  liveTestNone: "Send one live campaign to your test list first, and check that it arrived (Going-live guide, step 3).",
  liveTestSent: "The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page again.",
  workerStopped: "The background sender isn't running. Double-click start.bat on the office PC.",
  // Shared From address (SHARED-FROM-DESIGN §3.3).
  /** The from-mx row is "bad": shown for Live, the reply test and a LIVE launch, right after the DNS sentence. */
  fromMx:
    "Mail for your main domain points to Mailgun or is missing. It must stay with your mail provider, never Mailgun (Domain checklist).",
  /** No from-mx row yet (e.g. right after the From address was saved). */
  fromMxUnchecked:
    "The Domain checklist hasn't checked your main domain's mail servers (MX) yet. Click Check again on the Domain checklist.",
  /**
   * Going live: the checklist is fresh by the hour rule but older than the last From address change (instead of
   * checkStale). Since review SETTING-1 a sending-domain change (a region-only move too) restarts evidence the same way,
   * so the sentence names both.
   */
  checkBeforeFromChange:
    "The Domain checklist was checked before the From address or the sending domain changed. Click Check again on the Domain checklist, then come back.",
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, O38).
  /** The reply test waits for the DMARC row (present and not "bad"), so its emails don't report dmarc=none. */
  dmarcFirst:
    "Add the DMARC record first (the DMARC row of the Domain checklist) and wait until it shows Done, so the test emails can pass DMARC.",
  /**
   * Own-mailbox mode, instead of `fromMx` (review SCREENS-11, DOMAIN-8): the row is also red for Cloudflare Email Routing
   * there (`ownMxCause`), and the sending domain is the main domain itself.
   */
  fromMxOwn:
    "Mail for your domain doesn't go to your mail provider: it points to Mailgun or Cloudflare Email Routing, or is missing. It must stay with your mail provider, never Mailgun (Domain checklist).",
  /** Own-mailbox mode, instead of `liveTestNone` (review SCREENS-11): the own guide's live-test step. */
  liveTestNoneOwn: "Send one live campaign to your test list first, and check that it arrived (Own-mailbox guide, step 10).",
} as const;

/** The go-live card's "Recommended first:" sentences (M6-DESIGN §2.4), in display order. Never blocking. */
export const GO_LIVE_RECOMMENDATION_TEXTS = {
  domainAge: "Your sending domain is less than 30 days old. Wait before real campaigns (Domain checklist › Domain age).",
  monthlyLimit: "Set Mailgun's monthly safety limit (Mailgun guide, step 9).",
  checks: "Try address checks once (Settings › Deliverability): after going live, live campaigns only email checked addresses.",
  secondFolder: "Choose a second backup folder in Settings › Backups, so a copy survives if this PC's disk fails.",
  backupOld: "Make a backup first: the newest is more than 36 hours old (Settings › Backups).",
  backupNever: "Make a first backup in Settings › Backups.",
  accessOff: "Cloudflare Access is off, so anyone who finds the address sees the app's sign-in page.",
  appFolder: (name: string): string =>
    `The app folder is inside ${name}, which OneDrive, a sync program or Windows' ransomware protection can take over. Move it to C:\\Outreach first (Going-live guide, step 4).`,
  restore: "Try a practice restore before you go live (Going-live guide, step 5).",
  templates: "Read your master template and follow-ups once: they go to real prospects from now on (Templates).",
  aiModel: "Test the AI model once (Settings › AI).",
  // Shared From address (SHARED-FROM-DESIGN §3.3).
  /** `where`: the mailboxes whose reply-test email landed in spam, e.g. "Outlook.com (tess@outlook.com)". */
  spamPlacement: (where: string): string =>
    `The reply test's email landed in spam at ${where}. Emails from your From address may land in spam there at first: start with small campaigns and watch the replies.`,
  postmasterTeam: (org: string): string =>
    `Add ${org} to Google Postmaster Tools, so you can watch how Gmail rates the domain your everyday email shares (Mailgun guide, step 16).`,
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4).
  /** Instead of `postmasterTeam`, which points into the Mailgun guide. */
  postmasterOwn: (d: string): string =>
    `Add ${d} to Google Postmaster Tools, so you can watch how Gmail rates the domain your everyday email shares (Own-mailbox guide, step 14).`,
  /** While the plan is Free (it has a daily limit): the account may only send to authorized recipients. */
  authorizedCheck:
    "Check in Mailgun that your account can email anyone: if it says free accounts only send to authorized recipients, add a payment card (Account › Billing). Otherwise the first live email to a prospect pauses sending.",
  /** While the plan has a daily limit. */
  planUpgrade:
    "On Mailgun's Free plan the app sends at most 90 campaign emails a day, keeps 1 day of logs and uses http unsubscribe links. Mailgun's Foundation plan lifts all three and lets replies reach the app (Own-mailbox guide, step 15).",
  /**
   * Replaces `checks` while the plan has a daily limit (Free) and no check was tried. Review SCREENS-01: there is no other
   * checker to choose, and checks aren't part of the Free plan: Mailgun sells them as an add-on ("Email Validations",
   * from $1.20 per 100 on its pricing page, https://www.mailgun.com/pricing/, read 2026-09-28; research
   * verification-reference.md §5.1). Nothing is needed to go live; live campaigns after it email checked addresses only.
   */
  checksFree:
    "Address checks are optional but paid: Mailgun's Free plan doesn't include them (the Email Validations add-on costs about 1 cent per address). Going live doesn't need them, but after going live, live campaigns only email checked addresses. Try one check in Settings › Deliverability › Test address checks; if Mailgun refuses it, add Email Validations in Mailgun (Account › Billing) before your first real campaign.",
} as const;

/**
 * The checklist rows Live mode needs, grouped by the sentence shown when any of them is missing. "DNS confirmed"
 * covers Mailgun's own confirmation plus the records it checks: SPF and DKIM (sending), MX (replies) and the
 * tracking CNAME (unsubscribe links).
 */
const LIVE_ROW_GATES: ReadonlyArray<{ keys: readonly ChecklistRowKey[]; text: string }> = [
  { keys: ["mailgun-domain", "spf", "dkim", "mx", "tracking-cname"], text: MODE_GATE_TEXTS.dns },
  { keys: ["tracking-off"], text: MODE_GATE_TEXTS.trackingOff },
  { keys: ["unsubscribe"], text: MODE_GATE_TEXTS.unsubscribe },
  { keys: ["webhooks"], text: MODE_GATE_TEXTS.webhooks },
  { keys: ["signing-key"], text: MODE_GATE_TEXTS.signingKey },
  { keys: ["sending-allowed"], text: MODE_GATE_TEXTS.sendingAllowed },
];

/** The rows that must be "ok" before going live (M6), in checklist order. */
export const GO_LIVE_ROW_KEYS: readonly ChecklistRowKey[] = [
  "mailgun-domain",
  "spf",
  "dkim",
  "mx",
  "tracking-cname",
  "https-links",
  "dmarc",
  "tracking-off",
  "unsubscribe",
  "spam-filter",
  "retention",
  "signing-key",
  "webhooks",
  "reply-routes",
  "sending-allowed",
  "remote-access",
];

/** Shared-From mode (SHARED-FROM-DESIGN §3.3): the extra rows going live needs "ok". */
export const GO_LIVE_TEAM_FROM_ROW_KEYS: readonly ChecklistRowKey[] = ["from-mx"];

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O9, O10, §3.4): Live mode's "DNS confirmed" rows. No `mx` row exists in this
 * mode: the sending domain's MX stays with the mail provider and is guarded by the from-mx row instead.
 */
const OWN_MAILBOX_DNS_KEYS: readonly ChecklistRowKey[] = ["mailgun-domain", "spf", "dkim", "tracking-cname"];

/**
 * The rows that must be "ok" before going live: `GO_LIVE_ROW_KEYS` in per-person mode (unchanged); in shared-From mode
 * also `GO_LIVE_TEAM_FROM_ROW_KEYS`, placed in checklist order (from-mx right after dmarc, where the checklist shows it).
 *
 * Own-mailbox mode (`opts.ownMailbox`, MAIN-DOMAIN-DESIGN O14, §3.4): mailgun-domain, spf, dkim, tracking-cname, dmarc,
 * from-mx, tracking-off, unsubscribe, signing-key, [webhooks], sending-allowed, [remote-access] (the two in brackets
 * only with a public address, O21; never https-links, whose go-live tick covers it, O20). `teamFrom` is then ignored.
 * Without `opts.ownMailbox`: exactly as before.
 */
export function goLiveRowKeys(teamFrom: boolean, opts: { ownMailbox?: boolean; publicAddress?: boolean } = {}): readonly ChecklistRowKey[] {
  if (opts.ownMailbox === true) {
    const pub = opts.publicAddress === true;
    return [
      "mailgun-domain",
      "spf",
      "dkim",
      "tracking-cname",
      "dmarc",
      "from-mx",
      "tracking-off",
      "unsubscribe",
      "signing-key",
      ...(pub ? (["webhooks"] as const) : []),
      "sending-allowed",
      ...(pub ? (["remote-access"] as const) : []),
    ];
  }
  if (!teamFrom) return GO_LIVE_ROW_KEYS;
  const at = GO_LIVE_ROW_KEYS.indexOf("dmarc") + 1;
  return [...GO_LIVE_ROW_KEYS.slice(0, at), ...GO_LIVE_TEAM_FROM_ROW_KEYS, ...GO_LIVE_ROW_KEYS.slice(at)];
}

/** Row titles (Settings › Domain checklist, §5.3) for rows that were never checked, so they have no title yet. */
export const CHECKLIST_ROW_TITLES: Readonly<Record<ChecklistRowKey, string>> = {
  "mailgun-domain": "Mailgun knows your domain",
  spf: "Mailgun may send for your domain (SPF)",
  dkim: "Your emails are signed (DKIM)",
  mx: "Replies reach the app (MX)",
  "tracking-cname": "Unsubscribe links work (tracking CNAME)",
  "https-links": "Unsubscribe links are secure (HTTPS)",
  dmarc: "Mail servers know your policy (DMARC)",
  "tracking-off": "Open and click tracking are off",
  unsubscribe: "Unsubscribe handling is on",
  "spam-filter": "Spam filter marks, never deletes",
  retention: "Stored replies are kept",
  "signing-key": "Webhook signing key saved",
  webhooks: "Mailgun tells the app what happened",
  "reply-routes": "Replies reach each sender",
  "sending-allowed": "Mailgun lets you send",
  "monthly-limit": "Monthly safety limit",
  "remote-access": "Remote access works",
  "reply-test": "Reply test",
  postmaster: "Gmail dashboard",
  "domain-age": "Domain age",
  // Shared-From mode (SHARED-FROM-DESIGN §3.2): checked rows are titled with the From domain (checklistTitle).
  "from-mx": "Mail for your main domain stays with your mail provider (MX)",
  "from-spf": "Your main domain's SPF record (your everyday email)",
};

function rowFor(rows: readonly ChecklistRow[], key: ChecklistRowKey): ChecklistRow | undefined {
  return rows.find((r) => r.key === key);
}

/** Missing = never checked, or checked and "bad". */
function isMissing(rows: readonly ChecklistRow[], key: ChecklistRowKey): boolean {
  const row = rowFor(rows, key);
  return !row || row.status === "bad";
}

/** "Ali", "Ali and Sara", "Ali, Sara and Bo". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What Test mode needs (Settings › Sending & Mailgun, and a TEST launch): a connected Mailgun, outside the practice
 * copy.
 */
export function testModeBlockers(ctx: { connected: boolean; practiceCopy: boolean }): string[] {
  if (ctx.practiceCopy) return [MODE_GATE_TEXTS.practiceCopy];
  if (!ctx.connected) return [MODE_GATE_TEXTS.connect];
  return [];
}

/**
 * What Live mode needs (Settings › Sending & Mailgun): Mailgun connected; DNS confirmed; open and click tracking off;
 * unsubscribe handling on; webhooks registered; the signing key saved; Mailgun accepting emails. The practice copy
 * only ever gets its own sentence, and a Mailgun that isn't connected only "Connect Mailgun first." (the checklist
 * rows mean nothing before that). An empty test list doesn't block here: see `modeWarnings`.
 *
 * Shared-From mode (`teamFrom: true`, SHARED-FROM-DESIGN §3.3): right after the DNS sentence's place, a never-checked
 * from-mx row adds `fromMxUnchecked` and a "bad" one `fromMx` ("warn", "unknown" and "ok" add nothing). Absent = per-person.
 *
 * Own-mailbox mode (`ownMailbox: true`, MAIN-DOMAIN-DESIGN §3.4): the DNS sentence covers mailgun-domain, spf, dkim and
 * tracking-cname (no `mx` row exists), and the from-mx sentences follow it as in shared-From mode, whether or not a
 * From is saved (O10); a "bad" row says `fromMxOwn` (review SCREENS-11: it names Cloudflare Email Routing too). The other
 * gates as before (an "info" webhooks row passes: it isn't "bad", O21).
 */
export function liveModeBlockers(
  rows: readonly ChecklistRow[],
  ctx: { connected: boolean; practiceCopy: boolean; testListSize: number; teamFrom?: boolean; ownMailbox?: boolean },
): string[] {
  if (ctx.practiceCopy) return [MODE_GATE_TEXTS.practiceCopy];
  if (!ctx.connected) return [MODE_GATE_TEXTS.connect];
  const own = ctx.ownMailbox === true;
  const out: string[] = [];
  LIVE_ROW_GATES.forEach((gate, i) => {
    const keys = i === 0 && own ? OWN_MAILBOX_DNS_KEYS : gate.keys;
    if (keys.some((key) => isMissing(rows, key))) out.push(gate.text);
    if (i === 0 && (ctx.teamFrom === true || own)) {
      const fromMx = rowFor(rows, "from-mx");
      if (!fromMx) out.push(MODE_GATE_TEXTS.fromMxUnchecked);
      else if (fromMx.status === "bad") out.push(own ? MODE_GATE_TEXTS.fromMxOwn : MODE_GATE_TEXTS.fromMx);
    }
  });
  return out;
}

/**
 * liveModeBlockers + Setup A + the reply test passed on the current domain: what a LIVE launch needs (P3 calls it
 * at launch and for the wizard's `modeBlockers`). Before go-live an empty test list blocks too, because a live
 * campaign can then only reach the test list; after go-live (`goLive`, M6-DESIGN §2.3) it doesn't.
 */
export function liveLaunchBlockers(
  rows: readonly ChecklistRow[],
  ctx: {
    connected: boolean;
    practiceCopy: boolean;
    testListSize: number;
    setup: UnsubscribeSetup;
    replyTestPassedOnDomain: boolean;
    /**
     * M6 (M6-DESIGN §2.3): today's `sending.goLive`. After go-live an empty test list no longer blocks a LIVE launch.
     * Absent = false (before go-live).
     */
    goLive?: boolean;
    /** SHARED-FROM-DESIGN §3.3: a valid shared From address is saved (passed through to liveModeBlockers). */
    teamFrom?: boolean;
    /**
     * MAIN-DOMAIN-DESIGN §3.4: own-mailbox mode (passed through to liveModeBlockers). A stored setup other than A then
     * says `OWN_MAILBOX_TEXTS.setupNotNormal` (MODE_GATE_TEXTS.setupA is never shown in this mode).
     */
    ownMailbox?: boolean;
  },
): string[] {
  if (ctx.practiceCopy) return [MODE_GATE_TEXTS.practiceCopy];
  const out = liveModeBlockers(rows, ctx);
  if (ctx.setup !== "A") out.push(ctx.ownMailbox === true ? OWN_MAILBOX_TEXTS.setupNotNormal : MODE_GATE_TEXTS.setupA);
  if (!ctx.replyTestPassedOnDomain) out.push(MODE_GATE_TEXTS.replyTestPass);
  if (ctx.goLive !== true && !(ctx.testListSize > 0)) out.push(MODE_GATE_TEXTS.emptyTestListLaunch);
  return out;
}

/**
 * §1.5 step 0: what the reply test needs before its emails may go out, because results from a half-set-up domain
 * mean nothing. Sending mode Test or Live; every liveModeBlockers item; the Owner's reply route working; the public
 * address working; at least one test mailbox; Setup A or B.
 *
 * Own-mailbox mode (`ownMailbox: true`, MAIN-DOMAIN-DESIGN O9, O13, O38, §3.4): no reply route and no public address are
 * needed (`ownerRouteOk` and `publicAddressOk` are ignored); the DMARC row must exist and not be "bad" (`dmarcFirst`, so
 * the test emails don't report dmarc=none); and only Setup A (the stored setup is always A there; a restored database
 * that says otherwise gets `OWN_MAILBOX_TEXTS.setupNotNormal`).
 */
export function replyTestBlockers(
  rows: readonly ChecklistRow[],
  ctx: {
    mode: "DRY_RUN" | "TEST" | "LIVE";
    connected: boolean;
    practiceCopy: boolean;
    testListSize: number;
    ownerRouteOk: boolean;
    publicAddressOk: boolean;
    setup: UnsubscribeSetup;
    /** SHARED-FROM-DESIGN §3.3: a valid shared From address is saved (passed through to liveModeBlockers). */
    teamFrom?: boolean;
    /** MAIN-DOMAIN-DESIGN §3.4: own-mailbox mode (passed through to liveModeBlockers). Absent = app mode. */
    ownMailbox?: boolean;
  },
): string[] {
  if (ctx.practiceCopy) return [MODE_GATE_TEXTS.practiceCopy];
  const own = ctx.ownMailbox === true;
  const out: string[] = [];
  if (ctx.mode === "DRY_RUN") out.push(MODE_GATE_TEXTS.modeForReplyTest);
  out.push(...liveModeBlockers(rows, ctx));
  if (own) {
    if (isMissing(rows, "dmarc")) out.push(MODE_GATE_TEXTS.dmarcFirst);
  } else {
    if (!ctx.ownerRouteOk) out.push(MODE_GATE_TEXTS.ownerRoute);
    if (!ctx.publicAddressOk) out.push(MODE_GATE_TEXTS.publicAddress);
  }
  if (!(ctx.testListSize > 0)) out.push(MODE_GATE_TEXTS.testMailboxes);
  if (own) {
    if (ctx.setup !== "A") out.push(OWN_MAILBOX_TEXTS.setupNotNormal);
  } else if (ctx.setup !== "A" && ctx.setup !== "B") {
    out.push(MODE_GATE_TEXTS.setupForReplyTest);
  }
  return out;
}

/**
 * One go-live row that isn't "ok", in words: missing or "bad" → "<title>: not done yet (Domain checklist)."; "warn",
 * "unknown", "info" or "off" → "<title>: needs attention: <the row's text without its final period> (Domain
 * checklist)." (e.g. DNS "still spreading"), so the Owner reads what to do instead of "not done".
 */
function goLiveRowSentence(key: ChecklistRowKey, row: ChecklistRow | undefined): string {
  const title = row?.title?.trim() || CHECKLIST_ROW_TITLES[key];
  if (!row || row.status === "bad") return `${title}: not done yet (Domain checklist).`;
  const text = (row.text ?? "").trim().replace(/\.+$/, "");
  return text ? `${title}: needs attention: ${text} (Domain checklist).` : `${title}: needs attention (Domain checklist).`;
}

/**
 * What going live needs (M6-DESIGN §2.4, "Before going live:"), in display order: the practice copy (its sentence
 * alone); Mailgun not connected ("Connect Mailgun first." alone); the Domain checklist checked within the hour; every
 * row of `GO_LIVE_ROW_KEYS` "ok" (remote access "ok" includes the Cloudflare Access opt-out); Setup A; the reply test
 * passed; sending not paused; a working reply route for every sender; a delivered live test on the current domain; the
 * background sender running. The M6 inputs are optional: absent = satisfied, so older callers are unchanged.
 * Shared-From mode (SHARED-FROM-DESIGN §3.3): `teamFrom` adds the from-mx row (`goLiveRowKeys(true)`), and a checklist
 * that is stale only because it predates the last From change says `checkBeforeFromChange` instead of `checkStale`.
 */
export function goLiveBlockers(
  rows: readonly ChecklistRow[],
  ctx: {
    replyTestPassed: boolean;
    paused: boolean;
    practiceCopy: boolean;
    sendersWithoutRoute: string[];
    /** M6: Mailgun connected (domain and a usable key). */
    connected?: boolean;
    /** M6: the Domain checklist was checked within the last hour, without an error, after the Access choice last changed. */
    checkFresh?: boolean;
    /** M6: the unsubscribe setup chosen with the reply test (live campaigns need "A"). */
    setup?: UnsubscribeSetup;
    /** M6: the live test (M6-DESIGN §0.3): none yet, sent but not delivered, or delivered. */
    liveTest?: "none" | "sent" | "delivered";
    /** M6: the background sender's heartbeat is fresh (getWorkerStatus().running). */
    workerRunning?: boolean;
    /** SHARED-FROM-DESIGN §3.3: a valid shared From address is saved (the from-mx row must be "ok" too). */
    teamFrom?: boolean;
    /**
     * SHARED-FROM-DESIGN §3.3: `checkFresh` is false only because the check is older than the last From address change;
     * the first sentence is then `checkBeforeFromChange` instead of `checkStale`.
     */
    checkBeforeFromChange?: boolean;
    /**
     * MAIN-DOMAIN-DESIGN O14, §3.4: own-mailbox mode: the rows are `goLiveRowKeys(false, { ownMailbox, publicAddress })`,
     * nobody needs a reply route (`sendersWithoutRoute` is ignored), a setup other than A says
     * `OWN_MAILBOX_TEXTS.setupNotNormal` and no live test yet says `liveTestNoneOwn` (review SCREENS-11). Absent = app
     * mode, exactly as before.
     */
    ownMailbox?: boolean;
    /** MAIN-DOMAIN-DESIGN O21: own-mailbox mode, a public address is set (the webhooks and remote-access rows count). */
    publicAddress?: boolean;
  },
): string[] {
  if (ctx.practiceCopy) return [MODE_GATE_TEXTS.practiceCopy];
  if (ctx.connected === false) return [MODE_GATE_TEXTS.connect];
  const own = ctx.ownMailbox === true;
  const out: string[] = [];
  if (ctx.checkFresh === false) {
    out.push(ctx.checkBeforeFromChange === true ? MODE_GATE_TEXTS.checkBeforeFromChange : MODE_GATE_TEXTS.checkStale);
  }
  for (const key of goLiveRowKeys(ctx.teamFrom === true, { ownMailbox: own, publicAddress: ctx.publicAddress })) {
    const row = rowFor(rows, key);
    if (row?.status === "ok") continue;
    out.push(goLiveRowSentence(key, row));
  }
  if (ctx.setup !== undefined && ctx.setup !== "A") out.push(own ? OWN_MAILBOX_TEXTS.setupNotNormal : MODE_GATE_TEXTS.setupA);
  if (!ctx.replyTestPassed) out.push(MODE_GATE_TEXTS.replyTestNotPassed);
  if (ctx.paused) out.push(MODE_GATE_TEXTS.paused);
  const names = own ? [] : ctx.sendersWithoutRoute.map((n) => n.trim()).filter(Boolean);
  if (names.length > 0) {
    out.push(`${joinNames(names)} ${names.length === 1 ? "has" : "have"} no working reply route.`);
  }
  if (ctx.liveTest === "none") out.push(own ? MODE_GATE_TEXTS.liveTestNoneOwn : MODE_GATE_TEXTS.liveTestNone);
  else if (ctx.liveTest === "sent") out.push(MODE_GATE_TEXTS.liveTestSent);
  if (ctx.workerRunning === false) out.push(MODE_GATE_TEXTS.workerStopped);
  return out;
}

/**
 * "Recommended first:" on the go-live card (M6-DESIGN §2.4, G10): things worth doing before real prospects get email,
 * never blocking, in this order: the domain is younger than 30 days (the Domain age row warns); Mailgun's monthly
 * safety limit (that row isn't "ok"); address checks never tried; no second backup folder; no backup, or the newest is
 * older than 36 hours; Cloudflare Access switched off; the app folder inside Pictures, OneDrive…; no practice restore
 * resumed yet; reading the templates; testing the AI model (the last two always, before go-live).
 * Shared-From mode (SHARED-FROM-DESIGN §3.3): the reply test's spam placements after the monthly-limit line, and Google
 * Postmaster for the main domain (unless the postmaster row is "ok") after the address-checks line. Absent = per-person.
 *
 * Own-mailbox mode (`ownMailbox`, MAIN-DOMAIN-DESIGN §3.4; `teamFrom` carries the own From): Google Postmaster says
 * `postmasterOwn(d)` instead of `postmasterTeam`; while the plan has a daily limit (`planDailyLimit`, Free) the checks
 * line is `checksFree`, followed by `authorizedCheck` and `planUpgrade`. A monthly-limit row that is "info" (a plan with
 * a daily limit needs no monthly safety limit, O12; no app-mode row is ever "info") adds no line.
 */
export function goLiveRecommendations(ctx: {
  rows: readonly ChecklistRow[];
  checksTried: boolean;
  secondFolder: string | null;
  newestBackupAt: Date | null;
  accessOff: boolean;
  riskyFolder: string | null;
  restoreDone: boolean;
  now: Date;
  /** SHARED-FROM-DESIGN §3.3: the valid shared From address, or null/absent in per-person mode. */
  teamFrom?: string | null;
  /** SHARED-FROM-DESIGN F12: the reply test's mailboxes whose email landed in spam, e.g. "Outlook.com (tess@outlook.com)". */
  spamPlacements?: readonly string[];
  /** MAIN-DOMAIN-DESIGN §3.4: own-mailbox mode (`teamFrom` = the own From). Absent = app mode. */
  ownMailbox?: boolean;
  /** MAIN-DOMAIN-DESIGN O22, O23: the daily limit of the plan in force (`loadPlanLimits()`), or null/absent. */
  planDailyLimit?: number | null;
}): string[] {
  const T = GO_LIVE_RECOMMENDATION_TEXTS;
  const own = ctx.ownMailbox === true;
  const limited = own && typeof ctx.planDailyLimit === "number";
  const out: string[] = [];
  // The age row is "info" while no purchase date is entered: "less than 30 days old" would be a guess, so only a
  // known young domain ("warn") is named.
  const age = rowFor(ctx.rows, "domain-age");
  if (age && (age.status === "warn" || age.status === "bad")) out.push(T.domainAge);
  const limit = rowFor(ctx.rows, "monthly-limit");
  if (limit && limit.status !== "ok" && limit.status !== "info") out.push(T.monthlyLimit);
  const spam = (ctx.spamPlacements ?? []).map((s) => s.trim()).filter(Boolean);
  if (spam.length > 0) out.push(T.spamPlacement(spam.join(", ")));
  if (!ctx.checksTried) out.push(limited ? T.checksFree : T.checks);
  const org = ctx.teamFrom ? domainOfAddress(ctx.teamFrom.trim()) : null;
  if (org && rowFor(ctx.rows, "postmaster")?.status !== "ok") out.push(own ? T.postmasterOwn(org) : T.postmasterTeam(org));
  if (limited) out.push(T.authorizedCheck, T.planUpgrade);
  if (!(ctx.secondFolder ?? "").trim()) out.push(T.secondFolder);
  // The same 36 hours as Settings › Backups and the dashboard (@/core/backups/age).
  const backup = backupAge(ctx.newestBackupAt, ctx.now).state;
  if (backup === "never") out.push(T.backupNever);
  else if (backup === "stale") out.push(T.backupOld);
  if (ctx.accessOff) out.push(T.accessOff);
  if (ctx.riskyFolder) out.push(T.appFolder(ctx.riskyFolder));
  if (!ctx.restoreDone) out.push(T.restore);
  out.push(T.templates, T.aiModel);
  return out;
}

/**
 * Non-blocking warnings for the chosen mode (Settings › Sending & Mailgun): with an empty test list, Test mode can't
 * send anything (it only ever emails the test list, also after go-live, M6-DESIGN G3), and neither can Live before
 * go-live.
 */
export function modeWarnings(
  mode: "DRY_RUN" | "TEST" | "LIVE",
  ctx: { testListSize: number; goLive?: boolean },
): string[] {
  if (mode === "DRY_RUN" || (mode === "LIVE" && ctx.goLive === true)) return [];
  return ctx.testListSize > 0 ? [] : [MODE_GATE_TEXTS.emptyTestListWarning];
}
