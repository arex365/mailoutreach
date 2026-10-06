import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../../fake-mailgun/cli";
import { startFakeMailgun } from "../../fake-mailgun/server";

/**
 * The fake Mailgun's GET/POST /v4/address/validate (M5-DESIGN §7.1, research verification-reference §11): outcomes,
 * overrides, switches, faults, counters and what stays unrouted. Plain HTTP, no app code, no database.
 */

const KEY = "key-fake-api";
const ROUTE = "GET /v4/address/validate";
let clock = new Date("2026-09-30T10:00:00Z");
const fake = await startFakeMailgun({ domain: "send.example.com", sendingKey: "key-fake-sending", now: () => clock });

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  clock = new Date("2026-09-30T10:00:00Z");
  fake.reset();
  fake.setNow(() => clock);
});

const auth = (key = KEY) => ({ authorization: "Basic " + Buffer.from(`api:${key}`).toString("base64") });

async function validate(address: string | null, opts: { providerLookup?: string; key?: string } = {}) {
  const q = new URLSearchParams();
  if (address !== null) q.set("address", address);
  q.set("provider_lookup", opts.providerLookup ?? "true");
  const res = await fetch(`${fake.origin}/v4/address/validate?${q}`, { headers: auth(opts.key) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, body: body as Record<string, unknown>, headers: res.headers };
}

describe("outcomes per address", () => {
  const rows: Array<[string, number, Record<string, unknown>]> = [
    ["anna@valid.test", 200, { result: "deliverable", risk: "low", reason: [] }],
    ["x@nomx.test", 200, { result: "undeliverable", risk: "high", reason: ["no_mx"] }],
    ["anna@yaho.test", 200, { result: "undeliverable", did_you_mean: "anna@yahoo.test" }],
    ["x@catchall-low.test", 200, { result: "catch_all", risk: "low" }],
    ["x@catchall-medium.test", 200, { result: "catch_all", risk: "medium" }],
    ["x@catchall-high.test", 200, { result: "catch_all", risk: "high" }],
    ["x@disposable.test", 200, { result: "do_not_send", is_disposable_address: true }],
    ["t@timeout.test", 200, { result: "unknown", reason: ["smtp_timeout"] }],
    ["bad1@valid.test", 200, { result: "undeliverable", reason: ["mailbox_does_not_exist"] }],
    ["dns1@valid.test", 200, { result: "do_not_send", reason: ["high_risk_domain"] }],
    ["risky1@valid.test", 200, { result: "deliverable", risk: "high" }],
    ["medium1@valid.test", 200, { result: "deliverable", risk: "medium" }],
    ["weird1@valid.test", 200, { result: "maybe", risk: "odd" }],
    ["temp1@valid.test", 200, { result: "deliverable", risk: "low", is_disposable_address: true, reason: ["mailbox_is_disposable_address"] }],
    ["full1@valid.test", 200, { result: "undeliverable", risk: "medium", reason: ["mailbox_quota_exceeded"] }],
    ["info@role.test", 200, { result: "deliverable", is_role_address: true }],
    ["anna+cv@valid.test", 200, { result: "deliverable", root_address: "anna@valid.test" }],
    ["noatsign", 200, { result: "undeliverable", reason: ["malformed_address"] }],
    ["boom@valid.test", 500, { message: "Internal Server Error" }],
  ];
  it.each(rows)("%s → %i", async (address, status, expected) => {
    const res = await validate(address);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject(expected);
    if (status === 200) expect(res.body.engagement).toEqual({ engaging: false, is_bot: false });
  });

  it("v3shape answers without `result`; a missing or too long address is a 400", async () => {
    const v3 = await validate("v3shape@valid.test");
    expect(v3.status).toBe(200);
    expect("result" in v3.body).toBe(false);
    expect(await validate(null)).toMatchObject({ status: 400, body: { message: "'address' parameter is required" } });
    expect(await validate(`${"a".repeat(600)}@x.test`)).toMatchObject({ status: 400, body: { message: "address exceeds 512 characters" } });
  });

  it("provider_lookup=false answers unknown / no_data for every address", async () => {
    expect((await validate("anna@valid.test", { providerLookup: "false" })).body).toMatchObject({ result: "unknown", reason: ["no_data"] });
  });

  it("greylist: the first answer is unknown, later ones deliverable; a reset starts over", async () => {
    expect((await validate("g@greylist.test")).body).toMatchObject({ result: "unknown" });
    expect((await validate("G@Greylist.test")).body).toMatchObject({ result: "deliverable" });
    fake.reset();
    expect((await validate("g@greylist.test")).body).toMatchObject({ result: "unknown" });
  });

  it("POST reads the address from the form or the query", async () => {
    const form = new URLSearchParams({ address: "bad2@valid.test" });
    const res = await fetch(`${fake.origin}/v4/address/validate?provider_lookup=true`, { method: "POST", headers: auth(), body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ address: "bad2@valid.test", result: "undeliverable" });
    const q = await fetch(`${fake.origin}/v4/address/validate?address=medium2%40valid.test`, { method: "POST", headers: auth() });
    expect(await q.json()).toMatchObject({ result: "deliverable", risk: "medium" });
  });

  it("a sending key or a wrong key gets 401 Invalid private key", async () => {
    expect(await validate("anna@valid.test", { key: "key-fake-sending" })).toMatchObject({ status: 401, body: { message: "Invalid private key" } });
    expect(await validate("anna@valid.test", { key: "key-fake-wrong" })).toMatchObject({ status: 401 });
  });

  it("bulk, preview and every /v3/address/* path stay unrouted", async () => {
    for (const path of ["/v3/address/validate", "/v3/address/private/validate", "/v4/address/validate/bulk/list1", "/v4/address/validate/preview/list1"]) {
      const res = await fetch(`${fake.origin}${path}?address=a@b.test`, { headers: auth() });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 page not found");
    }
  });
});

describe("overrides", () => {
  it("setValidation answers the next `times` calls, then the address's own rule answers again", async () => {
    fake.setValidation("Flaky2@valid.test", { status: 500, times: 2 });
    expect((await validate("flaky2@valid.test")).status).toBe(500);
    expect(await validate("flaky2@valid.test")).toMatchObject({ status: 500, body: { message: "Internal Server Error" } });
    expect(await validate("flaky2@valid.test")).toMatchObject({ status: 200, body: { result: "deliverable" } });
  });

  it("an override without `times` answers every call; one that runs out falls back (boom stays 500)", async () => {
    fake.setValidation("anna@valid.test", { body: { result: "catch_all", risk: "low", reason: [] } });
    for (let i = 0; i < 3; i++) expect((await validate("anna@valid.test")).body).toMatchObject({ result: "catch_all" });
    fake.setValidation("boom@valid.test", { body: { result: "deliverable", risk: "low" }, times: 1 });
    expect((await validate("boom@valid.test")).status).toBe(200);
    expect((await validate("boom@valid.test")).status).toBe(500);
    expect((await validate("boom@valid.test")).status).toBe(500);
  });

  it("the admin mirror POST /__fake/validation", async () => {
    const res = await fetch(`${fake.origin}/__fake/validation`, {
      method: "POST",
      body: JSON.stringify({ address: "ola@valid.test", status: 429, times: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await validate("ola@valid.test")).toMatchObject({ status: 429, body: { message: "Too many requests" } });
    expect((await validate("ola@valid.test")).status).toBe(200);
    const bad = await fetch(`${fake.origin}/__fake/validation`, { method: "POST", body: JSON.stringify({ address: "x@y.test" }) });
    expect(bad.status).toBe(400);
  });
});

describe("switches and faults", () => {
  it("validateEngagement shapes `engagement`; validateDidYouMeanNull adds a null did_you_mean", async () => {
    fake.setSwitches({ validateEngagement: "empty" });
    expect((await validate("anna@valid.test")).body.engagement).toEqual({});
    fake.setSwitches({ validateEngagement: "null" });
    expect((await validate("anna@valid.test")).body.engagement).toBeNull();
    fake.setSwitches({ validateEngagement: "absent" });
    expect("engagement" in (await validate("anna@valid.test")).body).toBe(false);
    fake.setSwitches({ validateEngagement: "object", validateDidYouMeanNull: true });
    const b = (await validate("anna@valid.test")).body;
    expect("did_you_mean" in b && b.did_you_mean === null).toBe(true);
    expect((await validate("x@yaho.test")).body.did_you_mean).toBe("x@yahoo.test");
  });

  it("validateNoRateHeaders drops X-RateLimit-* from answers and faults of this route only", async () => {
    expect((await validate("anna@valid.test")).headers.get("x-ratelimit-reset")).not.toBeNull();
    fake.setSwitches({ validateNoRateHeaders: true });
    expect((await validate("anna@valid.test")).headers.get("x-ratelimit-reset")).toBeNull();
    fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" }, headers: {} });
    const limited = await validate("anna@valid.test");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-ratelimit-reset")).toBeNull();
    const other = await fetch(`${fake.origin}/v5/accounts/http_signing_key`, { headers: auth() });
    expect(other.headers.get("x-ratelimit-reset")).not.toBeNull();
  });

  it("validateMaxActive with validateSlowMs: an extra request in flight gets 429 without a reset header", async () => {
    fake.setSwitches({ validateMaxActive: 2, validateSlowMs: 300 });
    const started = Date.now();
    const answers = await Promise.all([validate("slow1@valid.test"), validate("slow2@valid.test"), validate("slow3@valid.test")]);
    const statuses = answers.map((a) => a.status).sort();
    expect(statuses).toEqual([200, 200, 429]);
    const limited = answers.find((a) => a.status === 429)!;
    expect(limited.body).toEqual({ message: "Too many requests" });
    expect(limited.headers.get("x-ratelimit-reset")).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(fake.state().validations.peakInFlight).toBe(3);
    // Once they are answered, new ones get through again.
    expect((await validate("slow4@valid.test")).status).toBe(200);
  });

  it("a slow address answers after validateSlowMs", async () => {
    fake.setSwitches({ validateSlowMs: 200 });
    const started = Date.now();
    expect((await validate("slow@valid.test")).body).toMatchObject({ result: "deliverable" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it("the delay fault waits, then answers normally or with its `then`", async () => {
    fake.failNext(ROUTE, { kind: "delay", ms: 150 });
    let started = Date.now();
    expect((await validate("anna@valid.test")).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(130);
    fake.failNext(ROUTE, { kind: "delay", ms: 100, then: { kind: "status", status: 503, body: { message: "Service Unavailable" } } });
    started = Date.now();
    expect(await validate("anna@valid.test")).toMatchObject({ status: 503, body: { message: "Service Unavailable" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});

describe("counters", () => {
  it("records every answered request; byAddress and billableThisMonth count 200s only (month of the fake clock)", async () => {
    await validate("anna@valid.test");
    await validate("ANNA@valid.test");
    await validate("boom@valid.test");
    fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" } });
    await validate("ben@valid.test");
    expect(fake.validations.map((v) => [v.address, v.status, v.billable])).toEqual([
      ["anna@valid.test", 200, true],
      ["ANNA@valid.test", 200, true],
      ["boom@valid.test", 500, false],
      ["ben@valid.test", 429, false],
    ]);
    expect(fake.validations[0]!.at).toEqual(new Date("2026-09-30T10:00:00Z"));
    expect(fake.state().validations).toEqual({ billableThisMonth: 2, byAddress: { "anna@valid.test": 2 }, peakInFlight: 1 });

    clock = new Date("2026-10-01T00:30:00Z");
    await validate("ben@valid.test");
    expect(fake.state().validations).toMatchObject({ billableThisMonth: 1, byAddress: { "anna@valid.test": 2, "ben@valid.test": 1 } });
    const state = (await (await fetch(`${fake.origin}/__fake/state`)).json()) as { validations: { billableThisMonth: number } };
    expect(state.validations.billableThisMonth).toBe(1);
  });

  it("the request log keeps the address (the only place it appears) and never the key", async () => {
    await validate("anna@valid.test");
    const req = fake.requests.at(-1)!;
    expect(req.query.address).toEqual(["anna@valid.test"]);
    expect(req.headers.authorization).toBeUndefined();
  });
});

describe("command line switches", () => {
  it("parses the validation switches", () => {
    const opts = parseCliArgs([
      "--switch",
      "validateSlowMs=250",
      "--switch",
      "validateMaxActive=2",
      "--switch",
      "validateEngagement=absent",
      "--switch",
      "validateNoRateHeaders",
      "--switch",
      "validateDidYouMeanNull=true",
    ]);
    expect(opts.switches).toEqual({
      validateSlowMs: 250,
      validateMaxActive: 2,
      validateEngagement: "absent",
      validateNoRateHeaders: true,
      validateDidYouMeanNull: true,
    });
    expect(parseCliArgs(["--switch", "validateMaxActive=null"]).switches).toEqual({ validateMaxActive: null });
    expect(() => parseCliArgs(["--switch", "validateEngagement=weird"])).toThrow(/object, empty, null or absent/);
  });
});
