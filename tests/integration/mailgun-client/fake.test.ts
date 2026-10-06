import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../../fake-mailgun/cli";
import { toEventData } from "../../fake-mailgun/events";
import { compileExpression } from "../../fake-mailgun/handlers/routes";
import { startFakeMailgun } from "../../fake-mailgun/server";
import { hmacSignature, randomToken, signedEventRequest } from "../../fake-mailgun/webhooks";

/**
 * The fake Mailgun server's own contract (M3-DESIGN §6.2, research §15): auth per endpoint, unknown domains and the
 * other region, the request log, reset, events and their two shapes, the switches, faults, signing and the admin API.
 * These call the fake over plain HTTP, independent of MailgunClient.
 */

const D = "send.example.com";
const fake = await startFakeMailgun({ domain: D });
const AUTH = "Basic " + Buffer.from("api:key-fake-api").toString("base64");

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

async function call(
  method: string,
  path: string,
  opts: { auth?: string | null; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== null) headers.authorization = opts.auth ?? AUTH;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(fake.origin + path, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

function sendForm(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
}

const basicSend = (over: Record<string, string | string[]> = {}) =>
  sendForm({ from: `Ali <ali@${D}>`, to: "tester@gmail.com", subject: "Hi", text: "Hello", "h:Message-Id": `<pp.x1@${D}>`, ...over });

describe("auth", () => {
  it("answers the send endpoint with plain 'Forbidden' and the others with JSON", async () => {
    const send = await call("POST", `/v3/${D}/messages`, { auth: null, body: basicSend() });
    expect(send.status).toBe(401);
    expect(send.text).toBe("Forbidden");
    const wrong = await call("GET", `/v4/domains/${D}`, { auth: "Basic " + Buffer.from("api:key-fake-nope").toString("base64") });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ message: "Invalid private key" });
    expect((await call("GET", "/v3/routes", { auth: null })).status).toBe(401);
  });

  it("puts rate-limit headers on every answer", async () => {
    const res = await call("GET", `/v4/domains/${D}`);
    expect(res.headers.get("x-ratelimit-limit")).toBe("300");
    expect(Number(res.headers.get("x-ratelimit-reset"))).toBeGreaterThan(1e12);
  });
});

describe("domains and regions", () => {
  it("knows only its own domain", async () => {
    expect((await call("GET", `/v4/domains/${D}`)).status).toBe(200);
    const other = await call("GET", "/v4/domains/other.example.com");
    expect(other.status).toBe(404);
    expect(other.json).toEqual({ message: "Domain not found" });
    expect((await call("POST", "/v3/other.example.com/messages", { body: basicSend() })).status).toBe(404);
  });

  it("treats a request for the other region as an unknown domain", async () => {
    expect((await call("GET", `/v4/domains/${D}`, { headers: { "x-outreach-region": "US" } })).status).toBe(404);
    expect((await call("GET", `/v4/domains/${D}`, { headers: { "x-outreach-region": "EU" } })).status).toBe(200);
    const us = await startFakeMailgun({ domain: D, region: "US" });
    try {
      const res = await fetch(`${us.origin}/v4/domains/${D}`, { headers: { authorization: AUTH, "x-outreach-region": "EU" } });
      expect(res.status).toBe(404);
    } finally {
      await us.close();
    }
  });

  it("answers unknown paths like Mailgun (404 without JSON)", async () => {
    const res = await call("GET", "/v9/nothing");
    expect(res.status).toBe(404);
    expect(res.text).toBe("404 page not found");
  });
});

