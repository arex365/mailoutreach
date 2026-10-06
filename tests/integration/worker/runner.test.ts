import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-runner");
const { db, dbWrite } = await import("@/server/db");
const { enqueueJob, toPublicJob } = await import("@/server/jobs");
const { claimNextJob, runClaimedJob, resetOrphanedJobs, JobRunner, StopRequestedError } = await import(
  "../../../worker/runner"
);
type JobRegistry = import("../../../worker/jobs/types").JobRegistry;

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let ownerId = 0;

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { email: "owner@example.com", name: "Arslan", role: "OWNER" } }));
  ownerId = owner.id;
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

function registry(handler: JobRegistry[string]["handler"], extra: Partial<JobRegistry[string]> = {}): JobRegistry {
  return {
    "backup.run": { handler, label: "The backup", whatToDo: "Check free disk space.", link: "/settings/backups", ...extra },
  };
}

async function claimAndRun(reg: JobRegistry, signal = new AbortController().signal) {
  const claimed = await claimNextJob("w1");
  expect(claimed).not.toBeNull();
  return { claimed: claimed!, result: await runClaimedJob(claimed!, { workerId: "w1", registry: reg, signal, logger: quiet }) };
}

describe("claiming", () => {
  it("claims by priority, then run time, then id, and skips jobs that aren't due", async () => {
    const low = await enqueueJob({ type: "system.cleanup", runAt: past() });
    const high = await enqueueJob({ type: "backup.run", priority: 5, runAt: past() });
    await enqueueJob({ type: "backup.run", priority: 9, runAt: new Date(Date.now() + 60_000) });

    const first = await claimNextJob("w1");
    expect(first?.id).toBe(high.id);
    expect(first).toMatchObject({ status: "RUNNING", lockedBy: "w1", attempts: 1 });
    expect(first?.startedAt).toBeInstanceOf(Date);
    expect(first?.lockedAt).toBeInstanceOf(Date);

    expect((await claimNextJob("w1"))?.id).toBe(low.id);
    expect(await claimNextJob("w1")).toBeNull();
  });

  it("never lets two workers claim the same job", async () => {
    await enqueueJob({ type: "backup.run", runAt: past() });
    const [a, b] = await Promise.all([claimNextJob("w1"), claimNextJob("w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("running", () => {
  it("marks a successful job DONE, stores the result and frees the dedupe key", async () => {
    const queued = await enqueueJob({ type: "backup.run", dedupeKey: "backup:manual", runAt: past() });
    expect((await enqueueJob({ type: "backup.run", dedupeKey: "backup:manual" })).id).toBe(queued.id);

    const { result } = await claimAndRun(registry(async () => ({ summary: "Backup saved (1 MB).", size: 1 })));
    expect(result.outcome).toBe("done");

    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "DONE", activeDedupeKey: null, lockedBy: null, lockedAt: null, error: null });
    expect(row.result).toEqual({ summary: "Backup saved (1 MB).", size: 1 });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(toPublicJob(row).summary).toBe("Backup saved (1 MB).");

    // The same key can be used again once the job has finished.
    const again = await enqueueJob({ type: "backup.run", dedupeKey: "backup:manual" });
    expect(again.id).not.toBe(queued.id);
  });

  it("queues a failed job again in 1 minute, then 5 minutes, with the error redacted", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past(), maxAttempts: 3 });
    const failing = registry(async () => {
      throw new Error("Disk busy, password=hunter2hunter2");
    });

    const before = Date.now();
    const { result } = await claimAndRun(failing);
    expect(result.outcome).toBe("retry");
    let row = await job(queued.id);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, lockedBy: null, lockedAt: null });
    expect(row.error).toContain("password: [hidden]");
    expect(row.error).not.toContain("hunter2");
    expect(row.runAt.getTime() - before).toBeGreaterThanOrEqual(59_000);
    expect(row.runAt.getTime() - before).toBeLessThan(65_000);
    expect(toPublicJob(row).error).toBeNull(); // not failed yet: the browser sees no error

    await dbWrite((c) => c.job.update({ where: { id: queued.id }, data: { runAt: past() } }));
    const before2 = Date.now();
    await claimAndRun(failing);
    row = await job(queued.id);
    expect(row.attempts).toBe(2);
    expect(row.runAt.getTime() - before2).toBeGreaterThanOrEqual(299_000);
    expect(row.runAt.getTime() - before2).toBeLessThan(305_000);
  });

  it("fails for good after the last try, frees the dedupe key and tells the Owner", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past(), maxAttempts: 1, dedupeKey: "k" });
    const { result } = await claimAndRun(
      registry(async () => {
        throw new Error("The disk is full.");
      }),
    );
    expect(result.outcome).toBe("failed");
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "FAILED", activeDedupeKey: null, error: "The disk is full." });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(toPublicJob(row).error).toBe("The disk is full.");

    const notes = await db.notification.findMany({ where: { userId: ownerId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "task.failed", title: "A background task failed", link: "/settings/backups" });
    expect(notes[0]!.body).toBe("The backup didn't finish: The disk is full. Check free disk space.");
  });

  it("shows a plain sentence for a technical error and keeps the raw text for Details", async () => {
    class FakePrismaError extends Error {
      code = "P2034";
      constructor() {
        super("Invalid `prisma.importRow.updateMany()` invocation: SQLITE_BUSY: database is locked, token=abcdef123456");
        this.name = "PrismaClientKnownRequestError";
      }
    }
    const queued = await enqueueJob({ type: "backup.run", runAt: past(), maxAttempts: 1 });
    const { result } = await claimAndRun(
      registry(async () => {
        throw new FakePrismaError();
      }),
    );
    expect(result.outcome).toBe("failed");
    const row = await job(queued.id);
    expect(row.error).toBe("Something unexpected went wrong.");
    const pub = toPublicJob(row);
    expect(pub.error).toBe("Something unexpected went wrong.");
    expect(pub.errorDetail).toContain("PrismaClientKnownRequestError (P2034): Invalid `prisma.importRow.updateMany()` invocation");
    expect(pub.errorDetail).toContain("token: [hidden]");
    expect(pub.errorDetail).not.toContain("abcdef123456");
    const note = await db.notification.findFirstOrThrow({ where: { userId: ownerId } });
    expect(note.body).toBe("The backup didn't finish: Something unexpected went wrong. Check free disk space.");
    expect(note.body).not.toContain("prisma");
  });

  it("keeps a plain error's sentence, with its technical detail behind Details", async () => {
    const { PlainJobError } = await import("@/server/jobs");
    const queued = await enqueueJob({ type: "backup.run", runAt: past(), maxAttempts: 1 });
    await claimAndRun(
      registry(async () => {
        throw new PlainJobError("Couldn't write the backup file. Check that the disk isn't full.", "ENOSPC: no space left on device");
      }),
    );
    const pub = toPublicJob(await job(queued.id));
    expect(pub.error).toBe("Couldn't write the backup file. Check that the disk isn't full.");
    expect(pub.errorDetail).toBe("ENOSPC: no space left on device");
  });

  it("treats TypeErrors and system errors as unexpected, while retrying", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past(), maxAttempts: 3 });
    const { result } = await claimAndRun(
      registry(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'id')");
      }),
    );
    expect(result).toMatchObject({ outcome: "retry", error: "Something unexpected went wrong." });
    expect(result.detail).toBe("TypeError: Cannot read properties of undefined (reading 'id')");
    const row = await job(queued.id);
    expect(row.error).toBe("Something unexpected went wrong.");
    expect(toPublicJob(row).errorDetail).toBeNull(); // not failed yet
  });

  it("uses a task's own failure notice when it has one", async () => {
    await enqueueJob({ type: "backup.run", payload: { kind: "AUTO" }, runAt: past(), maxAttempts: 1 });
    await claimAndRun(
      registry(
        async () => {
          throw new Error("no space left");
        },
        { failureNotice: (_payload, error) => ({ type: "backup.failed", title: "The daily backup failed", body: `Why: ${error}` }) },
      ),
    );
    const note = await db.notification.findFirstOrThrow({ where: { userId: ownerId } });
    expect(note).toMatchObject({ type: "backup.failed", title: "The daily backup failed", body: "Why: no space left" });
  });

  it("fails an unknown task type straight away", async () => {
    // A made-up type (a newer app's task the worker doesn't know yet): enqueueJob only takes known types.
    const queued = await dbWrite((c) => c.job.create({ data: { type: "made.upTask", runAt: past(), maxAttempts: 3 } }));
    const { result } = await claimAndRun(registry(async () => ({})));
    expect(result.outcome).toBe("failed");
    const row = await job(queued.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("Unknown task type");
    expect(row.attempts).toBe(1);
    expect(await db.notification.count({ where: { userId: ownerId, title: "A background task failed" } })).toBe(1);
  });

  it("puts a job stopped by shutdown back in the queue without counting the try", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past() });
    const controller = new AbortController();
    const reg = registry(
      (_payload, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    );
    const claimed = await claimNextJob("w1");
    const running = runClaimedJob(claimed!, { workerId: "w1", registry: reg, signal: controller.signal, logger: quiet });
    controller.abort(new StopRequestedError());
    expect((await running).outcome).toBe("requeued");
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 0, lockedBy: null, lockedAt: null });
    expect(await db.notification.count()).toBe(0);
  });

  it("saves progress at most once a second and keeps the last value", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past() });
    const seen: number[] = [];
    await claimAndRun(
      registry(async (_payload, ctx) => {
        await ctx.progress(1, 50);
        seen.push((await job(queued.id)).progressDone);
        for (let i = 2; i <= 50; i++) await ctx.progress(i, 50);
        seen.push((await job(queued.id)).progressDone);
        return { summary: "ok" };
      }),
    );
    expect(seen).toEqual([1, 1]);
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "DONE", progressDone: 50, progressTotal: 50 });
  });
});

