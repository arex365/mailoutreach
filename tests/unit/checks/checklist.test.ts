import { describe, expect, it } from "vitest";
import {
  buildChecklistRows,
  checklistTitle,
  COULD_NOT_CHECK,
  relativeName,
  signingDomainOf,
  SPREADING,
  withoutStrictAlignment,
  zoneOf,
  type ChecklistFacts,
  type DmarcFind,
  type FromDomainFacts,
  type TwoAnswers,
} from "@/core/dns/checklist";
import { parseDmarc } from "@/core/dns/dmarc";
import type { DnsAnswer } from "@/core/dns/types";
import type { ChecklistRow, ChecklistRowKey, TunnelState } from "@/core/system-state";

const D = "send.example.com";
const NOW = new Date("2026-09-23T10:00:00Z");
const DKIM = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekey";
const SPF = "v=spf1 include:eu.mailgun.org ~all";
const PUB = "https://outreach.example.com";
const HOOK = `${PUB}/api/webhooks/mailgun/events`;

const ok = <T>(value: T): DnsAnswer<T> => ({ ok: true, value });
const missing: DnsAnswer<never> = { ok: false, code: "missing", detail: "ENOTFOUND" };
const timeout: DnsAnswer<never> = { ok: false, code: "timeout", detail: "ETIMEOUT" };
const both = <T>(value: T): TwoAnswers<T> => ({ a: ok(value), b: ok(value) });
const none = <T>(): TwoAnswers<T> => ({ a: missing, b: missing });

function found(policy: string | null, at: string | null = D, inherited = false): DmarcFind {
  if (!policy) return { at: null, policy: null, duplicates: false, inherited: false, error: null };
  const p = /p=(\w+)/.exec(policy)?.[1] ?? null;
  const sp = /sp=(\w+)/.exec(policy)?.[1] ?? null;
  const rua = /rua=([^;]+)/.exec(policy)?.[1]?.split(",") ?? [];
  return { at, policy: { p, sp, rua, adkim: null, aspf: null, raw: policy }, duplicates: false, inherited, error: null };
}

function tunnel(over: Partial<TunnelState> = {}): TunnelState {
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
    ...over,
  };
}

function goodFacts(): ChecklistFacts {
  return {
    domain: D,
    region: "EU",
    now: NOW,
    timeZone: "Asia/Karachi",
    mailgun: {
      ok: true,
      value: {
        state: "active",
        isDisabled: false,
        disabledReason: null,
        spamAction: "tag",
        webPrefix: "email",
        webScheme: "https",
        messageTtl: 86_400,
        webhooksRedactPii: false,
        sending: [
          { recordType: "TXT", name: D, value: SPF, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "TXT", name: `pdk1._domainkey.${D}`, value: DKIM, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "CNAME", name: `email.${D}`, value: "eu.mailgun.org", priority: null, valid: "valid", isActive: true, cached: [] },
        ],
        receiving: [
          { recordType: "MX", name: null, value: "mxa.eu.mailgun.org", priority: "10", valid: "valid", isActive: true, cached: [] },
          { recordType: "MX", name: null, value: "mxb.eu.mailgun.org", priority: "10", valid: "valid", isActive: true, cached: [] },
        ],
      },
    },
    verifyError: null,
    dns: {
      txt: both([SPF, "google-site-verification=abc"]),
      spfLookups: { count: 3, complete: true },
      dkim: [{ name: `pdk1._domainkey.${D}`, recordType: "TXT", expected: DKIM, answers: both([DKIM]), proxied: null, doubled: null }],
      mx: both([
        { priority: 10, exchange: "mxa.eu.mailgun.org" },
        { priority: 10, exchange: "mxb.eu.mailgun.org." },
      ]),
      tracking: { host: `email.${D}`, expected: "eu.mailgun.org", cname: both(["eu.mailgun.org."]), a: null, doubled: null },
      dmarc: { a: found("v=DMARC1; p=none"), b: found("v=DMARC1; p=none"), ruaAuthorized: {} },
    },
    certificate: { ok: true, value: { status: "active", error: null } },
    setupCertificate: "active",
    tracking: { ok: true, value: { openActive: false, clickActive: false, unsubscribeActive: true, htmlFooter: "", textFooter: "" } },
    unsubscribeSetup: "A",
    messageRetentionDays: 1,
    webhooks: {
      url: HOOK,
      map: { ok: true, value: { delivered: [HOOK], permanent_fail: [HOOK], temporary_fail: [HOOK], complained: [HOOK], unsubscribed: [HOOK] } },
    },
    signingKey: { saved: true, matches: true, problem: null },
    routes: {
      senders: [
        { name: "Arslan", address: `arslan@${D}`, status: "ok", error: null, forwardTo: "arslan@gmail.com", lists: [] },
        { name: "Ali", address: `ali@${D}`, status: "ok", error: null, forwardTo: "ali.khan@gmail.com", lists: [] },
      ],
      catchAllRouteId: "route-catchall",
      listsError: null,
    },
    queues: { ok: true, value: { regularDisabled: false, reason: null } },
    pause: [],
    monthlyLimit: { ok: true, value: { limit: 30_000, current: 1_234, period: "1m" } },
    tunnel: tunnel(),
    publicUrl: PUB,
    fakeMode: false,
    replyTest: { status: "passed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z" },
    domainRegisteredOn: "2026-07-01",
  };
}

function rows(f: ChecklistFacts, keyBits: number | null = 2048): ChecklistRow[] {
  return buildChecklistRows(f, { keyBits });
}

