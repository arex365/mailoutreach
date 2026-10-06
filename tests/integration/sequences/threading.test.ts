import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Follow-ups in the same thread, as Mailgun receives them (SPEC "threading headers", M4-DESIGN §2.2, §2.3): the real
 * sending loop and the real renderer against the local fake Mailgun. Step 1 and step 2 carry h:In-Reply-To and
 * h:References with angle brackets, oldest first; the subject is "Re: " + the first subject exactly as this person got
 * it (their own when it was edited for them), never "Re: Re:"; after Mailgun rewrote our Message-ID, the next step
 * replies to Mailgun's id and References carries both.
 */

const t = await createTestDb("sequences-threading");
const { db } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { editUnsentEmail } = await import("@/server/services/campaigns/control");

const LIST = ["t1@thread-1.de", "t2@thread-2.de", "t3@thread-3.de", "t4@thread-4.de"];
const [A, B, C, D] = LIST as [string, string, string, string];
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "Hi, we make 3D models." },
  { step: 1, body: "Just following up.", delayDays: 3 },
  { step: 2, body: "One last note.", delayDays: 4 },
];
/** Wednesday 23 Sep 2026, 10:00 Berlin. */
const WED = new Date("2026-09-23T08:00:00Z");
/** Monday 28 Sep 09:00 Berlin: follow-up 1 is due (Wed + 3 days = Saturday → Monday's window start). */
const MON = new Date("2026-09-28T07:00:00Z");
/** Friday 2 Oct 09:00 Berlin: follow-up 2 is due (Mon + 4 days). */
const FRI = new Date("2026-10-02T07:00:00Z");

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** One tick with the real renderer (not the test stub), after forgetting the pacer's gap. */
async function tick(clock: ReturnType<typeof worldClock>) {
  await clearPacer();
  return loop.sendingTick(tickDeps(world, clock, { render: undefined }));
}

function sentTo(address: string) {
  return world.mg.fake.messages.filter((m) => m.fields.to?.[0] === address);
}

describe("follow-ups in the same thread", () => {
  it("step 1 and step 2 thread to the emails before them, with 'Re: <first subject>' and never 'Re: Re:'", async () => {
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [A], { now: clock.now(), steps: STEPS });
    expect((await tick(clock)).sent).toBe(1);
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
    expect(first.subject).toBe("3D models for your shop");

    clock.set(MON);
    expect((await tick(clock)).sent).toBe(1);
    const second = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } });
    clock.set(FRI);
    expect((await tick(clock)).sent).toBe(1);

    const [m0, m1, m2] = sentTo(A);
    expect(m0!.fields["h:In-Reply-To"]).toBeUndefined();
    expect(m1!.fields["h:In-Reply-To"]).toEqual([`<${first.messageId}>`]);
    expect(m1!.fields["h:References"]).toEqual([`<${first.messageId}>`]);
    expect(m1!.fields.subject).toEqual(["Re: 3D models for your shop"]);
    expect(m2!.fields["h:In-Reply-To"]).toEqual([`<${second.messageId}>`]);
    expect(m2!.fields["h:References"]).toEqual([`<${first.messageId}> <${second.messageId}>`]);
    expect(m2!.fields.subject).toEqual(["Re: 3D models for your shop"]);
    // Each email has its own Message-ID on the same domain.
    expect(new Set([m0, m1, m2].map((m) => m!.fields["h:Message-Id"]?.[0])).size).toBe(3);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });

  it("uses the first subject as this person got it: their own, edited for them", async () => {
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [B], { now: clock.now(), steps: STEPS });
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    await editUnsentEmail(recipient.id, 0, { subject: "A shop idea for Anna", body: "Hi Anna, we make 3D models." }, world.owner.id, { now: clock.now() });
    expect((await tick(clock)).sent).toBe(1);
    clock.set(MON);
    expect((await tick(clock)).sent).toBe(1);
    expect(sentTo(B).map((m) => m.fields.subject?.[0])).toEqual(["A shop idea for Anna", "Re: A shop idea for Anna"]);
  });

  it("a first subject that already reads 'Re: …' from an old draft gets no second 'Re:'", async () => {
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [C], { now: clock.now(), steps: STEPS });
    expect((await tick(clock)).sent).toBe(1);
    // As stored by an older version (the launch now refuses such subjects).
    await (await import("@/server/db")).dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId, step: 0 }, data: { subject: "Re: Our call" } }));
    clock.set(MON);
    expect((await tick(clock)).sent).toBe(1);
    expect(sentTo(C).at(-1)!.fields.subject).toEqual(["Re: Our call"]);
  });

  it("after Mailgun rewrote our Message-ID, the next step replies to Mailgun's id and References carries both", async () => {
    world.mg.fake.setSwitches({ rewriteMessageId: true });
    const clock = worldClock(world, WED);
    const { campaignId } = await launchTo(world, [D], { now: clock.now(), steps: STEPS });
    expect((await tick(clock)).sent).toBe(1);
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
    expect(first.providerId).not.toBe(first.messageId);
    const theirs = first.providerId!;
    const step1 = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } });
    expect(step1).toMatchObject({ inReplyTo: theirs, references: `${first.messageId} ${theirs}` });
    clock.set(MON);
    expect((await tick(clock)).sent).toBe(1);
    const m1 = sentTo(D).at(-1)!;
    expect(m1.fields["h:In-Reply-To"]).toEqual([`<${theirs}>`]);
    expect(m1.fields["h:References"]).toEqual([`<${first.messageId}> <${theirs}>`]);
  });
});
