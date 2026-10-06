import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MailgunClient, type MailgunClientOptions } from "@/server/mailgun/client";
import { MailgunError } from "@/server/mailgun/errors";
import type { SendMessageInput } from "@/server/mailgun/types";
import { startFakeMailgun } from "../../fake-mailgun/server";

/**
 * MailgunClient against the fake Mailgun server (M3-DESIGN §4.2.3, §8 P2 tests). No database: the Logs form memory
 * is an in-memory store here.
 */

const D = "send.example.com";
const KEY = "key-fake-api";
const fake = await startFakeMailgun({ domain: D });

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

function memoryLogsForm(start = false) {
  const store = { value: start, sets: 0 };
  return {
    store,
    form: {
      get: async () => store.value,
      set: async (v: boolean) => {
        store.value = v;
        store.sets += 1;
      },
    },
  };
}

function client(extra: Partial<MailgunClientOptions> = {}): MailgunClient {
  return new MailgunClient({
    apiKey: KEY,
    region: "EU",
    baseUrl: fake.origin,
    retryDelayMs: () => 0,
    logsForm: memoryLogsForm().form,
    ...extra,
  });
}

const guard = { goLive: false, testList: new Set(["tester@gmail.com", "tester2@outlook.com"]) };

function msg(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    from: "Ali Khan <ali@send.example.com>",
    to: "tester@gmail.com",
    subject: "3D models for Studio",
    text: "Hi there\n\nIf you'd rather not hear from us, unsubscribe here: %unsubscribe_url%",
    html: "<p>Hi there</p>",
    messageId: `pp.${crypto.randomBytes(12).toString("hex")}@${D}`,
    tags: ["outreach", "step-0"],
    variables: { send_id: crypto.randomBytes(16).toString("hex"), campaign_id: "12", step: "0" },
    purpose: "campaign",
    guard,
    ...over,
  };
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

const requestsTo = (path: string) => fake.requests.filter((r) => r.path === path).length;

// ───────────────────────── sending ─────────────────────────

