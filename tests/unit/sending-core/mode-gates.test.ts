import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ROW_TITLES,
  GO_LIVE_ROW_KEYS,
  MODE_GATE_TEXTS as T,
  goLiveBlockers,
  liveLaunchBlockers,
  liveModeBlockers,
  modeWarnings,
  replyTestBlockers,
  testModeBlockers,
} from "@/core/sending/mode-gates";
import type { CheckStatus, ChecklistRow, ChecklistRowKey } from "@/core/system-state";

const ALL_KEYS = Object.keys(CHECKLIST_ROW_TITLES) as ChecklistRowKey[];

function row(key: ChecklistRowKey, status: CheckStatus, title?: string): ChecklistRow {
  return { key, group: "dns", status, title: title ?? `Row ${key}`, text: "", fix: null, records: [], detail: null };
}

/** Every checklist row green, with some rows changed. */
function rows(changes: Partial<Record<ChecklistRowKey, CheckStatus | "absent">> = {}): ChecklistRow[] {
  return ALL_KEYS.flatMap((key) => {
    const status = changes[key] ?? "ok";
    return status === "absent" ? [] : [row(key, status)];
  });
}

const connected = { connected: true, practiceCopy: false, testListSize: 2 };

describe("testModeBlockers", () => {
  it("needs Mailgun connected, outside the practice copy", () => {
    expect(testModeBlockers({ connected: true, practiceCopy: false })).toEqual([]);
    expect(testModeBlockers({ connected: false, practiceCopy: false })).toEqual(["Connect Mailgun first."]);
    expect(testModeBlockers({ connected: true, practiceCopy: true })).toEqual(["The practice copy never sends real email."]);
  });
});

describe("liveModeBlockers", () => {
  it("allows Live when every needed row is green", () => {
    expect(liveModeBlockers(rows(), connected)).toEqual([]);
  });

  it("gives each missing row's sentence", () => {
    const cases: Array<[ChecklistRowKey, string]> = [
      ["mailgun-domain", "Mailgun hasn't confirmed your DNS records yet (Domain checklist)."],
      ["spf", T.dns],
      ["dkim", T.dns],
      ["mx", T.dns],
      ["tracking-cname", T.dns],
      ["tracking-off", "Open and click tracking must be off (Domain checklist › Apply recommended settings)."],
      ["unsubscribe", "Mailgun's unsubscribe handling must be on (Domain checklist › Apply recommended settings)."],
      ["webhooks", "Mailgun must be told where to send bounces and unsubscribes (Domain checklist › Apply recommended settings)."],
      ["signing-key", "The webhook signing key isn't saved yet (Domain checklist › Apply recommended settings)."],
      ["sending-allowed", "Mailgun isn't accepting emails from your domain right now (Domain checklist)."],
    ];
    for (const [key, text] of cases) {
      expect(liveModeBlockers(rows({ [key]: "bad" }), connected)).toEqual([text]);
      // A row that was never checked blocks too.
      expect(liveModeBlockers(rows({ [key]: "absent" }), connected)).toEqual([text]);
    }
  });

  it("never blocks on warn, unknown, info or off", () => {
    for (const status of ["warn", "unknown", "info", "off"] as const) {
      const r = rows({ "mailgun-domain": status, spf: status, "tracking-off": status, unsubscribe: status, webhooks: status });
      expect(liveModeBlockers(r, connected)).toEqual([]);
    }
  });

  it("ignores rows Live mode doesn't need", () => {
    expect(liveModeBlockers(rows({ dmarc: "bad", "https-links": "bad", "remote-access": "bad", "monthly-limit": "bad" }), connected)).toEqual([]);
  });

  it("lists the DNS sentence once, and everything in order when nothing was checked", () => {
    expect(liveModeBlockers(rows({ spf: "bad", dkim: "bad", mx: "absent" }), connected)).toEqual([T.dns]);
    expect(liveModeBlockers([], connected)).toEqual([T.dns, T.trackingOff, T.unsubscribe, T.webhooks, T.signingKey, T.sendingAllowed]);
  });

  it("only asks to connect when Mailgun isn't connected, and refuses the practice copy", () => {
    expect(liveModeBlockers([], { ...connected, connected: false })).toEqual(["Connect Mailgun first."]);
    expect(liveModeBlockers(rows(), { ...connected, practiceCopy: true })).toEqual(["The practice copy never sends real email."]);
  });

  it("doesn't block on an empty test list, but warns", () => {
    expect(liveModeBlockers(rows(), { ...connected, testListSize: 0 })).toEqual([]);
    expect(modeWarnings("LIVE", { testListSize: 0 })).toEqual(["Your test list is empty, so nothing can be sent yet."]);
    expect(modeWarnings("TEST", { testListSize: 0 })).toEqual([T.emptyTestListWarning]);
    expect(modeWarnings("LIVE", { testListSize: 2 })).toEqual([]);
    expect(modeWarnings("DRY_RUN", { testListSize: 0 })).toEqual([]);
    expect(modeWarnings("LIVE", { testListSize: 0, goLive: true })).toEqual([]);
  });
});