describe("request log and reset", () => {
  it("logs method, path, query, parsed body and headers without Authorization", async () => {
    await call("POST", `/v3/${D}/messages`, { body: basicSend({ "o:tag": ["a", "b"] }) });
    await call("POST", "/v1/analytics/logs", { json: { events: ["accepted"] } });
    await call("DELETE", `/v4/domains/${D}/webhooks?url=https%3A%2F%2Fa.example.com%2Fh`);
    const [send, logs, del] = fake.requests;
    expect(send).toMatchObject({ method: "POST", path: `/v3/${D}/messages` });
    expect((send!.body as Record<string, string[]>)["o:tag"]).toEqual(["a", "b"]);
    expect(send!.headers.authorization).toBeUndefined();
    expect(logs!.body).toEqual({ events: ["accepted"] });
    expect(del!.query).toEqual({ url: ["https://a.example.com/h"] });
  });

  it("reset clears everything and keeps the live arrays", async () => {
    const messages = fake.messages;
    await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    fake.setDns("all");
    fake.failNext("GET /v4/domains/:d", { kind: "status", status: 500, body: "x" });
    expect(messages).toHaveLength(1);
    fake.reset();
    expect(messages).toHaveLength(0);
    expect(fake.messages).toBe(messages);
    expect(fake.requests).toHaveLength(0);
    expect(fake.state().dns).toEqual({ spf: false, dkim: false, mx: false, tracking: false });
    expect((await call("GET", `/v4/domains/${D}`)).status).toBe(200);
  });
});

describe("messages and events", () => {
  it("validates like Mailgun", async () => {
    const miss = async (drop: string) => {
      const fields: Record<string, string> = { from: `Ali <ali@${D}>`, to: "tester@gmail.com", subject: "Hi", text: "Hello" };
      delete fields[drop];
      return (await call("POST", `/v3/${D}/messages`, { body: sendForm(fields) })).json;
    };
    expect(await miss("from")).toEqual({ message: "from parameter is missing. " });
    expect(await miss("to")).toEqual({ message: "to parameter is missing. " });
    expect(await miss("subject")).toEqual({ message: "subject parameter is missing. " });
    expect(await miss("text")).toEqual({ message: "Need at least one of 'text', 'html', 'amp-html' or 'template' parameters specified." });
    const bad = await call("POST", `/v3/${D}/messages`, { body: basicSend({ to: "not an address" }) });
    expect(bad.json).toEqual({ message: "to parameter is not a valid address. please check documentation." });
    const big = await call("POST", `/v3/${D}/messages`, { body: basicSend({ "v:blob": "x".repeat(17_000) }) });
    expect(big.json).toEqual({ message: "Send options (parameters starting with o:, h:, or v:) are limited to 16KB total" });
    expect(fake.messages).toHaveLength(0);
  });

  it("accepts, doesn't dedupe, and records accepted events with the Logs shape", async () => {
    const a = await call("POST", `/v3/${D}/messages`, { body: basicSend({ "v:send_id": "s1", "o:testmode": "yes" }) });
    const b = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    expect(a.json).toEqual({ id: `<pp.x1@${D}>`, message: "Queued. Thank you." });
    expect(b.status).toBe(200);
    expect(fake.messages).toHaveLength(2);
    const events = fake.state().logEvents;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "accepted", recipient: "tester@gmail.com", "user-variables": '{"send_id":"s1"}' });
    expect((events[0]!.message as { headers: Record<string, string> }).headers["message-id"]).toBe(`pp.x1@${D}`);
    expect((events[0]!.flags as Record<string, boolean>)["is-test-mode"]).toBe(true);
  });

  it("builds webhook event-data with Mailgun's quirks", async () => {
    await call("POST", `/v3/${D}/messages`, { body: basicSend({ "v:send_id": "s1", "o:tag": ["outreach", "step-0"] }) });
    const delivered = fake.deliver(`pp.x1@${D}`);
    expect(delivered).toMatchObject({ event: "delivered", recipient: "tester@gmail.com", "user-variables": { send_id: "s1" }, tags: ["outreach", "step-0"] });
    expect(typeof delivered.timestamp).toBe("number");
    expect((delivered["delivery-status"] as Record<string, unknown>).code).toBe(250);

    const temp = fake.tempFail(`<pp.x1@${D}>`);
    expect(temp).toMatchObject({ event: "failed", severity: "temporary", reason: "generic" });

    const unsub = fake.unsubscribe(`pp.x1@${D}`);
    expect(unsub).toMatchObject({ event: "unsubscribed", storage: [], tags: ["*"] });
    expect(fake.state().suppressions.unsubscribes.map((s) => s.address)).toEqual(["tester@gmail.com"]);

    const complaint = fake.complain(`pp.x1@${D}`);
    expect(complaint).toMatchObject({ event: "complained", "log-level": "warn" });
    expect(fake.state().suppressions.complaints).toHaveLength(1);

    const hard = fake.bounce(`pp.x1@${D}`);
    expect(hard).toMatchObject({ event: "failed", severity: "permanent", reason: "bounce" });
    expect((hard["delivery-status"] as Record<string, unknown>)["bounce-type"]).toBe("hard");
    expect(fake.state().suppressions.bounces.map((s) => s.code)).toEqual(["550"]);

    const other = fake.bounce(`pp.x1@${D}`, { reason: "espblock", code: 554 });
    expect(other).toMatchObject({ reason: "espblock" });
    expect(fake.state().logEvents.map((e) => e.event)).toEqual(["accepted", "delivered", "failed", "unsubscribed", "complained", "failed", "failed"]);
    expect(() => fake.deliver("unknown@nowhere")).toThrow(/no message/);
  });

  it("delivers test-mode messages with code 650 and user-variables [] when there are none", async () => {
    await call("POST", `/v3/${D}/messages`, { body: basicSend({ "o:testmode": "yes" }) });
    const ev = fake.deliver(`pp.x1@${D}`);
    expect(ev["user-variables"]).toEqual([]);
    expect((ev["delivery-status"] as Record<string, unknown>).code).toBe(650);
    expect((ev.flags as Record<string, boolean>)["is-test-mode"]).toBe(true);
  });

  it("drops sends to suppressed addresses with suppress-* failures", async () => {
    fake.addSuppression("unsubscribes", "tester@gmail.com");
    await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    const events = fake.state().logEvents;
    expect(events.map((e) => [e.event, e.reason ?? null])).toEqual([
      ["accepted", null],
      ["failed", "suppress-unsubscribe"],
    ]);
  });

  it("rewriteMessageId answers and emits Mailgun's own id; our id still finds the message", async () => {
    fake.setSwitches({ rewriteMessageId: true });
    const res = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    const id = String((res.json as { id: string }).id).replace(/[<>]/g, "");
    expect(id).not.toBe(`pp.x1@${D}`);
    const ev = fake.deliver(`pp.x1@${D}`);
    expect((ev.message as { headers: Record<string, string> }).headers["message-id"]).toBe(id);
  });
});

