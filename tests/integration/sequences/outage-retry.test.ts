import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeDraft, setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Retry after the PC was off (M4-DESIGN §2.8.3, review finding SEQ-3): the outage hold only reaches people who were
 * open when it was applied, so a person reopened later by "Try again" (their email didn't send) isn't held. The sending
 * guard applies the hold's own rules to them until it is released: a colleague's first email waits while someone
 * emailed at the company is held; a follow-up waits while its sender hasn't checked their inbox, when its last email
 * went out before the end of the unchecked window. Retry says so. The same covers a campaign launched after the hold
 * that takes no reservation (test mode, live before go-live). The real sending loop, the local fake Mailgun and a
 * fixed clock.
 */

const t = await createTestDb("sequences-outage-retry");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const control = await import("@/server/services/campaigns/control");
const holds = await import("@/server/services/sequences/holds");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { setState } = await import("@/server/state");

const LIST = Array.from({ length: 30 }, (_, i) => `or${i}@outage-retry-${i}.de`);
/** Wednesday 10:00 in Berlin: the first emails go. */
const WED = new Date("2026-09-23T08:00:00Z");
/** The next day, 10:00 in Berlin: back after the PC was off (nobody's follow-up is due yet). */
const THU = new Date("2026-09-24T08:00:00Z");
const MIN = 60_000;
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];
/** The check with Mailgun found a gap ending after Wednesday's first emails: replies to them may have been missed. */
const OUTAGE = {
  detectedAt: THU.toISOString(),
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-09-23T10:00:00.000Z",
  beyondLogRetention: true,
  beyondMessageRetention: false,
  handledAt: null,
  heldFor: null,
  heldTo: null,
  heldCount: 0,
};

