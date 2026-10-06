import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLAN_TEXTS } from "@/core/mailgun/plan";
import { MailgunError } from "@/server/mailgun/errors";
import { SEND_OPTIONS_MAX_BYTES, type MailgunClient } from "@/server/mailgun/client";
import type { MailgunContext } from "@/server/mailgun/context";
import type { SendMessageInput } from "@/server/mailgun/types";
import {
  AUTH_PAUSE_FIX,
  MailgunTransport,
  SENDER_HEADERS_PAUSE,
  SENDING_KEY_TEAM_FROM_FIX,
  buildSendInput,
  domainOfAddress,
  fromAddressOf,
  isOwnMailboxBlock,
  mailgunFailure,
  ownMailboxBlocked,
  sendOptionBytes,
} from "@/server/services/sending/mailgun-transport";
import { TransportError, failureText, type OutgoingMessage, type TransportFailure } from "@/server/services/sending/transport";

/**
 * The Mailgun transport's pure parts (M3-DESIGN §4.3.1): the request built for one campaign email, the size check
 * of its extra fields, and how every Mailgun error maps to what the sending loop does. Plus the shared From address's
 * checks in `send()` (SHARED-FROM-DESIGN §2.3, §2.4), with the SendingDomain lookup and the Mailgun client stubbed:
 * which domain an email goes through, the fail-closed sender check, and the sending-key sentence.
 */

/** The SendingDomain rows `send()` looks up (only send.example.com is connected). */
const domainRows = vi.hoisted(() => new Map<string, { name: string; region: string }>([["send.example.com", { name: "send.example.com", region: "EU" }]]));
vi.mock("@/server/db", () => ({
  db: { sendingDomain: { findUnique: async (args: { where: { name: string } }) => domainRows.get(args.where.name) ?? null } },
  dbWrite: vi.fn(),
  dbTx: vi.fn(),
  withWriteLock: vi.fn(),
}));

const guard = { goLive: false, testList: new Set(["anna@kunde.de"]) };
const NOW = new Date("2026-09-23T08:00:00Z");
const ctx = { domain: "send.example.com", now: NOW };

function message(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    emailId: 7,
    campaignId: 12,
    step: 0,
    from: "Ali from Polygon Paradise <ali@send.example.com>",
    to: "Anna@Kunde.de",
    toNorm: "anna@kunde.de",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: "pp.abc@send.example.com",
    inReplyTo: null,
    references: null,
    sendId: "0123456789abcdef",
    ...over,
  };
}

function mgError(kind: ConstructorParameters<typeof MailgunError>[0]["kind"], over: Partial<ConstructorParameters<typeof MailgunError>[0]> = {}) {
  return new MailgunError({ kind, message: `technical ${kind}`, mailgunMessage: `Mailgun says ${kind}`, ...over });
}

describe("addresses", () => {
  it("takes the address from a From line, and the domain from an address", () => {
    expect(fromAddressOf("Ali <Ali@Send.Example.com>")).toBe("ali@send.example.com");
    expect(fromAddressOf("ali@send.example.com")).toBe("ali@send.example.com");
    expect(domainOfAddress("ali@send.example.com")).toBe("send.example.com");
    expect(domainOfAddress("no-at-sign")).toBeNull();
    expect(domainOfAddress("@send.example.com")).toBeNull();
  });
});