describe("sendMessage", () => {
  it("sends the §4.3.1 fields and returns Mailgun's id without brackets", async () => {
    const m = msg({ messageId: `PP.Abc123@${D}` });
    const res = await client().sendMessage(D, m);
    expect(res).toEqual({ id: `pp.abc123@${D}`, message: "Queued. Thank you." });
    expect(fake.messages).toHaveLength(1);
    const f = fake.messages[0]!.fields;
    expect(f.to).toEqual(["tester@gmail.com"]);
    expect(f["h:Message-Id"]).toEqual([`<pp.abc123@${D}>`]);
    expect(f["o:tracking-opens"]).toEqual(["no"]);
    expect(f["o:tracking-clicks"]).toEqual(["no"]);
    expect(f["o:tag"]).toEqual(["outreach", "step-0"]);
    expect(f["v:campaign_id"]).toEqual(["12"]);
    expect(f["v:send_id"]).toEqual([m.variables.send_id]);
    expect(f["o:testmode"]).toBeUndefined();
    expect(f["o:tracking"]).toBeUndefined();
    expect(f["h:Reply-To"]).toBeUndefined();
    const logged = fake.requests.at(-1)!;
    expect(logged.headers.authorization).toBeUndefined();
    expect(logged.headers["x-outreach-region"]).toBe("EU");
  });

  it("adds test mode, threading and Reply-To when asked", async () => {
    await client().sendMessage(
      D,
      msg({ testMode: true, inReplyTo: `pp.first@${D}`, references: `pp.zero@${D} pp.first@${D}`, replyTo: "ali@reply.example.com" }),
    );
    const f = fake.messages[0]!.fields;
    expect(f["o:testmode"]).toEqual(["yes"]);
    expect(f["h:In-Reply-To"]).toEqual([`<pp.first@${D}>`]);
    expect(f["h:References"]).toEqual([`<pp.zero@${D}> <pp.first@${D}>`]);
    expect(f["h:Reply-To"]).toEqual(["ali@reply.example.com"]);
  });

  it("stops at the test-list guard before any request", async () => {
    const err = await failure(client().sendMessage(D, msg({ to: "anna@studio.de" })));
    expect(err.kind).toBe("guard");
    expect(err.requestStarted).toBe(false);
    expect(fake.requests).toHaveLength(0);
    expect(fake.messages).toHaveLength(0);
    const list = await failure(client().sendMessage(D, msg({ to: "tester@gmail.com, tester2@outlook.com" })));
    expect(list.kind).toBe("guard");
    expect(fake.requests).toHaveLength(0);
  });

  it("SHARED-FROM §2.4: stops at the sender check before any request (kind 'sender')", async () => {
    for (const bad of [
      { from: "Ali from Polygon Paradise <contact@example.com>", replyTo: null },
      { from: "Ali from Polygon Paradise <contact@example.com>", replyTo: "contact@example.com" },
      { from: "Anna <anna@firma.de>", replyTo: `ali@${D}` },
    ]) {
      const err = await failure(client().sendMessage(D, msg(bad)));
      expect(err, bad.from).toMatchObject({ kind: "sender", requestStarted: false, ambiguous: false });
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.messages).toHaveLength(0);
  });

  it("SHARED-FROM §2.3: a shared-From email goes to the sending domain with the team From line and h:Reply-To", async () => {
    await client().sendMessage(D, msg({ from: "Ali from Polygon Paradise <contact@example.com>", replyTo: `ali@${D}` }));
    const f = fake.messages[0]!.fields;
    expect(f.from).toEqual(["Ali from Polygon Paradise <contact@example.com>"]);
    expect(f["h:Reply-To"]).toEqual([`ali@${D}`]);
    expect(fake.requests.at(-1)!.path).toBe(`/v3/${D}/messages`);
  });

  it("refuses bad input without a request", async () => {
    const err = await failure(client().sendMessage(D, msg({ tags: ["a", "b", "c", "d"] })));
    expect(err.requestStarted).toBe(false);
    const noId = await failure(client().sendMessage(D, msg({ messageId: "" })));
    expect(noId.requestStarted).toBe(false);
    const big = await failure(client().sendMessage(D, msg({ variables: { note: "x".repeat(17_000) } })));
    expect(big.requestStarted).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("maps a 400 about the email to rejected (never ambiguous)", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "status", status: 400, body: { message: "to parameter is not a valid address. please check documentation." } });
    const err = await failure(client().sendMessage(D, msg()));
    expect(err).toMatchObject({ kind: "rejected", status: 400, requestStarted: true, ambiguous: false });
    expect(err.mailgunMessage).toBe("to parameter is not a valid address. please check documentation.");
  });

  it("maps a 400 'is not allowed to send' to not-allowed", async () => {
    fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 400,
      body: { message: `Domain ${D} is not allowed to send: Free accounts are for test purposes only.` },
    });
    expect((await failure(client().sendMessage(D, msg()))).kind).toBe("not-allowed");
  });

  it("maps business verification", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "businessVerification" });
    const err = await failure(client().sendMessage(D, msg()));
    expect(err).toMatchObject({ kind: "business-verification", status: 403, ambiguous: false });
  });

  it("answers a wrong key with auth and Mailgun's plain 'Forbidden'", async () => {
    const err = await failure(client({ apiKey: "key-fake-wrong" }).sendMessage(D, msg()));
    expect(err).toMatchObject({ kind: "auth", status: 401, mailgunMessage: "Forbidden", ambiguous: false });
  });

  it("reads every 429 form, and never retries a send", async () => {
    const now = new Date("2026-09-23T10:00:00Z");
    fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 429,
      body: { message: "limit" },
      headers: { "X-RateLimit-Reset": String(now.getTime() + 90_000) },
    });
    const abs = await failure(client({ now: () => now }).sendMessage(D, msg()));
    expect(abs).toMatchObject({ kind: "rate-limited", retryAfterMs: 90_000, ambiguous: false });

    fake.failNext("POST /v3/:d/messages", { kind: "status", status: 429, body: { message: "limit" }, headers: { "X-RateLimit-Reset": "5000" } });
    expect((await failure(client().sendMessage(D, msg()))).retryAfterMs).toBe(5000);

    fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 429,
      body: { message: `Domain ${D} is not allowed to send: account-requests-per-sec limit exceeded, try again after 120 seconds` },
      headers: { "X-RateLimit-Reset": "" },
    });
    const text = await failure(client().sendMessage(D, msg()));
    expect(text).toMatchObject({ kind: "rate-limited", retryAfterMs: 120_000 });
    expect(requestsTo(`/v3/${D}/messages`)).toBe(3);
  });

  it("treats a 5xx as ambiguous and doesn't retry it", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "status", status: 500, body: { message: "Internal Server Error" } });
    const err = await failure(client().sendMessage(D, msg()));
    expect(err).toMatchObject({ kind: "server", status: 500, ambiguous: true });
    expect(requestsTo(`/v3/${D}/messages`)).toBe(1);
  });

  it("treats a 5xx whose page says 'disabled' or 'suspended' as ambiguous, never as a refusal (CRASH-2)", async () => {
    // Mailgun accepts the email, then a maintenance page in front of it answers 5xx instead of Mailgun's 200.
    for (const [status, page] of [
      [503, "<html><body>Service temporarily disabled for maintenance</body></html>"],
      [502, '{"message":"Domain is not allowed to send: account suspended"}'],
      [500, "Business verification is required"],
    ] as const) {
      fake.reset();
      const acceptThenFail = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const real = await fetch(input, init);
        await real.text();
        return new Response(page, { status, headers: { "Content-Type": "text/html" } });
      }) as typeof fetch;
      const err = await failure(client({ fetchImpl: acceptThenFail }).sendMessage(D, msg()));
      expect(err, String(status)).toMatchObject({ kind: "server", status, ambiguous: true, requestStarted: true });
      expect(fake.messages, String(status)).toHaveLength(1);
      expect(requestsTo(`/v3/${D}/messages`)).toBe(1);
    }
  });

  it("times out on a hang: ambiguous", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "hang" });
    const started = Date.now();
    const err = await failure(client({ timeoutMs: 300 }).sendMessage(D, msg()));
    expect(err).toMatchObject({ kind: "timeout", ambiguous: true, requestStarted: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(requestsTo(`/v3/${D}/messages`)).toBe(1);
  });

  it("acceptThenDrop, acceptThenRedirect and acceptWithoutId are ambiguous, and the message was recorded", async () => {
    for (const kind of ["acceptThenDrop", "acceptThenRedirect", "acceptWithoutId"] as const) {
      fake.reset();
      fake.failNext("POST /v3/:d/messages", { kind });
      const err = await failure(client().sendMessage(D, msg()));
      expect(err.ambiguous, kind).toBe(true);
      expect(err.requestStarted).toBe(true);
      expect(fake.messages, kind).toHaveLength(1);
      expect(fake.state().logEvents.filter((e) => e.event === "accepted")).toHaveLength(1);
    }
    // the redirect was never followed
    expect(fake.requests.every((r) => r.path === `/v3/${D}/messages`)).toBe(true);
  });

  it("never marks a 4xx ambiguous", async () => {
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422]) {
      fake.failNext("POST /v3/:d/messages", { kind: "status", status, body: { message: "no" } });
      const err = await failure(client().sendMessage(D, msg()));
      expect(err.ambiguous, String(status)).toBe(false);
      expect(err.status).toBe(status);
    }
  });

  it("returns Mailgun's own id when it rewrites ours", async () => {
    fake.setSwitches({ rewriteMessageId: true });
    const m = msg();
    const res = await client().sendMessage(D, m);
    expect(res.id).not.toBe(m.messageId);
    expect(res.id).toMatch(new RegExp(`@${D.replace(/\./g, "\\.")}$`));
  });

  it("uses a domain sending key when given", async () => {
    const fake2 = await startFakeMailgun({ domain: D, sendingKey: "key-fake-sending" });
    try {
      const c = new MailgunClient({ apiKey: "key-fake-sending", region: "EU", baseUrl: fake2.origin, retryDelayMs: () => 0 });
      await c.sendMessage(D, msg());
      expect(fake2.messages).toHaveLength(1);
      expect((await failure(c.getDomain(D))).kind).toBe("auth");
      const dev = new MailgunClient({ apiKey: "key-fake-api", region: "EU", baseUrl: fake2.origin });
      await dev.sendMessage(D, msg(), { apiKey: "key-fake-sending" });
      expect(fake2.messages).toHaveLength(2);
    } finally {
      await fake2.close();
    }
  });

  it("passes only its own timeout signal to fetch", async () => {
    const seen: RequestInit[] = [];
    const c = client({ fetchImpl: (input, init) => (seen.push(init ?? {}), fetch(input, init)) });
    await c.sendMessage(D, msg());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal!.aborted).toBe(false);
  });
});

