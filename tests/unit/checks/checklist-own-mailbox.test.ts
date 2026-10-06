import { describe, expect, it } from "vitest";
import {
  APPLY_STEP_TEXTS,
  applyStepStatus,
  buildChecklistRows,
  checklistTitle,
  COULD_NOT_CHECK,
  lastGoodMxOf,
  ownMxCause,
  OWN_SPF_TEXTS,
  SPREADING,
  type ChecklistFacts,
  type DmarcFind,
  type FromDomainFacts,
  type SpfWalk,
  type TwoAnswers,
} from "@/core/dns/checklist";
import { planLimits } from "@/core/mailgun/plan";
import { NEVER_MAILGUN_MX_TEXT, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import type { DnsAnswer } from "@/core/dns/types";
import type { ChecklistRow, ChecklistRowKey, TunnelState } from "@/core/system-state";
import { formatShortDate } from "@/core/time/format";

/**
 * The Domain checklist in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.3, §5, O10–O12, O37): the own-mailbox list and order,
 * the include-aware SPF row (GoDaddy's `_spfm` wrapping), the inverted MX guard for the sending domain itself with the
 * last good MX, the info rows the Free plan and a missing public address leave, the reply test that counts only in its
 * own mode and From, and the safety rules: no MX record box and no SPF value anywhere, in own-mailbox mode and for a
 * website domain checked in app mode.
 */

const D = "example.com";
const FROM = "contact@example.com";
const NOW = new Date("2026-09-28T10:00:00Z");
const DKIM = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekey";
const MG_SPF = "v=spf1 include:mailgun.org ~all";
const PUB = "https://outreach.example.com";
const HOOK = `${PUB}/api/webhooks/mailgun/events`;
const ZOHO = [
  { priority: 10, exchange: "mx.zoho.com" },
  { priority: 20, exchange: "mx2.zoho.com" },
  { priority: 50, exchange: "mx3.zoho.com" },
];
const ZOHO_GOOD = [
  { priority: 10, host: "mx.zoho.com" },
  { priority: 20, host: "mx2.zoho.com" },
  { priority: 50, host: "mx3.zoho.com" },
];
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
/** Mailgun's receiving MX hosts: never in a fix except inside NEVER_MAILGUN_MX_TEXT (§2.5 item 4). */
const MAILGUN_MX_HOSTS = ["mxa.mailgun.org", "mxb.mailgun.org", "mxa.eu.mailgun.org", "mxb.eu.mailgun.org"];

const ok = <T>(value: T): DnsAnswer<T> => ({ ok: true, value });
const missing: DnsAnswer<never> = { ok: false, code: "missing", detail: "ENOTFOUND" };
const timeout: DnsAnswer<never> = { ok: false, code: "timeout", detail: "ETIMEOUT" };
const both = <T>(value: T): TwoAnswers<T> => ({ a: ok(value), b: ok(value) });
const none = <T>(): TwoAnswers<T> => ({ a: missing, b: missing });

const godaddy = (d: string) => `v=spf1 include:dc-1._spfm.${d} include:dc-2._spfm.${d} ~all`;
/** The names the SPF walk looks up for the owner's record: 9 lookups, Mailgun reached through dc-2._spfm. */
const names = (d: string) => [`dc-1._spfm.${d}`, "zoho.com", "transmail.net", "zcsend.net", `dc-2._spfm.${d}`, "mailgun.org", "_spf.mailgun.org"];

function found(policy: string | null, at: string): DmarcFind {
  if (!policy) return { at: null, policy: null, duplicates: false, inherited: false, error: null };
  const p = /p=(\w+)/.exec(policy)?.[1] ?? null;
  const rua = /rua=([^;]+)/.exec(policy)?.[1]?.split(",") ?? [];
  return { at, policy: { p, sp: null, rua, adkim: null, aspf: null, raw: policy }, duplicates: false, inherited: false, error: null };
}

function tunnel(): TunnelState {
  const at = NOW.toISOString();
  return {
    checkedAt: at,
    state: "connected",
    readyConnections: 4,
    port: 20241,
    connectorId: "c-1",
    version: "2026.9.1",
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: { at, ok: true, status: 200, error: null },
    webhookPathCheck: { at, ok: true, status: 406, error: null },
    appProtectedCheck: { at, ok: true, status: 302, location: "https://team.cloudflareaccess.com/login", error: null },
    selfCheckNonce: "n",
  };
}

/** The owner's shape: own-mailbox mode on the Free plan, no public address, GoDaddy's SPF, Zoho's MX, _dmarc added. */
function ownFacts(d = D, from = `contact@${d}`): ChecklistFacts {
  const dmarc = { a: found("v=DMARC1; p=none", d), b: found("v=DMARC1; p=none", d), ruaAuthorized: {} };
  const txt = both([godaddy(d), "google-site-verification=abc", "zoho-verification=zb123.zmverify.zoho.com"]);
  return {
    domain: d,
    region: "US",
    now: NOW,
    timeZone: "Asia/Karachi",
    mailgun: {
      ok: true,
      value: {
        state: "active",
        isDisabled: false,
        disabledReason: null,
        spamAction: "disabled",
        webPrefix: "email",
        webScheme: "http",
        messageTtl: 86_400,
        webhooksRedactPii: false,
        sending: [
          { recordType: "TXT", name: d, value: MG_SPF, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "TXT", name: `mx._domainkey.${d}`, value: DKIM, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "CNAME", name: `email.${d}`, value: "mailgun.org", priority: null, valid: "valid", isActive: true, cached: [] },
        ],
        receiving: [
          { recordType: "MX", name: null, value: "mxa.mailgun.org", priority: "10", valid: "unverified", isActive: true, cached: [] },
          { recordType: "MX", name: null, value: "mxb.mailgun.org", priority: "10", valid: "unverified", isActive: true, cached: [] },
        ],
      },
    },
    verifyError: null,
    dns: {
      txt,
      spfLookups: { count: 9, complete: true, names: names(d) },
      dkim: [{ name: `mx._domainkey.${d}`, recordType: "TXT", expected: DKIM, answers: both([DKIM]), proxied: null, doubled: null }],
      mx: both(ZOHO),
      tracking: { host: `email.${d}`, expected: "mailgun.org", cname: both(["mailgun.org."]), a: null, doubled: null },
      dmarc,
    },
    certificate: { ok: true, value: { status: "none", error: null } },
    setupCertificate: "not-in-plan",
    tracking: { ok: true, value: { openActive: false, clickActive: false, unsubscribeActive: true, htmlFooter: "", textFooter: "" } },
    unsubscribeSetup: "A",
    messageRetentionDays: 1,
    webhooks: { url: null, map: { ok: true, value: {} } },
    signingKey: { saved: true, matches: true, problem: null },
    routes: { senders: [], catchAllRouteId: null, listsError: null },
    queues: { ok: true, value: { regularDisabled: false, reason: null } },
    pause: [],
    monthlyLimit: { ok: true, value: null },
    tunnel: tunnel(),
    publicUrl: null,
    fakeMode: false,
    replyTest: { status: "passed", setup: "A", domain: d, decidedAt: "2026-09-22T09:00:00Z", from, replies: "own-mailbox" },
    domainRegisteredOn: "2024-08-22",
    from: {
      address: from,
      domain: d,
      problem: null,
      signingDomain: d,
      originalSigner: null,
      originalPasted: false,
      dns: { txt, spfLookups: { count: 9, complete: true, dangling: [], names: names(d) }, mx: both(ZOHO), dmarc },
    },
    ownMailbox: true,
    plan: planLimits(null, "own-mailbox"),
    lastGoodMx: null,
  };
}

function rows(f: ChecklistFacts, keyBits: number | null = 1024): ChecklistRow[] {
  return buildChecklistRows(f, { keyBits });
}

function rowOf(f: ChecklistFacts, key: ChecklistRowKey, keyBits: number | null = 1024): ChecklistRow {
  const r = rows(f, keyBits).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

function own(change: (f: ChecklistFacts, x: FromDomainFacts) => void, d = D): ChecklistFacts {
  const f = ownFacts(d);
  change(f, f.from!);
  return f;
}

/** The own DNS of the sending domain (facts.from.dns): the SPF row and the from-mx row read it. */
function ownDns(f: ChecklistFacts): NonNullable<FromDomainFacts["dns"]> {
  return f.from!.dns!;
}

// ───────────────────────── the list ─────────────────────────

describe("own-mailbox mode: the rows", () => {
  it("are the own-mailbox list, in order: no mx, spam-filter, retention, reply-routes or from-spf", () => {
    const r = rows(ownFacts());
    expect(r.map((x) => x.key)).toEqual(OWN_KEYS);
    for (const k of ["mx", "spam-filter", "retention", "reply-routes", "from-spf"] as const) expect(r.map((x) => x.key)).not.toContain(k);
    expect(r.map((x) => [x.key, x.status])).toEqual([
      ["mailgun-domain", "ok"],
      ["spf", "ok"],
      ["dkim", "ok"],
      ["tracking-cname", "ok"],
      ["https-links", "info"],
      ["dmarc", "ok"],
      ["from-mx", "ok"],
      ["tracking-off", "ok"],
      ["unsubscribe", "ok"],
      ["signing-key", "ok"],
      ["webhooks", "info"],
      ["sending-allowed", "ok"],
      ["monthly-limit", "info"],
      ["remote-access", "info"],
      ["reply-test", "ok"],
      ["postmaster", "info"],
      ["domain-age", "ok"],
    ]);
  });

  it("titles from-mx and spf with the sending domain itself; from-mx sits in the dns group, right after dmarc", () => {
    const r = rows(ownFacts());
    const mx = r.find((x) => x.key === "from-mx")!;
    expect(mx).toMatchObject({ group: "dns", title: "Mail for example.com stays with your mail provider (MX)", records: [] });
    expect(mx.title).toBe(checklistTitle("from-mx", D));
    expect(r.find((x) => x.key === "spf")!.title).toBe("Mailgun may send for example.com (SPF)");
    const keys = r.map((x) => x.key);
    expect(keys.indexOf("from-mx")).toBe(keys.indexOf("dmarc") + 1);
  });

  it("has a record box only on DKIM, the tracking CNAME and _dmarc", () => {
    for (const f of [ownFacts(), own((g) => (g.dns!.txt = none())), own((_g, x) => (x.dns!.mx = none()))]) {
      const withBoxes = rows(f).filter((x) => x.records.length > 0).map((x) => x.key);
      expect(withBoxes.every((k) => ["dkim", "tracking-cname", "dmarc"].includes(k)), withBoxes.join()).toBe(true);
    }
  });

  it("with the owner's real domain: the texts name polygonparadise.com, and its age is 767 days", () => {
    const P = "polygonparadise.com";
    const r = Object.fromEntries(rows(ownFacts(P)).map((x) => [x.key, x]));
    expect(r["from-mx"]!.title).toBe("Mail for polygonparadise.com stays with your mail provider (MX)");
    expect(r.dkim!.text).toBe("Your emails carry polygonparadise.com's digital signature (1024-bit; it works, 2048-bit is stronger).");
    expect(r["domain-age"]).toMatchObject({ status: "ok", text: "polygonparadise.com is 767 days old." });
    expect(r.spf!.text).toBe(
      "Mailgun may send for polygonparadise.com (through its SPF record's includes). The record is almost full: 9 of 10 DNS lookups. Before you add another email service to polygonparadise.com, ask the person who set up the app.",
    );
  });

  it("app-mode facts for another domain are exactly today's rows (the own-mailbox fields are ignored without the flag)", () => {
    const app = own((f) => {
      delete f.ownMailbox;
      delete f.from;
      delete f.plan;
      delete f.lastGoodMx;
      delete f.replyTest.replies;
    });
    const r = rows(app);
    expect(r.map((x) => x.key)).toContain("mx");
    expect(rows({ ...app, ownMailbox: false, plan: planLimits("free", "app"), lastGoodMx: ZOHO_GOOD })).toEqual(r);
    // Today's app-mode mx row still asks for Mailgun's MX records on a domain that isn't a website domain.
    expect(r.find((x) => x.key === "mx")!.records.map((x) => x.type)).toEqual(["MX", "MX"]);
  });
});

// ───────────────────────── mailgun-domain, dkim, https-links ─────────────────────────

describe("own-mailbox mode: mailgun-domain, dkim and https-links", () => {
  it("mailgun-domain not active: the fix never sends the Owner to Mailgun's MX records", () => {
    const r = rowOf(own((f) => ((f.mailgun as { value: { state: string } }).value.state = "unverified")), "mailgun-domain");
    expect(r).toMatchObject({
      status: "bad",
      text: "Mailgun has your domain (US) but hasn't confirmed your records yet.",
      fix: OWN_MAILBOX_TEXTS.mailgunDomainFix(D),
    });
    expect(r.fix).toBe(
      "Check the SPF, DKIM and tracking rows below, then click Check again in a few minutes. Mailgun's page for example.com also lists MX records: leave them out. Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to example.com.",
    );
    expect(rowOf(ownFacts(), "mailgun-domain").text).toBe("Mailgun has your domain (US) and has confirmed your records.");
  });

  it("dkim: per-person wording for the sending domain, 1024-bit ok with its note", () => {
    expect(rowOf(ownFacts(), "dkim")).toMatchObject({
      status: "ok",
      text: "Your emails carry example.com's digital signature (1024-bit; it works, 2048-bit is stronger).",
    });
    expect(rowOf(ownFacts(), "dkim", 2048).text).toBe("Your emails carry example.com's digital signature (2048-bit).");
  });

  it("https-links: a plan without the certificate is info with the honest sentence; every other case as today", () => {
    expect(rowOf(ownFacts(), "https-links")).toMatchObject({
      status: "info",
      text: "Your Mailgun plan doesn't include secure (https) unsubscribe links, so they use http. They still work when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https, so it may not show. That is required only above 5,000 emails a day to Gmail.",
      fix: "Foundation and higher include https links. After upgrading, choose the plan in Settings › Sending & Mailgun › Advanced and click Apply recommended settings.",
    });
    expect(rowOf(own((f) => (f.setupCertificate = null)), "https-links")).toMatchObject({ status: "bad", text: "Unsubscribe links use http." });
    const https = own((f) => {
      f.setupCertificate = "active";
      f.certificate = { ok: true, value: { status: "active", error: null } };
      (f.mailgun as { value: { webScheme: string } }).value.webScheme = "https";
    });
    expect(rowOf(https, "https-links")).toMatchObject({ status: "ok", text: "Unsubscribe links use https, as Gmail and Yahoo require." });
  });
});

// ───────────────────────── spf ─────────────────────────

describe("own-mailbox mode: the SPF row reads Mailgun's include anywhere in the tree (O11)", () => {
  const spf = (change: (x: NonNullable<FromDomainFacts["dns"]>, f: ChecklistFacts) => void) => rowOf(own((f) => change(ownDns(f), f)), "spf");

  it("GoDaddy-style facts, 9 lookups, Mailgun reached through dc-2._spfm: ok, almost full; 10 too", () => {
    const text =
      "Mailgun may send for example.com (through its SPF record's includes). The record is almost full: 9 of 10 DNS lookups. Before you add another email service to example.com, ask the person who set up the app.";
    expect(rowOf(ownFacts(), "spf")).toMatchObject({ status: "ok", text, fix: null, records: [] });
    expect(spf((x) => (x.spfLookups = { count: 10, complete: true, dangling: [], names: names(D) }))).toMatchObject({
      status: "ok",
      text: text.replace("9 of 10", "10 of 10"),
    });
  });

  it("below 9 lookups: ok with the count; a top-level include:mailgun.org counts too (with or without names)", () => {
    expect(spf((x) => (x.spfLookups = { count: 5, complete: true, dangling: [], names: names(D) }))).toMatchObject({
      status: "ok",
      text: "Mailgun may send for example.com (5 of 10 DNS lookups).",
    });
    const topLevel = spf((x) => {
      x.txt = both([MG_SPF]);
      x.spfLookups = { count: 2, complete: true, dangling: [], names: ["mailgun.org", "_spf.mailgun.org"] };
    });
    expect(topLevel).toMatchObject({ status: "ok", text: "Mailgun may send for example.com (2 of 10 DNS lookups)." });
    const noNames = spf((x) => {
      x.txt = both([MG_SPF]);
      x.spfLookups = { count: 2, complete: true, dangling: [] };
    });
    expect(noNames.status).toBe("ok");
  });

  it("Mailgun missing from the tree: bad, and the include is added only by the person who set up the app (never a merged record)", () => {
    const r = spf((x) => (x.spfLookups = { count: 4, complete: true, dangling: [], names: [`dc-1._spfm.${D}`, "zoho.com", `dc-2._spfm.${D}`] }));
    expect(r).toMatchObject({
      status: "bad",
      text: "example.com's SPF record doesn't include Mailgun, so the app's emails fail SPF.",
      fix: "Ask the person who set up the app to add include:mailgun.org to example.com's SPF record (Name @), just before ~all, changing nothing else. Your everyday email depends on that record too, so don't edit it yourself. It uses 4 of 10 DNS lookups now, and include:mailgun.org adds about 5.",
      records: [],
    });
    expect(r.fix).toBe(OWN_SPF_TEXTS.noMailgunFix(D, "@", "include:mailgun.org", 4));
    // Review DOMAIN-1: the guide says never to edit the SPF record yourself; no fix tells the Owner to do it.
    expect(r.fix!.startsWith("Ask the person who set up the app")).toBe(true);
    // Mailgun's EU include is what counts for an EU domain.
    const eu = own((f) => {
      f.region = "EU";
      (f.mailgun as { value: { sending: Array<{ value: string }> } }).value.sending[0]!.value = "v=spf1 include:eu.mailgun.org ~all";
    });
    expect(rowOf(eu, "spf")).toMatchObject({ status: "bad", fix: expect.stringContaining("add include:eu.mailgun.org to example.com's SPF record") });
  });

  it("more than 10 lookups: bad (by its count first, even when the walk stopped before Mailgun's include)", () => {
    const r = spf((x) => (x.spfLookups = { count: 11, complete: true, dangling: [], names: [`dc-1._spfm.${D}`] }));
    expect(r).toMatchObject({
      status: "bad",
      text: "example.com's SPF record needs 11 DNS lookups (the limit is 10), so mail servers treat it as broken: your campaign emails and your everyday email fail SPF.",
      fix: "Ask the person who set up the app to remove services you no longer use from it. Keep include:mailgun.org: without it Mailgun can't send for example.com.",
    });
    // A lower bound over 10 is over 10 too.
    expect(spf((x) => (x.spfLookups = { count: 14, complete: false, dangling: [], names: [] })).status).toBe("bad");
  });

  it("a dangling include: bad, naming it", () => {
    const r = spf((x) => (x.spfLookups = { count: 4, complete: true, dangling: [`dc-1._spfm.${D}`], names: names(D) }));
    expect(r).toMatchObject({
      status: "bad",
      text: "example.com's SPF record includes dc-1._spfm.example.com, which has no SPF record, so mail servers treat example.com's SPF as broken: your campaign emails and your everyday email fail SPF.",
      fix: "If example.com's DNS moved recently, add the TXT record of dc-1._spfm.example.com again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app.",
    });
  });

  it("two records (on either resolver): bad, merge by hand, nothing built", () => {
    const r = spf((x) => (x.txt = { a: ok([godaddy(D), MG_SPF]), b: ok([godaddy(D)]) }));
    expect(r).toMatchObject({
      status: "bad",
      text: "example.com has 2 SPF records, so mail servers ignore all of them: your campaign emails and your everyday email fail SPF.",
      fix: "Ask the person who set up the app to merge them into one record, keeping every part of both (including include:mailgun.org).",
    });
  });

  it("no record (both agree, NXDOMAIN or only other TXT): bad, added by the person who set up the app from the provider's help pages", () => {
    const fix =
      "Ask the person who set up the app to add an SPF record for example.com (Name @) as your mail provider's help pages show it, with include:mailgun.org just before ~all. Your everyday email depends on it too, so don't add it yourself. Then click Check again.";
    expect(OWN_SPF_TEXTS.noRecordFix(D, "@", "include:mailgun.org")).toBe(fix);
    const text = "example.com has no SPF record, so mail servers can't tell that Mailgun may send for it.";
    expect(spf((x) => ((x.txt = none()), (x.spfLookups = null)))).toMatchObject({ status: "bad", text, fix });
    expect(spf((x) => ((x.txt = both(["google-site-verification=abc"])), (x.spfLookups = null)))).toMatchObject({ status: "bad", text, fix });
  });

  it("+all: bad; spreading: warn; a timeout: unknown; an unfinished count up to 10: unknown", () => {
    expect(spf((x) => (x.txt = both([`v=spf1 include:dc-1._spfm.${D} include:dc-2._spfm.${D} +all`])))).toMatchObject({
      status: "bad",
      text: "Your SPF record lets anyone send email for your domain (+all).",
      fix: "Change +all at the end to ~all.",
    });
    expect(spf((x) => (x.txt = { a: ok([godaddy(D)]), b: missing }))).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    expect(spf((x) => (x.txt = { a: timeout, b: missing }))).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK });
    for (const n of [4, 9, 10]) {
      expect(spf((x) => (x.spfLookups = { count: n, complete: false, dangling: [], names: [] }))).toMatchObject({
        status: "unknown",
        text: `Couldn't count all the DNS lookups example.com's SPF record needs: at least ${n} of the 10 allowed.`,
        fix: null,
      });
    }
  });

  it("Mailgun's facts or the DNS couldn't be read: unknown", () => {
    const noMailgun = own((f) => (f.mailgun = { ok: false, kind: "unreachable", message: "timeout" }));
    expect(rowOf(noMailgun, "spf")).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK, fix: "Fix the 'Mailgun knows your domain' row first." });
    const noDns = own((f) => (f.dns = null));
    expect(rowOf(noDns, "spf")).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK });
    // The own list stays whole without Mailgun: the DMARC and MX rows read the domain's own DNS.
    expect(rows(noMailgun).map((x) => x.key)).toEqual(OWN_KEYS);
    expect(rowOf(noMailgun, "dmarc").status).toBe("ok");
    expect(rowOf(noMailgun, "from-mx").status).toBe("ok");
  });
});

