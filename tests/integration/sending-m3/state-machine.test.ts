import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "./helpers";

/**
 * Claim → POST → outcome (PLAN B6.7, M3-DESIGN §4.3.5) against the fake Mailgun: every answer Mailgun can give lands
 * the row in the right state, the proof of sending is saved before markSent, and nothing is ever sent twice.
 */

// markSent can be made to fail once, to test "Sent, but not recorded yet".
const markSentControl = vi.hoisted(() => ({ failNext: 0 }));
vi.mock("@/server/services/sending/mark-sent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/sending/mark-sent")>();
  return {
    ...real,
    markSent: async (...args: Parameters<typeof real.markSent>) => {
      if (markSentControl.failNext > 0) {
        markSentControl.failNext -= 1;
        throw new Error("database is locked (simulated)");
      }
      return real.markSent(...args);
    },
  };
});

const t = await createTestDb("m3-state-machine");
const { db, dbTx } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { claimEmail } = await import("@/server/services/sending/claim");
const { reconcileSends } = await import("@/server/services/sending/reconcile");
const { getPauseState } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { parsePacerState } = await import("@/core/system-state-parse");

const A = "anna@test-mailbox-a.de";
const B = "bea@test-mailbox-b.de";
const C = "cem@test-mailbox-c.de";
const D = "dora@test-mailbox-d.de";

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: [A, B, C, D] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  markSentControl.failNext = 0;
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", [A, B, C, D]);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function pacer() {
  return (await readTyped("sending.pacer", parsePacerState)).value;
}

async function row(campaignId: number, toNorm = A) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, toNorm } });
}

describe("a 200 from Mailgun", () => {
  it("saves Mailgun's id, records the email as sent, and paces the next one", async () => {
    const clock = worldClock(world);
    const { campaignId, companyIds } = await launchTo(world, [A], { now: clock.now() });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 1, sent: 1, waiting: null, finished: [campaignId] });

    const e = await row(campaignId);
    expect(e).toMatchObject({ status: "SENT", providerId: e.messageId, lastError: null });
    expect(e.sentAt?.toISOString()).toBe(clock.now().toISOString());
    expect(world.mg.fake.messages).toHaveLength(1);
    const f = world.mg.fake.messages[0]!.fields;
    expect(f.to).toEqual([A]);
    expect(f["h:Message-Id"]).toEqual([`<${e.messageId}>`]);
    expect(f["o:tag"]).toEqual(["outreach", "step-0"]);
    expect(f["v:send_id"]).toEqual([e.sendId]);
    expect(f["v:campaign_id"]).toEqual([String(campaignId)]);
    expect(f["v:step"]).toEqual(["0"]);
    expect(f["o:tracking-opens"]).toEqual(["no"]);
    expect(f["o:tracking-clicks"]).toEqual(["no"]);
    expect(f["o:testmode"]).toBeUndefined();
    expect(f.text?.[0]).toContain("%unsubscribe_url%");

    const p = await pacer();
    expect(p.lastSentAt).toBe(clock.now().toISOString());
    expect(Date.parse(p.nextSendAt!)).toBeGreaterThanOrEqual(clock.now().getTime() + 20_000);
    expect(p.ambiguousStreak).toBe(0);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: world.mg.domainId } })).lastLiveSendAt?.toISOString()).toBe(
      clock.now().toISOString(),
    );
    // §1.7: a live send before go-live doesn't make the company "emailed".
    const company = await db.company.findUniqueOrThrow({ where: { id: companyIds[0]! } });
    expect(company).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null, firstContactedAt: null });
    expect(await db.companyReservation.count({ where: { campaignId } })).toBe(0);
  });

  it("markSent failing after the 200 leaves 'Sent, but not recorded yet' with the proof; the reconciler finishes it, never twice", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [B], { now: clock.now() });
    markSentControl.failNext = 1;
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.unknown).toBe(1);
    const e = await row(campaignId, B);
    expect(e).toMatchObject({
      status: "UNKNOWN",
      providerId: e.messageId,
      lastError: "Sent, but not recorded yet. The app will record it within 10 minutes.",
    });
    expect(await db.notification.count({ where: { type: "system.mailgun", title: "An email was sent but not recorded yet" } })).toBe(1);

    // The loop never sends an UNKNOWN row again.
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).picked).toBe(0);

    const rec = await reconcileSends({ now: clock.advance(60_000), mailgun: world.mailgun });
    expect(rec).toMatchObject({ sent: 1, requeued: 0 });
    expect(await row(campaignId, B)).toMatchObject({ status: "SENT", providerId: e.messageId });
    expect(world.mg.fake.messages).toHaveLength(1);
  });
});

