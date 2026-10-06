import type { Job, Prisma } from "@/generated/prisma/client";
import { db, dbWrite } from "@/server/db";
import {
  AI_LANE_TYPES,
  CHECKS_LANE_TYPES,
  describeJobError,
  isDeferJob,
  setJobProgress,
  type DeferJob,
  type JobContext,
} from "@/server/jobs";
import { allSecretValues } from "@/server/secret-values";
import { canRetry, nextRetryAt } from "./backoff";
import type { FailureNotice, JobDefinition, JobRegistry } from "./jobs/types";
import { log as defaultLog, type Logger } from "./log";
import { notifyOwner } from "./notify";

/**
 * The job runner (PLAN.md B8): every 2 s it claims the next due QUEUED job with a compare-and-set
 * update and runs its handler. Each runner runs one job at a time; from Milestone 5 the worker has three runners, one
 * per lane (M5-DESIGN §0.3 "Lane", D1): `main` (every type except the two long ones), `checks` (verify.addresses) and
 * `ai` (ai.draftLines), so a long check or drafting run never delays the catch-up, "Send me a test" or a backup.
 *
 *  success          → DONE (result, finishedAt, dedupe key released)
 *  error, tries left → QUEUED again in 1 / 5 / 15 minutes, with the (redacted) error; `result.carry` kept
 *  error, no tries   → FAILED (dedupe key released) + a notification to the Owner
 *  DeferJob          → QUEUED again until its `runAt`, the try not counted, dedupe key, progress and `carry` kept
 *                      (M5-DESIGN D2: a yield to a more urgent job, a pause, a rate limit, a retry later)
 *  stopped by shutdown or lease loss → QUEUED again, and the attempt doesn't count (also a job still finishing a paid
 *                      call when the shutdown's wait is over: `waitForIdle` hands it back)
 *
 * job.error is always a plain sentence people can read (errors not written for people become
 * "Something unexpected went wrong."); the redacted technical text is kept in job.result.errorDetail
 * for a "Details" disclosure and the worker log. Redaction hides every saved secret (`allSecretValues`) and anything
 * shaped like a key.
 */

export const RUNNER_INTERVAL_MS = 2_000;
/** ctx.progress() writes to the database at most this often. */
export const PROGRESS_MIN_INTERVAL_MS = 1_000;

export type JobOutcome = "done" | "retry" | "failed" | "deferred" | "requeued" | "lost";

/**
 * Which job types a runner takes: `include` (only these) and/or `exclude` (every type but these). No lane, or one with
 * neither list, takes every type.
 */
export type RunnerLane = { name: string; include?: readonly string[]; exclude?: readonly string[] };

/** The worker's three lanes (M5-DESIGN §0.3, D1). */
export const WORKER_LANES = {
  main: { name: "main", exclude: [...CHECKS_LANE_TYPES, ...AI_LANE_TYPES] },
  checks: { name: "checks", include: CHECKS_LANE_TYPES },
  ai: { name: "ai", include: AI_LANE_TYPES },
} as const satisfies Record<string, RunnerLane>;

/** The `where` part that limits a job query to a lane's types. */
function laneWhere(lane: Pick<RunnerLane, "include" | "exclude"> | undefined): Prisma.JobWhereInput {
  if (!lane) return {};
  const parts: Prisma.JobWhereInput[] = [];
  if (lane.include) parts.push({ type: { in: [...lane.include] } });
  if (lane.exclude?.length) parts.push({ type: { notIn: [...lane.exclude] } });
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0]! : { AND: parts };
}

/** The bookkeeping a job's `result` carries between runs: the handler's carry and how often it was deferred. */
type Kept = { carry: unknown; defers: number };

function keptFrom(result: unknown): Kept {
  const r = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  const defers = typeof r.defers === "number" && Number.isFinite(r.defers) && r.defers >= 0 ? Math.floor(r.defers) : 0;
  return { carry: r.carry ?? null, defers };
}

/** Reason given to the job's AbortSignal when the worker stops (or loses its lease) mid-task. */
export class StopRequestedError extends Error {
  constructor(message = "The background sender is stopping.") {
    super(message);
    this.name = "StopRequestedError";
  }
}

/**
 * Claims the next due job for `workerId` (of the lane's types when a lane is given), or returns null when there's
 * nothing to do. Priority first, then run time, then id.
 */