// ───────────────────────── spf: both resolvers' walks (review DOMAIN-1) ─────────────────────────

describe("own-mailbox mode: the SPF row compares both resolvers' walks (review DOMAIN-1)", () => {
  /** The owner's tree walked in full: 9 lookups, Mailgun reached through dc-2._spfm. */
  const full = (): SpfWalk => ({ count: 9, complete: true, dangling: [], names: names(D) });
  /** The same tree on a resolver that has no dc-2._spfm (a cache, or a DNS move halfway): Mailgun not reached. */
  const lostHelper = (): SpfWalk => ({ count: 5, complete: true, dangling: [`dc-2._spfm.${D}`], names: names(D).slice(0, 5) });
  const walks = (a: SpfWalk | null, b: SpfWalk | null, change?: (x: NonNullable<FromDomainFacts["dns"]>) => void) =>
    rowOf(
      own((_f, x) => {
        const done = [a, b].filter((w): w is SpfWalk => w !== null);
        x.dns!.spfLookups = {
          count: Math.max(...done.map((w) => w.count)),
          complete: done.every((w) => w.complete),
          dangling: a && b ? a.dangling.filter((n) => b.dangling.includes(n)) : [],
          names: [...new Set(done.flatMap((w) => w.names))],
          walks: [a, b],
        };
        change?.(x.dns!);
      }),
      "spf",
    );

  it("both walks agree: as before (ok and almost full, 9 of 10)", () => {
    expect(walks(full(), full())).toMatchObject({ status: "ok", text: expect.stringContaining("9 of 10 DNS lookups") });
  });

  it("a helper missing on only one resolver, either one: still spreading, never the add-include fix, never ok", () => {
    for (const [a, b] of [
      [lostHelper(), full()],
      [full(), lostHelper()],
    ]) {
      const r = walks(a, b);
      expect(r).toMatchObject({ status: "warn", text: SPREADING, fix: null });
      // Details name each resolver's walk.
      expect(r.detail).toContain("Walk on 1.1.1.1:");
      expect(r.detail).toContain("Walk on 8.8.8.8:");
      expect(r.detail).toContain(`without an SPF record: dc-2._spfm.${D}`);
    }
  });

  it("the same helper missing on both: the dangling fix (re-add it), as before", () => {
    expect(walks(lostHelper(), lostHelper())).toMatchObject({ status: "bad", text: expect.stringContaining(`includes dc-2._spfm.${D}, which has no SPF record`) });
  });

  it("one resolver still has the old top-level record: still spreading (the records differ)", () => {
    const old = "v=spf1 include:dc-1._spfm.example.com ~all";
    const r = walks({ count: 5, complete: true, dangling: [], names: names(D).slice(0, 4) }, full(), (x) => (x.txt = { a: ok([old]), b: ok([godaddy(D)]) }));
    expect(r).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    // Spaces and case alone don't make two records different.
    expect(walks(full(), full(), (x) => (x.txt = { a: ok([godaddy(D)]), b: ok([godaddy(D).toUpperCase().replace(/ /g, "  ")]) })).status).toBe("ok");
  });

  it("the walks differ in Mailgun's include, or only in the count: still spreading", () => {
    const noMailgun: SpfWalk = { count: 5, complete: true, dangling: [], names: [...names(D).slice(0, 5)] };
    expect(walks(noMailgun, full())).toMatchObject({ status: "warn", text: SPREADING });
    expect(walks({ ...full(), count: 7 }, full())).toMatchObject({ status: "warn", text: SPREADING });
    // Over 10 on one only: still spreading too (the other still sees the smaller record).
    expect(walks({ ...full(), count: 13 }, noMailgun)).toMatchObject({ status: "warn", text: SPREADING });
  });

  it("the add-include fix only when both complete walks agree Mailgun is missing, through the person who set up the app", () => {
    const noMailgun: SpfWalk = { count: 4, complete: true, dangling: [], names: [`dc-1._spfm.${D}`, "zoho.com", "transmail.net", "zcsend.net"] };
    expect(walks(noMailgun, { ...noMailgun, names: [...noMailgun.names] })).toMatchObject({
      status: "bad",
      text: "example.com's SPF record doesn't include Mailgun, so the app's emails fail SPF.",
      fix: OWN_SPF_TEXTS.noMailgunFix(D, "@", "include:mailgun.org", 4),
    });
    // One walk couldn't finish: couldn't count (grey), never the fix.
    const unsure: SpfWalk = { count: 3, complete: false, dangling: [], names: [`dc-1._spfm.${D}`] };
    expect(walks(unsure, noMailgun)).toMatchObject({
      status: "unknown",
      text: "Couldn't count all the DNS lookups example.com's SPF record needs: at least 3 of the 10 allowed.",
      fix: null,
    });
    // One unsure, the other fine: only one resolver is right, so still spreading.
    expect(walks(unsure, full())).toMatchObject({ status: "warn", text: SPREADING });
    // Both unsure: the larger lower bound.
    expect(walks(unsure, { ...unsure, count: 4 })).toMatchObject({ status: "unknown", text: expect.stringContaining("at least 4 of the 10") });
  });

  it("over 10 on both (a repeated include counted every time): bad with the larger count", () => {
    expect(walks({ ...full(), count: 13 }, { ...full(), count: 12 })).toMatchObject({
      status: "bad",
      text: "example.com's SPF record needs 13 DNS lookups (the limit is 10), so mail servers treat it as broken: your campaign emails and your everyday email fail SPF.",
    });
  });

  it("a walk missing although both resolvers answered a record: couldn't check", () => {
    expect(walks(full(), null)).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK, fix: null });
  });
});