// ───────────────────────── safety of every request ─────────────────────────

describe("every request", () => {
  it("uses redirect: 'error'", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const c = client({ fetchImpl: (input, init) => (seen.push(init), fetch(input, init)) });
    fake.setDns("all");
    const m = msg();
    await c.sendMessage(D, m);
    await c.getDomain(D);
    await c.verifyDomain(D);
    await c.updateDomain(D, { spam_action: "tag" });
    await c.getTracking(D);
    await c.setOpenTracking(D, false);
    await c.getSendingQueues(D);
    await c.getWebhooks(D);
    await c.createWebhook(D, "https://outreach.example.com/api/webhooks/mailgun/events", ["delivered"]);
    await c.getSigningKey();
    await c.getMonthlyLimit();
    await c.listRoutes();
    await c.matchRoute(`ali@${D}`);
    await c.queryLogs({ start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000), events: ["accepted"], filters: [] });
    await c.walkSuppressions(D, "bounces", async () => undefined);
    await c.getSuppression(D, "bounces", "x@y.com");
    await c.startCertificate(`email.${D}`);
    await c.getCertificateStatus(`email.${D}`);
    expect(seen.length).toBeGreaterThanOrEqual(18);
    for (const init of seen) expect(init?.redirect).toBe("error");
  });

  it("never sends a real key to the fake (nothing leaves this PC)", async () => {
    const err = await failure(client({ apiKey: "0123456789abcdef0123456789abcdef-a1b2c3d4-e5f6a7b8" }).getDomain(D));
    expect(err).toMatchObject({ kind: "auth", requestStarted: false });
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps the key out of a serialised error", async () => {
    const wrong = "key-fake-wrong-0123456789";
    const basic = Buffer.from("api:" + wrong).toString("base64");
    const err = await failure(client({ apiKey: wrong }).getDomain(D));
    expect(err.kind).toBe("auth");
    for (const text of [JSON.stringify(err), String(err.stack), JSON.stringify(client({ apiKey: wrong }))]) {
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(basic);
    }
  });
});