describe("liveLaunchBlockers", () => {
  const ready = { ...connected, setup: "A" as const, replyTestPassedOnDomain: true };

  it("allows a live launch when Live is ready, Setup A passed the reply test and the test list has mailboxes", () => {
    expect(liveLaunchBlockers(rows(), ready)).toEqual([]);
  });

  it("adds Setup A, the reply-test pass and the test list to the Live mode items", () => {
    expect(liveLaunchBlockers(rows(), { ...ready, setup: "B" })).toEqual([
      "Live campaigns need Setup A (Mailgun's unsubscribe handling). Settings › Domain checklist › Reply test.",
    ]);
    expect(liveLaunchBlockers(rows(), { ...ready, replyTestPassedOnDomain: false })).toEqual([
      "Live campaigns start once the reply test has passed (Settings › Domain checklist › Reply test).",
    ]);
    expect(liveLaunchBlockers(rows(), { ...ready, testListSize: 0 })).toEqual([
      "Your test list is empty, so a live campaign can't reach anyone yet.",
    ]);
    expect(
      liveLaunchBlockers(rows({ webhooks: "bad" }), { ...ready, setup: "C", replyTestPassedOnDomain: false, testListSize: 0 }),
    ).toEqual([T.webhooks, T.setupA, T.replyTestPass, T.emptyTestListLaunch]);
  });

  it("puts 'Connect Mailgun first.' first and refuses the practice copy alone", () => {
    expect(liveLaunchBlockers([], { ...ready, connected: false, replyTestPassedOnDomain: false })).toEqual([
      T.connect,
      T.replyTestPass,
    ]);
    expect(liveLaunchBlockers(rows(), { ...ready, practiceCopy: true })).toEqual([T.practiceCopy]);
  });
});

describe("replyTestBlockers", () => {
  const ready = {
    mode: "LIVE" as const,
    connected: true,
    practiceCopy: false,
    testListSize: 2,
    ownerRouteOk: true,
    publicAddressOk: true,
    setup: "A" as const,
  };

  it("allows the reply test when everything is ready, in Live or Test mode, with Setup A or B", () => {
    expect(replyTestBlockers(rows(), ready)).toEqual([]);
    expect(replyTestBlockers(rows(), { ...ready, mode: "TEST" })).toEqual([]);
    expect(replyTestBlockers(rows(), { ...ready, setup: "B" })).toEqual([]);
  });

  it("needs Test mode or Live", () => {
    expect(replyTestBlockers(rows(), { ...ready, mode: "DRY_RUN" })).toEqual([
      "Set sending to Test mode or Live first: the test emails go through Mailgun.",
    ]);
  });

  it("needs every Live mode item, the reply route, the public address and a test mailbox", () => {
    expect(replyTestBlockers(rows({ "tracking-off": "bad" }), ready)).toEqual([T.trackingOff]);
    expect(replyTestBlockers(rows(), { ...ready, ownerRouteOk: false })).toEqual([
      "Your reply route isn't working yet. Click Apply recommended settings.",
    ]);
    expect(replyTestBlockers(rows(), { ...ready, publicAddressOk: false })).toEqual([
      "Remote access doesn't work yet. Finish the Cloudflare guide.",
    ]);
    expect(replyTestBlockers(rows(), { ...ready, testListSize: 0 })).toEqual([
      "Add your test mailboxes first in Settings › Sending & Mailgun.",
    ]);
    expect(replyTestBlockers(rows(), { ...ready, setup: "C" })).toEqual([T.setupForReplyTest]);
  });

  it("lists everything missing in order", () => {
    expect(
      replyTestBlockers([], { ...ready, mode: "DRY_RUN", connected: false, ownerRouteOk: false, publicAddressOk: false, testListSize: 0 }),
    ).toEqual([T.modeForReplyTest, T.connect, T.ownerRoute, T.publicAddress, T.testMailboxes]);
  });

  it("refuses the practice copy", () => {
    expect(replyTestBlockers(rows(), { ...ready, practiceCopy: true })).toEqual([T.practiceCopy]);
  });
});

