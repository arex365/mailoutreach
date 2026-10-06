import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { eventData, makeOwner, personFor, seedEmail, setSetting, type SeededEmail } from "./seed";

const t = await createTestDb("mail-apply");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { normalizeWebhookEventData, normalizeLogItem } = await import("@/core/mailgun/events");
const { applyMailEvent, applyMailEventNow } = await import("@/server/services/mail-events/apply");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { loadHealthCounts } = await import("@/server/services/sending/usage");
type NormalizedEvent = import("@/core/mailgun/events").NormalizedEvent;
type EventSource = import("@/generated/prisma/client").EventSource;

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await setSetting("mailgun.domain", "send.example.com");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

function ev(data: Record<string, unknown>): NormalizedEvent {
  const e = normalizeWebhookEventData(data);
  if (!e) throw new Error("unreadable test event");
  return e;
}

async function apply(e: NormalizedEvent, opts: { practiceCopy?: boolean; source?: EventSource; now?: Date } = {}) {
  return dbTx((tx) => applyMailEvent(tx, e, opts.source ?? "WEBHOOK", { now: opts.now ?? new Date(), practiceCopy: opts.practiceCopy ?? false }));
}

async function state(s: SeededEmail) {
  const email = await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } });
  const recipient = await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } });
  const followUp = s.followUpId ? await db.outboundEmail.findUniqueOrThrow({ where: { id: s.followUpId } }) : null;
  const suppression = await db.suppression.findUnique({ where: { emailNorm: s.toNorm } });
  const person = await db.person.findUniqueOrThrow({ where: { id: s.personId } });
  return { email, recipient, followUp, suppression, person };
}

