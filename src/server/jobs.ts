import type { Job, Prisma } from "@/generated/prisma/client";
import { db, dbTx, dbWrite, type DbOrTx } from "./db";

/**
 * Database job queue (SPEC: "a database-backed job table, not Redis").
 * The web app enqueues; the worker (worker/index.ts) claims and runs.
 * Job payloads and results must NEVER contain secrets.
 */

export type JobType =
  | "import.commit"
  | "backup.run"
  | "system.cleanup"
  | "verify.addresses"
  | "ai.draftLines"
  | "mailgun.catchUp"
  | "mailgun.syncSuppressions"
  | "mailgun.applySettings"
  | "mailgun.syncRoutes"
  | "send.testEmail"
  | "campaign.finishCheck"
  | "mailgun.checkDomain"
  | "mailgun.restoreScan"
  | "warmup.evaluate";

/** The long-running job types each get their own lane (M5-DESIGN §0.3 "Lane"). */
export const CHECKS_LANE_TYPES: readonly JobType[] = ["verify.addresses"];
export const AI_LANE_TYPES: readonly JobType[] = ["ai.draftLines"];

/**
 * Thrown by a handler to put its job back in the queue until `runAt` without counting a try (yield, pause, rate
 * limit, retry later). The dedupe key, progress and `carry` are kept; `summary` shows on progress screens meanwhile.
 */
export class DeferJob extends Error {
  readonly deferJob = true as const;
  constructor(
    readonly runAt: Date,
    readonly reason: "yield" | "paused" | "rate-limited" | "retry-later",
    readonly opts: { carry?: Prisma.InputJsonValue; summary?: string | null } = {},
  ) {
    super(`Deferred until ${runAt.toISOString()} (${reason})`);
    this.name = "DeferJob";
  }
}
export function isDeferJob(err: unknown): err is DeferJob {
  return err instanceof Error && (err as { deferJob?: unknown }).deferJob === true;
}

export type EnqueueInput = {
  type: JobType;
  payload?: Prisma.InputJsonValue;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** While a job with this key is queued or running, enqueueing again returns that job. */
  dedupeKey?: string;
  createdById?: number | null;
};

export async function enqueueJob(input: EnqueueInput, tx?: DbOrTx): Promise<Job> {
  const run = async (c: DbOrTx) => {
    if (input.dedupeKey) {
      const existing = await c.job.findUnique({ where: { activeDedupeKey: input.dedupeKey } });
      if (existing) return existing;
    }
    return c.job.create({
      data: {
        type: input.type,
        payload: input.payload,
        runAt: input.runAt ?? new Date(),
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
        activeDedupeKey: input.dedupeKey ?? null,
        createdById: input.createdById ?? null,
      },
    });
  };
  return tx ? run(tx) : dbWrite((c) => run(c));
}

/** What the browser may see about a job (never payload/raw result). */
export type PublicJob = {
  id: number;
  type: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  progressDone: number;
  progressTotal: number;
  summary: string | null;
  /** A plain sentence when the task failed for good. */
  error: string | null;
  /** The technical text behind a failure (redacted), for a "Details" disclosure only. */
  errorDetail: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** A queued job that waits until this instant (deferred, or delayed on purpose), so screens can say "Waiting: …". */
  waitingUntil: string | null;
};

export function toPublicJob(job: Job, now: Date = new Date()): PublicJob {
  const result = (job.result ?? null) as { summary?: unknown; errorDetail?: unknown } | null;
  const failed = job.status === "FAILED";
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progressDone: job.progressDone,
    progressTotal: job.progressTotal,
    summary: typeof result?.summary === "string" ? result.summary : null,
    error: failed ? (job.error ?? "This task failed.") : null,
    errorDetail: failed && typeof result?.errorDetail === "string" && result.errorDetail ? result.errorDetail : null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    waitingUntil: job.status === "QUEUED" && job.runAt > now ? job.runAt.toISOString() : null,
  };
}

export async function getJob(id: number): Promise<Job | null> {
  return db.job.findUnique({ where: { id } });
}

export async function cancelJob(id: number): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.job.updateMany({
      where: { id, status: "QUEUED" },
      data: { status: "CANCELLED", activeDedupeKey: null, finishedAt: new Date() },
    }),
  );
  return res.count === 1;
}

export type JobCancelOutcome = "cancelled" | "requested" | "finished" | "not-found";

/**
 * Stop button, for one job type only (M5-DESIGN §0.2 rule 14): a QUEUED job of `type` is cancelled at once; a RUNNING
 * one is asked to stop at its next safe point. "not-found" when no job with this id has that type.
 *
 * One transaction (it takes SQLite's write lock first): the worker can't move the job between RUNNING and QUEUED
 * (a yield, a pause, a retry) half-way through, which would otherwise make both updates miss and answer "finished"
 * while the job goes on.
 */
export async function requestJobCancel(id: number, opts: { type: JobType; now?: Date }): Promise<JobCancelOutcome> {
  const now = opts.now ?? new Date();
  return dbTx(async (tx): Promise<JobCancelOutcome> => {
    const job = await tx.job.findFirst({ where: { id, type: opts.type }, select: { status: true } });
    if (!job) return "not-found";
    if (job.status === "QUEUED") {
      const res = await tx.job.updateMany({
        where: { id, type: opts.type, status: "QUEUED" },
        data: { status: "CANCELLED", activeDedupeKey: null, finishedAt: now },
      });
      return res.count === 1 ? "cancelled" : "finished";
    }
    if (job.status === "RUNNING") {
      const res = await tx.job.updateMany({ where: { id, type: opts.type, status: "RUNNING" }, data: { cancelRequestedAt: now } });
      return res.count === 1 ? "requested" : "finished";
    }
    return "finished";
  });
}

