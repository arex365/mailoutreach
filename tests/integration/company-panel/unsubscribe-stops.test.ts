import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeOwner, seedEmail, setSetting } from "../mail-events/seed";

// M3-DESIGN §4.4.6: "Mark unsubscribed" in the company panel stops the person's waiting emails at once (in the same
// transaction) and queues the push to Mailgun's unsubscribes list, except in the practice copy.
const t = await createTestDb("company-panel-unsub");
const { db, dbWrite } = await import("@/server/db");
const people = await import("@/server/services/people");

let owner: { id: number; name: string };

beforeAll(async () => {
  const o = await makeOwner();
  owner = { id: o.id, name: o.name };
});

beforeEach(async () => {
  await dbWrite((c) => c.job.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("markPersonUnsubscribed", () => {
  it("stops every open recipient with the address and skips their QUEUED emails at once", async () => {
    const first = await seedEmail({ createdById: owner.id, email: "finn@unsub.no", status: "QUEUED", followUp: false });
    const second = await seedEmail({ createdById: owner.id, email: "finn@unsub.no" });
    const res = await people.markPersonUnsubscribed(owner, first.personId);
    expect(res).toEqual({ changed: true, email: "finn@unsub.no" });
    for (const s of [first, second]) {
      expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({
        state: "STOPPED",
        stopReason: "unsubscribed",
      });
    }
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: first.emailId } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Stopped: this address unsubscribed",
    });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: second.followUpId! } })).toMatchObject({ status: "SKIPPED" });
    // The first email that already went out stays as it is.
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: second.emailId } })).status).toBe("SENT");
  });

  it("never lowers a spam complaint to an unsubscribe (the strongest reason wins)", async () => {
    const s = await seedEmail({ createdById: owner.id, email: "complainer@unsub.no", status: "QUEUED", followUp: false });
    const pushedAt = new Date("2026-09-20T10:00:00Z");
    await dbWrite((c) =>
      c.suppression.create({
        data: { emailNorm: "complainer@unsub.no", reason: "COMPLAINED", source: "webhook", detail: null, pushedToMailgunAt: pushedAt },
      }),
    );
    const res = await people.markPersonUnsubscribed(owner, s.personId);
    // The person's own flag is still set and the waiting email still stops.
    expect(res).toEqual({ changed: true, email: "complainer@unsub.no" });
    expect((await db.person.findUniqueOrThrow({ where: { id: s.personId } })).unsubscribedAt).toBeInstanceOf(Date);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe("SKIPPED");
    // The do-not-email entry keeps its stronger reason, source and push marker.
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: "complainer@unsub.no" } })).toMatchObject({
      reason: "COMPLAINED",
      source: "webhook",
      pushedToMailgunAt: pushedAt,
    });
  });

  it("raises a weaker reason (do not email, bounced) to unsubscribed", async () => {
    for (const [email, reason] of [
      ["manual@unsub.no", "MANUAL"],
      ["bounced@unsub.no", "BOUNCED"],
    ] as const) {
      const s = await seedEmail({ createdById: owner.id, email, status: "QUEUED", followUp: false });
      await dbWrite((c) => c.suppression.create({ data: { emailNorm: email, reason, source: "manual", pushedToMailgunAt: new Date() } }));
      await people.markPersonUnsubscribed(owner, s.personId);
      expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: email } })).toMatchObject({
        reason: "UNSUBSCRIBED",
        source: "manual",
        pushedToMailgunAt: null,
      });
    }
  });

  it("queues the push to Mailgun (once), never in the practice copy", async () => {
    const s = await seedEmail({ createdById: owner.id, email: "push@unsub.no", status: "QUEUED", followUp: false });
    await people.markPersonUnsubscribed(owner, s.personId);
    const jobs = await db.job.findMany({ where: { type: "mailgun.syncSuppressions" } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ activeDedupeKey: "mailgun:push", status: "QUEUED" });
    const s2 = await seedEmail({ createdById: owner.id, email: "push2@unsub.no", status: "QUEUED", followUp: false });
    await people.markPersonUnsubscribed(owner, s2.personId);
    expect(await db.job.count({ where: { type: "mailgun.syncSuppressions" } })).toBe(1);

    await dbWrite((c) => c.job.deleteMany({}));
    await setSetting("practice.copy", true);
    try {
      const s3 = await seedEmail({ createdById: owner.id, email: "practice@unsub.no", mode: "DRY_RUN", status: "QUEUED", followUp: false });
      await people.markPersonUnsubscribed(owner, s3.personId);
      expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s3.emailId } })).status).toBe("SKIPPED");
      expect(await db.job.count({ where: { type: "mailgun.syncSuppressions" } })).toBe(0);
    } finally {
      await setSetting("practice.copy", false);
    }
  });
});
