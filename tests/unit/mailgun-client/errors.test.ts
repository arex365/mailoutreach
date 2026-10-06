import { describe, expect, it } from "vitest";
import {
  AUTH_TEXT,
  BUSINESS_VERIFICATION_TEXT,
  MailgunError,
  NETWORK_TEXT,
  REFUSED_TEXT,
  TIMEOUT_TEXT,
  classifyStatus,
  errorText,
  plainMailgunError,
  retryAfterMs,
} from "@/server/mailgun/errors";

const NOW = new Date("2026-09-23T10:00:00Z");

describe("errorText (research §0.4: five error shapes)", () => {
  it("reads message, Reason, Description, Field and plain text", () => {
    expect(errorText('{"message":"Domain not found"}')).toBe("Domain not found");
    expect(errorText('{"Reason":"invalid CNAME record"}')).toBe("invalid CNAME record");
    expect(errorText('{"Description":"Webhook not found"}')).toBe("Webhook not found");
    expect(errorText('{"Field":"url"}')).toBe("invalid field url");
    expect(errorText("Forbidden")).toBe("Forbidden");
    expect(errorText('"quoted"')).toBe("quoted");
    expect(errorText("")).toBe("");
  });

  it("prefers message over the other keys and ignores empty ones", () => {
    expect(errorText('{"message":"","Reason":"r","Description":"d"}')).toBe("r");
    expect(errorText('{"message":"m","Reason":"r"}')).toBe("m");
  });
});

describe("classifyStatus", () => {
  it("checks 429 first: its text also says 'is not allowed to send'", () => {
    expect(
      classifyStatus(429, "Domain example.com is not allowed to send: account-requests-per-sec limit exceeded, try again after 120 seconds"),
    ).toBe("rate-limited");
  });

  it("reads the text on any other 4xx, 400 included", () => {
    expect(classifyStatus(400, "Domain d is not allowed to send: Free accounts are for test purposes only")).toBe("not-allowed");
    expect(classifyStatus(403, "Domain d is not allowed to send: business verification is required")).toBe("business-verification");
    expect(classifyStatus(400, "Business Verification is required")).toBe("business-verification");
    expect(classifyStatus(421, "account disabled")).toBe("not-allowed");
    expect(classifyStatus(403, "suspended")).toBe("not-allowed");
  });

  it("never reads the text of a 5xx or a 3xx: those may hide an accepted email (CRASH-2)", () => {
    expect(classifyStatus(503, "<html>Service temporarily disabled for maintenance</html>")).toBe("server");
    expect(classifyStatus(502, "Domain d is not allowed to send: account suspended")).toBe("server");
    expect(classifyStatus(500, "Business verification is required")).toBe("server");
    expect(classifyStatus(599, "disabled")).toBe("server");
    expect(classifyStatus(302, "disabled")).toBe("unexpected");
  });

  it("maps the plain statuses", () => {
    expect(classifyStatus(401, "Forbidden")).toBe("auth");
    expect(classifyStatus(403, "Forbidden")).toBe("auth");
    expect(classifyStatus(402, "upgrade your account")).toBe("payment");
    expect(classifyStatus(404, "Domain not found")).toBe("not-found");
    expect(classifyStatus(409, "already initiated")).toBe("conflict");
    expect(classifyStatus(400, "to parameter is not a valid address.")).toBe("rejected");
    expect(classifyStatus(422, "")).toBe("rejected");
    expect(classifyStatus(500, "Internal Server Error")).toBe("server");
    expect(classifyStatus(503, "")).toBe("server");
    expect(classifyStatus(302, "")).toBe("unexpected");
  });
});

describe("retryAfterMs (research §0.6)", () => {
  const h = (reset?: string) => new Headers(reset === undefined ? {} : { "X-RateLimit-Reset": reset });

  it("treats values above 10^12 as an absolute epoch in ms", () => {
    expect(retryAfterMs(h(String(NOW.getTime() + 90_000)), "", NOW)).toBe(90_000);
  });

  it("treats smaller values as a delay in ms", () => {
    expect(retryAfterMs(h("5000"), "", NOW)).toBe(5000);
  });

  it("falls back to 'try again after N seconds', then 60 s", () => {
    expect(retryAfterMs(h(), "limit exceeded, try again after 120 seconds", NOW)).toBe(120_000);
    expect(retryAfterMs(h(""), "try again after 1 second", NOW)).toBe(1000);
    expect(retryAfterMs(h("soon"), "no hint", NOW)).toBe(60_000);
  });

  it("clamps to 1 s–15 min", () => {
    expect(retryAfterMs(h("0"), "", NOW)).toBe(1000);
    expect(retryAfterMs(h(String(NOW.getTime() - 5000)), "", NOW)).toBe(1000);
    expect(retryAfterMs(h(String(NOW.getTime() + 3_600_000)), "", NOW)).toBe(15 * 60_000);
    expect(retryAfterMs(h(), "try again after 7200 seconds", NOW)).toBe(15 * 60_000);
  });
});

