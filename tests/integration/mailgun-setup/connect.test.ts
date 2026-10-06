import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { addSenderAddress, clearJobs, closedPort, makeUser, queuedJobs } from "./helpers";

const t = await createTestDb("mg-connect");
const { db, dbWrite } = await import("@/server/db");
const { getSecret, secretInfo, setSecret } = await import("@/server/secrets");
const { getSetting, setSetting } = await import("@/server/settings");
const connect = await import("@/server/services/mailgun/connect");
const { AUTH_TEXT, NETWORK_TEXT } = await import("@/server/mailgun/errors");
const { SENDING_DOMAIN_TEXTS } = await import("@/core/sender-address");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parseMailgunSetupState } = await import("@/core/system-state-parse");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");

const deps = { retryDelayMs: () => 0 };
const DOMAIN = "send.example.com";
let fake: FakeMailgun;
let fakeUs: FakeMailgun;
let fakeNew: FakeMailgun;
let owner: { id: number; name: string };
const previousBase = process.env.OUTREACH_MAILGUN_BASE_URL;

beforeAll(async () => {
  fake = await startFakeMailgun({ domain: DOMAIN, region: "EU" });
  fakeUs = await startFakeMailgun({ domain: DOMAIN, region: "US" });
  fakeNew = await startFakeMailgun({ domain: "new.example.com", region: "EU" });
  process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
  const o = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  owner = { id: o.id, name: o.name };
});

afterAll(async () => {
  if (previousBase === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousBase;
  await Promise.all([fake.close(), fakeUs.close(), fakeNew.close()]);
  await db.$disconnect();
  t.cleanup();
});

describe("testMailgunConnection (read-only)", () => {
  it("passes with the right key and domain, and saves nothing", async () => {
    const res = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: " key-fake-api​ " }, deps);
    expect(res).toEqual({ ok: true, message: `Mailgun found ${DOMAIN} (EU).`, domainState: "unverified" });
    expect((await secretInfo("mailgun.apiKey")).set).toBe(false);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("a wrong key: the API key sentence, on the key field", async () => {
    const res = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: "key-fake-wrong" }, deps);
    expect(res).toMatchObject({ ok: false, field: "apiKey", error: AUTH_TEXT });
  });

  it("a subdomain that lives in the other region: says so without pushing to the other region first (F28)", async () => {
    process.env.OUTREACH_MAILGUN_BASE_URL = fakeUs.origin;
    try {
      const res = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: "key-fake-api" }, deps);
      expect(res).toMatchObject({
        ok: false,
        field: "region",
        error:
          "Mailgun can't find send.example.com in the EU region, only in US. If your main domain is in the EU region in Mailgun, delete send.example.com there and add it again in the EU region (Mailgun guide, step 4). Otherwise change Region to US.",
      });
      expect(res.ok ? null : res.error).toBe(connect.wrongRegionSubdomainText(DOMAIN, "EU", "US"));
      // Read-only probes only: one GET per region (plus the one quick 404 retry).
      expect(fakeUs.requests.every((r) => r.method === "GET" && r.path === `/v4/domains/${DOMAIN}`)).toBe(true);
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
  });

  it("a main domain that lives in the other region: the plain wrong-region sentence, on the region field", async () => {
    const apex = await startFakeMailgun({ domain: "sendstudio.com", region: "US" });
    process.env.OUTREACH_MAILGUN_BASE_URL = apex.origin;
    try {
      const res = await connect.testMailgunConnection({ region: "EU", domain: "sendstudio.com", apiKey: "key-fake-api" }, deps);
      expect(res).toMatchObject({
        ok: false,
        field: "region",
        error: "Mailgun can't find sendstudio.com in the EU region. If you created the domain in the US region, change Region to US.",
      });
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
      await apex.close();
    }
  });

  it("an unknown domain in both regions: says how to add it, on the domain field", async () => {
    const res = await connect.testMailgunConnection({ region: "EU", domain: "other.example.com", apiKey: "key-fake-api" }, deps);
    expect(res).toMatchObject({
      ok: false,
      field: "domain",
      error: "Mailgun has no domain called other.example.com in either region. Check the spelling, or add it in Mailgun first (Send › Domains › Add new domain).",
    });
  });

  it("no network: the internet sentence", async () => {
    process.env.OUTREACH_MAILGUN_BASE_URL = `http://127.0.0.1:${await closedPort()}`;
    try {
      const res = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: "key-fake-api" }, deps);
      expect(res).toMatchObject({ ok: false, field: null, error: NETWORK_TEXT });
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
  });

  it("a test key outside fake mode is refused before anything is sent (and a real key in fake mode too)", async () => {
    delete process.env.OUTREACH_MAILGUN_BASE_URL;
    try {
      const res = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: "key-fake-api" }, deps);
      expect(res).toEqual({ ok: false, field: "apiKey", error: "This is a test key. Paste the key from Mailgun › API Security.", detail: null });
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    const real = await connect.testMailgunConnection({ region: "EU", domain: DOMAIN, apiKey: "key-0123456789abcdef" }, deps);
    expect(real).toMatchObject({ ok: false, field: "apiKey", error: connect.CONNECT_TEXTS.realKeyInFakeMode });
  });

  it("checks the domain's shape first: the website points to the From address card, Mailgun's sandbox is refused (F30)", async () => {
    const before = fake.requests.length;
    expect(await connect.testMailgunConnection({ region: "EU", domain: "polygonparadise.com", apiKey: "key-fake-api" }, deps)).toMatchObject({
      ok: false,
      field: "domain",
      error: SENDING_DOMAIN_TEXTS.website,
    });
    expect(SENDING_DOMAIN_TEXTS.website).toBe(
      "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4).",
    );
    expect(await connect.testMailgunConnection({ region: "US", domain: "sandbox1a2b3c.mailgun.org", apiKey: "key-fake-api" }, deps)).toMatchObject({
      ok: false,
      field: "domain",
      error: SENDING_DOMAIN_TEXTS.sandbox,
    });
    expect(fake.requests.length).toBe(before);
  });
});