function rowOf(f: ChecklistFacts, key: ChecklistRowKey, keyBits: number | null = 2048): ChecklistRow {
  const r = rows(f, keyBits).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

function with_(change: (f: ChecklistFacts) => void): ChecklistFacts {
  const f = goodFacts();
  change(f);
  return f;
}

describe("names in the DNS panel", () => {
  it("are relative to the registrable domain", () => {
    expect(zoneOf("send.example.com")).toBe("example.com");
    expect(zoneOf("mail.polygonparadise.com")).toBe("polygonparadise.com");
    expect(relativeName("example.com", "example.com")).toBe("@");
    expect(relativeName("email.send.example.com.", "example.com")).toBe("email.send");
    expect(relativeName("_dmarc.brand.co.uk", "brand.co.uk")).toBe("_dmarc");
  });
});

describe("buildChecklistRows: everything right", () => {
  it("gives every row ok, in the §5.3 order and groups, with the design's texts", () => {
    const r = rows(goodFacts());
    expect(r.map((x) => [x.key, x.status])).toEqual(
      [
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
        "monthly-limit",
        "remote-access",
        "reply-test",
        "postmaster",
        "domain-age",
      ].map((k) => [k, "ok"]),
    );
    const text = Object.fromEntries(r.map((x) => [x.key, x.text]));
    expect(text).toMatchObject({
      "mailgun-domain": "Mailgun has your domain (EU) and has confirmed your records.",
      spf: `Mailgun is allowed to send email for ${D}.`,
      dkim: `Your emails carry ${D}'s digital signature (2048-bit).`,
      mx: `Replies to ${D} go to Mailgun, which passes them to the app and your inbox.`,
      "tracking-cname": `Unsubscribe links on email.${D} work.`,
      "https-links": "Unsubscribe links use https, as Gmail and Yahoo require.",
      dmarc: "Policy found: monitor only. Right for now.",
      "tracking-off": "Mailgun doesn't add tracking pixels or change your links.",
      unsubscribe: "Mailgun fills in each email's unsubscribe link and adds the one-click unsubscribe header.",
      "spam-filter": "Suspicious replies are marked, never thrown away.",
      retention: "Mailgun keeps each reply for 1 day, so the app can fetch it after the PC was off.",
      "signing-key": "The app can check that messages really come from Mailgun.",
      webhooks: `Deliveries, bounces, temporary failures, complaints and unsubscribes go to ${HOOK}.`,
      "reply-routes": "2 reply routes (Arslan, Ali), plus a catch-all for unknown addresses.",
      "sending-allowed": `Mailgun accepts emails from ${D}.`,
      "monthly-limit": "Mailgun stops everything after 30,000 emails this month (1,234 used).",
      "remote-access":
        "Cloudflare reaches this PC, only your team gets past the login, and Mailgun's messages get through without a login page.",
      "reply-test": "Setup A passed on 22 Sept: replies arrive in your inbox, and unsubscribe links work.",
      postmaster: "Google Postmaster Tools looks set up.",
      "domain-age": `${D} is 84 days old.`,
    });
    expect(r.find((x) => x.key === "spf")!.title).toBe(`Mailgun may send for ${D} (SPF)`);
    expect(new Set(r.map((x) => x.group))).toEqual(new Set(["mailgun", "dns", "settings", "connection", "optional"]));
  });

  it("gives the record boxes with names as typed in the DNS panel", () => {
    const r = rows(goodFacts());
    expect(r.find((x) => x.key === "spf")!.records[0]).toMatchObject({ type: "TXT", name: "send", fqdn: D, value: SPF });
    expect(r.find((x) => x.key === "dkim")!.records[0]).toMatchObject({ type: "TXT", name: "pdk1._domainkey.send", value: DKIM });
    expect(r.find((x) => x.key === "mx")!.records.map((x) => [x.value, x.priority])).toEqual([
      ["mxa.eu.mailgun.org", "10"],
      ["mxb.eu.mailgun.org", "10"],
    ]);
    expect(r.find((x) => x.key === "tracking-cname")!.records[0]).toMatchObject({ type: "CNAME", name: "email.send", value: "eu.mailgun.org" });
    expect(r.find((x) => x.key === "dmarc")!.records[0]).toMatchObject({ type: "TXT", name: "_dmarc.send", value: "v=DMARC1; p=none" });
  });
});

describe("DNS agreement between the two resolvers", () => {
  it("one resolver sees it: still spreading (warn); a timeout without a good answer: couldn't check (grey, never red)", () => {
    const spreading = with_((f) => {
      f.dns!.dkim[0]!.answers = { a: ok([DKIM]), b: missing };
    });
    expect(rowOf(spreading, "dkim")).toMatchObject({ status: "warn", text: SPREADING });
    const slow = with_((f) => {
      f.dns!.txt = { a: timeout, b: missing };
    });
    expect(rowOf(slow, "spf")).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK });
    const oneGoodOneSlow = with_((f) => {
      f.dns!.mx = { a: timeout, b: ok([{ priority: 10, exchange: "mxa.eu.mailgun.org" }, { priority: 10, exchange: "mxb.eu.mailgun.org" }]) };
    });
    expect(rowOf(oneGoodOneSlow, "mx").status).toBe("warn");
  });
});

describe("SPF", () => {
  it("missing (NXDOMAIN)", () => {
    const r = rowOf(with_((f) => (f.dns!.txt = none())), "spf");
    expect(r).toMatchObject({ status: "bad", text: `No SPF record found for ${D}.`, fix: `Add a TXT record. Name: send. Value: ${SPF}` });
  });
  it("two records", () => {
    const r = rowOf(with_((f) => (f.dns!.txt = both([SPF, "v=spf1 include:other.test ~all"]))), "spf");
    expect(r).toMatchObject({
      status: "bad",
      text: "You have 2 SPF records; mail servers ignore all of them.",
      fix: "Merge them into one: v=spf1 include:eu.mailgun.org include:other.test ~all",
    });
  });
  it("without Mailgun, with +all, too many lookups", () => {
    expect(rowOf(with_((f) => (f.dns!.txt = both(["v=spf1 include:zoho.com ~all"]))), "spf")).toMatchObject({
      status: "bad",
      text: "Your SPF record doesn't include Mailgun.",
      fix: "Change it to: v=spf1 include:eu.mailgun.org include:zoho.com ~all",
    });
    expect(rowOf(with_((f) => (f.dns!.txt = both(["v=spf1 include:eu.mailgun.org +all"]))), "spf")).toMatchObject({
      status: "bad",
      fix: "Change +all at the end to ~all.",
    });
    expect(rowOf(with_((f) => (f.dns!.spfLookups = { count: 12, complete: true })), "spf")).toMatchObject({
      status: "warn",
      text: "Too many services in your SPF record; some mail servers will reject it.",
    });
  });
});

describe("DKIM", () => {
  it("missing, doubled name, a different key, and a 1024-bit key", () => {
    expect(rowOf(with_((f) => (f.dns!.dkim[0]!.answers = none())), "dkim")).toMatchObject({
      status: "bad",
      text: `The DKIM record for ${D} is missing.`,
      fix: "Add a TXT record. Name: pdk1._domainkey.send. Value: the long text below (paste it in one piece; your DNS host splits it).",
    });
    expect(
      rowOf(
        with_((f) => {
          f.dns!.dkim[0]!.answers = none();
          f.dns!.dkim[0]!.doubled = both([DKIM]);
        }),
        "dkim",
      ),
    ).toMatchObject({ status: "bad", text: `The DKIM record was saved as pdk1._domainkey.${D}.example.com.`, fix: "Edit it and type only pdk1._domainkey.send in the Name box." });
    expect(rowOf(with_((f) => (f.dns!.dkim[0]!.answers = both(["k=rsa; p=OTHERKEY"]))), "dkim")).toMatchObject({
      status: "bad",
      text: "The DKIM record doesn't match Mailgun's.",
      fix: "Replace it with the value below.",
    });
    // SHARED-FROM-DESIGN F10: a 1024-bit key is "ok" with a note (it would otherwise block going live for ever).
    expect(rowOf(goodFacts(), "dkim", 1024)).toMatchObject({
      status: "ok",
      text: `Your emails carry ${D}'s digital signature (1024-bit; it works, 2048-bit is stronger).`,
      fix: null,
    });
  });

  it("Automatic Sender Security CNAMEs: ok, proxied", () => {
    const cname = (answers: TwoAnswers<string[]>, proxied: TwoAnswers<string[]> | null = null) =>
      with_((f) => {
        f.dns!.dkim = [
          { name: `pdk1._domainkey.${D}`, recordType: "CNAME", expected: "pdk1._domainkey.abc.dkim1.mailgun.com", answers, proxied, doubled: null },
        ];
      });
    expect(rowOf(cname(both(["pdk1._domainkey.abc.dkim1.mailgun.com."])), "dkim", null)).toMatchObject({
      status: "ok",
      text: `Your emails carry ${D}'s digital signature.`,
    });
    expect(rowOf(cname(none(), both(["104.21.1.1"])), "dkim", null)).toMatchObject({
      status: "bad",
      text: `pdk1._domainkey.${D} is proxied (orange cloud).`,
      fix: "In Cloudflare, switch it to DNS only.",
    });
  });
});

