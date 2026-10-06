import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RenderedEmail } from "@/core/templates/types";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * The final check just before a follow-up is handed to Mailgun (M4-DESIGN §2.5.1, §2.8.3; review findings SEQ-1 and
 * SEQ-2):
 *  - it runs under the worker's write lock, so it never reads the event lane's half-finished transaction (a reply
 *    already marked processed whose stop isn't written yet) and the follow-up doesn't go to someone who just replied;
 *  - "touched" requires the person to be still open, so a stop the web app commits during the check skips the email;
 *  - an outage found meanwhile, a new start (the PC woke up mid-tick) or a check with Mailgun that failed meanwhile
 *    puts the email back;
 *  - follow-ups wait again while the latest check with Mailgun failed after the last success.
 * The real sending loop, the local fake Mailgun and a fixed clock.
 */

const t = await createTestDb("sequences-final-check");
const { db, dbTx, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const { stopCompany } = await import("@/server/services/mail-events/stops");
const { setState } = await import("@/server/state");
const { PrismaClient } = await import("@/generated/prisma/client");
const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
const { databaseFilePath } = await import("@/server/env");

/** The web app: its own connection to the same database. */
const web = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:" + databaseFilePath(), timeout: 5_000 }) });

const LIST = Array.from({ length: 30 }, (_, i) => `fc${i}@final-check-${i}.de`);
const WED = new Date("2026-09-23T08:00:00Z");
const MON = new Date("2026-09-28T08:00:00Z");
const MIN = 60_000;
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let world: M3World;
let next = 0;
const address = () => LIST[next++]!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  gates.clearThreadTargetCache();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", LIST);
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["catchup.outage", "mailgun.catchUp"] } } }));
});

afterAll(async () => {
  await world.mg.stop();
  await web.$disconnect();
  await db.$disconnect();
  t.cleanup();
});

const email = (text = "Hi"): RenderedEmail => ({ subject: "Re: 3D models", text: `${text}\n\n%unsubscribe_url%`, html: `<p>${text}</p>`, warnings: [] });

/** A LIVE campaign to one person whose first email went out on Wednesday; the clock is then Monday (the follow-up is due). */
async function followUpDue(clock: ReturnType<typeof worldClock>) {
  const to = address();
  const c = await launchTo(world, [to], { now: clock.now(), steps: STEPS });
  expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  clock.set(MON);
  await clearPacer();
  const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: c.campaignId } });
  return { to, ...c, recipientId: recipient.id };
}

const sentTo = (to: string) => world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to);

/** A reply the inbound webhook stored (not processed yet). */
function storeReply(fromEmail: string) {
  return dbWrite((c) =>
    c.inboundMessage.create({ data: { receivedAt: MON, toAddress: world.senderAddress, fromEmail, subject: "Re: 3D models", source: "NOTIFY" } }),
  );
}

/** Runs `hook` once, the next time the final check (or anything else) calls this delegate's method. */
function onceOn<T extends object>(delegate: T, method: keyof T & string, hook: () => Promise<void>): () => void {
  const target = delegate as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = target[method]!.bind(delegate);
  let armed = true;
  target[method] = async (...args: unknown[]) => {
    if (armed) {
      armed = false;
      await hook();
    }
    return original(...args);
  };
  return () => {
    target[method] = original;
  };
}

describe("the final check never reads the event lane's half-finished transaction (SEQ-1)", () => {
  it("a reply the lane is filing while the final check runs: the check waits for the lane, the follow-up doesn't go", async () => {
    const clock = worldClock(world, WED);
    const w = await followUpDue(clock);
    let reply: { id: number } | null = null;
    let restore: () => void = () => undefined;
    let finalCheckStarted!: () => void;
    const started = new Promise<void>((resolve) => (finalCheckStarted = resolve));
    let laneClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => (laneClaimed = resolve));
    const render = async (args: { step: number }) => {
      if (args.step === 1 && !reply) {
        // The inbound webhook stores the reply after the pick…
        reply = await storeReply(w.to);
        // …and the final check's first read lets the event lane start filing it. Without the lock the lane claims it
        // at once (processedAt) and stops the company 150 ms later; with the lock it waits until the check is done.
        restore = onceOn(db.suppression, "findUnique", async () => {
          finalCheckStarted();
          await Promise.race([claimed, sleep(400)]);
        });
      }
      return email();
    };
    try {
      const tick = loop.sendingTick(tickDeps(world, clock, { render }));
      // The hook really ran inside the final check (not after the tick was over).
      expect(await Promise.race([started.then(() => "final check"), tick.then(() => "tick over")])).toBe("final check");
      // The event lane: a separate flow of the same worker (this test's own async flow, outside the tick's lock).
      const id = reply!.id;
      const lane = dbTx(async (tx) => {
        await tx.inboundMessage.updateMany({ where: { id, processedAt: null }, data: { processedAt: clock.now() } });
        laneClaimed();
        await sleep(150);
        return stopCompany(tx, { companyId: w.companyIds[0]!, replierPersonIds: w.personIds, replierEmails: [w.to], inboundId: id, now: clock.now() });
      });
      const r = await tick;
      await lane;
      expect(r).toMatchObject({ sent: 0, held: 1 });
    } finally {
      restore();
    }
    expect(sentTo(w.to)).toHaveLength(1);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: w.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: w.campaignId, step: 1 } })).status).toBe("SKIPPED");
  });

  it("a stop the web app commits during the final check: 'touched' fails and the email is skipped, never sent", async () => {
    const clock = worldClock(world, WED);
    const w = await followUpDue(clock);
    let restore: () => void = () => undefined;
    const render = async (args: { step: number }) => {
      if (args.step === 1) {
        // While the final check reads, someone sets the company to Client in the web app (its own connection).
        restore = onceOn(db.inboundMessage, "findMany", async () => {
          await web.campaignRecipient.update({ where: { id: w.recipientId }, data: { state: "STOPPED", stopReason: "status:CLIENT", nextDueAt: null } });
        });
      }
      return email();
    };
    let r: Awaited<ReturnType<typeof loop.sendingTick>>;
    try {
      r = await loop.sendingTick(tickDeps(world, clock, { render }));
    } finally {
      restore();
    }
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(sentTo(w.to)).toHaveLength(1);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId: w.campaignId, step: 1 } })).toMatchObject({
      status: "SKIPPED",
      claimedAt: null,
    });
  });
});

