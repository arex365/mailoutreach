import { describe, expect, it } from "vitest";
import { checkMatchesMode } from "@/core/dns/check-state";
import { REPLY_NOTIFICATION, popupGroupOf } from "@/core/notification-types";
import { replyTestPassedFor } from "@/core/reply-test";
import { GO_LIVE_COPY, goLiveDialogItems, type GoLiveWarmup } from "@/core/sending/go-live-copy";
import {
  CHECKLIST_ROW_TITLES,
  GO_LIVE_RECOMMENDATION_TEXTS as R,
  GO_LIVE_ROW_KEYS,
  MODE_GATE_TEXTS as T,
  goLiveBlockers,
  goLiveRecommendations,
  goLiveRowKeys,
  liveLaunchBlockers,
  liveModeBlockers,
  replyTestBlockers,
} from "@/core/sending/mode-gates";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { STATE_KEYS, type CheckStatus, type ChecklistRow, type ChecklistRowKey } from "@/core/system-state";
import { parseDomainCheckState, parseInboxCheckState, parsePacerState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { waitingText } from "@/components/campaigns/format";

/**
 * Step C of docs/dev/MAIN-DOMAIN-DESIGN.md: the new SystemState key, wait reasons and optional fields and their parsers
 * (§7.2), `checkMatchesMode` (O36), `replyTestPassedFor`'s mode rule (O13, O15), the own-mailbox branches of the mode
 * gates and the go-live copy (§3.4, §7.5), the notification type and the waiting lines. With the new inputs absent
 * everything answers exactly as before.
 */

const D = "polygonparadise.com";
const FROM = `contact@${D}`;

// ───────────────────────── SystemState and settings shapes (§7.2) ─────────────────────────

describe("SystemState 'sending.inboxCheck' (O33)", () => {
  it("has its key and parses to { at, byUserId }, both null by default", () => {
    expect(STATE_KEYS.inboxCheck).toBe("sending.inboxCheck");
    for (const v of [undefined, null, "x", [], {}]) expect(parseInboxCheckState(v)).toEqual({ at: null, byUserId: null });
    expect(parseInboxCheckState({ at: "2026-09-28T04:10:00.000Z", byUserId: 3 })).toEqual({ at: "2026-09-28T04:10:00.000Z", byUserId: 3 });
    expect(parseInboxCheckState({ at: "not a date", byUserId: 0 })).toEqual({ at: null, byUserId: null });
    expect(parseInboxCheckState({ at: 5, byUserId: -2 })).toEqual({ at: null, byUserId: null });
    expect(parseInboxCheckState({ at: "2026-09-28T04:10:00Z", byUserId: 1.5 })).toEqual({ at: "2026-09-28T04:10:00Z", byUserId: null });
  });
});

describe("the new wait reasons", () => {
  it("survive the pacer's parser", () => {
    for (const reason of ["plan-limit", "inbox-check"] as const) {
      expect(parsePacerState({ waiting: { reason, until: null, at: "2026-09-28T04:10:00Z" } }).waiting?.reason).toBe(reason);
    }
  });

  it("have their waiting lines", () => {
    const ctx = { timeZone: "Asia/Karachi", now: new Date("2026-09-28T04:00:00Z") };
    expect(waitingText({ reason: "plan-limit", until: new Date("2026-09-28T09:05:00Z") }, ctx)).toBe(
      "Waiting: your Mailgun plan's daily limit is used up. The next email can go at 14:05.",
    );
    expect(waitingText({ reason: "plan-limit", until: null }, ctx)).toBe("Waiting: your Mailgun plan's daily limit is used up.");
    expect(waitingText({ reason: "inbox-check", until: null }, ctx)).toBe("Waiting for today's inbox check (Notifications › Inbox check).");
  });
});

describe("DomainCheckState.replies and lastGoodMx (O10, O36)", () => {
  const base = { domain: D, region: "US", checkedAt: "2026-09-28T04:00:00Z", lastVerifyAt: null, rows: [], error: null };

  it("leaves both out of states written before them", () => {
    const parsed = parseDomainCheckState(base);
    expect(parsed).toEqual(base);
    expect("replies" in parsed).toBe(false);
    expect("lastGoodMx" in parsed).toBe(false);
  });

  it("keeps a known mode and drops anything else", () => {
    expect(parseDomainCheckState({ ...base, replies: "own-mailbox" }).replies).toBe("own-mailbox");
    expect(parseDomainCheckState({ ...base, replies: "app" }).replies).toBe("app");
    for (const v of ["Own-mailbox", 1, null]) expect("replies" in parseDomainCheckState({ ...base, replies: v })).toBe(false);
  });

  it("keeps a well-formed last good MX (hosts lowercased, a trailing dot dropped), null as null, and drops anything else whole", () => {
    const zoho = [
      { priority: 10, host: "MX.zoho.com." },
      { priority: 20, host: "mx2.zoho.com" },
    ];
    expect(parseDomainCheckState({ ...base, lastGoodMx: zoho }).lastGoodMx).toEqual([
      { priority: 10, host: "mx.zoho.com" },
      { priority: 20, host: "mx2.zoho.com" },
    ]);
    expect(parseDomainCheckState({ ...base, lastGoodMx: null }).lastGoodMx).toBeNull();
    expect(parseDomainCheckState({ ...base, lastGoodMx: [] }).lastGoodMx).toEqual([]);
    const bad = [
      "mx.zoho.com",
      [{ priority: 10, host: "mx.zoho.com" }, { priority: 70_000, host: "mx2.zoho.com" }],
      [{ priority: 1.5, host: "mx.zoho.com" }],
      [{ priority: 10, host: "" }],
      [{ priority: 10, host: "not a host" }],
      [{ priority: 10 }],
      ["mx.zoho.com"],
      Array.from({ length: 11 }, (_, i) => ({ priority: i, host: `mx${i}.zoho.com` })),
    ];
    for (const v of bad) expect("lastGoodMx" in parseDomainCheckState({ ...base, lastGoodMx: v })).toBe(false);
  });

  it("checkMatchesMode: a state without a mode is app mode", () => {
    expect(checkMatchesMode({}, "app")).toBe(true);
    expect(checkMatchesMode({}, "own-mailbox")).toBe(false);
    expect(checkMatchesMode({ replies: "app" }, "app")).toBe(true);
    expect(checkMatchesMode({ replies: "app" }, "own-mailbox")).toBe(false);
    expect(checkMatchesMode({ replies: "own-mailbox" }, "own-mailbox")).toBe(true);
    expect(checkMatchesMode({ replies: "own-mailbox" }, "app")).toBe(false);
  });
});

describe("mailgun.unsubscribeTest's own-mailbox fields (O13)", () => {
  const original = {
    domain: D,
    from: FROM,
    address: "tess@gmail.com",
    testSendId: 4,
    returnPathDomain: D,
    returnPathOk: true,
    dmarc: "pass",
    dkimSigner: D,
    mailtoDomain: D,
    mailtoOk: true,
    readAt: "2026-09-28T04:00:00Z",
  };

  it("an app-mode shape parses exactly as before (no new keys)", () => {
    const parsed = parseUnsubscribeTest({ setup: "A", status: "passed", domain: "mail.polygonparadise.com", mailboxes: [], from: FROM, original });
    expect("replies" in parsed).toBe(false);
    expect("mailtoArrived" in parsed).toBe(false);
    expect(parsed.original).toEqual(original);
  });

  it("keeps replies only as 'own-mailbox' and mailtoArrived only as a boolean or null", () => {
    expect(parseUnsubscribeTest({ replies: "own-mailbox" }).replies).toBe("own-mailbox");
    for (const v of ["app", "OWN-MAILBOX", true]) expect("replies" in parseUnsubscribeTest({ replies: v })).toBe(false);
    for (const v of [true, false, null]) expect(parseUnsubscribeTest({ mailtoArrived: v }).mailtoArrived).toBe(v);
    for (const v of ["yes", 1]) expect("mailtoArrived" in parseUnsubscribeTest({ mailtoArrived: v })).toBe(false);
  });

  it("keeps the original's scheme and mailto address when well-formed; a bad scheme drops only that field", () => {
    const withBoth = parseUnsubscribeTest({ original: { ...original, unsubscribeScheme: "http", mailtoAddress: `u+abc@${D}` } }).original;
    expect(withBoth).toEqual({ ...original, unsubscribeScheme: "http", mailtoAddress: `u+abc@${D}` });
    const none = parseUnsubscribeTest({ original: { ...original, unsubscribeScheme: null, mailtoAddress: null } }).original;
    expect(none).toEqual({ ...original, unsubscribeScheme: null, mailtoAddress: null });
    for (const scheme of ["ftp", 1, "HTTPS"]) {
      expect(parseUnsubscribeTest({ original: { ...original, unsubscribeScheme: scheme } }).original).toEqual(original);
    }
    // Review SECURITY-03: Mailgun's u+… tokens may pass RFC 5321's 254 characters; a header line's 998 is the cap.
    const long = `${"x".repeat(250)}@${D}`;
    expect(parseUnsubscribeTest({ original: { ...original, mailtoAddress: long } }).original).toEqual({ ...original, mailtoAddress: long });
    const quoted = `"a@b"@${D}`;
    expect(parseUnsubscribeTest({ original: { ...original, mailtoAddress: quoted } }).original?.mailtoAddress).toBe(quoted);
  });

  it("a mailto address that is there but not well formed drops the whole original (fail closed, SECURITY-03)", () => {
    for (const bad of ["no-at-sign", "a@b@c", "@example.com", "u@", "", "u x@example.com", `${"x".repeat(990)}@${D}`, 7, true]) {
      expect(parseUnsubscribeTest({ original: { ...original, mailtoAddress: bad } }).original, String(bad)).toBeUndefined();
    }
    // Stored before the field existed (app mode never stores it): the original stays.
    expect(parseUnsubscribeTest({ original }).original).toEqual(original);
  });

  it("keeps mailtoUnreadable and leaveOutMailto only when exactly true (review SECURITY-03, REPLIES-03)", () => {
    expect(parseUnsubscribeTest({ original: { ...original, mailtoAddress: null, mailtoUnreadable: true } }).original).toEqual({
      ...original,
      mailtoAddress: null,
      mailtoUnreadable: true,
    });
    for (const v of [false, "true", 1, null]) {
      expect("mailtoUnreadable" in (parseUnsubscribeTest({ original: { ...original, mailtoUnreadable: v } }).original ?? {})).toBe(false);
      expect("leaveOutMailto" in parseUnsubscribeTest({ leaveOutMailto: v })).toBe(false);
    }
    expect(parseUnsubscribeTest({ leaveOutMailto: true }).leaveOutMailto).toBe(true);
    // App-mode shapes stay without the keys.
    expect("leaveOutMailto" in parseUnsubscribeTest({ setup: "A", status: "passed", mailboxes: [] })).toBe(false);
  });
});

describe("replyTestPassedFor: a pass belongs to one way of sending (O13, O15)", () => {
  const passed = { status: "passed" as const, domain: D, from: FROM };
  it("a pass decided in own-mailbox mode counts only in own-mailbox mode, with the same From", () => {
    const own = { ...passed, replies: "own-mailbox" as const };
    expect(replyTestPassedFor(own, D, FROM, { ownMailbox: true })).toBe(true);
    expect(replyTestPassedFor(own, D, FROM)).toBe(false);
    expect(replyTestPassedFor(own, D, FROM, { ownMailbox: false })).toBe(false);
    expect(replyTestPassedFor(own, D, `hello@${D}`, { ownMailbox: true })).toBe(false);
    expect(replyTestPassedFor(own, `mail.${D}`, FROM, { ownMailbox: true })).toBe(false);
  });

  it("a pass without a mode counts exactly as before, and never in own-mailbox mode", () => {
    expect(replyTestPassedFor(passed, D, FROM)).toBe(true);
    expect(replyTestPassedFor({ ...passed, from: null }, D, null)).toBe(true);
    expect(replyTestPassedFor(passed, D, FROM, { ownMailbox: true })).toBe(false);
    expect(replyTestPassedFor({ ...passed, status: "failed" }, D, FROM)).toBe(false);
  });
});

describe("the inbox-check notification type (§7.6)", () => {
  it("is a reply notification in the Replies pop-up group", () => {
    expect(REPLY_NOTIFICATION.inboxCheck).toBe("reply.inboxCheck");
    expect(popupGroupOf("reply.inboxCheck")).toBe("reply");
  });
});

// ───────────────────────── mode gates (§3.4, §7.5) ─────────────────────────

function row(key: ChecklistRowKey, status: CheckStatus): ChecklistRow {
  return { key, group: "dns", status, title: `Row ${key}`, text: `Text of ${key}.`, fix: null, records: [], detail: null };
}

/** The own-mailbox checklist (§3.3): no mx, spam-filter, retention, reply-routes or from-spf rows. */
const OWN_KEYS: ChecklistRowKey[] = [
  "mailgun-domain",
  "spf",
  "dkim",
  "tracking-cname",
  "https-links",
  "dmarc",
  "from-mx",
  "tracking-off",
  "unsubscribe",
  "signing-key",
  "webhooks",
  "sending-allowed",
  "monthly-limit",
  "remote-access",
  "reply-test",
  "postmaster",
  "domain-age",
];

function ownRows(changes: Partial<Record<ChecklistRowKey, CheckStatus | "absent">> = {}): ChecklistRow[] {
  return OWN_KEYS.flatMap((key) => {
    const status = changes[key] ?? "ok";
    return status === "absent" ? [] : [row(key, status)];
  });
}

const connected = { connected: true, practiceCopy: false, testListSize: 2 };

describe("liveModeBlockers, own-mailbox", () => {
  it("needs no mx row and follows the DNS sentence with the from-mx sentences", () => {
    expect(liveModeBlockers(ownRows(), { ...connected, ownMailbox: true })).toEqual([]);
    // App mode with the same rows still needs the mx row (unchanged).
    expect(liveModeBlockers(ownRows(), connected)).toEqual([T.dns]);
    expect(liveModeBlockers(ownRows({ "from-mx": "absent" }), { ...connected, ownMailbox: true })).toEqual([T.fromMxUnchecked]);
    expect(liveModeBlockers(ownRows({ "from-mx": "bad", spf: "bad" }), { ...connected, ownMailbox: true })).toEqual([T.dns, T.fromMxOwn]);
    for (const s of ["warn", "unknown", "info"] as const) {
      expect(liveModeBlockers(ownRows({ "from-mx": s }), { ...connected, ownMailbox: true })).toEqual([]);
    }
  });

  it("lets an 'info' webhooks row pass (no public address, O21) and keeps the other gates", () => {
    expect(liveModeBlockers(ownRows({ webhooks: "info", "remote-access": "info" }), { ...connected, ownMailbox: true })).toEqual([]);
    expect(liveModeBlockers(ownRows({ "tracking-off": "bad" }), { ...connected, ownMailbox: true })).toEqual([T.trackingOff]);
    expect(liveModeBlockers(ownRows(), { ...connected, connected: false, ownMailbox: true })).toEqual([T.connect]);
  });
});

describe("replyTestBlockers, own-mailbox (O9, O38)", () => {
  const base = { ...connected, mode: "LIVE" as const, ownerRouteOk: false, publicAddressOk: false, setup: "A" as const };
  it("needs no reply route and no public address, but the DMARC row", () => {
    expect(replyTestBlockers(ownRows(), { ...base, ownMailbox: true })).toEqual([]);
    expect(replyTestBlockers(ownRows({ dmarc: "absent" }), { ...base, ownMailbox: true })).toEqual([T.dmarcFirst]);
    expect(replyTestBlockers(ownRows({ dmarc: "bad" }), { ...base, ownMailbox: true })).toEqual([T.dmarcFirst]);
    expect(replyTestBlockers(ownRows({ dmarc: "warn" }), { ...base, ownMailbox: true })).toEqual([]);
    expect(T.dmarcFirst).toBe(
      "Add the DMARC record first (the DMARC row of the Domain checklist) and wait until it shows Done, so the test emails can pass DMARC.",
    );
  });

  it("only Setup A, with the 'Back to normal' sentence instead of setupA", () => {
    expect(replyTestBlockers(ownRows(), { ...base, setup: "B", ownMailbox: true })).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
    expect(replyTestBlockers(ownRows(), { ...base, setup: "C", ownMailbox: true })).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
  });

  it("app mode is unchanged", () => {
    expect(replyTestBlockers(ownRows(), base)).toEqual([T.dns, T.ownerRoute, T.publicAddress]);
    expect(replyTestBlockers(ownRows(), { ...base, setup: "B", ownMailbox: false })).toEqual([T.dns, T.ownerRoute, T.publicAddress]);
  });
});

describe("liveLaunchBlockers and goLiveBlockers, own-mailbox", () => {
  it("a LIVE launch never shows setupA in own-mailbox mode", () => {
    const ctx = { ...connected, setup: "B" as const, replyTestPassedOnDomain: true };
    expect(liveLaunchBlockers(ownRows(), { ...ctx, ownMailbox: true })).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
    expect(liveLaunchBlockers(ownRows(), { ...ctx, ownMailbox: true, setup: "A", replyTestPassedOnDomain: false })).toEqual([T.replyTestPass]);
    expect(liveLaunchBlockers(ownRows(), ctx)).toEqual([T.dns, T.setupA]);
  });

  it("goLiveRowKeys: the own-mailbox rows, webhooks and remote access only with a public address; app mode unchanged", () => {
    expect(goLiveRowKeys(false, { ownMailbox: true })).toEqual([
      "mailgun-domain",
      "spf",
      "dkim",
      "tracking-cname",
      "dmarc",
      "from-mx",
      "tracking-off",
      "unsubscribe",
      "signing-key",
      "sending-allowed",
    ]);
    expect(goLiveRowKeys(true, { ownMailbox: true, publicAddress: true })).toEqual([
      "mailgun-domain",
      "spf",
      "dkim",
      "tracking-cname",
      "dmarc",
      "from-mx",
      "tracking-off",
      "unsubscribe",
      "signing-key",
      "webhooks",
      "sending-allowed",
      "remote-access",
    ]);
    expect(goLiveRowKeys(false, { ownMailbox: true })).not.toContain("https-links");
    expect(goLiveRowKeys(false)).toBe(GO_LIVE_ROW_KEYS);
    expect(goLiveRowKeys(false, {})).toBe(GO_LIVE_ROW_KEYS);
    expect(goLiveRowKeys(true, { ownMailbox: false })).toEqual(goLiveRowKeys(true));
  });

  it("goLiveBlockers: own rows only, no reply routes, setupNotNormal", () => {
    const ctx = { replyTestPassed: true, paused: false, practiceCopy: false, sendersWithoutRoute: ["Ali"], connected: true, checkFresh: true };
    expect(goLiveBlockers(ownRows({ "https-links": "info", webhooks: "info", "remote-access": "warn" }), { ...ctx, ownMailbox: true })).toEqual([]);
    expect(goLiveBlockers(ownRows({ webhooks: "info" }), { ...ctx, ownMailbox: true, publicAddress: true })).toEqual([
      "Row webhooks: needs attention: Text of webhooks (Domain checklist).",
    ]);
    expect(goLiveBlockers(ownRows({ "from-mx": "bad" }), { ...ctx, ownMailbox: true, setup: "B" })).toEqual([
      "Row from-mx: not done yet (Domain checklist).",
      OWN_MAILBOX_TEXTS.setupNotNormal,
    ]);
    // App mode: the mx, spam-filter, retention and reply-routes rows and the reply routes still count.
    const app = goLiveBlockers(ownRows(), ctx);
    expect(app).toContain(`${CHECKLIST_ROW_TITLES.mx}: not done yet (Domain checklist).`);
    expect(app).toContain("Ali has no working reply route.");
  });
});

describe("goLiveRecommendations, own-mailbox (§3.4)", () => {
  const base = {
    checksTried: false,
    secondFolder: "D:\\Backups",
    newestBackupAt: new Date("2026-09-28T03:00:00Z"),
    accessOff: false,
    riskyFolder: null,
    restoreDone: true,
    now: new Date("2026-09-28T04:00:00Z"),
    teamFrom: FROM,
  };

  it("on the Free plan: checksFree, Postmaster through the Own-mailbox guide, the authorized-recipients check and the upgrade", () => {
    const rows = ownRows({ postmaster: "info", "monthly-limit": "info" });
    expect(goLiveRecommendations({ ...base, rows, ownMailbox: true, planDailyLimit: 100 })).toEqual([
      R.checksFree,
      R.postmasterOwn(D),
      R.authorizedCheck,
      R.planUpgrade,
      R.templates,
      R.aiModel,
    ]);
    expect(R.postmasterOwn(D)).toContain("(Own-mailbox guide, step 14)");
  });

  it("without a daily limit: the usual checks line and no plan lines", () => {
    const rows = ownRows({ postmaster: "info", "monthly-limit": "warn" });
    expect(goLiveRecommendations({ ...base, rows, ownMailbox: true, planDailyLimit: null })).toEqual([
      R.monthlyLimit,
      R.checks,
      R.postmasterOwn(D),
      R.templates,
      R.aiModel,
    ]);
  });

  it("app mode is unchanged", () => {
    const rows = ownRows({ postmaster: "info", "monthly-limit": "warn" });
    expect(goLiveRecommendations({ ...base, rows, planDailyLimit: 100 })).toEqual([R.monthlyLimit, R.checks, R.postmasterTeam(D), R.templates, R.aiModel]);
  });
});

describe("the go-live copy (§3.4)", () => {
  const warmup: GoLiveWarmup = { startCap: 50, maxCap: 90, steps: 20 };
  const input = { capOverrideToday: null, drafts: { items: [], more: 0 }, warmup };

  it("puts the own-mailbox item where the From item goes", () => {
    const items = goLiveDialogItems({ ...input, from: { team: null, ownExample: null, ownMailbox: { from: FROM, domain: D } } });
    expect(items[2]).toBe(GO_LIVE_COPY.dialogOwnMailboxItem(FROM, D));
    expect(items[2]).toBe(
      "Every email shows From contact@polygonparadise.com and goes out through polygonparadise.com itself. Replies come only to contact@polygonparadise.com: the app never sees them.",
    );
    expect(items.filter((s) => s.startsWith("Every email shows From"))).toHaveLength(1);
  });

  it("without ownMailbox the list is as before", () => {
    const team = { team: { from: FROM, org: D }, ownExample: null };
    expect(goLiveDialogItems({ ...input, from: team })).toEqual(goLiveDialogItems({ ...input, from: { ...team, ownMailbox: null } }));
    expect(goLiveDialogItems({ ...input, from: team })[2]).toBe(GO_LIVE_COPY.dialogTeamFromItem(FROM, D));
  });

  it("words the ticks and lines", () => {
    expect(GO_LIVE_COPY.ownMailboxTick(FROM)).toMatch(/^I read contact@polygonparadise\.com every working day, its inbox and its Spam folder\./);
    expect(GO_LIVE_COPY.ownMailboxRequired).toBe("Tick the box about replies in your own mailbox first.");
    expect(GO_LIVE_COPY.httpLinksRequired).toBe("Tick the box about unsubscribe links first.");
    expect(GO_LIVE_COPY.liveOwnFromLine(FROM)).toBe("Emails show From contact@polygonparadise.com; replies go straight to that mailbox.");
    expect(GO_LIVE_COPY.guideLineOwn).toBe("Step by step: Own-mailbox guide, step 11.");
  });
});
