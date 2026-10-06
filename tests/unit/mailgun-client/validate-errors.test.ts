import { describe, expect, it } from "vitest";
import { classifyStatus, errorText, RETRY_AFTER_DEFAULT_MS, retryAfterHintMs, retryAfterMs } from "@/server/mailgun/errors";
import { MailgunError } from "@/server/mailgun/errors";
import { failureKindOf } from "@/server/verification/mailgun-verifier";

/** Milestone 5 additions to the Mailgun error helpers (M5-DESIGN §2.2, research verification-reference §0.8, §3). */

const NOW = new Date("2026-09-26T10:00:00Z");

describe("errorText reads the `Error` key (mailgun-php reads it on 403s)", () => {
  it("returns Error's text when no other key has one", () => {
    expect(errorText('{"Error":"Forbidden"}')).toBe("Forbidden");
    expect(errorText('{"Error":"  Validations are not enabled  "}')).toBe("Validations are not enabled");
  });

  it("keeps the older keys first and ignores an empty Error", () => {
    expect(errorText('{"message":"m","Error":"e"}')).toBe("m");
    expect(errorText('{"Description":"d","Error":"e"}')).toBe("d");
    expect(errorText('{"Error":"","Field":"address"}')).toBe("invalid field address");
  });

  it("a 403 with an Error body is classified by its text like any other 4xx", () => {
    expect(classifyStatus(403, errorText('{"Error":"Forbidden"}'))).toBe("auth");
    expect(classifyStatus(403, errorText('{"Error":"account disabled"}'))).toBe("not-allowed");
  });
});

describe("retryAfterHintMs: Mailgun's own wait hint, or null", () => {
  it("reads X-RateLimit-Reset (absolute or a delay) and 'try again after N seconds'", () => {
    expect(retryAfterHintMs(new Headers({ "x-ratelimit-reset": String(NOW.getTime() + 5_000) }), "", NOW)).toBe(5_000);
    expect(retryAfterHintMs(new Headers({ "x-ratelimit-reset": "2500" }), "", NOW)).toBe(2_500);
    expect(retryAfterHintMs(new Headers(), "Too many requests, try again after 3 seconds", NOW)).toBe(3_000);
  });

  it("is null without a hint, where retryAfterMs falls back to 60 s", () => {
    expect(retryAfterHintMs(new Headers(), "Too many requests", NOW)).toBeNull();
    expect(retryAfterHintMs(new Headers({ "x-ratelimit-reset": "soon" }), "", NOW)).toBeNull();
    expect(retryAfterMs(new Headers(), "Too many requests", NOW)).toBe(RETRY_AFTER_DEFAULT_MS);
  });

  it("clamps to 1 s–15 min like retryAfterMs", () => {
    expect(retryAfterHintMs(new Headers({ "x-ratelimit-reset": "10" }), "", NOW)).toBe(1_000);
    expect(retryAfterHintMs(new Headers({ "x-ratelimit-reset": String(60 * 60_000) }), "", NOW)).toBe(15 * 60_000);
  });
});

describe("the verifier's failure kinds (§2.2)", () => {
  const err = (status: number | null, kind: ConstructorParameters<typeof MailgunError>[0]["kind"], mailgunMessage = "") =>
    new MailgunError({ kind, status, mailgunMessage, message: "x", endpoint: "GET /v4/address/validate" });

  it("every 400 is rejected, whatever its text (it may echo the address)", () => {
    expect(failureKindOf(err(400, classifyStatus(400, "disabled@firma.de is not a valid address"), "disabled@firma.de is not a valid address"))).toBe("rejected");
    expect(failureKindOf(err(400, classifyStatus(400, "suspended-models.de"), "suspended-models.de"))).toBe("rejected");
    expect(failureKindOf(err(400, "business-verification"))).toBe("rejected");
  });

  it("maps the other kinds", () => {
    expect(failureKindOf(err(413, "rejected"))).toBe("rejected");
    expect(failureKindOf(err(409, "conflict"))).toBe("rejected");
    expect(failureKindOf(err(429, "rate-limited"))).toBe("rate-limited");
    expect(failureKindOf(err(null, "timeout"))).toBe("transient");
    expect(failureKindOf(err(null, "network"))).toBe("transient");
    expect(failureKindOf(err(500, "server"))).toBe("transient");
    expect(failureKindOf(err(200, "unexpected"))).toBe("transient");
    for (const k of ["auth", "payment", "not-allowed", "business-verification", "not-found"] as const) {
      expect(failureKindOf(err(403, k))).toBe(k);
    }
  });
});
