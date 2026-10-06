import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, setSetting, setState } from "../mail-events/seed";
import { FakeDns, goodZone, type FakeZone } from "../../unit/checks/fake-dns";

const t = await createTestDb("domain-check");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { FROM_CHANGE_RERUNS, runDomainCheck } = await import("@/server/services/checks/domain-check");
const { getPauseState } = await import("@/server/services/sending/pause");
const { handleEventWebhook } = await import("@/server/services/mail-events/webhook");
const { checkDomainJob } = await import("../../../worker/jobs/mailgun-check-domain");
type ChecklistRow = import("@/core/system-state").ChecklistRow;

const D = mg.domain;
const PUB = "http://127.0.0.1:3100";
const HOOK = `${PUB}/api/webhooks/mailgun/events`;
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const previousPub = process.env.APP_PUBLIC_URL;

/** Answers the public-address checks like the app would (health JSON, the webhook handler itself). */
const appFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/api/health")) return Response.json({ ok: true, database: "ok", workerLastSeen: null, time: new Date().toISOString() });
  if (url.endsWith("/api/webhooks/mailgun/events")) return handleEventWebhook(new Request(url, init));
  return new Response("not found", { status: 404 });
};

function lookups(a: FakeZone, b: FakeZone = a): [FakeDns, FakeDns] {
  return [new FakeDns(a), new FakeDns(b)];
}

function byKey(list: ChecklistRow[]) {
  return Object.fromEntries(list.map((r) => [r.key, r]));
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  const owner = await makeOwner("Arslan", "arslan@polygonparadise.test");
  // What "Apply recommended settings" leaves behind, set up directly on the fake.
  mg.fake.setDns("all");
  mg.fake.setMonthlyLimit({ limit: 30_000, current: 1_234 });
  const ctx = await mailgun();
  if (!ctx.connected) throw new Error(ctx.text);
  await ctx.client.setOpenTracking(D, false);
  await ctx.client.setClickTracking(D, false);
  await ctx.client.setUnsubscribeTracking(D, true, { html: "", text: "" });
  await ctx.client.updateDomain(D, { spam_action: "tag" });
  await ctx.client.createWebhook(D, HOOK, ["delivered", "permanent_fail", "temporary_fail", "complained", "unsubscribed"]);
  await ctx.client.startCertificate(`email.${D}`);
  while ((await ctx.client.getCertificateStatus(`email.${D}`)).status !== "active") {
    /* the fake turns it active after a couple of polls */
  }
  await ctx.client.updateDomain(D, { web_scheme: "https" });
  await dbWrite(async (c) => {
    await c.senderAddress.create({
      data: { userId: owner.id, domainId: mg.domainId, localPart: "arslan", address: `arslan@${D}`, routeStatus: "ok", forwardTo: "arslan.inbox@gmail.com" },
    });
    await c.sendingDomain.update({ where: { id: mg.domainId }, data: { catchAllRouteId: "route-catchall" } });
  });
  await setSetting("mailgun.unsubscribeTest", { setup: "A", status: "passed", domain: D, mailboxes: [], headersOk: true, decidedAt: "2026-09-20T10:00:00Z", decidedById: owner.id, note: null });
  await setSetting("mailgun.domainRegisteredOn", "2026-06-01");
});