describe("gates that close between the pick and the hand-over (SEQ-2)", () => {
  const outage = {
    detectedAt: MON.toISOString(),
    from: "2026-09-10T00:00:00.000Z",
    to: "2026-09-18T00:00:00.000Z",
    beyondLogRetention: true,
    beyondMessageRetention: false,
    handledAt: null,
    heldFor: null,
    heldTo: null,
    heldCount: 0,
  };

  it("an outage found meanwhile puts the follow-up back without counting a try", async () => {
    const clock = worldClock(world, WED);
    const w = await followUpDue(clock);
    const render = async (args: { step: number }) => {
      if (args.step === 1) await setState("catchup.outage", outage);
      return email();
    };
    const r = await loop.sendingTick(tickDeps(world, clock, { render }));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(sentTo(w.to)).toHaveLength(1);
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId: w.campaignId, step: 1 } })).toMatchObject({ status: "QUEUED", attempts: 0 });
    // The next tick's gates say why.
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "outage-hold" } });
  });

  it("a new start meanwhile (the PC woke up mid-tick) closes the check-with-Mailgun gate until a new check succeeds", async () => {
    const clock = worldClock(world, WED);
    const w = await followUpDue(clock);
    const startedAt = new Date(MON.getTime() - 60 * MIN);
    await setState("mailgun.catchUp", {
      lastStartedAt: new Date(MON.getTime() - 2 * MIN).toISOString(),
      lastFinishedAt: new Date(MON.getTime() - MIN).toISOString(),
      lastSuccessAt: new Date(MON.getTime() - MIN).toISOString(),
      lastError: null,
      lastErrorKind: null,
      lastReason: "hourly",
      lastSummary: null,
    });
    const render = async (args: { step: number }) => {
      // The worker's heartbeat treats a wake-up as a new start: the same Date the loop holds moves forward.
      if (args.step === 1) startedAt.setTime(MON.getTime());
      return email();
    };
    const r = await loop.sendingTick(tickDeps(world, clock, { render, startedAt }));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(sentTo(w.to)).toHaveLength(1);
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock, { startedAt }))).toMatchObject({ sent: 0, waiting: { reason: "catch-up" } });
    // A check with Mailgun after the new start: it goes.
    await setState("mailgun.catchUp", {
      lastStartedAt: MON.toISOString(),
      lastFinishedAt: MON.toISOString(),
      lastSuccessAt: MON.toISOString(),
      lastError: null,
      lastErrorKind: null,
      lastReason: "startup",
      lastSummary: null,
    });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock, { startedAt }))).sent).toBe(1);
    expect(sentTo(w.to)).toHaveLength(2);
  });

  it("follow-ups wait again while the latest check with Mailgun failed after the last success; first emails don't", async () => {
    const started = new Date(MON.getTime() - 60 * MIN);
    const failedAfterSuccess = {
      lastStartedAt: new Date(MON.getTime() - 5 * MIN).toISOString(),
      lastFinishedAt: new Date(MON.getTime() - 4 * MIN).toISOString(),
      lastSuccessAt: new Date(MON.getTime() - 30 * MIN).toISOString(),
      lastError: "Mailgun couldn't be reached",
      lastErrorKind: "network" as const,
      lastReason: "hourly" as const,
      lastSummary: null,
    };
    expect(gates.isFollowUpCatchUpReady({ connected: true, startedAt: started, catchUp: failedAfterSuccess })).toBe(false);
    expect(gates.isCatchUpReady({ connected: true, startedAt: started, now: MON, catchUp: failedAfterSuccess })).toBe(true);
    // A success after the failure opens it; a success before the start never does.
    const recovered = { ...failedAfterSuccess, lastSuccessAt: failedAfterSuccess.lastFinishedAt, lastError: null, lastErrorKind: null };
    expect(gates.isFollowUpCatchUpReady({ connected: true, startedAt: started, catchUp: recovered })).toBe(true);
    expect(gates.isFollowUpCatchUpReady({ connected: true, startedAt: new Date(MON.getTime()), catchUp: recovered })).toBe(false);

    const clock = worldClock(world, WED);
    const w = await followUpDue(clock);
    const fresh = await launchTo(world, [address()], { now: clock.now() });
    await setState("mailgun.catchUp", failedAfterSuccess);
    const r = await loop.sendingTick(tickDeps(world, clock, { startedAt: started }));
    expect(r).toMatchObject({ sent: 1, waiting: { reason: "catch-up" } });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: fresh.campaignId } })).status).toBe("SENT");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: w.campaignId, step: 1 } })).status).toBe("QUEUED");
    await setState("mailgun.catchUp", recovered);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock, { startedAt: started }))).sent).toBe(1);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: w.campaignId, step: 1 } })).status).toBe("SENT");
  });
});