// ───────────────────────── retries on other calls ─────────────────────────

describe("retries (calls other than sends)", () => {
  it("retries 5xx up to 3 times", async () => {
    fake.failNext("GET /v4/domains/:d", { kind: "status", status: 500, body: { message: "Internal Server Error" } }, 2);
    const info = await client().getDomain(D);
    expect(info.name).toBe(D);
    expect(requestsTo(`/v4/domains/${D}`)).toBe(3);

    fake.reset();
    fake.failNext("GET /v4/domains/:d", { kind: "status", status: 503, body: "busy" }, 4);
    const err = await failure(client().getDomain(D));
    expect(err).toMatchObject({ kind: "server", status: 503 });
    expect(requestsTo(`/v4/domains/${D}`)).toBe(4);
  });

  it("retries a 429, waiting what Mailgun asks for (capped by retryDelayMs in tests)", async () => {
    const waits: number[] = [];
    fake.failNext("GET /v3/domains/:d/tracking", { kind: "status", status: 429, body: { message: "slow down" }, headers: { "X-RateLimit-Reset": "1500" } });
    const c = client({ retryDelayMs: (a) => (waits.push(a), 0) });
    await c.getTracking(D);
    expect(waits).toEqual([0]);
    expect(requestsTo(`/v3/domains/${D}/tracking`)).toBe(2);
  });

  it("retries a timeout", async () => {
    fake.failNext("GET /v4/domains/:d", { kind: "hang" });
    const info = await client({ timeoutMs: 300 }).getDomain(D);
    expect(info.name).toBe(D);
    expect(requestsTo(`/v4/domains/${D}`)).toBe(2);
  });

  it("fails fast on a refused connection (a forgotten fake): no retries", async () => {
    let calls = 0;
    const dead = new MailgunClient({
      apiKey: KEY,
      region: "EU",
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: (input, init) => (calls++, fetch(input, init)),
    });
    const started = Date.now();
    const err = await failure(dead.getDomain(D));
    expect(err).toMatchObject({ kind: "network", requestStarted: true });
    expect(err.message).toMatch(/Couldn't reach Mailgun/);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("retries one 404 on domain endpoints", async () => {
    fake.failNext("GET /v4/domains/:d", { kind: "status", status: 404, body: { message: "Domain not found" } });
    await client().getDomain(D);
    expect(requestsTo(`/v4/domains/${D}`)).toBe(2);

    fake.reset();
    const err = await failure(client({ region: "US" }).getDomain(D));
    expect(err).toMatchObject({ kind: "not-found", status: 404, mailgunMessage: "Domain not found" });
    expect(requestsTo(`/v4/domains/${D}`)).toBe(2);
  });

  it("doesn't retry a 404 that names something else, nor a route create", async () => {
    const e1 = await failure(client().updateWebhook(D, "https://unknown.example.com/hook", ["delivered"]));
    expect(e1).toMatchObject({ kind: "not-found", mailgunMessage: "Webhook not found" });
    expect(requestsTo(`/v4/domains/${D}/webhooks`)).toBe(1);

    fake.failNext("POST /v3/routes", { kind: "status", status: 500, body: { message: "oops" } });
    await failure(client().createRoute({ priority: 10, description: "x", expression: 'match_recipient("^a@b$")', actions: ["stop()"] }));
    expect(requestsTo("/v3/routes")).toBe(1);
    expect(fake.state().routes).toHaveLength(0);
  });

  it("stops retrying when the caller's signal aborts", async () => {
    fake.failNext("POST /v1/analytics/logs", { kind: "hang" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const walk = await client({ timeoutMs: 10_000 }).walkLogs(
      { start: new Date(Date.now() - 3_600_000), end: new Date(), events: ["accepted"], filters: [] },
      async () => undefined,
      { signal: ac.signal },
    );
    expect(walk).toMatchObject({ complete: false, stoppedBecause: "aborted" });
  });
});

// ───────────────────────── logs ─────────────────────────

describe("Logs", () => {
  const window = () => ({ start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000) });

  async function sendMany(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await client().sendMessage(D, msg())).id);
    return ids;
  }

  it("queries by domain and message_id and returns Logs items", async () => {
    const [id] = await sendMany(3);
    const res = await client().queryLogs({
      ...window(),
      events: ["accepted", "delivered", "failed"],
      filters: [
        { attribute: "domain", comparator: "=", value: D },
        { attribute: "message_id", comparator: "=", value: id! },
      ],
    });
    expect(res.items).toHaveLength(1);
    const item = res.items[0] as Record<string, unknown>;
    expect(item.event).toBe("accepted");
    expect(typeof item["@timestamp"]).toBe("string");
    expect(typeof item["user-variables"]).toBe("string");
    expect(res.next).toBeNull();
    const body = fake.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.start).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} -0000$/);
    expect(body.filter).toEqual({
      AND: [
        { attribute: "domain", comparator: "=", values: [{ label: D, value: D }] },
        { attribute: "message_id", comparator: "=", values: [{ label: id, value: id }] },
      ],
    });
  });

  it("walks every page and stops when there is no next", async () => {
    await sendMany(5);
    const seen: unknown[] = [];
    const walk = await client().walkLogs({ ...window(), events: ["accepted"], filters: [], limit: 2 }, async (items) => {
      seen.push(...items);
    });
    expect(walk).toEqual({ complete: true, pages: 3, items: 5, stoppedBecause: "no-next" });
    expect(seen).toHaveLength(5);
  });

  it("stops on an empty page when the last page still has a next token (nextOnLastPage)", async () => {
    fake.setSwitches({ nextOnLastPage: true });
    await sendMany(4);
    const walk = await client().walkLogs({ ...window(), events: ["accepted"], filters: [], limit: 2 }, async () => undefined);
    expect(walk).toEqual({ complete: true, pages: 3, items: 4, stoppedBecause: "empty" });
  });

  it("stops when Mailgun repeats the token it was sent", async () => {
    const page = { items: [{ id: "e1", event: "accepted" }], pagination: { next: "SAME" } };
    fake.failNext("POST /v1/analytics/logs", { kind: "status", status: 200, body: page }, 2);
    const walk = await client().walkLogs({ ...window(), events: ["accepted"], filters: [] }, async () => undefined);
    expect(walk).toEqual({ complete: true, pages: 2, items: 2, stoppedBecause: "same-token" });
  });

  it("stops at the page guard (incomplete)", async () => {
    await sendMany(5);
    const walk = await client().walkLogs({ ...window(), events: ["accepted"], filters: [], limit: 1 }, async () => undefined, { maxPages: 2 });
    expect(walk).toEqual({ complete: false, pages: 2, items: 2, stoppedBecause: "page-guard" });
  });

  it("doesn't start when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const walk = await client().walkLogs({ ...window(), events: ["accepted"], filters: [] }, async () => undefined, { signal: ac.signal });
    expect(walk).toEqual({ complete: false, pages: 0, items: 0, stoppedBecause: "aborted" });
    expect(fake.requests).toHaveLength(0);
  });

  it("learns the duration form once and remembers it (strictDuration)", async () => {
    fake.setSwitches({ strictDuration: true });
    await sendMany(1);
    const mem = memoryLogsForm();
    const c = client({ logsForm: mem.form });
    const q = { ...window(), events: ["accepted"], filters: [] };
    const first = await c.queryLogs(q);
    expect(first.items).toHaveLength(1);
    expect(mem.store).toEqual({ value: true, sets: 1 });
    const logs = fake.requests.filter((r) => r.path === "/v1/analytics/logs");
    expect(logs).toHaveLength(2);
    expect((logs[0]!.body as Record<string, unknown>).duration).toBeUndefined();
    expect((logs[1]!.body as Record<string, unknown>).duration).toBe("2h");
    expect((logs[1]!.body as Record<string, unknown>).start).toBeUndefined();

    await c.queryLogs(q);
    expect(fake.requests.filter((r) => r.path === "/v1/analytics/logs")).toHaveLength(3);
    // a new client with the same memory starts in duration form
    await client({ logsForm: mem.form }).queryLogs(q);
    expect(fake.requests.filter((r) => r.path === "/v1/analytics/logs")).toHaveLength(4);
    expect(mem.store.sets).toBe(1);
  });
});

