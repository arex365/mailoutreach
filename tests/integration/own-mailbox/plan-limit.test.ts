import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { clearPacer, render, resetSendingState, tickDeps, worldClock, WEDNESDAY_10_BERLIN, type M3World } from "../sending-m3/helpers";
import { OWN, launchOwn, passReplyTest, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * The Mailgun Free plan's 100 emails a day (docs/dev/MAIN-DOMAIN-DESIGN.md O23, O24, §2.8, §8 P1): campaign emails
 * never go while the emails handed to Mailgun in the last 24 hours (the app's own count, or Mailgun's `accepted`
 * events when those are more) reach the limit minus the 10 kept for tests; today's cap is never planned above 90; a
 * send Mailgun refuses for the limit pauses and puts the email back (never "Didn't send"); a 429 is today's back-off.
 * Review SEND-2: test sends at the same time count each other, and the loop's final check counts again. Review SEND-5:
 * the 10 kept for tests are there on a full cap day, and the refusal after them is plain.
 */

const t = await createTestDb("own-mailbox-plan-limit");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { getPauseState } = await import("@/server/services/sending/pause");
const { countMailgunSendsSince, getTodayCap } = await import("@/server/services/sending/usage");
const { loadGateContext } = await import("@/server/services/sending/gates");
const { capReachedTestText, sendMeATest, sendReplyTestEmails, TestSendError } = await import("@/server/services/test-send");
const { PLAN_TEXTS } = await import("@/core/mailgun/plan");

const LIST = Array.from({ length: 14 }, (_, i) => `p${i}@team-${i}.de`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = WEDNESDAY_10_BERLIN;
const LIMIT_TEXT = "Domain example.com has reached its daily sending limit of 100 messages.";

let world: M3World;
let filler: { campaignId: number; recipientId: number } | null = null;
let seq = 0;

/** A finished campaign that holds the filler rows (their addresses never meet the campaigns under test). */
async function fillerCampaign(): Promise<{ campaignId: number; recipientId: number }> {
  if (filler) return filler;
  const { company, people } = await makeCompany({ name: "Filler", people: [{ name: "Filler", email: "filler@filler.de" }] });
  filler = await dbWrite(async (c) => {
    const campaign = await c.campaign.create({
      data: { name: "Filler", createdById: world.owner.id, senderId: world.owner.id, status: "FINISHED", mode: "LIVE", launchedGoLive: false },
    });
    const recipient = await c.campaignRecipient.create({
      data: { campaignId: campaign.id, companyId: company.id, personId: people[0]!.id, emailNorm: "filler@filler.de", state: "FINISHED" },
    });
    return { campaignId: campaign.id, recipientId: recipient.id };
  });
  return filler;
}

/** Writes counted Mailgun sends directly: SENT LIVE and TEST campaign emails and "Send me a test" rows, at `at`. */
async function writeSends(counts: { live?: number; test?: number; tests?: number }, at: (i: number) => Date): Promise<void> {
  const f = await fillerCampaign();
  const rows: Array<{ mode: "LIVE" | "TEST" }> = [
    ...Array.from({ length: counts.live ?? 0 }, () => ({ mode: "LIVE" as const })),
    ...Array.from({ length: counts.test ?? 0 }, () => ({ mode: "TEST" as const })),
  ];
  await dbWrite(async (c) => {
    if (rows.length > 0) {
      await c.outboundEmail.createMany({
        data: rows.map((r, i) => {
          seq += 1;
          return {
            campaignId: f.campaignId,
            recipientId: f.recipientId,
            step: 0,
            mode: r.mode,
            toEmail: `f${seq}@filler.de`,
            toNorm: `f${seq}@filler.de`,
            companyName: "Filler",
            fromAddress: `Ali <${OWN}>`,
            subject: "s",
            text: "t",
            html: "h",
            messageId: `pp.filler${seq}@example.com`,
            sendId: `filler-${seq}`,
            dueAt: at(i),
            status: "SENT",
            sentAt: at(i),
            claimedAt: at(i),
          };
        }),
      });
    }
    for (let i = 0; i < (counts.tests ?? 0); i++) {
      await c.testSend.create({ data: { userId: world.owner.id, to: "me@polygonparadise.test", subject: "filler", mode: "TEST", sentAt: at(rows.length + i), status: "SENT" } });
    }
  });
}

/** Mailgun reported `n` distinct accepted emails (other senders on the account, or test sends a restore lost). */
async function writeAccepted(n: number, at: Date): Promise<void> {
  await dbWrite((c) =>
    c.mailEvent.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        dedupeKey: `filler:accepted:${i}`,
        type: "accepted",
        occurredAt: new Date(at.getTime() + i * 1000),
        messageId: `other${i}@example.com`,
        recipient: null,
        source: "LOGS" as const,
        raw: {},
        processedAt: at,
      })),
    }),
  );
}