describe("start-up reset", () => {
  it("puts orphaned RUNNING jobs back in the queue", async () => {
    const queued = await enqueueJob({ type: "backup.run", dedupeKey: "backup:auto" });
    await dbWrite((c) =>
      c.job.update({
        where: { id: queued.id },
        data: { status: "RUNNING", lockedBy: "dead-worker", lockedAt: new Date(), attempts: 1 },
      }),
    );
    const reset = await resetOrphanedJobs(quiet);
    expect(reset).toEqual({ requeued: [queued.id], failed: [] });
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "QUEUED", lockedBy: null, lockedAt: null, attempts: 1, activeDedupeKey: "backup:auto" });
  });

  it("gives up on a job that stopped the worker on every try", async () => {
    const queued = await enqueueJob({ type: "backup.run", dedupeKey: "backup:auto", maxAttempts: 3 });
    await dbWrite((c) =>
      c.job.update({ where: { id: queued.id }, data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(), attempts: 3 } }),
    );
    const reset = await resetOrphanedJobs(quiet);
    expect(reset.failed).toEqual([queued.id]);
    const row = await job(queued.id);
    expect(row).toMatchObject({ status: "FAILED", activeDedupeKey: null });
    expect(await db.notification.count({ where: { userId: ownerId } })).toBe(1);
    // The worker's own registry is used: the backup's own notice, never "doesn't know how to run a task".
    const note = await db.notification.findFirstOrThrow({ where: { userId: ownerId } });
    expect(note).toMatchObject({ type: "backup.failed", title: "The backup failed" });
    expect(note.body).not.toContain("doesn't know how to run");
  });

  it("gives up with the task's own failure notice from the registry it is given (CRASH-4)", async () => {
    const queued = await enqueueJob({ type: "backup.run", payload: { kind: "AUTO" }, maxAttempts: 2 });
    await dbWrite((c) =>
      c.job.update({ where: { id: queued.id }, data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(), attempts: 2 } }),
    );
    const seen: Array<{ payload: unknown; error: string }> = [];
    const reg = registry(async () => ({}), {
      failureNotice: (payload, error) => {
        seen.push({ payload, error });
        return { type: "backup.failed", title: "Given up", body: `Why: ${error}` };
      },
    });
    expect((await resetOrphanedJobs(quiet, reg)).failed).toEqual([queued.id]);
    expect(seen).toEqual([{ payload: { kind: "AUTO" }, error: "The background sender stopped every time it ran this task." }]);
    expect(await db.notification.findFirstOrThrow({ where: { userId: ownerId } })).toMatchObject({
      type: "backup.failed",
      title: "Given up",
      body: "Why: The background sender stopped every time it ran this task.",
    });
  });

  it("an unknown task type still gets the 'run update.bat' notice", async () => {
    const queued = await dbWrite((c) => c.job.create({ data: { type: "made.upTask", maxAttempts: 1 } }));
    await dbWrite((c) =>
      c.job.update({ where: { id: queued.id }, data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(), attempts: 1 } }),
    );
    expect((await resetOrphanedJobs(quiet, registry(async () => ({})))).failed).toEqual([queued.id]);
    const note = await db.notification.findFirstOrThrow({ where: { userId: ownerId } });
    expect(note.body).toContain('doesn\'t know how to run a task called "made.upTask"');
  });

  it("an orphaned restore check that used all its tries is marked failed and pauses sending for the Owner's confirmation", async () => {
    const { setState } = await import("@/server/state");
    const { readTyped } = await import("@/server/state-typed");
    const { parsePauseState, parseRestoreState } = await import("@/core/system-state-parse");
    await setState("restore", {
      status: "scanning",
      restoredFrom: "2026-09-20T10:00:00.000Z",
      scanFrom: "2026-09-20T09:00:00.000Z",
      markerAt: "2026-09-23T08:00:00.000Z",
      file: "app-auto.db",
      handledAt: "2026-09-23T08:00:00.000Z",
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const queued = await enqueueJob({ type: "mailgun.restoreScan", payload: { pass: 1 }, dedupeKey: "mailgun:restore-scan", maxAttempts: 3 });
    await dbWrite((c) =>
      c.job.update({ where: { id: queued.id }, data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(), attempts: 3 } }),
    );
    // The default registry: the worker's own (worker/jobs), whose restore check marks the check failed.
    expect((await resetOrphanedJobs(quiet)).failed).toEqual([queued.id]);
    await vi.waitFor(async () => {
      expect((await readTyped("restore", parseRestoreState)).value).toMatchObject({
        status: "failed",
        report: { error: "The background sender stopped every time it ran this task." },
      });
      expect((await readTyped("sending.pause", parsePauseState)).value).toMatchObject({ paused: true, kind: "restore" });
    });
    const notes = await db.notification.findMany({ where: { userId: ownerId }, orderBy: { id: "asc" } });
    expect(notes.find((n) => n.type === "restore.checked")).toMatchObject({ title: "The restore check with Mailgun failed", link: "/settings/sending" });
    expect(notes.some((n) => (n.body ?? "").includes("doesn't know how to run"))).toBe(false);
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["restore", "sending.pause"] } } }));
  });
});