// ───────────────────────── suppressions ─────────────────────────

describe("suppressions", () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `person${String(i).padStart(5, "0")}@example.org` }));

  it("adds unsubscribes in batches of at most 999", async () => {
    const res = await client().addUnsubscribes(D, people(1500));
    expect(res).toEqual({ added: 1500 });
    const posts = fake.requests.filter((r) => r.method === "POST" && r.path === `/v3/${D}/unsubscribes`);
    expect(posts.map((p) => (p.body as unknown[]).length)).toEqual([999, 501]);
    expect((posts[0]!.body as Array<Record<string, unknown>>)[0]).toMatchObject({ tags: ["*"] });
    expect(fake.state().suppressions.unsubscribes).toHaveLength(1500);
  });

  it("pages until an empty page (next is always there)", async () => {
    await client().addUnsubscribes(D, people(1500));
    fake.requests.length = 0;
    const seen: string[] = [];
    const res = await client().walkSuppressions(D, "unsubscribes", async (items) => {
      seen.push(...items.map((i) => i.address));
    });
    expect(res).toEqual({ complete: true, pages: 3, items: 1500 });
    expect(new Set(seen).size).toBe(1500);
    expect(fake.requests.map((r) => r.query.page?.[0] ?? "")).toEqual(["", "next", "next"]);
  });

  it("refuses a next link on another host without calling it", async () => {
    fake.addSuppression("bounces", "a@example.org");
    fake.setSwitches({ crossOriginNext: true });
    const urls: string[] = [];
    const c = client({ fetchImpl: (input, init) => (urls.push(String(input)), fetch(input, init)) });
    const err = await failure(c.walkSuppressions(D, "bounces", async () => undefined));
    expect(err).toMatchObject({ kind: "unexpected", requestStarted: false });
    expect(urls).toHaveLength(1);
    expect(urls.every((u) => u.startsWith(fake.origin))).toBe(true);
  });

  it("gets and deletes one entry; 404 → null / not-found", async () => {
    const c = client();
    expect(await c.getSuppression(D, "bounces", "gone@example.org")).toBeNull();
    fake.addSuppression("bounces", "Gone@Example.org", { code: "550", error: "No such mailbox" });
    const item = await c.getSuppression(D, "bounces", "gone@example.org");
    expect(item).toMatchObject({ address: "gone@example.org", code: "550", error: "No such mailbox" });
    expect(item!.createdAt).toBeInstanceOf(Date);
    expect(await c.deleteSuppression(D, "bounces", "gone@example.org")).toBe("deleted");
    expect(await c.deleteSuppression(D, "bounces", "gone@example.org")).toBe("not-found");
  });
});

