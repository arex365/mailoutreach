import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckStatus } from "@/core/system-state";
import { waitingText } from "@/components/campaigns/format";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { writeDomainCheck } from "../mailgun-setup/helpers";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * SHARED-FROM-DESIGN F27 (§2.5 point 3, §3.7): while the Domain checklist's "from-mx" row is "bad" (the main domain's
 * mail servers point to Mailgun or are missing), every LIVE email waits with the reason "main-domain-mx"; test-mode
 * emails and dry runs go. A "warn", "unknown" or missing row holds nothing. Through the real sending loop and the fake
 * Mailgun, with the rows written the way the domain check stores them.
 */

const t = await createTestDb("shared-from-hold");
const { db } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { explainCampaignWaiting } = await import("@/server/services/sending/gates");

const TEAM = "contact@example.com";
const LIST = Array.from({ length: 8 }, (_, i) => `h${i}@hold-${i}.de`);
const WAITING_TEXT =
  "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist.";

let world: M3World;

/** The Domain checklist of the sending domain, every row "ok" except the from-mx row (null = no from-mx row at all). */
async function checklist(fromMx: CheckStatus | null): Promise<void> {
  await writeDomainCheck(world.mg.domain, fromMx ? { "from-mx": fromMx } : {});
}

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
  await setSettingValue("mailgun.fromAddress", TEAM);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
    from: TEAM,
  });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "LIVE");
  // A live launch in shared-From mode needs a checked, green from-mx row; each test turns it afterwards.
  await checklist("ok");
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the main-domain MX hold", () => {
  it("a bad from-mx row holds live emails while test-mode emails go; the campaign page says why; fixed, the live email goes", async () => {
    const clock = worldClock(world);
    const live = await launchTo(world, [LIST[0]!], { now: clock.now() });
    await setSettingValue("sending.mode", "TEST");
    await launchTo(world, [LIST[1]!], { now: clock.now() });
    await checklist("bad");

    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect(r.waiting).toEqual({ reason: "main-domain-mx", until: null });
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([LIST[1]]);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status).toBe("QUEUED");

    const waiting = await explainCampaignWaiting(live.campaignId, clock.now(), { mailgun: world.mailgun });
    expect(waiting).toEqual({ reason: "main-domain-mx", until: null });
    expect(waitingText(waiting!, { timeZone: "Europe/Berlin", now: clock.now(), senderName: "Ali" })).toBe(WAITING_TEXT);

    await checklist("ok");
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status).toBe("SENT");
  });

  it("a live follow-up waits too; a dry run goes", async () => {
    const clock = worldClock(world);
    const live = await launchTo(world, [LIST[2]!], {
      now: clock.now(),
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const next = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId, step: 1 } });
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await launchTo(world, [LIST[3]!], { now: next.dueAt, ignoreWindow: false });
    clock.set(next.dueAt);
    await checklist("bad");
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect(r.waiting?.reason).toBe("main-domain-mx");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: dry.campaignId } })).status).toBe("SENT");
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: next.id } })).status).toBe("QUEUED");
    expect(world.mg.fake.messages).toHaveLength(1);
  });

  it("per-person mode is never held, even by a bad from-mx row stored before the From address was cleared (review SECURITY-3)", async () => {
    const passed = {
      setup: "A",
      status: "passed",
      domain: world.mg.domain,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: world.owner.id,
      note: null,
    };
    await setSettingValue("mailgun.fromAddress", null);
    await setSettingValue("mailgun.unsubscribeTest", { ...passed, from: null });
    try {
      const clock = worldClock(world);
      const live = await launchTo(world, [LIST[7]!], { now: clock.now() });
      // The row a check wrote while the From address was still saved (the check ran across the change).
      await checklist("bad");
      const r = await loop.sendingTick(tickDeps(world, clock));
      expect(r.sent).toBe(1);
      expect(r.waiting?.reason).not.toBe("main-domain-mx");
      expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status).toBe("SENT");
      expect(await explainCampaignWaiting(live.campaignId, clock.now(), { mailgun: world.mailgun })).not.toEqual({ reason: "main-domain-mx", until: null });
      // Per-person: From is the sender's own address, no Reply-To.
      const sent = world.mg.fake.messages[0]!;
      expect(sent.fields.from?.[0]).not.toContain(TEAM);
      expect(sent.fields["h:Reply-To"]).toBeUndefined();
    } finally {
      await setSettingValue("mailgun.fromAddress", TEAM);
      await setSettingValue("mailgun.unsubscribeTest", { ...passed, from: TEAM });
    }
  });

  it("'warn', 'unknown' or no from-mx row hold nothing", async () => {
    for (const [i, status] of (["warn", "unknown", null] as const).entries()) {
      await resetSendingState();
      world.mg.fake.reset();
      await setSettingValue("sending.mode", "LIVE");
      await checklist("ok");
      const clock = worldClock(world);
      const live = await launchTo(world, [LIST[4 + i]!], { now: clock.now() });
      await checklist(status);
      const r = await loop.sendingTick(tickDeps(world, clock));
      expect(r.sent, String(status)).toBe(1);
      expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status, String(status)).toBe("SENT");
    }
  });
});
