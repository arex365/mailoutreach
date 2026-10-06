import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeUser, setSettingValue } from "../campaigns/seed";

/** getMailgunContext and friends (M3-DESIGN §4.2.4) against the fake, on a temp database. */

const t = await createTestDb("foundations-context");
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext, domainsToSync, clientFor, mailgunSecrets, loadSendGuard, NOT_CONNECTED_TEXT } = await import(
  "@/server/mailgun/context"
);
const { suppressionListsFor } = await import("@/server/mailgun/suppression-lookup");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { MailgunError } = await import("@/server/mailgun/errors");

const mg = await connectFakeMailgun({ domain: "send.example.com" });

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("practice.copy", false);
  await setSettingValue("mailgun.domain", mg.domain);
  await setSecret("mailgun.apiKey", mg.apiKey, null);
  await deleteSecret("mailgun.sendingKey");
});

describe("connectFakeMailgun", () => {
  it("points the app at the fake and saves test keys, settings and the domain row", async () => {
    expect(process.env.OUTREACH_MAILGUN_BASE_URL).toBe(mg.fake.origin);
    expect(mg.apiKey.startsWith("key-fake-")).toBe(true);
    const row = await db.sendingDomain.findUniqueOrThrow({ where: { id: mg.domainId } });
    expect(row).toMatchObject({ name: "send.example.com", region: "EU", active: true });
  });
});