describe("Mailgun says no", () => {
  it("a 400 about this email: Didn't send, the recipient stops, Mailgun's words are kept for Details", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [C], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 400,
      body: { message: "to parameter is not a valid address. please check documentation." },
    });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ failed: 1, finished: [campaignId] });
    const e = await row(campaignId, C);
    expect(e).toMatchObject({ status: "FAILED", lastError: "Mailgun refused this email.", attempts: 1 });
    expect(e.claimedAt).not.toBeNull();
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "STOPPED", stopReason: "failed" });
    const log = await db.activityLog.findFirstOrThrow({ where: { campaignId, type: "email.failed" } });
    expect((log.data as { mailgunMessage?: string }).mailgunMessage).toBe("to parameter is not a valid address. please check documentation.");
    expect((await pacer()).recentRejects).toHaveLength(1);
    expect((await getPauseState()).paused).toBe(false);
  });

  it("three refusals of three different addresses pause sending (the circuit breaker)", async () => {
    const clock = worldClock(world);
    const bodies = { kind: "status" as const, status: 400, body: { message: "Something about the account we don't know" } };
    for (const to of [A, B, C]) {
      await launchTo(world, [to], { now: clock.now() });
      world.mg.fake.failNext("POST /v3/:d/messages", bodies);
      await loop.sendingTick(tickDeps(world, clock));
      clock.advance(60_000);
    }
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "mailgun-settings", reason: "Mailgun refused 3 emails in a row" });
    expect(pause.fixText).toBe(
      "Mailgun refused the last 3 emails (Something about the account we don't know). Check the banner in Mailgun, then click Resume.",
    );
    expect((await pacer()).recentRejects).toEqual([]);
  });

  it("'is not allowed to send' on a 400 pauses and puts the email back without counting a try", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [D], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 400,
      body: { message: `Domain ${world.mg.domain} is not allowed to send: Free accounts are for test purposes only` },
    });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.held).toBe(1);
    expect(await row(campaignId, D)).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    // MAIN-DOMAIN-DESIGN O25 (every mode): this text is the free-account refusal, so the pause names it and says to add
    // a payment card (never to authorize a prospect).
    const { PLAN_TEXTS } = await import("@/core/mailgun/plan");
    expect(await getPauseState()).toMatchObject({
      paused: true,
      kind: "mailgun-not-allowed",
      reason: PLAN_TEXTS.authorizedReason,
      fixText: PLAN_TEXTS.authorizedOnlyCampaign,
    });
    // Paused: nothing at all is claimed, dry runs included.
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ paused: true, picked: 0 });
  });

  it("any other 'is not allowed to send' on a 400 keeps the domain sentence", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [C], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 400,
      body: { message: `Domain ${world.mg.domain} is not allowed to send: domain is disabled` },
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).held).toBe(1);
    expect(await row(campaignId, C)).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-not-allowed", reason: `Mailgun won't send from ${world.mg.domain}` });
  });

  it("a 429 waits for Mailgun's reset without counting a try", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [A], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 429,
      body: { message: `Domain ${world.mg.domain} is not allowed to send: account-requests-per-sec limit exceeded, try again after 120 seconds` },
      headers: { "x-ratelimit-reset": "120000" },
    });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.held).toBe(1);
    const retryAt = new Date(clock.now().getTime() + 120_000);
    const e = await row(campaignId);
    expect(e).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    expect(e.dueAt.toISOString()).toBe(retryAt.toISOString());
    // 10:02 in Berlin is 13:02 in the cap-day zone (Asia/Karachi).
    expect(e.lastError).toBe("Mailgun asked us to slow down; trying again at 13:02");
    const p = await pacer();
    expect(p).toMatchObject({ backoffUntil: retryAt.toISOString(), backoffReason: "rate-limited" });
    expect((await getPauseState()).paused).toBe(false);
    // Nothing goes to Mailgun before the reset, not even another campaign's email that is due now.
    await launchTo(world, [B], { now: clock.advance(60_000) });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({
      picked: 0,
      waiting: { reason: "rate-limited", until: retryAt },
    });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("a 401 pauses with the API key reason and keeps the email", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [B], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 401, body: "Forbidden" });
    await loop.sendingTick(tickDeps(world, clock));
    expect(await row(campaignId, B)).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-auth", reason: "Mailgun didn't accept the API key" });
    expect(await db.notification.count({ where: { type: "sending.paused", title: "Sending paused: Mailgun didn't accept the API key" } })).toBe(1);
  });

  it("business verification pauses", async () => {
    const clock = worldClock(world);
    await launchTo(world, [C], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "businessVerification" });
    await loop.sendingTick(tickDeps(world, clock));
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-verification", reason: "Mailgun business verification" });
  });

  it("a 404 puts it back with a 5-minute back-off and asks the domain check to look", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [D], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 404, body: { message: "Domain not found" } });
    await loop.sendingTick(tickDeps(world, clock));
    const e = await row(campaignId, D);
    expect(e).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(e.lastError).toBe("Mailgun couldn't find the sending domain for a moment; trying again at 13:05");
    expect(await pacer()).toMatchObject({
      backoffUntil: new Date(clock.now().getTime() + 5 * 60_000).toISOString(),
      backoffReason: "mailgun-unreachable",
    });
    expect(await db.job.count({ where: { type: "mailgun.checkDomain", activeDedupeKey: "mailgun:domain-check" } })).toBe(1);
    expect((await getPauseState()).paused).toBe(false);
  });
});

