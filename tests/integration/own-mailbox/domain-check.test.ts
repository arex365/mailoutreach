import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, setSetting, setState } from "../mail-events/seed";
import { FakeDns, type FakeZone } from "../../unit/checks/fake-dns";

/**
 * The domain check in own-mailbox mode (MAIN-DOMAIN-DESIGN §5, §3.3, O10, O36): against the fake Mailgun on the Free
 * plan whose domain's mail goes elsewhere (`receivesMail: false`) and an injected DNS table shaped like the owner's
 * (GoDaddy's `_spfm` includes, the mail provider's MX). The rows are the own-mailbox list; the stored state records the
 * mode and the last good MX; a red from-mx row tells the Owner once a day with the own-mailbox body.
 */

// Any real resolver in this file is a bug: node:dns is replaced by one that refuses to be made.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor() {
      throw new Error("A real DNS resolver was created in a test.");
    }
  },
}));

const t = await createTestDb("own-mailbox-domain-check");
const mg = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  fromAddress: "contact@example.com",
  plan: "free",
  fake: { plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runDomainCheck, FROM_DOMAIN_NOTICE_TEXTS } = await import("@/server/services/checks/domain-check");
const { parseDomainCheckState } = await import("@/core/system-state-parse");
const { NEVER_MAILGUN_MX_TEXT, OWN_REPLY_TEST_TEXTS } = await import("@/core/sending/own-mailbox");
type ChecklistRow = import("@/core/system-state").ChecklistRow;

const D = mg.domain;
const FROM = "contact@example.com";
const DKIM = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB";
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const noFetch = (async () => {
  throw new TypeError("fetch failed (no network in this test)");
}) as unknown as typeof fetch;
const previousPub = process.env.APP_PUBLIC_URL;
const OWN_KEYS = [
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

/** MAIN-DOMAIN-DESIGN §9.3's table: the mail provider's MX, GoDaddy's two _spfm includes, Mailgun reached through dc-2. */
function ownZone(): FakeZone {
  return {
    [D]: {
      mx: [{ priority: 10, exchange: "mx.provider.example" }],
      txt: [`v=spf1 include:dc-1._spfm.${D} include:dc-2._spfm.${D} ~all`, "google-site-verification=abc"],
    },
    [`dc-1._spfm.${D}`]: { txt: ["v=spf1 include:_spf.provider.example ~all"] },
    [`dc-2._spfm.${D}`]: { txt: ["v=spf1 include:mailgun.org ~all"] },
    "_spf.provider.example": { txt: ["v=spf1 ip4:192.0.2.20 ~all"] },
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org ~all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 ip4:192.0.2.40 ~all"] },
    [`pdk1._domainkey.${D}`]: { txt: [[DKIM.slice(0, 60), DKIM.slice(60)]] },
    [`email.${D}`]: { cname: ["mailgun.org"] },
    [`_dmarc.${D}`]: { txt: ["v=DMARC1; p=none"] },
  };
}

const run = (zone: FakeZone, now?: Date) =>
  runDomainCheck({ verify: true, now, lookups: [new FakeDns(zone), new FakeDns(zone)], mailgun, fetchImpl: noFetch });

function byKey(list: ChecklistRow[]) {
  return Object.fromEntries(list.map((r) => [r.key, r]));
}

async function stored() {
  const row = await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } });
  return { raw: row.value as Record<string, unknown>, parsed: parseDomainCheckState(row.value) };
}

async function mxNotes() {
  return db.notification.findMany({ where: { title: FROM_DOMAIN_NOTICE_TEXTS.mxTitle(D) } });
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = "";
  await makeOwner("Arslan", "arslan@polygonparadise.test");
  // What the owner's Mailgun shows (SPF, DKIM, tracking verified) and what Apply leaves behind on the Free plan.
  mg.fake.setDns("all");
  const ctx = await mailgun();
  if (!ctx.connected) throw new Error(ctx.text);
  await ctx.client.setOpenTracking(D, false);
  await ctx.client.setClickTracking(D, false);
  await ctx.client.setUnsubscribeTracking(D, true, { html: "", text: "" });
  await setState("mailgun.setup", {
    runAt: "2026-09-28T10:00:00.000Z",
    byUserId: null,
    jobId: null,
    steps: [],
    certificate: { host: `email.${D}`, status: "not-in-plan", startedAt: null, lastPolledAt: null, error: null },
  });
  await setSetting("mailgun.domainRegisteredOn", "2024-08-22");
});