describe("applyMailEvent: every eventEffect row (LIVE email, real scope)", () => {
  it("delivered sets deliveredAt and nothing else", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const at = new Date("2026-09-20T10:00:00Z");
    const r = await apply(ev(eventData(s, "delivered", { at })));
    expect(r).toMatchObject({ status: "created", outboundEmailId: s.emailId, scope: "real", stopped: 0, suppression: null });
    const st = await state(s);
    expect(st.email.deliveredAt?.toISOString()).toBe(at.toISOString());
    expect(st.recipient.state).toBe("WAITING");
    expect(st.suppression).toBeNull();
    const row = await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } });
    expect(row).toMatchObject({ type: "delivered", processedAt: null, stopAppliedAt: expect.any(Date), outboundEmailId: s.emailId });
  });

  it("a temporary failure sets tempFailedAt only", async () => {
    const s = await seedEmail({ createdById: ownerId });
    await apply(ev(eventData(s, "tempfail")));
    const st = await state(s);
    expect(st.email.tempFailedAt).toBeInstanceOf(Date);
    expect(st.email.bouncedAt).toBeNull();
    expect(st.recipient.state).toBe("WAITING");
    expect(st.suppression).toBeNull();
  });

  it("a hard bounce stops every campaign, suppresses the address, flags the person and skips waiting emails", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const other = await seedEmail({ createdById: ownerId, email: s.toNorm, status: "QUEUED", followUp: false });
    const r = await apply(ev(eventData(s, "bounce")));
    expect(r).toMatchObject({ scope: "real", stopped: 2, suppression: "created" });
    const st = await state(s);
    expect(st.email.bouncedAt).toBeInstanceOf(Date);
    expect(st.recipient).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(st.followUp).toMatchObject({ status: "SKIPPED", lastError: "Stopped: this address bounced" });
    expect(st.suppression).toMatchObject({ reason: "BOUNCED", source: "webhook", pushedToMailgunAt: expect.any(Date) });
    expect(st.suppression?.detail).toMatch(/mailbox unavailable/);
    expect(st.person.bouncedAt).toBeInstanceOf(Date);
    const o = await state(other);
    expect(o.recipient).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(o.email).toMatchObject({ status: "SKIPPED", lastError: "Stopped: this address bounced" });
  });

  it("an espblock failure stops only that recipient, counts for health and creates no suppression", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const other = await seedEmail({ createdById: ownerId, email: s.toNorm, status: "QUEUED", followUp: false });
    const r = await apply(ev(eventData(s, "bounce", { reason: "espblock" })));
    expect(r).toMatchObject({ scope: "real", stopped: 1, suppression: null });
    const st = await state(s);
    expect(st.email.bouncedAt).toBeInstanceOf(Date);
    expect(st.recipient).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(st.suppression).toBeNull();
    expect(st.person.bouncedAt).toBeNull();
    expect((await state(other)).recipient.state).toBe("SCHEDULED");
    const counts = await loadHealthCounts({ since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
    expect(counts.bounceEmailIds).toContain(s.emailId);
  });

  it.each([
    ["suppress-bounce", "BOUNCED", "bounced", "bouncedAt"],
    ["suppress-unsubscribe", "UNSUBSCRIBED", "unsubscribed", "unsubscribedAt"],
    ["suppress-complaint", "COMPLAINED", "complained", "complainedAt"],
  ] as const)("%s: Mailgun dropped it; stop and suppression, never health", async (reason, suppression, stop, personField) => {
    const s = await seedEmail({ createdById: ownerId });
    await apply(ev(eventData(s, "bounce", { reason })));
    const st = await state(s);
    expect(st.email.bouncedAt).toBeInstanceOf(Date);
    expect(st.recipient).toMatchObject({ state: "STOPPED", stopReason: stop });
    expect(st.suppression?.reason).toBe(suppression);
    expect(st.person[personField]).toBeInstanceOf(Date);
    const counts = await loadHealthCounts({ since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
    expect(counts.bounceEmailIds).not.toContain(s.emailId);
    expect(counts.complaintEmailIds).not.toContain(s.emailId);
  });

  it("a complaint and an unsubscribe stop every campaign and suppress", async () => {
    const a = await seedEmail({ createdById: ownerId });
    await apply(ev(eventData(a, "complain")));
    expect(await state(a)).toMatchObject({
      recipient: { state: "STOPPED", stopReason: "complained" },
      suppression: { reason: "COMPLAINED" },
      email: { complainedAt: expect.any(Date) },
    });
    const b = await seedEmail({ createdById: ownerId });
    await apply(ev(eventData(b, "unsubscribe")));
    expect(await state(b)).toMatchObject({
      recipient: { state: "STOPPED", stopReason: "unsubscribed" },
      suppression: { reason: "UNSUBSCRIBED" },
      email: { unsubscribedAt: expect.any(Date) },
      person: { unsubscribedAt: expect.any(Date) },
    });
  });

  it("accepted changes nothing and stays unprocessed; other events are stored processed", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const data = eventData(s, "delivered");
    const accepted = ev({ ...data, event: "accepted", id: `acc-${s.emailId}` });
    const r = await apply(accepted);
    expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } })).processedAt).toBeNull();
    expect((await state(s)).email.deliveredAt).toBeNull();
    const opened = ev({ ...data, event: "opened", id: `open-${s.emailId}` });
    const r2 = await apply(opened);
    expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r2.eventId } })).processedAt).toBeInstanceOf(Date);
  });

  it("a duplicate (same dedupe key) writes nothing but still returns the matched ids", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const e = ev(eventData(s, "delivered"));
    const first = await apply(e);
    const again = await apply(e);
    expect(again).toMatchObject({ status: "duplicate", eventId: first.eventId, outboundEmailId: s.emailId, stopped: 0 });
    expect(await db.mailEvent.count({ where: { dedupeKey: e.dedupeKey } })).toBe(1);
  });
});

