import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeSentEmail, makeUser } from "../campaigns/seed";

const t = await createTestDb("sending-claim");
const { db, dbTx, dbWrite } = await import("@/server/db");
const {
  CAMPAIGN_CANCELLED_MESSAGE,
  CAMPAIGN_FINISHED_MESSAGE,
  cancelEmailsOfCancelledCampaigns,
  claimEmail,
  releaseClaim,
  resetStuckDryRunSends,
  STUCK_DRY_RUN_MESSAGE,
} = await import("@/server/services/sending/claim");

let userId = 0;
let n = 0;

beforeAll(async () => {
  userId = (await makeUser("Ali", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function queuedEmail(mode: "DRY_RUN" | "LIVE" = "DRY_RUN", status: "QUEUED" | "SENDING" = "QUEUED", claimedAt?: Date) {
  n += 1;
  const { company, people } = await makeCompany({ name: `Claim ${n}`, people: [{ name: "P" }] });
  const { email } = await makeSentEmail({
    mode,
    status,
    createdById: userId,
    companyId: company.id,
    personId: people[0]!.id,
    toNorm: people[0]!.emailNorm!,
    sentAt: claimedAt ?? new Date(),
  });
  return email;
}

describe("claiming an email", () => {
  it("lets exactly one of two concurrent claims win", async () => {
    const email = await queuedEmail();
    const results = await Promise.all([claimEmail(email.id), claimEmail(email.id), claimEmail(email.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe("SENDING");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).not.toBeNull();
  });

  it("only claims queued emails", async () => {
    const email = await queuedEmail();
    await dbWrite((c) => c.outboundEmail.update({ where: { id: email.id }, data: { status: "CANCELLED" } }));
    expect(await claimEmail(email.id)).toBe(false);
    expect(await claimEmail(987_654)).toBe(false);
  });

  it("is committed on its own, even when a transaction beside it rolls back", async () => {
    const email = await queuedEmail();
    const failing = dbTx(async (tx) => {
      await tx.activityLog.create({ data: { type: "test", summary: "rolled back" } });
      throw new Error("boom");
    }).catch((e: unknown) => e);
    const [claimed, err] = await Promise.all([claimEmail(email.id), failing]);
    expect(claimed).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } })).status).toBe("SENDING");
    expect(await db.activityLog.count({ where: { summary: "rolled back" } })).toBe(0);
  });

  it("releases a claim back to the queue, with or without counting the attempt", async () => {
    const email = await queuedEmail();
    expect(await claimEmail(email.id)).toBe(true);
    const later = new Date(Date.now() + 60_000);
    expect(await releaseClaim(email.id, { error: "Couldn't prepare this email: x", dueAt: later })).toBe("queued");
    let row = await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } });
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "Couldn't prepare this email: x", claimedAt: null });
    expect(row.dueAt.getTime()).toBe(later.getTime());
    expect(await releaseClaim(email.id)).toBe("lost"); // not claimed any more

    expect(await claimEmail(email.id)).toBe(true);
    expect(await releaseClaim(email.id, { countAttempt: false })).toBe("queued");
    row = await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.attempts).toBe(1);
  });

  it("cancels a claimed email instead of putting it back when its campaign has ended", async () => {
    const cancelled = await queuedEmail();
    const finished = await queuedEmail();
    expect(await claimEmail(cancelled.id)).toBe(true);
    expect(await claimEmail(finished.id)).toBe(true);
    await dbWrite((c) => c.campaign.update({ where: { id: cancelled.campaignId }, data: { status: "CANCELLED" } }));
    await dbWrite((c) => c.campaign.update({ where: { id: finished.campaignId }, data: { status: "FINISHED" } }));
    expect(await releaseClaim(cancelled.id, { error: "Couldn't prepare this email: x" })).toBe("cancelled");
    expect(await releaseClaim(finished.id)).toBe("cancelled");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: cancelled.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
      claimedAt: null,
    });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: finished.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_FINISHED_MESSAGE,
    });
  });

  it("puts dry-run emails stuck in Sending for over 2 minutes back in the queue (never live ones)", async () => {
    const now = new Date();
    const stuck = await queuedEmail("DRY_RUN", "SENDING", new Date(now.getTime() - 3 * 60_000));
    const fresh = await queuedEmail("DRY_RUN", "SENDING", new Date(now.getTime() - 30_000));
    const live = await queuedEmail("LIVE", "SENDING", new Date(now.getTime() - 10 * 60_000));
    expect(await resetStuckDryRunSends(now)).toBe(1);
    const rows = await db.outboundEmail.findMany({ where: { id: { in: [stuck.id, fresh.id, live.id] } }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["QUEUED", "SENDING", "SENDING"]);
    expect(rows[0]!.lastError).toBe(STUCK_DRY_RUN_MESSAGE);
    expect(STUCK_DRY_RUN_MESSAGE).not.toMatch(/queue/i);
  });

  it("cancels stuck dry-run emails of a campaign that was cancelled meanwhile, instead of queueing them again", async () => {
    const now = new Date();
    const stuck = await queuedEmail("DRY_RUN", "SENDING", new Date(now.getTime() - 3 * 60_000));
    await dbWrite((c) => c.campaign.update({ where: { id: stuck.campaignId }, data: { status: "CANCELLED" } }));
    expect(await resetStuckDryRunSends(now)).toBe(0);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
      claimedAt: null,
    });
  });

  it("cancels emails still waiting in cancelled campaigns, and nothing else", async () => {
    const leftover = await queuedEmail();
    const running = await queuedEmail();
    await dbWrite((c) => c.campaign.update({ where: { id: leftover.campaignId }, data: { status: "CANCELLED" } }));
    expect(await cancelEmailsOfCancelledCampaigns()).toBe(1);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: leftover.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
    });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("QUEUED");
    expect(await cancelEmailsOfCancelledCampaigns()).toBe(0);
  });
});