describe("MX and the tracking CNAME", () => {
  it("MX missing, extra servers, the other region's servers", () => {
    expect(rowOf(with_((f) => (f.dns!.mx = none())), "mx")).toMatchObject({
      status: "bad",
      text: `No MX records found for ${D}.`,
      fix: "Add 2 MX records. Name send: mail server mxa.eu.mailgun.org, priority 10; and mail server mxb.eu.mailgun.org, priority 10.",
    });
    const extra = both([
      { priority: 10, exchange: "mxa.eu.mailgun.org" },
      { priority: 10, exchange: "mxb.eu.mailgun.org" },
      { priority: 20, exchange: "route1.mx.cloudflare.net" },
    ]);
    expect(rowOf(with_((f) => (f.dns!.mx = extra)), "mx")).toMatchObject({
      status: "warn",
      text: "Other mail servers are also listed (route1.mx.cloudflare.net). Some replies may go there instead.",
    });
    const us = both([
      { priority: 10, exchange: "mxa.mailgun.org" },
      { priority: 10, exchange: "mxb.mailgun.org" },
    ]);
    expect(rowOf(with_((f) => (f.dns!.mx = us)), "mx")).toMatchObject({
      status: "bad",
      fix: "Change them to mxa.eu.mailgun.org and mxb.eu.mailgun.org.",
    });
  });

  it("tracking CNAME proxied, doubled, missing, pointing elsewhere", () => {
    const t = (change: (tr: NonNullable<ChecklistFacts["dns"]>["tracking"]) => void) => rowOf(with_((f) => change(f.dns!.tracking)), "tracking-cname");
    expect(t((tr) => ((tr.cname = none()), (tr.a = both(["104.21.1.1"]))))).toMatchObject({
      status: "bad",
      text: `email.${D} is proxied (orange cloud).`,
      fix: "In Cloudflare, switch it to DNS only.",
    });
    expect(t((tr) => ((tr.cname = none()), (tr.a = none()), (tr.doubled = both(["eu.mailgun.org"]))))).toMatchObject({
      status: "bad",
      text: `The record was saved as email.${D}.example.com.`,
      fix: "Edit it and type only email.send in the Name box.",
    });
    expect(t((tr) => ((tr.cname = none()), (tr.a = none()), (tr.doubled = none())))).toMatchObject({
      status: "bad",
      text: `email.${D} is missing.`,
      fix: "Add a CNAME record. Name: email.send. Target: eu.mailgun.org.",
    });
    expect(t((tr) => (tr.cname = both(["mailgun.org"])))).toMatchObject({ status: "bad", fix: "Change its target to eu.mailgun.org." });
  });
});

describe("HTTPS links and DMARC", () => {
  it("certificate states", () => {
    const cert = (status: "none" | "processing" | "active" | "expired" | "error", scheme: "http" | "https" = "https") =>
      rowOf(
        with_((f) => {
          f.certificate = { ok: true, value: { status, error: null } };
          if (f.mailgun.ok) f.mailgun.value.webScheme = scheme;
        }),
        "https-links",
      );
    expect(cert("processing")).toMatchObject({ status: "warn", text: "Mailgun is preparing the certificate." });
    expect(cert("none")).toMatchObject({ status: "bad", fix: "Click Apply recommended settings: it asks Mailgun for a certificate." });
    expect(cert("active", "http")).toMatchObject({ status: "bad" });
    expect(cert("expired")).toMatchObject({ status: "bad", text: "The certificate for secure unsubscribe links has expired." });
    expect(rowOf(with_((f) => (f.setupCertificate = "not-in-plan")), "https-links")).toMatchObject({
      status: "bad",
      text: "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.",
    });
  });

  it("DMARC missing, doubled, inherited, stricter, and reports to an unauthorised domain", () => {
    const dm = (a: DmarcFind, b: DmarcFind = a, ruaAuthorized: Record<string, boolean | null> = {}) =>
      rowOf(with_((f) => (f.dns!.dmarc = { a, b, ruaAuthorized })), "dmarc");
    expect(dm(found(null))).toMatchObject({ status: "bad", text: `No DMARC policy found for ${D}.`, fix: "Add a TXT record. Name: _dmarc.send. Value: v=DMARC1; p=none" });
    expect(dm({ at: D, policy: null, duplicates: true, inherited: false, error: null })).toMatchObject({
      status: "bad",
      text: "Two DMARC records cancel each other.",
    });
    expect(dm(found("v=DMARC1; p=quarantine; sp=reject", "example.com", true))).toMatchObject({
      status: "ok",
      text: `No record on ${D}; using example.com's policy: reject.`,
    });
    expect(dm(found("v=DMARC1; p=reject"))).toMatchObject({ status: "ok", text: "Policy found: reject." });
    expect(dm(found("v=DMARC1; p=none; rua=mailto:reports@dmarc-service.io"), undefined, { "dmarc-service.io": false })).toMatchObject({
      status: "warn",
      text: "Reports to dmarc-service.io will be dropped (that domain hasn't agreed to receive them).",
      fix: `Use dmarc@${D} or remove rua.`,
    });
    expect(dm(found("v=DMARC1; p=none"), found(null))).toMatchObject({ status: "warn", text: SPREADING });
  });
});

describe("Mailgun settings rows", () => {
  it("tracking, unsubscribe handling (Setup A and B), spam filter, retention", () => {
    expect(rowOf(with_((f) => f.tracking.ok && (f.tracking.value.openActive = true)), "tracking-off")).toMatchObject({
      status: "bad",
      text: "Open tracking is on in Mailgun, so it changes your emails.",
    });
    expect(rowOf(with_((f) => f.tracking.ok && (f.tracking.value.htmlFooter = "<p>unsubscribe</p>")), "unsubscribe")).toMatchObject({
      status: "bad",
      fix: "Mailgun kept its own unsubscribe footer. In Mailgun: Domain settings › Tracking › Unsubscribes, clear both footers, then apply again.",
    });
    expect(rowOf(with_((f) => f.tracking.ok && (f.tracking.value.unsubscribeActive = false)), "unsubscribe").status).toBe("bad");
    expect(
      rowOf(
        with_((f) => {
          f.unsubscribeSetup = "B";
          if (f.tracking.ok) f.tracking.value.unsubscribeActive = false;
        }),
        "unsubscribe",
      ),
    ).toMatchObject({ status: "info", text: "Unsubscribe handling is off on purpose while you check Setup B." });
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.spamAction = "block")), "spam-filter").status).toBe("bad");
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.spamAction = "disabled")), "spam-filter").status).toBe("warn");
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.messageTtl = 0)), "retention").status).toBe("bad");
    expect(rowOf(with_((f) => (f.messageRetentionDays = 3)), "retention")).toMatchObject({ status: "warn" });
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.messageTtl = 3 * 86_400)), "retention").text).toBe(
      "Mailgun keeps each reply for 3 days, so the app can fetch it after the PC was off.",
    );
    expect(rowOf(with_((f) => (f.tracking = { ok: false, kind: "unreachable", message: "timeout" })), "tracking-off")).toMatchObject({
      status: "unknown",
      text: COULD_NOT_CHECK,
      detail: "timeout",
    });
  });

  it("signing key and webhooks", () => {
    expect(rowOf(with_((f) => (f.signingKey = { saved: false, matches: null, problem: null })), "signing-key")).toMatchObject({
      status: "bad",
      text: "The webhook signing key isn't saved yet.",
    });
    expect(rowOf(with_((f) => (f.signingKey = { saved: true, matches: false, problem: null })), "signing-key")).toMatchObject({
      status: "bad",
      fix: "Click Apply recommended settings to fetch it again.",
    });
    expect(
      rowOf(with_((f) => (f.signingKey = { saved: false, matches: null, problem: { kind: "missing-at-mailgun", message: "400" } })), "signing-key"),
    ).toMatchObject({ status: "bad", text: "Mailgun hasn't made a webhook signing key for your account yet." });
    expect(
      rowOf(with_((f) => (f.signingKey = { saved: true, matches: null, problem: { kind: "unreachable", message: "timeout" } })), "signing-key").status,
    ).toBe("unknown");
    expect(rowOf(with_((f) => (f.webhooks.url = null)), "webhooks")).toMatchObject({
      status: "bad",
      text: "The public address isn't set yet, so Mailgun can't reach the app.",
    });
    expect(
      rowOf(
        with_((f) => {
          if (f.webhooks.map.ok) delete f.webhooks.map.value.complained;
        }),
        "webhooks",
      ),
    ).toMatchObject({ status: "bad", text: "Mailgun doesn't tell the app about complaints yet." });
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.webhooksRedactPii = true)), "webhooks").status).toBe("bad");
  });

  it("reply routes: a suppressed inbox, a mismatch, being set up, no catch-all, nobody", () => {
    const routes = (change: (r: ChecklistFacts["routes"]) => void) => rowOf(with_((f) => change(f.routes)), "reply-routes");
    expect(routes((r) => (r.senders[1]!.lists = ["bounces"]))).toMatchObject({
      status: "bad",
      text: "Mailgun won't forward replies to ali.khan@gmail.com: it's on Mailgun's bounce list.",
      fix: "Remove it in Settings › Deliverability.",
    });
    expect(routes((r) => (r.senders[1]!.lists = ["local"]))).toMatchObject({
      text: "Mailgun won't forward replies to ali.khan@gmail.com: it's on the app's do-not-email list.",
    });
    const mismatch = "Another Mailgun route catches ali@send.example.com first.";
    expect(routes((r) => Object.assign(r.senders[1]!, { status: "mismatch", error: mismatch }))).toMatchObject({ status: "bad", text: mismatch });
    expect(routes((r) => (r.senders[1]!.status = "pending"))).toMatchObject({ status: "warn", text: "Reply routes are being set up for Ali." });
    expect(routes((r) => (r.catchAllRouteId = null))).toMatchObject({ status: "warn" });
    // Nobody has an address: the per-sender list under the row says so (and how to add one), so the row itself stays
    // quiet instead of repeating it.
    expect(routes((r) => (r.senders = []))).toMatchObject({ status: "bad", text: "", fix: null });
  });

  it("sending allowed and the monthly limit", () => {
    expect(rowOf(with_((f) => (f.queues = { ok: true, value: { regularDisabled: true, reason: "Too many messages" } })), "sending-allowed")).toMatchObject({
      status: "bad",
      text: `Mailgun has stopped accepting emails from ${D}: Too many messages.`,
    });
    expect(
      rowOf(with_((f) => (f.pause = [{ kind: "mailgun-not-allowed", reason: "Mailgun won't send", fixText: "Check the banner." }])), "sending-allowed"),
    ).toMatchObject({ status: "bad", text: "Sending is paused: Mailgun won't send.", fix: "Check the banner." });
    expect(rowOf(with_((f) => (f.pause = [{ kind: "manual", reason: "by the Owner", fixText: "" }])), "sending-allowed").status).toBe("ok");
    const noLimit =
      "No monthly safety limit set in Mailgun. In Mailgun, set a custom monthly message limit of about 30,000 (see the Mailgun guide, step 9).";
    expect(rowOf(with_((f) => (f.monthlyLimit = { ok: true, value: null })), "monthly-limit")).toMatchObject({ status: "warn", text: noLimit });
    // A key that may not read the limit: the app doesn't know, so a neutral "couldn't check" row, never "none set".
    const unreadable = rowOf(with_((f) => (f.monthlyLimit = { ok: false, kind: "auth", message: "403" })), "monthly-limit");
    expect(unreadable).toMatchObject({
      status: "unknown",
      text: "Couldn't check: the app's key isn't allowed to read Mailgun's monthly limit.",
      fix: "If you set the limit in Mailgun (Mailgun guide, step 9), you can ignore this.",
      detail: "The app's key can't read the limit: 403",
    });
    expect(unreadable.text).not.toContain("No monthly safety limit");
    expect(rowOf(with_((f) => (f.monthlyLimit = { ok: false, kind: "unreachable", message: "ETIMEDOUT" })), "monthly-limit")).toMatchObject({
      status: "unknown",
      text: "Couldn't check right now.",
    });
  });
});

