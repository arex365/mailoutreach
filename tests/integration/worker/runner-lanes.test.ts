import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * Milestone 5 job runner (M5-DESIGN §8 P4, D1, D2): three lanes, DeferJob (not counted, dedupe key, progress and
 * carry kept), carry kept on a retry, ctx.cancelRequested / shouldYield / queuedAt, redaction of every saved secret and
 * of Anthropic keys, and a handler that never runs inside the write lock's context (§0.2 rule 12).
 */

const t = await createTestDb("worker-runner-lanes");
const { db, dbWrite, withWriteLock } = await import("@/server/db");
const { DeferJob, enqueueJob, requestJobCancel, toPublicJob } = await import("@/server/jobs");
const { setSecret } = await import("@/server/secrets");
const { claimNextJob, runClaimedJob, JobRunner, WORKER_LANES } = await import("../../../worker/runner");
const { BackgroundWorker } = await import("../../../worker/main");
type JobRegistry = import("../../../worker/jobs/types").JobRegistry;
type JobHandler = import("@/server/jobs").JobHandler;
type JobContext = import("@/server/jobs").JobContext;

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  await dbWrite((c) => c.user.create({ data: { email: "owner@example.com", name: "Arslan", role: "OWNER" } }));
});

beforeEach(async () => {
  await dbWrite((c) => c.job.deleteMany({}));
  await dbWrite((c) => c.notification.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const past = () => new Date(Date.now() - 1_000);
const job = (id: number) => db.job.findUniqueOrThrow({ where: { id } });

function def(handler: JobHandler) {
  return { handler, label: "The task", whatToDo: "Nothing.", link: null };
}

/** One registry for every lane's type used here. */
function registry(handlers: Partial<Record<"backup.run" | "verify.addresses" | "ai.draftLines" | "system.cleanup", JobHandler>>): JobRegistry {
  return Object.fromEntries(Object.entries(handlers).map(([type, handler]) => [type, def(handler!)]));
}

async function runOne(reg: JobRegistry, lane = WORKER_LANES.checks) {
  const claimed = await claimNextJob("w1", new Date(), lane);
  expect(claimed).not.toBeNull();
  return runClaimedJob(claimed!, { workerId: "w1", registry: reg, signal: new AbortController().signal, logger: quiet, lane });
}

describe("lanes", () => {
  it("each lane claims only its own types", async () => {
    const backup = await enqueueJob({ type: "backup.run", runAt: past(), priority: 1 });
    const checks = await enqueueJob({ type: "verify.addresses", runAt: past(), priority: 99 });
    const ai = await enqueueJob({ type: "ai.draftLines", runAt: past(), priority: 99 });
    expect((await claimNextJob("w1", new Date(), WORKER_LANES.main))?.id).toBe(backup.id);
    expect(await claimNextJob("w1", new Date(), WORKER_LANES.main)).toBeNull();
    expect((await claimNextJob("w1", new Date(), WORKER_LANES.checks))?.id).toBe(checks.id);
    expect((await claimNextJob("w1", new Date(), WORKER_LANES.ai))?.id).toBe(ai.id);
    expect(WORKER_LANES.main.exclude).toEqual(["verify.addresses", "ai.draftLines"]);
  });

  it("run side by side: a slow check run doesn't delay a main-lane task", async () => {
    await enqueueJob({ type: "verify.addresses", runAt: past() });
    const quick = await enqueueJob({ type: "backup.run", runAt: past() });
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const reg = registry({
      "verify.addresses": async () => {
        started();
        await new Promise<void>((r) => (release = r));
        return { summary: "checked" };
      },
      "backup.run": async () => ({ summary: "backed up" }),
    });
    const checksRunner = new JobRunner({ workerId: "w1", registry: reg, logger: quiet, lane: WORKER_LANES.checks });
    const mainRunner = new JobRunner({ workerId: "w1", registry: reg, logger: quiet, lane: WORKER_LANES.main });
    const checksTick = checksRunner.tick();
    await running;
    expect(checksRunner.busy).toBe(true);
    expect(await mainRunner.tick()).toBe(true);
    expect((await job(quick.id)).status).toBe("DONE");
    expect(checksRunner.laneName).toBe("checks");
    release();
    await checksTick;
    expect(await db.job.count({ where: { status: "DONE" } })).toBe(2);
  });

  it("the worker's round runs every lane until it is idle", async () => {
    const ran: string[] = [];
    const reg = registry({
      "backup.run": async () => (ran.push("main"), { summary: "ok" }),
      "verify.addresses": async () => (ran.push("checks"), { summary: "ok" }),
      "ai.draftLines": async () => (ran.push("ai"), { summary: "ok" }),
    });
    await enqueueJob({ type: "ai.draftLines", runAt: past() });
    await enqueueJob({ type: "verify.addresses", runAt: past() });
    await enqueueJob({ type: "verify.addresses", runAt: past() });
    await enqueueJob({ type: "backup.run", runAt: past() });
    const noNetwork = (async () => {
      throw new TypeError("fetch failed (no network in this test)");
    }) as typeof fetch;
    const worker = new BackgroundWorker({
      logger: quiet,
      registry: reg,
      fetchImpl: noNetwork,
      mailgun: async () => ({ connected: false, reason: "no-domain", text: "Mailgun isn't connected yet." }),
    });
    expect(await worker.tickOnce()).toBe(0);
    expect(ran).toEqual(["main", "checks", "checks", "ai"]);
    expect(await db.job.count({ where: { status: { not: "DONE" } } })).toBe(0);
  });
});

describe("DeferJob", () => {
  it("puts the job back until runAt without counting the try; dedupe key, progress and carry are kept", async () => {
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), dedupeKey: "verify:campaign:7", maxAttempts: 3 });
    const until = new Date(Date.now() + 3_600_000);
    const res = await runOne(
      registry({
        "verify.addresses": async (_payload, ctx) => {
          expect(ctx.carry).toBeNull();
          expect(ctx.defers).toBe(0);
          await ctx.progress(12, 40);
          throw new DeferJob(until, "paused", { carry: { cursor: 12, pending: [5] }, summary: "Paused: Mailgun didn't accept the key." });
        },
      }),
    );
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused", summary: "Paused: Mailgun didn't accept the key." });
    expect(res.deferredUntil?.getTime()).toBe(until.getTime());
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 0, activeDedupeKey: "verify:campaign:7", lockedBy: null, progressDone: 12, progressTotal: 40 });
    expect(row.runAt.getTime()).toBe(until.getTime());
    expect(row.result).toEqual({ carry: { cursor: 12, pending: [5] }, summary: "Paused: Mailgun didn't accept the key.", deferred: "paused", defers: 1 });
    // The dedupe key still points at it, and the progress screens see "Waiting".
    expect((await enqueueJob({ type: "verify.addresses", dedupeKey: "verify:campaign:7" })).id).toBe(queued.id);
    const pub = toPublicJob(row);
    expect(pub).toMatchObject({ status: "QUEUED", summary: "Paused: Mailgun didn't accept the key.", waitingUntil: until.toISOString(), error: null });
  });

  it("the next run gets the carry; a defer without a carry keeps the one it started with", async () => {
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), maxAttempts: 1 });
    const seen: Array<{ carry: unknown; defers: number | undefined }> = [];
    const reg = registry({
      "verify.addresses": async (_payload, ctx: JobContext) => {
        seen.push({ carry: ctx.carry, defers: ctx.defers });
        if (seen.length === 1) throw new DeferJob(new Date(), "yield", { carry: { cursor: 3 } });
        if (seen.length === 2) throw new DeferJob(new Date(), "rate-limited");
        return { summary: "done", carry: ctx.carry as { cursor: number } };
      },
    });
    for (let i = 0; i < 3; i++) await runOne(reg);
    expect(seen).toEqual([
      { carry: null, defers: 0 },
      { carry: { cursor: 3 }, defers: 1 },
      { carry: { cursor: 3 }, defers: 2 },
    ]);
    // Three runs with maxAttempts 1: deferrals never used up the one try.
    expect(await job(queued.id)).toMatchObject({ status: "DONE", attempts: 1 });
  });

  it("a normal retry keeps the carry (and the deferral count) next to the error", async () => {
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), maxAttempts: 3 });
    const seen: unknown[] = [];
    const reg = registry({
      "verify.addresses": async (_payload, ctx) => {
        seen.push(ctx.carry);
        if (seen.length === 1) throw new DeferJob(new Date(), "yield", { carry: { cursor: 9 } });
        if (seen.length === 2) throw new Error("The database was busy.");
        return { summary: "done" };
      },
    });
    await runOne(reg);
    expect((await runOne(reg)).outcome).toBe("retry");
    let row = await job(queued.id);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, error: "The database was busy." });
    expect(row.result).toMatchObject({ carry: { cursor: 9 }, defers: 1 });
    await dbWrite((c) => c.job.update({ where: { id: queued.id }, data: { runAt: past() } }));
    await runOne(reg);
    expect(seen).toEqual([null, { cursor: 9 }, { cursor: 9 }]);
    row = await job(queued.id);
    expect(row.status).toBe("DONE");
  });
});

