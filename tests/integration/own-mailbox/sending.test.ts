import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StepSeed } from "../campaigns/seed";
import { setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { clearPacer, resetSendingState, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";
import { ALI_LINE, DOMAIN, OWN, ownRows, passReplyTest, launchOwn, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * Every email in own-mailbox mode (docs/dev/MAIN-DOMAIN-DESIGN.md §2.3, §2.4, O5, O6, O9, O10, O36, §8 P1), through the
 * real launch and sending loop against the fake Mailgun (Free plan, the domain's mail elsewhere): recipients see
 * "Ali from Polygon Paradise <contact@example.com>", there is no Reply-To, Message-IDs are on example.com, nobody has a
 * sending address and nothing waits on a reply route; the domain's own from-mx row holds live emails.
 */

const t = await createTestDb("own-mailbox-sending");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { setState } = await import("@/server/state");
const { loadGateContext } = await import("@/server/services/sending/gates");
const { launchModeProblems } = await import("@/server/services/campaigns/launch");
const { MailgunError } = await import("@/server/mailgun/errors");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");

const LIST = Array.from({ length: 10 }, (_, i) => `o${i}@team-${i}.de`);
const FOLLOW_UP: StepSeed[] = [
  { step: 0, subject: "Hello", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let world: M3World;

async function rowOf(campaignId: number, step = 0) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, step } });
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("mailgun.fromAddress", OWN);
  await passReplyTest(world.owner.id);
  await storeCheck();
  await dbWrite(async (c) => {
    // Earlier tests' sent emails must not count toward the plan's rolling limit here.
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
    await c.systemState.deleteMany({ where: { key: "sending.inboxCheck" } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the headers of every email", () => {
  it("test mode: the campaign and its row keep the own-mailbox snapshot; Mailgun gets the own From, no h:Reply-To, ids on example.com", async () => {
    await setSettingValue("sending.mode", "TEST");
    const clock = worldClock(world);
    const { campaignId } = await launchOwn(world, [LIST[0]!], { now: clock.now() });
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({
      mode: "TEST",
      fromName: "Ali from Polygon Paradise",
      fromAddress: OWN,
      replyTo: null,
      sendingDomainId: domainRow.id,
    });
    const row = await rowOf(campaignId);
    expect(row).toMatchObject({ fromAddress: ALI_LINE, replyTo: null });
    expect(row.messageId).toMatch(/^pp\.[0-9a-f]{24}@example\.com$/);

    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const m = world.mg.fake.messages[0]!;
    expect(m.fields.from).toEqual([ALI_LINE]);
    expect(m.fields["h:Reply-To"]).toBeUndefined();
    expect(m.fields["h:Message-Id"]).toEqual([`<${row.messageId}>`]);
    expect(m.fields["o:testmode"]).toEqual(["yes"]);
    expect(world.mg.fake.requests.some((r) => r.method === "POST" && r.path === "/v3/example.com/messages")).toBe(true);
    // No route is ever created or changed, and nobody got a sending address.
    expect(world.mg.fake.requests.some((r) => r.path.startsWith("/v3/routes") && r.method !== "GET")).toBe(false);
    expect(await db.senderAddress.count()).toBe(0);
  });

  it("live: goes with no SenderAddress (no route hold); lastLiveSendAt of example.com; the follow-up copies the From line", async () => {
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    await dbWrite((c) => c.sendingDomain.update({ where: { id: domainRow.id }, data: { lastLiveSendAt: null } }));
    const clock = worldClock(world);
    const { campaignId } = await launchOwn(world, [LIST[1]!], { now: clock.now(), steps: FOLLOW_UP });
    expect(await db.senderAddress.count()).toBe(0);
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r.sent).toBe(1);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: domainRow.id } })).lastLiveSendAt).toEqual(clock.now());
    expect(world.mg.fake.messages[0]!.fields.from).toEqual([ALI_LINE]);
    expect(world.mg.fake.messages[0]!.fields["o:testmode"]).toBeUndefined();

    const first = await rowOf(campaignId, 0);
    const next = await rowOf(campaignId, 1);
    expect(next).toMatchObject({ status: "QUEUED", fromAddress: ALI_LINE, replyTo: null, inReplyTo: first.messageId });
    expect(next.messageId).toMatch(/@example\.com$/);
    // The follow-up is a live one: it goes once someone has read contact@ after the first email (O33).
    clock.set(next.dueAt);
    await setState("sending.inboxCheck", { at: clock.now().toISOString(), byUserId: world.owner.id });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const f = world.mg.fake.messages[1]!.fields;
    expect(f.from).toEqual([ALI_LINE]);
    expect(f["h:Reply-To"]).toBeUndefined();
    expect(f["h:In-Reply-To"]).toEqual([`<${first.messageId}>`]);
    expect(f["h:Message-Id"]).toEqual([`<${next.messageId}>`]);
  });
});