describe("buildSendInput", () => {
  it("sends to the bare normalised address with our tags, opaque variables and test mode for TEST", () => {
    const input = buildSendInput(message(), "TEST", guard);
    expect(input).toMatchObject({
      from: "Ali from Polygon Paradise <ali@send.example.com>",
      to: "anna@kunde.de",
      messageId: "pp.abc@send.example.com",
      tags: ["outreach", "step-0"],
      variables: { send_id: "0123456789abcdef", campaign_id: "12", step: "0" },
      testMode: true,
      purpose: "campaign",
      replyTo: null,
      guard,
    });
    expect(buildSendInput(message({ step: 2 }), "LIVE", guard)).toMatchObject({ testMode: false, tags: ["outreach", "step-2"] });
  });

  it("M6-DESIGN §2.3: carries the message's testListOnly for the client's guard; test mode and a missing flag stay test-list only", () => {
    // A live campaign launched after go-live.
    expect(buildSendInput(message({ testListOnly: false }), "LIVE", guard).testListOnly).toBe(false);
    // A live campaign launched before go-live.
    expect(buildSendInput(message({ testListOnly: true }), "LIVE", guard).testListOnly).toBe(true);
    // No flag: fail closed.
    expect(buildSendInput(message(), "LIVE", guard).testListOnly).toBe(true);
    // Mailgun's test mode never reaches anyone else (G3), whatever the message says.
    for (const testListOnly of [false, true, undefined]) {
      expect(buildSendInput(message({ testListOnly }), "TEST", guard)).toMatchObject({ testMode: true, testListOnly: true });
    }
  });

  it("SHARED-FROM §2.3: passes the row's Reply-To (h:Reply-To), which counts toward the extra fields", () => {
    const team = buildSendInput(message({ from: "Ali from Polygon Paradise <contact@example.com>", replyTo: "ali@send.example.com" }), "LIVE", guard);
    expect(team).toMatchObject({ from: "Ali from Polygon Paradise <contact@example.com>", replyTo: "ali@send.example.com" });
    const own = buildSendInput(message(), "LIVE", guard);
    expect(sendOptionBytes(team)).toBe(sendOptionBytes(own) + "h:Reply-To".length + "ali@send.example.com".length);
  });

  it("the flag isn't one of the fields Mailgun gets", () => {
    const open = buildSendInput(message({ testListOnly: false }), "LIVE", guard);
    const closed = buildSendInput(message({ testListOnly: true }), "LIVE", guard);
    expect(sendOptionBytes(open)).toBe(sendOptionBytes(closed));
  });

  it("refuses anything that isn't one bare address (nothing is sent)", () => {
    for (const bad of [
      { to: "anna@kunde.de, bob@kunde.de", toNorm: "anna@kunde.de, bob@kunde.de" },
      { to: "Anna <anna@kunde.de>", toNorm: "<anna@kunde.de>" },
      { to: "bob@kunde.de", toNorm: "anna@kunde.de" },
      { to: "", toNorm: "" },
    ]) {
      try {
        buildSendInput(message(bad), "LIVE", guard);
        throw new Error("expected a refusal");
      } catch (err) {
        expect(err).toBeInstanceOf(TransportError);
        expect((err as TransportError).failure).toEqual({ kind: "rejected", message: "This email's address isn't a single valid address.", detail: null });
      }
    }
  });
});

describe("sendOptionBytes", () => {
  it("counts every o:, h: and v: field Mailgun gets, with the angle brackets", () => {
    const input = buildSendInput(message(), "LIVE", guard);
    const expected =
      "h:Message-Id".length +
      "<pp.abc@send.example.com>".length +
      "o:tracking-opens".length +
      2 +
      "o:tracking-clicks".length +
      2 +
      ("o:tag".length + "outreach".length) +
      ("o:tag".length + "step-0".length) +
      ("v:send_id".length + 16) +
      ("v:campaign_id".length + 2) +
      ("v:step".length + 1);
    expect(sendOptionBytes(input)).toBe(expected);
    expect(sendOptionBytes({ ...input, testMode: true })).toBe(expected + "o:testmode".length + 3);
  });

  it("grows with a long References header, past Mailgun's 16 KB", () => {
    const refs = Array.from({ length: 400 }, (_, i) => `pp.${"x".repeat(30)}${i}@send.example.com`).join(" ");
    const input = buildSendInput(message({ references: refs, inReplyTo: "pp.prev@send.example.com" }), "LIVE", guard);
    expect(sendOptionBytes(input)).toBeGreaterThan(SEND_OPTIONS_MAX_BYTES);
  });
});