describe("Logs", () => {
  const window = () => ({
    start: new Date(Date.now() - 3_600_000).toUTCString().slice(0, 25) + " -0000",
    end: new Date(Date.now() + 60_000).toUTCString().slice(0, 25) + " -0000",
  });

  it("hides events until indexLagMs has passed and drops events older than retention", async () => {
    let now = new Date();
    const lagged = await startFakeMailgun({ domain: D, indexLagMs: 60_000, retentionDays: 1, now: () => now });
    try {
      const post = (path: string, init: RequestInit) => fetch(lagged.origin + path, { ...init, headers: { ...(init.headers ?? {}), authorization: AUTH } });
      await post(`/v3/${D}/messages`, { method: "POST", body: basicSend() });
      const q = (w: { start: string; end: string }) =>
        post("/v1/analytics/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...w, events: ["accepted"] }),
        }).then((r) => r.json() as Promise<{ items: unknown[] }>);
      const w1 = {
        start: new Date(now.getTime() - 3_600_000).toUTCString().slice(0, 25) + " -0000",
        end: new Date(now.getTime() + 3_600_000).toUTCString().slice(0, 25) + " -0000",
      };
      expect((await q(w1)).items).toHaveLength(0);
      now = new Date(now.getTime() + 61_000);
      expect((await q(w1)).items).toHaveLength(1);
      now = new Date(now.getTime() + 2 * 86_400_000);
      expect((await q({ start: w1.start, end: new Date(now).toUTCString().slice(0, 25) + " -0000" })).items).toHaveLength(0);
    } finally {
      await lagged.close();
    }
  });

  it("refuses a limit above 100, a changed body mid-walk and unsupported filters", async () => {
    expect((await call("POST", "/v1/analytics/logs", { json: { ...window(), pagination: { limit: 101 } } })).status).toBe(400);
    for (let i = 0; i < 3; i++) await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    const first = (await call("POST", "/v1/analytics/logs", { json: { ...window(), events: ["accepted"], pagination: { limit: 1 } } })).json as {
      pagination: { next: string };
    };
    const changed = await call("POST", "/v1/analytics/logs", {
      json: { ...window(), events: ["delivered"], pagination: { limit: 1, token: first.pagination.next } },
    });
    expect(changed.status).toBe(400);
    const unsupported = await call("POST", "/v1/analytics/logs", {
      json: { ...window(), filter: { AND: [{ attribute: "ip", comparator: "=", values: [{ label: "1", value: "1" }] }] } },
    });
    expect(unsupported.status).toBe(400);
  });

  it("strictDuration demands duration; bracketedMessageIdFilter and brokenContainsFilter change matching", async () => {
    await call("POST", `/v3/${D}/messages`, { body: basicSend({ "v:send_id": "abc123" }) });
    const q = (filter: { attribute: string; comparator: string; value: string }, extra: Record<string, unknown> = {}) =>
      call("POST", "/v1/analytics/logs", {
        json: { ...window(), ...extra, filter: { AND: [{ attribute: filter.attribute, comparator: filter.comparator, values: [{ label: filter.value, value: filter.value }] }] } },
      }).then((r) => r);
    expect(((await q({ attribute: "message_id", comparator: "=", value: `pp.x1@${D}` })).json as { items: unknown[] }).items).toHaveLength(1);
    expect(((await q({ attribute: "user_variables", comparator: "contains", value: "abc123" })).json as { items: unknown[] }).items).toHaveLength(1);

    fake.setSwitches({ bracketedMessageIdFilter: true, brokenContainsFilter: true, strictDuration: true });
    const noDuration = await q({ attribute: "domain", comparator: "=", value: D });
    expect(noDuration.json).toEqual({ message: "duration is required" });
    const withDuration = { end: window().end, duration: "2h" };
    const plain = await call("POST", "/v1/analytics/logs", {
      json: { ...withDuration, filter: { AND: [{ attribute: "message_id", comparator: "=", values: [{ label: "x", value: `pp.x1@${D}` }] }] } },
    });
    expect((plain.json as { items: unknown[] }).items).toHaveLength(0);
    const bracketed = await call("POST", "/v1/analytics/logs", {
      json: { ...withDuration, filter: { AND: [{ attribute: "message_id", comparator: "=", values: [{ label: "x", value: `<pp.x1@${D}>` }] }] } },
    });
    expect((bracketed.json as { items: unknown[] }).items).toHaveLength(1);
    const contains = await call("POST", "/v1/analytics/logs", {
      json: { ...withDuration, filter: { AND: [{ attribute: "user_variables", comparator: "contains", values: [{ label: "x", value: "abc123" }] }] } },
    });
    expect((contains.json as { items: unknown[] }).items).toHaveLength(0);
  });

  it("shows stored inbound as a `stored` event with storage.url as an array", async () => {
    const r = fake.receive({ from: "Anna <anna@studio.de>", to: `ali@${D}`, subject: "Re: hi", text: "Hello back", references: ["a@x", "b@x"] });
    const res = await call("POST", "/v1/analytics/logs", { json: { ...window(), events: ["stored"] } });
    const item = (res.json as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item.event).toBe("stored");
    expect((item.storage as { url: string[]; key: string }).url).toEqual([r.messageUrl]);
    expect((item.flags as Record<string, boolean>)["is-routed"]).toBe(true);
    const headers = JSON.parse(r.fields["message-headers"]!) as Array<[string, string]>;
    expect(headers.find(([n]) => n === "References")?.[1]).toBe("<a@x> <b@x>");
    const stored = await call("GET", `/v3/domains/${D}/messages/${r.storageKey}`, { headers: { accept: "message/rfc2822" } });
    expect(stored.json).toMatchObject({ recipients: `ali@${D}`, sender: "anna@studio.de" });
  });
});

