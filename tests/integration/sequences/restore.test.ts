import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * The restore check with follow-ups (M4-DESIGN §2.11): a follow-up the backup never knew is found in Mailgun's logs
 * by (campaign, step, recipient) and its row made again, threaded to the newest email already sent to that person at
 * a lower step (a switched-off step leaves a gap, so never simply step − 1).
 */

const t = await createTestDb("sequences-restore");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const restore = await import("@/server/services/sending/restore");
const { setState } = await import("@/server/state");

const WED = new Date("2026-09-23T08:00:00Z");
const MON = new Date("2026-09-28T07:00:00Z");
const TO = "r1@restore-thread.de";

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: [TO] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("mailgun.logRetentionDays", 10);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("a follow-up row made again by the restore check", () => {
  it("with follow-up 1 switched off, a missing follow-up 2 threads to the first email", async () => {
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [TO], {
      now: clock.now(),
      steps: [
        { step: 0, subject: "3D models for your shop", body: "First" },
        { step: 1, body: "Second", delayDays: 1, enabled: false },
        { step: 2, body: "Third", delayDays: 3 },
      ],
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
    clock.set(MON);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const followUp = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 2 } });
    expect(followUp).toMatchObject({ status: "SENT", inReplyTo: first.messageId });

    // The backup was made after the launch but before follow-up 2 went out: its row is gone.
    await dbWrite(async (c) => {
      await c.outboundEmail.delete({ where: { id: followUp.id } });
      await c.campaignRecipient.updateMany({ where: { campaignId }, data: { state: "WAITING", currentStep: 2 } });
      await c.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING", finishedAt: null } });
    });
    const markerAt = clock.advance(5 * 60_000);
    await setState("restore", {
      status: "pending",
      restoredFrom: new Date(WED.getTime() + 60_000).toISOString(),
      scanFrom: new Date(WED.getTime() - 3_600_000).toISOString(),
      markerAt: markerAt.toISOString(),
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const report = await restore.runRestoreScan({ now: clock.advance(60_000), pass: 1, mailgun: world.mailgun });
    expect(report).toMatchObject({ mailgunChecked: true, matchedByRecipient: 1, rowsCreated: 1 });
    const recreated = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 2 } });
    expect(recreated).toMatchObject({
      status: "SENT",
      messageId: followUp.messageId,
      inReplyTo: first.messageId,
      references: first.messageId,
    });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "FINISHED", currentStep: 2 });
  });
});