describe("mailgunFailure", () => {
  it("maps each Mailgun answer to what the loop does", () => {
    expect(mailgunFailure(mgError("guard", { requestStarted: false }), ctx)).toEqual({ kind: "blocked", message: "technical guard", guard: true });
    expect(mailgunFailure(mgError("rejected", { status: 400 }), ctx)).toEqual({
      kind: "rejected",
      message: "Mailgun says rejected",
      detail: "technical rejected",
    });
    expect(mailgunFailure(mgError("rate-limited", { status: 429, retryAfterMs: 90_000 }), ctx)).toEqual({
      kind: "rate-limited",
      retryAt: new Date(NOW.getTime() + 90_000),
      message: "Mailgun says rate-limited",
    });
    expect(mailgunFailure(mgError("rate-limited", { status: 429 }), ctx)).toMatchObject({ retryAt: new Date(NOW.getTime() + 60_000) });
    expect(mailgunFailure(mgError("not-found", { status: 404 }), ctx)).toEqual({ kind: "not-found", message: "Mailgun says not-found" });
  });

  it("pauses for the key, business verification, a domain Mailgun won't send from, and account problems", () => {
    expect(mailgunFailure(mgError("auth", { status: 401 }), ctx)).toEqual({
      kind: "pause",
      pause: "mailgun-auth",
      reason: "Mailgun didn't accept the API key",
      fixText: AUTH_PAUSE_FIX,
      mailgunMessage: "Mailgun says auth",
    });
    expect(mailgunFailure(mgError("auth", { requestStarted: false, message: "The saved key can't be read." }), ctx)).toMatchObject({
      pause: "mailgun-auth",
      fixText: "The saved key can't be read. Then click Resume.",
    });
    expect(mailgunFailure(mgError("business-verification", { status: 403 }), ctx)).toMatchObject({
      kind: "pause",
      pause: "mailgun-verification",
      reason: "Mailgun business verification",
    });
    expect(mailgunFailure(mgError("not-allowed", { status: 400 }), ctx)).toMatchObject({
      kind: "pause",
      pause: "mailgun-not-allowed",
      reason: "Mailgun won't send from send.example.com",
      fixText: "Mailgun won't send from send.example.com right now. Check the banner in Mailgun, then click Resume.",
    });
    for (const kind of ["payment", "conflict"] as const) {
      expect(mailgunFailure(mgError(kind, { status: kind === "payment" ? 402 : 409 }), ctx)).toMatchObject({
        kind: "pause",
        pause: "mailgun-settings",
        reason: "Mailgun won't send for your account right now",
      });
    }
  });

  it("treats timeouts, dropped connections, 5xx and anything unexpected as 'may have been sent'", () => {
    for (const kind of ["timeout", "network", "server", "unexpected"] as const) {
      expect(mailgunFailure(mgError(kind, { status: kind === "server" ? 502 : null }), ctx)).toEqual({ kind: "ambiguous", message: `technical ${kind}` });
    }
    expect(mailgunFailure(new Error("socket hang up"), ctx)).toEqual({
      kind: "ambiguous",
      message: "Unexpected problem while handing the email to Mailgun: socket hang up",
    });
  });

  it("a 5xx or 3xx answer is 'may have been sent' whatever its kind, never a pause or a refusal (CRASH-2)", () => {
    for (const kind of ["not-allowed", "business-verification", "auth", "rejected", "not-found", "payment"] as const) {
      for (const status of [503, 302]) {
        expect(mailgunFailure(mgError(kind, { status }), ctx), `${kind} ${status}`).toEqual({ kind: "ambiguous", message: `technical ${kind}` });
      }
    }
  });

  it("an error raised before any request is 'blocked': nothing left this PC", () => {
    expect(mailgunFailure(mgError("network", { requestStarted: false }), ctx)).toEqual({ kind: "blocked", message: "technical network" });
  });

  it("SHARED-FROM §2.4: the client's sender check (kind 'sender') is the sender pause, never the test-list guard", () => {
    const f = mailgunFailure(mgError("sender", { requestStarted: false, message: "Stopped by the sender check: x" }), ctx);
    expect(f).toEqual({ kind: "blocked", message: "Stopped by the sender check: x", pause: SENDER_HEADERS_PAUSE });
    expect(f.kind === "blocked" && f.guard).toBeFalsy();
    expect(SENDER_HEADERS_PAUSE).toEqual({
      kind: "mailgun-settings",
      reason: "an email's From or reply address doesn't fit the sending domain",
      fixText:
        "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then click Resume.",
    });
  });

  it("SHARED-FROM §2.4: a key refused for a shared-From email sent with the domain sending key adds the sending-key sentence", () => {
    const refused = mgError("auth", { status: 401 });
    expect(mailgunFailure(refused, { ...ctx, teamFromWithSendingKey: true })).toMatchObject({
      pause: "mailgun-auth",
      fixText:
        AUTH_PAUSE_FIX +
        " If this started after the From address was set, remove the domain sending key (Settings › Sending & Mailgun › Advanced › Remove the sending key) and click Resume: the API key sends then.",
    });
    expect(SENDING_KEY_TEAM_FROM_FIX.startsWith(" If this started")).toBe(true);
    // Review SCREENS-01: it names the button that removes only the sending key, which the connection form shows.
    expect(SENDING_KEY_TEAM_FROM_FIX).toContain("› Advanced › Remove the sending key)");
    // Per-person mode, or no sending key: exactly as before.
    expect(mailgunFailure(refused, { ...ctx, teamFromWithSendingKey: false })).toMatchObject({ fixText: AUTH_PAUSE_FIX });
    expect(mailgunFailure(refused, ctx)).toMatchObject({ fixText: AUTH_PAUSE_FIX });
    // A key that couldn't even be used (no request) keeps its own sentence.
    expect(mailgunFailure(mgError("auth", { requestStarted: false, message: "The saved key can't be read." }), { ...ctx, teamFromWithSendingKey: true })).toMatchObject({
      fixText: "The saved key can't be read. Then click Resume.",
    });
  });

  it("every failure has a plain sentence", () => {
    expect(failureText(mailgunFailure(mgError("auth", { status: 401 }), ctx))).toBe("Mailgun says auth");
    expect(
      failureText({ kind: "pause", pause: "mailgun-settings", reason: "Mailgun won't send for your account right now", fixText: "x", mailgunMessage: "" }),
    ).toBe("Mailgun won't send for your account right now");
    expect(failureText({ kind: "rejected", message: "Mailgun says no", detail: null })).toBe("Mailgun says no");
  });
});