describe("suppression lists", () => {
  it("pages with absolute URLs on the fake's origin; next is there even on the last page", async () => {
    for (const a of ["c@x.com", "a@x.com", "b@x.com"]) fake.addSuppression("bounces", a);
    const p1 = (await call("GET", `/v3/${D}/bounces?limit=2`)).json as { items: Array<{ address: string; code: string }>; paging: { next: string } };
    expect(p1.items.map((i) => i.address)).toEqual(["a@x.com", "b@x.com"]);
    expect(typeof p1.items[0]!.code).toBe("string");
    expect(p1.paging.next.startsWith(fake.origin)).toBe(true);
    const p2 = (await call("GET", p1.paging.next.slice(fake.origin.length))).json as { items: Array<{ address: string }>; paging: { next: string } };
    expect(p2.items.map((i) => i.address)).toEqual(["c@x.com"]);
    const p3 = (await call("GET", p2.paging.next.slice(fake.origin.length))).json as { items: unknown[] };
    expect(p3.items).toEqual([]);
    expect((await call("GET", `/v3/${D}/bounces?limit=1001`)).status).toBe(400);
  });

  it("crossOriginNext puts a foreign host in paging.next", async () => {
    fake.addSuppression("complaints", "a@x.com");
    fake.setSwitches({ crossOriginNext: true });
    const p = (await call("GET", `/v3/${D}/complaints`)).json as { paging: { next: string } };
    expect(new URL(p.paging.next).origin).not.toBe(fake.origin);
  });

  it("bulk-adds unsubscribes: JSON only, fewer than 1,000, upsert", async () => {
    const form = await call("POST", `/v3/${D}/unsubscribes`, { body: new URLSearchParams({ address: "a@x.com" }) });
    expect(form.status).toBe(400);
    const tooMany = await call("POST", `/v3/${D}/unsubscribes`, { json: Array.from({ length: 1000 }, (_, i) => ({ address: `p${i}@x.com` })) });
    expect(tooMany.json).toEqual({ message: "Batch size should be less than 1000" });
    const ok = await call("POST", `/v3/${D}/unsubscribes`, { json: [{ address: "A@x.com", tags: ["*"] }, { address: "a@x.com" }] });
    expect(ok.json).toEqual({ message: "2 addresses have been added to the unsubscribes table" });
    expect(fake.state().suppressions.unsubscribes).toHaveLength(1);
  });
});