export async function claimNextJob(
  workerId: string,
  now = new Date(),
  lane?: Pick<RunnerLane, "include" | "exclude">,
): Promise<Job | null> {
  // If another claimer wins the race for the first candidate, look again (a few times).
  for (let i = 0; i < 3; i++) {
    const next = await db.job.findFirst({
      where: { status: "QUEUED", runAt: { lte: now }, ...laneWhere(lane) },
      orderBy: [{ priority: "desc" }, { runAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!next) return null;
    const res = await dbWrite((c) =>
      c.job.updateMany({
        where: { id: next.id, status: "QUEUED" },
        data: { status: "RUNNING", lockedAt: now, lockedBy: workerId, startedAt: now, attempts: { increment: 1 } },
      }),
    );
    if (res.count === 1) return db.job.findUnique({ where: { id: next.id } });
  }
  return null;
}

/** Puts a claimed job back in the queue without counting the attempt (shutdown, lease lost). */
export async function requeueWithoutCounting(job: Pick<Job, "id">, workerId: string): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.job.updateMany({
      where: { id: job.id, status: "RUNNING", lockedBy: workerId },
      data: { status: "QUEUED", lockedAt: null, lockedBy: null, attempts: { decrement: 1 } },
    }),
  );
  return res.count === 1;
}

export type ResetResult = { requeued: number[]; failed: number[] };

/**
 * Start-up: RUNNING jobs belong to a worker that stopped without finishing them. They go back to the
 * queue. A job that has already used all its tries (it keeps stopping the worker) fails instead, so
 * it can't crash the worker for ever, and the Owner gets the job's own failure notice (its
 * `failureNotice` runs, e.g. the restore check is marked failed so its hold can end), exactly as for
 * a handler that failed for good. `registry` defaults to the worker's registry (worker/jobs).
 */
export async function resetOrphanedJobs(logger: Logger = defaultLog, registry?: JobRegistry): Promise<ResetResult> {
  const running = await db.job.findMany({
    where: { status: "RUNNING" },
    select: { id: true, type: true, attempts: true, maxAttempts: true, payload: true },
  });
  const result: ResetResult = { requeued: [], failed: [] };
  let defs: JobRegistry | undefined = registry;
  const definitionOf = async (type: string): Promise<JobDefinition | undefined> => {
    // Loaded only when a job is given up (rare): the registry pulls in every job's module.
    defs ??= (await import("./jobs")).JOB_REGISTRY;
    return Object.hasOwn(defs, type) ? defs[type] : undefined;
  };
  for (const job of running) {
    if (job.attempts >= job.maxAttempts) {
      const error = "The background sender stopped every time it ran this task.";
      const res = await dbWrite((c) =>
        c.job.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: {
            status: "FAILED",
            error,
            finishedAt: new Date(),
            activeDedupeKey: null,
            lockedAt: null,
            lockedBy: null,
          },
        }),
      );
      if (res.count === 1) {
        result.failed.push(job.id);
        let def: JobDefinition | undefined;
        try {
          def = await definitionOf(job.type);
        } catch (err) {
          logger.error(`Couldn't load how to run the task "${job.type}"`, err);
        }
        await sendFailureNotice(def, job.type, job.payload, error, logger);
      }
    } else {
      const res = await dbWrite((c) =>
        c.job.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: { status: "QUEUED", lockedAt: null, lockedBy: null },
        }),
      );
      if (res.count === 1) result.requeued.push(job.id);
    }
  }
  return result;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return {};
  }
}

/** A copy of a JSON-like value for a Json column, or null (for null/undefined or anything unserialisable). */
function jsonOrNull(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : (JSON.parse(text) as Prisma.InputJsonValue);
  } catch {
    return null;
  }
}

/**
 * A handler threw DeferJob (M5-DESIGN D2): back to the queue until `runAt` without counting the try (the claim's
 * increment is undone), keeping the dedupe key and the progress; `result` becomes `{carry, summary, deferred, defers}`
 * (the new carry, or the one the run started with; `defers` counts deferrals so far).
 */
async function deferJob(
  job: Job,
  err: DeferJob,
  x: { whereMine: Prisma.JobWhereInput; kept: Kept; pending: { progressDone?: number; progressTotal?: number } },
): Promise<RunJobResult> {
  const runAt = err.runAt instanceof Date && Number.isFinite(err.runAt.getTime()) ? err.runAt : new Date();
  const summary = typeof err.opts.summary === "string" && err.opts.summary.trim() ? err.opts.summary : null;
  const result: Prisma.InputJsonObject = {
    carry: jsonOrNull(err.opts.carry !== undefined ? err.opts.carry : x.kept.carry),
    summary,
    deferred: err.reason,
    defers: x.kept.defers + 1,
  };
  const res = await dbWrite((c) =>
    c.job.updateMany({
      where: x.whereMine,
      data: { status: "QUEUED", runAt, attempts: { decrement: 1 }, lockedAt: null, lockedBy: null, result, ...x.pending },
    }),
  );
  if (res.count !== 1) return { outcome: "lost" };
  return { outcome: "deferred", deferredUntil: runAt, deferReason: err.reason, ...(summary ? { summary } : {}) };
}

