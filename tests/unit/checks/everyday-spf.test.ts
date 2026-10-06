import { describe, expect, it } from "vitest";
import {
  buildChecklistRows,
  OWN_SPF_TEXTS,
  SPREADING,
  type ChecklistFacts,
  type DnsFacts,
  type FromDomainFacts,
  type MailgunDomainFact,
} from "@/core/dns/checklist";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { ChecklistRow, ChecklistRowKey, TunnelState } from "@/core/system-state";
import { gatherDnsFacts, gatherFromDomainFacts } from "@/server/services/checks/dns-facts";
import { FakeDns, type FakeZone } from "./fake-dns";

/**
 * Review DOMAIN-1 and DOMAIN-4 with the real gatherers: the owner's GoDaddy-style SPF tree (9 lookups, Mailgun reached
 * through dc-bb._spfm) asked of two resolvers that disagree. Own-mailbox mode (and a website domain checked in app mode,
 * O37) walks the tree on each resolver; a difference is "Still spreading", never a fix that edits the everyday domain's
 * SPF record; a repeated include is counted every time, so a record that needs 13 lookups is never "10 of 10".
 */

const P = "polygonparadise.com";
const NOW = new Date("2026-09-28T10:00:00Z");
const DKIM = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekey";
const TOP = `v=spf1 include:dc-aa._spfm.${P} include:dc-bb._spfm.${P} ~all`;

/** The owner's zone: 2 + (1 + 2) for Zoho + (1 + 3) for Mailgun = 9 lookups. */
function zone(): FakeZone {
  return {
    [P]: { txt: [TOP, "google-site-verification=abc"], mx: [{ priority: 10, exchange: "mx.zoho.com" }] },
    [`dc-aa._spfm.${P}`]: { txt: ["v=spf1 include:zoho.com ~all"] },
    [`dc-bb._spfm.${P}`]: { txt: ["v=spf1 include:mailgun.org ~all"] },
    "zoho.com": { txt: ["v=spf1 include:transmail.net include:zcsend.net ~all"] },
    "transmail.net": { txt: ["v=spf1 ip4:136.143.188.0/24 ~all"] },
    "zcsend.net": { txt: ["v=spf1 ip4:135.84.80.0/24 ~all"] },
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org ~all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 include:_a.mailgun.org include:_b.mailgun.org ~all"] },
    "_a.mailgun.org": { txt: ["v=spf1 ip4:192.0.2.1 ~all"] },
    "_b.mailgun.org": { txt: ["v=spf1 ip4:192.0.2.2 ~all"] },
    [`mx._domainkey.${P}`]: { txt: [DKIM] },
    [`email.${P}`]: { cname: ["mailgun.org"] },
    [`_dmarc.${P}`]: { txt: ["v=DMARC1; p=none"] },
  };
}

const M: MailgunDomainFact = {
  state: "active",
  isDisabled: false,
  disabledReason: null,
  spamAction: "disabled",
  webPrefix: "email",
  webScheme: "http",
  messageTtl: 86_400,
  webhooksRedactPii: false,
  sending: [
    { recordType: "TXT", name: P, value: "v=spf1 include:mailgun.org ~all", priority: null, valid: "valid", isActive: true, cached: [] },
    { recordType: "TXT", name: `mx._domainkey.${P}`, value: DKIM, priority: null, valid: "valid", isActive: true, cached: [] },
    { recordType: "CNAME", name: `email.${P}`, value: "mailgun.org", priority: null, valid: "valid", isActive: true, cached: [] },
  ],
  receiving: [],
};

function tunnel(): TunnelState {
  return {
    checkedAt: null,
    state: "not-running",
    readyConnections: 0,
    port: null,
    connectorId: null,
    version: null,
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: null,
    webhookPathCheck: null,
    appProtectedCheck: null,
    selfCheckNonce: null,
  };
}

function facts(dns: DnsFacts, own: NonNullable<FromDomainFacts["dns"]> | null): ChecklistFacts {
  return {
    domain: P,
    region: "US",
    now: NOW,
    timeZone: "Asia/Karachi",
    mailgun: { ok: true, value: M },
    verifyError: null,
    dns,
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
    replyTest: { status: "untested", setup: "A", domain: null, decidedAt: null },
    domainRegisteredOn: null,
    ...(own
      ? {
          ownMailbox: true,
          from: { address: `contact@${P}`, domain: P, problem: null, signingDomain: P, originalSigner: null, originalPasted: false, dns: own },
          plan: null,
          lastGoodMx: null,
        }
      : {}),
  };
}