// ─────────────── used by the worker's job runner and by job handlers ───────────────

export type JobContext = {
  jobId: number;
  createdById: number | null;
  /** Aborted when the worker is shutting down: stop at the next safe point and throw. */
  signal: AbortSignal;
  /** Reports progress (throttled by the caller if needed). */
  progress: (done: number, total: number) => Promise<void>;
  // Milestone 5 (M5-DESIGN §5.9, P4 runner): optional so existing handlers and tests compile; the runner always sets
  // them. Handlers use `ctx.carry ?? null` and `(await ctx.cancelRequested?.()) ?? false`.
  /** The previous `result.carry` (kept across deferrals and retries), default null. */
  carry?: unknown;
  /** How many times this job was deferred so far. */
  defers?: number;
  /** When the job was queued (the job's `createdAt`). */
  queuedAt?: Date;
  /** True once someone clicked Stop (Job.cancelRequestedAt is set): stop at the next safe point. */
  cancelRequested?: () => Promise<boolean>;
  /** True when a QUEUED job of the same lane with a higher priority is due: defer with reason "yield". */
  shouldYield?: () => Promise<boolean>;
};

/** A job handler returns a JSON result; put a plain-language `summary` string in it. */
export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<Prisma.InputJsonValue & { summary?: string }>;

export async function setJobProgress(jobId: number, done: number, total: number): Promise<void> {
  await dbWrite((c) => c.job.update({ where: { id: jobId }, data: { progressDone: done, progressTotal: total } }));
}

/** Removes anything secret-looking from a text (known secrets and "password=…"-style pairs), max 1,000 characters. */
export function redactText(text: string, secrets: string[] = []): string {
  let msg = text;
  for (const s of secrets) if (s && s.length >= 6) msg = msg.split(s).join("[hidden]");
  // "Authorization: Basic <base64>" must lose the credential, not just the word "Basic".
  msg = msg.replace(/(authorization)\s*[:=]\s*(?:basic|bearer)?\s*\S+/gi, "$1: [hidden]");
  msg = msg.replace(/(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1: [hidden]");
  // Anthropic keys, even ones that aren't saved (M5-DESIGN §5.2).
  msg = msg.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[hidden]");
  return msg.slice(0, 1000);
}

/** An error's message with anything secret-looking removed. */
export function redactError(err: unknown, secrets: string[] = []): string {
  return redactText(err instanceof Error ? err.message : String(err), secrets);
}

/**
 * An error whose message is written for people (what happened and what to do): a failed task
 * shows it as it is. `detail` is optional technical text (e.g. the file system's message) that
 * goes behind "Details". Never put secrets in either.
 */
export class PlainJobError extends Error {
  readonly userFacing = true as const;
  readonly detail: string | null;
  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "PlainJobError";
    this.detail = detail ?? null;
  }
}

/** What a failed task says when its error wasn't written for people. */
export const UNEXPECTED_JOB_ERROR = "Something unexpected went wrong.";

/** Text that shows an error came from a library or the system rather than from our own wording. */
const TECHNICAL_TEXT =
  /`|\binvocation\b|\b[A-Z]{2,}_[A-Z_]{2,}\b|\bE(?:NOENT|ACCES|PERM|BUSY|NOSPC|EXIST|ISDIR|NOTDIR|MFILE|CONNREFUSED|CONNRESET|TIMEDOUT)\b|\bP\d{4}\b|\n\s*at\s|node_modules|prisma\.|Cannot read propert|is not a function|is not defined|Unexpected token/;

/**
 * True for errors that can be shown to people as they are: ones marked `userFacing` (PlainJobError,
 * PlainBackupError…) and plain `new Error("…")` sentences thrown by our own services. Library and
 * system errors (Prisma, SQLite, the file system, TypeError…) are subclasses, carry a `code`, or
 * read like code, and are not.
 */
export function isUserFacingError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  if ((err as { userFacing?: unknown }).userFacing === true) return true;
  if (Object.getPrototypeOf(err) !== Error.prototype) return false;
  if ("code" in err) return false;
  return Boolean(err.message.trim()) && !TECHNICAL_TEXT.test(err.message);
}

export type JobErrorText = {
  /** A plain sentence for the screen and the Owner's notification. */
  error: string;
  /** Redacted technical text for "Details" and the worker log, or null. */
  detail: string | null;
};

/** Splits a failure into a plain sentence (shown) and the technical text (behind "Details"). */
export function describeJobError(err: unknown, secrets: string[] = []): JobErrorText {
  if (isUserFacingError(err)) {
    const detail = (err as { detail?: unknown }).detail;
    return {
      error: redactError(err, secrets),
      detail: typeof detail === "string" && detail.trim() ? redactText(detail, secrets) : null,
    };
  }
  const raw = redactError(err, secrets).trim();
  const name = err instanceof Error ? err.name || "Error" : "";
  const rawCode = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "";
  // "PrismaClientKnownRequestError (P2002)", "Error (ENOENT)", "TypeError"; a bare "Error" adds nothing.
  const label = code ? `${name || "Error"} (${code})` : name !== "Error" ? name : "";
  const detail = label ? (raw ? `${label}: ${raw}` : label) : raw;
  return { error: UNEXPECTED_JOB_ERROR, detail: detail ? detail.slice(0, 1000) : null };
}
