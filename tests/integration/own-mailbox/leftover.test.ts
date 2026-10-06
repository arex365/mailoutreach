import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { clearPacer, resetSendingState, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";
import { DOMAIN, OWN, draftTo, passReplyTest, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * Leftover rows of an interrupted launch (docs/dev/MAIN-DOMAIN-DESIGN.md O35, §2.3, §8 P1): a dry run of a draft that
 * stopped before its last transaction leaves rows with "@dry-run.invalid" Message-IDs. Relaunched in own-mailbox mode,
 * each leftover gets an id on the sending domain and sends. A row that still fails the own-mailbox sender check is
 * blocked once (sending pauses, the row goes back uncounted with `senderBlocked`), and blocked again after Resume it
 * fails for good ("Didn't send", `senderBlockedTwice`) instead of pausing a second time, and Retry refuses it (review
 * SEND-6) instead of bringing it back to pause again. Per-person mode keeps today's rule: a relaunch keeps the
 * leftover's id.
 */

const t = await createTestDb("own-mailbox-leftover");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { SENDER_HEADERS_PAUSE } = await import("@/server/services/sending/mailgun-transport");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { retryEmail, RETRY_FROM_TEXTS } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");

const LIST = Array.from({ length: 8 }, (_, i) => `x${i}@team-${i}.de`);

let world: M3World;

/** A dry-run launch of the draft that stops just before its last transaction (a power cut): rows stay, the draft too. */
async function interruptedDryRun(draftId: number, now: Date): Promise<void> {
  await setSettingValue("sending.mode", "DRY_RUN");
  const err = await launchCampaign(draftId, world.owner.id, {
    now,
    mailgun: world.mailgun,
    beforeFinalize: async () => {
      throw new Error("power cut");
    },
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((await db.campaign.findUniqueOrThrow({ where: { id: draftId } })).status).toBe("DRAFT");
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.fromAddress", OWN);
  await passReplyTest(world.owner.id);
  await storeCheck();
  await dbWrite((c) => c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } }));
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("leftover rows of an interrupted launch (O35)", () => {
  it("relaunched live in own-mailbox mode, every leftover gets an id on the sending domain and sends", async () => {
    const clock = worldClock(world);
    const d = await draftTo(world, [LIST[0]!, LIST[1]!]);
    await interruptedDryRun(d.draftId, clock.now());
    const leftovers = await db.outboundEmail.findMany({ where: { campaignId: d.draftId }, orderBy: { id: "asc" } });
    expect(leftovers).toHaveLength(2);
    for (const r of leftovers) expect(r.messageId).toMatch(/@dry-run\.invalid$/);

    await setSettingValue("sending.mode", "LIVE");
    await launchCampaign(d.draftId, world.owner.id, { now: clock.now(), mailgun: world.mailgun });
    const rows = await db.outboundEmail.findMany({ where: { campaignId: d.draftId }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.id)).toEqual(leftovers.map((r) => r.id));
    for (const r of rows) {
      expect(r).toMatchObject({ mode: "LIVE", status: "QUEUED", replyTo: null });
      expect(r.messageId).toMatch(/^pp\.[0-9a-f]{24}@example\.com$/);
    }
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages.map((m) => m.fields["h:Message-Id"]?.[0])).toEqual(rows.map((r) => `<${r.messageId}>`));
    expect((await getPauseState()).paused).toBe(false);
  });

  it("a row still off the domain is blocked once (paused, back uncounted), then fails for good after Resume without a second pause", async () => {
    const clock = worldClock(world);
    await setSettingValue("sending.mode", "LIVE");
    const d = await draftTo(world, [LIST[2]!]);
    await launchCampaign(d.draftId, world.owner.id, { now: clock.now(), mailgun: world.mailgun });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.draftId } });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { messageId: row.messageId.replace(/@.*$/, "@dry-run.invalid") } }));

    // First block: nothing sent, paused with the From-or-reply sentence, the row back in the queue with senderBlocked.
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, held: 1, failed: 0 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-settings", reason: SENDER_HEADERS_PAUSE.reason });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "QUEUED",
      attempts: 0,
      lastError: OWN_MAILBOX_TEXTS.senderBlocked,
    });

    // Resume: blocked again → Didn't send for good; sending isn't paused a second time.
    await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: clock.now() });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, failed: 1 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect((await getPauseState()).paused).toBe(false);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "FAILED",
      lastError: OWN_MAILBOX_TEXTS.senderBlockedTwice,
    });
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.draftId } })).state).toBe("STOPPED");

    // Review SEND-6: Retry is refused with a plain sentence, so it can't bring the row back to pause all sending again.
    const refused = await retryEmail(row.id, world.owner.id, { now: clock.now() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(CampaignError);
    expect(refused).toMatchObject({ code: "from-changed", message: RETRY_FROM_TEXTS.emailDoesntFit(OWN) });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, failed: 0, held: 0 });
    expect((await getPauseState()).paused).toBe(false);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "FAILED" });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("per-person mode keeps today's rule: a relaunch keeps the leftover's id", async () => {
    const clock = worldClock(world);
    await setSettingValue("mailgun.replies", "app");
    await setSettingValue("mailgun.fromAddress", null);
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    const address = await dbWrite((c) =>
      c.senderAddress.create({ data: { userId: world.member.id, domainId: domainRow.id, localPart: "ali", address: `ali@${DOMAIN}`, routeStatus: "ok" } }),
    );
    try {
      const d = await draftTo(world, [LIST[3]!]);
      await interruptedDryRun(d.draftId, clock.now());
      const leftover = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.draftId } });
      expect(leftover.messageId).toMatch(/@dry-run\.invalid$/);
      await setSettingValue("sending.mode", "TEST");
      await launchCampaign(d.draftId, world.owner.id, { now: clock.now(), mailgun: world.mailgun });
      const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: leftover.id } });
      expect(row).toMatchObject({ mode: "TEST", status: "QUEUED", messageId: leftover.messageId, fromAddress: `Ali from Polygon Paradise <ali@${DOMAIN}>` });
    } finally {
      await dbWrite((c) => c.senderAddress.delete({ where: { id: address.id } }));
    }
  });
});
