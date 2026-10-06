import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { eventData, makeOwner, seedEmail, setSetting } from "./seed";

// markSent stays real, but a test can make it fail (the lane's give-up after 5 tries).
const markSentControl = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/services/sending/mark-sent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/sending/mark-sent")>();
  return {
    ...real,
    markSent: async (...args: Parameters<typeof real.markSent>) => {
      if (markSentControl.fail) throw new Error("markSent broke on purpose");
      return real.markSent(...args);
    },
  };
});

const t = await createTestDb("mail-lane");
const { db } = await import("@/server/db");
const { normalizeWebhookEventData } = await import("@/core/mailgun/events");
const { applyMailEventNow } = await import("@/server/services/mail-events/apply");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { EventLane } = await import("../../../worker/event-lane");

let ownerId: number;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await setSetting("mailgun.domain", "send.example.com");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function store(data: Record<string, unknown>, source: "WEBHOOK" | "LOGS" | "SIMULATED" = "WEBHOOK") {
  return applyMailEventNow(normalizeWebhookEventData(data)!, source);
}

describe("the event lane", () => {
  it("writes one activity per event, with the email's mode and ids", async () => {
    const d = await seedEmail({ createdById: ownerId });
    const b = await seedEmail({ createdById: ownerId });
    const c = await seedEmail({ createdById: ownerId });
    const u = await seedEmail({ createdById: ownerId });
    const tf = await seedEmail({ createdById: ownerId });
    await store(eventData(d, "delivered"));
    await store(eventData(b, "bounce"));
    await store(eventData(c, "complain"));
    await store(eventData(u, "unsubscribe"));
    await store(eventData(tf, "tempfail"));
    const r = await processPendingMailEvents();
    expect(r.processed).toBe(5);
    const acts = await db.activityLog.findMany({
      where: { campaignId: { in: [d, b, c, u, tf].map((x) => x.campaignId) }, type: { startsWith: "email." } },
      orderBy: { id: "asc" },
    });
    expect(acts.map((a) => [a.type, a.summary])).toEqual([
      ["email.delivered", `Delivered to ${d.toNorm}`],
      ["email.bounced", `Bounced: ${b.toNorm} (5.5.0 Requested action not taken: mailbox unavailable)`],
      ["email.complained", `${c.toNorm} marked the email as spam`],
      ["email.unsubscribed", `${u.toNorm} unsubscribed`],
    ]);
    expect(acts[0]).toMatchObject({ mode: "LIVE", companyId: d.companyId, personId: d.personId, actorId: null });
    expect(await db.mailEvent.count({ where: { processedAt: null } })).toBe(0);
  });

  it("tells the Owner about a real complaint (not about a test-mode one)", async () => {
    const c = await seedEmail({ createdById: ownerId });
    await store(eventData(c, "complain"));
    const test = await seedEmail({ createdById: ownerId, mode: "TEST" });
    await store(eventData(test, "complain"));
    await processPendingMailEvents();
    const notes = await db.notification.findMany({ where: { type: "email.complained" } });
    const mine = notes.filter((n) => n.title.includes(c.toNorm));
    expect(mine).toHaveLength(1);
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: c.campaignId } });
    expect(mine[0]).toMatchObject({
      userId: ownerId,
      title: `${c.toNorm} marked an email as spam`,
      body: `${campaign.name} · First email. They won't be emailed again.`,
      link: `/contacts?company=${c.companyId}`,
    });
    expect(notes.some((n) => n.title.includes(test.toNorm))).toBe(false);
  });

  it("calls onProblems with the real bounces and complaints of our emails", async () => {
    const b = await seedEmail({ createdById: ownerId });
    const c = await seedEmail({ createdById: ownerId });
    const dry = await seedEmail({ createdById: ownerId, mode: "DRY_RUN" });
    await store(eventData(b, "bounce"));
    await store(eventData(c, "complain"));
    await store(eventData(dry, "bounce"));
    const onProblems = vi.fn(async () => undefined);
    const lane = new EventLane({ ownsLease: async () => true, logger: quiet, onProblems });
    const r = await lane.tick();
    expect(r?.problems).toEqual({ bounces: 1, complaints: 1 });
    expect(onProblems).toHaveBeenCalledWith({ bounces: 1, complaints: 1 });
    expect(await lane.tick()).toMatchObject({ processed: 0 });
    expect(onProblems).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the lease", async () => {
    const d = await seedEmail({ createdById: ownerId });
    await store(eventData(d, "delivered"));
    const lane = new EventLane({ ownsLease: async () => false, logger: quiet });
    expect(await lane.tick()).toBeNull();
    expect(await db.mailEvent.count({ where: { processedAt: null } })).toBe(1);
    await processPendingMailEvents();
  });

  it("processes each event once when two runs race (compare-and-set on processedAt)", async () => {
    const d = await seedEmail({ createdById: ownerId });
    await store(eventData(d, "delivered"));
    await Promise.all([processPendingMailEvents(), processPendingMailEvents()]);
    expect(await db.activityLog.count({ where: { type: "email.delivered", campaignId: d.campaignId } })).toBe(1);
  });

  it("gives an event up after 5 failures, sets it processed and sends the notice once", async () => {
    const s = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: null });
    markSentControl.fail = true;
    try {
      const r = await store(eventData(s, "delivered")); // its own proof step fails too (logged, not thrown)
      const lane = new EventLane({ ownsLease: async () => true, logger: quiet });
      for (let i = 0; i < 4; i++) {
        await lane.tick();
        expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } })).processedAt).toBeNull();
      }
      await lane.tick();
      expect((await db.mailEvent.findUniqueOrThrow({ where: { id: r.eventId } })).processedAt).toBeInstanceOf(Date);
      expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("UNKNOWN");
    } finally {
      markSentControl.fail = false;
    }
    const notes = await db.notification.findMany({ where: { title: "A Mailgun report couldn't be processed" } });
    expect(notes).toHaveLength(1);
    // PLAN A6: "Background sender", never "worker".
    expect(notes[0]!.body).toBe(
      "The app skipped one report from Mailgun after 5 tries. Nothing was sent because of it; details are in the background sender's log.",
    );
    expect(notes[0]!.body).not.toMatch(/worker/i);
    expect(await db.activityLog.count({ where: { type: "email.delivered", campaignId: s.campaignId } })).toBe(0);
  });

  it("names who simulated an event", async () => {
    const s = await seedEmail({ createdById: ownerId, mode: "DRY_RUN" });
    const data = { ...eventData(s, "bounce"), id: `sim-${s.emailId}` };
    const e = normalizeWebhookEventData(data)!;
    e.raw = { simulated: true, byUserId: ownerId, byName: "Arslan" };
    await applyMailEventNow(e, "SIMULATED");
    await processPendingMailEvents();
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "email.bounced", campaignId: s.campaignId } });
    expect(act.actorId).toBe(ownerId);
    expect(act.summary).toMatch(/\(simulated by Arslan\)$/);
  });
});