// ───────────────────────── from-mx ─────────────────────────

describe("own-mailbox mode: from-mx guards the sending domain's own MX (O10)", () => {
  const mx = (change: (x: NonNullable<FromDomainFacts["dns"]>, f: ChecklistFacts) => void) => rowOf(own((f) => change(ownDns(f), f)), "from-mx");
  const withLast = (change: (x: NonNullable<FromDomainFacts["dns"]>) => void) =>
    mx((x, f) => {
      change(x);
      // Stored in another order: the fix names them by priority.
      f.lastGoodMx = [ZOHO_GOOD[2]!, ZOHO_GOOD[0]!, ZOHO_GOOD[1]!];
    });
  const NEVER = NEVER_MAILGUN_MX_TEXT(D);
  const PUT_BACK = "put back your mail provider's MX records: mx.zoho.com (priority 10), mx2.zoho.com (priority 20), mx3.zoho.com (priority 50)";
  const PUT_BACK_NONE = "put back your mail provider's MX records (its help pages list them)";

  it("ok: the mail provider's hosts", () => {
    expect(rowOf(ownFacts(), "from-mx")).toMatchObject({
      status: "ok",
      text: "Mail for example.com goes to your mail provider (mx.zoho.com, mx2.zoho.com, mx3.zoho.com), not to Mailgun, so replies reach your inbox. Keep it that way.",
      fix: null,
      records: [],
    });
  });

  it("a Mailgun MX on either resolver: bad; keeps the provider's hosts, or puts back the last good MX", () => {
    const text =
      "example.com's mail servers (MX) point to Mailgun. Your everyday email and every reply to your campaigns would go to Mailgun, where nobody reads them. Live campaign emails wait until this is fixed.";
    expect(mx((x) => (x.mx = { a: ok([...ZOHO, { priority: 5, exchange: "mxa.mailgun.org" }]), b: ok(ZOHO) }))).toMatchObject({
      status: "bad",
      text,
      fix: `In the DNS panel for example.com (GoDaddy), delete the MX records of example.com (Name @) that point to Mailgun, and keep only mx.zoho.com, mx2.zoho.com, mx3.zoho.com. ${NEVER} Then click Check again.`,
    });
    const mailgunOnly = (x: NonNullable<FromDomainFacts["dns"]>) => (x.mx = both([{ priority: 10, exchange: "mxa.mailgun.org" }, { priority: 10, exchange: "mxb.mailgun.org" }]));
    expect(withLast(mailgunOnly)).toMatchObject({
      status: "bad",
      text,
      fix: `In the DNS panel for example.com (GoDaddy), delete the MX records of example.com (Name @) that point to Mailgun, and ${PUT_BACK}. ${NEVER} Then click Check again.`,
    });
    expect(mx(mailgunOnly).fix).toBe(
      `In the DNS panel for example.com (GoDaddy), delete the MX records of example.com (Name @) that point to Mailgun, and ${PUT_BACK_NONE}. ${NEVER} Then click Check again.`,
    );
    // Either region, and a trailing dot.
    expect(mx((x) => (x.mx = both([{ priority: 10, exchange: "mxb.eu.mailgun.org." }]))).status).toBe("bad");
    // One resolver still sees only the provider: still red (a Mailgun host on either resolver is enough).
    expect(mx((x) => (x.mx = { a: ok(ZOHO), b: ok([{ priority: 10, exchange: "mxa.mailgun.org" }]) })).status).toBe("bad");
  });

  it("a null MX: bad, with the last good MX (or the help pages) to put back", () => {
    const text =
      'example.com\'s MX record says it takes no email (a "null MX"), so replies to your campaigns bounce, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.';
    expect(withLast((x) => (x.mx = both([{ priority: 0, exchange: "" }])))).toMatchObject({
      status: "bad",
      text,
      fix: `In the DNS panel for example.com, delete the MX record of example.com (Name @) whose value is just a dot, and ${PUT_BACK}. ${NEVER} Then click Check again.`,
    });
    expect(mx((x) => (x.mx = both([{ priority: 0, exchange: "." }]))).fix).toContain(PUT_BACK_NONE);
  });

  it("no MX (both agree): bad", () => {
    expect(withLast((x) => (x.mx = none()))).toMatchObject({
      status: "bad",
      text: "example.com has no mail servers (MX), so replies to your campaigns can't reach you, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.",
      fix: `In the DNS panel for example.com, ${PUT_BACK} (Name @). ${NEVER} Then click Check again.`,
    });
  });

  it("Cloudflare Email Routing: bad in this mode (app mode keeps its amber row)", () => {
    const cf = [
      { priority: 10, exchange: "route1.mx.cloudflare.net" },
      { priority: 20, exchange: "route2.mx.cloudflare.net" },
    ];
    expect(withLast((x) => (x.mx = both(cf)))).toMatchObject({
      status: "bad",
      text: "Mail for example.com goes to Cloudflare Email Routing (route1.mx.cloudflare.net, route2.mx.cloudflare.net), not to your mailbox at your mail provider, so your everyday email and the replies to your campaigns may never reach it. Live campaign emails wait until this is fixed.",
      fix: `In Cloudflare, switch Email Routing off for example.com, then in its DNS ${PUT_BACK}. ${NEVER} Then click Check again.`,
    });
  });

  it("spreading: warn; a timeout: unknown; built with no From saved too", () => {
    expect(mx((x) => (x.mx = { a: ok(ZOHO), b: missing }))).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    expect(mx((x) => (x.mx = { a: timeout, b: missing }))).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK });
    const noFrom = own((_f, x) => (x.address = ""));
    expect(rowOf(noFrom, "from-mx")).toMatchObject({ status: "ok", title: "Mail for example.com stays with your mail provider (MX)" });
  });
});

