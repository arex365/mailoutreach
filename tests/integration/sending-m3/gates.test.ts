import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import {
  checklistRows,
  clearPacer,
  launchTo,
  resetSendingState,
  setupM3,
  tickDeps,
  worldClock,
  type M3World,
} from "./helpers";

/**
 * Sending hours, limits, pacing and the holds (PLAN B6.4, B6.6, M3-DESIGN §4.3.2, §4.3.4) through the real sending
 * loop, the real database and the fake Mailgun, with a fixed clock (Wednesday 10:00 in Berlin).
 */

const t = await createTestDb("m3-gates");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parsePacerState } = await import("@/core/system-state-parse");
const { DEFAULT_WINDOW } = await import("@/core/sending/window");

const LIST = ["g1@gates-1.de", "g2@gates-2.de", "g3@gates-3.de", "g4@gates-4.de", "g5@gates-5.de", "g6@gates-6.de"];
const [A, B, C, D, E] = LIST as [string, string, string, string, string, string];
const MIN = 60_000;

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.capOverride", null);
  await setSettingValue("practice.copy", false);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: null,
    decidedById: null,
    note: null,
  });
  await setState("domain.check", { domain: world.mg.domain, region: "EU", checkedAt: null, lastVerifyAt: null, rows: checklistRows(), error: null });
  await dbWrite(async (c) => {
    await c.senderAddress.updateMany({ data: { routeStatus: "ok" } });
    await c.user.updateMany({ data: { dailyCap: null } });
    await c.notification.deleteMany({});
    // Earlier tests' sends must not use up today's limit (every test runs on the same fixed day).
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function pacer() {
  return (await readTyped("sending.pacer", parsePacerState)).value;
}

describe("sending hours", () => {
  it("600 due emails in a closed zone never starve the one in an open zone", async () => {
    const clock = worldClock(world);
    await setSettingValue("sending.mode", "DRY_RUN");
    const many = Array.from({ length: 600 }, (_, i) => `closed${i}@auckland-studio.nz`);
    const closed = await launchTo(world, many, { now: clock.now(), sameCompany: true, ignoreWindow: false, timeZone: "Pacific/Auckland" });
    await setSettingValue("sending.mode", "LIVE");
    const open = await launchTo(world, [A], { now: clock.now() });

    const picked = await gates.pickCandidates(clock.now(), { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin" });
    expect(picked.gated.map((c) => c.campaignId)).toEqual([open.campaignId]);
    expect(picked.due.find((d) => d.zone === "Pacific/Auckland")?.count).toBe(600);

    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 1, sent: 1 });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: open.campaignId } })).status).toBe("SENT");
    expect(await db.outboundEmail.count({ where: { campaignId: closed.campaignId, status: "QUEUED" } })).toBe(600);
  }, 60_000);

  it("claims nothing while every due email's window is closed, and says when the next one opens", async () => {
    // Wednesday 18:00 in Berlin: closed until Thursday 09:00 (07:00 UTC).
    const clock = worldClock(world, new Date("2026-09-23T16:00:00Z"));
    const { campaignId } = await launchTo(world, [B], { now: clock.now() });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 0, waiting: { reason: "outside-hours", until: new Date("2026-09-24T07:00:00Z") } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).status).toBe("QUEUED");
    expect((await pacer()).waiting).toMatchObject({ reason: "outside-hours", until: "2026-09-24T07:00:00.000Z" });
    // At 09:00 it goes.
    clock.set(new Date("2026-09-24T07:00:00Z"));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });
});

