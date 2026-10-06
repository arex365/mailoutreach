import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { randomToken, signedInboundRequest } from "../../fake-mailgun/webhooks";
import { makeOwner, seedEmail, setSetting } from "../mail-events/seed";

const t = await createTestDb("webhook-inbound");
const { db, dbWrite } = await import("@/server/db");
const { setSecret } = await import("@/server/secrets");
const { POST } = await import("@/app/api/webhooks/mailgun/inbound/route");

const URL = "http://127.0.0.1:3000/api/webhooks/mailgun/inbound";
const KEY = "key-fake-signing";
let ownerId: number;
let senderAddressId: number;
let n = 0;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await setSetting("mailgun.domain", "send.example.com");
  await setSecret("mailgun.webhookSigningKey", KEY, null);
  const domain = await dbWrite((c) => c.sendingDomain.create({ data: { name: "send.example.com", region: "EU" } }));
  const sa = await dbWrite((c) =>
    c.senderAddress.create({ data: { userId: ownerId, domainId: domain.id, localPart: "arslan", address: "arslan@send.example.com", routeStatus: "ok" } }),
  );
  senderAddressId = sa.id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** The notify form Mailgun posts (research §13.2); the storage URL points at a dead loopback port (never fetched). */
function replyFields(opts: { from?: string; key?: string; inReplyTo?: string } = {}): Record<string, string> {
  n += 1;
  const key = opts.key ?? `STOREKEY${n}${Date.now()}`;
  const headers: Array<[string, string]> = [
    ["From", opts.from ?? "Anna Berg <Anna@Firma.DE>"],
    ["To", "arslan@send.example.com"],
    ["Subject", "Re: Hello"],
    ["Message-Id", `<reply${n}.${Date.now()}@firma.de>`],
  ];
  if (opts.inReplyTo) headers.push(["In-Reply-To", `<${opts.inReplyTo}>`], ["References", `<${opts.inReplyTo}>`]);
  return {
    domain: "send.example.com",
    recipient: "arslan@send.example.com",
    sender: "anna@firma.de",
    from: opts.from ?? "Anna Berg <Anna@Firma.DE>",
    subject: "Re: Hello",
    "body-plain": "Thanks, sounds good!\n\n> old text",
    "stripped-text": "Thanks, sounds good!",
    "message-headers": JSON.stringify(headers),
    "message-url": `http://127.0.0.1:9/v3/domains/send.example.com/messages/${key}`,
    attachments: "[]",
  };
}

describe("POST /api/webhooks/mailgun/inbound", () => {
  it("stores an urlencoded reply unprocessed, normalised, linked to our sending address, with its texts, and stops nobody", async () => {
    const s = await seedEmail({ createdById: ownerId, email: "anna@firma.de" });
    const fields = replyFields({ inReplyTo: s.messageId });
    const res = await POST(signedInboundRequest(URL, fields, { key: KEY }));
    expect(res.status).toBe(200);
    const row = await db.inboundMessage.findFirstOrThrow({ where: { storageKey: fields["message-url"]!.split("/").pop()! } });
    expect(row).toMatchObject({
      source: "NOTIFY",
      toAddress: "arslan@send.example.com",
      senderAddressId,
      fromEmail: "anna@firma.de",
      fromName: "Anna Berg",
      subject: "Re: Hello",
      snippet: "Thanks, sounds good!",
      inReplyTo: s.messageId,
      references: s.messageId,
      // M4 (M4-DESIGN §3.2): what the classifier needs, newlines kept.
      envelopeSender: "anna@firma.de",
      strippedText: "Thanks, sounds good!",
      bodyText: "Thanks, sounds good!\n\n> old text",
      bodyAvailable: true,
      processedAt: null,
      kind: null,
      autoReason: null,
      signals: null,
      linkMethod: null,
      replyScope: null,
      assigneeId: null,
      personId: null,
      companyId: null,
      campaignId: null,
    });
    // The route stays store-only (M4-DESIGN §12.2 D1): the worker's event lane classifies and stops within seconds,
    // and until then the sending guard holds this address and company.
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).state).toBe("WAITING");
    expect(await db.suppression.findUnique({ where: { emailNorm: "anna@firma.de" } })).toBeNull();
    expect(await db.notification.count()).toBe(0);
  });

  it("stores an automatic reply's null sender and a failed parse (no stripped-text) as they came", async () => {
    const fields = replyFields({ from: "ooo@firma.de" });
    fields.sender = "";
    delete fields["stripped-text"];
    fields["body-plain"] = "I am out of the office.\r\nBack on Monday.";
    const res = await POST(signedInboundRequest(URL, fields, { key: KEY }));
    expect(res.status).toBe(200);
    expect(await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "ooo@firma.de" } })).toMatchObject({
      envelopeSender: "",
      strippedText: null,
      bodyText: "I am out of the office.\nBack on Monday.",
      bodyAvailable: true,
      processedAt: null,
    });
  });

  it("stores a multipart reply too", async () => {
    const fields = replyFields({ from: "bo@example.org" });
    const res = await POST(signedInboundRequest(URL, fields, { key: KEY, multipart: true }));
    expect(res.status).toBe(200);
    expect(await db.inboundMessage.count({ where: { fromEmail: "bo@example.org" } })).toBe(1);
  });

  it("stores the same reply once (same storage key, new token)", async () => {
    const fields = replyFields({ from: "twice@example.org" });
    expect((await POST(signedInboundRequest(URL, fields, { key: KEY }))).status).toBe(200);
    expect((await POST(signedInboundRequest(URL, fields, { key: KEY }))).status).toBe(200);
    expect(await db.inboundMessage.count({ where: { fromEmail: "twice@example.org" } })).toBe(1);
  });

  it("keeps replies for 24 hours (the freshness window), not longer", async () => {
    const day = Math.floor(Date.now() / 1000);
    const ok = replyFields({ from: "late@example.org" });
    expect((await POST(signedInboundRequest(URL, ok, { key: KEY, timestamp: String(day - 23 * 3600) }))).status).toBe(200);
    const stale = replyFields({ from: "stale@example.org" });
    expect((await POST(signedInboundRequest(URL, stale, { key: KEY, timestamp: String(day - 25 * 3600) }))).status).toBe(406);
    expect(await db.inboundMessage.count({ where: { fromEmail: "stale@example.org" } })).toBe(0);
  });

  it("refuses a wrong signature (401), a replayed token (200, nothing new), a wrong content type and missing fields (406)", async () => {
    const tampered = replyFields({ from: "tamper@example.org" });
    expect((await POST(signedInboundRequest(URL, tampered, { key: KEY, tamper: true }))).status).toBe(401);
    const token = randomToken();
    expect((await POST(signedInboundRequest(URL, replyFields({ from: "first@example.org" }), { key: KEY, token }))).status).toBe(200);
    expect((await POST(signedInboundRequest(URL, replyFields({ from: "forged@example.org" }), { key: KEY, token }))).status).toBe(200);
    expect(await db.inboundMessage.count({ where: { fromEmail: "forged@example.org" } })).toBe(0);
    expect(
      (await POST(new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status,
    ).toBe(406);
    expect((await POST(new Request(URL, { method: "POST", body: new URLSearchParams({ recipient: "x@y.z" }) }))).status).toBe(406);
  });

  it("refuses a body over 10 MB (406)", async () => {
    let sent = 0;
    const total = 12 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        sent += 256 * 1024;
        controller.enqueue(new Uint8Array(256 * 1024).fill(0x61));
      },
    });
    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=----x" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(406);
    expect(await res.json()).toEqual({ error: "too-large" });
    expect(sent).toBeLessThan(total);
  });
});