describe("ownMxCause: the cause the row and the Owner's notice share (review DOMAIN-8)", () => {
  it("names the red row's cause in the row's own order, null for ok, spreading and couldn't check", () => {
    const cf = [{ priority: 10, exchange: "route1.mx.cloudflare.net" }];
    expect(ownMxCause(both([{ priority: 10, exchange: "mxa.mailgun.org" }, ...cf]))).toBe("mailgun");
    expect(ownMxCause(both([{ priority: 0, exchange: "" }]))).toBe("null-mx");
    expect(ownMxCause(none())).toBe("no-mx");
    expect(ownMxCause(both(cf))).toBe("cloudflare");
    expect(ownMxCause({ a: ok(cf), b: missing })).toBe("cloudflare");
    expect(ownMxCause(both(ZOHO))).toBeNull();
    expect(ownMxCause({ a: ok(ZOHO), b: missing })).toBeNull();
    expect(ownMxCause({ a: timeout, b: missing })).toBeNull();
    expect(ownMxCause(null)).toBeNull();
    // Every red from-mx row has a cause, and every cause is a red row.
    const cases: Array<TwoAnswers<Array<{ priority: number; exchange: string }>>> = [
      both(cf),
      none(),
      both([{ priority: 0, exchange: "" }]),
      both([{ priority: 10, exchange: "mxb.eu.mailgun.org" }]),
      both(ZOHO),
    ];
    for (const mx of cases) {
      const r = rowOf(own((_f, x) => (x.dns!.mx = mx)), "from-mx");
      expect(r.status === "bad", r.text).toBe(ownMxCause(mx) !== null);
    }
  });
});