describe("connectMailgun", () => {
  it("saves nothing when the test fails", async () => {
    const res = await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: "key-fake-wrong" }, deps);
    expect(res.ok).toBe(false);
    expect((await secretInfo("mailgun.apiKey")).set).toBe(false);
    expect(await getSetting("mailgun.domain")).toBeNull();
    expect(await db.sendingDomain.count()).toBe(0);
  });

  it("saves keys, settings and the domain after a pass, fetches the signing key and queues the checks", async () => {
    await clearJobs();
    const res = await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: "key-fake-api" }, deps);
    expect(res).toEqual({
      ok: true,
      message: `Connected to ${DOMAIN} (EU). Mailgun hasn't confirmed your DNS records yet: add them from the Domain checklist.`,
      domainState: "unverified",
    });
    expect(await getSecret("mailgun.apiKey")).toBe("key-fake-api");
    expect(await getSecret("mailgun.webhookSigningKey")).toBe("key-fake-signing");
    expect(await getSetting("mailgun.domain")).toBe(DOMAIN);
    expect(await getSetting("mailgun.region")).toBe("EU");
    expect(await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } })).toMatchObject({ active: true, region: "EU" });
    expect((await queuedJobs("mailgun.checkDomain")).length).toBe(1);
    expect((await queuedJobs("mailgun.syncSuppressions")).length).toBe(1);
    expect((await queuedJobs("mailgun.syncRoutes")).length).toBe(0);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.connected" } });
    expect(log.summary).toBe(`Arslan connected Mailgun (${DOMAIN}, EU)`);
    // The signing key was read, never regenerated.
    expect(fake.state().signingKeyRegenerated).toBe(0);
  });

  it("an empty key re-tests with the saved one, and the same domain keeps its sending key", async () => {
    await setSecret("mailgun.sendingKey", "key-fake-send-a", owner.id);
    const res = await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: "" }, deps);
    expect(res.ok).toBe(true);
    expect(await getSecret("mailgun.apiKey")).toBe("key-fake-api");
    expect(await getSecret("mailgun.sendingKey")).toBe("key-fake-send-a");
    if (res.ok) expect(res.message).not.toContain("sending key");
  });

  it("a domain change moves the sending addresses, starts the reply test again and re-pushes the do-not-email list", async () => {
    const old = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    await addSenderAddress(owner.id, old.id, "arslan", "ok");
    await setSetting(
      "mailgun.unsubscribeTest",
      { setup: "A", status: "passed", domain: DOMAIN, mailboxes: [], headersOk: true, decidedAt: new Date().toISOString(), decidedById: owner.id, note: null },
      owner.id,
    );
    await dbWrite((c) =>
      c.suppression.create({ data: { emailNorm: "gone@studio.de", reason: "BOUNCED", source: "webhook", pushedToMailgunAt: new Date() } }),
    );
    // The old domain's Apply run, with its certificate still being prepared.
    await setState("mailgun.setup", {
      runAt: new Date().toISOString(),
      byUserId: owner.id,
      jobId: 7,
      steps: [{ key: "webhooks", ok: true, text: "Mailgun tells the app about deliveries, bounces, complaints and unsubscribes.", detail: null, at: new Date().toISOString() }],
      certificate: { host: `email.${DOMAIN}`, status: "processing", startedAt: new Date().toISOString(), lastPolledAt: null, error: null },
    });
    expect(await getSecret("mailgun.sendingKey")).toBe("key-fake-send-a");
    await clearJobs();

    process.env.OUTREACH_MAILGUN_BASE_URL = fakeNew.origin;
    try {
      const res = await connect.connectMailgun(owner, { region: "EU", domain: "new.example.com", apiKey: null }, deps);
      expect(res.ok).toBe(true);
      // The old domain's sending key would make every send from new.example.com fail: it's removed, and said so.
      if (res.ok) expect(res.message).toContain(connect.sendingKeyRemovedText(DOMAIN));
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    expect((await secretInfo("mailgun.sendingKey")).set).toBe(false);
    expect(await getSecret("mailgun.apiKey")).toBe("key-fake-api");
    // The old domain's Apply steps and certificate are gone: the checklist starts clean for new.example.com.
    expect((await readTyped("mailgun.setup", parseMailgunSetupState)).value).toEqual({ runAt: null, byUserId: null, jobId: null, steps: [], certificate: null });

    const addresses = await db.senderAddress.findMany({ where: { userId: owner.id }, orderBy: { id: "asc" } });
    expect(addresses.map((a) => [a.address, a.retiredAt !== null, a.routeStatus])).toEqual([
      ["arslan@send.example.com", true, "ok"],
      ["arslan@new.example.com", false, "pending"],
    ]);
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", domain: null, setup: "A" });
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: "gone@studio.de" } })).pushedToMailgunAt).toBeNull();
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } })).active).toBe(false);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: "new.example.com" } })).active).toBe(true);
    const changed = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.domainChanged" } });
    expect(changed.summary).toBe("Arslan changed the sending domain from send.example.com to new.example.com");
    expect((await queuedJobs("mailgun.syncRoutes")).length).toBe(1);
  });

  it("refuses a domain change while a test or live campaign still sends from the old domain", async () => {
    await dbWrite((c) => c.campaign.create({ data: { name: "Test mailboxes", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
    const res = await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: null }, deps);
    expect(res).toEqual({
      ok: false,
      field: "domain",
      error: "Finish or cancel “Test mailboxes” first: it sends from new.example.com.",
      detail: null,
    });
    expect(await getSetting("mailgun.domain")).toBe("new.example.com");
    await dbWrite((c) => c.campaign.updateMany({ where: { name: "Test mailboxes" }, data: { status: "FINISHED" } }));
  });

  it("checks the refusal again when saving: a campaign launched while Mailgun was being asked keeps the old domain", async () => {
    let launched = false;
    const racingFetch: typeof fetch = async (input, init) => {
      if (!launched) {
        launched = true; // a Member launches a live campaign during the connection test
        await dbWrite((c) => c.campaign.create({ data: { name: "Launched meanwhile", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
      }
      return fetch(input, init);
    };
    const addressesBefore = await db.senderAddress.count({ where: { retiredAt: null } });
    const changesBefore = await db.activityLog.count({ where: { type: { in: ["mailgun.domainChanged", "mailgun.connected"] } } });
    const res = await connect.connectMailgun(
      owner,
      { region: "EU", domain: DOMAIN, apiKey: null, sendingKey: "key-fake-send-b" },
      { ...deps, fetchImpl: racingFetch },
    );
    expect(launched).toBe(true);
    expect(res).toEqual({ ok: false, field: "domain", error: "Finish or cancel “Launched meanwhile” first: it sends from new.example.com.", detail: null });
    // Nothing was saved: not the domain, not the key, not the addresses.
    expect(await getSetting("mailgun.domain")).toBe("new.example.com");
    expect((await secretInfo("mailgun.sendingKey")).set).toBe(false);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: "new.example.com" } })).active).toBe(true);
    expect(await db.senderAddress.count({ where: { retiredAt: null } })).toBe(addressesBefore);
    expect(await db.activityLog.count({ where: { type: { in: ["mailgun.domainChanged", "mailgun.connected"] } } })).toBe(changesBefore);
    await dbWrite((c) => c.campaign.updateMany({ where: { name: "Launched meanwhile" }, data: { status: "FINISHED" } }));
  });

  it("forgetMailgunKeys removes the three keys and logs it", async () => {
    await setSecret("mailgun.sendingKey", "key-fake-sending", owner.id);
    await connect.forgetMailgunKeys(owner);
    for (const k of ["mailgun.apiKey", "mailgun.sendingKey", "mailgun.webhookSigningKey"] as const) {
      expect((await secretInfo(k)).set).toBe(false);
    }
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.keysRemoved" } });
    expect(log.summary).toBe("Arslan removed the saved Mailgun keys");
  });

  it("removeSendingKey removes only the domain sending key, so the API key sends again, and logs it (review SCREENS-01)", async () => {
    await setSecret("mailgun.apiKey", "key-fake-api", owner.id);
    await setSecret("mailgun.webhookSigningKey", "key-fake-signing", owner.id);
    await setSecret("mailgun.sendingKey", "key-fake-sending", owner.id);
    const withKey = await getMailgunContext();
    expect(withKey.connected && withKey.sendClient !== withKey.client).toBe(true);
    const domainBefore = await getSetting("mailgun.domain");

    expect(await connect.removeSendingKey(owner)).toEqual({ removed: true });
    expect((await secretInfo("mailgun.sendingKey")).set).toBe(false);
    expect(await getSecret("mailgun.apiKey")).toBe("key-fake-api");
    expect(await getSecret("mailgun.webhookSigningKey")).toBe("key-fake-signing");
    expect(await getSetting("mailgun.domain")).toBe(domainBefore);
    const ctx = await getMailgunContext();
    expect(ctx.connected && ctx.sendClient === ctx.client).toBe(true);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.keysRemoved" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: owner.id, summary: "Arslan removed the domain sending key" });
    expect(log.data).toEqual({ keys: ["sendingKey"] });

    // Nothing saved: nothing removed, nothing logged.
    const logs = await db.activityLog.count();
    expect(await connect.removeSendingKey(owner)).toEqual({ removed: false });
    expect(await db.activityLog.count()).toBe(logs);
  });
});