describe("MailgunError", () => {
  const make = (kind: MailgunError["kind"], status: number | null, requestStarted = true) =>
    new MailgunError({ kind, status, requestStarted, message: "x" });

  it("is ambiguous only for answers that may hide an acceptance", () => {
    expect(make("timeout", null).ambiguous).toBe(true);
    expect(make("network", null).ambiguous).toBe(true);
    expect(make("server", 500).ambiguous).toBe(true);
    expect(make("unexpected", 302).ambiguous).toBe(true);
    expect(make("unexpected", 200).ambiguous).toBe(true);
  });

  it("is always ambiguous for a 5xx or 3xx answer, whatever its kind", () => {
    for (const kind of ["not-allowed", "business-verification", "auth", "rejected", "not-found"] as const) {
      expect(make(kind, 503).ambiguous, kind).toBe(true);
      expect(make(kind, 302).ambiguous, kind).toBe(true);
    }
    expect(make("not-allowed", 503, false).ambiguous).toBe(false);
  });

  it("is never ambiguous for a 4xx or when nothing was sent", () => {
    for (const kind of ["rejected", "auth", "payment", "not-found", "conflict", "rate-limited", "not-allowed", "business-verification"] as const) {
      expect(make(kind, 400).ambiguous).toBe(false);
    }
    expect(make("unexpected", 400).ambiguous).toBe(false);
    expect(make("guard", null, false).ambiguous).toBe(false);
    expect(make("timeout", null, false).ambiguous).toBe(false);
  });

  it("serialises (JSON and stack) without the key or its Basic-auth form", () => {
    const key = "key-fake-0123456789abcdef";
    const basic = Buffer.from("api:" + key).toString("base64");
    const err = new MailgunError({
      kind: "auth",
      status: 401,
      message: `Mailgun answered 401 with Authorization: Basic ${basic} for ${key}`,
      mailgunMessage: `bad key ${key}`,
      body: `{"message":"Invalid private key ${key}","auth":"${basic}"}`,
      endpoint: "GET /v4/domains/x",
      secrets: [key, basic],
    });
    const json = JSON.stringify(err);
    for (const text of [json, String(err.stack), err.message, err.mailgunMessage, err.bodySnippet]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(basic);
    }
    expect(JSON.parse(json)).toMatchObject({ name: "MailgunError", kind: "auth", status: 401, requestStarted: true, ambiguous: false });
  });

  it("keeps the body snippet short", () => {
    const err = new MailgunError({ kind: "server", status: 500, message: "x", body: "y".repeat(10_000) });
    expect(err.bodySnippet.length).toBeLessThanOrEqual(1000);
  });
});

describe("plainMailgunError (§5.9)", () => {
  const err = (kind: MailgunError["kind"], extra: Partial<ConstructorParameters<typeof MailgunError>[0]> = {}) =>
    new MailgunError({ kind, status: 400, message: "technical", ...extra });

  it("uses the owner's wording", () => {
    expect(plainMailgunError(err("auth", { status: 401 }), {})).toBe(AUTH_TEXT);
    expect(plainMailgunError(err("business-verification", { status: 403 }), {})).toBe(BUSINESS_VERIFICATION_TEXT);
    expect(plainMailgunError(err("not-allowed"), { domain: "send.example.com" })).toBe(
      "Mailgun won't send from send.example.com right now. Check the banner in Mailgun, then click Resume.",
    );
    expect(plainMailgunError(err("timeout", { status: null }), {})).toBe(TIMEOUT_TEXT);
    expect(plainMailgunError(err("network", { status: null }), {})).toBe(NETWORK_TEXT);
    expect(plainMailgunError(err("rejected"), {})).toBe(REFUSED_TEXT);
    expect(plainMailgunError(err("conflict", { status: 409 }), {})).toBe(REFUSED_TEXT);
  });

  it("says which region to pick on a domain 404", () => {
    const e = err("not-found", { status: 404, mailgunMessage: "Domain not found" });
    expect(plainMailgunError(e, { domain: "mail.example.com", region: "EU" })).toBe(
      "Mailgun can't find mail.example.com in the EU region. If you created the domain in the US region, change Region to US.",
    );
    expect(plainMailgunError(e, { domain: "mail.example.com", region: "US" })).toContain("change Region to EU");
    expect(plainMailgunError(err("not-found", { status: 404, mailgunMessage: "Route not found" }), { domain: "d.com", region: "EU" })).toBe(
      REFUSED_TEXT,
    );
  });

  it("names the retry time for a rate limit in the cap-day zone", () => {
    const e = err("rate-limited", { status: 429, retryAfterMs: 5 * 60_000 });
    // 10:00Z + 5 min = 15:05 in Karachi (UTC+5)
    expect(plainMailgunError(e, { now: NOW })).toBe("Mailgun asked us to slow down; trying again at 15:05.");
    expect(plainMailgunError(e, { now: NOW, timeZone: "Europe/Berlin" })).toBe("Mailgun asked us to slow down; trying again at 12:05.");
  });

  it("passes our own sentences through for errors raised before any request", () => {
    const guard = new MailgunError({
      kind: "guard",
      requestStarted: false,
      message: "Stopped by the test-list guard: a@x.com isn't on your test list.",
    });
    expect(plainMailgunError(guard, {})).toBe("Stopped by the test-list guard: a@x.com isn't on your test list.");
    const testKey = new MailgunError({ kind: "auth", requestStarted: false, message: "This is a test key. Paste the key from Mailgun › API Security." });
    expect(plainMailgunError(testKey, {})).toBe("This is a test key. Paste the key from Mailgun › API Security.");
  });
});