describe("Apply's step words on the Recommended settings card (review DOMAIN-3, SCREENS-06)", () => {
  it("done and not done as before; no result: Not needed, Optional, Not in your plan (grey), else Waiting", () => {
    expect(applyStepStatus({ ok: true, text: "Open tracking is off." })).toEqual({ status: "ok" });
    expect(applyStepStatus({ ok: false, text: APPLY_STEP_TEXTS.certNotInPlan })).toEqual({ status: "bad" });
    expect(applyStepStatus({ ok: null, text: OWN_MAILBOX_TEXTS.applyNotNeeded })).toEqual({ status: "info", word: "Not needed" });
    expect(applyStepStatus({ ok: null, text: OWN_MAILBOX_TEXTS.applyNoPublicAddress })).toEqual({ status: "info", word: "Optional" });
    expect(applyStepStatus({ ok: null, text: APPLY_STEP_TEXTS.webhooksOptionalOwn })).toEqual({ status: "info", word: "Optional" });
    expect(applyStepStatus({ ok: null, text: APPLY_STEP_TEXTS.certNotInPlan })).toEqual({ status: "info", word: "Not in your plan" });
    expect(applyStepStatus({ ok: null, text: APPLY_STEP_TEXTS.httpsNotInPlanOwn })).toEqual({ status: "info", word: "Not in your plan" });
    // App mode's waiting steps keep "Waiting".
    for (const text of ["Skipped until the public address works.", "Secure unsubscribe links need the certificate first.", "Mailgun is still preparing the certificate. Check again later."]) {
      expect(applyStepStatus({ ok: null, text })).toEqual({ status: "unknown", word: "Waiting" });
    }
  });
});