describe("context", () => {
  it("queuedAt is when the job was queued; cancelRequested turns true once someone clicks Stop", async () => {
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past() });
    const before: boolean[] = [];
    const after: boolean[] = [];
    await runOne(
      registry({
        "verify.addresses": async (_payload, ctx) => {
          expect(ctx.queuedAt?.getTime()).toBe(queued.createdAt.getTime());
          before.push((await ctx.cancelRequested?.()) ?? false);
          expect(await requestJobCancel(ctx.jobId, { type: "verify.addresses" })).toBe("requested");
          after.push((await ctx.cancelRequested?.()) ?? false);
          return { summary: "Stopped after 0 of 0 addresses." };
        },
      }),
    );
    expect(before).toEqual([false]);
    expect(after).toEqual([true]);
    expect((await job(queued.id)).status).toBe("DONE");
  });

  it("shouldYield: a more urgent due job of the same lane only", async () => {
    await enqueueJob({ type: "verify.addresses", runAt: past(), priority: 10 });
    const answers: boolean[] = [];
    await runOne(
      registry({
        "verify.addresses": async (_payload, ctx) => {
          answers.push((await ctx.shouldYield?.()) ?? false);
          // Another lane's urgent job, a lower one of this lane, and a higher one that isn't due yet: no.
          await enqueueJob({ type: "backup.run", runAt: past(), priority: 99 });
          await enqueueJob({ type: "verify.addresses", runAt: past(), priority: 5 });
          await enqueueJob({ type: "verify.addresses", runAt: new Date(Date.now() + 60_000), priority: 30 });
          answers.push((await ctx.shouldYield?.()) ?? false);
          // A panel check (priority 25) waits: yes.
          await enqueueJob({ type: "verify.addresses", runAt: past(), priority: 25 });
          answers.push((await ctx.shouldYield?.()) ?? false);
          return { summary: "ok" };
        },
      }),
    );
    expect(answers).toEqual([false, false, true]);
  });

  it("a handler never runs inside the write lock's context (a pool started there would skip the lock)", async () => {
    await enqueueJob({ type: "verify.addresses", runAt: past() });
    let seenInside: boolean | null = null;
    await runOne(
      registry({
        "verify.addresses": async () => {
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          let entered = false;
          // In a clean context, the second one queues behind the first; inside the lock's context both would run at once.
          const holder = withWriteLock(() => gate);
          const inner = withWriteLock(async () => {
            entered = true;
          });
          await new Promise((r) => setTimeout(r, 30));
          seenInside = entered;
          release();
          await holder;
          await inner;
          return { summary: "ok" };
        },
      }),
    );
    expect(seenInside).toBe(false);
  });
});