beforeEach(async () => {
  await setSetting("mailgun.replies", "own-mailbox");
  await setSetting("mailgun.fromAddress", FROM);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["domain.check", "sending.pause", "notices"] } } });
    await c.notification.deleteMany({});
  });
  mg.fake.requests.length = 0;
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("runDomainCheck in own-mailbox mode", () => {
  it("builds the own-mailbox rows, all done or info, from-mx titled with the sending domain; stores the mode and the last good MX", async () => {
    const state = await run(ownZone());
    expect(state.rows.map((r) => r.key)).toEqual(OWN_KEYS);
    const rows = byKey(state.rows);
    const notOk = state.rows.filter((r) => r.status !== "ok").map((r) => `${r.key}: ${r.status}`);
    expect(notOk).toEqual(["https-links: info", "webhooks: info", "monthly-limit: info", "remote-access: info", "reply-test: warn", "postmaster: info"]);
    expect(rows.spf).toMatchObject({ status: "ok", title: `Mailgun may send for ${D} (SPF)`, text: `Mailgun may send for ${D} (5 of 10 DNS lookups).`, records: [] });
    expect(rows["from-mx"]).toMatchObject({
      status: "ok",
      title: "Mail for example.com stays with your mail provider (MX)",
      text: "Mail for example.com goes to your mail provider (mx.provider.example), not to Mailgun, so replies reach your inbox. Keep it that way.",
      records: [],
    });
    expect(rows.dmarc).toMatchObject({ status: "ok", text: "Policy found: monitor only. Right for now." });
    expect(rows["reply-test"]).toMatchObject({ status: "warn", text: `Not tested yet with the From address ${FROM}. Live campaigns start once this passes.` });
    expect(rows["monthly-limit"]!.text).toBe("Your Mailgun plan stops at 100 emails a day, so a monthly safety limit isn't needed.");
    expect(rows["domain-age"]!.status).toBe("ok");
    expect(state).toMatchObject({ domain: D, error: null, replies: "own-mailbox", lastGoodMx: [{ priority: 10, host: "mx.provider.example" }] });
    const { raw, parsed } = await stored();
    expect(raw.replies).toBe("own-mailbox");
    expect(parsed.lastGoodMx).toEqual([{ priority: 10, host: "mx.provider.example" }]);
    // Nothing about receiving is ever asked of Mailgun: no route request.
    expect(mg.fake.requests.filter((r) => r.path.startsWith("/v3/routes"))).toEqual([]);
    // A healthy check tells nobody anything.
    expect(await mxNotes()).toHaveLength(0);
  });

  it("MX switched to Mailgun: from-mx red, its fix names the MX of the earlier ok check, and the Owner hears once a day", async () => {
    await run(ownZone());
    const bad = ownZone();
    bad[D]!.mx = [{ priority: 10, exchange: "mxa.mailgun.org" }];
    const rows = byKey((await run(bad)).rows);
    expect(rows["from-mx"]).toMatchObject({
      status: "bad",
      text: "example.com's mail servers (MX) point to Mailgun. Your everyday email and every reply to your campaigns would go to Mailgun, where nobody reads them. Live campaign emails wait until this is fixed.",
      fix: `In the DNS panel for example.com (GoDaddy), delete the MX records of example.com (Name @) that point to Mailgun, and put back your mail provider's MX records: mx.provider.example (priority 10). ${NEVER_MAILGUN_MX_TEXT(D)} Then click Check again.`,
    });
    // The red check keeps the last good MX it didn't see itself.
    expect((await stored()).parsed.lastGoodMx).toEqual([{ priority: 10, host: "mx.provider.example" }]);
    await run(bad);
    const notes = await mxNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "system.mailgun", link: "/settings/domain", body: FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn(D) });
    expect(notes[0]!.body).toBe(
      "example.com's mail servers (MX) point to Mailgun or are missing, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait until it's fixed. Open Settings › Domain checklist.",
    );
    // No from-spf notice exists in this mode.
    expect(await db.notification.count({ where: { title: { contains: "SPF record is broken" } } })).toBe(0);
  });

  it("Cloudflare Email Routing is red and tells the Owner too; another domain's last good MX is never used", async () => {
    await setState("domain.check", {
      domain: "other.example",
      region: "US",
      checkedAt: new Date().toISOString(),
      lastVerifyAt: null,
      rows: [],
      error: null,
      replies: "own-mailbox",
      lastGoodMx: [{ priority: 10, host: "mx.other.example" }],
    });
    const cf = ownZone();
    cf[D]!.mx = [{ priority: 10, exchange: "route1.mx.cloudflare.net" }];
    const rows = byKey((await run(cf)).rows);
    expect(rows["from-mx"]).toMatchObject({ status: "bad", fix: expect.stringContaining("(its help pages list them)") });
    expect(rows["from-mx"]!.fix).not.toContain("mx.other.example");
    expect(await mxNotes()).toHaveLength(1);
    expect((await stored()).parsed.lastGoodMx ?? null).toBeNull();
  });

  it("builds from-mx with no From saved; the reply-test row asks for the From address", async () => {
    await setSetting("mailgun.fromAddress", null);
    const rows = byKey((await run(ownZone())).rows);
    expect(rows["from-mx"]).toMatchObject({ status: "ok", title: "Mail for example.com stays with your mail provider (MX)" });
    expect(rows["reply-test"]).toMatchObject({ status: "warn", text: OWN_REPLY_TEST_TEXTS.noFromRow });
  });

  it("SPF: a top-level include:mailgun.org is ok; a vanished dc-2._spfm is red and no fix gives an SPF value", async () => {
    const top = ownZone();
    top[D]!.txt = ["v=spf1 include:mailgun.org ~all"];
    expect(byKey((await run(top)).rows).spf).toMatchObject({ status: "ok", text: `Mailgun may send for ${D} (2 of 10 DNS lookups).` });
    const gone = ownZone();
    delete gone[`dc-2._spfm.${D}`];
    const state = await run(gone);
    expect(byKey(state.rows).spf).toMatchObject({
      status: "bad",
      text: `${D}'s SPF record includes dc-2._spfm.${D}, which has no SPF record, so mail servers treat ${D}'s SPF as broken: your campaign emails and your everyday email fail SPF.`,
    });
    for (const r of state.rows) expect(r.fix ?? "", r.key).not.toContain("v=spf1");
    for (const r of state.rows) for (const rec of r.records) expect(rec.type, r.key).not.toBe("MX");
  });

  it("switching back to app mode: today's rows, replies \"app\", the last good MX cleared; own-mailbox again starts afresh", async () => {
    await run(ownZone());
    await setSetting("mailgun.replies", "app");
    await setSetting("mailgun.fromAddress", null);
    const app = await run(ownZone());
    expect(app.rows.map((r) => r.key)).toEqual([
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
    ]);
    // Today's app-mode rows for this domain: the mx row still wants Mailgun's receiving records (example.com isn't the
    // website domain), and the SPF row reads only the record's own includes.
    expect(byKey(app.rows).mx!.status).toBe("bad");
    expect(byKey(app.rows)["https-links"]!.status).toBe("bad");
    const { raw, parsed } = await stored();
    expect(raw.replies).toBe("app");
    expect("lastGoodMx" in raw).toBe(false);
    expect(parsed.lastGoodMx ?? null).toBeNull();

    // Back in own-mailbox mode, a red first check has no earlier list of its own mode to name.
    await setSetting("mailgun.replies", "own-mailbox");
    await setSetting("mailgun.fromAddress", FROM);
    const bad = ownZone();
    bad[D]!.mx = [];
    const rows = byKey((await run(bad)).rows);
    expect(rows["from-mx"]).toMatchObject({ status: "bad", fix: expect.stringContaining("(its help pages list them)") });
  });

  it("Mailgun not connected: no rows, the reason, and the mode still stored (O36)", async () => {
    const text = "Mailgun isn't set up yet.";
    const state = await runDomainCheck({ mailgun: async () => ({ connected: false, reason: "no-key", text }), fetchImpl: noFetch });
    expect(state).toMatchObject({ domain: null, rows: [], error: text, replies: "own-mailbox" });
    expect((await stored()).raw.replies).toBe("own-mailbox");
  });

  it("the mode changing while the check runs: the stale rows are never written (review SETTING-6, O36)", async () => {
    let flipped = false;
    const [a, b] = [new FakeDns(ownZone()), new FakeDns(ownZone())];
    const txt = a.txt.bind(a);
    a.txt = async (name: string) => {
      if (name === D && !flipped) {
        flipped = true;
        await setSetting("mailgun.replies", "app");
        await setSetting("mailgun.fromAddress", null);
      }
      return txt(name);
    };
    const state = await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: noFetch });
    expect(flipped).toBe(true);
    expect(state.replies).toBe("app");
    expect(state.rows.map((r) => r.key)).toContain("mx");
    expect(state.rows.map((r) => r.key)).not.toContain("from-mx");
  });
});

