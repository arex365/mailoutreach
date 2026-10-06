import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { randomToken, signedEventRequest } from "../../fake-mailgun/webhooks";
import { eventData, makeOwner, seedEmail, setSetting, setState } from "../mail-events/seed";

const t = await createTestDb("webhook-events");
const { db, dbWrite } = await import("@/server/db");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { POST } = await import("@/app/api/webhooks/mailgun/events/route");
const { handleEventWebhook, SELF_CHECK_HEADER } = await import("@/server/services/mail-events/webhook");

const URL = "http://127.0.0.1:3000/api/webhooks/mailgun/events";
const KEY = "key-fake-signing";
let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await setSetting("mailgun.domain", "send.example.com");
  await setSecret("mailgun.webhookSigningKey", KEY, null);
  await dbWrite((c) => c.sendingDomain.create({ data: { name: "send.example.com", region: "EU" } }));
});

beforeEach(async () => {
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["webhooks.stats", "notices"] } } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

function rawRequest(body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request(URL, { method: "POST", headers, body });
}

/** A body that counts how much of it was read (to prove an oversized body isn't read to the end). */
function countedStream(total: number, chunk = 16 * 1024) {
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, sent: () => sent, cancelled: () => cancelled };
}

async function stats() {
  return (await db.systemState.findUnique({ where: { key: "webhooks.stats" } }))?.value as Record<string, unknown> | undefined;
}