describe("redaction", () => {
  it("hides every saved secret (the address check key and its Basic form) and any Anthropic key in a job's error", async () => {
    await setSecret("verification.apiKey", "key-fake-verify-123456", null);
    const basic = Buffer.from("api:key-fake-verify-123456").toString("base64");
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), maxAttempts: 1 });
    await runOne(
      registry({
        "verify.addresses": async () => {
          throw new Error(`Mailgun refused key-fake-verify-123456 (Basic ${basic}) and Claude refused sk-ant-api03-abcdefghijklmnopq.`);
        },
      }),
    );
    const row = await job(queued.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("[hidden]");
    for (const secret of ["key-fake-verify-123456", basic, "sk-ant-api03-abcdefghijklmnopq"]) {
      expect(row.error).not.toContain(secret);
      expect(JSON.stringify(row.result)).not.toContain(secret);
    }
    const note = await db.notification.findFirstOrThrow({ where: { type: "task.failed" } });
    expect(note.body).not.toContain("key-fake-verify-123456");
  });

  it("hides them in the technical text behind Details too", async () => {
    await setSecret("verification.apiKey", "key-fake-verify-123456", null);
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), maxAttempts: 1 });
    await runOne(
      registry({
        "verify.addresses": async () => {
          throw new TypeError("Cannot read properties of undefined (key-fake-verify-123456, sk-ant-admin01-zyxwvutsrqponm)");
        },
      }),
    );
    const pub = toPublicJob(await job(queued.id));
    expect(pub.error).toBe("Something unexpected went wrong.");
    expect(pub.errorDetail).toContain("[hidden]");
    expect(pub.errorDetail).not.toContain("key-fake-verify-123456");
    expect(pub.errorDetail).not.toContain("sk-ant-admin01");
  });
});