describe("Mailgun may have it", () => {
  it("timeouts become 'Checking whether it was sent', with a 5, 15, then 60-minute back-off and a notice at 3", async () => {
    const clock = worldClock(world);
    const waits: number[] = [];
    for (const to of [A, B, C]) {
      const { campaignId } = await launchTo(world, [to], { now: clock.now() });
      world.mg.fake.failNext("POST /v3/:d/messages", { kind: "hang" });
      const r = await loop.sendingTick(tickDeps(world, clock));
      expect(r.unknown).toBe(1);
      expect(await row(campaignId, to)).toMatchObject({
        status: "UNKNOWN",
        providerId: null,
        lastError: "Mailgun didn't answer in time; checking whether it was sent",
        attempts: 1,
      });
      const p = await pacer();
      waits.push((Date.parse(p.backoffUntil!) - clock.now().getTime()) / 60_000);
      clock.set(new Date(Date.parse(p.backoffUntil!) + 1_000));
    }
    expect(waits).toEqual([5, 15, 60]);
    expect((await pacer()).ambiguousStreak).toBe(3);
    expect(await db.notification.count({ where: { title: "Mailgun isn't answering" } })).toBe(1);
  }, 20_000);

  it("a redirect or a 200 without an id is unclear too", async () => {
    const clock = worldClock(world);
    for (const fault of [{ kind: "acceptThenRedirect" as const }, { kind: "acceptWithoutId" as const }]) {
      const to = fault.kind === "acceptThenRedirect" ? A : B;
      const { campaignId } = await launchTo(world, [to], { now: clock.now() });
      world.mg.fake.failNext("POST /v3/:d/messages", fault);
      await clearPacer();
      expect((await loop.sendingTick(tickDeps(world, clock))).unknown).toBe(1);
      expect((await row(campaignId, to)).status).toBe("UNKNOWN");
    }
    expect(world.mg.fake.messages).toHaveLength(2);
  });

  it("a connection dropped after Mailgun accepted: the reconciler finds it and records it once", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [C], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
    expect((await loop.sendingTick(tickDeps(world, clock))).unknown).toBe(1);
    const e = await row(campaignId, C);
    expect(e.status).toBe("UNKNOWN");
    const rec = await reconcileSends({ now: clock.advance(3 * 60_000), mailgun: world.mailgun });
    expect(rec).toMatchObject({ sent: 1, requeued: 0 });
    expect(await row(campaignId, C)).toMatchObject({ status: "SENT", providerId: e.messageId });
    expect(world.mg.fake.messages).toHaveLength(1);
  });
});

describe("crash safety around the claim", () => {
  it("losing the lease (the tick's signal) during the POST never aborts it", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [D], { now: clock.now() });
    const stop = new AbortController();
    const r = await loop.sendingTick({
      ...tickDeps(world, clock),
      signal: stop.signal,
      render: async (args: { recipientId: number; step: number }) => {
        stop.abort();
        return { subject: `Hello ${args.recipientId}`, text: "Hi %unsubscribe_url%", html: "<p>Hi</p>", warnings: [] };
      },
    });
    expect(r.sent).toBe(1);
    expect((await row(campaignId, D)).status).toBe("SENT");
    expect(world.mg.fake.messages).toHaveLength(1);
  });

  it("a transaction rolled back beside a claim never takes the claim back", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [A], { now: clock.now() });
    const e = await row(campaignId);
    const rollback = dbTx(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { name: "Renamed in a failing transaction" } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("rolled back");
    }).catch(() => "rolled back");
    const claimed = claimEmail(e.id, clock.now());
    expect(await Promise.all([rollback, claimed])).toEqual(["rolled back", true]);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "SENDING", attempts: 1 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).name).not.toBe("Renamed in a failing transaction");
  });
});