describe("goLiveBlockers", () => {
  const ready = { replyTestPassed: true, paused: false, practiceCopy: false, sendersWithoutRoute: [] as string[] };

  it("allows go-live when every needed row is green and nothing else is open", () => {
    expect(goLiveBlockers(rows(), ready)).toEqual([]);
    // Optional rows don't matter.
    expect(goLiveBlockers(rows({ "monthly-limit": "warn", postmaster: "info", "domain-age": "warn", "reply-test": "warn" }), ready)).toEqual([]);
  });

  it("needs every go-live row to be green: warn, unknown and never-checked rows count", () => {
    expect(GO_LIVE_ROW_KEYS).toHaveLength(16);
    // Rows that aren't "bad" say what needs attention (M6-DESIGN §2.4); these rows have no text of their own.
    expect(goLiveBlockers(rows({ dmarc: "warn" }), ready)).toEqual(["Row dmarc: needs attention (Domain checklist)."]);
    expect(goLiveBlockers(rows({ "remote-access": "unknown" }), ready)).toEqual(["Row remote-access: needs attention (Domain checklist)."]);
    expect(goLiveBlockers(rows({ "https-links": "absent" }), ready)).toEqual([
      "Unsubscribe links are secure (HTTPS): not done yet (Domain checklist).",
    ]);
    expect(goLiveBlockers(rows({ spf: "bad" }), ready)).toEqual(["Row spf: not done yet (Domain checklist)."]);
    expect(goLiveBlockers([], ready)).toHaveLength(16);
  });

  it("says what a warn, unknown, info or off row needs, from its own text without the final period", () => {
    const withText = (key: ChecklistRowKey, status: CheckStatus, text: string): ChecklistRow[] =>
      rows().map((r) => (r.key === key ? { ...row(key, status, CHECKLIST_ROW_TITLES[key]), text } : r));
    expect(goLiveBlockers(withText("spf", "warn", "Still spreading. Check again in 30 minutes."), ready)).toEqual([
      "Mailgun may send for your domain (SPF): needs attention: Still spreading. Check again in 30 minutes (Domain checklist).",
    ]);
    for (const status of ["unknown", "info", "off"] as const) {
      expect(goLiveBlockers(withText("dmarc", status, "Couldn't check right now."), ready)).toEqual([
        "Mail servers know your policy (DMARC): needs attention: Couldn't check right now (Domain checklist).",
      ]);
    }
    // "bad" always reads "not done yet", whatever its text.
    expect(goLiveBlockers(withText("webhooks", "bad", "Mailgun doesn't tell the app about bounces yet."), ready)).toEqual([
      "Mailgun tells the app what happened: not done yet (Domain checklist).",
    ]);
  });

  it("uses the row's own title when it has one", () => {
    const r = rows().map((x) => (x.key === "spf" ? row("spf", "bad", "Mailgun may send for send.example.com (SPF)") : x));
    expect(goLiveBlockers(r, ready)).toEqual(["Mailgun may send for send.example.com (SPF): not done yet (Domain checklist)."]);
  });

  it("adds the reply test, the pause and the senders without a reply route", () => {
    expect(goLiveBlockers(rows(), { ...ready, replyTestPassed: false })).toEqual(["The reply test hasn't passed yet."]);
    expect(goLiveBlockers(rows(), { ...ready, paused: true })).toEqual(["Sending is paused."]);
    expect(goLiveBlockers(rows(), { ...ready, sendersWithoutRoute: ["Ali"] })).toEqual(["Ali has no working reply route."]);
    expect(goLiveBlockers(rows(), { ...ready, sendersWithoutRoute: ["Ali", "Sara"] })).toEqual([
      "Ali and Sara have no working reply route.",
    ]);
    expect(goLiveBlockers(rows(), { ...ready, sendersWithoutRoute: ["Ali", "Sara", "Bo"] })).toEqual([
      "Ali, Sara and Bo have no working reply route.",
    ]);
  });

  it("refuses the practice copy", () => {
    expect(goLiveBlockers([], { ...ready, practiceCopy: true })).toEqual([T.practiceCopy]);
  });
});

