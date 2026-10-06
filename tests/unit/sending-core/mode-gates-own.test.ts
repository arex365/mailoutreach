import { describe, expect, it } from "vitest";
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
import type { CheckStatus, ChecklistRow, ChecklistRowKey } from "@/core/system-state";

/**
 * The mode gates in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, O9–O14, O20, O21, O38; the step-C code of
 * `core/sending/mode-gates.ts`, pinned by P4): Live mode never needs an `mx` row but always the from-mx guard; the reply
 * test needs no reply route and no public address but the DMARC row first, and says "Back to normal" words for a stored
 * Setup B; go-live's own-mailbox rows with and without a public address; the recommendations. Without the new options
 * every answer is today's.
 */

/** The rows an own-mailbox check writes (no mx, spam-filter, retention, reply-routes or from-spf). */
const OWN_KEYS: readonly ChecklistRowKey[] = [
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
const ALL_KEYS = Object.keys(CHECKLIST_ROW_TITLES) as ChecklistRowKey[];

function row(key: ChecklistRowKey, status: CheckStatus, title?: string, text = ""): ChecklistRow {
  return { key, group: "dns", status, title: title ?? `Row ${key}`, text, fix: null, records: [], detail: null };
}

function ownRows(changes: Partial<Record<ChecklistRowKey, CheckStatus | "absent">> = {}): ChecklistRow[] {
  return OWN_KEYS.flatMap((key) => {
    const status = changes[key] ?? "ok";
    return status === "absent" ? [] : [row(key, status)];
  });
}

const connected = { connected: true, practiceCopy: false, testListSize: 2 };
const own = { ...connected, ownMailbox: true };

describe("liveModeBlockers in own-mailbox mode", () => {
  it("allows Live with the own-mailbox rows green: no mx row is needed", () => {
    expect(liveModeBlockers(ownRows(), own)).toEqual([]);
    expect(ownRows().some((r) => r.key === "mx")).toBe(false);
  });

  it("never names mx; the DNS sentence covers mailgun-domain, spf, dkim and tracking-cname", () => {
    for (const key of ["mailgun-domain", "spf", "dkim", "tracking-cname"] as const) {
      expect(liveModeBlockers(ownRows({ [key]: "bad" }), own)).toEqual([T.dns]);
      expect(liveModeBlockers(ownRows({ [key]: "absent" }), own)).toEqual([T.dns]);
    }
    // A bad mx row left from somewhere else changes nothing here.
    expect(liveModeBlockers([...ownRows(), row("mx", "bad")], own)).toEqual([]);
  });

  it("names the from-mx guard right after the DNS sentence: fromMxOwn when bad, fromMxUnchecked when missing", () => {
    // Review SCREENS-11: the own sentence names Cloudflare Email Routing too (red in this mode, `ownMxCause`).
    expect(liveModeBlockers(ownRows({ "from-mx": "bad" }), own)).toEqual([T.fromMxOwn]);
    expect(T.fromMxOwn).toBe(
      "Mail for your domain doesn't go to your mail provider: it points to Mailgun or Cloudflare Email Routing, or is missing. It must stay with your mail provider, never Mailgun (Domain checklist).",
    );
    expect(liveModeBlockers(ownRows({ "from-mx": "absent" }), own)).toEqual([T.fromMxUnchecked]);
    expect(liveModeBlockers(ownRows({ spf: "bad", "from-mx": "bad" }), own)).toEqual([T.dns, T.fromMxOwn]);
    for (const status of ["warn", "unknown", "info"] as const) expect(liveModeBlockers(ownRows({ "from-mx": status }), own)).toEqual([]);
  });

  it("an info webhooks row (no public address) passes; a bad one still blocks", () => {
    expect(liveModeBlockers(ownRows({ webhooks: "info", "remote-access": "info" }), own)).toEqual([]);
    expect(liveModeBlockers(ownRows({ webhooks: "bad" }), own)).toEqual([T.webhooks]);
  });

  it("everything in order when nothing was checked", () => {
    expect(liveModeBlockers([], own)).toEqual([T.dns, T.fromMxUnchecked, T.trackingOff, T.unsubscribe, T.webhooks, T.signingKey, T.sendingAllowed]);
  });

  it("without ownMailbox: today's answers (mx needed, no from-mx sentence)", () => {
    expect(liveModeBlockers(ownRows(), connected)).toEqual([T.dns]);
    expect(liveModeBlockers(ownRows({ "from-mx": "bad" }), connected)).toEqual([T.dns]);
  });
});

describe("liveLaunchBlockers in own-mailbox mode", () => {
  const launch = { ...own, setup: "A" as const, replyTestPassedOnDomain: true };

  it("needs the by-hand reply test's pass and Setup A, which it calls 'back to normal'", () => {
    expect(liveLaunchBlockers(ownRows(), launch)).toEqual([]);
    expect(liveLaunchBlockers(ownRows(), { ...launch, replyTestPassedOnDomain: false })).toEqual([T.replyTestPass]);
    const setupB = liveLaunchBlockers(ownRows(), { ...launch, setup: "B" });
    expect(setupB).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
    expect(setupB).not.toContain(T.setupA);
    expect(liveLaunchBlockers(ownRows(), { ...launch, testListSize: 0 })).toEqual([T.emptyTestListLaunch]);
  });
});

describe("replyTestBlockers in own-mailbox mode", () => {
  const rt = { ...own, mode: "LIVE" as const, ownerRouteOk: false, publicAddressOk: false, setup: "A" as const };

  it("needs no owner route and no public address", () => {
    expect(replyTestBlockers(ownRows(), rt)).toEqual([]);
    const app = replyTestBlockers([...ownRows(), row("mx", "ok")], { ...rt, ownMailbox: undefined });
    expect(app).toEqual([T.ownerRoute, T.publicAddress]);
  });

  it("waits for the DMARC row: missing or bad → dmarcFirst; ok or warn passes that gate (O38)", () => {
    expect(replyTestBlockers(ownRows({ dmarc: "absent" }), rt)).toEqual([T.dmarcFirst]);
    expect(replyTestBlockers(ownRows({ dmarc: "bad" }), rt)).toEqual([T.dmarcFirst]);
    expect(replyTestBlockers(ownRows({ dmarc: "warn" }), rt)).toEqual([]);
    expect(replyTestBlockers(ownRows({ dmarc: "ok" }), rt)).toEqual([]);
    expect(T.dmarcFirst).toBe(
      "Add the DMARC record first (the DMARC row of the Domain checklist) and wait until it shows Done, so the test emails can pass DMARC.",
    );
    // App mode never asks for DMARC first.
    expect(replyTestBlockers([...ALL_KEYS.filter((k) => k !== "dmarc").map((k) => row(k, "ok"))], { ...rt, ownerRouteOk: true, publicAddressOk: true, ownMailbox: undefined })).toEqual([]);
  });

  it("a stored Setup B says setupNotNormal, never setupA or setupForReplyTest", () => {
    for (const setup of ["B", "C"] as const) {
      const out = replyTestBlockers(ownRows(), { ...rt, setup });
      expect(out).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
      expect(out).not.toContain(T.setupA);
      expect(out).not.toContain(T.setupForReplyTest);
    }
    expect(OWN_MAILBOX_TEXTS.setupNotNormal).toBe("The reply test is set to a check-only setup. Click Back to normal in the Reply test section.");
  });

  it("still needs Test mode or Live, the from-mx guard and test mailboxes", () => {
    expect(replyTestBlockers(ownRows(), { ...rt, mode: "DRY_RUN" })).toEqual([T.modeForReplyTest]);
    expect(replyTestBlockers(ownRows({ "from-mx": "bad" }), rt)).toEqual([T.fromMxOwn]);
    expect(replyTestBlockers(ownRows(), { ...rt, testListSize: 0 })).toEqual([T.testMailboxes]);
    expect(replyTestBlockers(ownRows(), { ...rt, practiceCopy: true })).toEqual([T.practiceCopy]);
  });
});

describe("goLiveRowKeys and goLiveBlockers in own-mailbox mode", () => {
  it("the own-mailbox rows, with webhooks and remote-access only with a public address; never https-links", () => {
    expect(goLiveRowKeys(false, { ownMailbox: true, publicAddress: false })).toEqual([
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
    expect(goLiveRowKeys(false, { ownMailbox: true, publicAddress: true })).toEqual([
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
    // teamFrom is ignored in own-mailbox mode.
    expect(goLiveRowKeys(true, { ownMailbox: true })).toEqual(goLiveRowKeys(false, { ownMailbox: true, publicAddress: false }));
    // Without the option: today's lists (GO_LIVE_ROW_KEYS itself is unchanged, the guide-4 list test).
    expect(goLiveRowKeys(false)).toBe(GO_LIVE_ROW_KEYS);
    expect(goLiveRowKeys(false, {})).toBe(GO_LIVE_ROW_KEYS);
    expect(GO_LIVE_ROW_KEYS).toContain("mx");
  });

  const ready = {
    replyTestPassed: true,
    paused: false,
    practiceCopy: false,
    sendersWithoutRoute: ["Ali"],
    connected: true,
    checkFresh: true,
    setup: "A" as const,
    liveTest: "delivered" as const,
    workerRunning: true,
    ownMailbox: true,
  };

  it("ready with the own-mailbox rows ok: https-links, webhooks and remote-access may be info; nobody needs a route", () => {
    expect(goLiveBlockers(ownRows({ "https-links": "info", webhooks: "info", "remote-access": "info", "monthly-limit": "info" }), ready)).toEqual([]);
  });

  it("with a public address the webhooks and remote-access rows must be ok", () => {
    const r = ownRows({ webhooks: "info", "remote-access": "warn" });
    r.find((x) => x.key === "remote-access")!.text = "The tunnel is down.";
    expect(goLiveBlockers(r, { ...ready, publicAddress: true })).toEqual([
      "Row webhooks: needs attention (Domain checklist).",
      "Row remote-access: needs attention: The tunnel is down (Domain checklist).",
    ]);
  });

  it("the sentences use the rows' titles (or the fallback titles when never checked)", () => {
    const title = "Mail for example.com stays with your mail provider (MX)";
    const r = ownRows({ "from-mx": "absent" }).concat(row("from-mx", "bad", title));
    expect(goLiveBlockers(r, ready)).toEqual([`${title}: not done yet (Domain checklist).`]);
    expect(goLiveBlockers(ownRows({ dmarc: "absent" }), ready)).toEqual([`${CHECKLIST_ROW_TITLES.dmarc}: not done yet (Domain checklist).`]);
    expect(goLiveBlockers(ownRows({ spf: "warn" }), ready)).toEqual(["Row spf: needs attention (Domain checklist)."]);
  });

  it("a stored Setup B says setupNotNormal; the rest as today", () => {
    expect(goLiveBlockers(ownRows(), { ...ready, setup: "B" })).toEqual([OWN_MAILBOX_TEXTS.setupNotNormal]);
    expect(goLiveBlockers(ownRows(), { ...ready, replyTestPassed: false, paused: true, liveTest: "none", workerRunning: false })).toEqual([
      T.replyTestNotPassed,
      T.paused,
      // Review SCREENS-11: the own guide's live-test step, not guide 4's rehearsal.
      T.liveTestNoneOwn,
      T.workerStopped,
    ]);
    expect(T.liveTestNoneOwn).toBe("Send one live campaign to your test list first, and check that it arrived (Own-mailbox guide, step 10).");
    expect(goLiveBlockers(ownRows(), { ...ready, checkFresh: false })).toEqual([T.checkStale]);
  });

  it("without ownMailbox: today's answers (the route sentence, mx needed)", () => {
    const app = { ...ready, ownMailbox: undefined };
    const out = goLiveBlockers(ownRows(), app);
    expect(out).toContain("Ali has no working reply route.");
    expect(out).toContain(`${CHECKLIST_ROW_TITLES.mx}: not done yet (Domain checklist).`);
    expect(goLiveBlockers(ownRows(), { ...app, liveTest: "none" })).toContain(T.liveTestNone);
    expect(liveModeBlockers(ownRows({ "from-mx": "bad" }), { ...connected, teamFrom: true })).toContain(T.fromMx);
  });
});

describe("goLiveRecommendations in own-mailbox mode", () => {
  const base = {
    rows: ownRows(),
    checksTried: false,
    secondFolder: "D:\\Backups",
    newestBackupAt: new Date("2026-09-28T08:00:00Z"),
    accessOff: false,
    riskyFolder: null,
    restoreDone: true,
    now: new Date("2026-09-28T09:00:00Z"),
    teamFrom: "contact@example.com",
  };

  it("on Free: checksFree, postmasterOwn (never the Mailgun guide), authorizedCheck and planUpgrade, in that order", () => {
    const out = goLiveRecommendations({ ...base, rows: ownRows({ postmaster: "info" }), ownMailbox: true, planDailyLimit: 100 });
    expect(out).toEqual([R.checksFree, R.postmasterOwn("example.com"), R.authorizedCheck, R.planUpgrade, R.templates, R.aiModel]);
    expect(out.join(" ")).not.toContain("Mailgun guide");
    expect(R.postmasterOwn("example.com")).toBe(
      "Add example.com to Google Postmaster Tools, so you can watch how Gmail rates the domain your everyday email shares (Own-mailbox guide, step 14).",
    );
  });

  it("a plan without a daily limit: today's checks line and no Free-plan lines", () => {
    const out = goLiveRecommendations({ ...base, ownMailbox: true, planDailyLimit: null });
    expect(out).toEqual([R.checks, R.templates, R.aiModel]);
  });

  it("an info monthly-limit row adds no line; a bad one still does", () => {
    expect(goLiveRecommendations({ ...base, rows: ownRows({ "monthly-limit": "info" }), checksTried: true, ownMailbox: true, planDailyLimit: 100 })).toEqual([
      R.authorizedCheck,
      R.planUpgrade,
      R.templates,
      R.aiModel,
    ]);
    expect(goLiveRecommendations({ ...base, rows: ownRows({ "monthly-limit": "bad" }), checksTried: true, ownMailbox: true })[0]).toBe(R.monthlyLimit);
  });

  it("without ownMailbox: today's lines (postmasterTeam, no Free-plan lines even with a limit given)", () => {
    const out = goLiveRecommendations({ ...base, rows: ownRows({ postmaster: "info" }), planDailyLimit: 100 });
    expect(out).toEqual([R.checks, R.postmasterTeam("example.com"), R.templates, R.aiModel]);
  });
});