describe("lastGoodMxOf (O10)", () => {
  it("keeps the hosts both resolvers agree on, by priority, never Mailgun's or Cloudflare's, at most 10", () => {
    expect(lastGoodMxOf(both([ZOHO[2]!, ZOHO[0]!, ZOHO[1]!]))).toEqual(ZOHO_GOOD);
    expect(lastGoodMxOf({ a: ok([...ZOHO, { priority: 5, exchange: "MX4.Zoho.com." }]), b: ok([...ZOHO]) })).toEqual(ZOHO_GOOD);
    expect(
      lastGoodMxOf(both([...ZOHO, { priority: 5, exchange: "mxa.mailgun.org" }, { priority: 6, exchange: "route1.mx.cloudflare.net" }, { priority: 0, exchange: "" }])),
    ).toEqual(ZOHO_GOOD);
    const many = Array.from({ length: 12 }, (_, i) => ({ priority: i, exchange: `mx${i}.provider.example` }));
    expect(lastGoodMxOf(both(many))).toHaveLength(10);
    expect(lastGoodMxOf({ a: ok(ZOHO), b: timeout })).toEqual([]);
    expect(lastGoodMxOf(both([{ priority: 10, exchange: "bad_host.example" }]))).toEqual([]);
  });
});

// ───────────────────────── dmarc, webhooks, remote access, monthly limit, postmaster ─────────────────────────

describe("own-mailbox mode: dmarc, webhooks, remote access, monthly limit and postmaster", () => {
  const withDmarc = (raw: string | null, rua: Record<string, boolean | null> = {}) =>
    rowOf(
      own((f, x) => {
        f.dns!.dmarc = { a: found(raw, D), b: found(raw, D), ruaAuthorized: rua };
        x.dns!.dmarc = f.dns!.dmarc;
      }),
      "dmarc",
    );

  it("dmarc: on the sending domain; the missing fix covers the everyday email; the rua fix names no dmarc@ route", () => {
    expect(withDmarc("v=DMARC1; p=none")).toMatchObject({ status: "ok", text: "Policy found: monitor only. Right for now." });
    const r = withDmarc(null);
    expect(r).toMatchObject({
      status: "bad",
      text: "No DMARC policy found for example.com.",
      fix: "Add a TXT record. Name: _dmarc. Value: v=DMARC1; p=none. It also covers your everyday email from example.com; p=none changes nothing for it.",
    });
    expect(r.records).toEqual([{ type: "TXT", name: "_dmarc", fqdn: "_dmarc.example.com", value: "v=DMARC1; p=none", priority: null, found: [] }]);
    expect(withDmarc("v=DMARC1; p=none; rua=mailto:reports@dmarc-service.io", { "dmarc-service.io": false })).toMatchObject({
      status: "warn",
      text: "Reports to dmarc-service.io will be dropped (that domain hasn't agreed to receive them).",
      fix: "Remove rua from the record, or use a mailbox at example.com that you read.",
    });
  });

  it("webhooks and remote access: info without a public address, today's rows with one", () => {
    expect(rowOf(ownFacts(), "webhooks")).toMatchObject({
      status: "info",
      text: "No public address yet, so Mailgun can't tell the app at once. The app reads Mailgun's logs every hour instead, while the background sender runs.",
      fix: "Optional: remote access (Cloudflare guide) lets Mailgun tell the app at once.",
    });
    expect(rowOf(ownFacts(), "remote-access")).toMatchObject({
      status: "info",
      text: "Remote access isn't set up: the app works on this PC and your office network only.",
      fix: "Optional in your setup. To reach the app from elsewhere, follow the Cloudflare guide.",
    });
    const pub = own((f) => {
      f.publicUrl = PUB;
      f.webhooks = {
        url: HOOK,
        map: { ok: true, value: { delivered: [HOOK], permanent_fail: [HOOK], temporary_fail: [HOOK], complained: [HOOK], unsubscribed: [HOOK] } },
      };
    });
    expect(rowOf(pub, "webhooks")).toMatchObject({ status: "ok", text: `Deliveries, bounces, temporary failures, complaints and unsubscribes go to ${HOOK}.` });
    expect(rowOf(pub, "remote-access")).toMatchObject({
      status: "ok",
      text: "Cloudflare reaches this PC, only your team gets past the login, and Mailgun's messages get through without a login page.",
    });
    const missingHooks = own((f) => {
      f.publicUrl = PUB;
      f.webhooks = { url: HOOK, map: { ok: true, value: {} } };
    });
    expect(rowOf(missingHooks, "webhooks").status).toBe("bad");
  });

  it("monthly-limit: info on a plan with a daily limit, today's row otherwise", () => {
    expect(rowOf(ownFacts(), "monthly-limit")).toMatchObject({
      status: "info",
      text: "Your Mailgun plan stops at 100 emails a day, so a monthly safety limit isn't needed.",
      fix: null,
    });
    expect(rowOf(own((f) => (f.plan = planLimits("foundation", "own-mailbox"))), "monthly-limit").status).toBe("warn");
    expect(rowOf(own((f) => (f.plan = null)), "monthly-limit").status).toBe("warn");
  });

  it("postmaster: a Google record on the everyday domain stays info; none is info with the reminder", () => {
    expect(rowOf(ownFacts(), "postmaster")).toMatchObject({
      status: "info",
      text: "A Google verification record is on example.com. Check at postmaster.google.com that example.com is listed there.",
    });
    expect(rowOf(own((_f, x) => (x.dns!.txt = both([godaddy(D)]))), "postmaster")).toMatchObject({
      status: "info",
      text: "Optional: see how Gmail rates example.com, the domain your everyday email uses.",
      fix: "Open postmaster.google.com, click Add new domain, type example.com, copy the TXT record it shows and add it (Name @). It shows data only once you send enough email.",
    });
  });
});

// ───────────────────────── reply-test ─────────────────────────