describe("daily limits and pacing", () => {
  it("today's limit reached: the Owner hears once per cap day; uncounted emails may still go", async () => {
    const clock = worldClock(world);
    await setSettingValue("sending.capOverride", { capDay: "2026-09-23", cap: 1, byUserId: world.owner.id, at: clock.now().toISOString() });
    await launchTo(world, [C, D], { now: clock.now() });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 0, waiting: { reason: "cap-reached" } });
    await clearPacer();
    clock.advance(MIN);
    await loop.sendingTick(tickDeps(world, clock));
    const notes = await db.notification.findMany({ where: { type: "sending.capReached" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: "Today's limit of 1 email is reached",
      body: "The rest go out from the start of tomorrow's sending hours in each recipient's time zone. To send more today, change today's limit in Settings › Limits & warm-up.",
      link: "/settings/limits",
    });
    // A test-mode email doesn't count toward the limit: it still goes.
    await setSettingValue("sending.mode", "TEST");
    await launchTo(world, [E], { now: clock.now() });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages.at(-1)!.fields["o:testmode"]).toEqual(["yes"]);
  });

  it("a sender at their own limit waits; another sender's email goes", async () => {
    const clock = worldClock(world);
    await dbWrite((c) => c.user.update({ where: { id: world.member.id }, data: { dailyCap: 1 } }));
    const ali = await launchTo(world, [A, B], { now: clock.now(), senderId: world.member.id });
    const arslan = await launchTo(world, [C], { now: clock.now(), senderId: world.owner.id });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await clearPacer();
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect(r.waiting).toMatchObject({ reason: "sender-cap" });
    expect(await db.outboundEmail.count({ where: { campaignId: ali.campaignId, status: "SENT" } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId: arslan.campaignId, status: "SENT" } })).toBe(1);
  });

  it("spreads the emails over the open time left: the gap follows the formula, and nothing goes before it", async () => {
    const clock = worldClock(world);
    await launchTo(world, [A, B, C], { now: clock.now() });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // 10:00–17:00 Berlin = 25,200 s open; 2 more due → 3 intervals; random 0.5 → factor 1.0.
    const p = await pacer();
    expect(p.lastGapSeconds).toBe(8_400);
    expect(p.nextSendAt).toBe(new Date(clock.now().getTime() + 8_400_000).toISOString());
    expect(p.lastByClass).toEqual({ counted: { at: clock.now().toISOString(), jitter: 1 }, uncounted: null });
    clock.advance(10 * MIN);
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ picked: 0, waiting: { reason: "pacing", until: new Date(Date.parse(p.nextSendAt!)) } });
    clock.set(new Date(Date.parse(p.nextSendAt!)));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });
});

describe("waiting for Mailgun and for fixes", () => {
  it("the start-up check with Mailgun: waits; a network failure opens it after 15 minutes; an auth failure never", async () => {
    const clock = worldClock(world);
    const startedAt = new Date(clock.now().getTime() - MIN);
    await launchTo(world, [A], { now: clock.now() });
    expect(await loop.sendingTick(tickDeps(world, clock, { startedAt }))).toMatchObject({ picked: 0, waiting: { reason: "catch-up" } });

    const failed = (kind: "auth" | "network") => ({
      lastStartedAt: clock.now().toISOString(),
      lastFinishedAt: clock.now().toISOString(),
      lastSuccessAt: null,
      lastError: "Couldn't reach Mailgun",
      lastErrorKind: kind,
      lastReason: "startup",
      lastSummary: null,
    });
    await setState("mailgun.catchUp", failed("auth"));
    clock.advance(20 * MIN);
    expect(await loop.sendingTick(tickDeps(world, clock, { startedAt }))).toMatchObject({ picked: 0, waiting: { reason: "catch-up" } });
    await setState("mailgun.catchUp", failed("network"));
    expect((await loop.sendingTick(tickDeps(world, clock, { startedAt }))).sent).toBe(1);

    // A success after the start opens it straight away.
    const startedLater = new Date(clock.now().getTime() - MIN);
    await setState("mailgun.catchUp", { ...failed("network"), lastSuccessAt: clock.now().toISOString(), lastErrorKind: null });
    await launchTo(world, [B], { now: clock.now() });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock, { startedAt: startedLater }))).sent).toBe(1);
  });

  it("holds Mailgun emails while a restore is being checked, but not dry runs", async () => {
    const clock = worldClock(world);
    await setState("restore", {
      status: "scanning",
      restoredFrom: null,
      scanFrom: null,
      markerAt: clock.now().toISOString(),
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const live = await launchTo(world, [A], { now: clock.now() });
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await launchTo(world, ["dry@restore-held.de"], { now: clock.now(), ignoreWindow: false });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.waiting).toMatchObject({ reason: "restore-check" });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: live.campaignId } })).status).toBe("QUEUED");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: dry.campaignId } })).status).toBe("SENT");
  });

  it("holds live emails while the live settings drifted (Setup B, tracking back on)", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [B], { now: clock.now() });
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "B",
      status: "untested",
      domain: null,
      mailboxes: [],
      headersOk: null,
      decidedAt: null,
      decidedById: null,
      note: null,
    });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "live-not-ready" } });
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: world.mg.domain,
      mailboxes: [],
      headersOk: true,
      decidedAt: null,
      decidedById: null,
      note: null,
    });
    await setState("domain.check", {
      domain: world.mg.domain,
      region: "EU",
      checkedAt: null,
      lastVerifyAt: null,
      rows: checklistRows({ "tracking-off": "bad" }),
      error: null,
    });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "live-not-ready" } });
    // "Couldn't check right now" never holds anything.
    await setState("domain.check", {
      domain: world.mg.domain,
      region: "EU",
      checkedAt: null,
      lastVerifyAt: null,
      rows: checklistRows({ "tracking-off": "unknown" }),
      error: null,
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).status).toBe("SENT");
  });

  it("a reply route being set up only makes live emails wait (never stops anyone); the Owner hears after an hour", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [C], { now: clock.now() });
    await dbWrite((c) => c.senderAddress.updateMany({ where: { address: world.senderAddress }, data: { routeStatus: "pending" } }));
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "reply-route" } });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "SCHEDULED" });
    expect(await db.notification.count({ where: { type: "system.replyRoute" } })).toBe(0);
    clock.advance(61 * MIN);
    await loop.sendingTick(tickDeps(world, clock));
    const note = await db.notification.findFirstOrThrow({ where: { type: "system.replyRoute" } });
    expect(note).toMatchObject({
      title: "Live emails are waiting: a reply route isn't working",
      body: "Replies to Ali couldn't reach them, so their live emails wait. Click Apply recommended settings in Settings › Domain checklist.",
    });
    await dbWrite((c) => c.senderAddress.updateMany({ where: { address: world.senderAddress }, data: { routeStatus: "ok" } }));
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await pacer()).routeWaitSince).toBeNull();
  });
});