describe("scopes", () => {
  it("TEST mode emails only change their own campaign", async () => {
    const s = await seedEmail({ createdById: ownerId, mode: "TEST" });
    const other = await seedEmail({ createdById: ownerId, email: s.toNorm, status: "QUEUED", followUp: false });
    const r = await apply(ev(eventData(s, "bounce")));
    expect(r.scope).toBe("campaign");
    const st = await state(s);
    expect(st.recipient.state).toBe("STOPPED");
    expect(st.suppression).toBeNull();
    expect(st.person.bouncedAt).toBeNull();
    expect((await state(other)).recipient.state).toBe("SCHEDULED");
  });

  it("an event in Mailgun's test mode is campaign scope even for a LIVE row", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const r = await apply(ev(eventData(s, "unsubscribe", { testMode: true })));
    expect(r.scope).toBe("campaign");
    expect((await state(s)).suppression).toBeNull();
  });

  it("a dry run changes only its campaign on real data, the person too in the practice copy", async () => {
    const real = await seedEmail({ createdById: ownerId, mode: "DRY_RUN" });
    expect((await apply(ev(eventData(real, "bounce")))).scope).toBe("campaign");
    expect((await state(real)).suppression).toBeNull();

    const practice = await seedEmail({ createdById: ownerId, mode: "DRY_RUN" });
    const r = await apply(ev(eventData(practice, "bounce")), { practiceCopy: true });
    expect(r.scope).toBe("real");
    const st = await state(practice);
    expect(st.suppression).toMatchObject({ reason: "BOUNCED", pushedToMailgunAt: null });
    expect(st.person.bouncedAt).toBeInstanceOf(Date);
  });

  it("a SELF test never suppresses your inbox; a reply test does; unmatched events are real", async () => {
    const self = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: ownerId, to: "me@gmail.com", subject: "Test", mode: "LIVE", purpose: "SELF", messageId: "pp.t.self1@send.example.com", status: "SENT" },
      }),
    );
    const selfEvent = ev(eventData({ messageId: self.messageId!, toNorm: "me@gmail.com", sendId: "x", campaignId: 0 }, "unsubscribe"));
    const r1 = await apply(selfEvent);
    expect(r1).toMatchObject({ scope: "none", testSendId: self.id, outboundEmailId: null });
    expect(await db.suppression.findUnique({ where: { emailNorm: "me@gmail.com" } })).toBeNull();

    const reply = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: ownerId, to: "box@outlook.com", subject: "Reply test", mode: "LIVE", purpose: "REPLY_TEST", messageId: "pp.t.1.abc@send.example.com" },
      }),
    );
    const r2 = await apply(ev(eventData({ messageId: reply.messageId!, toNorm: "box@outlook.com", sendId: "y", campaignId: 0 }, "unsubscribe")));
    expect(r2).toMatchObject({ scope: "real", testSendId: reply.id });
    expect(await db.suppression.findUnique({ where: { emailNorm: "box@outlook.com" } })).toMatchObject({ reason: "UNSUBSCRIBED" });

    const r3 = await apply(ev(eventData({ messageId: "unknown.1@elsewhere.test", toNorm: "stranger@x.de", sendId: "zz", campaignId: 0 }, "complain")));
    expect(r3).toMatchObject({ scope: "real", outboundEmailId: null, testSendId: null, suppression: "created" });
  });
});

describe("matching", () => {
  it("matches Mailgun's own id saved as providerId, a test email's provider id, and send_id", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: "20260923.mailgun1@send.example.com" });
    const r1 = await apply(ev(eventData({ ...s, messageId: "20260923.mailgun1@send.example.com" }, "delivered")));
    expect(r1.outboundEmailId).toBe(s.emailId);

    const test = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: ownerId, to: "me2@gmail.com", subject: "T", mode: "LIVE", messageId: "pp.t.self2@send.example.com", providerId: "rewritten.2@send.example.com" },
      }),
    );
    const r2 = await apply(ev(eventData({ messageId: "rewritten.2@send.example.com", toNorm: "me2@gmail.com", sendId: "q", campaignId: 0 }, "delivered")));
    expect(r2.testSendId).toBe(test.id);

    const s3 = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false });
    const r3 = await apply(ev(eventData({ ...s3, messageId: "totally.different@send.example.com" }, "delivered")));
    expect(r3.outboundEmailId).toBe(s3.emailId);
  });

  it("an event whose recipient reads [REDACTED] stops the matched row's own address", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const data = { ...eventData(s, "unsubscribe"), recipient: "[REDACTED]" };
    const r = await apply(ev(data));
    expect(r.stopped).toBeGreaterThan(0);
    const st = await state(s);
    expect(st.recipient).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect(st.suppression?.reason).toBe("UNSUBSCRIBED");
    expect(await db.suppression.findUnique({ where: { emailNorm: "[redacted]" } })).toBeNull();
  });

  it("pushedToMailgunAt is set only when Mailgun lists the address on the active domain", async () => {
    const s = await seedEmail({ createdById: ownerId });
    await apply(ev(eventData(s, "bounce", { domain: "old.example.com" })));
    expect((await state(s)).suppression).toMatchObject({ reason: "BOUNCED", pushedToMailgunAt: null });
    const sim = await seedEmail({ createdById: ownerId, mode: "DRY_RUN" });
    await apply(ev(eventData(sim, "unsubscribe")), { practiceCopy: true, source: "SIMULATED" });
    expect((await state(sim)).suppression).toMatchObject({ source: "simulated", pushedToMailgunAt: null });
  });
});

