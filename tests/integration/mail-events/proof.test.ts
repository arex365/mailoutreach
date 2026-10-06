import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { signedEventRequest } from "../../fake-mailgun/webhooks";
import { eventData, makeOwner, seedEmail, setSetting } from "./seed";

const t = await createTestDb("mail-proof");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { setSecret } = await import("@/server/secrets");
const { normalizeWebhookEventData } = await import("@/core/mailgun/events");
const { applyMailEvent, ensureSentFromEvent } = await import("@/server/services/mail-events/apply");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { POST } = await import("@/app/api/webhooks/mailgun/events/route");

const URL = "http://127.0.0.1:3000/api/webhooks/mailgun/events";
const KEY = "key-fake-signing";
let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await setSetting("mailgun.domain", "send.example.com");
  await setSecret("mailgun.webhookSigningKey", KEY, null);
  await dbWrite((c) => c.sendingDomain.create({ data: { name: "send.example.com", region: "EU" } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function post(data: Record<string, unknown>) {
  const res = await POST(signedEventRequest(URL, data, { key: KEY }));
  expect(res.status).toBe(200);
}

describe("proof of sending (§4.4.2)", () => {
  it.each(["UNKNOWN", "UNCONFIRMED", "QUEUED"] as const)("a delivered webhook turns a %s LIVE row SENT with the event's time", async (status) => {
    const s = await seedEmail({ createdById: ownerId, status, followUp: false, providerId: null });
    const at = new Date(Date.now() - 20 * 60_000);
    await post(eventData(s, "delivered", { at }));
    const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } });
    expect(row).toMatchObject({ status: "SENT", providerId: s.messageId, lastError: null });
    expect(row.sentAt?.getTime()).toBe(at.getTime());
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).state).not.toBe("SCHEDULED");
  });

  it("a failed webhook proves it too", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: null });
    await post(eventData(s, "bounce"));
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("SENT");
  });

  it("a duplicate event still repairs a row whose markSent never ran", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: null });
    const data = eventData(s, "delivered");
    // The event was stored, then the process stopped before the proof step.
    await dbTx((tx) => applyMailEvent(tx, normalizeWebhookEventData(data)!, "WEBHOOK", { now: new Date(), practiceCopy: false }));
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("UNKNOWN");
    await post(data); // Mailgun's retry: same event, new token
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(1);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("SENT");
  });

  it("an accepted event stays unprocessed until the lane ran the proof step", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: null });
    const accepted = normalizeWebhookEventData({ ...eventData(s, "delivered"), event: "accepted", id: `acc-${s.emailId}` })!;
    const r = await dbTx((tx) => applyMailEvent(tx, accepted, "LOGS", { now: new Date(), practiceCopy: false }));
    expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } })).processedAt).toBeNull();
    await processPendingMailEvents();
    expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } })).processedAt).toBeInstanceOf(Date);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("SENT");
  });

  it("keeps a saved providerId and never touches dry-run rows", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: "mailgun.own.1@send.example.com" });
    const res = await ensureSentFromEvent({ outboundEmailId: s.emailId }, { type: "delivered", occurredAt: new Date(), messageId: s.messageId });
    expect(res).toBe("sent");
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).providerId).toBe("mailgun.own.1@send.example.com");

    const dry = await seedEmail({ createdById: ownerId, mode: "DRY_RUN", status: "QUEUED", followUp: false });
    expect(await ensureSentFromEvent({ outboundEmailId: dry.emailId }, { type: "delivered", occurredAt: new Date(), messageId: dry.messageId })).toBe(
      "not-proof",
    );
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: dry.emailId } })).status).toBe("QUEUED");
    expect(await ensureSentFromEvent({ outboundEmailId: s.emailId }, { type: "other", occurredAt: new Date(), messageId: null })).toBe("not-proof");
  });

  it("turns an UNKNOWN test email SENT", async () => {
    const test = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: ownerId, to: "me@gmail.com", subject: "T", mode: "LIVE", messageId: "pp.t.proof1@send.example.com", status: "UNKNOWN" },
      }),
    );
    await post(eventData({ messageId: test.messageId!, toNorm: "me@gmail.com", sendId: "n/a", campaignId: 0 }, "delivered"));
    expect(await db.testSend.findUniqueOrThrow({ where: { id: test.id } })).toMatchObject({ status: "SENT", providerId: test.messageId });
  });
});