describe("own-mailbox mode: the reply-test row counts only its own mode and From (O13, O15)", () => {
  const rt = (change: (r: ChecklistFacts["replyTest"], x: FromDomainFacts) => void) => rowOf(own((f, x) => change(f.replyTest, x)), "reply-test");

  it("passed for this domain, own From and mode: ok with the by-hand sentence", () => {
    const when = ` on ${formatShortDate("2026-09-22T09:00:00Z", "Asia/Karachi", NOW)}`;
    expect(rowOf(ownFacts(), "reply-test")).toMatchObject({ status: "ok", text: OWN_REPLY_TEST_TEXTS.passedRow(when, FROM) });
    expect(rowOf(ownFacts(), "reply-test").text).toMatch(/^The reply test passed on .+ with the From address contact@example\.com: test emails arrived/);
    expect(rowOf(ownFacts(), "reply-test").text).not.toContain("Setup A");
  });

  it("an app-mode pass, another From's or another domain's: not tested yet", () => {
    const warn = { status: "warn", text: "Not tested yet with the From address contact@example.com. Live campaigns start once this passes." };
    expect(rt((r) => delete r.replies)).toMatchObject(warn);
    expect(rt((r) => (r.from = "hello@example.com"))).toMatchObject(warn);
    expect(rt((r) => (r.from = null))).toMatchObject(warn);
    expect(rt((r) => (r.domain = "mail.example.com"))).toMatchObject(warn);
  });

  it("failed for them: bad; an app-mode failure: not tested yet", () => {
    expect(rt((r) => (r.status = "failed"))).toMatchObject({
      status: "bad",
      text: "The reply test didn't pass with the From address contact@example.com.",
      fix: "The reply test section says which check failed.",
    });
    expect(rt((r) => ((r.status = "failed"), delete r.replies)).status).toBe("warn");
  });

  it("no fitting own From: warn, type the From address first", () => {
    expect(rt((_r, x) => (x.address = ""))).toMatchObject({ status: "warn", text: "Type your From address in Settings › Sending & Mailgun first.", fix: null });
    expect(rt((_r, x) => (x.address = "contact@mail.example.com")).text).toBe(OWN_REPLY_TEST_TEXTS.noFromRow);
    expect(rowOf(own((f) => delete f.from), "reply-test").text).toBe(OWN_REPLY_TEST_TEXTS.noFromRow);
  });

  it("app mode never counts an own-mailbox pass (the reverse of O13)", () => {
    const app = own((f) => {
      delete f.ownMailbox;
      delete f.from;
      f.domain = "send.example.com";
      f.replyTest = { status: "passed", setup: "A", domain: "send.example.com", decidedAt: "2026-09-22T09:00:00Z", from: null, replies: "own-mailbox" };
    });
    expect(rowOf(app, "reply-test")).toMatchObject({ status: "warn", text: "Not tested yet. Live campaigns start once this passes." });
    expect(rowOf({ ...app, replyTest: { ...app.replyTest, status: "failed" } }, "reply-test").status).toBe("warn");
    const plain = { ...app, replyTest: { ...app.replyTest } };
    delete plain.replyTest.replies;
    expect(rowOf(plain, "reply-test").status).toBe("ok");
  });
});

// ───────────────────────── O37: a website domain in app mode ─────────────────────────

/** App-mode facts (per-person) for a website domain: Mailgun lists its receiving MX records, as for any domain. */
function websiteAppFacts(d = "polygonparadise.com"): ChecklistFacts {
  const f = ownFacts(d);
  delete f.ownMailbox;
  delete f.from;
  delete f.plan;
  delete f.lastGoodMx;
  delete f.replyTest.replies;
  f.replyTest.from = null;
  return f;
}

describe("O37: a website domain checked in app mode never gets receiving DNS advice", () => {
  it("the mx row asks to connect again in own-mailbox mode, with no record box", () => {
    const r = rowOf(websiteAppFacts(), "mx");
    expect(r).toMatchObject({
      status: "bad",
      title: "Replies reach the app (MX)",
      text: "polygonparadise.com is your own domain, and its mail must stay with your mail provider.",
      fix: "Open Settings › Sending & Mailgun and connect again with How the app sends = From polygonparadise.com itself.",
      records: [],
    });
    // Today's list otherwise (the guard changes rows, never the list).
    expect(rows(websiteAppFacts()).map((x) => x.key)).toContain("reply-routes");
    // www. is a website domain too; Mailgun unavailable still gives the guard row.
    expect(rowOf(websiteAppFacts("www.polygonparadise.com"), "mx").text).toBe(OWN_MAILBOX_TEXTS.websiteInAppMode("www.polygonparadise.com"));
    const down = websiteAppFacts();
    down.mailgun = { ok: false, kind: "unreachable", message: "timeout" };
    expect(rowOf(down, "mx")).toMatchObject({ status: "bad", records: [] });
  });

  it("the spf row uses the include-aware logic (no box, no value), reading the walk's names", () => {
    expect(rowOf(websiteAppFacts(), "spf")).toMatchObject({ status: "ok", records: [] });
    const noRecord = websiteAppFacts();
    noRecord.dns!.txt = none();
    noRecord.dns!.spfLookups = null;
    const r = rowOf(noRecord, "spf");
    expect(r).toMatchObject({ status: "bad", records: [] });
    expect(r.fix).not.toContain("v=spf1");
  });

  it("review DOMAIN-4: keeps the dangling-include case, and never proposes an include for the website domain", () => {
    const P = "polygonparadise.com";
    // A GoDaddy helper lost in a DNS move (both resolvers): the own-mailbox dangling fix, not "add include:mailgun.org".
    const lost = websiteAppFacts();
    lost.dns!.spfLookups = { count: 5, complete: true, names: [`dc-1._spfm.${P}`, "zoho.com", `dc-2._spfm.${P}`], dangling: [`dc-2._spfm.${P}`] };
    expect(rowOf(lost, "spf")).toMatchObject({
      status: "bad",
      text: `${P}'s SPF record includes dc-2._spfm.${P}, which has no SPF record, so mail servers treat ${P}'s SPF as broken: your campaign emails and your everyday email fail SPF.`,
      fix: `If ${P}'s DNS moved recently, add the TXT record of dc-2._spfm.${P} again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app.`,
    });
    // Mailgun really missing (both walks agree): the row says so, and the fix is to connect again in own-mailbox mode.
    const noMailgun = websiteAppFacts();
    noMailgun.dns!.spfLookups = { count: 4, complete: true, names: [`dc-1._spfm.${P}`, "zoho.com"], dangling: [] };
    expect(rowOf(noMailgun, "spf")).toMatchObject({
      status: "bad",
      text: `${P}'s SPF record doesn't include Mailgun, so the app's emails fail SPF.`,
      fix: OWN_MAILBOX_TEXTS.websiteInAppModeFix,
    });
    const noRecord = websiteAppFacts();
    noRecord.dns!.txt = none();
    noRecord.dns!.spfLookups = null;
    expect(rowOf(noRecord, "spf").fix).toBe(OWN_MAILBOX_TEXTS.websiteInAppModeFix);
    for (const f of websiteVariants(P)) {
      const fix = rowOf(f, "spf").fix ?? "";
      expect(fix, fix).not.toMatch(/add include:/i);
    }
  });
});

// ───────────────────────── the safety sweep (§2.5 item 4) ─────────────────────────

