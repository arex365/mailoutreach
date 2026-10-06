import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SendStatus } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeOwner, seedEmail } from "../mail-events/seed";

const t = await createTestDb("mark-sent-only-from");
const { db } = await import("@/server/db");
const { markSent } = await import("@/server/services/sending/mark-sent");

/** The statuses a reply may prove sent (M4-DESIGN §3.7, D12). */
const REPLY_PROOF: readonly SendStatus[] = ["UNKNOWN", "UNCONFIRMED", "QUEUED"];

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("markSent with onlyFrom (a reply proves an email arrived)", () => {
  // Campaigns launched after go-live: their live sends count as "emailed" (M6-DESIGN §2.2: the launch flag decides).
  it.each(["UNKNOWN", "UNCONFIRMED", "QUEUED"] as const)("a %s email becomes SENT and the recipient moves on", async (status) => {
    const s = await seedEmail({ createdById: ownerId, status, recipientState: "SCHEDULED", followUp: false, providerId: null, launchedGoLive: true });
    const at = new Date(Date.now() - 60_000);
    const res = await markSent(s.emailId, at, { onlyFrom: REPLY_PROOF, practiceCopy: false });
    expect(res).toMatchObject({ alreadySent: false, counted: true });
    expect(res.next).not.toBeNull();
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).toMatchObject({ status: "SENT", sentAt: at });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).state).toBe("WAITING");
  });

  it.each(["SENDING", "FAILED"] as const)("a %s email is left alone", async (status) => {
    const s = await seedEmail({ createdById: ownerId, status, recipientState: "SCHEDULED", followUp: false, providerId: null });
    const res = await markSent(s.emailId, new Date(), { onlyFrom: REPLY_PROOF, practiceCopy: false });
    expect(res).toEqual({ emailId: s.emailId, campaignId: s.campaignId, alreadySent: false, counted: false, next: null, finished: false });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).status).toBe(status);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).state).toBe("SCHEDULED");
    expect(await db.activityLog.count({ where: { type: "email.sent", campaignId: s.campaignId } })).toBe(0);
  });

  it("an email already SENT stays as it was; without onlyFrom any status becomes SENT (Milestone 3 behaviour)", async () => {
    const sent = await seedEmail({ createdById: ownerId, followUp: false });
    expect(await markSent(sent.emailId, new Date(), { onlyFrom: REPLY_PROOF, practiceCopy: false })).toMatchObject({ alreadySent: true });
    const failed = await seedEmail({ createdById: ownerId, status: "FAILED", recipientState: "SCHEDULED", followUp: false, providerId: null });
    await markSent(failed.emailId, new Date(), { practiceCopy: false });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: failed.emailId } })).status).toBe("SENT");
  });
});