describe("Mailgun's own view of the domain", () => {
  it("not found (wrong region), wrong key, unverified, disabled, unreachable; DNS rows then can't be checked", () => {
    const nf = with_((f) => {
      f.mailgun = { ok: false, kind: "not-found", message: "Domain not found" };
      f.dns = null;
    });
    expect(rowOf(nf, "mailgun-domain")).toMatchObject({
      status: "bad",
      text: `Mailgun can't find ${D} in the EU region. If you created the domain in the US region, change Region to US.`,
    });
    expect(rowOf(nf, "spf")).toMatchObject({ status: "unknown", fix: "Fix the 'Mailgun knows your domain' row first." });
    expect(rowOf(with_((f) => (f.mailgun = { ok: false, kind: "auth", message: "401" })), "mailgun-domain")).toMatchObject({
      status: "bad",
      text: "Mailgun didn't accept the saved API key.",
    });
    expect(rowOf(with_((f) => f.mailgun.ok && (f.mailgun.value.state = "unverified")), "mailgun-domain")).toMatchObject({
      status: "bad",
      text: "Mailgun has your domain (EU) but hasn't confirmed your records yet.",
    });
    expect(rowOf(with_((f) => f.mailgun.ok && Object.assign(f.mailgun.value, { isDisabled: true, disabledReason: "bad customer" })), "mailgun-domain").text).toBe(
      `Mailgun has disabled ${D}: bad customer.`,
    );
    expect(rowOf(with_((f) => (f.mailgun = { ok: false, kind: "unreachable", message: "ETIMEDOUT" })), "mailgun-domain").status).toBe("unknown");
  });
});

describe("remote access, reply test and the optional rows", () => {
  it("remote access variants", () => {
    const ra = (t: Partial<TunnelState>, change?: (f: ChecklistFacts) => void) =>
      rowOf(
        with_((f) => {
          f.tunnel = tunnel(t);
          change?.(f);
        }),
        "remote-access",
      );
    expect(ra({}, (f) => (f.publicUrl = null))).toMatchObject({ status: "bad", text: "The public address isn't set yet." });
    expect(ra({ publicCheck: null, webhookPathCheck: null })).toMatchObject({ status: "unknown", text: "Not checked yet." });
    expect(ra({ state: "not-running", publicCheck: { at: NOW.toISOString(), ok: false, status: null, error: "Couldn't connect." } })).toMatchObject({
      status: "bad",
      text: "cloudflared isn't running on this PC.",
    });
    expect(ra({ webhookPathCheck: { at: NOW.toISOString(), ok: false, status: 302, error: "Cloudflare's login page answered instead of the app." } })).toMatchObject({
      status: "bad",
      text: "The webhook address shows Cloudflare's login page.",
      fix: "In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6).",
    });
    expect(ra({ appProtectedCheck: { at: NOW.toISOString(), ok: false, status: 200, location: null, error: "no redirect" } })).toMatchObject({
      status: "bad",
      text: "Anyone on the internet can reach your app's sign-in page.",
      fix: "In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5).",
    });
    expect(ra({ state: "degraded", readyConnections: 2 })).toMatchObject({ status: "warn", text: "Remote access works, but the connection to Cloudflare is weak." });
    expect(ra({ versionWarning: "cloudflared 2026.8.0 has a known problem." }).status).toBe("warn");
    expect(ra({ state: "not-running", appProtectedCheck: null }, (f) => ((f.fakeMode = true), (f.publicUrl = "http://127.0.0.1:3100")))).toMatchObject({
      status: "ok",
    });
  });

  it("remote access with the Cloudflare Access opt-out (M6-DESIGN §2.8)", () => {
    const ra = (t: Partial<TunnelState>, change?: (f: ChecklistFacts) => void) =>
      rowOf(
        with_((f) => {
          f.tunnel = tunnel(t);
          change?.(f);
        }),
        "remote-access",
      );
    const open = { appProtectedCheck: { at: NOW.toISOString(), ok: false, status: 200, location: null, error: "no redirect" } };
    const accessOff = (f: ChecklistFacts) => (f.accessOff = true);
    // An open sign-in page is fine once the Owner said "We don't use Cloudflare Access".
    expect(ra(open, accessOff)).toMatchObject({
      status: "ok",
      text: "Remote access works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login.",
      fix: null,
    });
    // A weak connection and an old cloudflared still warn after it.
    expect(ra({ ...open, state: "degraded", readyConnections: 1 }, accessOff)).toMatchObject({
      status: "warn",
      text: "Remote access works, but the connection to Cloudflare is weak.",
    });
    expect(ra({ ...open, versionWarning: "cloudflared 2026.8.0 has a known problem." }, accessOff)).toMatchObject({
      status: "warn",
      text: "cloudflared 2026.8.0 has a known problem.",
    });
    // Everything before it still fails as before.
    expect(ra({ ...open, webhookPathCheck: { at: NOW.toISOString(), ok: false, status: 302, error: "login page" } }, accessOff).status).toBe("bad");
    expect(ra({ ...open, publicCheck: null, webhookPathCheck: null }, accessOff)).toMatchObject({ status: "unknown", text: "Not checked yet." });
    // Access actually in front of the app: the usual sentence, opt-out or not.
    expect(ra({}, accessOff).text).toBe(
      "Cloudflare reaches this PC, only your team gets past the login, and Mailgun's messages get through without a login page.",
    );
    // Without the opt-out (false or absent) an open sign-in page stays "bad".
    expect(ra(open, (f) => (f.accessOff = false))).toMatchObject({ status: "bad", text: "Anyone on the internet can reach your app's sign-in page." });
    expect(ra(open).status).toBe("bad");
  });

  it("the public address sentence says to run setup.bat again, and update.bat for the services (M6-DESIGN §5.2)", () => {
    const fix =
      "Follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).";
    const noPub = with_((f) => ((f.publicUrl = null), (f.webhooks.url = null)));
    expect(rowOf(noPub, "remote-access")).toMatchObject({ status: "bad", text: "The public address isn't set yet.", fix });
    expect(rowOf(noPub, "webhooks")).toMatchObject({ status: "bad", text: "The public address isn't set yet, so Mailgun can't reach the app.", fix });
  });

  it("reply test: passed only counts on this domain", () => {
    expect(rowOf(with_((f) => (f.replyTest.domain = "old.example.com")), "reply-test")).toMatchObject({
      status: "warn",
      text: "Not tested yet. Live campaigns start once this passes.",
    });
    expect(rowOf(with_((f) => (f.replyTest.status = "failed")), "reply-test")).toMatchObject({ status: "bad", text: "Setup A didn't pass." });
  });

  it("postmaster and domain age", () => {
    expect(rowOf(with_((f) => (f.dns!.txt = both([SPF]))), "postmaster")).toMatchObject({ status: "info", text: "Optional: see how Gmail rates your domain." });
    expect(rowOf(with_((f) => (f.domainRegisteredOn = "2026-09-13")), "domain-age")).toMatchObject({
      status: "warn",
      text: `${D} is 10 days old. Wait until it's 30 days old before real campaigns, then start slowly.`,
    });
    // No date yet: the row asks once; the date field below it is labelled "When did you buy …?", so no fix sentence.
    expect(rowOf(with_((f) => (f.domainRegisteredOn = null)), "domain-age")).toMatchObject({
      status: "info",
      text: `Optional: enter the day you bought ${D} to see its age.`,
      fix: null,
    });
  });

  it("per-person mode: a stored pass of a shared From address doesn't count; from: null is per-person", () => {
    expect(rowOf(with_((f) => (f.replyTest.from = "contact@example.com")), "reply-test")).toMatchObject({
      status: "warn",
      text: "Not tested yet. Live campaigns start once this passes.",
    });
    expect(rowOf(with_((f) => (f.replyTest.from = null)), "reply-test").status).toBe("ok");
    // `from: null` facts are per-person mode: exactly the same rows as without the field.
    expect(rows(with_((f) => (f.from = null)))).toEqual(rows(goodFacts()));
  });
});