describe("getMailgunContext", () => {
  it("connects through the fake with the saved key", async () => {
    const ctx = await getMailgunContext();
    if (!ctx.connected) throw new Error(ctx.text);
    expect(ctx).toMatchObject({ connected: true, domain: "send.example.com", region: "EU", domainId: mg.domainId, fakeMode: true });
    expect(ctx.client.baseUrl).toBe(mg.fake.origin);
    expect(ctx.sendClient).toBe(ctx.client);
    expect((await ctx.client.getDomain(ctx.domain)).name).toBe("send.example.com");
  });

  it("uses the domain sending key for sends when one is saved", async () => {
    await setSecret("mailgun.sendingKey", "key-fake-sending", null);
    const ctx = await getMailgunContext();
    if (!ctx.connected) throw new Error(ctx.text);
    expect(ctx.sendClient).not.toBe(ctx.client);
    // a real-looking sending key doesn't fit the fake: ignored
    await setSecret("mailgun.sendingKey", "0123456789abcdef0123456789abcdef-11111111-22222222", null);
    const ctx2 = await getMailgunContext();
    if (!ctx2.connected) throw new Error(ctx2.text);
    expect(ctx2.sendClient).toBe(ctx2.client);
  });

  it("explains why it isn't connected", async () => {
    await setSettingValue("practice.copy", true);
    expect(await getMailgunContext()).toEqual({ connected: false, reason: "practice-copy", text: "The practice copy never talks to Mailgun." });
    await setSettingValue("practice.copy", false);

    await dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.domain" } }));
    expect(await getMailgunContext()).toEqual({
      connected: false,
      reason: "no-domain",
      text: "Mailgun isn't connected yet. Open Settings › Sending & Mailgun.",
    });
    await setSettingValue("mailgun.domain", mg.domain);

    await deleteSecret("mailgun.apiKey");
    expect(await getMailgunContext()).toEqual({
      connected: false,
      reason: "no-key",
      text: "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun.",
    });

    await setSecret("mailgun.apiKey", "0123456789abcdef0123456789abcdef-11111111-22222222", null);
    expect(await getMailgunContext()).toEqual({ connected: false, reason: "no-key", text: NOT_CONNECTED_TEXT.mismatch });
  });

  it("reports an unreadable key instead of throwing", async () => {
    await dbWrite((c) => c.secret.update({ where: { key: "mailgun.apiKey" }, data: { ciphertext: "v1:bad:bad:bad" } }));
    expect(await getMailgunContext()).toEqual({ connected: false, reason: "no-key", text: NOT_CONNECTED_TEXT.unreadable });
  });

  it("repairs a missing SendingDomain row", async () => {
    await setSettingValue("mailgun.domain", "Other.Example.com");
    const ctx = await getMailgunContext();
    if (!ctx.connected) throw new Error(ctx.text);
    expect(ctx.domain).toBe("other.example.com");
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: ctx.domainId } })).name).toBe("other.example.com");
    await dbWrite((c) => c.sendingDomain.delete({ where: { id: ctx.domainId } }));
  });

  it("gives the other region's client for older domains (the same fake here)", async () => {
    const ctx = await getMailgunContext();
    if (!ctx.connected) throw new Error(ctx.text);
    const us = clientFor(ctx, "US");
    expect(us.region).toBe("US");
    expect(us.baseUrl).toBe(mg.fake.origin);
    expect(clientFor(ctx, "EU")).toBe(ctx.client);
    // the fake answers the US client as "the other region": the domain is unknown there, which is never read as
    // "not on the list"
    const err = await us.getSuppression(ctx.domain, "bounces", "x@y.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailgunError);
    expect(err).toMatchObject({ kind: "not-found", mailgunMessage: "Domain not found" });
    expect(await ctx.client.getSuppression(ctx.domain, "bounces", "x@y.com")).toBeNull();

    // retryDelayMs reaches both clients, so a test's fake 404 doesn't wait 5 s
    const quick = await getMailgunContext({ retryDelayMs: () => 0 });
    if (!quick.connected) throw new Error(quick.text);
    const started = Date.now();
    await expect(clientFor(quick, "US").getDomain(quick.domain)).rejects.toMatchObject({ kind: "not-found" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("domainsToSync", () => {
  it("lists the active domain and inactive ones that sent live email in the last 60 days", async () => {
    const now = new Date("2026-09-23T10:00:00Z");
    await dbWrite(async (c) => {
      await c.sendingDomain.create({ data: { name: "recent.example.com", region: "US", active: false, lastLiveSendAt: new Date("2026-08-01T00:00:00Z") } });
      await c.sendingDomain.create({ data: { name: "stale.example.com", region: "EU", active: false, lastLiveSendAt: new Date("2026-06-01T00:00:00Z") } });
      await c.sendingDomain.create({ data: { name: "never.example.com", region: "EU", active: false } });
    });
    const list = await domainsToSync(now);
    expect(list.map((d) => d.name)).toEqual(["send.example.com", "recent.example.com"]);
    expect(list.find((d) => d.name === "recent.example.com")?.region).toBe("US");
  });
});

describe("mailgunSecrets", () => {
  it("lists every saved key and its Basic-auth form", async () => {
    await setSecret("mailgun.sendingKey", "key-fake-sending", null);
    const secrets = await mailgunSecrets();
    for (const k of [mg.apiKey, "key-fake-sending", mg.signingKey!]) {
      expect(secrets).toContain(k);
      expect(secrets).toContain(Buffer.from("api:" + k).toString("base64"));
    }
  });
});

describe("loadSendGuard", () => {
  it("reads go-live, the normalised test list and the user's own inbox", async () => {
    const ali = await makeUser("Ali Guard", { email: "ali.guard@polygonparadise.test" });
    await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { replyInbox: "Ali.Khan@Gmail.com" } }));
    await setSettingValue("sending.testList", ["Tester@Gmail.com", "bad", "tester2@outlook.com"]);
    const g = await loadSendGuard({ userId: ali.id });
    expect(g.goLive).toBe(false);
    expect([...g.testList].sort()).toEqual(["tester2@outlook.com", "tester@gmail.com"]);
    expect(g.ownInbox).toBe("ali.khan@gmail.com");
    const noInbox = await makeUser("Sara Guard", { email: "sara.guard@polygonparadise.test" });
    expect((await loadSendGuard({ userId: noInbox.id })).ownInbox).toBe("sara.guard@polygonparadise.test");
    expect("ownInbox" in (await loadSendGuard())).toBe(false);
    await setSettingValue("sending.goLive", true);
    expect((await loadSendGuard()).goLive).toBe(true);
    await setSettingValue("sending.goLive", false);
  });
});

describe("suppressionListsFor", () => {
  it("finds each address on the local list and on Mailgun's three lists", async () => {
    const ctx = await getMailgunContext();
    if (!ctx.connected) throw new Error(ctx.text);
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "inbox@gmail.com", reason: "UNSUBSCRIBED", source: "manual" } }));
    mg.fake.addSuppression("bounces", "inbox@gmail.com");
    mg.fake.addSuppression("complaints", "other@outlook.com");
    const map = await suppressionListsFor(["Inbox@Gmail.com", "other@outlook.com", "clean@yahoo.com", "inbox@gmail.com", "not an address"], ctx);
    expect([...map.entries()]).toEqual([
      ["inbox@gmail.com", ["local", "bounces"]],
      ["other@outlook.com", ["complaints"]],
      ["clean@yahoo.com", []],
    ]);
    expect(mg.fake.requests.filter((r) => r.method === "GET")).toHaveLength(9);
  });
});