async function clearFillers(): Promise<void> {
  await dbWrite(async (c) => {
    if (filler) await c.outboundEmail.deleteMany({ where: { campaignId: filler.campaignId } });
    // Every test email (fillers, and the reply tests and "Send me a test" of earlier cases).
    await c.testSend.deleteMany({});
    await c.mailEvent.deleteMany({ where: { dedupeKey: { startsWith: "filler:" } } });
    // Earlier tests' own sends must not count toward the rolling 24 hours here.
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await clearFillers();
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.plan", "free");
  await setSettingValue("sending.capOverride", null);
  await passReplyTest(world.owner.id);
  await storeCheck();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the rolling guard (O23)", () => {
  it("90 counted sends in the last 24 hours hold the next test-mode email until the oldest is 24 hours old; at 89 it goes", async () => {
    const clock = worldClock(world, NOW);
    const oldest = new Date(NOW.getTime() - 20 * HOUR);
    // 60 live, 20 test-mode and 9 "Send me a test": 89.
    await writeSends({ live: 60, test: 20, tests: 9 }, (i) => new Date(oldest.getTime() + i * 60_000));
    const { campaignId } = await launchOwn(world, [LIST[0]!], { now: clock.now() });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages).toHaveLength(1);

    // That email made 90: the next one waits.
    const second = await launchOwn(world, [LIST[1]!], { now: clock.now() });
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 0, waiting: { reason: "plan-limit", until: new Date(oldest.getTime() + 24 * HOUR) } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: second.campaignId } })).status).toBe("QUEUED");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).status).toBe("SENT");
    const ctx = await loadGateContext(clock.now(), { due: [], needMailgun: false });
    expect(ctx).toMatchObject({ planLeft: 0, planOpensAt: new Date(oldest.getTime() + 24 * HOUR) });

    // Once the oldest sends are more than 24 hours old, room opens again.
    clock.set(new Date(oldest.getTime() + 24 * HOUR + 5 * 60_000));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });

  it("Mailgun's accepted events count when they are more than the app's own rows", async () => {
    const clock = worldClock(world, NOW);
    await writeSends({ live: 10 }, (i) => new Date(NOW.getTime() - 2 * HOUR + i * 1000));
    await writeAccepted(95, new Date(NOW.getTime() - 3 * HOUR));
    await launchOwn(world, [LIST[2]!], { now: clock.now() });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({
      sent: 0,
      waiting: { reason: "plan-limit", until: new Date(NOW.getTime() - 3 * HOUR + 24 * HOUR) },
    });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("without a daily limit (app mode, no plan chosen) nothing is counted or held", async () => {
    await setSettingValue("mailgun.replies", "app");
    await setSettingValue("mailgun.plan", null);
    await writeSends({ live: 150 }, (i) => new Date(NOW.getTime() - HOUR + i * 1000));
    const ctx = await loadGateContext(NOW, { due: [], needMailgun: false });
    expect(ctx).toMatchObject({ planLeft: null, planOpensAt: null });
    // A chosen Foundation plan has no daily limit either.
    await setSettingValue("mailgun.plan", "foundation");
    expect(await loadGateContext(NOW, { due: [], needMailgun: false })).toMatchObject({ planLeft: null });
  });
});

/** The first recipient of a launched campaign (for "Send me a test"). */
async function recipientOf(campaignId: number): Promise<number> {
  return (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).id;
}

/** The world's Mailgun context, but `onFirst` runs while the first email is being handed over (a click meanwhile). */
function duringFirstSend(onFirst: () => Promise<void>) {
  return async () => {
    const ctx = await world.mailgun();
    if (!ctx.connected) return ctx;
    const real = ctx.sendClient;
    let calls = 0;
    const sendClient = {
      sendMessage: async (...args: Parameters<typeof real.sendMessage>) => {
        calls += 1;
        if (calls === 1) await onFirst();
        return real.sendMessage(...args);
      },
    } as unknown as typeof real;
    return { ...ctx, sendClient };
  };
}