describe("before every send (B6.4)", () => {
  it("an unprocessed Mailgun report holds only that address; the next email goes", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [A, B], { now: clock.now() });
    await dbWrite((c) =>
      c.mailEvent.create({
        data: { dedupeKey: "pending-1", type: "delivered", occurredAt: clock.now(), recipient: A, source: "WEBHOOK", raw: {} },
      }),
    );
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect(r.waiting).toMatchObject({ reason: "pending-events" });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, toNorm: A } })).status).toBe("QUEUED");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, toNorm: B } })).status).toBe("SENT");
  });

  it("an unprocessed reply holds that company, even one from before the launch; a reply to a reply-test email holds nothing", async () => {
    const clock = worldClock(world);
    // Two people at one company (both on the test list), and one elsewhere.
    await setSettingValue("sending.testList", [...LIST, "colleague1@replied-co.de", "colleague2@replied-co.de"]);
    const again = await launchTo(world, ["colleague1@replied-co.de", "colleague2@replied-co.de"], { now: clock.now(), sameCompany: true });
    const other = await launchTo(world, [D], { now: clock.now() });
    // Someone at the company answered BEFORE this launch; the reply isn't processed yet. Since Milestone 4 the guard
    // holds it whatever its date (M4-DESIGN §2.5.1): the event lane processes it within a second.
    await dbWrite((c) =>
      c.inboundMessage.create({
        data: {
          receivedAt: new Date(clock.now().getTime() - 86_400_000),
          toAddress: world.senderAddress,
          fromEmail: "colleague1@replied-co.de",
          subject: "Re: Hello",
          source: "NOTIFY",
        },
      }),
    );
    // A reply to a reply-test email from a test mailbox holds nothing.
    await dbWrite(async (c) => {
      await c.testSend.create({
        data: { userId: world.owner.id, to: D, subject: "Reply test", mode: "LIVE", purpose: "REPLY_TEST", messageId: "pp.replytest1@send.example.com" },
      });
      await c.inboundMessage.create({
        data: {
          receivedAt: new Date(clock.now().getTime() + 1_000),
          toAddress: world.senderAddress,
          fromEmail: D,
          subject: "Re: Reply test",
          inReplyTo: "pp.replytest1@send.example.com",
          references: "pp.replytest1@send.example.com",
          source: "NOTIFY",
        },
      });
    });
    clock.advance(2_000);
    const due = await gates.pickCandidates(clock.now(), { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin" });
    const blocked = (await gates.pendingProblemIds(due.gated)).pending;
    const rows = await db.outboundEmail.findMany({ where: { campaignId: { in: [again.campaignId, other.campaignId] } } });
    const idOf = (to: string) => rows.find((r) => r.toNorm === to)!.id;
    expect(blocked.has(idOf("colleague1@replied-co.de"))).toBe(true);
    expect(blocked.has(idOf("colleague2@replied-co.de"))).toBe(true);
    expect(blocked.has(idOf(D))).toBe(false);
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: idOf(D) } })).status).toBe("SENT");
  });
});