beforeEach(async () => {
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["domain.check", "sending.pause", "notices"] } } }));
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("runDomainCheck against the fake Mailgun and a fake DNS table", () => {
  it("shows every row done when everything is set up, and stores the rows", async () => {
    const state = await runDomainCheck({ verify: true, lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
    expect(state).toMatchObject({ domain: D, region: "EU", error: null, checkedAt: expect.any(String), lastVerifyAt: expect.any(String) });
    const notOk = state.rows.filter((r) => r.status !== "ok").map((r) => `${r.key}: ${r.status} ${r.text}`);
    expect(notOk).toEqual([]);
    expect(state.rows).toHaveLength(20);
    const stored = (await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } })).value as { rows: unknown[] };
    expect(stored.rows).toHaveLength(20);
    // The public-address check had never run, so the check ran it (through the app's own handlers).
    const tunnel = (await db.systemState.findUniqueOrThrow({ where: { key: "tunnel.status" } })).value as Record<string, { ok: boolean } | null>;
    expect(tunnel.publicCheck?.ok).toBe(true);
    expect(tunnel.webhookPathCheck?.ok).toBe(true);
  });

  it("reads NXDOMAIN, NODATA, timeouts, split chunks, a proxied CNAME and an inherited DMARC", async () => {
    const a = goodZone(D);
    delete a[D]!.txt; // NXDOMAIN for the TXT records on one resolver…
    a[`email.${D}`] = { a: ["104.21.5.5"] }; // …a proxied tracking CNAME (NODATA for CNAME, A answers)
    delete a[`_dmarc.${D}`];
    a["_dmarc.example.com"] = { txt: [["v=DMARC1; p=quar", "antine"]] }; // split chunks, on the parent
    const b = { ...a, [D]: { ...a[D], txt: "timeout" as const } };
    const rows = byKey((await runDomainCheck({ lookups: lookups(a, b), mailgun, fetchImpl: appFetch })).rows);
    expect(rows.spf).toMatchObject({ status: "unknown", text: "Couldn't check right now." });
    expect(rows["tracking-cname"]).toMatchObject({ status: "bad", text: `email.${D} is proxied (orange cloud).` });
    expect(rows.dmarc).toMatchObject({ status: "ok", text: `No record on ${D}; using example.com's policy: quarantine.` });
    expect(rows.dkim.status).toBe("ok");
    expect(rows.postmaster.status).toBe("info");
  });

  it("reads two SPF records, two DMARC records, a doubled name and reports sent elsewhere", async () => {
    const z = goodZone(D);
    z[D]!.txt = ["v=spf1 include:eu.mailgun.org ~all", "v=spf1 include:zoho.com ~all"];
    z[`_dmarc.${D}`] = { txt: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] };
    delete z[`email.${D}`];
    z[`email.${D}.example.com`] = { cname: ["eu.mailgun.org"] };
    const rows = byKey((await runDomainCheck({ lookups: lookups(z), mailgun, fetchImpl: appFetch })).rows);
    expect(rows.spf).toMatchObject({ status: "bad", text: "You have 2 SPF records; mail servers ignore all of them." });
    expect(rows.dmarc).toMatchObject({ status: "bad", text: "Two DMARC records cancel each other." });
    expect(rows["tracking-cname"]).toMatchObject({ status: "bad", fix: "Edit it and type only email.send in the Name box." });

    const r = goodZone(D);
    r[`_dmarc.${D}`] = { txt: ["v=DMARC1; p=none; rua=mailto:reports@dmarc-reports.io"] };
    const rows2 = byKey((await runDomainCheck({ lookups: lookups(r), mailgun, fetchImpl: appFetch })).rows);
    expect(rows2.dmarc).toMatchObject({ status: "warn", text: "Reports to dmarc-reports.io will be dropped (that domain hasn't agreed to receive them)." });
    r[`${D}._report._dmarc.dmarc-reports.io`] = { txt: ["v=DMARC1"] };
    const rows3 = byKey((await runDomainCheck({ lookups: lookups(r), mailgun, fetchImpl: appFetch })).rows);
    expect(rows3.dmarc.status).toBe("ok");
  });

  it("reads Mailgun's settings back from the fake: tracking, webhooks, the monthly limit", async () => {
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    await ctx.client.setClickTracking(D, true);
    await ctx.client.deleteWebhook(D, HOOK);
    mg.fake.setMonthlyLimit(null);
    try {
      const rows = byKey((await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch })).rows);
      expect(rows["tracking-off"]).toMatchObject({ status: "bad", text: "Click tracking is on in Mailgun, so it changes your emails." });
      expect(rows.webhooks).toMatchObject({ status: "bad" });
      expect(rows["monthly-limit"]).toMatchObject({ status: "warn" });
    } finally {
      await ctx.client.setClickTracking(D, false);
      await ctx.client.createWebhook(D, HOOK, ["delivered", "permanent_fail", "temporary_fail", "complained", "unsubscribed"]);
      mg.fake.setMonthlyLimit({ limit: 30_000, current: 1_234 });
    }
  });

  it("turns the reply-routes row red when a reply inbox is on Mailgun's bounce list", async () => {
    mg.fake.addSuppression("bounces", "arslan.inbox@gmail.com");
    try {
      const rows = byKey((await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch })).rows);
      expect(rows["reply-routes"]).toMatchObject({
        status: "bad",
        text: "Mailgun won't forward replies to arslan.inbox@gmail.com: it's on Mailgun's bounce list.",
        fix: "Remove it in Settings › Deliverability.",
      });
    } finally {
      const ctx = await mailgun();
      if (ctx.connected) await ctx.client.deleteSuppression(D, "bounces", "arslan.inbox@gmail.com");
    }
  });

  it("asks Mailgun to re-check the records at most once a minute", async () => {
    mg.fake.requests.length = 0;
    const now = new Date();
    await runDomainCheck({ verify: true, now, lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
    await runDomainCheck({ verify: true, now: new Date(now.getTime() + 30_000), lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
    expect(mg.fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/verify"))).toHaveLength(1);
    await runDomainCheck({ verify: true, now: new Date(now.getTime() + 61_000), lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
    expect(mg.fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/verify"))).toHaveLength(2);
  });

  it("pauses sending when Mailgun can't find the domain (404 after the one retry)", async () => {
    await setSetting("mailgun.domain", "unknown.example.com");
    try {
      const state = await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
      expect(byKey(state.rows)["mailgun-domain"]).toMatchObject({ status: "bad" });
      const pause = await getPauseState();
      expect(pause).toMatchObject({ paused: true, kind: "mailgun-domain", reason: "Mailgun can't find unknown.example.com" });
      expect(pause.fixText).toBe(
        "Mailgun can't find unknown.example.com in the EU region. If you created the domain in the US region, change Region to US.",
      );
      expect(mg.fake.requests.filter((r) => r.path === "/v4/domains/unknown.example.com").length).toBeGreaterThanOrEqual(2);
    } finally {
      await setSetting("mailgun.domain", D);
    }
  });

  it("writes no rows and the reason when Mailgun isn't connected; the job records its task", async () => {
    await setSetting("practice.copy", true);
    try {
      const state = await runDomainCheck({ lookups: lookups(goodZone(D)) });
      expect(state).toMatchObject({ domain: null, rows: [], error: "The practice copy never talks to Mailgun." });
      const res = await checkDomainJob.handler({}, { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined });
      expect((res as { summary: string }).summary).toBe("The practice copy never talks to Mailgun.");
      expect(await db.systemState.findUnique({ where: { key: "task.mailgun.domainCheck.6h" } })).not.toBeNull();
    } finally {
      await setSetting("practice.copy", false);
    }
  });

  it("ignores a certificate Apply recorded for the old domain's host (SETUP-08)", async () => {
    const setup = (host: string) => ({
      runAt: "2026-09-20T10:00:00.000Z",
      byUserId: null,
      jobId: null,
      steps: [],
      certificate: { host, status: "not-in-plan", startedAt: null, lastPolledAt: null, error: null },
    });
    const NOT_IN_PLAN = "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.";
    try {
      // An Apply run for the old domain that finished after the domain change.
      await setState("mailgun.setup", setup("email.old-domain.example"));
      let rows = byKey((await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch })).rows);
      expect(rows["https-links"]).toMatchObject({ status: "ok" });
      // The same answer for this domain's own host still counts.
      await setState("mailgun.setup", setup(`email.${D}`));
      rows = byKey((await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch })).rows);
      expect(rows["https-links"]).toMatchObject({ status: "bad", text: NOT_IN_PLAN });
    } finally {
      await dbWrite((c) => c.systemState.deleteMany({ where: { key: "mailgun.setup" } }));
    }
  });

  it("warns once when the tracking certificate expired", async () => {
    mg.fake.expireCertificate();
    await setState("notices", {});
    const rows = byKey((await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch })).rows);
    expect(rows["https-links"]).toMatchObject({ status: "bad", text: "The certificate for secure unsubscribe links has expired." });
    await runDomainCheck({ lookups: lookups(goodZone(D)), mailgun, fetchImpl: appFetch });
    expect(await db.notification.count({ where: { title: "Secure unsubscribe links stopped working" } })).toBe(1);
  });
});