describe("test sends counted together (review SEND-2)", () => {
  it("a Send me a test clicked while the reply test sends counts every reply-test email: never more than 100 in 24 hours", async () => {
    const { dayStart } = await getTodayCap(NOW);
    // 98 counted in the last 24 hours, all before today's cap day (today's limit is untouched).
    await writeSends({ live: 98 }, (i) => new Date(dayStart.getTime() - 3 * HOUR + i * 10_000));
    expect((await countMailgunSendsSince(new Date(NOW.getTime() - DAY))).total).toBe(98);
    const { campaignId } = await launchOwn(world, [LIST[5]!], { now: NOW });
    const recipientId = await recipientOf(campaignId);

    let clicked: unknown = null;
    await setSettingValue("sending.testList", [LIST[6]!, LIST[7]!]);
    try {
      const res = await sendReplyTestEmails(world.owner.id, {
        jobId: 901,
        now: NOW,
        mailgun: duringFirstSend(async () => {
          clicked = await sendMeATest(world.member, { campaignId, recipientId, step: 0 }, { mailgun: world.mailgun, now: NOW }).catch((e: unknown) => e);
        }),
      });
      expect(res).toEqual({ sent: 2, failed: 0, skipped: [], paused: [] });
    } finally {
      await setSettingValue("sending.testList", LIST);
    }
    // Both reply-test emails were recorded before the first went out, so the click saw 100 and was refused.
    expect(clicked).toBeInstanceOf(TestSendError);
    expect((clicked as Error).message).toBe(PLAN_TEXTS.testsFull(100));
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([LIST[6], LIST[7]]);
    expect((await countMailgunSendsSince(new Date(NOW.getTime() - DAY))).total).toBe(100);
  });

  it("a test email sent between the loop's pick and its hand-over takes the last room: the campaign email goes back uncounted", async () => {
    const clock = worldClock(world, NOW);
    // 89 counted: the tick sees room for one more campaign email.
    await writeSends({ live: 60, test: 20, tests: 9 }, (i) => new Date(NOW.getTime() - 20 * HOUR + i * 60_000));
    const { campaignId } = await launchOwn(world, [LIST[8]!], { now: clock.now() });
    // A "Send me a test" lands while the campaign email is being prepared (after the tick counted).
    const clickMeanwhile = async (args: { recipientId: number; step: number; purpose: "send" }) => {
      await dbWrite((c) =>
        c.testSend.create({ data: { userId: world.owner.id, to: "me@polygonparadise.test", subject: "filler", mode: "TEST", sentAt: clock.now(), status: "SENT" } }),
      );
      return render(args);
    };
    expect(await loop.sendingTick(tickDeps(world, clock, { render: clickMeanwhile }))).toMatchObject({ sent: 0, held: 1, failed: 0 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "QUEUED", attempts: 0 });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "plan-limit" } });
    expect((await countMailgunSendsSince(new Date(NOW.getTime() - DAY))).total).toBe(90);
  });
});

