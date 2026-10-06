import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MailgunClient, type MailgunClientOptions } from "@/server/mailgun/client";
import { MailgunError } from "@/server/mailgun/errors";
import { startFakeMailgun } from "../../fake-mailgun/server";

/**
 * MailgunClient.validateAddress against the fake Mailgun server (M5-DESIGN §2.2, §8 P4 tests). No database. A paid
 * call is exactly one request: no retry on a timeout, a 5xx or a 429 (maxRetries 0 on every retry branch).
 */

const KEY = "key-fake-api";
const ROUTE = "GET /v4/address/validate";
const fake = await startFakeMailgun({ domain: "send.example.com" });

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

function client(extra: Partial<MailgunClientOptions> = {}): MailgunClient {
  // retryDelayMs 0: if a retry ever happened, it would happen at once and the request count would show it.
  return new MailgunClient({ apiKey: KEY, region: "EU", baseUrl: fake.origin, retryDelayMs: () => 0, ...extra });
}

async function failure(p: Promise<unknown>): Promise<MailgunError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MailgunError);
    return err as MailgunError;
  }
  throw new Error("expected a MailgunError");
}

const validateRequests = () => fake.requests.filter((r) => r.path === "/v4/address/validate");

describe("validateAddress: the request", () => {
  it("sends GET with the address URL-encoded (anna+cv stays a plus) and provider_lookup=true", async () => {
    const body = await client().validateAddress("anna+cv@x.no");
    expect(body).toMatchObject({ address: "anna+cv@x.no", result: "deliverable", risk: "low", root_address: "anna@x.no" });
    const [req] = validateRequests();
    expect(req).toBeDefined();
    expect(req!.method).toBe("GET");
    expect(req!.query.address).toEqual(["anna+cv@x.no"]);
    expect(req!.query.provider_lookup).toEqual(["true"]);
    expect(req!.headers.authorization).toBeUndefined();
    expect(req!.body).toBeNull();
  });

  it("returns the parsed body as it is, also a v3-shaped one (the mapping decides)", async () => {
    expect(await client().validateAddress("v3shape@valid.test")).toMatchObject({ is_valid: true });
    expect(await client().validateAddress("x@catchall-medium.test")).toMatchObject({ result: "catch_all", risk: "medium" });
  });

  it("never calls the v3 or public validation endpoints", async () => {
    await client().validateAddress("anna@valid.test");
    expect(fake.requests.some((r) => r.path.startsWith("/v3/address"))).toBe(false);
    // …and the fake has no route for them (a stray call would fail loudly).
    const res = await fetch(`${fake.origin}/v3/address/validate?address=a@b.test`, {
      headers: { authorization: "Basic " + Buffer.from(`api:${KEY}`).toString("base64") },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 page not found");
  });
});

describe("validateAddress: exactly one request", () => {
  it("a 500 is thrown after one request (kind server, ambiguous), with an endpoint label without the address", async () => {
    const err = await failure(client().validateAddress("boom@valid.test"));
    expect(err).toMatchObject({ kind: "server", status: 500, endpoint: ROUTE });
    expect(err.message).not.toContain("boom@valid.test");
    expect(err.endpoint).not.toContain("@");
    expect(validateRequests()).toHaveLength(1);
  });

  it("a 429 is thrown after one request, with Mailgun's wait hint", async () => {
    fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" } });
    const err = await failure(client().validateAddress("anna@valid.test"));
    expect(err).toMatchObject({ kind: "rate-limited", status: 429 });
    // The fake's X-RateLimit-Reset is 10 s ahead.
    expect(err.retryAfterMs).toBeGreaterThan(8_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(validateRequests()).toHaveLength(1);
  });

  it("a 429 without any hint carries retryAfterMs null (the check job backs off by itself)", async () => {
    fake.setSwitches({ validateNoRateHeaders: true });
    fake.failNext(ROUTE, { kind: "status", status: 429, body: { message: "Too many requests" }, headers: {} });
    const err = await failure(client().validateAddress("anna@valid.test"));
    expect(err.kind).toBe("rate-limited");
    expect(err.retryAfterMs).toBeNull();
  });

  it("a timeout is thrown after one request (the delay fault above a lowered timeout)", async () => {
    fake.failNext(ROUTE, { kind: "delay", ms: 400 });
    const err = await failure(client({ timeoutMs: 100 }).validateAddress("anna@valid.test"));
    expect(err).toMatchObject({ kind: "timeout", requestStarted: true });
    expect(err.message).not.toContain("anna@valid.test");
    expect(validateRequests()).toHaveLength(1);
  });

  it("the other paths of the client still retry (maxRetries only limits the paid call)", async () => {
    fake.failNext("GET /v5/accounts/http_signing_key", { kind: "status", status: 500, body: { message: "Internal Server Error" } });
    expect(await client().getSigningKey()).toBe("key-fake-signing");
    expect(fake.requests.filter((r) => r.path === "/v5/accounts/http_signing_key")).toHaveLength(2);
  });
});

describe("validateAddress: error kinds", () => {
  it("401 with a wrong or sending key", async () => {
    const err = await failure(client({ apiKey: "key-fake-other" }).validateAddress("anna@valid.test"));
    expect(err).toMatchObject({ kind: "auth", status: 401, mailgunMessage: "Invalid private key" });
  });

  it("402 payment, 403 auth with a message or an `Error` body, 404 not-found", async () => {
    fake.failNext(ROUTE, { kind: "status", status: 402, body: { message: "Payment required" } });
    expect(await failure(client().validateAddress("a@valid.test"))).toMatchObject({ kind: "payment", status: 402 });

    fake.failNext(ROUTE, { kind: "status", status: 403, body: { Error: "Forbidden" } });
    expect(await failure(client().validateAddress("a@valid.test"))).toMatchObject({ kind: "auth", status: 403, mailgunMessage: "Forbidden" });

    fake.failNext(ROUTE, { kind: "status", status: 403, body: { message: "Validations are not enabled for this account" } });
    expect(await failure(client().validateAddress("a@valid.test"))).toMatchObject({
      kind: "auth",
      mailgunMessage: "Validations are not enabled for this account",
    });

    fake.failNext(ROUTE, { kind: "businessVerification" });
    expect(await failure(client().validateAddress("a@valid.test"))).toMatchObject({ kind: "business-verification", status: 403 });

    fake.failNext(ROUTE, { kind: "status", status: 404, body: "404 page not found" });
    expect(await failure(client().validateAddress("a@valid.test"))).toMatchObject({ kind: "not-found", status: 404 });
    expect(validateRequests()).toHaveLength(5);
  });

  it("a 400 for a missing or too long address", async () => {
    const err = await failure(client().validateAddress(""));
    expect(err).toMatchObject({ status: 400, mailgunMessage: "'address' parameter is required" });
    const long = await failure(client().validateAddress(`${"a".repeat(520)}@x.test`));
    expect(long).toMatchObject({ status: 400, mailgunMessage: "address exceeds 512 characters" });
  });
});