// ───────────────────────── shared From address (SHARED-FROM-DESIGN §3.2) ─────────────────────────

const ORG = "example.com";
const FROM = "contact@example.com";
const ZOHO = [
  { priority: 10, exchange: "mx.zoho.com" },
  { priority: 20, exchange: "mx2.zoho.com" },
  { priority: 50, exchange: "mx3.zoho.com" },
];

/** One resolver's DMARC find with the record's own tags (adkim, aspf, rua) read by parseDmarc. */
function policyAt(raw: string | null, at: string = ORG): DmarcFind {
  if (!raw) return { at: null, policy: null, duplicates: false, inherited: false, error: null };
  return { at, policy: parseDmarc(raw), duplicates: false, inherited: false, error: null };
}

/** The owner's shape: From contact@example.com, sent through send.example.com, DKIM signed by the sending domain's key. */
function teamFacts(change?: (x: FromDomainFacts, f: ChecklistFacts) => void): ChecklistFacts {
  const f = goodFacts();
  f.from = {
    address: FROM,
    domain: ORG,
    problem: null,
    signingDomain: D,
    originalSigner: null,
    originalPasted: false,
    dns: {
      txt: both(["v=spf1 include:zoho.com include:mailgun.org ~all", "zoho-verification=zb123.zmverify.zoho.com"]),
      spfLookups: { count: 6, complete: true, dangling: [] },
      mx: both(ZOHO),
      dmarc: { a: policyAt("v=DMARC1; p=none"), b: policyAt("v=DMARC1; p=none"), ruaAuthorized: {} },
    },
  };
  f.replyTest = { status: "passed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z", from: FROM };
  f.domainRegisteredOn = "2023-08-17";
  change?.(f.from, f);
  return f;
}

function teamRow(key: ChecklistRowKey, change?: (x: FromDomainFacts, f: ChecklistFacts) => void, keyBits: number | null = 2048): ChecklistRow {
  return rowOf(teamFacts(change), key, keyBits);
}

