import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { launchTo, render, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "./helpers";

/**
 * The final check just before a Mailgun email is handed over (M3-DESIGN §4.3.3), and the rule that a TEST/LIVE email
 * only ever goes out through the gates: whatever changes between the re-check and the POST stops the email, and
 * nothing reaches the fake Mailgun.
 */

const t = await createTestDb("m3-final-check");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { pauseSending } = await import("@/server/services/sending/pause");

const A = "anna@final-a.de";
const B = "bea@final-b.de";
const C = "cem@final-c.de";
const D = "dora@final-d.de";
const E = "emil@final-e.de";
const F = "fina@final-f.de";

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: [A, B, C, D, E, F] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", [A, B, C, D, E, F]);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Runs one tick where `between` happens after the re-check and rendering, just before the final check. */
async function tickWith(between: (emailId: number) => Promise<void>, to: string) {
  const clock = worldClock(world);
  const { campaignId } = await launchTo(world, [to], { now: clock.now() });
  const email = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
  const r = await loop.sendingTick({
    ...tickDeps(world, clock),
    render: async (args: { recipientId: number; step: number }) => {
      await between(email.id);
      return render(args);
    },
  });
  return { r, campaignId, email: await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } }) };
}

describe("the final check before the POST", () => {
  it("an address that lands on the do-not-email list meanwhile is skipped", async () => {
    const { r, email, campaignId } = await tickWith(async () => {
      await dbWrite((c) => c.suppression.create({ data: { emailNorm: A, reason: "UNSUBSCRIBED", source: "webhook" } }));
    }, A);
    expect(r.skipped).toBe(1);
    expect(email).toMatchObject({ status: "SKIPPED", lastError: "Unsubscribed" });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("a bounce flag on the person meanwhile is skipped", async () => {
    const { email } = await tickWith(async () => {
      await dbWrite((c) => c.person.update({ where: { emailNorm: B }, data: { bouncedAt: new Date() } }));
    }, B);
    expect(email).toMatchObject({ status: "SKIPPED", lastError: "An earlier email to this address bounced" });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("'Pause all sending' meanwhile puts the email back as it was", async () => {
    const { r, email } = await tickWith(async () => {
      await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: world.owner.id });
    }, C);
    expect(r.lost).toBe(1);
    expect(email).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("an address removed from the test list meanwhile is skipped 'not on the test list'", async () => {
    const { email } = await tickWith(async () => {
      await setSettingValue("sending.testList", [A, B, C, E, F]);
    }, D);
    expect(email).toMatchObject({
      status: "SKIPPED",
      lastError: "Not on the test list (until you go live, only test-list addresses get real email)",
    });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("a row the reconciler took meanwhile is never posted", async () => {
    const { r, email } = await tickWith(async (id) => {
      await dbWrite((c) => c.outboundEmail.update({ where: { id }, data: { status: "UNKNOWN", lastError: "Checking with Mailgun whether it was sent" } }));
    }, E);
    expect(r.lost).toBe(1);
    expect(email.status).toBe("UNKNOWN");
    expect(world.mg.fake.messages).toHaveLength(0);
  });
});

describe("Mailgun emails only go through the gates", () => {
  it("sendOneEmail on a live email without the gates' pick sends nothing and puts it back", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [F], { now: clock.now() });
    const email = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(await loop.sendOneEmail(email.id, { now: clock.now, render, mailgun: world.mailgun })).toBe("not-running");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect("pickDueEmails" in loop).toBe(false);
  });
});