/** Every kind of DNS answer and case of §3.3, with and without a last good MX, for one domain. */
function ownVariants(d: string): ChecklistFacts[] {
  const out: ChecklistFacts[] = [];
  const add = (change: (f: ChecklistFacts, x: NonNullable<FromDomainFacts["dns"]>) => void) => {
    for (const last of [null, ZOHO_GOOD]) {
      const f = ownFacts(d);
      f.lastGoodMx = last;
      change(f, f.from!.dns!);
      out.push(f);
    }
  };
  const mxCases: Array<TwoAnswers<Array<{ priority: number; exchange: string }>>> = [
    both(ZOHO),
    { a: ok([...ZOHO, { priority: 5, exchange: "mxa.mailgun.org" }]), b: ok(ZOHO) },
    both([{ priority: 10, exchange: "mxa.mailgun.org" }, { priority: 10, exchange: "mxb.mailgun.org" }]),
    both([{ priority: 10, exchange: "mxa.eu.mailgun.org" }, { priority: 10, exchange: "mxb.eu.mailgun.org" }]),
    both([{ priority: 0, exchange: "" }]),
    none(),
    both([{ priority: 10, exchange: "route1.mx.cloudflare.net" }]),
    { a: ok(ZOHO), b: missing },
    { a: timeout, b: missing },
  ];
  for (const m of mxCases) add((f, x) => ((x.mx = m), (f.dns!.mx = m)));
  const spfCases: Array<(x: NonNullable<FromDomainFacts["dns"]>) => void> = [
    (x) => (x.txt = { a: ok([godaddy(d), MG_SPF]), b: ok([godaddy(d)]) }),
    (x) => ((x.txt = none()), (x.spfLookups = null)),
    (x) => (x.txt = { a: ok([godaddy(d)]), b: missing }),
    (x) => (x.txt = { a: timeout, b: missing }),
    (x) => (x.spfLookups = { count: 4, complete: true, dangling: [`dc-2._spfm.${d}`], names: names(d) }),
    (x) => (x.txt = both([`v=spf1 include:dc-1._spfm.${d} +all`])),
    (x) => (x.spfLookups = { count: 6, complete: false, dangling: [], names: [] }),
    (x) => (x.spfLookups = { count: 12, complete: true, dangling: [], names: [] }),
    (x) => (x.spfLookups = { count: 4, complete: true, dangling: [], names: [`dc-1._spfm.${d}`] }),
    (x) => (x.spfLookups = { count: 5, complete: true, dangling: [], names: names(d) }),
  ];
  for (const s of spfCases) add((f, x) => (s(x), (f.dns!.txt = x.txt)));
  add((f) => ((f.mailgun as { value: { state: string } }).value.state = "unverified"));
  add((f) => (f.mailgun = { ok: false, kind: "not-found", message: "404" }));
  add((f) => (f.dns = null));
  add((f) => ((f.dns!.dmarc = { a: found(null, d), b: found(null, d), ruaAuthorized: {} }), (f.from!.dns!.dmarc = f.dns!.dmarc)));
  add((f) => (f.setupCertificate = null));
  add((f) => ((f.publicUrl = PUB), (f.webhooks = { url: HOOK, map: { ok: true, value: {} } })));
  add((f) => (f.from!.address = ""));
  add((f) => ((f.replyTest.status = "failed"), (f.plan = null)));
  add((f) => (f.dns!.dkim[0]!.answers = none()));
  add((f) => (f.dns!.tracking.cname = none()));
  return out;
}

/** App-mode variants of a website domain (O37): everything that would have asked for Mailgun's MX or a full SPF value. */
function websiteVariants(d: string): ChecklistFacts[] {
  const out: ChecklistFacts[] = [websiteAppFacts(d)];
  const add = (change: (f: ChecklistFacts) => void) => {
    const f = websiteAppFacts(d);
    change(f);
    out.push(f);
  };
  add((f) => (f.dns!.mx = none()));
  add((f) => (f.dns!.mx = both([{ priority: 10, exchange: "mxa.mailgun.org" }])));
  add((f) => (f.dns!.mx = both([{ priority: 10, exchange: "mxa.eu.mailgun.org" }])));
  add((f) => ((f.dns!.txt = none()), (f.dns!.spfLookups = null)));
  add((f) => (f.dns!.txt = both(["v=spf1 include:zoho.com ~all"])));
  add((f) => (f.dns!.txt = both([godaddy(d), "v=spf1 include:mailgun.org ~all"])));
  add((f) => (f.dns!.spfLookups = { count: 14, complete: true }));
  // Review DOMAIN-4: a lost helper, and Mailgun missing from the tree.
  add((f) => (f.dns!.spfLookups = { count: 5, complete: true, names: [`dc-2._spfm.${d}`], dangling: [`dc-2._spfm.${d}`] }));
  add((f) => (f.dns!.spfLookups = { count: 4, complete: true, names: [`dc-1._spfm.${d}`], dangling: [] }));
  add((f) => (f.mailgun = { ok: false, kind: "unreachable", message: "x" }));
  add((f) => {
    // A shared From saved on the website domain (it can't fit: the From card refuses it, the rows say so).
    f.from = { address: `contact@${d}`, domain: d, problem: "The From address doesn't fit.", signingDomain: d, originalSigner: null, originalPasted: false, dns: null };
  });
  return out;
}

function expectSafe(f: ChecklistFacts, label: string) {
  const d = f.domain.toLowerCase();
  const never = NEVER_MAILGUN_MX_TEXT(d);
  for (const r of rows(f)) {
    const where = `${label} / ${r.key}: ${r.fix ?? ""}`;
    for (const rec of r.records) {
      expect(rec.type.toUpperCase(), where).not.toBe("MX");
      if (rec.type.toUpperCase() === "TXT" && rec.fqdn.toLowerCase().replace(/\.$/, "") === d) {
        expect(rec.value.trim().toLowerCase().startsWith("v=spf1"), where).toBe(false);
      }
    }
    const fix = r.fix ?? "";
    expect(fix, where).not.toContain("v=spf1");
    const rest = fix.split(never).join("");
    for (const h of MAILGUN_MX_HOSTS) expect(rest, where).not.toContain(h);
  }
}

describe("safety (§2.5 item 4): never a Mailgun MX, never an MX box, never an SPF value", () => {
  it("own-mailbox mode, every case, for example.com and polygonparadise.com", () => {
    let n = 0;
    for (const d of [D, "polygonparadise.com"]) {
      for (const f of ownVariants(d)) {
        expectSafe(f, `own ${d} #${n++}`);
        const r = rows(f);
        // Every red from-mx fix, and the not-active mailgun-domain fix, end with the "never" sentence.
        const mx = r.find((x) => x.key === "from-mx")!;
        if (mx.status === "bad") expect(mx.fix, mx.text).toContain(NEVER_MAILGUN_MX_TEXT(d));
        const mg = r.find((x) => x.key === "mailgun-domain")!;
        if (mg.text.includes("hasn't confirmed your records")) expect(mg.fix).toBe(OWN_MAILBOX_TEXTS.mailgunDomainFix(d));
        // No row outside DKIM, the tracking CNAME and _dmarc has a record box.
        for (const row of r) if (row.records.length > 0) expect(["dkim", "tracking-cname", "dmarc"], row.key).toContain(row.key);
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it("the red cases really are red (the sweep isn't passing on green rows)", () => {
    const reds = ownVariants(D).map((f) => rows(f).find((x) => x.key === "from-mx")!).filter((x) => x.status === "bad");
    expect(reds.length).toBeGreaterThanOrEqual(10);
    const spfReds = ownVariants(D).map((f) => rows(f).find((x) => x.key === "spf")!).filter((x) => x.status === "bad");
    expect(spfReds.length).toBeGreaterThanOrEqual(10);
  });

  it("app mode with the sending domain polygonparadise.com (O37), and www.polygonparadise.com", () => {
    for (const d of ["polygonparadise.com", "www.polygonparadise.com"]) {
      websiteVariants(d).forEach((f, i) => {
        expectSafe(f, `app ${d} #${i}`);
        const mx = rows(f).find((x) => x.key === "mx")!;
        expect(mx).toMatchObject({ status: "bad", text: OWN_MAILBOX_TEXTS.websiteInAppMode(d), records: [] });
      });
    }
  });

  it("the sweep would catch today's app-mode advice on another domain (it asks for Mailgun's MX and an SPF value)", () => {
    const f = websiteAppFacts("send.example.com");
    f.dns!.txt = none();
    f.dns!.mx = none();
    const r = rows(f);
    expect(r.find((x) => x.key === "mx")!.records.some((x) => x.type === "MX")).toBe(true);
    expect(r.find((x) => x.key === "spf")!.fix).toContain("v=spf1");
  });
});