// ───────────────────────── domain, tracking, queues, certificate ─────────────────────────

describe("domain and settings", () => {
  it("reads the domain and its records; verify turns it active once DNS is valid", async () => {
    const c = client();
    const before = await c.getDomain(D);
    expect(before).toMatchObject({ name: D, state: "unverified", webScheme: "http", spamAction: "disabled", messageTtl: 86_400, webPrefix: "email" });
    expect(before.webhooksRedactPii).toBe(false);
    expect(before.sending.map((r) => [r.recordType, r.valid])).toEqual([
      ["TXT", "unknown"],
      ["TXT", "unknown"],
      ["CNAME", "unknown"],
    ]);
    expect(before.receiving[0]).toMatchObject({ recordType: "MX", name: null, priority: "10" });
    fake.setDns("all");
    const after = await c.verifyDomain(D);
    expect(after.state).toBe("active");
    expect(after.sending.every((r) => r.valid === "valid" && r.cached.length === 1)).toBe(true);
  });

  it("verify answers 429 with verifyRateLimited", async () => {
    fake.setSwitches({ verifyRateLimited: true });
    const err = await failure(client().verifyDomain(D));
    expect(err.kind).toBe("rate-limited");
  });

  it("updates one field per call", async () => {
    const c = client();
    expect((await c.updateDomain(D, { spam_action: "tag" })).spamAction).toBe("tag");
    expect((await c.updateDomain(D, { message_ttl: 86_400 })).messageTtl).toBe(86_400);
    expect((await c.updateDomain(D, { webhooks_redact_pii: false })).webhooksRedactPii).toBe(false);
    const tooLong = await failure(c.updateDomain(D, { message_ttl: 7 * 86_400 }));
    expect(tooLong).toMatchObject({ kind: "rejected", status: 400 });
    const two = await failure(c.updateDomain(D, { spam_action: "tag", message_ttl: 60 }));
    expect(two.requestStarted).toBe(false);
    const https = await failure(c.updateDomain(D, { web_scheme: "https" }));
    expect(https.kind).toBe("rejected");
  });

  it("reads and changes tracking, footers included", async () => {
    const c = client();
    expect(await c.getTracking(D)).toMatchObject({ openActive: true, clickActive: true, unsubscribeActive: false, webScheme: "http" });
    await c.setOpenTracking(D, false);
    await c.setClickTracking(D, false);
    await c.setUnsubscribeTracking(D, true, { html: "", text: "" });
    expect(await c.getTracking(D)).toEqual({
      openActive: false,
      clickActive: false,
      unsubscribeActive: true,
      htmlFooter: "",
      textFooter: "",
      webScheme: "http",
    });
  });

  it("keeps the old footers with ignoreEmptyFooters", async () => {
    fake.setSwitches({ ignoreEmptyFooters: true });
    const c = client();
    await c.setUnsubscribeTracking(D, true, { html: "", text: "" });
    const t = await c.getTracking(D);
    expect(t.unsubscribeActive).toBe(true);
    expect(t.htmlFooter).toContain("%unsubscribe_url%");
    expect(t.textFooter).toContain("%unsubscribe_url%");
  });

  it("reads the sending queue", async () => {
    const c = client();
    expect(await c.getSendingQueues(D)).toEqual({ regularDisabled: false, reason: null, until: null, scheduledDisabled: false });
    const until = new Date("2026-09-24T10:00:00Z");
    fake.disableQueue("You have too many messages in queue", until);
    expect(await c.getSendingQueues(D)).toEqual({
      regularDisabled: true,
      reason: "You have too many messages in queue",
      until,
      scheduledDisabled: false,
    });
  });

  it("walks the certificate state machine", async () => {
    const c = client();
    const host = `email.${D}`;
    expect(await c.getCertificateStatus(host)).toEqual({ status: "none", error: null });
    expect(await failure(c.startCertificate(host))).toMatchObject({ kind: "rejected", status: 400, mailgunMessage: "invalid CNAME record" });
    fake.setDns(["tracking"]);
    expect(await c.startCertificate(host)).toBe("started");
    expect(await c.startCertificate(host)).toBe("already");
    expect(await c.regenerateCertificate(host)).toBe("in-progress");
    expect((await c.getCertificateStatus(host)).status).toBe("processing");
    expect(await c.getCertificateStatus(host)).toEqual({ status: "active", error: null });
    expect(await c.regenerateCertificate(host)).toBe("still-valid");
    expect((await c.updateDomain(D, { web_scheme: "https" })).webScheme).toBe("https");
    expect((await c.getTracking(D)).webScheme).toBe("https");
    fake.expireCertificate(host);
    expect((await c.getCertificateStatus(host)).status).toBe("expired");
    expect(await c.regenerateCertificate(host)).toBe("started");
    // a 429 here means "in progress", never a rate limit: no retry
    expect(fake.requests.filter((r) => r.method === "PUT" && r.path === `/v2/x509/${host}`)).toHaveLength(3);
  });

  it("ends in error with certFails, and 402 on the basic plan", async () => {
    fake.setSwitches({ certFails: true, certPolls: 1 });
    fake.setDns("all");
    const c = client();
    await c.startCertificate(`email.${D}`);
    expect((await c.getCertificateStatus(`email.${D}`)).status).toBe("error");

    const basic = await startFakeMailgun({ domain: D, plan: "basic" });
    try {
      basic.setDns("all");
      const bc = new MailgunClient({ apiKey: KEY, region: "EU", baseUrl: basic.origin, retryDelayMs: () => 0 });
      expect(await failure(bc.startCertificate(`email.${D}`))).toMatchObject({ kind: "payment", status: 402 });
    } finally {
      await basic.close();
    }
  });
});