describe("faults", () => {
  it("status faults answer once, then the normal answer returns", async () => {
    fake.failNext("GET /v4/domains/:d", { kind: "status", status: 502, body: "bad gateway", headers: { "x-extra": "1" } }, 2);
    const a = await call("GET", `/v4/domains/${D}`);
    const b = await call("GET", `/v4/domains/${D}`);
    const c = await call("GET", `/v4/domains/${D}`);
    expect([a.status, b.status, c.status]).toEqual([502, 502, 200]);
    expect(a.text).toBe("bad gateway");
    expect(a.headers.get("x-extra")).toBe("1");
  });

  it("an empty header value removes a default header", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "status", status: 429, body: { message: "x" }, headers: { "X-RateLimit-Reset": "" } });
    const res = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-reset")).toBeNull();
  });

  it("hang never answers until reset or close", async () => {
    fake.failNext("GET /v3/routes", { kind: "hang" });
    const pending = fetch(`${fake.origin}/v3/routes`, { headers: { authorization: AUTH }, signal: AbortSignal.timeout(300) });
    await expect(pending).rejects.toThrow();
  });

  it("accept faults record the message first", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "acceptThenRedirect" });
    const redirect = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    expect(redirect.status).toBe(302);
    fake.failNext("POST /v3/:d/messages", { kind: "acceptWithoutId" });
    const noId = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    expect(noId.json).toEqual({});
    fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
    await expect(call("POST", `/v3/${D}/messages`, { body: basicSend() })).rejects.toThrow();
    expect(fake.messages).toHaveLength(3);
    // an accept fault on a refused send changes nothing: the 400 comes back
    fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
    expect((await call("POST", `/v3/${D}/messages`, { body: basicSend({ to: "bad" }) })).status).toBe(400);
  });

  it("businessVerification answers 403 with the verification text", async () => {
    fake.failNext("POST /v3/:d/messages", { kind: "businessVerification" });
    const res = await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    expect(res.status).toBe(403);
    expect((res.json as { message: string }).message).toMatch(/business verification/i);
  });
});

