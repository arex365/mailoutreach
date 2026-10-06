import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLAN_TEXTS } from "@/core/mailgun/plan";
import { MailgunClient } from "@/server/mailgun/client";
import { MailgunError, classifyStatus, isAuthorizedOnlyRefusal, plainMailgunError } from "@/server/mailgun/errors";
import type { SendMessageInput } from "@/server/mailgun/types";
import { catchUpErrorKind } from "@/server/services/mailgun/catch-up";
import { failureKindOf } from "@/server/verification/mailgun-verifier";

/**
 * A send refused because the plan's sending limit is reached (docs/dev/MAIN-DOMAIN-DESIGN.md O24, O25, §2.8, §8 P1): the
 * "limit" kind exists only for a 400 or 403 to POST /v3/{d}/messages (`classifyStatus(…, { send: true })`, set by
 * `MailgunClient.sendMessage` alone), so every other endpoint keeps exactly today's kinds. A free account limited to
 * authorized recipients stays "not-allowed" with its own sentence, which never suggests authorizing a prospect.
 */

const LIMIT_400 = "Domain example.com has reached its daily sending limit of 100 messages.";
const AUTHORIZED_403 =
  "Domain example.com is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.";

describe("classifyStatus with { send: true }", () => {
  const send = (status: number, text: string) => classifyStatus(status, text, { send: true });

  it("a 400 or 403 that says the plan's sending limit is reached → limit", () => {
    expect(send(400, LIMIT_400)).toBe("limit");
    expect(send(403, "sending quota exceeded")).toBe("limit");
    expect(send(400, "Free accounts are limited to 100 messages per day")).toBe("limit");
    expect(send(403, "Account limit reached")).toBe("limit");
    expect(send(400, "Your plan limit has been reached")).toBe("limit");
    expect(send(403, "You exceeded your message quota")).toBe("limit");
  });

  it("limits about one message stay rejected (size, recipients per message), and bare 'limit reached' too", () => {
    expect(send(400, "Message size limit exceeded")).toBe("rejected");
    expect(send(400, "Recipient limit exceeded: 1000 recipients per message")).toBe("rejected");
    expect(send(400, "limit reached")).toBe("rejected");
    expect(send(400, "Attachment quota exceeded")).toBe("rejected");
  });

  it("the free-account refusal stays not-allowed, and is recognised as authorized-recipients only", () => {
    expect(send(403, AUTHORIZED_403)).toBe("not-allowed");
    expect(isAuthorizedOnlyRefusal(AUTHORIZED_403)).toBe(true);
    expect(isAuthorizedOnlyRefusal("Sandbox subdomains are for test purposes only. Please add your own domain or add the address to authorized recipients in Account Settings.")).toBe(true);
    expect(isAuthorizedOnlyRefusal("Domain example.com is not allowed to send: domain is disabled")).toBe(false);
    expect(isAuthorizedOnlyRefusal("")).toBe(false);
  });

  it("the earlier rules still win: business verification, 429, 5xx; and other statuses keep their kinds", () => {
    expect(send(403, "Please complete business verification: your daily sending limit is on hold")).toBe("business-verification");
    expect(send(429, "Rate limit exceeded: daily sending limit")).toBe("rate-limited");
    expect(send(500, "daily sending limit")).toBe("server");
    expect(send(402, "quota")).toBe("payment");
    expect(send(401, "daily sending limit")).toBe("auth");
    expect(send(404, "daily sending limit")).toBe("not-found");
  });
});

describe("classifyStatus without { send } (every other endpoint): today's kinds", () => {
  it("never answers limit", () => {
    expect(classifyStatus(402, "quota")).toBe("payment");
    expect(classifyStatus(403, "limit reached")).toBe("auth");
    expect(classifyStatus(400, "daily sending limit")).toBe("rejected");
    expect(classifyStatus(400, LIMIT_400)).toBe("rejected");
    expect(classifyStatus(403, "sending quota exceeded")).toBe("auth");
    expect(classifyStatus(403, LIMIT_400, { send: false })).toBe("auth");
    expect(classifyStatus(403, AUTHORIZED_403)).toBe("not-allowed");
  });
});