function rowOf(rows: ChecklistRow[], key: ChecklistRowKey): ChecklistRow {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

/** Own-mailbox mode's SPF row, 1.1.1.1 answering `a` and 8.8.8.8 answering `b`. */
async function ownSpf(a: FakeZone, b: FakeZone): Promise<ChecklistRow> {
  const lookups = [new FakeDns(a), new FakeDns(b)] as const;
  const dns = await gatherDnsFacts(P, M, lookups);
  const own = await gatherFromDomainFacts(P, lookups, { ownMailbox: true });
  return rowOf(buildChecklistRows(facts(dns, own), { keyBits: 1024 }), "spf");
}

/** The website domain checked in app mode (O37), 1.1.1.1 answering `a` and 8.8.8.8 answering `b`. */
async function websiteSpf(a: FakeZone, b: FakeZone): Promise<ChecklistRow> {
  const lookups = [new FakeDns(a), new FakeDns(b)] as const;
  const dns = await gatherDnsFacts(P, M, lookups, { everydaySpf: true });
  return rowOf(buildChecklistRows(facts(dns, null), { keyBits: 1024 }), "spf");
}

function without(name: string): FakeZone {
  const z = zone();
  delete z[name];
  return z;
}

describe("own-mailbox mode: the SPF row over both resolvers' walks (review DOMAIN-1)", () => {
  it("the owner's tree on both: ok, almost full (9 of 10)", async () => {
    expect(await ownSpf(zone(), zone())).toMatchObject({ status: "ok", text: expect.stringContaining("9 of 10 DNS lookups") });
  });

  it("(a) 1.1.1.1 has lost dc-bb._spfm, 8.8.8.8 still has it: still spreading, no add-include fix", async () => {
    const r = await ownSpf(without(`dc-bb._spfm.${P}`), zone());
    expect(r).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    expect(r.detail).toContain("Walk on 1.1.1.1:");
  });

  it("(c) the reverse (8.8.8.8, which Gmail relies on, sees the dangling include): still spreading, never ok", async () => {
    expect(await ownSpf(zone(), without(`dc-bb._spfm.${P}`))).toMatchObject({ status: "warn", text: SPREADING, fix: null });
  });

  it("(d) 1.1.1.1 still serves an old top-level record without Mailgun: still spreading", async () => {
    const old = zone();
    old[P]!.txt = [`v=spf1 include:dc-aa._spfm.${P} ~all`];
    expect(await ownSpf(old, zone())).toMatchObject({ status: "warn", text: SPREADING, fix: null });
  });

  it("dc-bb._spfm lost on both: the dangling fix (re-add it), as before", async () => {
    expect(await ownSpf(without(`dc-bb._spfm.${P}`), without(`dc-bb._spfm.${P}`))).toMatchObject({
      status: "bad",
      text: expect.stringContaining(`includes dc-bb._spfm.${P}, which has no SPF record`),
    });
  });

  it("(b) include:mailgun.org added on top of the tree that already reaches it: 13 lookups, bad (never 10 of 10)", async () => {
    const twice = zone();
    twice[P]!.txt = [`v=spf1 include:dc-aa._spfm.${P} include:dc-bb._spfm.${P} include:mailgun.org ~all`];
    expect(await ownSpf(twice, twice)).toMatchObject({
      status: "bad",
      text: `${P}'s SPF record needs 13 DNS lookups (the limit is 10), so mail servers treat it as broken: your campaign emails and your everyday email fail SPF.`,
    });
  });

  it("Mailgun missing on both, complete walks: the fix goes through the person who set up the app", async () => {
    const none = zone();
    none[`dc-bb._spfm.${P}`] = { txt: ["v=spf1 ~all"] };
    const r = await ownSpf(none, none);
    expect(r).toMatchObject({ status: "bad", fix: OWN_SPF_TEXTS.noMailgunFix(P, "@", "include:mailgun.org", 5) });
    // Missing on one resolver only: still spreading.
    expect(await ownSpf(none, zone())).toMatchObject({ status: "warn", text: SPREADING, fix: null });
  });

  it("a timeout in the tree on one resolver: never red, never the fix", async () => {
    const slow = zone();
    slow["zoho.com"] = { txt: "timeout" };
    const r = await ownSpf(slow, zone());
    expect(["warn", "unknown"]).toContain(r.status);
    expect(r.fix).toBeNull();
  });
});

describe("O37: the website domain in app mode (review DOMAIN-4)", () => {
  it("gathers both walks and the dangling includes; a lost helper gets the dangling fix, never an include to add", async () => {
    const lookups = [new FakeDns(without(`dc-bb._spfm.${P}`)), new FakeDns(without(`dc-bb._spfm.${P}`))] as const;
    const dns = await gatherDnsFacts(P, M, lookups, { everydaySpf: true });
    expect(dns.spfLookups).toMatchObject({ dangling: [`dc-bb._spfm.${P}`], complete: true });
    expect(dns.spfLookups?.walks?.[0]).toMatchObject({ dangling: [`dc-bb._spfm.${P}`] });
    const r = await websiteSpf(without(`dc-bb._spfm.${P}`), without(`dc-bb._spfm.${P}`));
    expect(r).toMatchObject({ status: "bad", text: expect.stringContaining(`includes dc-bb._spfm.${P}, which has no SPF record`) });
    expect(r.fix).not.toMatch(/add include:/i);
  });

  it("Mailgun really missing: connect again in own-mailbox mode; spreading as in own-mailbox mode", async () => {
    const none = zone();
    none[`dc-bb._spfm.${P}`] = { txt: ["v=spf1 ~all"] };
    expect(await websiteSpf(none, none)).toMatchObject({ status: "bad", fix: OWN_MAILBOX_TEXTS.websiteInAppModeFix });
    expect(await websiteSpf(without(`dc-bb._spfm.${P}`), zone())).toMatchObject({ status: "warn", text: SPREADING });
    expect(await websiteSpf(zone(), zone())).toMatchObject({ status: "ok" });
  });

  it("another domain in app mode keeps today's single walk (no both-resolver fields)", async () => {
    const lookups = [new FakeDns(zone()), new FakeDns(zone())] as const;
    const dns = await gatherDnsFacts(P, M, lookups);
    expect(dns.spfLookups).toEqual({ count: 9, complete: true, names: expect.any(Array) });
    const shared = await gatherFromDomainFacts(P, lookups);
    expect(shared.spfLookups).not.toHaveProperty("walks");
  });
});
