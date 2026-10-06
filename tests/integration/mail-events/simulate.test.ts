import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeOwner, seedEmail, setSetting } from "./seed";

const t = await createTestDb("mail-simulate");
const { db } = await import("@/server/db");
const { simulateEmailEvent, loadSimulation, ALREADY_SIMULATED } = await import("@/server/services/mail-events/simulate");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { ServiceError } = await import("@/server/services/companies/mutations");

let actor: { id: number; name: string };

beforeAll(async () => {
  const o = await makeOwner();
  actor = { id: o.id, name: o.name };
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("simulateEmailEvent (the dry-run outbox's test tools)", () => {
  it("on real data changes only that campaign", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    const elsewhere = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", email: s.toNorm, status: "QUEUED", followUp: false });
    const res = await simulateEmailEvent(actor, s.emailId, "bounce");
    expect(res.message).toBe(`Simulated a bounce for ${s.toNorm}. In a dry run this only changes this campaign.`);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).toMatchObject({ bouncedAt: expect.any(Date) });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.followUpId! } })).toMatchObject({ status: "SKIPPED" });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: elsewhere.recipientId } })).state).toBe("SCHEDULED");
    expect(await db.suppression.findUnique({ where: { emailNorm: s.toNorm } })).toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: s.personId } })).bouncedAt).toBeNull();

    expect(await simulateEmailEvent(actor, s.emailId, "bounce")).toEqual({ message: ALREADY_SIMULATED });
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(1);

    await simulateEmailEvent(actor, s.emailId, "delivered");
    const view = await loadSimulation(s.emailId);
    expect(view).toMatchObject({ practiceCopy: false, done: ["delivered", "bounce"], resultLine: "Delivered · Bounced (simulated)" });

    await processPendingMailEvents();
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "email.bounced", campaignId: s.campaignId } });
    expect(act).toMatchObject({ actorId: actor.id, mode: "DRY_RUN" });
    expect(act.summary).toMatch(/\(simulated by Arslan\)$/);
  });

  it("in the practice copy changes the person too, like a real event", async () => {
    await setSetting("practice.copy", true);
    try {
      const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
      const res = await simulateEmailEvent(actor, s.emailId, "bounce");
      expect(res.message).toBe(`Simulated a bounce: ${s.toNorm} is now marked Bounced and won't be emailed again.`);
      expect(await db.suppression.findUnique({ where: { emailNorm: s.toNorm } })).toMatchObject({
        reason: "BOUNCED",
        source: "simulated",
        pushedToMailgunAt: null,
      });
      expect((await db.person.findUniqueOrThrow({ where: { id: s.personId } })).bouncedAt).toBeInstanceOf(Date);
      const u = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
      expect((await simulateEmailEvent(actor, u.emailId, "unsubscribe")).message).toBe(
        `Simulated an unsubscribe: ${u.toNorm} is now marked Unsubscribed and won't be emailed again.`,
      );
      expect((await loadSimulation(u.emailId))?.practiceCopy).toBe(true);
    } finally {
      await setSetting("practice.copy", false);
    }
  });

  it("refuses real (TEST/LIVE) emails and dry-run emails that haven't gone out", async () => {
    const live = await seedEmail({ createdById: actor.id, mode: "LIVE" });
    await expect(simulateEmailEvent(actor, live.emailId, "bounce")).rejects.toThrow(
      "Only dry-run emails can be simulated. Real emails get their results from Mailgun.",
    );
    const queued = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", status: "QUEUED", followUp: false });
    await expect(simulateEmailEvent(actor, queued.emailId, "delivered")).rejects.toBeInstanceOf(ServiceError);
    await expect(simulateEmailEvent(actor, 999_999, "delivered")).rejects.toBeInstanceOf(ServiceError);
    expect(await db.mailEvent.count({ where: { outboundEmailId: { in: [live.emailId, queued.emailId] } } })).toBe(0);
    expect(await loadSimulation(live.emailId)).toBeNull();
  });
});
