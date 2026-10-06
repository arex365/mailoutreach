import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { addSenderAddress, clearJobs, fastMailgun, healthFetch, makeUser, queuedJobs } from "./helpers";

const t = await createTestDb("mg-apply");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getSecret, setSecret } = await import("@/server/secrets");
const { readTyped } = await import("@/server/state-typed");
const { parseMailgunSetupState } = await import("@/core/system-state-parse");
const apply = await import("@/server/services/mailgun/apply-settings");
const { registerWebhooks, WEBHOOK_TYPES, WEBHOOKS_OK_TEXT, webhookHostNotFoundText } = await import(
  "@/server/services/mailgun/webhooks-setup"
);
const { PUBLIC_ADDRESS_TEXTS } = await import("@/core/mailgun/routes");
const { applySettingsJob } = await import("../../../worker/jobs/mailgun-apply-settings");
type Ctx = Extract<Awaited<ReturnType<typeof fastMailgun>>, { connected: true }>;

const PUB = "http://127.0.0.1:3999";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const HOST = `email.${mg.domain}`;
const previousPub = process.env.APP_PUBLIC_URL;
let ownerId = 0;

async function ctx(): Promise<Ctx> {
  const c = await fastMailgun();
  if (!c.connected) throw new Error(c.text);
  return c;
}

async function run(opts: Partial<Parameters<typeof apply.runApplySettings>[0]> = {}) {
  return apply.runApplySettings({ byUserId: ownerId, mailgun: fastMailgun, fetchImpl: healthFetch(), ...opts });
}

function step(state: { steps: Array<{ key: string; ok: boolean | null; text: string; detail: string | null }> }, key: string) {
  const s = state.steps.find((x) => x.key === key);
  if (!s) throw new Error(`No step ${key}: ${state.steps.map((x) => x.key).join(", ")}`);
  return s;
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  const owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  ownerId = owner.id;
  await addSenderAddress(owner.id, mg.domainId, "arslan");
});

