import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * After the PC slept or hibernated (review finding SEQ-2, M4-DESIGN §2.8.3 rule 2, D7): the worker process keeps
 * running, so nothing restarts it. Before every heartbeat it looks at the wall clock; time it can't account for (more
 * than 3 minutes since the last saved heartbeat) is treated as a new start: the start time the sending loop reads moves
 * to now, so Mailgun follow-ups wait for a new check with Mailgun (replies from the time asleep may not be stored yet,
 * and an outage may need a hold), and that check is queued at once. M6-DESIGN §3.9 (L7): the same for a lease taken
 * again after it was lost. The real worker round (`tickOnce`) and lease hold, the local fake Mailgun and a fixed clock;
 * nothing reaches the network.
 */

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("worker-wake-gap");
const dir = path.join(path.dirname(created.file), `wake-gap-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "wake-gap.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");
const t = { cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };

const { db } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parsePacerState } = await import("@/core/system-state-parse");
const { STATE_KEYS } = await import("@/core/system-state");
const { createJobRegistry } = await import("../../../worker/jobs");
const { BackgroundWorker, WAKE_GAP_MS, isWallClockGap } = await import("../../../worker/main");
const { acquireLease, releaseLease } = await import("../../../worker/lease");

const LIST = ["anna@wake-gap.de", "ben@wake-gap.de"];
const WED = new Date("2026-09-23T08:00:00Z");
const MON = new Date("2026-09-28T08:00:00Z");
const MIN = 60_000;
const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

/** No network in this file (the monitor's remote-access checks). */
const noNetwork = (async () => {
  throw new TypeError("fetch failed (the test refused it)");
}) as typeof fetch;
const skipped = { handler: async () => ({ summary: "skipped in this test" }), label: "Skipped", whatToDo: "Nothing." };

type Line = { level: "info" | "warn" | "error"; message: string };

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
  await setSettingValue("sending.mode", "LIVE");
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  try {
    t.cleanup();
  } catch {
    /* an open handle on Windows: data/test is ignored anyway */
  }
});

describe("a gap in wall-clock time counts as a new start", () => {
  it("only more than 3 minutes since the last saved heartbeat (and never before the first one)", () => {
    expect(WAKE_GAP_MS).toBe(3 * MIN);
    const last = Date.parse("2026-09-28T08:00:00Z");
    expect(isWallClockGap(last, last + 15_000)).toBe(false);
    expect(isWallClockGap(last, last + WAKE_GAP_MS)).toBe(false);
    expect(isWallClockGap(last, last + WAKE_GAP_MS + 1)).toBe(true);
    expect(isWallClockGap(last, last + 7 * 24 * 60 * MIN)).toBe(true);
    expect(isWallClockGap(0, last)).toBe(false);
  });

  it("after the PC slept, follow-ups wait for a new check with Mailgun, which is queued at once; then they go", async () => {
    const clock = worldClock(world, WED);
    const to = LIST[0]!;
    const { campaignId } = await launchTo(world, [to], { now: clock.now(), steps: STEPS });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    clock.set(MON);
    await clearPacer();

    const lines: Line[] = [];
    const logger = {
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: (message: string) => void lines.push({ level: "warn", message }),
      error: (message: string, err?: unknown) => void lines.push({ level: "error", message: `${message}${err ? `: ${String(err)}` : ""}` }),
    };
    // The real registry, except the tasks that would reach DNS or write backups, and a check with Mailgun that does
    // nothing (so the round below can't succeed it by itself).
    const registry = {
      ...createJobRegistry({ mailgun: world.mailgun, now: clock.now }),
      "mailgun.catchUp": skipped,
      "mailgun.checkDomain": skipped,
      "backup.run": skipped,
      "system.cleanup": skipped,
    };
    const worker = new BackgroundWorker({ logger, mailgun: world.mailgun, registry, now: clock.now, fetchImpl: noNetwork, random: () => 0.5 });
    const internals = worker as unknown as { lastHeartbeatOk: number };
    expect(worker.startedAt.toISOString()).toBe(MON.toISOString());
    // A check with Mailgun succeeded after the start: the follow-up could go now.
    const checked = {
      lastStartedAt: MON.toISOString(),
      lastFinishedAt: MON.toISOString(),
      lastSuccessAt: MON.toISOString(),
      lastError: null,
      lastErrorKind: null,
      lastReason: "startup",
      lastSummary: null,
    };
    await setState("mailgun.catchUp", checked);

    // A heartbeat that comes on time changes nothing.
    internals.lastHeartbeatOk = Date.now() - 2 * MIN;
    expect(await worker.checkWallClock()).toBe(false);
    expect(worker.startedAt.toISOString()).toBe(MON.toISOString());
    expect(await db.job.count({ where: { type: "mailgun.catchUp" } })).toBe(0);

    // The lid was closed for 20 minutes (the process kept running): a new start.
    clock.advance(20 * MIN);
    internals.lastHeartbeatOk = Date.now() - 20 * MIN;
    expect(await worker.checkWallClock()).toBe(true);
    expect(worker.startedAt.toISOString()).toBe(clock.now().toISOString());
    const queued = await db.job.findFirstOrThrow({ where: { type: "mailgun.catchUp", status: "QUEUED" } });
    expect(queued.payload).toEqual({ reason: "startup" });
    expect(lines).toContainEqual({
      level: "warn",
      message: "No heartbeat for 20 minutes (the PC was asleep, or the background sender was paused); emails through Mailgun wait for a new check with Mailgun",
    });

    // The worker's next round: the sending loop holds the same start time, so the follow-up waits for the check.
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } })).status).toBe("QUEUED");
    expect((await readTyped(STATE_KEYS.pacer, parsePacerState)).value.waiting?.reason).toBe("catch-up");
    expect(world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to)).toHaveLength(1);

    // The check with Mailgun after the wake-up succeeds: the follow-up goes in the next round.
    const catchUp = createJobRegistry({ mailgun: world.mailgun, now: clock.now })["mailgun.catchUp"]!;
    await catchUp.handler({ reason: "startup" }, { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined });
    await clearPacer();
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } })).status).toBe("SENT");
    expect(world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to)).toHaveLength(2);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

describe("a lease taken again after it was lost counts as a new start (M6-DESIGN §3.9, L7)", () => {
  it("startedAt moves to the new lease, so follow-ups wait for a check with Mailgun after it", async () => {
    const clock = worldClock(world, WED);
    const to = LIST[1]!;
    const { campaignId } = await launchTo(world, [to], { now: clock.now(), steps: STEPS });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // Monday: the follow-up is due. The check with Mailgun of the first test is from before this worker started.
    clock.set(new Date("2026-09-28T09:00:00Z"));
    await clearPacer();

    const lines: Line[] = [];
    const logger = {
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: (message: string) => void lines.push({ level: "warn", message }),
      error: (message: string, err?: unknown) => void lines.push({ level: "error", message: `${message}${err ? `: ${String(err)}` : ""}` }),
    };
    // The real registry, except the tasks that would reach DNS or write backups, and a check with Mailgun that does
    // nothing (so it can never succeed on its own here).
    const registry = {
      ...createJobRegistry({ mailgun: world.mailgun, now: clock.now }),
      "mailgun.catchUp": skipped,
      "mailgun.checkDomain": skipped,
      "backup.run": skipped,
      "system.cleanup": skipped,
    };
    const worker = new BackgroundWorker({ logger, mailgun: world.mailgun, registry, now: clock.now, fetchImpl: noNetwork, random: () => 0.5 });
    const internals = worker as unknown as { holdLease(): Promise<void>; loseLease(reason: string): void; startup(): Promise<void> };
    let startups = 0;
    const startup = internals.startup.bind(worker);
    internals.startup = async () => {
      await startup();
      startups += 1;
    };
    const catchUpJobs = () => db.job.count({ where: { type: "mailgun.catchUp" } });

    // The first lease: the start-up runs with startedAt = now.
    expect((await acquireLease(worker.id)).acquired).toBe(true);
    const firstHold = internals.holdLease();
    await vi.waitFor(() => expect(startups).toBe(1), { timeout: 15_000 });
    const firstStart = worker.startedAt.getTime();
    expect(firstStart).toBe(clock.now().getTime());
    internals.loseLease("No heartbeat saved for 45 s; stopped taking tasks until the lease is back");
    await firstHold;

    // Meanwhile a check with Mailgun succeeded (after the first start, before the gap). Then, 20 minutes later (a
    // locked database, a disk stall), the lease is taken again.
    clock.advance(MIN);
    await setState("mailgun.catchUp", {
      lastStartedAt: clock.now().toISOString(),
      lastFinishedAt: clock.now().toISOString(),
      lastSuccessAt: clock.now().toISOString(),
      lastError: null,
      lastErrorKind: null,
      lastReason: "startup",
      lastSummary: null,
    });
    clock.advance(20 * MIN);
    const checksBefore = await catchUpJobs();
    expect((await acquireLease(worker.id)).acquired).toBe(true);
    const secondHold = internals.holdLease();
    await vi.waitFor(() => expect(startups).toBe(2), { timeout: 15_000 });
    expect(worker.startedAt.toISOString()).toBe(clock.now().toISOString());
    expect(worker.startedAt.getTime()).toBeGreaterThan(firstStart);
    expect(await catchUpJobs()).toBeGreaterThan(checksBefore); // the start-up queued a new check with Mailgun
    internals.loseLease("The test is done with this lease");
    await secondHold;

    // The next round: the check from before the gap no longer opens the gate.
    await clearPacer();
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } })).status).toBe("QUEUED");
    expect((await readTyped(STATE_KEYS.pacer, parsePacerState)).value.waiting?.reason).toBe("catch-up");
    expect(world.mg.fake.messages.filter((m) => m.fields.to?.[0] === to)).toHaveLength(1);
    await releaseLease(worker.id);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });
});