describe("the shared From address and the connection (SHARED-FROM-DESIGN F14, F28)", () => {
  it("a new domain the saved From address doesn't fit is refused before Mailgun is asked; one it fits is allowed", async () => {
    // Back on send.example.com (EU), with a From address on its main domain.
    const back = await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: "key-fake-api" }, deps);
    expect(back.ok).toBe(true);
    await setSetting("mailgun.fromAddress", "contact@example.com", owner.id);
    const changesBefore = await db.activityLog.count({ where: { type: "mailgun.domainChanged" } });
    fake.requests.length = 0;
    for (const other of ["mail.other.test", "sendstudio.com"]) {
      expect(await connect.connectMailgun(owner, { region: "EU", domain: other, apiKey: null }, deps)).toEqual({
        ok: false,
        field: "domain",
        error: TEAM_FROM_TEXTS.domainMisfit("contact@example.com", other),
        detail: null,
      });
    }
    expect(TEAM_FROM_TEXTS.domainMisfit("contact@example.com", "mail.other.test")).toBe(
      "Your From address contact@example.com doesn't fit mail.other.test. Clear or change it in the From address card first.",
    );
    expect(fake.requests).toEqual([]);
    expect(await getSetting("mailgun.domain")).toBe(DOMAIN);
    expect(await db.activityLog.count({ where: { type: "mailgun.domainChanged" } })).toBe(changesBefore);

    // new.example.com has the same main domain: the From address still fits.
    process.env.OUTREACH_MAILGUN_BASE_URL = fakeNew.origin;
    try {
      expect((await connect.connectMailgun(owner, { region: "EU", domain: "new.example.com", apiKey: null }, deps)).ok).toBe(true);
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    expect(await getSetting("mailgun.domain")).toBe("new.example.com");
    expect(await connect.connectMailgun(owner, { region: "EU", domain: DOMAIN, apiKey: null }, deps)).toMatchObject({ ok: true });
    await setSetting("mailgun.fromAddress", null, owner.id);
  });

  it("the same name in the other region is a domain change: reply test, go-live, sending key, suppressions, Apply run and routes", async () => {
    // Connected to send.example.com (EU): Arslan's address works, the reply test passed, the app is live.
    const row = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    const address = await db.senderAddress.findFirstOrThrow({ where: { userId: owner.id, domainId: row.id, retiredAt: null } });
    await dbWrite((c) => c.senderAddress.update({ where: { id: address.id }, data: { routeStatus: "ok" } }));
    await setSetting(
      "mailgun.unsubscribeTest",
      { setup: "A", status: "passed", domain: DOMAIN, mailboxes: [], headersOk: true, decidedAt: new Date().toISOString(), decidedById: owner.id, note: null },
      owner.id,
    );
    await setSetting("sending.goLive", true, owner.id);
    await setSetting("sending.goLiveAt", "2026-09-20T10:00:00.000Z", owner.id);
    await setSetting("sending.goLiveDomain", DOMAIN, owner.id);
    await setSecret("mailgun.sendingKey", "key-fake-send-eu", owner.id);
    await dbWrite((c) =>
      c.suppression.upsert({
        where: { emailNorm: "moved@studio.de" },
        create: { emailNorm: "moved@studio.de", reason: "UNSUBSCRIBED", source: "webhook", pushedToMailgunAt: new Date() },
        update: { pushedToMailgunAt: new Date() },
      }),
    );
    await setState("mailgun.setup", {
      runAt: new Date().toISOString(),
      byUserId: owner.id,
      jobId: 9,
      steps: [],
      certificate: { host: `email.${DOMAIN}`, status: "active", startedAt: null, lastPolledAt: null, error: null },
    });

    // A running live campaign blocks the move like any domain change.
    await dbWrite((c) => c.campaign.create({ data: { name: "EU run", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
    expect(await connect.connectMailgun(owner, { region: "US", domain: DOMAIN, apiKey: null }, deps)).toEqual({
      ok: false,
      field: "domain",
      error: "Finish or cancel “EU run” first: it sends from send.example.com.",
      detail: null,
    });
    await dbWrite((c) => c.campaign.updateMany({ where: { name: "EU run" }, data: { status: "FINISHED" } }));
    await clearJobs();

    process.env.OUTREACH_MAILGUN_BASE_URL = fakeUs.origin;
    let res: Awaited<ReturnType<typeof connect.connectMailgun>>;
    try {
      res = await connect.connectMailgun(owner, { region: "US", domain: DOMAIN, apiKey: null }, deps);
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain(connect.sendingKeyRemovedText("send.example.com (EU)"));
      expect(res.message).toContain(GO_LIVE_COPY.endedByDomainChange("send.example.com (EU)", "send.example.com (US)"));
      // Review SETTING-1: the old region's evidence stops counting, and its late reports can't reach the app.
      expect(res.message).toContain(connect.regionMovedText("EU"));
    }
    // The evidence moment moved to the move; the From address itself (empty here) is unchanged.
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect((await loadTeamFrom()).changedAt).toBeInstanceOf(Date);
    expect(await getSetting("mailgun.region")).toBe("US");
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("sending.goLiveAt")).toBe("2026-09-20T10:00:00.000Z");
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", domain: null });
    expect((await secretInfo("mailgun.sendingKey")).set).toBe(false);
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: "moved@studio.de" } })).pushedToMailgunAt).toBeNull();
    expect((await readTyped("mailgun.setup", parseMailgunSetupState)).value).toEqual({ runAt: null, byUserId: null, jobId: null, steps: [], certificate: null });
    // The same row and the same address, its route set up again in the new region.
    expect(await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } })).toMatchObject({ id: row.id, region: "US", active: true });
    expect(await db.senderAddress.findUniqueOrThrow({ where: { id: address.id } })).toMatchObject({ retiredAt: null, routeStatus: "pending" });
    expect((await queuedJobs("mailgun.syncRoutes")).length).toBe(1);
    expect((await queuedJobs("mailgun.syncSuppressions")).length).toBe(1);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.domainChanged" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan moved send.example.com from the EU region to the US region");
    expect(log.data).toMatchObject({ from: DOMAIN, to: DOMAIN, fromRegion: "EU", toRegion: "US", goLiveEnded: true, sendingKeyRemoved: true });
  });

  it("reconnecting the same name in the same region changes nothing of that", async () => {
    await setSetting("sending.goLive", true, owner.id);
    await clearJobs();
    const changes = await db.activityLog.count({ where: { type: "mailgun.domainChanged" } });
    process.env.OUTREACH_MAILGUN_BASE_URL = fakeUs.origin;
    try {
      expect((await connect.connectMailgun(owner, { region: "US", domain: DOMAIN, apiKey: null }, deps)).ok).toBe(true);
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    expect(await getSetting("sending.goLive")).toBe(true);
    expect(await db.activityLog.count({ where: { type: "mailgun.domainChanged" } })).toBe(changes);
    expect((await queuedJobs("mailgun.syncRoutes")).length).toBe(0);
  });
});
