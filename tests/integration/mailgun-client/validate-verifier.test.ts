import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";

/**
 * The address-check adapter with a database (M5-DESIGN §2.2, §0.2 rule 13): which checker `getVerifier` picks and the
 * sentences when it can't, the Mailgun verifier against the fake (provider "mailgun-fake", unreadable answers, failure
 * kinds, scrubbed details), and `scrubProviderText` / `allSecretValues`.
 */

const t = await createTestDb("validate-verifier");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { getVerifier, NO_CHECK_KEY_TEXT } = await import("@/server/verification");
const { NOT_CONNECTED_TEXT } = await import("@/server/mailgun/context");
const { allSecretValues, scrubProviderText } = await import("@/server/secret-values");

const ROUTE = "GET /v4/address/validate";

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  mg.fake.reset();
  await setSetting("practice.copy", false, null);
  await setSecret("mailgun.apiKey", "key-fake-api", null);
  await deleteSecret("verification.apiKey");
});

async function mailgunVerifier(opts: { timeoutMs?: number } = {}) {
  const res = await getVerifier(opts);
  if (!res.ok) throw new Error(`expected a verifier: ${res.text}`);
  return res.verifier;
}

describe("getVerifier", () => {
  it("uses the test checker in the practice copy (provider fake, $0, no request)", async () => {
    await setSetting("practice.copy", true, null);
    const res = await getVerifier();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verifier).toMatchObject({ provider: "fake", pricePerCheck: 0 });
    expect(await res.verifier.check("bad1@valid.test", "bad1@valid.test")).toMatchObject({ ok: true, result: { status: "INVALID" } });
    expect(mg.fake.requests).toHaveLength(0);
  });

  it("uses Mailgun (the fake: provider mailgun-fake) with the Setting's price", async () => {
    await setSetting("verification.pricePerCheck", 0.008, null);
    const v = await mailgunVerifier();
    expect(v).toMatchObject({ provider: "mailgun-fake", pricePerCheck: 0.008 });
    await setSetting("verification.pricePerCheck", 5, null);
    expect((await mailgunVerifier()).pricePerCheck).toBe(0.012);
    await setSetting("verification.pricePerCheck", 0.012, null);
  });

  it("prefers the address check key over the Mailgun key", async () => {
    await setSecret("verification.apiKey", "key-fake-checks", null);
    const v = await mailgunVerifier();
    // The fake only knows key-fake-api: the separate key is the one sent.
    expect(await v.check("anna@valid.test", "anna@valid.test")).toMatchObject({ ok: false, kind: "auth" });
    await deleteSecret("verification.apiKey");
    expect(await (await mailgunVerifier()).check("anna@valid.test", "anna@valid.test")).toMatchObject({ ok: true });
  });

  it("says what to do without a key, with a key that can't be read, or one that doesn't fit the server", async () => {
    await deleteSecret("mailgun.apiKey");
    expect(await getVerifier()).toEqual({ ok: false, reason: "no-key", text: NO_CHECK_KEY_TEXT });
    expect(NO_CHECK_KEY_TEXT).toBe("Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun.");

    await dbWrite((c) => c.secret.create({ data: { key: "mailgun.apiKey", ciphertext: "v1:bad:bad:bad", last4: "xxxx" } }));
    expect(await getVerifier()).toEqual({ ok: false, reason: "unreadable", text: NOT_CONNECTED_TEXT.unreadable });

    await setSecret("mailgun.apiKey", "key-real-looking-0123456789", null);
    expect(await getVerifier()).toEqual({ ok: false, reason: "mismatch", text: NOT_CONNECTED_TEXT.mismatch });
  });
});