describe("settings endpoints", () => {
  it("webhooks: 4th URL refused; DELETE without url → {Field}", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await call("POST", `/v4/domains/${D}/webhooks`, { body: new URLSearchParams([["url", `https://h${i}.example.com/x`], ["event_types", "delivered"]]) });
      expect(r.status).toBe(200);
    }
    const fourth = await call("POST", `/v4/domains/${D}/webhooks`, { body: new URLSearchParams([["url", "https://h4.example.com/x"], ["event_types", "delivered"]]) });
    expect(fourth.json).toEqual({ Reason: "too many urls" });
    expect((await call("DELETE", `/v4/domains/${D}/webhooks`)).json).toEqual({ Field: "url" });
  });

  it("the signing key POST regenerates (so tests can prove the app never calls it); monthly limit PUT is 403", async () => {
    const before = fake.state().signingKey;
    await call("POST", "/v5/accounts/http_signing_key");
    expect(fake.state().signingKey).not.toBe(before);
    expect(fake.state().signingKeyRegenerated).toBe(1);
    expect((await call("PUT", "/v5/accounts/limit/custom/monthly?limit=30000")).status).toBe(403);
  });

  it("certPolls decides which status call turns the certificate active", async () => {
    fake.setDns(["tracking"]);
    fake.setSwitches({ certPolls: 3 });
    await call("POST", `/v2/x509/email.${D}`);
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) statuses.push(((await call("GET", `/v2/x509/email.${D}/status`)).json as { status: string }).status);
    expect(statuses).toEqual(["processing", "processing", "active"]);
    expect((await call("GET", `/v2/x509/email.other.com/status`)).status).toBe(404);
  });

  it("route expressions: python-style regex and catch_all()", () => {
    const re = compileExpression('match_recipient("^ali\\.b@send\\.example\\.com$")');
    expect(re).toBeInstanceOf(RegExp);
    expect((re as RegExp).test("ali.b@send.example.com")).toBe(true);
    expect((re as RegExp).test("aliXb@send.example.com")).toBe(false);
    expect(compileExpression("catch_all()")).toBe("catch-all");
    expect(compileExpression("match_recipient('^(?P<user>.*)@x\\.com$')")).toBeInstanceOf(RegExp);
    expect(compileExpression('match_header("subject", "x")')).toBeNull();
  });
});

