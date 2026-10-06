import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignStatus, SendMode, SendStatus } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeOwner, seedEmail, setSetting } from "../mail-events/seed";
import { makeInbound } from "../stops-holds/world";

/**
 * The "Dry runs and test mode" tile (M6-DESIGN §4.3, B6.5 "shown separately"): today's dry-run and test-mode numbers
 * by the cap day in `sending.capDayTimeZone` (Karachi, UTC+5, so a cap day starts at 19:00 UTC the day before), the
 * running campaigns of each mode, the waiting dry-run replies; null in the practice copy and when all are 0.
 */

const t = await createTestDb("dashboard-dry-run");
const { db, dbWrite } = await import("@/server/db");
const { dryRunLines, loadDryRunSummary } = await import("@/server/services/dashboard/dry-run");

// Wednesday 23 Sep 2026, 15:00 in Karachi. The cap day runs 22 Sep 19:00 UTC → 23 Sep 19:00 UTC.
const NOW = new Date("2026-09-23T10:00:00.000Z");
let ownerId: number;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.inboundMessage.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
  });
  await setSetting("practice.copy", false);
  await setSetting("sending.capDayTimeZone", "Asia/Karachi");
});

async function sent(mode: SendMode, sentAt: Date, status: SendStatus = "SENT") {
  return seedEmail({ createdById: ownerId, mode, status, sentAt, followUp: false });
}

async function campaign(mode: SendMode | null, status: CampaignStatus) {
  return dbWrite((c) => c.campaign.create({ data: { name: `${mode} ${status}`, createdById: ownerId, mode, status } }));
}

describe("loadDryRunSummary", () => {
  it("counts today's sends by the Karachi cap day across UTC midnight", async () => {
    // Inside the cap day: 22 Sep 19:30 UTC (Karachi 00:30 on the 23rd; UTC's day would leave it out) and 23 Sep 09:00.
    await sent("DRY_RUN", new Date("2026-09-22T19:30:00.000Z"));
    await sent("DRY_RUN", new Date("2026-09-23T09:00:00.000Z"));
    await sent("TEST", new Date("2026-09-23T00:30:00.000Z"));
    // Outside: 22 Sep 18:59 UTC (Karachi 23:59 on the 22nd) and 23 Sep 19:00 UTC (Karachi midnight, the 24th).
    await sent("DRY_RUN", new Date("2026-09-22T18:59:00.000Z"));
    await sent("TEST", new Date("2026-09-23T19:00:00.000Z"));
    // Not SENT, or not a dry run / test mode: never counted.
    await sent("DRY_RUN", new Date("2026-09-23T08:00:00.000Z"), "QUEUED");
    await sent("TEST", new Date("2026-09-23T08:00:00.000Z"), "FAILED");
    await sent("LIVE", new Date("2026-09-23T08:00:00.000Z"));
    // Every seeded email has its own RUNNING campaign in its mode: 4 dry runs and 3 in test mode are running.
    expect(await loadDryRunSummary(NOW)).toEqual({
      today: { dryRun: 2, testMode: 1 },
      running: { dryRun: 4, testMode: 3 },
      waitingReplies: 0,
    });
  });

  it("follows the cap-day zone setting", async () => {
    await setSetting("sending.capDayTimeZone", "Europe/Berlin");
    // 23 Sep in Berlin: 22 Sep 22:00 UTC → 23 Sep 22:00 UTC.
    await sent("DRY_RUN", new Date("2026-09-22T19:30:00.000Z"));
    await sent("DRY_RUN", new Date("2026-09-22T22:30:00.000Z"));
    const s = await loadDryRunSummary(NOW);
    expect(s?.today).toEqual({ dryRun: 1, testMode: 0 });
  });

  it("counts running and scheduled campaigns of each mode only", async () => {
    await campaign("DRY_RUN", "RUNNING");
    await campaign("DRY_RUN", "SCHEDULED");
    await campaign("DRY_RUN", "PAUSED");
    await campaign("DRY_RUN", "FINISHED");
    await campaign(null, "DRAFT");
    await campaign("TEST", "SCHEDULED");
    await campaign("TEST", "CANCELLED");
    await campaign("LIVE", "RUNNING");
    expect(await loadDryRunSummary(NOW)).toEqual({ today: { dryRun: 0, testMode: 0 }, running: { dryRun: 2, testMode: 1 }, waitingReplies: 0 });
  });

  it("counts waiting dry-run replies (the ones the bell leaves out)", async () => {
    await makeInbound({ kind: "REPLY", assigneeId: ownerId, replyScope: "campaign" });
    await makeInbound({ kind: "POSSIBLE_REPLY", assigneeId: ownerId, replyScope: "campaign" });
    await makeInbound({ kind: "REPLY", assigneeId: ownerId, replyScope: "campaign", answeredAt: new Date(), answerOutcome: "answered" });
    await makeInbound({ kind: "REPLY", assigneeId: ownerId, replyScope: "real" });
    expect(await loadDryRunSummary(NOW)).toEqual({ today: { dryRun: 0, testMode: 0 }, running: { dryRun: 0, testMode: 0 }, waitingReplies: 2 });
  });

  it("is null when every number is 0, and always in the practice copy", async () => {
    await campaign("LIVE", "RUNNING");
    await sent("LIVE", new Date("2026-09-23T08:00:00.000Z"));
    expect(await loadDryRunSummary(NOW)).toBeNull();

    await sent("DRY_RUN", new Date("2026-09-23T08:00:00.000Z"));
    expect(await loadDryRunSummary(NOW)).not.toBeNull();
    await setSetting("practice.copy", true);
    expect(await loadDryRunSummary(NOW)).toBeNull();
  });
});

describe("dryRunLines", () => {
  it("writes the three lines, singular and plural", () => {
    expect(dryRunLines({ today: { dryRun: 40, testMode: 3 }, running: { dryRun: 2, testMode: 1 }, waitingReplies: 1 })).toEqual([
      "Dry run today: 40 emails in the outbox · 2 campaigns running",
      "Test mode today: 3 emails · 1 campaign running",
      "Dry-run replies waiting: 1",
    ]);
    expect(dryRunLines({ today: { dryRun: 1, testMode: 1 }, running: { dryRun: 1, testMode: 2 }, waitingReplies: 1_200 })).toEqual([
      "Dry run today: 1 email in the outbox · 1 campaign running",
      "Test mode today: 1 email · 2 campaigns running",
      "Dry-run replies waiting: 1,200",
    ]);
  });

  it("leaves out every part and line that is 0", () => {
    expect(dryRunLines({ today: { dryRun: 0, testMode: 3 }, running: { dryRun: 2, testMode: 0 }, waitingReplies: 0 })).toEqual([
      "Dry run today: 2 campaigns running",
      "Test mode today: 3 emails",
    ]);
    expect(dryRunLines({ today: { dryRun: 5, testMode: 0 }, running: { dryRun: 0, testMode: 0 }, waitingReplies: 0 })).toEqual([
      "Dry run today: 5 emails in the outbox",
    ]);
    expect(dryRunLines({ today: { dryRun: 0, testMode: 0 }, running: { dryRun: 0, testMode: 0 }, waitingReplies: 2 })).toEqual([
      "Dry-run replies waiting: 2",
    ]);
    expect(dryRunLines({ today: { dryRun: 0, testMode: 0 }, running: { dryRun: 0, testMode: 0 }, waitingReplies: 0 })).toEqual([]);
  });
});