describe("the Mailgun verifier against the fake", () => {
  it("maps an answer and says how long it took", async () => {
    const v = await mailgunVerifier();
    const res = await v.check("medium1@valid.test", "medium1@valid.test");
    expect(res).toMatchObject({ ok: true, unreadable: false, result: { status: "VALID", risk: "MEDIUM", reasons: [] } });
    if (res.ok) expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(await v.check("x@yaho.test", "x@yaho.test")).toMatchObject({ ok: true, result: { status: "INVALID", didYouMean: "x@yahoo.test" } });
  });

  it("an answer it can't read is ok but unreadable (a charged row that leaves the person alone)", async () => {
    const v = await mailgunVerifier();
    const weird = await v.check("weird1@valid.test", "weird1@valid.test");
    expect(weird).toMatchObject({ ok: true, unreadable: true, result: { status: "UNKNOWN", risk: "UNKNOWN", reasons: ["app:unreadable_response"] } });
    if (weird.ok) expect(weird.result.raw).toMatchObject({ result: "maybe" });
    expect(await v.check("v3shape@valid.test", "v3shape@valid.test")).toMatchObject({ ok: true, unreadable: true });
  });

  it("any 400 is rejected, even when its text says 'disabled'; the detail has no address", async () => {
    const v = await mailgunVerifier();
    mg.fake.failNext(ROUTE, { kind: "status", status: 400, body: { message: "disabled@firma.de is disabled for checks" } });
    const res = await v.check("disabled@firma.de", "disabled@firma.de");
    expect(res).toMatchObject({ ok: false, kind: "rejected", timedOut: false, retryAfterMs: null, message: "Mailgun refused to check this address." });
    if (!res.ok) {
      expect(res.detail).toBe("[address] is disabled for checks");
      expect(res.message).not.toContain("@");
    }
  });

  it("maps the other failures", async () => {
    const v = await mailgunVerifier({ timeoutMs: 100 });
    mg.fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" } });
    const limited = await v.check("a@valid.test", "a@valid.test");
    expect(limited).toMatchObject({ ok: false, kind: "rate-limited", timedOut: false });
    if (!limited.ok) expect(limited.retryAfterMs).toBeGreaterThan(0);

    expect(await v.check("boom@valid.test", "boom@valid.test")).toMatchObject({ ok: false, kind: "transient", timedOut: false });

    mg.fake.failNext(ROUTE, { kind: "delay", ms: 400 });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "transient", timedOut: true });
    await new Promise((r) => setTimeout(r, 400));

    mg.fake.failNext(ROUTE, { kind: "status", status: 402, body: { message: "Payment required" } });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "payment", detail: "Payment required" });
    mg.fake.failNext(ROUTE, { kind: "status", status: 403, body: { Error: "Forbidden" } });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "auth", detail: "Forbidden" });
    mg.fake.failNext(ROUTE, { kind: "status", status: 403, body: { message: "Account suspended" } });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "not-allowed" });
    mg.fake.failNext(ROUTE, { kind: "businessVerification" });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "business-verification" });
    mg.fake.failNext(ROUTE, { kind: "status", status: 404, body: "404 page not found" });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "not-found" });
  });

  it("each check is exactly one request, whatever happens", async () => {
    const v = await mailgunVerifier();
    await v.check("boom@valid.test", "boom@valid.test");
    mg.fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" } });
    await v.check("a@valid.test", "a@valid.test");
    expect(mg.fake.requests.filter((r) => r.path === "/v4/address/validate")).toHaveLength(2);
  });
});

describe("scrubProviderText and allSecretValues", () => {
  it("lists every saved secret and the Basic forms of the Mailgun and address check keys", async () => {
    await setSecret("verification.apiKey", "key-fake-checks-123456", null);
    await setSecret("anthropic.apiKey", "sk-ant-fake-key-abcdefghij", null);
    const values = await allSecretValues();
    const basic = (k: string) => Buffer.from(`api:${k}`).toString("base64");
    expect(values).toEqual(
      expect.arrayContaining([
        "key-fake-api",
        basic("key-fake-api"),
        "key-fake-checks-123456",
        basic("key-fake-checks-123456"),
        "key-fake-signing",
        "sk-ant-fake-key-abcdefghij",
      ]),
    );
    await deleteSecret("anthropic.apiKey");
  });

  it("removes the key, the address (also URL-encoded) and any other address, capped at 300 characters", async () => {
    await setSecret("verification.apiKey", "key-fake-checks-123456", null);
    const text =
      "Refused anna+cv@firma.de (anna%2Bcv%40firma.de) with key-fake-checks-123456 and " +
      `${Buffer.from("api:key-fake-api").toString("base64")}; also ben@butikk.no and ola%40example.no.`;
    const out = await scrubProviderText(text, { address: "anna+cv@firma.de" });
    expect(out).not.toContain("anna");
    expect(out).not.toContain("ben@");
    expect(out).not.toContain("ola%40");
    expect(out).not.toContain("key-fake-checks-123456");
    expect(out).not.toContain(Buffer.from("api:key-fake-api").toString("base64"));
    expect(out).toContain("[address]");
    expect(out).toContain("[hidden]");
    expect(out).not.toMatch(/@/);
    const long = await scrubProviderText("x".repeat(1_000));
    expect(long.length).toBe(300);
    expect(await scrubProviderText("Invalid key sk-ant-api03-abcdefghijklmnop")).toBe("Invalid key [hidden]");
  });
});