describe("shared From address: the two From-domain rows", () => {
  it("come right after DMARC, in the dns group, titled with the From domain (never the sending domain)", () => {
    const r = rows(teamFacts());
    const keys = r.map((x) => x.key);
    expect(keys.slice(keys.indexOf("dmarc"), keys.indexOf("dmarc") + 3)).toEqual(["dmarc", "from-mx", "from-spf"]);
    expect(r).toHaveLength(22);
    const mx = r.find((x) => x.key === "from-mx")!;
    const spf = r.find((x) => x.key === "from-spf")!;
    expect(mx).toMatchObject({ group: "dns", title: "Mail for example.com stays with your mail provider (MX)", records: [] });
    expect(spf).toMatchObject({ group: "dns", title: "example.com's SPF record (your everyday email)", records: [] });
    expect(mx.title).toBe(checklistTitle("from-mx", ORG));
    for (const t of [mx.title, spf.title]) expect(t).not.toContain(D);
    // Per-person mode never has them.
    expect(rows(goodFacts()).map((x) => x.key)).not.toContain("from-mx");
  });

  it("from-mx: ok with the mail provider's hosts", () => {
    expect(teamRow("from-mx")).toMatchObject({
      status: "ok",
      text: "Mail for example.com goes to your mail provider (mx.zoho.com, mx2.zoho.com, mx3.zoho.com), not to Mailgun. Keep it that way.",
      fix: null,
    });
  });

  it("from-mx: a Mailgun MX host (US or EU, on either resolver) is red; the fix keeps the other hosts, never adds Mailgun's", () => {
    const text =
      "example.com's mail servers (MX) point to Mailgun. Email to contact@example.com would go to Mailgun instead of your inbox, and replies the app forwards there would be lost. Live campaign emails wait until this is fixed.";
    const us = teamRow("from-mx", (x) => (x.dns!.mx = { a: ok([...ZOHO, { priority: 5, exchange: "mxa.mailgun.org" }]), b: ok(ZOHO) }));
    expect(us).toMatchObject({
      status: "bad",
      text,
      fix: "In the DNS panel for example.com, delete the MX records of example.com (Name @) that point to Mailgun, and keep only mx.zoho.com, mx2.zoho.com, mx3.zoho.com. Never add Mailgun's MX records to example.com. Then click Check again.",
    });
    const eu = teamRow("from-mx", (x) => (x.dns!.mx = both([{ priority: 10, exchange: "mxa.eu.mailgun.org." }, { priority: 10, exchange: "mxb.eu.mailgun.org" }])));
    expect(eu).toMatchObject({
      status: "bad",
      text,
      fix: "In the DNS panel for example.com, delete the MX records of example.com (Name @) that point to Mailgun, and put back your mail provider's MX records. Never add Mailgun's MX records to example.com. Then click Check again.",
    });
    expect(eu.detail).toContain("mxa.eu.mailgun.org");
  });

  it("from-mx: no MX, Cloudflare Email Routing, spreading, a timeout, and a saved From that doesn't fit", () => {
    expect(teamRow("from-mx", (x) => (x.dns!.mx = none()))).toMatchObject({
      status: "bad",
      text: "example.com has no mail servers (MX), so nobody can email contact@example.com, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.",
      fix: "Add your mail provider's MX records for example.com (Name @). Its help pages list them. Then click Check again.",
    });
    expect(
      teamRow("from-mx", (x) => (x.dns!.mx = both([{ priority: 10, exchange: "route1.mx.cloudflare.net" }, { priority: 20, exchange: "route2.mx.cloudflare.net" }]))),
    ).toMatchObject({
      status: "warn",
      text: "Mail for example.com goes to Cloudflare Email Routing (route1.mx.cloudflare.net, route2.mx.cloudflare.net), not straight to your mail provider.",
      fix: "If your mailbox is with another provider, switch Email Routing off for example.com in Cloudflare and put back the provider's MX records (Cloudflare guide, step 1).",
    });
    expect(teamRow("from-mx", (x) => (x.dns!.mx = { a: ok(ZOHO), b: missing }))).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    expect(teamRow("from-mx", (x) => (x.dns!.mx = { a: timeout, b: missing }))).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK });
    const misfit = "The From address contact@other.test doesn't fit your sending domain send.example.com. Change or clear it in Settings › Sending & Mailgun.";
    const r = rows(
      teamFacts((x) => {
        x.address = "contact@other.test";
        x.domain = "other.test";
        x.problem = misfit;
        x.dns = null;
      }),
    );
    expect(r.find((x) => x.key === "from-mx")).toMatchObject({ status: "bad", text: misfit, title: "Mail for other.test stays with your mail provider (MX)" });
    expect(r.find((x) => x.key === "from-spf")).toMatchObject({ status: "unknown", text: COULD_NOT_CHECK, detail: misfit });
    // With a misfit the other rows stay on the sending domain (per-person wording): nothing is sent with it anyway.
    expect(r.find((x) => x.key === "dmarc")!.text).toBe("Policy found: monitor only. Right for now.");
  });

  it("from-mx: a null MX (RFC 7505 '0 .') is red, never 'goes to your mail provider ()' (review SETTING-3)", () => {
    const nullMx = teamRow("from-mx", (x) => (x.dns!.mx = both([{ priority: 0, exchange: "" }])));
    const bad = {
      status: "bad",
      text: 'example.com\'s MX record says it takes no email (a "null MX"), so email to contact@example.com bounces, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.',
      fix: "In the DNS panel for example.com, delete the MX record of example.com (Name @) whose value is just a dot, and put back your mail provider's MX records. Its help pages list them. Then click Check again.",
    };
    expect(nullMx).toMatchObject(bad);
    expect(nullMx.text).not.toContain("()");
    // Written with the dot, and seen by one resolver while the other has nothing: the same.
    expect(teamRow("from-mx", (x) => (x.dns!.mx = both([{ priority: 0, exchange: "." }])))).toMatchObject(bad);
    expect(teamRow("from-mx", (x) => (x.dns!.mx = { a: ok([{ priority: 0, exchange: "" }]), b: missing }))).toMatchObject(bad);
    // One resolver still sees the mail provider: spreading, as for any change.
    expect(teamRow("from-mx", (x) => (x.dns!.mx = { a: ok([{ priority: 0, exchange: "" }]), b: ok(ZOHO) }))).toMatchObject({ status: "warn", text: SPREADING });
    // A timeout and a null MX: couldn't check (a timeout never makes the row red).
    expect(teamRow("from-mx", (x) => (x.dns!.mx = { a: ok([{ priority: 0, exchange: "" }]), b: timeout }))).toMatchObject({ status: "unknown" });
  });

  it("from-spf: a count left incomplete by a failed lookup is never 'fine' or 'almost full' (review SETTING-4)", () => {
    for (const count of [5, 9, 10]) {
      const r = teamRow("from-spf", (x) => (x.dns!.spfLookups = { count, complete: false, dangling: [] }));
      expect(r, String(count)).toMatchObject({
        status: "unknown",
        text: `Couldn't count all the DNS lookups example.com's SPF record needs: at least ${count} of the 10 allowed.`,
        fix: null,
      });
      expect(r.text).not.toContain("fine");
      expect(r.detail).toContain(`DNS lookups in the SPF record: ${count} or more`);
    }
    // Even the lower bound is over the limit: broken, as when the count is complete.
    expect(teamRow("from-spf", (x) => (x.dns!.spfLookups = { count: 14, complete: false, dangling: [] }))).toMatchObject({
      status: "bad",
      text: "example.com's SPF record needs 14 DNS lookups (the limit is 10), so mail servers treat it as broken. This affects your everyday email.",
    });
    // A dangling include found on both resolvers is broken whatever the count.
    expect(teamRow("from-spf", (x) => (x.dns!.spfLookups = { count: 4, complete: false, dangling: ["gone.example.net"] })).status).toBe("bad");
  });

  it("from-spf: ok, almost full (info, never amber), too many lookups, a dangling include, two records, none", () => {
    expect(teamRow("from-spf")).toMatchObject({
      status: "ok",
      text: "example.com's SPF record is fine (6 of 10 DNS lookups). The app's emails don't use it; they use send.example.com's.",
      fix: null,
    });
    for (const n of [9, 10]) {
      expect(teamRow("from-spf", (x) => (x.dns!.spfLookups = { count: n, complete: true, dangling: [] }))).toMatchObject({
        status: "info",
        text: `example.com's SPF record is almost full (${n} of 10 DNS lookups). Before you add another email service to example.com, ask the person who set up the app.`,
        fix: null,
      });
    }
    const eleven = teamRow("from-spf", (x) => (x.dns!.spfLookups = { count: 11, complete: true, dangling: [] }));
    expect(eleven).toMatchObject({
      status: "bad",
      text: "example.com's SPF record needs 11 DNS lookups (the limit is 10), so mail servers treat it as broken. This affects your everyday email.",
      fix: "Ask the person who set up the app to remove services you no longer use from it. Keep include:mailgun.org: Mailgun needs it to keep example.com verified, and example.com signs your emails.",
    });
    expect(eleven.fix).toContain("Keep include:mailgun.org");
    expect(teamRow("from-spf", (x) => (x.dns!.spfLookups = { count: 4, complete: true, dangling: ["dc-aa11bb_spfm.example.com"] }))).toMatchObject({
      status: "bad",
      text: "example.com's SPF record includes dc-aa11bb_spfm.example.com, which has no SPF record, so mail servers treat example.com's SPF as broken. This affects your everyday email.",
      // Review SCREENS-09: the old DNS host usually no longer shows the zone after a move; the guide has the owner write
      // every record down before it.
      fix: "If example.com's DNS moved recently, add the TXT record of dc-aa11bb_spfm.example.com again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app.",
    });
    const two = teamRow("from-spf", (x) => (x.dns!.txt = { a: ok(["v=spf1 include:zoho.com ~all", "v=spf1 include:mailgun.org ~all"]), b: ok(["v=spf1 include:zoho.com ~all"]) }));
    expect(two).toMatchObject({
      status: "bad",
      text: "example.com has 2 SPF records, so mail servers ignore all of them. This affects your everyday email.",
      fix: "Ask the person who set up the app to merge them into one record, keeping every part of both (including include:mailgun.org).",
    });
    expect(two.fix).not.toContain("v=spf1");
    expect(teamRow("from-spf", (x) => ((x.dns!.txt = both(["zoho-verification=zb123"])), (x.dns!.spfLookups = null)))).toMatchObject({
      status: "info",
      text: "example.com has no SPF record. The app's emails don't use it, but your everyday email should have one.",
      fix: "Your mail provider's help pages show the record to add (Name @).",
    });
    expect(teamRow("from-spf", (x) => (x.dns!.txt = { a: ok(["v=spf1 include:zoho.com ~all"]), b: missing })).status).toBe("warn");
    expect(teamRow("from-spf", (x) => (x.dns!.txt = { a: timeout, b: missing })).status).toBe("unknown");
  });

  it("from-spf never suggests dropping include:mailgun.org or builds a record", () => {
    const variants: Array<(x: FromDomainFacts) => void> = [
      () => undefined,
      (x) => (x.dns!.spfLookups = { count: 9, complete: true, dangling: [] }),
      (x) => (x.dns!.spfLookups = { count: 14, complete: false, dangling: [] }),
      (x) => (x.dns!.spfLookups = { count: 3, complete: true, dangling: ["gone.example.net"] }),
      (x) => (x.dns!.txt = both(["v=spf1 include:zoho.com ~all", "v=spf1 include:mailgun.org -all"])),
      (x) => (x.dns!.txt = none()),
    ];
    for (const v of variants) {
      const r = teamRow("from-spf", v);
      const words = `${r.text} ${r.fix ?? ""}`;
      expect(words).not.toMatch(/(don't|do not|no longer) need include:mailgun\.org/i);
      expect(words).not.toMatch(/remove include:mailgun\.org/i);
      expect(r.fix ?? "").not.toContain("v=spf1");
    }
  });
});