describe("the 10 kept for test emails (review SEND-5)", () => {
  it("are there on a full cap day of campaign emails; once used, the refusal says so and suggests nothing that can't help", async () => {
    const today = await getTodayCap(NOW);
    await setSettingValue("sending.capOverride", { capDay: today.capDay, cap: 90, byUserId: world.owner.id, at: NOW.toISOString() });
    expect(await getTodayCap(NOW)).toMatchObject({ cap: 90, maxCap: 90 });
    await writeSends({ live: 90 }, (i) => new Date(today.dayStart.getTime() + i * 60_000));
    expect((await getTodayCap(NOW)).left).toBe(0);
    const { campaignId } = await launchOwn(world, [LIST[9]!], { now: NOW });
    const deps = { mailgun: world.mailgun, now: NOW };
    const input = { campaignId, recipientId: await recipientOf(campaignId), step: 0 };

    // The reply test (two mailboxes) and "Send me a test" still go.
    await setSettingValue("sending.testList", [LIST[10]!, LIST[11]!]);
    try {
      expect(await sendReplyTestEmails(world.owner.id, { jobId: 902, now: NOW, mailgun: world.mailgun })).toMatchObject({ sent: 2, failed: 0 });
    } finally {
      await setSettingValue("sending.testList", LIST);
    }
    expect(await sendMeATest(world.owner, input, deps)).toMatchObject({ status: "sent" });

    // Seven more test emails today make 100: the next one is refused, and the sentence doesn't send the owner to a
    // limit that can't go higher.
    await writeSends({ tests: 7 }, (i) => new Date(today.dayStart.getTime() + (120 + i) * 60_000));
    const refused = await sendMeATest(world.owner, input, deps).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TestSendError);
    const text = capReachedTestText(90, { reserve: 10, atMax: true });
    expect(text).toBe(
      "Today's limit of 90 emails and the 10 kept for test emails are used up: that's all your Mailgun plan sends in a day. Try again tomorrow.",
    );
    expect((refused as Error).message).toBe(text);
    const replyTest = await sendReplyTestEmails(world.owner.id, { jobId: 903, now: NOW, mailgun: world.mailgun }).catch((e: unknown) => e);
    expect((replyTest as Error).message).toBe(text);
  });

  it("below the plan's highest limit the refusal still offers changing today's limit; without a daily limit the sentence is as before", async () => {
    const today = await getTodayCap(NOW);
    await setSettingValue("sending.capOverride", { capDay: today.capDay, cap: 50, byUserId: world.owner.id, at: NOW.toISOString() });
    await writeSends({ live: 50, tests: 10 }, (i) => new Date(today.dayStart.getTime() + i * 60_000));
    const { campaignId } = await launchOwn(world, [LIST[12]!], { now: NOW });
    const refused = await sendMeATest(world.owner, { campaignId, recipientId: await recipientOf(campaignId), step: 0 }, { mailgun: world.mailgun, now: NOW }).catch(
      (e: unknown) => e,
    );
    expect((refused as Error).message).toBe(
      "Today's limit of 50 emails and the 10 kept for test emails are used up. Try again tomorrow, or change today's limit in Settings › Limits & warm-up.",
    );
    expect(capReachedTestText(50)).toBe(
      "Today's limit of 50 emails is reached, and tests count toward it. Try again tomorrow, or change today's limit in Settings › Limits & warm-up.",
    );
  });
});

describe("today's cap on Free (O23)", () => {
  it("is never above 90, whatever the saved maximum or today's override; Foundation keeps the saved maximum", async () => {
    const today = await getTodayCap(NOW);
    expect(today.maxCap).toBe(90);
    expect(today.cap).toBeLessThanOrEqual(90);
    await setSettingValue("sending.capOverride", { capDay: today.capDay, cap: 1000, byUserId: world.owner.id, at: NOW.toISOString() });
    expect((await getTodayCap(NOW)).cap).toBe(90);
    // Assumed Free in own-mailbox mode with no plan chosen.
    await setSettingValue("mailgun.plan", null);
    expect((await getTodayCap(NOW)).maxCap).toBe(90);
    await setSettingValue("mailgun.plan", "foundation");
    expect((await getTodayCap(NOW)).maxCap).toBe(1000);
  });
});

describe("Mailgun's own answers to a send", () => {
  it("a 400 that says the limit is reached: sending pauses with the plan sentence and the email goes back to the queue", async () => {
    await setSettingValue("sending.mode", "LIVE");
    const clock = worldClock(world, NOW);
    const { campaignId } = await launchOwn(world, [LIST[3]!], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 400, body: { message: LIMIT_TEXT } });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, failed: 0, held: 1 });
    expect(await getPauseState()).toMatchObject({
      paused: true,
      kind: "mailgun-not-allowed",
      reason: PLAN_TEXTS.limitReason,
      fixText: PLAN_TEXTS.limitRefused,
    });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).state).not.toBe("STOPPED");
  });

  it("a 429 is today's rate-limited back-off", async () => {
    const clock = worldClock(world, NOW);
    const { campaignId } = await launchOwn(world, [LIST[4]!], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 429, body: { message: "Too many requests" }, headers: { "X-RateLimit-Reset": "120000" } });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, held: 1 });
    expect((await getPauseState()).paused).toBe(false);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row.status).toBe("QUEUED");
    expect(row.lastError).toMatch(/^Mailgun asked us to slow down; trying again at /);
    const pacer = await db.systemState.findUniqueOrThrow({ where: { key: "sending.pacer" } });
    expect(pacer.value).toMatchObject({ backoffReason: "rate-limited" });
  });
});