// ───────────────────────── send(): the shared From address (SHARED-FROM-DESIGN §2.3, §2.4) ─────────────────────────

type StubClient = { calls: Array<{ domain: string; input: SendMessageInput }>; failWith: unknown; sendMessage: MailgunClient["sendMessage"]; forRegion: () => StubClient };

/** A Mailgun client that records every send (and answers with its own Message-ID), or throws `failWith`. */
function stubClient(): StubClient {
  const c: StubClient = {
    calls: [],
    failWith: null,
    sendMessage: async (domain: string, input: SendMessageInput) => {
      c.calls.push({ domain, input });
      if (c.failWith) throw c.failWith;
      return { id: input.messageId, message: "Queued. Thank you." };
    },
    forRegion: () => c,
  };
  return c;
}

function transport(opts: { sendingKey?: boolean } = {}) {
  const client = stubClient();
  const sendClient = opts.sendingKey ? stubClient() : client;
  const context = {
    connected: true,
    domain: "send.example.com",
    region: "EU",
    domainId: 1,
    client: client as unknown as MailgunClient,
    sendClient: sendClient as unknown as MailgunClient,
    fakeMode: false,
    replies: "app",
    ownFrom: null,
    ownMailboxFrom: null,
  } satisfies MailgunContext;
  return { t: new MailgunTransport({ mode: "LIVE", context, guard, now: () => NOW }), client, sendClient };
}

/** A shared-From email: From contact@example.com, Reply-To Ali's own address, Message-ID on the sending domain. */
const TEAM = { from: "Ali from Polygon Paradise <contact@example.com>", replyTo: "ali@send.example.com" };

async function failureOf(p: Promise<unknown>): Promise<TransportFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TransportError);
  return (err as TransportError).failure;
}