function genericNotice(def: JobDefinition | undefined, type: string, error: string): FailureNotice {
  const reason = error.replace(/\.+$/, "");
  if (!def) {
    return {
      title: "A background task failed",
      body:
        `The background sender doesn't know how to run a task called "${type}": ${reason}. ` +
        "Run update.bat so the app and the background sender are on the same version.",
      link: null,
    };
  }
  return {
    title: "A background task failed",
    body: `${def.label} didn't finish: ${reason}. ${def.whatToDo}`,
    link: def.link ?? null,
  };
}

async function sendFailureNotice(
  def: JobDefinition | undefined,
  type: string,
  payload: unknown,
  error: string,
  logger: Logger,
): Promise<void> {
  try {
    const notice = def?.failureNotice ? def.failureNotice(payload, error) : genericNotice(def, type, error);
    await notifyOwner({ type: notice.type ?? "task.failed", title: notice.title, body: notice.body, link: notice.link });
  } catch (err) {
    logger.error(`Couldn't notify the Owner about the failed task "${type}"`, err);
  }
}

export type RunJobOptions = {
  workerId: string;
  registry: JobRegistry;
  signal: AbortSignal;
  logger?: Logger;
  /** The runner's lane: `ctx.shouldYield()` looks for a more urgent job of the same lane only. Default: every type. */
  lane?: RunnerLane;
  /** The clock of `ctx.shouldYield()` (which due jobs count). Default the real time. */
  now?: () => Date;
};

export type RunJobResult = {
  outcome: JobOutcome;
  summary?: string;
  error?: string;
  detail?: string | null;
  retryAt?: Date;
  /** "deferred": until when, and why (DeferJob's reason). */
  deferredUntil?: Date;
  deferReason?: DeferJob["reason"];
};