describe("runDomainCheck in own-mailbox mode, fake mode (no injected DNS)", () => {
  it("a made-up mail provider answers for the sending domain: spf, from-mx and dmarc done, no real resolver", async () => {
    const state = await runDomainCheck({ verify: true, mailgun, fetchImpl: noFetch });
    const rows = byKey(state.rows);
    expect(state.rows.map((r) => r.key)).toEqual(OWN_KEYS);
    expect(rows.spf).toMatchObject({ status: "ok", text: `Mailgun may send for ${D} (4 of 10 DNS lookups).` });
    expect(rows["from-mx"]).toMatchObject({
      status: "ok",
      text: "Mail for example.com goes to your mail provider (mx.mail-provider.invalid), not to Mailgun, so replies reach your inbox. Keep it that way.",
    });
    expect(rows.dmarc!.status).toBe("ok");
    expect(rows.dkim!.status).toBe("ok");
    expect(rows["tracking-cname"]!.status).toBe("ok");
    expect(state.lastGoodMx).toEqual([{ priority: 10, host: "mx.mail-provider.invalid" }]);

    // Mailgun's SPF record not valid yet: the tree carries no Mailgun include, and the row says so.
    mg.fake.setDns(["dkim", "tracking"]);
    try {
      const partial = byKey((await runDomainCheck({ mailgun, fetchImpl: noFetch, now: new Date(Date.now() + 1e9) })).rows);
      expect(partial.spf).toMatchObject({ status: "bad", text: `${D}'s SPF record doesn't include Mailgun, so the app's emails fail SPF.` });
      expect(partial["from-mx"]!.status).toBe("ok");
    } finally {
      mg.fake.setDns("all");
    }
  });
});