describe("plainMailgunError", () => {
  it("limit → the plan sentence", () => {
    const err = new MailgunError({ kind: "limit", status: 400, mailgunMessage: LIMIT_400, message: `Mailgun answered 400: ${LIMIT_400}` });
    expect(plainMailgunError(err)).toBe(PLAN_TEXTS.limitRefused);
  });

  it("the authorized-recipients refusal → the campaign sentence, which never suggests authorizing an address", () => {
    const err = new MailgunError({ kind: "not-allowed", status: 403, mailgunMessage: AUTHORIZED_403, message: "x" });
    expect(plainMailgunError(err, { domain: "example.com" })).toBe(PLAN_TEXTS.authorizedOnlyCampaign);
    expect(PLAN_TEXTS.authorizedOnlyCampaign).not.toMatch(/Authorized recipients/);
    // Found in the technical message too (no Mailgun text kept).
    expect(plainMailgunError(new MailgunError({ kind: "not-allowed", status: 403, message: `Mailgun answered 403: ${AUTHORIZED_403}` }))).toBe(
      PLAN_TEXTS.authorizedOnlyCampaign,
    );
    // Any other "not allowed" keeps today's sentence.
    const other = new MailgunError({ kind: "not-allowed", status: 403, mailgunMessage: "Domain example.com is disabled", message: "x" });
    expect(plainMailgunError(other, { domain: "example.com" })).toBe("Mailgun won't send from example.com right now. Check the banner in Mailgun, then click Resume.");
  });
});

// ───────────────────────── through the client ─────────────────────────

/** A client whose every request answers `status` with `{ message: text }`. */
function answering(status: number, text: string) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify({ message: text }), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new MailgunClient({ apiKey: "key-fake-api", region: "US", baseUrl: "http://127.0.0.1:9", retryDelayMs: () => 0, fetchImpl });
  return { client, calls };
}

function msg(): SendMessageInput {
  return {
    from: "Ali from Polygon Paradise <ali@example.com>",
    to: "tester@gmail.com",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: `pp.${crypto.randomBytes(12).toString("hex")}@example.com`,
    tags: ["outreach", "step-0"],
    variables: {},
    purpose: "campaign",
    guard: { goLive: false, testList: new Set(["tester@gmail.com"]) },
  };
}

async function caught(p: Promise<unknown>): Promise<MailgunError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailgunError);
  return err as MailgunError;
}

describe("only the client's send path classifies with { send: true }", () => {
  it("a send answered 400 with the limit text is kind limit; the same text on Logs, the address check or Apply keeps today's kind", async () => {
    const sent = answering(400, LIMIT_400);
    expect((await caught(sent.client.sendMessage("example.com", msg()))).kind).toBe("limit");
    expect(sent.calls).toEqual(["POST /v3/example.com/messages"]);

    // Apply's tracking settings (a PUT) and the domain read: 400 → rejected, never limit.
    expect((await caught(answering(400, LIMIT_400).client.setOpenTracking("example.com", false))).kind).toBe("rejected");
    expect((await caught(answering(400, LIMIT_400).client.getDomain("example.com"))).kind).toBe("rejected");
  });

  it("app-mode regression: the verifier's failureKindOf and the catch-up's catchUpErrorKind give today's answers", async () => {
    // The address check (a 402 "quota" and a 403 limit text): payment / auth, as before.
    const quota = await caught(answering(402, "quota exceeded").client.validateAddress("anna@firma.de"));
    expect(quota.kind).toBe("payment");
    expect(failureKindOf(quota)).toBe("payment");
    const limited = await caught(answering(403, "sending quota exceeded").client.validateAddress("anna@firma.de"));
    expect(limited.kind).toBe("auth");
    expect(failureKindOf(limited)).toBe("auth");
    const refused = await caught(answering(400, LIMIT_400).client.validateAddress("anna@firma.de"));
    expect(failureKindOf(refused)).toBe("rejected");

    // A Logs-style read answered 403 with limit words: "auth", so the catch-up still pauses for the key.
    const logs = await caught(answering(403, "daily sending limit reached").client.getSigningKey());
    expect(logs.kind).toBe("auth");
    expect(catchUpErrorKind(logs)).toBe("auth");
    const logs400 = await caught(answering(400, LIMIT_400).client.getSigningKey());
    expect(catchUpErrorKind(logs400)).toBe("other");
  });

  it("a send answered 403 with the free-account text is not-allowed; a 429 stays rate-limited", async () => {
    const auth = await caught(answering(403, AUTHORIZED_403).client.sendMessage("example.com", msg()));
    expect(auth.kind).toBe("not-allowed");
    expect(plainMailgunError(auth)).toBe(PLAN_TEXTS.authorizedOnlyCampaign);
    const slow = await caught(answering(429, "Too many requests: daily sending limit").client.sendMessage("example.com", msg()));
    expect(slow.kind).toBe("rate-limited");
  });
});