describe("runDomainCheck with a shared From address (SHARED-FROM-DESIGN §5, F27)", () => {
  const FROM = "contact@example.com";
  /** The sending domain's records plus the From domain's own: a mail provider's MX and SPF, and its DMARC record. */
  function teamZone(): FakeZone {
    const z = goodZone(D);
    z["example.com"] = { mx: [{ priority: 10, exchange: "mx.provider.example" }], txt: ["v=spf1 include:_spf.provider.example ~all"] };
    z["_spf.provider.example"] = { txt: ["v=spf1 ip4:192.0.2.20 ~all"] };
    z["_dmarc.example.com"] = { txt: ["v=DMARC1; p=none"] };
    return z;
  }
  const run = (zone: FakeZone, mg2: typeof mailgun = mailgun) => runDomainCheck({ lookups: lookups(zone), mailgun: mg2, fetchImpl: appFetch });
  let testBefore: unknown;

  beforeAll(async () => {
    testBefore = (await db.setting.findUnique({ where: { key: "mailgun.unsubscribeTest" } }))?.value;
    // The previous test expired the tracking certificate: renew it, so only the From address makes a difference here.
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    await ctx.client.startCertificate(`email.${D}`);
    while ((await ctx.client.getCertificateStatus(`email.${D}`)).status !== "active") {
      /* the fake turns it active after a couple of polls */
    }
  });
  beforeEach(async () => {
    await setSetting("mailgun.fromAddress", FROM);
    await setSetting("mailgun.unsubscribeTest", testBefore);
    mg.fake.requests.length = 0;
  });
  afterAll(async () => {
    await setSetting("mailgun.fromAddress", null);
    await setSetting("mailgun.unsubscribeTest", testBefore);
  });

  it("adds the From domain's rows after DMARC, green, titled with the From domain; DMARC and DKIM speak of the From address", async () => {
    const state = await run(teamZone());
    expect(state.rows).toHaveLength(22);
    const keys = state.rows.map((r) => r.key);
    expect(keys.slice(keys.indexOf("dmarc"), keys.indexOf("dmarc") + 3)).toEqual(["dmarc", "from-mx", "from-spf"]);
    const rows = byKey(state.rows);
    expect(rows["from-mx"]).toMatchObject({
      status: "ok",
      title: "Mail for example.com stays with your mail provider (MX)",
      text: "Mail for example.com goes to your mail provider (mx.provider.example), not to Mailgun. Keep it that way.",
    });
    expect(rows["from-spf"]).toMatchObject({
      status: "ok",
      title: "example.com's SPF record (your everyday email)",
      text: `example.com's SPF record is fine (1 of 10 DNS lookups). The app's emails don't use it; they use ${D}'s.`,
    });
    expect(rows.dmarc).toMatchObject({ status: "ok", text: "example.com's policy: monitor only. Right for now." });
    expect(rows.dkim.status).toBe("ok");
    expect(rows.dkim.text).toContain(`It fits your From address ${FROM}: same main domain.`);
    // The stored pass has no From address (per-person): it doesn't count for contact@.
    expect(rows["reply-test"]).toMatchObject({ status: "warn", text: `Not tested yet with the From address ${FROM}. Live campaigns start once this passes.` });
    expect(rows.postmaster.text).toBe("Optional: see how Gmail rates example.com, the domain in your From address.");
    // Every other row is as green as in per-person mode.
    const notOk = state.rows.filter((r) => r.status !== "ok" && !["reply-test", "postmaster"].includes(r.key)).map((r) => `${r.key}: ${r.text}`);
    expect(notOk).toEqual([]);
    // The From domain is never a Mailgun domain: no request path names it.
    expect(mg.fake.requests.filter((r) => /\/example\.com(\/|$)/.test(r.path))).toEqual([]);
  });

  it("a Mailgun MX on the From domain: from-mx red, and the Owner hears once a day", async () => {
    const z = teamZone();
    z["example.com"]!.mx = [{ priority: 10, exchange: "mxa.mailgun.org" }, { priority: 10, exchange: "mxb.mailgun.org" }];
    const rows = byKey((await run(z)).rows);
    expect(rows["from-mx"]).toMatchObject({ status: "bad", text: expect.stringContaining("example.com's mail servers (MX) point to Mailgun.") });
    await run(z);
    const notes = await db.notification.findMany({ where: { title: "Mail for example.com goes to the wrong place" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "system.mailgun",
      link: "/settings/domain",
      body: "example.com's mail servers (MX) point to Mailgun or are missing, so your everyday email and forwarded replies can be lost. Live campaign emails wait until it's fixed. Open Settings › Domain checklist.",
    });
  });

  it("a second SPF record on the From domain: from-spf red, and one notice with the row's sentence", async () => {
    const z = teamZone();
    z["example.com"]!.txt = ["v=spf1 include:_spf.provider.example ~all", "v=spf1 include:mailgun.org ~all"];
    const rows = byKey((await run(z)).rows);
    const text = "example.com has 2 SPF records, so mail servers ignore all of them. This affects your everyday email.";
    expect(rows["from-spf"]).toMatchObject({ status: "bad", text });
    await run(z);
    const notes = await db.notification.findMany({ where: { title: "example.com's SPF record is broken" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(`${text} Open Settings › Domain checklist.`);
  });

  it("an included record that vanished on both resolvers is red; a healthy row sends nothing", async () => {
    const z = teamZone();
    delete z["_spf.provider.example"];
    expect(byKey((await run(z)).rows)["from-spf"]).toMatchObject({
      status: "bad",
      text: "example.com's SPF record includes _spf.provider.example, which has no SPF record, so mail servers treat example.com's SPF as broken. This affects your everyday email.",
    });
    const before = await db.notification.count();
    await setState("notices", {});
    await run(teamZone());
    expect(await db.notification.count()).toBe(before);
  });

  it("a saved From address that no longer fits: from-mx red with the misfit sentence, no MX notice, no From-domain DNS asked", async () => {
    await setSetting("mailgun.fromAddress", "contact@other.test");
    const [a, b] = lookups(teamZone());
    const state = await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: appFetch });
    const rows = byKey(state.rows);
    expect(rows["from-mx"]).toMatchObject({
      status: "bad",
      title: "Mail for other.test stays with your mail provider (MX)",
      text: `The From address contact@other.test doesn't fit your sending domain ${D}. Change or clear it in Settings › Sending & Mailgun.`,
    });
    expect(a.asked.filter((q) => q.includes("other.test"))).toEqual([]);
    expect(await db.notification.count({ where: { title: "Mail for other.test goes to the wrong place" } })).toBe(0);
  });

  /** Resolvers whose first resolver runs `onSendingDomainTxt` before each TXT lookup of the sending domain (mid-check). */
  function hookedLookups(zone: FakeZone, onSendingDomainTxt: () => Promise<void>): [FakeDns, FakeDns] {
    const [a, b] = lookups(zone);
    const txt = a.txt.bind(a);
    a.txt = async (name: string) => {
      if (name === D) await onSendingDomainTxt();
      return txt(name);
    };
    return [a, b];
  }

  it("the From address cleared while the check runs: rows for per-person mode are written, never the stale ones (review SETTING-6)", async () => {
    let cleared = false;
    const [a, b] = hookedLookups(teamZone(), async () => {
      if (cleared) return;
      cleared = true; // the Owner clears the From address after the check read it
      await setSetting("mailgun.fromAddress", null);
    });
    const state = await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: appFetch });
    expect(cleared).toBe(true);
    // The check ran again: the sending domain's TXT was asked once per round.
    expect(a.asked.filter((q) => q === `TXT ${D}`)).toHaveLength(2);
    expect(state.rows.map((r) => r.key)).not.toContain("from-mx");
    expect(state.rows).toHaveLength(20);
    const stored = (await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } })).value as { rows: ChecklistRow[] };
    expect(stored.rows.map((r) => r.key)).not.toContain("from-mx");
    expect(byKey(stored.rows).dmarc!.text).toBe("Policy found: monitor only. Right for now.");
  });

  it("the From address set while the check runs: the from-mx row is there (no stale per-person rows)", async () => {
    await setSetting("mailgun.fromAddress", null);
    let set = false;
    const [a, b] = hookedLookups(teamZone(), async () => {
      if (set) return;
      set = true;
      await setSetting("mailgun.fromAddress", FROM);
    });
    const state = await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: appFetch });
    expect(byKey(state.rows)["from-mx"]).toMatchObject({ status: "ok" });
    expect(state.rows).toHaveLength(22);
  });

  it("a From address that keeps changing: at most FROM_CHANGE_RERUNS more rounds, then the last one is written", async () => {
    let flips = 0;
    const [a, b] = hookedLookups(teamZone(), async () => {
      flips += 1;
      await setSetting("mailgun.fromAddress", flips % 2 === 1 ? "hello@example.com" : FROM);
    });
    const state = await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: appFetch });
    expect(FROM_CHANGE_RERUNS).toBe(2);
    expect(a.asked.filter((q) => q === `TXT ${D}`)).toHaveLength(1 + FROM_CHANGE_RERUNS);
    expect(state.rows.map((r) => r.key)).toContain("from-mx");
  });

  it("an unchanged From address: one round only", async () => {
    const [a, b] = lookups(teamZone());
    await runDomainCheck({ lookups: [a, b], mailgun, fetchImpl: appFetch });
    expect(a.asked.filter((q) => q === `TXT ${D}`)).toHaveLength(1);
  });

  it("Mailgun lists no DKIM record: the pasted original of today's From settles the DKIM row; another From's doesn't", async () => {
    const noDkim = async () => {
      const ctx = await mailgun();
      if (!ctx.connected) return ctx;
      const getDomain = ctx.client.getDomain.bind(ctx.client);
      ctx.client.getDomain = async (d: string) => {
        const info = await getDomain(d);
        return { ...info, sending: info.sending.filter((r) => !/\._domainkey\./i.test(r.name ?? "")) };
      };
      return ctx;
    };
    const original = (from: string) => ({
      domain: D,
      from,
      address: "tess@outlook.com",
      testSendId: 1,
      returnPathDomain: D,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: "example.com",
      mailtoDomain: null,
      mailtoOk: true,
      readAt: new Date().toISOString(),
    });
    const test = { setup: "A", status: "untested", domain: null, mailboxes: [], headersOk: null, decidedAt: null, decidedById: null, note: null };
    await setSetting("mailgun.unsubscribeTest", { ...test, original: original(FROM) });
    expect(byKey((await run(teamZone(), noDkim)).rows).dkim).toMatchObject({
      status: "ok",
      text: `Mailgun doesn't list a DKIM record for ${D}, but the reply test's email was signed by example.com (dkim=pass), which fits your From address.`,
    });
    await setSetting("mailgun.unsubscribeTest", { ...test, original: original("hello@example.com") });
    expect(byKey((await run(teamZone(), noDkim)).rows).dkim).toMatchObject({
      status: "unknown",
      text: `Mailgun didn't list a DKIM record for ${D}. With a From address, example.com usually signs your emails.`,
    });
  });
});