// ───────────────────────── webhooks, account ─────────────────────────

describe("webhooks", () => {
  const URL_EVENTS = "https://outreach.example.com/api/webhooks/mailgun/events";
  const TYPES = ["delivered", "permanent_fail", "temporary_fail", "complained", "unsubscribed"] as const;

  it("creates, refuses a duplicate, updates, deletes", async () => {
    const c = client();
    expect(await c.getWebhooks(D)).toEqual({});
    const created = await c.createWebhook(D, URL_EVENTS, [...TYPES]);
    for (const t of TYPES) expect(created[t]).toEqual([URL_EVENTS]);
    const dup = await failure(c.createWebhook(D, URL_EVENTS, ["delivered"]));
    expect(dup).toMatchObject({ kind: "rejected", status: 400 });
    expect(dup.mailgunMessage).toMatch(/already exists/);
    const updated = await c.updateWebhook(D, URL_EVENTS, ["delivered", "complained"]);
    expect(updated).toEqual({ delivered: [URL_EVENTS], complained: [URL_EVENTS] });
    expect(await c.deleteWebhook(D, URL_EVENTS)).toEqual({});
    const form = fake.requests.find((r) => r.method === "POST" && r.path === `/v4/domains/${D}/webhooks`)!.body as Record<string, string[]>;
    expect(form.url).toEqual([URL_EVENTS]);
    expect(form.event_types).toEqual([...TYPES]);
  });

  it("merges the legacy url field", async () => {
    const c = client();
    await c.createWebhook(D, URL_EVENTS, ["delivered", "unsubscribed"]);
    fake.setSwitches({ legacyUrlField: true });
    expect(await c.getWebhooks(D)).toEqual({ delivered: [URL_EVENTS], unsubscribed: [URL_EVENTS] });
  });
});

describe("account", () => {
  it("reads the signing key with GET only", async () => {
    expect(await client().getSigningKey()).toBe("key-fake-signing");
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
    expect(fake.state().signingKeyRegenerated).toBe(0);

    const none = await startFakeMailgun({ domain: D, signingKey: null });
    try {
      const c = new MailgunClient({ apiKey: KEY, region: "EU", baseUrl: none.origin, retryDelayMs: () => 0 });
      expect(await failure(c.getSigningKey())).toMatchObject({ kind: "rejected", status: 400, mailgunMessage: "could not get HSK for account" });
    } finally {
      await none.close();
    }
  });

  it("reads the monthly limit; none → null", async () => {
    expect(await client().getMonthlyLimit()).toBeNull();
    fake.setMonthlyLimit({ limit: 30_000, current: 1234 });
    expect(await client().getMonthlyLimit()).toEqual({ limit: 30_000, current: 1234, period: "1m" });
  });
});

// ───────────────────────── routes ─────────────────────────

