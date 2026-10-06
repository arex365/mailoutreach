import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The Mailgun verifier when the answer itself breaks (M5-DESIGN §2.2, §2.3, §0.2 rule 11): once Mailgun has answered
 * 200 the validation is done and billed, so a body that breaks off or stalls is an answer we can't read (stored with
 * its cost, never asked again at once), while a 5xx whose body breaks stays a failure Mailgun didn't bill. No network:
 * an injected fetch answers, and the base URL is a loopback address it never reaches.
 */

const t = await createTestDb("verification-verifier-answers");
const { db } = await import("@/server/db");
const { createMailgunVerifier, answeredBeforeFailing } = await import("@/server/verification/mailgun-verifier");
const { MailgunError } = await import("@/server/mailgun/errors");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

type Mode = "cut" | "stall";

/** A fetch whose answer has `status` and a body that breaks off after a few bytes, or never ends until aborted. */
function answering(status: number, mode: Mode, seen: { calls: number }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.calls += 1;
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"address":"anna@firma.de","result":"deliv'));
        if (mode === "cut") controller.error(new TypeError("terminated"));
        else signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function verifier(fetchImpl: typeof fetch, timeoutMs = 2_000) {
  return createMailgunVerifier({ apiKey: "key-fake-verify", region: "EU", baseUrl: "http://127.0.0.1:9", pricePerCheck: 0.012, timeoutMs, fetchImpl });
}

describe("an answer that breaks off", () => {
  it("a 200 whose body breaks off is an answer we can't read (billed), not a quiet failure to ask again", async () => {
    const seen = { calls: 0 };
    const out = await verifier(answering(200, "cut", seen)).check("anna@firma.de", "anna@firma.de");
    expect(out).toMatchObject({
      ok: true,
      unreadable: true,
      result: { status: "UNKNOWN", risk: "UNKNOWN", reasons: ["app:unreadable_response"] },
    });
    expect(seen.calls).toBe(1);
  });

  it("a 200 whose body stalls past the check's own timeout is billed too", async () => {
    const seen = { calls: 0 };
    const out = await verifier(answering(200, "stall", seen), 50).check("anna@firma.de", "anna@firma.de");
    expect(out).toMatchObject({ ok: true, unreadable: true });
    expect(seen.calls).toBe(1);
  });

  it("a 500 whose body breaks off stays a failure Mailgun didn't bill (tried again later)", async () => {
    const seen = { calls: 0 };
    const out = await verifier(answering(500, "cut", seen)).check("anna@firma.de", "anna@firma.de");
    expect(out).toMatchObject({ ok: false, kind: "transient", timedOut: false });
    expect(seen.calls).toBe(1);
  });

  it("tells an answer that arrived from one that never did", () => {
    expect(answeredBeforeFailing(new MailgunError({ kind: "network", status: 200, message: "terminated" }))).toBe(true);
    expect(answeredBeforeFailing(new MailgunError({ kind: "timeout", status: 204, message: "stalled" }))).toBe(true);
    expect(answeredBeforeFailing(new MailgunError({ kind: "timeout", status: null, message: "no answer" }))).toBe(false);
    expect(answeredBeforeFailing(new MailgunError({ kind: "network", status: 502, message: "bad gateway" }))).toBe(false);
  });
});