describe("POST /api/webhooks/mailgun/events", () => {
  it("stores a valid event and answers 200", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const res = await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId, type: "delivered", source: "WEBHOOK" } })).toBe(1);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).deliveredAt).toBeInstanceOf(Date);
    expect((await stats())?.lastEventAt).toEqual(expect.any(String));
  });

  it("refuses a tampered signature with 401 and stores nothing", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const res = await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, tamper: true }));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "signature" });
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(0);
  });

  it("refuses a stale timestamp and one from the future (406)", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const old = String(Math.floor(Date.now() / 1000) - 13 * 3600);
    expect((await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, timestamp: old }))).status).toBe(406);
    const future = String(Math.floor(Date.now() / 1000) + 2 * 3600);
    expect((await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, timestamp: future }))).status).toBe(406);
    // 11 hours old is still fine (Mailgun retries for about 8 hours with the original signature).
    const late = String(Math.floor(Date.now() / 1000) - 11 * 3600);
    expect((await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, timestamp: late }))).status).toBe(200);
  });

  it("answers 406 for unreadable JSON, missing signature fields and the wrong content type", async () => {
    expect((await POST(rawRequest("{not json"))).status).toBe(406);
    expect((await POST(rawRequest(JSON.stringify({ "event-data": {} })))).status).toBe(406);
    expect((await POST(rawRequest(JSON.stringify({ signature: { timestamp: "1770920772", token: randomToken() } })))).status).toBe(406);
    expect((await POST(rawRequest("{}", { "content-type": "text/plain" }))).status).toBe(406);
    expect((await POST(rawRequest("a=b", { "content-type": "application/x-www-form-urlencoded" }))).status).toBe(406);
  });

  it("answers 406 for an unreadable event (no id, event or timestamp)", async () => {
    const res = await POST(signedEventRequest(URL, { event: "delivered" }, { key: KEY }));
    expect(res.status).toBe(406);
  });

  it("refuses a body over 256 KB without reading it all, with and without content-length", async () => {
    const big = countedStream(10 * 1024 * 1024);
    const withLength = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: big.stream,
      duplex: "half",
    } as RequestInit);
    const r1 = await POST(withLength);
    expect(r1.status).toBe(406);
    expect(await json(r1)).toEqual({ error: "too-large" });
    expect(big.sent()).toBeLessThanOrEqual(32 * 1024);

    const noLength = countedStream(4 * 1024 * 1024);
    const r2 = await POST(
      new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: noLength.stream, duplex: "half" } as RequestInit),
    );
    expect(r2.status).toBe(406);
    expect(noLength.sent()).toBeLessThan(400 * 1024);
    expect(noLength.cancelled()).toBe(true);
  });

  it("treats a replayed token as a no-op (200, no second event)", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const token = randomToken();
    expect((await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, token }))).status).toBe(200);
    // Same signature block, forged body: the token was used, so nothing is stored.
    const replay = await POST(signedEventRequest(URL, eventData(s, "complain"), { key: KEY, token }));
    expect(replay.status).toBe(200);
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(1);
    expect((await db.suppression.findUnique({ where: { emailNorm: s.toNorm } }))).toBeNull();
  });

  it("treats the same event with a new token as a no-op", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const data = eventData(s, "bounce");
    expect((await POST(signedEventRequest(URL, data, { key: KEY }))).status).toBe(200);
    expect((await POST(signedEventRequest(URL, data, { key: KEY }))).status).toBe(200);
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(1);
  });

  it("answers 401 when no signing key is saved", async () => {
    await deleteSecret("mailgun.webhookSigningKey");
    try {
      const s = await seedEmail({ createdById: ownerId });
      const res = await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY }));
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "no-key" });
      expect((await stats())?.lastRejectReason).toBe("no-key");
    } finally {
      await setSecret("mailgun.webhookSigningKey", KEY, null);
    }
  });

  it("answers 500 when the database stays busy, so Mailgun retries", async () => {
    const s = await seedEmail({ createdById: ownerId });
    vi.spyOn(db, "$transaction").mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    const res = await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY }));
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "busy" });
    vi.restoreAllMocks();
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(0);
  });

  it("accepts a numeric signature timestamp (normalised with String())", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const res = await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, timestamp: Math.floor(Date.now() / 1000) }));
    expect(res.status).toBe(200);
  });

  it("leaves webhooks.stats alone for the monitor's self-check", async () => {
    await setState("tunnel.status", { state: "connected", selfCheckNonce: "nonce-123" });
    const before = await db.systemState.findUnique({ where: { key: "webhooks.stats" } });
    const res = await handleEventWebhook(
      new Request(URL, { method: "POST", headers: { "content-type": "application/json", [SELF_CHECK_HEADER]: "nonce-123" }, body: "{}" }),
    );
    expect(res.status).toBe(406);
    const after = await db.systemState.findUnique({ where: { key: "webhooks.stats" } });
    expect(after).toEqual(before);
    // A wrong nonce is an ordinary request and is recorded.
    await handleEventWebhook(
      new Request(URL, { method: "POST", headers: { "content-type": "application/json", [SELF_CHECK_HEADER]: "guess" }, body: "{}" }),
    );
    expect((await stats())?.lastRejectReason).toBe("unreadable");
  });

  it("never counts junk from the internet (another domain, a stale timestamp) toward the notice", async () => {
    const s = await seedEmail({ createdById: ownerId });
    for (let i = 0; i < 4; i++) {
      await POST(signedEventRequest(URL, eventData(s, "delivered", { domain: "stranger.example.org" }), { key: KEY, tamper: true }));
      const stale = String(Math.floor(Date.now() / 1000) - 20 * 3600);
      await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, tamper: true, timestamp: stale }));
    }
    expect((await stats())?.rejects ?? []).toEqual([]);
    expect(await db.notification.count({ where: { title: "Mailgun's messages to the app are being rejected" } })).toBe(0);
  });

  it("sends one notice after 3 counted rejections with no valid webhook in between", async () => {
    await dbWrite((c) => c.notification.deleteMany({ where: { title: "Mailgun's messages to the app are being rejected" } }));
    const s = await seedEmail({ createdById: ownerId });
    const reject = () => POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, tamper: true }));
    await reject();
    await reject();
    expect(await db.notification.count({ where: { title: "Mailgun's messages to the app are being rejected" } })).toBe(0);
    await reject();
    await reject();
    const notes = await db.notification.findMany({ where: { title: "Mailgun's messages to the app are being rejected" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: ownerId,
      type: "system.mailgun",
      body: "The webhook signing key saved in the app doesn't match Mailgun's. Click Apply recommended settings in Settings › Domain checklist to fetch it again.",
      link: "/settings/domain",
    });
    expect(((await stats())?.rejects as string[]).length).toBe(4);
  });

  it("doesn't send the notice when a valid webhook arrived between the rejections", async () => {
    await dbWrite((c) => c.notification.deleteMany({ where: { title: "Mailgun's messages to the app are being rejected" } }));
    const s = await seedEmail({ createdById: ownerId });
    const reject = () => POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY, tamper: true }));
    await reject();
    await reject();
    await new Promise((r) => setTimeout(r, 5));
    expect((await POST(signedEventRequest(URL, eventData(s, "delivered"), { key: KEY }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    await reject();
    await reject();
    expect(await db.notification.count({ where: { title: "Mailgun's messages to the app are being rejected" } })).toBe(0);
  });
});