let world: M3World;
let next = 0;
const address = () => LIST[next++]!;
const sentTo = (to: string) => world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to);

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
    await c.campaignRecipient.updateMany({ where: { state: "HELD" }, data: { state: "STOPPED", stopReason: "campaign_cancelled", holdReason: null, heldAt: null } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Ali (the campaigns' sender) clicks "I've checked my inbox". */
const aliChecked = (now: Date) =>
  holds.releaseOutageHold({ id: world.member.id, name: world.member.name, role: "MEMBER" }, { senderId: world.member.id, now });

/** An email that didn't send after its last try: "Didn't send", its person stopped with "failed". */
async function didntSend(emailId: number) {
  await dbWrite(async (x) => {
    const e = await x.outboundEmail.update({ where: { id: emailId }, data: { status: "FAILED", attempts: 5, lastError: "Couldn't prepare this email" } });
    await x.campaignRecipient.update({ where: { id: e.recipientId }, data: { state: "STOPPED", stopReason: "failed", nextDueAt: null } });
  });
}

describe("Retry while a hold after the PC was off is in place", () => {
  it("a colleague's first email waits while someone emailed at the company is on hold, and goes once the sender has checked", async () => {
    const clock = worldClock(world, WED);
    const [anna, ben] = [address(), address()];
    const c = await launchTo(world, [anna, ben], { now: clock.now(), steps: STEPS, sameCompany: true });
    const benEmail = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: c.campaignId, toNorm: ben } });
    await didntSend(benEmail.id);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(sentTo(anna)).toHaveLength(1);

    // Back after the PC was off: the check found the gap and Anna (emailed before its end) is held. Ben wasn't open.
    clock.set(THU);
    await setState("catchup.outage", OUTAGE);
    expect(await holds.applyOutageHold({ now: clock.now() })).toMatchObject({ applied: true, held: 1 });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: c.campaignId, emailNorm: anna } })).toMatchObject({
      state: "HELD",
      holdReason: "outage",
    });

    const res = await control.retryEmail(benEmail.id, world.owner.id, { now: clock.now() });
    expect(res.message).toBe(`The first email to ${ben} will be tried again once the senders have checked their inbox after the PC was off.`);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: benEmail.recipientId } })).toMatchObject({ state: "SCHEDULED", holdReason: null });

    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "outage-hold" } });
    expect(sentTo(ben)).toHaveLength(0);
    expect(await gates.explainCampaignWaiting(c.campaignId, clock.now())).toEqual({ reason: "outage-hold", until: null });

    // Ali checked their inbox: nobody emailed at the company is held any more, so Ben's first email goes.
    await aliChecked(clock.now());
    clock.advance(MIN);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(sentTo(ben)).toHaveLength(1);
  });

  it("a follow-up waits while its sender hasn't checked their inbox, when its last email went out before the gap's end", async () => {
    const clock = worldClock(world, WED);
    const [anna, carl] = [address(), address()];
    const c = await launchTo(world, [anna, carl], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const annaFollowUp = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: c.campaignId, toNorm: anna, step: 1 } });
    await didntSend(annaFollowUp.id);

    // Carl (another company) is held for the outage; Anna wasn't open then.
    clock.set(THU);
    await setState("catchup.outage", OUTAGE);
    expect(await holds.applyOutageHold({ now: clock.now() })).toMatchObject({ applied: true, held: 1 });

    const res = await control.retryEmail(annaFollowUp.id, world.owner.id, { now: clock.now() });
    expect(res.message).toBe(`The follow-up 1 to ${anna} will be tried again once the senders have checked their inbox after the PC was off.`);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: annaFollowUp.recipientId } })).toMatchObject({ state: "WAITING", currentStep: 1 });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "outage-hold" } });
    expect(sentTo(anna)).toHaveLength(1);

    await aliChecked(clock.now());
    clock.advance(MIN);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(sentTo(anna)).toHaveLength(2);
  });

  it("a campaign launched after the hold (test mode: no reservation) waits at a company where someone emailed is held", async () => {
    const clock = worldClock(world, WED);
    const anna = address();
    const c = await launchTo(world, [anna], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(THU);
    await setState("catchup.outage", OUTAGE);
    expect(await holds.applyOutageHold({ now: clock.now() })).toMatchObject({ applied: true, held: 1 });

    // A colleague of Anna's, in a new test-mode campaign of the Owner's.
    const dora = address();
    const person = await dbWrite((x) => x.person.create({ data: { companyId: c.companyIds[0]!, name: "Dora", email: dora, emailNorm: dora } }));
    await setSettingValue("sending.mode", "TEST");
    const draft = await makeDraft({
      name: "After the hold",
      createdById: world.owner.id,
      senderId: world.owner.id,
      steps: STEPS,
      recipients: [{ companyId: c.companyIds[0]!, personId: person.id }],
    });
    await launchCampaign(draft.id, world.owner.id, { now: clock.now(), mailgun: world.mailgun });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "outage-hold" } });
    expect(sentTo(dora)).toHaveLength(0);

    await aliChecked(clock.now());
    clock.advance(MIN);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(sentTo(dora)).toHaveLength(1);
  });

  it("a Retry with no hold covering the person goes at once, and says so", async () => {
    const clock = worldClock(world, WED);
    const [anna, dora] = [address(), address()];
    const c = await launchTo(world, [anna, dora], { now: clock.now(), steps: STEPS });
    const doraEmail = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: c.campaignId, toNorm: dora } });
    await didntSend(doraEmail.id);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // An outage whose hold was applied and has ended (everyone held has been continued): nothing covers Dora.
    clock.set(THU);
    await setState("catchup.outage", { ...OUTAGE, handledAt: THU.toISOString(), heldFor: OUTAGE.from, heldTo: OUTAGE.to });
    const res = await control.retryEmail(doraEmail.id, world.owner.id, { now: clock.now() });
    expect(res.message).toBe(`The first email to ${dora} will be tried again in a moment.`);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(sentTo(dora)).toHaveLength(1);
  });
});