/** The redaction list for a failed job's texts: every saved secret; never lets a database problem hide the failure. */
async function secretsForRedaction(logger: Logger): Promise<string[]> {
  try {
    return await allSecretValues();
  } catch (err) {
    logger.warn(`Couldn't load the saved keys to hide them from an error text: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Runs one job that `workerId` has claimed, and records the outcome. */
export async function runClaimedJob(job: Job, opts: RunJobOptions): Promise<RunJobResult> {
  const { workerId, registry, signal } = opts;
  const logger = opts.logger ?? defaultLog;
  const clock = opts.now ?? (() => new Date());
  const def = Object.hasOwn(registry, job.type) ? registry[job.type] : undefined;
  const whereMine = { id: job.id, status: "RUNNING" as const, lockedBy: workerId };
  const kept = keptFrom(job.result);

  if (!def) {
    const error = `Unknown task type "${job.type}". Run update.bat so the app and the background sender are on the same version.`;
    const res = await dbWrite((c) =>
      c.job.updateMany({
        where: whereMine,
        data: { status: "FAILED", error, finishedAt: new Date(), activeDedupeKey: null, lockedAt: null, lockedBy: null },
      }),
    );
    if (res.count !== 1) return { outcome: "lost" };
    await sendFailureNotice(undefined, job.type, job.payload, "Unknown task type", logger);
    return { outcome: "failed", error };
  }

  // Progress: at most one database write per second; the last value is saved with the outcome.
  let lastProgressAt = 0;
  let pending: { progressDone: number; progressTotal: number } | null = null;
  const ctx: JobContext = {
    jobId: job.id,
    createdById: job.createdById,
    signal,
    carry: kept.carry,
    defers: kept.defers,
    queuedAt: job.createdAt,
    cancelRequested: async () => {
      const row = await db.job.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } });
      return row?.cancelRequestedAt != null;
    },
    shouldYield: async () => {
      const waiting = await db.job.findFirst({
        where: { status: "QUEUED", runAt: { lte: clock() }, priority: { gt: job.priority }, ...laneWhere(opts.lane) },
        select: { id: true },
      });
      return waiting !== null;
    },
    progress: async (done, total) => {
      const safeDone = Math.max(0, Math.floor(Number(done) || 0));
      const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
      const t = Date.now();
      if (t - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
        pending = { progressDone: safeDone, progressTotal: safeTotal };
        return;
      }
      lastProgressAt = t;
      pending = null;
      try {
        await setJobProgress(job.id, safeDone, safeTotal);
      } catch (err) {
        logger.warn(`Couldn't save the progress of task #${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  const progressFields = () => pending ?? {};

  let result: unknown;
  try {
    result = await def.handler(job.payload, ctx);
  } catch (err) {
    // A deferral keeps the handler's carry even when the worker is stopping (it drained before throwing).
    if (isDeferJob(err)) return deferJob(job, err, { whereMine, kept, pending: progressFields() });
    if (signal.aborted) {
      const ok = await requeueWithoutCounting(job, workerId);
      return { outcome: ok ? "requeued" : "lost" };
    }
    const { error, detail } = describeJobError(err, await secretsForRedaction(logger));
    // The technical text stays out of job.error; it's kept for "Details" (never secrets: it's redacted). The carry
    // survives a retry (and stays readable after the last one), so a resumed run picks up where it was.
    const failureResult = {
      errorDetail: detail,
      ...(kept.carry !== null ? { carry: jsonOrNull(kept.carry) } : {}),
      ...(kept.defers > 0 ? { defers: kept.defers } : {}),
    } as Prisma.InputJsonValue;
    const now = new Date();
    if (canRetry(job.attempts, job.maxAttempts)) {
      const retryAt = nextRetryAt(now, job.attempts);
      const res = await dbWrite((c) =>
        c.job.updateMany({
          where: whereMine,
          data: { status: "QUEUED", runAt: retryAt, error, result: failureResult, lockedAt: null, lockedBy: null, ...progressFields() },
        }),
      );
      return { outcome: res.count === 1 ? "retry" : "lost", error, detail, retryAt };
    }
    const res = await dbWrite((c) =>
      c.job.updateMany({
        where: whereMine,
        data: {
          status: "FAILED",
          error,
          result: failureResult,
          finishedAt: now,
          activeDedupeKey: null,
          lockedAt: null,
          lockedBy: null,
          ...progressFields(),
        },
      }),
    );
    if (res.count !== 1) return { outcome: "lost", error, detail };
    await sendFailureNotice(def, job.type, job.payload, error, logger);
    return { outcome: "failed", error, detail };
  }

  const json = toJson(result);
  const summary =
    json && typeof json === "object" && !Array.isArray(json) && typeof (json as { summary?: unknown }).summary === "string"
      ? ((json as { summary: string }).summary as string)
      : undefined;
  const res = await dbWrite((c) =>
    c.job.updateMany({
      where: whereMine,
      data: {
        status: "DONE",
        result: json,
        error: null,
        finishedAt: new Date(),
        activeDedupeKey: null,
        lockedAt: null,
        lockedBy: null,
        ...progressFields(),
      },
    }),
  );
  return { outcome: res.count === 1 ? "done" : "lost", summary };
}

export type JobRunnerOptions = {
  workerId: string;
  registry: JobRegistry;
  logger?: Logger;
  /** Checked before every claim; claiming stops when it returns false. */
  ownsLease?: () => Promise<boolean>;
  /** The job types this runner takes (WORKER_LANES); default every type. */
  lane?: RunnerLane;
  /** The clock of `ctx.shouldYield()`; default the real time. */
  now?: () => Date;
};

/** Claims and runs jobs one at a time (of its lane's types). The worker's loop for each lane calls tick() every 2 s. */
/** The job a runner is running; `handedBack` once shutdown put it back in the queue while it was still finishing. */
type RunningJob = { job: Job; controller: AbortController; done: Promise<unknown>; handedBack?: boolean };

export class JobRunner {
  private claiming = true;
  private current: RunningJob | null = null;
  private readonly logger: Logger;

  constructor(private readonly opts: JobRunnerOptions) {
    this.logger = opts.logger ?? defaultLog;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  get currentJobId(): number | null {
    return this.current?.job.id ?? null;
  }

  /** The lane's name ("main", "checks", "ai"), or "all" for a runner without a lane. */
  get laneName(): string {
    return this.opts.lane?.name ?? "all";
  }

  stopClaiming(): void {
    this.claiming = false;
  }

  resumeClaiming(): void {
    this.claiming = true;
  }

  /** Asks the running job to stop at its next safe point; it goes back to the queue. */
  abortCurrent(reason = "The background sender is stopping."): void {
    const cur = this.current;
    if (cur && !cur.controller.signal.aborted) cur.controller.abort(new StopRequestedError(reason));
  }

  /**
   * Resolves true once no job is running, or false after `timeoutMs`. When the running job was asked to stop
   * (`abortCurrent`, the worker is stopping) and is still busy after the wait, it is handed back to the queue now
   * without counting the try: a check or drafting run lets a paid call already in flight finish (up to 30 s / 60 s,
   * M5-DESIGN §0.2 rule 11) and the process ends before it can defer, so stopping the app would otherwise use up one
   * of its tries (and fail a one-try task). Its later outcome write then misses (the job isn't this worker's any more);
   * the per-job check rows and resetStuckDrafts cover the half-done work.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const cur = this.current;
    if (!cur) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    let idle: boolean;
    try {
      idle = await Promise.race([cur.done.then(() => true as const, () => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!idle && cur.controller.signal.aborted && this.current === cur && !cur.handedBack) {
      try {
        if (await requeueWithoutCounting(cur.job, this.opts.workerId)) {
          cur.handedBack = true;
          this.logger.info(`Task #${cur.job.id} (${cur.job.type}) is still finishing; put back in the queue without counting the try`);
        }
      } catch (err) {
        this.logger.error(`Task #${cur.job.id} (${cur.job.type}): couldn't put it back in the queue`, err);
      }
    }
    return idle;
  }

  /** Claims and runs at most one due job. Returns true when a job was run. */
  async tick(now = new Date()): Promise<boolean> {
    if (!this.claiming || this.current) return false;
    if (this.opts.ownsLease && !(await this.opts.ownsLease())) return false;
    if (!this.claiming) return false;

    const job = await claimNextJob(this.opts.workerId, now, this.opts.lane);
    if (!job) return false;
    if (!this.claiming) {
      // Shutdown started while we were claiming: hand it straight back.
      await requeueWithoutCounting(job, this.opts.workerId);
      return false;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    this.logger.info(`Task #${job.id} (${job.type}) started, try ${job.attempts} of ${job.maxAttempts}`);
    const done = runClaimedJob(job, {
      workerId: this.opts.workerId,
      registry: this.opts.registry,
      signal: controller.signal,
      logger: this.logger,
      lane: this.opts.lane,
      now: this.opts.now,
    });
    const current: RunningJob = { job, controller, done };
    this.current = current;
    const name = `Task #${job.id} (${job.type})`;
    try {
      const { outcome, summary, error, detail, retryAt, deferredUntil, deferReason } = await done;
      if (outcome === "lost" && current.handedBack) {
        this.logger.info(`${name} finished after it was put back in the queue; it runs again on the next start`);
        return true;
      }
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const why = detail ? `${error} Details: ${detail}` : error;
      if (outcome === "done") this.logger.info(`${name} finished in ${secs} s${summary ? `: ${summary}` : ""}`);
      else if (outcome === "deferred") {
        this.logger.info(`${name} waits until ${deferredUntil?.toISOString()} (${deferReason})${summary ? `: ${summary}` : ""}`);
      } else if (outcome === "retry") this.logger.warn(`${name} failed (${why}); trying again at ${retryAt?.toISOString()}`);
      else if (outcome === "failed") this.logger.error(`${name} failed for good: ${why}`);
      else if (outcome === "requeued") this.logger.info(`${name} was stopped and put back in the queue`);
      else this.logger.warn(`${name} was changed by someone else while it ran; its outcome wasn't saved`);
    } catch (err) {
      // Recording the outcome failed (e.g. the database stayed locked). Don't leave the job RUNNING
      // for ever (its dedupe key would block new ones): queue it again for a later try.
      this.logger.error(`${name}: couldn't save how it ended`, err);
      await this.releaseAfterCrash(job).catch((e) => this.logger.error(`${name}: couldn't put it back in the queue`, e));
    } finally {
      this.current = null;
    }
    return true;
  }

  private async releaseAfterCrash(job: Job): Promise<void> {
    await dbWrite((c) =>
      c.job.updateMany({
        where: { id: job.id, status: "RUNNING", lockedBy: this.opts.workerId },
        data: {
          status: "QUEUED",
          runAt: nextRetryAt(new Date(), job.attempts),
          error: "The background sender couldn't save this task's result.",
          lockedAt: null,
          lockedBy: null,
        },
      }),
    );
  }
}