describe("shared From address: DMARC on the From domain", () => {
  const dm = (raw: string | null, change?: (x: FromDomainFacts) => void) =>
    teamRow("dmarc", (x) => {
      x.dns!.dmarc = { a: policyAt(raw), b: policyAt(raw), ruaAuthorized: {} };
      change?.(x);
    });

  it("checks _dmarc.<From domain> and names it", () => {
    expect(dm("v=DMARC1; p=none")).toMatchObject({ status: "ok", text: "example.com's policy: monitor only. Right for now." });
    expect(dm("v=DMARC1; p=reject")).toMatchObject({ status: "ok", text: "example.com's policy: reject." });
    expect(dm("v=DMARC1; p=none").records[0]).toMatchObject({ type: "TXT", name: "_dmarc", fqdn: "_dmarc.example.com", value: "v=DMARC1; p=none" });
    expect(dm(null)).toMatchObject({
      status: "bad",
      text: "No DMARC policy found for example.com, the domain in your From address.",
      fix: "Add a TXT record. Name: _dmarc. Value: v=DMARC1; p=none. It also covers your everyday email from example.com; p=none changes nothing for it.",
    });
  });

  it("strict alignment: bad only when both SPF and DKIM are strict and the From domain doesn't sign", () => {
    const strict = {
      status: "bad",
      text: "example.com's DMARC record asks for strict alignment (adkim=s and aspf=s), so emails sent through send.example.com fail it.",
      fix: "Remove adkim=s and aspf=s from the record (relaxed is the default). Don't change anything else in it: the value below is your record without them.",
    };
    // Signed by the sending domain (the fake's default): strict DKIM fails too.
    expect(dm("v=DMARC1; p=none; adkim=s; aspf=s")).toMatchObject(strict);
    // No signer known at all.
    expect(dm("v=DMARC1; p=none; adkim=s; aspf=s", (x) => (x.signingDomain = null))).toMatchObject(strict);
    // aspf=s alone: DKIM (relaxed) still aligns.
    expect(dm("v=DMARC1; p=none; aspf=s").status).toBe("ok");
    // adkim=s with the From domain as the signer: DKIM aligns strictly.
    expect(dm("v=DMARC1; p=none; adkim=s; aspf=s", (x) => (x.signingDomain = ORG)).status).toBe("ok");
    // …or with the signer read from the pasted original when Mailgun lists none.
    expect(dm("v=DMARC1; p=none; adkim=s; aspf=s", (x) => ((x.signingDomain = null), (x.originalSigner = ORG), (x.originalPasted = true))).status).toBe("ok");
  });

  it("strict alignment: the record box offers the owner's own record without the two tags, never p=none (review SCREENS-10)", () => {
    const raw = "v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:dmarc@send.example.com; pct=100";
    const r = dm(raw);
    expect(r.status).toBe("bad");
    expect(r.records).toEqual([
      {
        type: "TXT",
        name: "_dmarc",
        fqdn: "_dmarc.example.com",
        value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@send.example.com; pct=100",
        priority: null,
        found: [raw],
      },
    ]);
    // What the Copy button gives agrees with the fix: the policy and the report address stay.
    for (const rec of r.records) {
      expect(rec.value).not.toMatch(/adkim|aspf/i);
      expect(rec.value).toContain("p=quarantine");
      expect(rec.value).toContain("rua=mailto:dmarc@send.example.com");
      expect(rec.value).not.toBe("v=DMARC1; p=none");
    }
    // Every other case keeps the suggested record (a missing record still gets v=DMARC1; p=none).
    expect(dm(null).records[0]!.value).toBe("v=DMARC1; p=none");
  });

  it("withoutStrictAlignment keeps every other tag as written, in order", () => {
    expect(withoutStrictAlignment("v=DMARC1; p=reject; adkim=s; aspf=s")).toBe("v=DMARC1; p=reject");
    expect(withoutStrictAlignment("v=DMARC1;p=none;ADKIM = s;aspf=r;rua=mailto:a@b.com;")).toBe("v=DMARC1; p=none; rua=mailto:a@b.com");
    expect(withoutStrictAlignment("v=DMARC1; p=none")).toBe("v=DMARC1; p=none");
  });

  it("report addresses: an unauthorised one points to dmarc@ on the sending domain", () => {
    const r = teamRow("dmarc", (x) => {
      const raw = "v=DMARC1; p=none; rua=mailto:reports@dmarc-service.io";
      x.dns!.dmarc = { a: policyAt(raw), b: policyAt(raw), ruaAuthorized: { "dmarc-service.io": false } };
    });
    expect(r).toMatchObject({
      status: "warn",
      text: "Reports to dmarc-service.io will be dropped (that domain hasn't agreed to receive them).",
      fix: "Use dmarc@send.example.com or remove rua.",
    });
    // The sending domain's dmarc@ is the same organisation: nothing to authorise.
    expect(dm("v=DMARC1; p=none; rua=mailto:dmarc@send.example.com").status).toBe("ok");
    expect(teamRow("dmarc", (x) => (x.dns!.dmarc = { a: policyAt("v=DMARC1; p=none"), b: policyAt(null), ruaAuthorized: {} }))).toMatchObject({
      status: "warn",
      text: SPREADING,
    });
  });
});

describe("shared From address: DKIM names the signer", () => {
  it("the From domain signs: it matches the From address (1024-bit is ok with a note)", () => {
    expect(teamRow("dkim", (x) => (x.signingDomain = ORG))).toMatchObject({
      status: "ok",
      text: "Your emails carry example.com's digital signature (2048-bit), which matches your From address.",
    });
    expect(teamRow("dkim", (x) => (x.signingDomain = ORG), 1024)).toMatchObject({
      status: "ok",
      text: "Your emails carry example.com's digital signature (1024-bit; it works, 2048-bit is stronger), which matches your From address.",
    });
  });

  it("the sending domain signs: it fits, with the note that the main domain doesn't", () => {
    expect(teamRow("dkim")).toMatchObject({
      status: "ok",
      text: "Your emails carry send.example.com's digital signature (2048-bit). It fits your From address contact@example.com: same main domain. (example.com doesn't sign them: if you expected it to, check that both domains are in the same Mailgun account and region, US.)",
    });
  });

  it("missing and mismatched records keep today's texts", () => {
    expect(teamRow("dkim", (x, f) => (f.dns!.dkim[0]!.answers = none()))).toMatchObject({ status: "bad", text: `The DKIM record for ${D} is missing.` });
  });

  it("Mailgun lists no DKIM record: the pasted original settles it", () => {
    const noRecord = (change: (x: FromDomainFacts) => void) =>
      teamRow("dkim", (x, f) => {
        f.dns!.dkim = [];
        x.signingDomain = null;
        change(x);
      });
    expect(noRecord((x) => ((x.originalSigner = ORG), (x.originalPasted = true)))).toMatchObject({
      status: "ok",
      text: "Mailgun doesn't list a DKIM record for send.example.com, but the reply test's email was signed by example.com (dkim=pass), which fits your From address.",
      fix: null,
    });
    expect(noRecord((x) => ((x.originalSigner = "send.example.com"), (x.originalPasted = true))).status).toBe("ok");
    expect(noRecord(() => undefined)).toMatchObject({
      status: "unknown",
      text: "Mailgun didn't list a DKIM record for send.example.com. With a From address, example.com usually signs your emails.",
      // Review SCREENS-08: pasting an original doesn't start a check, so the fix says to click Check again.
      fix: "Run the reply test (below) and paste one test email's original, then click Check again: this row reads the signature from it. If it shows no signature, check in Mailgun (Send › Domains) that example.com and send.example.com are both there, in the same region (US).",
    });
    expect(noRecord((x) => (x.originalPasted = true))).toMatchObject({
      status: "warn",
      text: "The reply test's email carried no valid signature of example.com.",
      fix: "Check in Mailgun (Send › Domains) that example.com is still there and verified, and that send.example.com is in the same region (US). Then send the reply test's emails again, paste a new original and click Check again.",
    });
  });

  it("signingDomainOf reads the part after ._domainkey. of the first active DKIM record", () => {
    const rec = (name: string, isActive = true, recordType = "TXT") => ({ recordType, name, value: "v", priority: null, valid: "valid", isActive, cached: [] });
    expect(signingDomainOf({ sending: [rec("send.example.com"), rec("pdk1._domainkey.example.com")] })).toBe("example.com");
    expect(signingDomainOf({ sending: [rec("mx._domainkey.polygonparadise.com.", true, "CNAME")] })).toBe("polygonparadise.com");
    expect(signingDomainOf({ sending: [rec("old._domainkey.x.example.com", false), rec("pdk1._domainkey.send.example.com")] })).toBe("send.example.com");
    expect(signingDomainOf({ sending: [rec("send.example.com")] })).toBeNull();
  });
});