describe("routes", () => {
  const sender = {
    priority: 10,
    description: "outreach-app:sender:12",
    expression: 'match_recipient("^ali@send\\.example\\.com$")',
    actions: ['forward("ali.khan@gmail.com")', 'store(notify="https://outreach.example.com/api/webhooks/mailgun/inbound")', "stop()"],
  };
  const catchAll = {
    priority: 100,
    description: `outreach-app:catchall:${D}`,
    expression: 'match_recipient("^.*@send\\.example\\.com$")',
    actions: ['forward("owner@gmail.com")', "stop()"],
  };

  it("creates routes verbatim and matches the first by priority", async () => {
    const c = client();
    const all = await c.createRoute(catchAll);
    const ali = await c.createRoute(sender);
    expect(ali.id).toMatch(/^[0-9a-f]{24}$/);
    expect(ali).toMatchObject({ priority: 10, description: sender.description, expression: sender.expression, actions: sender.actions });
    expect(fake.state().routes.find((r) => r.id === ali.id)).toMatchObject({ expression: sender.expression, actions: sender.actions });
    expect((await c.matchRoute(`ali@${D}`))?.id).toBe(ali.id);
    expect((await c.matchRoute(`pp-route-check-1a2b@${D}`))?.id).toBe(all.id);
    expect(await c.matchRoute("ali@other.example.com")).toBeNull();
    // a dot in the local part is escaped: "aliXsend" must not match
    expect((await c.matchRoute(`ali@sendXexample.com`))).toBeNull();
  });

  it("treats catch_all() as matching when nothing earlier did", async () => {
    const c = client();
    const ca = await c.createRoute({ priority: 0, description: "x", expression: "catch_all()", actions: ["stop()"] });
    const ali = await c.createRoute({ ...sender, priority: 0 });
    expect((await c.matchRoute(`nobody@${D}`))?.id).toBe(ca.id);
    // same priority, created first: the catch-all comes first
    expect((await c.matchRoute(`ali@${D}`))?.id).toBe(ca.id);
    expect(ali.id).not.toBe(ca.id);
  });

  it("updates with every field; parses the spec answer and the bare route", async () => {
    const c = client();
    const r = await c.createRoute(sender);
    const changed = { ...sender, actions: ['forward("new.inbox@gmail.com")', "stop()"] };
    expect((await c.updateRoute(r.id, changed)).actions).toEqual(changed.actions);
    fake.setSwitches({ putBareRoute: true });
    const bare = await c.updateRoute(r.id, { ...changed, priority: 11 });
    expect(bare).toMatchObject({ id: r.id, priority: 11, actions: changed.actions });
    const put = fake.requests.filter((q) => q.method === "PUT").at(-1)!.body as Record<string, string[]>;
    expect(put.action).toEqual(changed.actions);
    expect(put.priority).toEqual(["11"]);
  });

  it("deletes, and 404 → not-found", async () => {
    const c = client();
    const r = await c.createRoute(sender);
    expect(await c.deleteRoute(r.id)).toBe("deleted");
    expect(await c.deleteRoute(r.id)).toBe("not-found");
  });

  it("lists every page (skip/limit 100 until total)", async () => {
    const c = client();
    for (let i = 0; i < 230; i++) {
      await c.createRoute({ priority: i, description: `r${i}`, expression: `match_recipient("^r${i}@x\\.com$")`, actions: ["stop()"] });
    }
    fake.requests.length = 0;
    const routes = await c.listRoutes();
    expect(routes).toHaveLength(230);
    expect(new Set(routes.map((r) => r.id)).size).toBe(230);
    expect(fake.requests.map((r) => r.query.skip?.[0])).toEqual(["0", "100", "200"]);
  });
});

// ───────────────────────── stored messages ─────────────────────────

describe("stored messages", () => {
  it("fetches a stored reply from the fake's own origin only", async () => {
    let now = new Date();
    fake.setNow(() => now);
    const received = fake.receive({
      from: "Anna Berg <anna@studio.de>",
      to: `ali@${D}`,
      subject: "Re: 3D models",
      text: "Sounds good",
      inReplyTo: `pp.first@${D}`,
    });
    const c = client({ now: () => now });
    const json = (await c.getStoredMessage(received.messageUrl)) as Record<string, unknown>;
    expect(json["body-plain"]).toBe("Sounds good");
    expect(Array.isArray(json["message-headers"])).toBe(true);
    expect(json["In-Reply-To"]).toBe(`<pp.first@${D}>`);

    const refused = await failure(c.getStoredMessage("https://storage.example.com/v3/domains/d/messages/KEY"));
    expect(refused).toMatchObject({ requestStarted: false });

    now = new Date(now.getTime() + 2 * 86_400_000);
    const expired = await failure(c.getStoredMessage(received.messageUrl));
    expect(expired).toMatchObject({ kind: "not-found", mailgunMessage: "Message not found" });
  });
});

// ───────────────────────── other regions ─────────────────────────

describe("forRegion", () => {
  it("keeps the fake for the other region, which then answers as unknown", async () => {
    const eu = client();
    const us = eu.forRegion("US");
    expect(us.region).toBe("US");
    expect(us.baseUrl).toBe(fake.origin);
    expect(eu.forRegion("EU")).toBe(eu);
    expect((await failure(us.getDomain(D))).kind).toBe("not-found");
  });
});