describe("goLiveBlockers: the M6 inputs (M6-DESIGN §2.4)", () => {
  const ready = { replyTestPassed: true, paused: false, practiceCopy: false, sendersWithoutRoute: [] as string[] };
  const allMet = { ...ready, connected: true, checkFresh: true, setup: "A" as const, liveTest: "delivered" as const, workerRunning: true };

  it("adds nothing when every new input is met, or when it is absent", () => {
    expect(goLiveBlockers(rows(), allMet)).toEqual([]);
    expect(goLiveBlockers(rows(), ready)).toEqual([]);
  });

  it("asks only to connect Mailgun first when it isn't connected (the practice copy still comes first)", () => {
    expect(goLiveBlockers([], { ...allMet, connected: false, checkFresh: false, liveTest: "none", workerRunning: false, paused: true })).toEqual([
      "Connect Mailgun first.",
    ]);
    expect(goLiveBlockers([], { ...allMet, connected: false, practiceCopy: true })).toEqual([T.practiceCopy]);
  });

  it("names each missing input with its own sentence", () => {
    expect(goLiveBlockers(rows(), { ...allMet, checkFresh: false })).toEqual([
      "The Domain checklist was last checked more than an hour ago. Click Check again on the Domain checklist, then come back.",
    ]);
    expect(goLiveBlockers(rows(), { ...allMet, setup: "B" })).toEqual([
      "Live campaigns need Setup A (Mailgun's unsubscribe handling). Settings › Domain checklist › Reply test.",
    ]);
    expect(goLiveBlockers(rows(), { ...allMet, liveTest: "none" })).toEqual([
      "Send one live campaign to your test list first, and check that it arrived (Going-live guide, step 3).",
    ]);
    expect(goLiveBlockers(rows(), { ...allMet, liveTest: "sent" })).toEqual([
      "The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page again.",
    ]);
    expect(goLiveBlockers(rows(), { ...allMet, workerRunning: false })).toEqual([
      "The background sender isn't running. Double-click start.bat on the office PC.",
    ]);
  });

  it("lists everything in the display order of §2.4", () => {
    const out = goLiveBlockers(rows({ dmarc: "bad", "remote-access": "warn" }), {
      replyTestPassed: false,
      paused: true,
      practiceCopy: false,
      sendersWithoutRoute: ["Ali"],
      connected: true,
      checkFresh: false,
      setup: "C",
      liveTest: "none",
      workerRunning: false,
    });
    expect(out).toEqual([
      T.checkStale,
      "Row dmarc: not done yet (Domain checklist).",
      "Row remote-access: needs attention (Domain checklist).",
      T.setupA,
      T.replyTestNotPassed,
      T.paused,
      "Ali has no working reply route.",
      T.liveTestNone,
      T.workerStopped,
    ]);
  });
});

describe("liveLaunchBlockers and modeWarnings after go-live (M6-DESIGN §2.3)", () => {
  const ready = { ...connected, setup: "A" as const, replyTestPassedOnDomain: true };

  it("an empty test list blocks a live launch only before go-live", () => {
    expect(liveLaunchBlockers(rows(), { ...ready, testListSize: 0 })).toEqual([T.emptyTestListLaunch]);
    expect(liveLaunchBlockers(rows(), { ...ready, testListSize: 0, goLive: false })).toEqual([T.emptyTestListLaunch]);
    expect(liveLaunchBlockers(rows(), { ...ready, testListSize: 0, goLive: true })).toEqual([]);
    // Everything else still applies after go-live.
    expect(liveLaunchBlockers(rows(), { ...ready, testListSize: 0, goLive: true, setup: "B", replyTestPassedOnDomain: false })).toEqual([
      T.setupA,
      T.replyTestPass,
    ]);
  });

  it("Test mode still warns about an empty test list after go-live; Live doesn't", () => {
    expect(modeWarnings("TEST", { testListSize: 0, goLive: true })).toEqual([T.emptyTestListWarning]);
    expect(modeWarnings("LIVE", { testListSize: 0, goLive: true })).toEqual([]);
    expect(modeWarnings("LIVE", { testListSize: 0, goLive: false })).toEqual([T.emptyTestListWarning]);
    expect(modeWarnings("TEST", { testListSize: 3, goLive: true })).toEqual([]);
    expect(modeWarnings("DRY_RUN", { testListSize: 0, goLive: true })).toEqual([]);
  });
});

// ───────────────────────── the shared From address (SHARED-FROM-DESIGN §3.3) ─────────────────────────