describe("signing (independent HMAC)", () => {
  it("matches the research test vector", () => {
    expect(
      hmacSignature("key-0123456789abcdef0123456789abcdef", "1770920772", "e0b5477167110d68991efc6b9f89f0a11066af27834600e123"),
    ).toBe("6ae8ba140d2536fd21c45a0db161e962a424ed6ca953c96a63182621e118ee13");
    expect(randomToken()).toMatch(/^[0-9a-f]{50}$/);
  });

  it("signs event webhooks (string or numeric timestamp, tamper)", async () => {
    const now = new Date("2026-09-23T10:00:00Z");
    const req = signedEventRequest("http://127.0.0.1:3100/api/webhooks/mailgun/events", { event: "delivered" }, { now, token: "t".repeat(50) });
    const body = (await req.json()) as { signature: { timestamp: string; token: string; signature: string }; "event-data": unknown };
    expect(body.signature.timestamp).toBe(String(now.getTime() / 1000));
    expect(body.signature.signature).toBe(hmacSignature("key-fake-signing", body.signature.timestamp, "t".repeat(50)));
    expect(body["event-data"]).toEqual({ event: "delivered" });
    expect(req.headers.get("content-type")).toBe("application/json");

    const numeric = (await signedEventRequest("http://127.0.0.1:3100/x", {}, { key: "k-123456", timestamp: 1770920772 }).json()) as {
      signature: { timestamp: unknown; token: string; signature: string };
    };
    expect(numeric.signature.timestamp).toBe(1770920772);
    expect(numeric.signature.signature).toBe(hmacSignature("k-123456", "1770920772", numeric.signature.token));

    const bad = (await signedEventRequest("http://127.0.0.1:3100/x", {}, { key: "k-123456", tamper: true, token: "a".repeat(50), timestamp: "1770920772" }).json()) as {
      signature: { signature: string };
    };
    expect(bad.signature.signature).not.toBe(hmacSignature("k-123456", "1770920772", "a".repeat(50)));
    expect(bad.signature.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs inbound notifications as urlencoded or multipart forms with flat signature fields", async () => {
    const r = fake.receive({ from: "Anna <anna@studio.de>", to: `ali@${D}`, subject: "Re: hi", text: "Yes" });
    for (const multipart of [false, true]) {
      const req = fake.signedInboundRequest("http://127.0.0.1:3100/api/webhooks/mailgun/inbound", r.fields, { multipart });
      expect(req.headers.get("content-type")).toMatch(multipart ? /^multipart\/form-data/ : /^application\/x-www-form-urlencoded/);
      const form = await req.formData();
      expect(form.get("recipient")).toBe(`ali@${D}`);
      expect(form.get("message-url")).toBe(r.messageUrl);
      expect(form.get("signature")).toBe(hmacSignature("key-fake-signing", String(form.get("timestamp")), String(form.get("token"))));
    }
  });

  it("uses the fake's clock and signing key for its own signed requests", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    fake.setNow(() => at);
    await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    const ev = fake.deliver(`pp.x1@${D}`);
    const req = fake.signedEventRequest("http://127.0.0.1:3100/api/webhooks/mailgun/events", ev);
    const body = (await req.json()) as { signature: { timestamp: string } };
    expect(body.signature.timestamp).toBe(String(at.getTime() / 1000));
    expect(ev.timestamp).toBe(at.getTime() / 1000);
  });
});

