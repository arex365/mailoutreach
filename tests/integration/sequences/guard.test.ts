import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * The full "before every send" guard (B6.4, M4-DESIGN §2.5.1): an unprocessed reply holds the address, anyone at the
 * company, and every email of ours its thread points at, whatever its date; replies that will be filed as test
 * replies (our own team, the reply test's mailbox) hold nothing; simulated replies never hold real emails; an
 * undecided possible reply holds the company's candidates until the maintenance or the launch puts them on hold; and
 * the guard runs again just before the hand-over, so a reply stored after the pick sends nothing.
 */

const t = await createTestDb("sequences-guard");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");

const LIST = Array.from({ length: 30 }, (_, i) => `g${i}@guard-${i}.de`);
const WED = new Date("2026-09-23T08:00:00Z");

let world: M3World;
let next = 0;
const address = () => LIST[next++]!;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  gates.clearThreadTargetCache();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await dbWrite(async (c) => {
    await c.inboundMessage.deleteMany({});
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

type Reply = { fromEmail: string; inReplyTo?: string | null; references?: string | null; source?: "NOTIFY" | "CATCHUP" | "SIMULATED"; receivedAt?: Date };

async function storeReply(r: Reply) {
  return dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        receivedAt: r.receivedAt ?? WED,
        toAddress: world.senderAddress,
        fromEmail: r.fromEmail,
        subject: "Re: Hello",
        inReplyTo: r.inReplyTo ?? null,
        references: r.references ?? null,
        source: r.source ?? "NOTIFY",
      },
    }),
  );
}

/** The guard for these campaigns' due emails, by address. */
async function heldAddresses(now: Date, campaignIds: number[]) {
  const { gated } = await gates.pickCandidates(now, { window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }, defaultZone: "Europe/Berlin" });
  const mine = gated.filter((c) => campaignIds.includes(c.campaignId));
  const problems = await gates.pendingProblemIds(mine);
  return {
    pending: mine.filter((c) => problems.pending.has(c.id)).map((c) => c.toNorm).sort(),
    possible: mine.filter((c) => problems.possibleReply.has(c.id)).map((c) => c.toNorm).sort(),
  };
}

describe("unprocessed replies", () => {
  it("a colleague we don't know, replying to our email to A: every candidate at A waits; the next one goes", async () => {
    const clock = worldClock(world, WED);
    const [anna, ben, other] = [address(), address(), address()];
    const a = await launchTo(world, [anna, ben], { now: clock.now(), sameCompany: true });
    const b = await launchTo(world, [other], { now: clock.now() });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const sent = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: a.campaignId, status: "SENT" } });
    // jonas@… isn't a contact: only the thread (References) says it's about company A.
    await storeReply({ fromEmail: "jonas@colleague-unknown.de", references: `<${sent.messageId}>` });
    await clearPacer();
    expect(await heldAddresses(clock.now(), [a.campaignId, b.campaignId])).toEqual({ pending: [anna, ben].filter((x) => x !== sent.toNorm), possible: [] });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 1, waiting: { reason: "pending-events" } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: b.campaignId } })).status).toBe("SENT");
  });

  it("a known person at A holds A, also a reply received before the campaign was launched", async () => {
    const clock = worldClock(world, WED);
    const [anna, ben] = [address(), address()];
    const a = await launchTo(world, [anna, ben], { now: clock.now(), sameCompany: true });
    // Ben wrote a day before the launch; the event lane hasn't processed it yet.
    await storeReply({ fromEmail: ben, receivedAt: new Date(WED.getTime() - 86_400_000) });
    expect(await heldAddresses(clock.now(), [a.campaignId])).toEqual({ pending: [anna, ben].sort(), possible: [] });
  });

  it("a reply to the reply test from the test mailbox holds nothing; the same thread from a prospect holds them", async () => {
    const clock = worldClock(world, WED);
    const mailbox = address();
    const test = await launchTo(world, [mailbox], { now: clock.now() });
    await dbWrite((c) =>
      c.testSend.create({
        data: { userId: world.owner.id, to: mailbox, subject: "Reply test", mode: "LIVE", purpose: "REPLY_TEST", messageId: "pp.replytest9@send.example.com" },
      }),
    );
    await storeReply({ fromEmail: mailbox, inReplyTo: "pp.replytest9@send.example.com" });
    expect(await heldAddresses(clock.now(), [test.campaignId])).toEqual({ pending: [], possible: [] });
    // A prospect answering a test email someone forwarded to them: it counts, for them and their company.
    const { company, people } = await makeCompany({ name: "Forwarded To", people: [{ name: "Pia", email: "pia@forwarded-to.de" }] });
    await storeReply({ fromEmail: "pia@forwarded-to.de", inReplyTo: "pp.replytest9@send.example.com" });
    const cands = [
      { id: -1, campaignId: test.campaignId, recipientId: -1, companyId: company.id, toNorm: "colleague@forwarded-to.de", mode: "LIVE" as const, step: 0 },
      { id: -2, campaignId: test.campaignId, recipientId: -2, companyId: null, toNorm: people[0]!.emailNorm!, mode: "LIVE" as const, step: 0 },
    ];
    const problems = await gates.pendingProblemIds(cands);
    expect([...problems.pending].sort((x, y) => x - y)).toEqual([-2, -1]);
  });

  it("our own team writing (a user, a sending address, anything on our sending domain) holds nothing", async () => {
    const clock = worldClock(world, WED);
    const anna = address();
    const a = await launchTo(world, [anna], { now: clock.now() });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: a.campaignId } });
    // Ali forwards something about Anna to our address, quoting our email.
    await storeReply({ fromEmail: "ali@polygonparadise.test", references: row.messageId });
    await storeReply({ fromEmail: world.senderAddress, references: row.messageId });
    await storeReply({ fromEmail: `someone@${world.mg.domain}`, references: row.messageId });
    expect(await heldAddresses(clock.now(), [a.campaignId])).toEqual({ pending: [], possible: [] });
  });

  it("one of our addresses answering the email that went to it holds it like any reply; forwarding another's holds nothing (REPLY-01)", async () => {
    const clock = worldClock(world, WED);
    const [mailbox, anna] = [address(), address()];
    // A test-list mailbox that is also a teammate's login email.
    await dbWrite((c) => c.user.create({ data: { email: mailbox, name: "Mailbox Owner" } }));
    const a = await launchTo(world, [mailbox], { now: clock.now() });
    const b = await launchTo(world, [anna], { now: clock.now() });
    const toMailbox = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: a.campaignId } });
    const toAnna = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: b.campaignId } });
    // The same person forwarding something about Anna, quoting our email to her: still internal, holds nothing.
    await storeReply({ fromEmail: mailbox, references: toAnna.messageId });
    expect(await heldAddresses(clock.now(), [a.campaignId, b.campaignId])).toEqual({ pending: [], possible: [] });
    // The mailbox answering the email it got: a reply, as the processor files it, so it holds its own address.
    await storeReply({ fromEmail: mailbox, references: toMailbox.messageId });
    expect(await heldAddresses(clock.now(), [a.campaignId, b.campaignId])).toEqual({ pending: [mailbox], possible: [] });
  });

  it("a simulated reply (dry-run outbox) never holds a live email, but holds a dry run's", async () => {
    const clock = worldClock(world, WED);
    const [liveTo, dryTo] = [address(), address()];
    const live = await launchTo(world, [liveTo], { now: clock.now() });
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await launchTo(world, [dryTo], { now: clock.now(), ignoreWindow: false });
    await storeReply({ fromEmail: liveTo, source: "SIMULATED" });
    await storeReply({ fromEmail: dryTo, source: "SIMULATED" });
    expect(await heldAddresses(clock.now(), [live.campaignId, dry.campaignId])).toEqual({ pending: [dryTo], possible: [] });
  });
});