describe("MailgunTransport.send", () => {
  it("per-person mode: goes through the From's domain with no Reply-To, as before", async () => {
    const { t, client } = transport();
    const res = await t.send(message({ testListOnly: true }));
    expect(res).toEqual({ providerId: "pp.abc@send.example.com", acceptedAt: NOW });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.domain).toBe("send.example.com");
    expect(client.calls[0]!.input).toMatchObject({ from: "Ali from Polygon Paradise <ali@send.example.com>", replyTo: null });
  });

  it("a shared-From email goes through the sending domain with the From line and h:Reply-To", async () => {
    const { t, client } = transport();
    await t.send(message(TEAM));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.domain).toBe("send.example.com");
    expect(client.calls[0]!.input).toMatchObject({
      from: "Ali from Polygon Paradise <contact@example.com>",
      replyTo: "ali@send.example.com",
      messageId: "pp.abc@send.example.com",
    });
  });

  it("a shared-From email that lost its Reply-To names the main domain, which isn't connected: NOT_ON_DOMAIN, nothing sent", async () => {
    const { t, client } = transport();
    const f = await failureOf(t.send(message({ ...TEAM, replyTo: null })));
    expect(f).toMatchObject({ kind: "blocked", pause: { kind: "mailgun-settings", reason: "a sender's address isn't on a sending domain" } });
    expect(client.calls).toHaveLength(0);
  });

  it("a From on an unrelated domain (or a Reply-To off the domain) with the route on the sending domain: the sender pause, nothing sent", async () => {
    const { t, client } = transport();
    for (const bad of [
      { from: "Anna <anna@firma.de>", replyTo: "ali@send.example.com" },
      { from: "Ali <contact@www.example.com>", replyTo: "ali@send.example.com" },
    ]) {
      const f = await failureOf(t.send(message(bad)));
      expect(f, bad.from).toEqual({ kind: "blocked", message: expect.stringMatching(/^Stopped by the sender check: /), pause: SENDER_HEADERS_PAUSE });
      expect(f.kind === "blocked" && f.guard).toBeFalsy();
    }
    expect(client.calls).toHaveLength(0);
  });

  it("a shared-From email whose Message-ID is on another domain: the sender pause, nothing sent", async () => {
    const { t, client } = transport();
    for (const messageId of ["pp.abc@dry-run.invalid", "pp.abc@example.com", "pp.abc@old.example.com"]) {
      const f = await failureOf(t.send(message({ ...TEAM, messageId })));
      expect(f, messageId).toEqual({ kind: "blocked", message: "Stopped by the sender check: the Message-ID isn't on send.example.com.", pause: SENDER_HEADERS_PAUSE });
    }
    expect(client.calls).toHaveLength(0);
    // Per-person rows are never judged by their Message-ID here (their headers and id come from the same snapshot).
    const own = transport();
    await own.t.send(message({ messageId: "pp.abc@dry-run.invalid" }));
    expect(own.client.calls).toHaveLength(1);
  });

  it("the client's own sender refusal becomes the same pause", async () => {
    const { t, client } = transport();
    client.failWith = new MailgunError({ kind: "sender", requestStarted: false, message: "Stopped by the sender check: no.", mailgunMessage: "" });
    expect(await failureOf(t.send(message(TEAM)))).toEqual({ kind: "blocked", message: "Stopped by the sender check: no.", pause: SENDER_HEADERS_PAUSE });
  });

  it("a key refused while the domain sending key sends a shared-From email: the key pause with the sending-key sentence", async () => {
    const withKey = transport({ sendingKey: true });
    withKey.sendClient.failWith = new MailgunError({ kind: "auth", status: 401, message: "401", mailgunMessage: "Forbidden" });
    expect(await failureOf(withKey.t.send(message(TEAM)))).toMatchObject({ pause: "mailgun-auth", fixText: AUTH_PAUSE_FIX + SENDING_KEY_TEAM_FROM_FIX });
    expect(withKey.client.calls).toHaveLength(0);
    // Per-person email with the same key, or a shared-From email with the API key: the plain key sentence.
    expect(await failureOf(withKey.t.send(message()))).toMatchObject({ pause: "mailgun-auth", fixText: AUTH_PAUSE_FIX });
    const noKey = transport();
    noKey.client.failWith = new MailgunError({ kind: "auth", status: 401, message: "401", mailgunMessage: "Forbidden" });
    expect(await failureOf(noKey.t.send(message(TEAM)))).toMatchObject({ pause: "mailgun-auth", fixText: AUTH_PAUSE_FIX });
  });

  it("app mode's blocks never carry the own-mailbox flag", async () => {
    const { t } = transport();
    const f = await failureOf(t.send(message({ ...TEAM, messageId: "pp.abc@dry-run.invalid" })));
    expect(isOwnMailboxBlock(f)).toBe(false);
    expect(f).not.toHaveProperty("ownMailbox");
  });
});