describe("admin API and CLI", () => {
  it("serves state and messages, and drives events, DNS, the queue, the clock and faults", async () => {
    await call("POST", `/v3/${D}/messages`, { body: basicSend() });
    const admin = (method: string, path: string, json?: unknown) => call(method, `/__fake/${path}`, { auth: null, json });
    expect(((await admin("GET", "messages")).json as { messages: unknown[] }).messages).toHaveLength(1);
    expect(((await admin("POST", "deliver", { messageId: `pp.x1@${D}` })).json as { eventData: { event: string } }).eventData.event).toBe("delivered");
    expect((await admin("POST", "bounce", { messageId: `pp.x1@${D}`, reason: "espblock" })).status).toBe(200);
    expect((await admin("POST", "deliver", { messageId: `pp.x1@${D}`, webhook: true })).json).toMatchObject({ error: expect.stringMatching(/--app/) });
    expect(((await admin("POST", "dns", { valid: ["spf", "dkim"] })).json as { dns: Record<string, boolean> }).dns).toEqual({ spf: true, dkim: true, mx: false, tracking: false });
    expect((await admin("POST", "queue", { disabled: true, reason: "Too many" })).json).toMatchObject({ queue: { regularDisabled: true, reason: "Too many" } });
    expect((await admin("POST", "clock", { now: "2026-09-24T08:00:00.000Z" })).json).toEqual({ now: "2026-09-24T08:00:00.000Z" });
    expect(fake.now().toISOString()).toBe("2026-09-24T08:00:00.000Z");
    await admin("POST", "fail-next", { route: "GET /v3/routes", fault: { kind: "status", status: 500, body: "x" } });
    expect((await call("GET", "/v3/routes")).status).toBe(500);
    const inbound = (await admin("POST", "inbound", { from: "a@b.com", to: `ali@${D}`, subject: "s", text: "t" })).json as { storageKey: string };
    expect(inbound.storageKey).toBeTruthy();
    const state = (await admin("GET", "state")).json as { queue: { regularDisabled: boolean }; logEvents: unknown[] };
    expect(state.queue.regularDisabled).toBe(true);
    expect((await admin("POST", "nope")).status).toBe(404);
    expect((await admin("POST", "reset")).json).toEqual({ reset: true });
    expect(fake.messages).toHaveLength(0);
    // admin calls are never logged as API requests
    expect(fake.requests.some((r) => r.path.startsWith("/__fake"))).toBe(false);
  });

  it("posts signed webhooks and replies to a loopback app", async () => {
    const received: Array<{ path: string; contentType: string; body: string }> = [];
    const app = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push({ path: req.url ?? "", contentType: req.headers["content-type"] ?? "", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const withApp = await startFakeMailgun({ domain: D, appUrl });
    try {
      const post = (path: string, json: unknown) =>
        fetch(`${withApp.origin}/__fake/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
      await fetch(`${withApp.origin}/v3/${D}/messages`, { method: "POST", headers: { authorization: AUTH }, body: basicSend() });
      const res = await post("deliver", { messageId: `pp.x1@${D}`, webhook: true });
      expect(res.webhook).toEqual({ status: 200, body: '{"ok":true}' });
      const inbound = await post("inbound", { from: "Anna <anna@studio.de>", to: `ali@${D}`, subject: "Re", text: "Yes", notify: true });
      expect((inbound.notify as { status: number }).status).toBe(200);
      expect(received.map((r) => r.path)).toEqual(["/api/webhooks/mailgun/events", "/api/webhooks/mailgun/inbound"]);
      const event = JSON.parse(received[0]!.body) as { signature: { timestamp: string; token: string; signature: string } };
      expect(event.signature.signature).toBe(hmacSignature("key-fake-signing", event.signature.timestamp, event.signature.token));
      expect(received[1]!.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    } finally {
      await withApp.close();
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  it("parses the CLI flags and refuses a non-loopback app", () => {
    expect(
      parseCliArgs([
        "--port",
        "4010",
        "--domain",
        "Send.Example.com",
        "--api-key",
        "key-fake-api",
        "--signing-key",
        "key-fake-signing",
        "--app",
        "http://127.0.0.1:3100/",
        "--switch",
        "strictDuration",
        "--switch=certPolls=3",
        "--region=US",
      ]),
    ).toEqual({
      port: 4010,
      domain: "send.example.com",
      apiKey: "key-fake-api",
      signingKey: "key-fake-signing",
      appUrl: "http://127.0.0.1:3100",
      region: "US",
      switches: { strictDuration: true, certPolls: 3 },
    });
    expect(() => parseCliArgs(["--app", "https://outreach.example.com"])).toThrow(/only posts to this PC/);
    expect(() => parseCliArgs(["--switch", "nope"])).toThrow(/Unknown switch/);
    expect(() => parseCliArgs(["--port"])).toThrow(/needs a value/);
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown option/);
  });

  it("event-data renders one event the webhook way", () => {
    const ev = toEventData({
      id: "e1",
      event: "unsubscribed",
      at: new Date("2026-09-23T10:00:00Z"),
      domain: D,
      recipient: "a@x.com",
      messageId: "m@x",
      from: "f",
      to: "t",
      subject: "s",
      tags: ["outreach"],
      userVariables: {},
      testMode: false,
      logLevel: "info",
      storage: { key: "k", url: "u" },
    });
    expect(ev).toMatchObject({ storage: [], tags: ["*"], "user-variables": [], timestamp: Date.parse("2026-09-23T10:00:00Z") / 1000 });
  });
});