describe("JobRunner", () => {
  it("runs one job per tick and reports whether it ran one", async () => {
    await enqueueJob({ type: "backup.run", runAt: past() });
    const handler = vi.fn(async () => ({ summary: "done" }));
    const runner = new JobRunner({ workerId: "w1", registry: registry(handler), logger: quiet });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("doesn't claim when the lease is gone or claiming has stopped", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past() });
    const noLease = new JobRunner({
      workerId: "w1",
      registry: registry(async () => ({})),
      logger: quiet,
      ownsLease: async () => false,
    });
    expect(await noLease.tick()).toBe(false);
    const stopped = new JobRunner({ workerId: "w1", registry: registry(async () => ({})), logger: quiet });
    stopped.stopClaiming();
    expect(await stopped.tick()).toBe(false);
    expect((await job(queued.id)).status).toBe("QUEUED");
  });

  it("stops the running job on shutdown and waits for it", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past() });
    let started!: () => void;
    const isRunning = new Promise<void>((r) => (started = r));
    const runner = new JobRunner({
      workerId: "w1",
      logger: quiet,
      registry: registry(
        (_payload, ctx) =>
          new Promise((_resolve, reject) => {
            started();
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
          }),
      ),
    });
    const tick = runner.tick();
    await isRunning;
    expect(runner.busy).toBe(true);
    expect(runner.currentJobId).toBe(queued.id);
    runner.stopClaiming();
    runner.abortCurrent();
    expect(await runner.waitForIdle(2_000)).toBe(true);
    await tick;
    expect(runner.busy).toBe(false);
    expect(await job(queued.id)).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  it("reports false when the running job doesn't stop in time", async () => {
    await enqueueJob({ type: "backup.run", runAt: past() });
    let release!: () => void;
    let started!: () => void;
    const isRunning = new Promise<void>((r) => (started = r));
    const runner = new JobRunner({
      workerId: "w1",
      logger: quiet,
      registry: registry(
        () =>
          new Promise((resolve) => {
            started();
            release = () => resolve({ summary: "late" });
          }),
      ),
    });
    const tick = runner.tick();
    await isRunning;
    runner.abortCurrent();
    expect(await runner.waitForIdle(50)).toBe(false);
    release();
    await tick;
  });

  it("a task still finishing a paid call when the stop's wait is over goes back to the queue without using a try", async () => {
    // A one-try task (like "Test address checks"): its handler lets the call in flight finish instead of aborting it.
    const queued = await enqueueJob({ type: "verify.addresses", runAt: past(), maxAttempts: 1 });
    let release!: () => void;
    let started!: () => void;
    const isRunning = new Promise<void>((r) => (started = r));
    const runner = new JobRunner({
      workerId: "w1",
      logger: quiet,
      registry: {
        "verify.addresses": {
          label: "The address checks",
          whatToDo: "Start them again.",
          link: null,
          handler: () =>
            new Promise((resolve) => {
              started();
              release = () => resolve({ summary: "late" });
            }),
        },
      },
    });
    const tick = runner.tick();
    await isRunning;
    expect((await job(queued.id)).attempts).toBe(1);
    runner.stopClaiming();
    runner.abortCurrent();
    expect(await runner.waitForIdle(50)).toBe(false);
    // Handed back at once: the process may end before the call does.
    expect(await job(queued.id)).toMatchObject({ status: "QUEUED", attempts: 0, lockedBy: null });
    // The late outcome doesn't overwrite it (the task isn't this worker's any more).
    release();
    await tick;
    expect(await job(queued.id)).toMatchObject({ status: "QUEUED", attempts: 0 });
    // The next start runs it, with its one try intact.
    const again = await claimNextJob("w2", new Date());
    expect(again).toMatchObject({ id: queued.id, attempts: 1, maxAttempts: 1 });
  });

  it("a task that simply outlasts a wait nobody asked to stop keeps running (only a stop hands it back)", async () => {
    const queued = await enqueueJob({ type: "backup.run", runAt: past() });
    let release!: () => void;
    let started!: () => void;
    const isRunning = new Promise<void>((r) => (started = r));
    const runner = new JobRunner({
      workerId: "w1",
      logger: quiet,
      registry: registry(
        () =>
          new Promise((resolve) => {
            started();
            release = () => resolve({ summary: "done late" });
          }),
      ),
    });
    const tick = runner.tick();
    await isRunning;
    expect(await runner.waitForIdle(20)).toBe(false);
    expect((await job(queued.id)).status).toBe("RUNNING");
    release();
    await tick;
    expect((await job(queued.id)).status).toBe("DONE");
  });
});