describe("possible replies nobody has decided (§2.5.1 step 3, §2.8.2)", () => {
  async function undecided(companyId: number, over: Record<string, unknown> = {}) {
    return dbWrite((c) =>
      c.inboundMessage.create({
        data: {
          receivedAt: WED,
          toAddress: world.senderAddress,
          fromEmail: "maybe@somewhere-else.de",
          subject: "Automatic reply?",
          source: "NOTIFY",
          kind: "POSSIBLE_REPLY",
          companyId,
          replyScope: "real",
          processedAt: WED,
          ...over,
        },
      }),
    );
  }

  it("a campaign launched while a possible reply is undecided: held at launch, with the reason", async () => {
    const clock = worldClock(world, WED);
    const { company } = await makeCompany({ name: "Undecided Co", people: [{ name: "Una", email: "una@undecided-co.de" }] });
    await undecided(company.id);
    await setSettingValue("sending.testList", [...LIST, "una@undecided-co.de"]);
    const c = await launchTo(world, ["una@undecided-co.de"], { now: clock.now() });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: c.campaignId } })).toMatchObject({
      state: "HELD",
      holdReason: "possible-reply",
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
  });

  it("a recipient the hold missed waits ('possible-reply'), and the maintenance puts them on hold", async () => {
    const clock = worldClock(world, WED);
    const to = address();
    const c = await launchTo(world, [to], { now: clock.now() });
    // Processed after the launch but before its hold reached this recipient (a race).
    await undecided(c.companyIds[0]!);
    expect(await heldAddresses(clock.now(), [c.campaignId])).toEqual({ pending: [], possible: [to] });
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 0, waiting: { reason: "possible-reply" } });
    const m = await loop.runSendingMaintenance(clock.now());
    expect(m.possibleReplyHeld).toBe(1);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: c.campaignId } })).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
  });

  it("a campaign-scope possible reply (a dry run's simulated one) holds only its own campaign", async () => {
    const clock = worldClock(world, WED);
    const to = address();
    const first = await launchTo(world, [to], { now: clock.now() });
    await undecided(first.companyIds[0]!, { replyScope: "campaign", campaignId: 999_999 });
    expect(await heldAddresses(clock.now(), [first.campaignId])).toEqual({ pending: [], possible: [] });
    await undecided(first.companyIds[0]!, { replyScope: "campaign", campaignId: first.campaignId });
    expect(await heldAddresses(clock.now(), [first.campaignId])).toEqual({ pending: [], possible: [to] });
  });
});

describe("just before the hand-over", () => {
  it("a reply stored after the pick and before the hand-over sends nothing to Mailgun", async () => {
    const clock = worldClock(world, WED);
    const to = address();
    const { campaignId } = await launchTo(world, [to], { now: clock.now() });
    const render = async () => {
      // The webhook stores Anna's reply while her email is being prepared.
      await storeReply({ fromEmail: to });
      return { subject: "Hello", text: "Hi\n\n%unsubscribe_url%", html: "<p>Hi</p>", warnings: [] };
    };
    const r = await loop.sendingTick(tickDeps(world, clock, { render }));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    // The next tick's pick holds it too, until the reply is processed.
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "pending-events" } });
  });
});