describe("shared From address: reply test, Gmail dashboard and domain age", () => {
  it("reply test: counts only a decision for this domain and today's From address", () => {
    expect(teamRow("reply-test")).toMatchObject({
      status: "ok",
      text: "Setup A passed on 22 Sept with the From address contact@example.com: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC.",
    });
    const notYet = { status: "warn", text: "Not tested yet with the From address contact@example.com. Live campaigns start once this passes." };
    expect(teamRow("reply-test", (_x, f) => (f.replyTest.from = "hello@example.com"))).toMatchObject(notYet);
    // A per-person pass (no `from`) doesn't count for the shared From address.
    expect(teamRow("reply-test", (_x, f) => delete f.replyTest.from)).toMatchObject(notYet);
    expect(teamRow("reply-test", (_x, f) => (f.replyTest.domain = "old.example.com"))).toMatchObject(notYet);
    const failed = teamRow("reply-test", (_x, f) => (f.replyTest.status = "failed"));
    expect(failed).toMatchObject({
      status: "bad",
      text: "Setup A didn't pass with the From address contact@example.com.",
      fix: "The reply test section says which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on send.example.com) and ask the person who set up the app.",
    });
    expect(failed.fix).not.toContain("reply.<domain>");
    // A failure of another From address is simply "not tested yet" here.
    expect(teamRow("reply-test", (_x, f) => ((f.replyTest.status = "failed"), (f.replyTest.from = null)))).toMatchObject(notYet);
  });

  it("Gmail dashboard reads the From domain's TXT records", () => {
    expect(teamRow("postmaster")).toMatchObject({
      status: "info",
      text: "Optional: see how Gmail rates example.com, the domain in your From address.",
      fix: "Open postmaster.google.com, click Add new domain, type example.com, copy the TXT record it shows and add it (Name @). It shows data only once you send enough email.",
    });
  });

  it("Gmail dashboard: a Google verification record on the From domain never turns it green (review SCREENS-03)", () => {
    // The main domain usually has one already (Search Console, Workspace…), and it doesn't say which service it's for.
    const r = teamRow("postmaster", (x) => (x.dns!.txt = both(["v=spf1 include:mailgun.org ~all", "google-site-verification=abc"])));
    expect(r).toMatchObject({
      status: "info",
      text: "A Google verification record is on example.com. Check at postmaster.google.com that example.com is listed there.",
      fix: "The app can't tell which Google service that record is for. If example.com isn't listed in Postmaster Tools, click Add new domain, type example.com, copy the TXT record it shows and add it (Name @). It shows data only once you send enough email.",
    });
    // So the go-live card keeps recommending Postmaster Tools for the main domain (it drops it only for an "ok" row).
    expect(r.status).not.toBe("ok");
    // Per-person mode is unchanged: the sending domain's record still reads as set up.
    expect(rowOf(goodFacts(), "postmaster")).toMatchObject({ status: "ok", text: "Google Postmaster Tools looks set up." });
  });

  it("domain age is about the From domain", () => {
    expect(teamRow("domain-age")).toMatchObject({ status: "ok", text: "example.com is 1,133 days old." });
    expect(teamRow("domain-age", (_x, f) => (f.domainRegisteredOn = null)).text).toBe("Optional: enter the day you bought example.com to see its age.");
  });

  it("every other row stays on the sending domain", () => {
    const team = rows(teamFacts());
    const plain = rows(goodFacts());
    for (const key of ["mailgun-domain", "spf", "mx", "tracking-cname", "https-links", "webhooks", "reply-routes", "sending-allowed"] as const) {
      expect(team.find((x) => x.key === key), key).toEqual(plain.find((x) => x.key === key));
    }
  });
});

describe("safety: the From domain is never asked to point its MX at Mailgun (§2.5)", () => {
  const mailgunHosts = both([{ priority: 10, exchange: "mxa.mailgun.org" }, { priority: 10, exchange: "mxb.mailgun.org" }]);
  const variants: Array<(x: FromDomainFacts, f: ChecklistFacts) => void> = [
    () => undefined,
    (x) => (x.dns!.mx = mailgunHosts),
    (x) => (x.dns!.mx = { a: ok([...ZOHO, { priority: 1, exchange: "mxa.eu.mailgun.org" }]), b: ok(ZOHO) }),
    (x) => (x.dns!.mx = none()),
    (x) => (x.dns!.mx = both([{ priority: 0, exchange: "" }])),
    (x) => (x.dns!.mx = both([{ priority: 10, exchange: "route1.mx.cloudflare.net" }])),
    (x) => (x.dns!.mx = { a: ok(ZOHO), b: timeout }),
    (_x, f) => (f.dns!.mx = none()),
    (_x, f) => (f.dns!.mx = mailgunHosts),
    (x) => (x.dns!.dmarc = { a: policyAt(null), b: policyAt(null), ruaAuthorized: {} }),
    (x) => (x.dns!.txt = none()),
  ];

  it("no record box is an MX record of the From domain, and no fix asks to add one pointing to Mailgun", () => {
    for (const v of variants) {
      for (const r of rows(teamFacts(v))) {
        for (const rec of r.records) {
          expect(rec.type.toUpperCase() === "MX" && rec.fqdn.toLowerCase().replace(/\.$/, "") === ORG, `${r.key} record box`).toBe(false);
        }
        for (const sentence of (r.fix ?? "").split(/(?<=\.)\s+/)) {
          if (!/^add\b/i.test(sentence) || !/\bMX\b/.test(sentence)) continue;
          // The sending domain's MX row names its own host ("Name send"); anything for the From domain says "Name @".
          const forFromDomain = /Name @|for example\.com\b/.test(sentence);
          expect(forFromDomain && /mailgun\.org/i.test(sentence), `${r.key}: ${sentence}`).toBe(false);
        }
      }
    }
  });

  it("the from-mx fixes only ever delete Mailgun's records there or put back the mail provider's", () => {
    for (const v of variants) {
      const fix = rows(teamFacts(v)).find((x) => x.key === "from-mx")!.fix;
      if (!fix) continue;
      expect(
        /delete the MX records of example\.com \(Name @\) that point to Mailgun/.test(fix) ||
          /put back (your mail provider's|the provider's) MX records/.test(fix) ||
          /^Add your mail provider's MX records for example\.com/.test(fix),
        fix,
      ).toBe(true);
      expect(fix).not.toMatch(/mx[ab]\.(eu\.)?mailgun\.org/);
    }
  });
});