describe("the domain's own MX guard (O10)", () => {
  it("a bad from-mx row holds live emails ('main-domain-mx'); test-mode emails go", async () => {
    await storeCheck(ownRows({ "from-mx": "bad" }));
    const clock = worldClock(world);
    const live = await launchOwn(world, [LIST[2]!], { now: clock.now() }).catch((e: unknown) => e);
    // A bad from-mx row stops a live launch first (the gate the launch shares with Live mode).
    expect(live).toMatchObject({ code: "mode-not-ready", message: MODE_GATE_TEXTS.fromMxOwn });

    // A live campaign launched while the row was fine waits once it turns bad.
    await storeCheck();
    const { campaignId } = await launchOwn(world, [LIST[3]!], { now: clock.now() });
    await storeCheck(ownRows({ "from-mx": "bad" }));
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "main-domain-mx" } });
    expect(world.mg.fake.messages).toHaveLength(0);

    await setSettingValue("sending.mode", "TEST");
    const test = await launchOwn(world, [LIST[4]!], { now: clock.now() });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await rowOf(test.campaignId)).status).toBe("SENT");
    expect((await rowOf(campaignId)).status).toBe("QUEUED");
  });

  it("the hold applies whether or not a From is saved; per-person app mode with nothing saved is never held", async () => {
    await storeCheck(ownRows({ "from-mx": "bad" }));
    await setSettingValue("mailgun.fromAddress", null);
    const ctx = await loadGateContext(new Date(), { due: [], needMailgun: false });
    expect(ctx).toMatchObject({ ownMailbox: true, mainDomainMxOk: false });
    // App mode (a corrupted flag reads as app), nothing saved, rows stored for app mode: today's rule, never held.
    await setSettingValue("mailgun.replies", "not-a-mode");
    await storeCheck(ownRows({ "from-mx": "bad" }), null);
    const app = await loadGateContext(new Date(), { due: [], needMailgun: false });
    expect(app).toMatchObject({ ownMailbox: false, mainDomainMxOk: true });
    await setSettingValue("mailgun.replies", "own-mailbox");
  });
});

describe("stored rows belong to one way of sending (O36)", () => {
  it("rows stored for app mode don't pass the live launch's checks, and hold nothing through the gates", async () => {
    await storeCheck(ownRows(), null);
    const problems = await launchModeProblems("LIVE", { name: "Ali", address: null }, { mailgun: world.mailgun });
    expect(problems.map((p) => p.text)).toContain(MODE_GATE_TEXTS.dns);
    await storeCheck(ownRows(), "app");
    expect((await launchModeProblems("LIVE", { name: "Ali", address: null }, { mailgun: world.mailgun })).map((p) => p.text)).toContain(
      MODE_GATE_TEXTS.dns,
    );
    // Stored for this mode: nothing stops it.
    await storeCheck();
    expect(await launchModeProblems("LIVE", { name: "Ali", address: null }, { mailgun: world.mailgun })).toEqual([]);

    // The gates ignore another mode's rows: a bad from-mx row stored for app mode holds nothing here.
    await storeCheck(ownRows({ "from-mx": "bad" }), "app");
    expect((await loadGateContext(new Date(), { due: [], needMailgun: false })).mainDomainMxOk).toBe(true);
  });
});

describe("fail closed (O6)", () => {
  it("the client's own check refuses a hand-built send with a Reply-To (or another From) before any request", async () => {
    const ctx = await world.mailgun();
    if (!ctx.connected) throw new Error("expected the fake to be connected");
    expect(ctx).toMatchObject({ replies: "own-mailbox", ownFrom: OWN, ownMailboxFrom: OWN });
    const base = {
      to: LIST[5]!,
      subject: "Hi",
      text: "Hi",
      html: "<p>Hi</p>",
      messageId: "pp.handbuilt1@example.com",
      tags: ["outreach"],
      variables: {},
      purpose: "campaign" as const,
      guard: { goLive: false, testList: new Set([LIST[5]!]) },
    };
    for (const bad of [
      { from: ALI_LINE, replyTo: "ali@example.com" },
      { from: "Ali <ali@example.com>", replyTo: null },
    ]) {
      const err = await ctx.sendClient.sendMessage(DOMAIN, { ...base, ...bad }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MailgunError);
      expect(err).toMatchObject({ kind: "sender", requestStarted: false });
    }
    expect(world.mg.fake.requests.filter((r) => r.path.endsWith("/messages"))).toHaveLength(0);
    expect(world.mg.fake.messages).toHaveLength(0);
  });
});