describe("the gates with a shared From address", () => {
  const readyToLaunch = { ...connected, setup: "A" as const, replyTestPassedOnDomain: true };
  const replyTestCtx = { ...connected, mode: "TEST" as const, ownerRouteOk: true, publicAddressOk: true, setup: "A" as const };

  it("liveModeBlockers: a never-checked from-mx row asks for a check, a bad one says so, right after the DNS sentence", () => {
    expect(liveModeBlockers(rows({ "from-mx": "absent" }), { ...connected, teamFrom: true })).toEqual([T.fromMxUnchecked]);
    expect(liveModeBlockers(rows({ "from-mx": "bad" }), { ...connected, teamFrom: true })).toEqual([T.fromMx]);
    expect(liveModeBlockers(rows({ "from-mx": "bad", spf: "bad", webhooks: "bad" }), { ...connected, teamFrom: true })).toEqual([
      T.dns,
      T.fromMx,
      T.webhooks,
    ]);
    // "warn", "unknown" and "ok" add nothing.
    for (const status of ["warn", "unknown", "ok"] as const) {
      expect(liveModeBlockers(rows({ "from-mx": status }), { ...connected, teamFrom: true })).toEqual([]);
    }
  });

  it("liveModeBlockers: per-person mode (teamFrom absent or false) ignores the from-* rows", () => {
    expect(liveModeBlockers(rows({ "from-mx": "bad", "from-spf": "bad" }), connected)).toEqual([]);
    expect(liveModeBlockers(rows({ "from-mx": "absent" }), { ...connected, teamFrom: false })).toEqual([]);
  });

  it("the texts", () => {
    expect(T.fromMx).toBe(
      "Mail for your main domain points to Mailgun or is missing. It must stay with your mail provider, never Mailgun (Domain checklist).",
    );
    expect(T.fromMxUnchecked).toBe(
      "The Domain checklist hasn't checked your main domain's mail servers (MX) yet. Click Check again on the Domain checklist.",
    );
    // Review SETTING-1: a sending-domain change (a region-only move too) restarts evidence like a From change.
    expect(T.checkBeforeFromChange).toBe(
      "The Domain checklist was checked before the From address or the sending domain changed. Click Check again on the Domain checklist, then come back.",
    );
  });

  it("liveLaunchBlockers and replyTestBlockers pass teamFrom through", () => {
    expect(liveLaunchBlockers(rows({ "from-mx": "bad" }), { ...readyToLaunch, teamFrom: true })).toEqual([T.fromMx]);
    expect(liveLaunchBlockers(rows({ "from-mx": "bad" }), readyToLaunch)).toEqual([]);
    expect(replyTestBlockers(rows({ "from-mx": "absent" }), { ...replyTestCtx, teamFrom: true })).toEqual([T.fromMxUnchecked]);
    expect(replyTestBlockers(rows({ "from-mx": "absent" }), replyTestCtx)).toEqual([]);
  });

  const goLiveCtx = {
    replyTestPassed: true,
    paused: false,
    practiceCopy: false,
    sendersWithoutRoute: [],
    connected: true,
    checkFresh: true,
    setup: "A" as const,
    liveTest: "delivered" as const,
    workerRunning: true,
  };

  it("goLiveBlockers: the from-mx row must be ok, in the '…: not done yet' form with its own title", () => {
    const title = "Mail for example.com stays with your mail provider (MX)";
    const withTitle = rows().map((r) => (r.key === "from-mx" ? { ...r, status: "bad" as const, title } : r));
    expect(goLiveBlockers(withTitle, { ...goLiveCtx, teamFrom: true })).toEqual([`${title}: not done yet (Domain checklist).`]);
    expect(goLiveBlockers(rows({ "from-mx": "absent" }), { ...goLiveCtx, teamFrom: true })).toEqual([
      `${CHECKLIST_ROW_TITLES["from-mx"]}: not done yet (Domain checklist).`,
    ]);
    expect(goLiveBlockers(rows({ "from-mx": "warn" }), { ...goLiveCtx, teamFrom: true })[0]).toMatch(/: needs attention/);
    // Per-person mode: never asked, and from-spf never blocks going live.
    expect(goLiveBlockers(rows({ "from-mx": "bad" }), goLiveCtx)).toEqual([]);
    expect(goLiveBlockers(rows({ "from-spf": "bad" }), { ...goLiveCtx, teamFrom: true })).toEqual([]);
  });

  it("goLiveBlockers: a checklist checked before the From change says so instead of 'more than an hour ago'", () => {
    expect(goLiveBlockers(rows(), { ...goLiveCtx, checkFresh: false, checkBeforeFromChange: true, teamFrom: true })).toEqual([
      T.checkBeforeFromChange,
    ]);
    expect(goLiveBlockers(rows(), { ...goLiveCtx, checkFresh: false, checkBeforeFromChange: false })).toEqual([T.checkStale]);
    expect(goLiveBlockers(rows(), { ...goLiveCtx, checkFresh: false })).toEqual([T.checkStale]);
    // Fresh: the flag means nothing.
    expect(goLiveBlockers(rows(), { ...goLiveCtx, checkBeforeFromChange: true })).toEqual([]);
  });
});