beforeEach(() => {
  mg.fake.reset();
  mg.fake.setDns("all");
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Apply recommended settings", () => {
  it("does every step against Mailgun, records them, then the certificate polls finish with https", async () => {
    await clearJobs();
    await setSecret("mailgun.webhookSigningKey", "key-fake-old", null);
    const state = await run();
    expect(state.steps.map((s) => s.key)).toEqual([
      "public-address",
      "tracking-open",
      "tracking-click",
      "unsubscribe",
      "spam-filter",
      "retention",
      "certificate",
      "https",
      "signing-key",
      "webhooks",
      "routes",
    ]);
    for (const key of ["public-address", "tracking-open", "tracking-click", "unsubscribe", "spam-filter", "retention", "certificate", "signing-key", "webhooks", "routes"]) {
      expect(step(state, key).ok, key).toBe(true);
    }
    expect(step(state, "public-address").text).toBe(`The public address answers: ${PUB}.`);
    // Each step says its own thing: no sentence appears twice in the list.
    expect(step(state, "tracking-open").text).toBe("Open tracking is off.");
    expect(step(state, "tracking-click").text).toBe("Click tracking is off.");
    expect(new Set(state.steps.map((s) => s.text)).size).toBe(state.steps.length);
    expect(step(state, "unsubscribe").text).toBe("Mailgun's unsubscribe handling is on, with its own footers blank.");
    expect(step(state, "retention").text).toBe("Mailgun keeps stored replies for 1 day.");
    expect(step(state, "certificate").text).toBe("Mailgun is preparing the certificate for secure unsubscribe links.");
    expect(step(state, "https")).toMatchObject({ ok: null, text: "Secure unsubscribe links switch on once the certificate is ready." });
    expect(step(state, "webhooks").text).toBe(WEBHOOKS_OK_TEXT);
    expect(step(state, "routes").text).toBe("Reply routes are set up for 1 sender, plus a catch-all.");
    expect(state.certificate).toMatchObject({ host: HOST, status: "processing" });

    // What Mailgun now has.
    const fs = mg.fake.state();
    expect(fs.tracking.open.active).toBe(false);
    expect(fs.tracking.click.active).toBe(false);
    expect(fs.tracking.unsubscribe).toMatchObject({ active: true, htmlFooter: "", textFooter: "" });
    expect(fs.domain).toMatchObject({ spam_action: "tag", message_ttl: 86_400, webhooks_redact_pii: false });
    for (const type of WEBHOOK_TYPES) expect(fs.webhooks[type]).toEqual([EVENTS_URL]);
    const descriptions = fs.routes.map((r) => r.description);
    expect(descriptions).toHaveLength(3);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        `outreach-app:catchall:${mg.domain}`,
        `outreach-app:dmarc:${mg.domain}`,
        expect.stringMatching(/^outreach-app:sender:\d+$/),
      ]),
    );
    expect(fs.signingKeyRegenerated).toBe(0);
    expect(await getSecret("mailgun.webhookSigningKey")).toBe("key-fake-signing");
    expect(mg.fake.requests.some((r) => r.method === "POST" && r.path === "/v5/accounts/http_signing_key")).toBe(false);

    // Stored, logged, and a fresh domain check queued; the first certificate poll waits a minute.
    const stored = (await readTyped("mailgun.setup", parseMailgunSetupState)).value;
    expect(stored.steps.length).toBe(state.steps.length);
    expect(stored.byUserId).toBe(ownerId);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.settingsApplied" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe(`Arslan applied the recommended Mailgun settings to ${mg.domain}: 10 of 11 steps done`);
    expect((await queuedJobs("mailgun.checkDomain")).length).toBe(1);
    const polls = await queuedJobs("mailgun.applySettings");
    expect(polls).toHaveLength(1);
    expect(polls[0]!.payload).toEqual({ step: "certificate-poll", attempt: 1 });
    expect(polls[0]!.activeDedupeKey).toBe("mailgun:cert-poll");
    expect(polls[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Poll 1 (the fake turns the certificate active on its 2nd status call): still processing, the next poll is queued
    // under the same dedupe key.
    await dbWrite((c) => c.job.update({ where: { id: polls[0]!.id }, data: { status: "RUNNING" } }));
    const p1 = await run({ step: "certificate-poll", attempt: 1, jobId: polls[0]!.id });
    expect(p1.certificate?.status).toBe("processing");
    expect(step(p1, "certificate").detail).toBe("Check 1 of 30.");
    const next = await queuedJobs("mailgun.applySettings");
    expect(next).toHaveLength(1);
    expect(next[0]!.payload).toEqual({ step: "certificate-poll", attempt: 2 });

    // Poll 2: active → web_scheme https, read back, the Owner is told.
    const p2 = await run({ step: "certificate-poll", attempt: 2 });
    expect(p2.certificate?.status).toBe("active");
    expect(step(p2, "certificate")).toMatchObject({ ok: true, text: "The certificate for secure unsubscribe links is ready." });
    expect(step(p2, "https")).toMatchObject({ ok: true, text: "Unsubscribe links use https." });
    expect(p2.steps.map((s) => s.key)).toEqual(state.steps.map((s) => s.key));
    expect(mg.fake.state().tracking.webScheme).toBe("https");
    const note = await db.notification.findFirstOrThrow({ where: { type: "system.mailgun", title: "Secure unsubscribe links are ready" } });
    expect(note.userId).toBe(ownerId);
  });

  it("Mailgun keeping its own footers turns the unsubscribe step red, with the click path", async () => {
    mg.fake.setSwitches({ ignoreEmptyFooters: true });
    const state = await run();
    expect(step(state, "unsubscribe")).toMatchObject({ ok: false, text: apply.APPLY_TEXTS.footersKept });
    expect(step(state, "unsubscribe").detail).toContain("unsubscribe_url");
  });

  it("the certificate: CNAME not valid yet, Mailgun's 400, the basic plan's 402, and an active one", async () => {
    mg.fake.setDns(["spf", "dkim", "mx"]);
    let state = await run();
    expect(step(state, "certificate")).toMatchObject({ ok: false, text: `Mailgun can't check ${HOST} yet. Fix the 'Unsubscribe links work' row first.` });
    expect(state.certificate?.status).toBe("cname-missing");
    expect(step(state, "https")).toMatchObject({ ok: null, text: apply.APPLY_TEXTS.httpsNeedsCert });

    mg.fake.setDns("all");
    mg.fake.failNext("POST /v2/x509/:host", { kind: "status", status: 400, body: { Reason: "invalid CNAME record" } });
    state = await run();
    expect(step(state, "certificate").text).toBe(`Mailgun can't check ${HOST} yet. Fix the 'Unsubscribe links work' row first.`);

    mg.fake.failNext("POST /v2/x509/:host", { kind: "status", status: 402, body: { Reason: "upgrade your account to enable this feature" } });
    state = await run();
    expect(step(state, "certificate")).toMatchObject({ ok: false, text: apply.APPLY_TEXTS.certNotInPlan });
    expect(state.certificate?.status).toBe("not-in-plan");

    // Already active (the fake turns it active on the 2nd status call): no new certificate, straight to https.
    mg.fake.reset();
    mg.fake.setDns("all");
    const c = await ctx();
    await c.client.startCertificate(HOST);
    for (let i = 0; i < 2; i++) await c.client.getCertificateStatus(HOST);
    const starts = mg.fake.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v2/x509/")).length;
    state = await run();
    expect(mg.fake.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v2/x509/")).length).toBe(starts);
    expect(step(state, "certificate")).toMatchObject({ ok: true, text: apply.APPLY_TEXTS.certReady });
    expect(step(state, "https")).toMatchObject({ ok: true, text: apply.APPLY_TEXTS.httpsOn });
    expect(new Set(state.steps.map((s) => s.text)).size).toBe(state.steps.length);
  });

  it("Mailgun can't find the domain: the reason once, the steps that need the domain wait", async () => {
    mg.fake.failNext("GET /v4/domains/:d", { kind: "status", status: 404, body: { message: "Domain not found" } }, 10);
    const state = await run();
    const failed = state.steps.filter((s) => s.ok === false);
    expect(failed.map((s) => s.key)).toEqual(["tracking-open"]);
    expect(failed[0]!.text).not.toBe("");
    for (const key of ["tracking-click", "unsubscribe", "spam-filter", "retention", "certificate", "https", "webhooks", "routes"]) {
      expect(step(state, key), key).toMatchObject({ ok: null, text: "Skipped until Mailgun finds the domain." });
    }
    expect(step(state, "signing-key").ok).toBe(true);
  });

  it("a certificate poll for another domain's host (queued before a domain change) stops without calling Mailgun", async () => {
    await clearJobs();
    const { setState } = await import("@/server/state");
    await setState("mailgun.setup", {
      runAt: new Date().toISOString(),
      byUserId: ownerId,
      jobId: 3,
      steps: [{ key: "certificate", ok: true, text: apply.APPLY_TEXTS.certPreparing, detail: null, at: new Date().toISOString() }],
      certificate: { host: "email.old.example.com", status: "processing", startedAt: new Date().toISOString(), lastPolledAt: null, error: null },
    });
    const state = await run({ step: "certificate-poll", attempt: 4 });
    expect(mg.fake.requests.filter((r) => r.path.startsWith("/v2/x509/") || r.path.startsWith("/v4/domains"))).toEqual([]);
    expect(state).toEqual(apply.EMPTY_SETUP_STATE);
    expect((await readTyped("mailgun.setup", parseMailgunSetupState)).value).toEqual(apply.EMPTY_SETUP_STATE);
    expect(await queuedJobs("mailgun.applySettings")).toHaveLength(0);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);

    // Nothing on record (the domain change cleared it): nothing to poll either.
    const again = await run({ step: "certificate-poll", attempt: 5 });
    expect(again.certificate).toBeNull();
    expect(mg.fake.requests).toEqual([]);

    expect(apply.certificateHostFits(`email.${mg.domain}`, mg.domain)).toBe(true);
    expect(apply.certificateHostFits("email.old.example.com", mg.domain)).toBe(false);
    expect(apply.certificateHostFits(`email.x${mg.domain}`, mg.domain)).toBe(false);
    expect(apply.setupFitsDomain({ ...apply.EMPTY_SETUP_STATE, steps: state.steps }, mg.domain)).toBe(true);
  });

  it("reply routes Mailgun can't confirm yet: the routes step isn't green, and a route sync is queued to try again", async () => {
    await clearJobs();
    await addSenderAddress(ownerId, mg.domainId, "arslan.new");
    // /routes/match doesn't find the senders' routes yet (the older, working address first: it stays ok).
    mg.fake.failNext("GET /v3/routes/match", { kind: "status", status: 404, body: { message: "Route not found" } }, 2);
    const state = await run();
    expect(step(state, "routes").ok).toBe(false);
    expect(step(state, "routes").text).toContain(`Couldn't confirm the reply route for arslan.new@${mg.domain} yet.`);
    const sync = await queuedJobs("mailgun.syncRoutes");
    expect(sync).toHaveLength(1);
    expect(sync[0]!.activeDedupeKey).toBe("mailgun:routes");
    expect(sync[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("the signing key: a different saved one is replaced; a missing one is explained", async () => {
    await setSecret("mailgun.webhookSigningKey", "key-fake-something-else", null);
    let state = await run();
    expect(step(state, "signing-key")).toMatchObject({ ok: true, text: "Webhook signing key saved." });
    expect(await getSecret("mailgun.webhookSigningKey")).toBe("key-fake-signing");
    mg.fake.failNext("GET /v5/accounts/http_signing_key", { kind: "status", status: 400, body: { message: "could not get HSK for account" } });
    state = await run();
    expect(step(state, "signing-key")).toMatchObject({ ok: false, text: apply.APPLY_TEXTS.signingKeyMissing });
  });

  it("the public address: http outside fake mode is refused and webhooks and routes are skipped", async () => {
    const before = mg.fake.requests.length;
    process.env.APP_PUBLIC_URL = "http://outreach.example.com";
    try {
      const state = await run({ mailgun: async () => ({ ...(await ctx()), fakeMode: false }) });
      expect(step(state, "public-address")).toMatchObject({ ok: false, text: PUBLIC_ADDRESS_TEXTS.notHttps });
      expect(step(state, "webhooks")).toMatchObject({ ok: null, text: "Skipped until the public address works." });
      expect(step(state, "routes")).toMatchObject({ ok: null, text: "Skipped until the public address works." });
      const hookCalls = mg.fake.requests.slice(before).filter((r) => r.path.includes("/webhooks") || r.path.startsWith("/v3/routes"));
      expect(hookCalls).toEqual([]);
    } finally {
      process.env.APP_PUBLIC_URL = PUB;
    }
  });

  it("the public address must answer with the app's own health check (a login page doesn't count)", async () => {
    let state = await run({ fetchImpl: healthFetch({ status: 302, body: "", location: "https://team.cloudflareaccess.com/login" }) });
    expect(step(state, "public-address")).toMatchObject({
      ok: false,
      text: `The app's public address doesn't answer yet (${PUB}/api/health). Finish the Cloudflare guide, check it on your phone, then try again.`,
    });
    expect(step(state, "public-address").detail).toContain("302");
    expect(step(state, "webhooks").ok).toBeNull();
    state = await run({ fetchImpl: healthFetch({ body: "<html>Hello</html>" }) });
    expect(step(state, "public-address").ok).toBe(false);
  });

  it("the job: runs Apply and says how many steps are done; not connected fails plainly", async () => {
    const out = (await applySettingsJob.handler(
      { step: "all" },
      { jobId: 1, createdById: ownerId, signal: new AbortController().signal, progress: async () => undefined },
    )) as { summary: string };
    // The default fetch can't reach the test's public address, so webhooks and routes wait.
    expect(out.summary).toMatch(/^\d+ of \d+ steps done\. Open the Domain checklist to see what's left\.$/);
    await dbWrite((c) => c.setting.update({ where: { key: "mailgun.domain" }, data: { value: null as never } }));
    try {
      await expect(
        applySettingsJob.handler({}, { jobId: 2, createdById: ownerId, signal: new AbortController().signal, progress: async () => undefined }),
      ).rejects.toThrow("Mailgun isn't connected yet. Open Settings › Sending & Mailgun.");
    } finally {
      await dbWrite((c) => c.setting.update({ where: { key: "mailgun.domain" }, data: { value: mg.domain } }));
    }
    expect(applySettingsJob.failureNotice?.({ step: "certificate-poll" }, "Mailgun didn't answer.").title).toBe(
      "The certificate check didn't finish",
    );
  });
});

describe("registerWebhooks", () => {
  it("creates the webhook for the five types when there is none", async () => {
    const res = await registerWebhooks(await ctx(), EVENTS_URL);
    expect(res).toMatchObject({ ok: true, text: WEBHOOKS_OK_TEXT });
    expect(mg.fake.requests.filter((r) => r.path.endsWith("/webhooks")).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(Object.keys(mg.fake.state().webhooks).sort()).toEqual([...WEBHOOK_TYPES].sort());
  });

  it("replaces the types with PUT when the URL is registered for others", async () => {
    const c = await ctx();
    await c.client.createWebhook(mg.domain, EVENTS_URL, ["delivered", "opened"]);
    const res = await registerWebhooks(c, EVENTS_URL);
    expect(res.ok).toBe(true);
    const hooks = mg.fake.state().webhooks;
    expect(hooks.opened ?? []).not.toContain(EVENTS_URL);
    for (const type of WEBHOOK_TYPES) expect(hooks[type]).toEqual([EVENTS_URL]);
    expect(mg.fake.requests.some((r) => r.method === "PUT" && r.path.endsWith("/webhooks"))).toBe(true);
  });

  it("a POST that says 'already exists' becomes a PUT, and a PUT that says 'not found' becomes a POST", async () => {
    const c = await ctx();
    await c.client.createWebhook(mg.domain, EVENTS_URL, ["delivered"]);
    // Mailgun's GET forgets it: POST gets "already exists" → PUT.
    mg.fake.failNext("GET /v3/domains/:d/webhooks", { kind: "status", status: 200, body: { webhooks: {} } });
    let res = await registerWebhooks(c, EVENTS_URL);
    expect(res.ok).toBe(true);
    const methods = mg.fake.requests.filter((r) => r.path.endsWith("/webhooks") && r.method !== "GET").map((r) => r.method);
    expect(methods).toEqual(["POST", "POST", "PUT"]);

    mg.fake.reset();
    // Mailgun's GET claims it: PUT gets 404 → POST.
    mg.fake.failNext("GET /v3/domains/:d/webhooks", { kind: "status", status: 200, body: { webhooks: { delivered: { urls: [EVENTS_URL] } } } });
    res = await registerWebhooks(c, EVENTS_URL);
    expect(res.ok).toBe(true);
    expect(mg.fake.requests.filter((r) => r.path.endsWith("/webhooks") && r.method !== "GET").map((r) => r.method)).toEqual(["PUT", "POST"]);
    for (const type of WEBHOOK_TYPES) expect(mg.fake.state().webhooks[type]).toEqual([EVENTS_URL]);
  });

  it("removes the app's old address (same path, other host), also when Mailgun answers with the legacy url field", async () => {
    const c = await ctx();
    const old = "https://old-tunnel.example.com/api/webhooks/mailgun/events";
    await c.client.createWebhook(mg.domain, old, [...WEBHOOK_TYPES]);
    mg.fake.setSwitches({ legacyUrlField: true });
    const res = await registerWebhooks(c, EVENTS_URL);
    mg.fake.setSwitches({ legacyUrlField: false });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain(old);
    const hooks = mg.fake.state().webhooks;
    expect(Object.values(hooks).flat()).not.toContain(old);
    for (const type of WEBHOOK_TYPES) expect(hooks[type]).toEqual([EVENTS_URL]);
  });

  it("leaves other people's webhooks alone", async () => {
    const c = await ctx();
    await c.client.createWebhook(mg.domain, "https://crm.example.com/hook", ["delivered"]);
    const res = await registerWebhooks(c, EVENTS_URL);
    expect(res).toMatchObject({ ok: true, detail: null });
    expect(mg.fake.state().webhooks.delivered).toEqual(["https://crm.example.com/hook", EVENTS_URL]);
  });

  it("explains a public address Mailgun can't resolve", async () => {
    const url = "https://outreach.example.com/api/webhooks/mailgun/events";
    mg.fake.failNext("POST /v4/domains/:d/webhooks", {
      kind: "status",
      status: 400,
      body: { Reason: `${url} is not a valid url: host not found` },
    });
    const res = await registerWebhooks(await ctx(), url);
    expect(res).toMatchObject({ ok: false, text: webhookHostNotFoundText("outreach.example.com") });
    expect(res.text).toBe("Mailgun can't find outreach.example.com yet. Finish the Cloudflare guide so the public address works, then try again.");
  });
});