describe("the instant stop is part of the event's transaction", () => {
  it("rolls back with it", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const e = ev(eventData(s, "complain"));
    await expect(
      dbTx(async (tx) => {
        await applyMailEvent(tx, e, "WEBHOOK", { now: new Date(), practiceCopy: false });
        throw new Error("boom after the event");
      }),
    ).rejects.toThrow("boom");
    const st = await state(s);
    expect(st.recipient.state).toBe("WAITING");
    expect(st.followUp?.status).toBe("QUEUED");
    expect(st.suppression).toBeNull();
    expect(await db.mailEvent.count({ where: { dedupeKey: e.dedupeKey } })).toBe(0);
  });

  it("applyMailEventNow commits the stop together with the event", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const r = await applyMailEventNow(ev(eventData(s, "unsubscribe")), "WEBHOOK");
    expect(r.status).toBe("created");
    expect((await state(s)).followUp).toMatchObject({ status: "SKIPPED", lastError: "Stopped: this address unsubscribed" });
  });
});

describe("order doesn't matter", () => {
  it("events applied in reverse order give the same rows", async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 20, 10, m));
    const events = (s: SeededEmail) => [
      ev(eventData(s, "delivered", { at: at(1) })),
      ev(eventData(s, "bounce", { reason: "suppress-bounce", at: at(2) })),
      ev(eventData(s, "unsubscribe", { at: at(3) })),
      ev(eventData(s, "complain", { at: at(4) })),
      ev(eventData(s, "delivered", { at: at(0) })),
    ];
    const forward = await seedEmail({ createdById: ownerId });
    const backward = await seedEmail({ createdById: ownerId });
    for (const e of events(forward)) await apply(e);
    for (const e of events(backward).reverse()) await apply(e);
    const shape = async (s: SeededEmail) => {
      const st = await state(s);
      return {
        dates: [st.email.deliveredAt, st.email.bouncedAt, st.email.unsubscribedAt, st.email.complainedAt].map((d) => d?.toISOString() ?? null),
        recipient: [st.recipient.state, st.recipient.stopReason],
        followUp: [st.followUp?.status, st.followUp?.lastError],
        suppression: [st.suppression?.reason, st.suppression?.source, st.suppression?.detail ?? null, Boolean(st.suppression?.pushedToMailgunAt)],
        person: [st.person.bouncedAt, st.person.unsubscribedAt, st.person.complainedAt].map((d) => d?.toISOString() ?? null),
      };
    };
    const a = await shape(forward);
    expect(a).toEqual(await shape(backward));
    expect(a.dates).toEqual([at(0).toISOString(), at(2).toISOString(), at(3).toISOString(), at(4).toISOString()]);
    expect(a.recipient).toEqual(["STOPPED", "complained"]);
    expect(a.followUp).toEqual(["SKIPPED", "Stopped: this address marked an email as spam"]);
    expect(a.suppression[0]).toBe("COMPLAINED");
  });

  it("a webhook event and its Logs twin make one activity", async () => {
    const s = await seedEmail({ createdById: ownerId });
    const data = eventData(s, "delivered");
    await applyMailEventNow(ev(data), "WEBHOOK");
    // The same event read from the Logs, under another id (Mailgun's ids are only "unique within a day").
    const logItem = {
      ...data,
      id: `${String(data.id)}-log`,
      "@timestamp": new Date(Number(data.timestamp) * 1000).toISOString(),
      "user-variables": JSON.stringify(data["user-variables"]),
    };
    const twin = normalizeLogItem(logItem)!;
    await applyMailEventNow(twin, "LOGS");
    await processPendingMailEvents();
    const acts = await db.activityLog.findMany({ where: { type: "email.delivered", campaignId: s.campaignId } });
    expect(acts).toHaveLength(1);
    expect(acts[0]!.summary).toBe(`Delivered to ${s.toNorm}`);
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId, processedAt: null } })).toBe(0);
  });
});

describe("unmatched events with a person", () => {
  it("log on the person found by address", async () => {
    const { personId, companyId } = await personFor("lonely@studio.de");
    await applyMailEventNow(ev(eventData({ messageId: "gone.1@send.example.com", toNorm: "lonely@studio.de", sendId: "none", campaignId: 0 }, "unsubscribe")), "LOGS");
    await processPendingMailEvents();
    const act = await db.activityLog.findFirst({ where: { type: "email.unsubscribed", personId } });
    expect(act).toMatchObject({ companyId, summary: "lonely@studio.de unsubscribed" });
  });
});