// ───────────────────────── own-mailbox mode (MAIN-DOMAIN-DESIGN O6, O24, O25, O35) ─────────────────────────

const OWN = "contact@example.com";
const OWN_LINE = `Ali from Polygon Paradise <${OWN}>`;
const AUTHORIZED_403 =
  "Domain example.com is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.";

/** A transport in own-mailbox mode on example.com (its SendingDomain row exists for these tests). */
function ownTransport(ownMailboxFrom: string = OWN) {
  const client = stubClient();
  const context = {
    connected: true,
    domain: "example.com",
    region: "US",
    domainId: 2,
    client: client as unknown as MailgunClient,
    sendClient: client as unknown as MailgunClient,
    fakeMode: false,
    replies: "own-mailbox",
    ownFrom: ownMailboxFrom || null,
    ownMailboxFrom,
  } satisfies MailgunContext;
  return { t: new MailgunTransport({ mode: "LIVE", context, guard, now: () => NOW }), client };
}

/** An own-mailbox email: From the own From with the display name, no Reply-To, Message-ID on the sending domain. */
const OWN_MSG = { from: OWN_LINE, replyTo: null, messageId: "pp.abc@example.com" };

describe("MailgunTransport.send in own-mailbox mode", () => {
  beforeAll(() => {
    domainRows.set("example.com", { name: "example.com", region: "US" });
  });
  afterAll(() => {
    domainRows.delete("example.com");
  });

  it("goes to /v3/example.com/messages with the own From line and no h:Reply-To", async () => {
    const { t, client } = ownTransport();
    expect(await t.send(message(OWN_MSG))).toEqual({ providerId: "pp.abc@example.com", acceptedAt: NOW });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.domain).toBe("example.com");
    expect(client.calls[0]!.input).toMatchObject({ from: OWN_LINE, replyTo: null, messageId: "pp.abc@example.com" });
    // No Reply-To field is counted (none is sent).
    expect(sendOptionBytes(client.calls[0]!.input)).toBe(sendOptionBytes(buildSendInput(message(OWN_MSG), "LIVE", guard)));
  });

  it("another From, a Reply-To (on any domain) or a Message-ID elsewhere: blocked with the sender pause and the own-mailbox flag; nothing sent", async () => {
    const { t, client } = ownTransport();
    for (const bad of [
      { ...OWN_MSG, from: "Ali from Polygon Paradise <ali@example.com>" },
      { ...OWN_MSG, from: "Ali <contact@mail.example.com>" },
      { ...OWN_MSG, replyTo: "ali@example.com" },
      { ...OWN_MSG, replyTo: "ali@send.example.com" },
      { ...OWN_MSG, replyTo: "ali@nowhere.example.org" },
      { ...OWN_MSG, messageId: "pp.abc@dry-run.invalid" },
      { ...OWN_MSG, messageId: "pp.abc@send.example.com" },
    ]) {
      const f = await failureOf(t.send(message(bad)));
      expect(f, JSON.stringify(bad)).toEqual({
        kind: "blocked",
        message: expect.stringMatching(/^Stopped by the sender check: /),
        pause: SENDER_HEADERS_PAUSE,
        ownMailbox: true,
      });
      expect(isOwnMailboxBlock(f)).toBe(true);
    }
    expect(client.calls).toHaveLength(0);
  });

  it("with no fitting own From yet every email is refused (fail closed)", async () => {
    const { t, client } = ownTransport("");
    const f = await failureOf(t.send(message(OWN_MSG)));
    expect(f).toMatchObject({ kind: "blocked", pause: SENDER_HEADERS_PAUSE, ownMailbox: true, message: "Stopped by the sender check: Own-mailbox mode has no From address yet." });
    expect(client.calls).toHaveLength(0);
  });

  it("the client's own sender refusal counts as the same own-mailbox block", async () => {
    const { t, client } = ownTransport();
    client.failWith = new MailgunError({ kind: "sender", requestStarted: false, message: "Stopped by the sender check: no.", mailgunMessage: "" });
    expect(await failureOf(t.send(message(OWN_MSG)))).toEqual({
      kind: "blocked",
      message: "Stopped by the sender check: no.",
      pause: SENDER_HEADERS_PAUSE,
      ownMailbox: true,
    });
  });

  it("a send refused for the plan's sending limit pauses with the plan sentence, never 'rejected'", async () => {
    const { t, client } = ownTransport();
    client.failWith = new MailgunError({ kind: "limit", status: 400, message: "Mailgun answered 400", mailgunMessage: "Domain example.com has reached its daily sending limit of 100 messages." });
    expect(await failureOf(t.send(message(OWN_MSG)))).toEqual({
      kind: "pause",
      pause: "mailgun-not-allowed",
      reason: PLAN_TEXTS.limitReason,
      fixText: PLAN_TEXTS.limitRefused,
      mailgunMessage: "Domain example.com has reached its daily sending limit of 100 messages.",
    });
  });

  it("a free account limited to authorized recipients pauses with the campaign sentence (every mode)", async () => {
    const refused = new MailgunError({ kind: "not-allowed", status: 403, message: "Mailgun answered 403", mailgunMessage: AUTHORIZED_403 });
    const expected = {
      kind: "pause",
      pause: "mailgun-not-allowed",
      reason: PLAN_TEXTS.authorizedReason,
      fixText: PLAN_TEXTS.authorizedOnlyCampaign,
      mailgunMessage: AUTHORIZED_403,
    };
    const { t, client } = ownTransport();
    client.failWith = refused;
    expect(await failureOf(t.send(message(OWN_MSG)))).toEqual(expected);
    expect(mailgunFailure(refused, ctx)).toEqual(expected);
    expect(PLAN_TEXTS.authorizedOnlyCampaign).not.toMatch(/Authorized recipients/);
    // Found in the technical message when Mailgun's text is empty; any other "not allowed" keeps its own sentence.
    expect(mailgunFailure(new MailgunError({ kind: "not-allowed", status: 403, message: `Mailgun answered 403: ${AUTHORIZED_403}` }), ctx)).toMatchObject({
      fixText: PLAN_TEXTS.authorizedOnlyCampaign,
    });
    expect(mailgunFailure(mgError("not-allowed", { status: 403 }), ctx)).toMatchObject({ reason: "Mailgun won't send from send.example.com" });
  });
});

describe("mailgunFailure: the plan's sending limit (O24)", () => {
  it("kind limit → the plan pause (the email goes back to the queue), whatever the mode", () => {
    expect(mailgunFailure(mgError("limit", { status: 400 }), ctx)).toEqual({
      kind: "pause",
      pause: "mailgun-not-allowed",
      reason: PLAN_TEXTS.limitReason,
      fixText: PLAN_TEXTS.limitRefused,
      mailgunMessage: "Mailgun says limit",
    });
    // A 5xx is still "may have been sent", whatever its kind.
    expect(mailgunFailure(mgError("limit", { status: 503 }), ctx)).toEqual({ kind: "ambiguous", message: "technical limit" });
  });

  it("ownMailboxBlocked builds the flagged sender block", () => {
    expect(ownMailboxBlocked("x")).toEqual({ kind: "blocked", message: "x", pause: SENDER_HEADERS_PAUSE, ownMailbox: true });
    expect(isOwnMailboxBlock({ kind: "blocked", message: "x", pause: SENDER_HEADERS_PAUSE })).toBe(false);
    expect(isOwnMailboxBlock({ kind: "rejected", message: "x", detail: null })).toBe(false);
  });
});
