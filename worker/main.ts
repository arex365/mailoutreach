import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendMode } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { databaseFilePath } from "@/server/env";
import { describeMailgunTarget } from "@/server/mailgun/base-url";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { processPendingInbound, type InboundFailures } from "@/server/services/replies/process";
import { runHealthCheck } from "@/server/services/sending/health-check";
import {
  cancelJobsCapturedInBackup,
  checkDatabaseInstance,
  handleRestoreMarker,
  restoreMarkerPath,
  restoreMarkerSeen,
} from "@/server/services/sending/restore";
import type { EmailTransport } from "@/server/services/sending/transport";
import { getSetting } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { parseOutageState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { EventLane } from "./event-lane";
import { JOB_REGISTRY, applyOutageHoldLogged, createJobRegistry } from "./jobs";
import type { AiDeps } from "./jobs/ai-draft-lines";
import type { JobRegistry } from "./jobs/types";
import {
  HEARTBEAT_MS,
  LEASE_RETRY_MS,
  LEASE_SAFETY_MS,
  acquireLease,
  ownsLease,
  releaseLease,
  renewLease,
} from "./lease";
import { createThrottledLogger, log, type Logger } from "./log";
import { MonitorLoop } from "./monitor";
import { PERIODIC_CHECK_MS, checkPeriodicTasks, enqueueCatchUp, mailgunConnected } from "./periodic";
import { ReconcilerLoop } from "./reconciler";
import { runOneOffRepairs } from "./repairs";
import { JobRunner, RUNNER_INTERVAL_MS, WORKER_LANES, resetOrphanedJobs } from "./runner";
import { SendingLoop, resetInterruptedDryRunSends } from "./sending";

/**
 * The background sender's life cycle (PLAN.md B1, B8, M3-DESIGN §4.6):
 *   take the lease (or wait and retry every 15 s — never exit, NSSM would restart-loop)
 *   → check the migrations → reset orphaned RUNNING jobs → put interrupted dry-run sends back in the queue
 *   → one-off data repairs (./repairs, incl. renaming an M1/M2 restore marker)
 *   → is this database a copy? (pause "copied-database") → a restore marker? (pause, queue the restore check)
 *   → the outage hold, when a check with Mailgun found the PC was off too long and its hold isn't applied yet (M4)
 *   → log where Mailgun calls go → queue the start-up check with Mailgun (when connected) → health check
 *   → check periodic tasks
 *   → loops: heartbeat 15 s · job runners 2 s, one per lane (./runner WORKER_LANES: main, checks, ai; Milestone 5,
 *            so a long check or drafting run never delays the catch-up, "Send me a test" or backups) · sending 5 s
 *            (./sending) · event lane 1 s (./event-lane: Mailgun events, then stored replies) · reconciler 10 min
 *            (./reconciler) · monitor 1 min (./monitor) · periodic tasks 10 min
 *   → on lease loss: stop claiming, go back to waiting; on shutdown: stop within 4 s.
 *
 * Mailgun emails wait for a successful check with Mailgun after `startedAt` (the catch-up gate, §4.3.2; every lease
 * taken, also one taken again after it was lost, moves `startedAt` to that moment before the start-up queues the check
 * (M6-DESIGN §3.9, L7); after the PC slept or hibernated, the heartbeat moves it to the wake-up and queues the check
 * again), and the
 * warm-up's closed days are evaluated only after that check (the catch-up job's onSuccess), never here: B1 "catch up,
 * then evaluate closed days, then send". From Milestone 4 (M4-DESIGN §2.8.3, §3.9) the same onSuccess first applies
 * the outage hold, TEST/LIVE follow-ups wait for a check with Mailgun after every start (no 15-minute fallback), and
 * the event lane processes stored replies with a back-off map of its own (1, 5, 15, 60 minutes, then the fail-safe).
 */

/** NSSM (AppStopMethodConsole 4000) kills the process 4 s after Ctrl+C. */
const SHUTDOWN_JOB_WAIT_MS = 3_000;
const SHUTDOWN_STEP_TIMEOUT_MS = 400;
const MAX_ONCE_JOBS = 100;

/**
 * Wall-clock time the worker can't account for: the heartbeat is saved every 15 seconds, so a gap this long since the
 * last saved one means the PC was asleep or hibernating, or the process was frozen. Replies that arrived meanwhile may
 * not have reached the app (Mailgun stops retrying after about 8 hours), so the worker treats it as a new start.
 */
export const WAKE_GAP_MS = 3 * 60_000;

/** True when `nowMs` is more than WAKE_GAP_MS after the last saved heartbeat (0 = none saved yet: nothing to compare). */
export function isWallClockGap(lastHeartbeatOkMs: number, nowMs: number): boolean {
  return lastHeartbeatOkMs > 0 && nowMs - lastHeartbeatOkMs > WAKE_GAP_MS;
}

export function makeWorkerId(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(2).toString("hex")}`;
}

/** Sleeps `ms`, or less if `signal` is aborted meanwhile. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]);
}

/** Warns (never blocks) when the database and this version's migrations don't match. */
async function checkMigrations(logger: Logger): Promise<void> {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "prisma", "migrations");
  let expected: string[];
  try {
    expected = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql")))
      .map((d) => d.name);
  } catch {
    return; // no migrations folder next to the worker: nothing to compare with
  }
  let applied: string[];
  try {
    const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    applied = rows.map((r) => r.migration_name);
  } catch (err) {
    logger.warn(`Couldn't read the database's update history (${err instanceof Error ? err.message : String(err)}). Run update.bat if tasks keep failing.`);
    return;
  }
  const missing = expected.filter((m) => !applied.includes(m));
  const unknown = applied.filter((m) => !expected.includes(m));
  if (missing.length > 0) {
    logger.warn(`The database is missing ${missing.length} update(s) (${missing.join(", ")}). Run update.bat so it matches this version.`);
  } else if (unknown.length > 0) {
    logger.warn(`The database is newer than this version of the background sender (${unknown.join(", ")}). Run update.bat.`);
  }
}

export type WorkerOptions = {
  workerId?: string;
  registry?: JobRegistry;
  logger?: Logger;
  /** Tests: the transport per mode (e.g. a recording fake). Production builds it from the Mailgun context. */
  transportFor?: (mode: SendMode) => EmailTransport;
  /** Tests: the Mailgun context (e.g. with fast retries against the fake server), for the loops and the catch-up. */
  mailgun?: () => Promise<MailgunContextResult>;
  /** Tests: the clock of the loops, the start-up steps and the catch-up. */
  now?: () => Date;
  /** Tests: the pacing jitter's random source. */
  random?: () => number;
  /** Tests: what the monitor's remote-access checks fetch with (cloudflared's /ready, the public address). */
  fetchImpl?: typeof fetch;
  /**
   * Tests (M5-DESIGN §9.3 Part A): AI drafting's website reader, Claude client and the like (`AiDeps`), for the
   * registry this worker builds. Ignored when `registry` is given.
   */
  ai?: Partial<AiDeps>;
};

export class BackgroundWorker {
  readonly id: string;
  /**
   * When this worker last took the lease (at first, when it was made): Mailgun emails wait for a check with Mailgun
   * after this (the catch-up gate). Moved forward on every lease taken (`holdLease`, also after a lost lease) and after
   * a wall-clock gap (`checkWallClock`). The sending loop holds this same Date object and reads it every tick, so the
   * gates see the new start at once.
   */
  readonly startedAt: Date;
  private readonly logger: Logger;
  private readonly throttled: ReturnType<typeof createThrottledLogger>;
  private readonly now: () => Date;
  private readonly mailgun: (() => Promise<MailgunContextResult>) | undefined;
  private readonly registry: JobRegistry;
  /** One job runner per lane (M5-DESIGN D1): main first, then checks, then ai. */
  private readonly runners: readonly JobRunner[];
  private readonly sending: SendingLoop;
  private readonly eventLane: EventLane;
  private readonly reconciler: ReconcilerLoop;
  private readonly monitor: MonitorLoop;
  /** The event lane's reply back-off (M4-DESIGN §3.8): failed tries per InboundMessage id and when to try again. */
  private readonly inboundFailures: InboundFailures = new Map();
  private stopping = false;
  private readonly stopSignal = new AbortController();
  private session: AbortController | null = null;
  private lastHeartbeatOk = 0;
  private stoppedPromise: Promise<void> | null = null;
  private resolveStopped!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  constructor(opts: WorkerOptions = {}) {
    this.id = opts.workerId ?? makeWorkerId();
    this.logger = opts.logger ?? log;
    this.throttled = createThrottledLogger(this.logger);
    this.now = opts.now ?? (() => new Date());
    this.mailgun = opts.mailgun;
    this.startedAt = this.now();
    const leased = () => ownsLease(this.id);
    this.registry =
      opts.registry ??
      (opts.mailgun || opts.now || opts.logger || opts.ai
        ? createJobRegistry({ mailgun: opts.mailgun, now: opts.now, logger: this.logger, ai: opts.ai })
        : JOB_REGISTRY);
    this.runners = [WORKER_LANES.main, WORKER_LANES.checks, WORKER_LANES.ai].map(
      (lane) => new JobRunner({ workerId: this.id, registry: this.registry, logger: this.logger, ownsLease: leased, lane }),
    );
    this.sending = new SendingLoop({
      ownsLease: leased,
      logger: this.logger,
      startedAt: this.startedAt,
      transportFor: opts.transportFor,
      mailgun: opts.mailgun,
      random: opts.random,
      now: opts.now,
    });
    this.eventLane = new EventLane({
      ownsLease: leased,
      logger: this.logger,
      now: opts.now,
      // New real bounces or complaints: the health check may pause sending at once (§4.3.8).
      onProblems: () => runHealthCheck({ now: this.now() }).then(() => undefined),
      // Stored replies (M4-DESIGN §3.9): 20 per round, oldest first, with this worker's back-off map; the lane goes
      // again at once when a full batch was handled.
      processInbound: (o) =>
        processPendingInbound({
          ...o,
          failures: this.inboundFailures,
          logger: { error: (m, err) => this.logger.error(m, err) },
        }).then((r) => r.processed + r.failed),
    });
    this.reconciler = new ReconcilerLoop({
      ownsLease: leased,
      logger: this.logger,
      now: opts.now,
      mailgun: opts.mailgun,
      // Never touch an email the sending loop is still sending.
      inFlight: this.sending.inFlight,
    });
    this.monitor = new MonitorLoop({ ownsLease: leased, logger: this.logger, now: opts.now, fetchImpl: opts.fetchImpl });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Resolves once shutdown() has finished. */
  whenStopped(): Promise<void> {
    return this.stopped;
  }

  /** Runs until shutdown(): waits for the lease, works while holding it, waits again if it's lost. */
  async run(): Promise<void> {
    this.logger.info(`Background sender starting (${this.id}); database ${databaseFilePath()}`);
    let waitingLogged = false;
    while (!this.stopping) {
      let result: Awaited<ReturnType<typeof acquireLease>>;
      try {
        result = await acquireLease(this.id);
        this.throttled.clear("lease");
      } catch (err) {
        this.throttled.error("lease", "Couldn't reach the database to take the lease; trying again in 15 s", err);
        await sleep(LEASE_RETRY_MS, this.stopSignal.signal);
        continue;
      }
      if (!result.acquired) {
        if (!waitingLogged) {
          this.logger.info("Another background sender is running; waiting");
          waitingLogged = true;
        }
        await sleep(LEASE_RETRY_MS, this.stopSignal.signal);
        continue;
      }
      waitingLogged = false;
      this.logger.info(
        result.previousOwner && result.previousOwner !== this.id
          ? `Lease taken over from ${result.previousOwner}`
          : "Lease taken",
      );
      await this.holdLease();
    }
  }

  /** Test/diagnostic mode (`--once`): take the lease, run start-up and one round of every loop, then release. */
  async runOnce(): Promise<number> {
    return this.withLeaseOnce(async () => {
      await this.startup();
      await renewLease(this.id);
      await this.oneRound();
    });
  }

  /**
   * Tests and diagnostics: take the lease, run one round (the queued tasks, then one tick of every loop) without the
   * start-up steps, then release. Returns 3 when another background sender holds the lease.
   */
  async tickOnce(): Promise<number> {
    return this.withLeaseOnce(() => this.oneRound());
  }

  private async withLeaseOnce(work: () => Promise<void>): Promise<number> {
    const result = await acquireLease(this.id);
    if (!result.acquired) {
      this.logger.info("Another background sender is running; nothing was done");
      return 3;
    }
    try {
      await work();
    } finally {
      await releaseLease(this.id).catch((err) => this.logger.error("Couldn't release the lease", err));
    }
    return 0;
  }

  /** The queued tasks of each lane until it is idle (at most 100 per lane: main, then checks, then ai), then one tick of each loop. */
  private async oneRound(): Promise<void> {
    let ran = 0;
    for (const runner of this.runners) {
      let inLane = 0;
      while (inLane < MAX_ONCE_JOBS && (await runner.tick())) inLane += 1;
      ran += inLane;
    }
    this.logger.info(`Ran ${ran} task${ran === 1 ? "" : "s"}`);
    const signal = new AbortController().signal;
    // Events and replies first (proof of sending, stops, holds), then the reconciler, then sending, then the
    // remote-access checks.
    await this.eventLane.tick();
    await this.reconciler.tick(signal);
    await this.sending.tick(signal);
    await this.monitor.tick();
  }

  private async startup(): Promise<void> {
    await checkMigrations(this.logger);
    // After a restore, the backup's own tasks (its backup job, an old restore check) never run again, and aren't given
    // up below with a false failure notice either. handleRestoreMarker cancels them too, so a problem here only waits.
    try {
      await cancelJobsCapturedInBackup({ now: this.now(), logger: this.logger });
    } catch (err) {
      this.logger.error("Couldn't cancel the tasks the restored backup held; the restore check does it again", err);
    }
    // The worker's own registry, so a task given up here gets the same failure notice as in the runner.
    const reset = await resetOrphanedJobs(this.logger, this.registry);
    if (reset.requeued.length > 0) {
      this.logger.info(`Put ${reset.requeued.length} interrupted task(s) back in the queue: #${reset.requeued.join(", #")}`);
    }
    if (reset.failed.length > 0) {
      this.logger.warn(`Gave up on ${reset.failed.length} task(s) that kept stopping the worker: #${reset.failed.join(", #")}`);
    }
    // Dry-run emails a stopped worker left "Sending" (Mailgun ones are the reconciler's: never reset).
    await resetInterruptedDryRunSends(this.logger, this.now());
    // Includes "m3.oldRestoreMarker", which must run before the restore check below.
    await runOneOffRepairs(this.logger, undefined, this.now());
    await this.startMailgunSafety();
    await this.runPeriodicCheck();
  }

  /**
   * Start-up for Milestones 3 and 4 (M3-DESIGN §4.6, M4-DESIGN §2.8.3), after the repairs and before any loop runs:
   *  1. a database opened from a new place without a restore marker is a copy: pause (§4.3.7);
   *  2. a restore marker: pause, queue the restore check with Mailgun, hold Mailgun emails until it's done;
   *  3. an outage found by an earlier check with Mailgun whose hold wasn't applied (the worker stopped in between):
   *     apply it now, before any follow-up can go;
   *  4. log where Mailgun calls go (the fake server in tests and manual checks);
   *  5. when Mailgun is connected, queue the start-up check with Mailgun (the catch-up gate waits for it);
   *  6. the health check (a pause the counts call for is set before anything is sent).
   * Steps 1 and 2 must succeed (a failure stops the start-up, which is tried again in 15 s, so a copy or a restore
   * can never send before it is handled); 3–6 are logged and never stop the worker (step 3 is retried by the next
   * check with Mailgun and the 5-minute sending maintenance, and the sending gate holds follow-ups meanwhile).
   */
  private async startMailgunSafety(): Promise<void> {
    const now = this.now();
    // Only a marker for THIS database counts (the practice copy's database shares the folder), and only while it isn't
    // handled yet: a stale one that couldn't be deleted never turns off the copied-database check.
    const markerSeen = await restoreMarkerSeen(restoreMarkerPath());
    // Logs which kind of copy it found (moved, another computer, a replaced file) through this worker's logger.
    await checkDatabaseInstance({ now, markerSeen, logger: this.logger });
    await handleRestoreMarker({ now, logger: this.logger });

    try {
      const outage = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
      if (outage.handledAt === null && (outage.from !== null || outage.beyondMessageRetention)) {
        await applyOutageHoldLogged(now, this.logger);
      }
    } catch (err) {
      this.logger.error("Couldn't put follow-ups on hold after the PC was off; the next check with Mailgun tries again", err);
    }

    let region: "EU" | "US" = "EU";
    try {
      region = (await getSetting("mailgun.region")) === "US" ? "US" : "EU";
    } catch {
      /* the default region is fine for the log line */
    }
    this.logger.info(`Mailgun: ${describeMailgunTarget(region)}`);

    try {
      if (await mailgunConnected(this.mailgun)) {
        await enqueueCatchUp("startup");
        this.logger.info("Queued the check with Mailgun; emails through Mailgun wait until it has finished.");
      }
    } catch (err) {
      this.logger.error("Couldn't queue the check with Mailgun; the hourly check queues it again", err);
    }

    try {
      const health = await runHealthCheck({ now });
      if (health.paused) this.logger.warn("Too many bounces or spam complaints: sending is paused until the Owner resumes it.");
    } catch (err) {
      this.logger.error("The health check at start-up hit a problem; it runs again after the next check with Mailgun", err);
    }
  }

  /**
   * Works while holding the lease. Every lease taken is a new start (M6-DESIGN §3.9, L7): the heartbeat may have
   * failed for 45 s (a locked database, a disk stall) or the PC slept while this worker waited, and replies from that
   * time may not be stored yet. So `startedAt` moves to now before the start-up queues the check with Mailgun, and
   * Mailgun emails wait for a check after it (the catch-up gates in services/sending/gates.ts).
   */
  private async holdLease(): Promise<void> {
    const session = new AbortController();
    this.session = session;
    this.startedAt.setTime(this.now().getTime());
    this.lastHeartbeatOk = Date.now();
    for (const runner of this.runners) runner.resumeClaiming();
    try {
      await this.startup();
      if (!session.signal.aborted) {
        await Promise.all([
          this.heartbeatLoop(session.signal),
          ...this.runners.map((runner) => this.runnerLoop(runner, session.signal)),
          this.sending.run(session.signal),
          this.eventLane.run(session.signal),
          this.reconciler.run(session.signal),
          this.monitor.run(session.signal),
          this.periodicLoop(session.signal),
        ]);
      }
    } catch (err) {
      this.logger.error("Start-up after taking the lease failed; trying again in 15 s", err);
      this.stopAllRunners();
      await releaseLease(this.id).catch(() => undefined);
      await sleep(LEASE_RETRY_MS, this.stopSignal.signal);
    } finally {
      this.stopAllRunners();
      if (this.session === session) this.session = null;
      session.abort();
    }
  }

  /** Every lane stops claiming new tasks. */
  private stopAllRunners(): void {
    for (const runner of this.runners) runner.stopClaiming();
  }

  /** Every lane stops claiming and asks its running task to stop at its next safe point (it goes back to the queue). */
  private abortAllRunners(reason?: string): void {
    for (const runner of this.runners) {
      runner.stopClaiming();
      runner.abortCurrent(reason);
    }
  }

  private loseLease(reason: string): void {
    this.logger.warn(reason);
    this.abortAllRunners("The background sender lost its lease.");
    this.session?.abort();
  }

  /**
   * Before every heartbeat: time the worker couldn't account for (the PC asleep or hibernating, the process frozen) is
   * treated as a new start. Replies from that time may not have reached the app, and an outage may need a hold, so the
   * start time moves to now (the sending loop reads the same Date, so both checks with Mailgun close for Mailgun emails
   * until a new check succeeds, M4-DESIGN §2.8.3 rule 2) and the check with Mailgun is queued at once. During such a gap
   * the lease is stale (no heartbeat for more than 45 s), so nothing is claimed until this has run and the heartbeat
   * has renewed it. Returns true when it treated the gap as a new start.
   */
  async checkWallClock(nowMs: number = Date.now()): Promise<boolean> {
    if (!isWallClockGap(this.lastHeartbeatOk, nowMs)) return false;
    const minutes = Math.round((nowMs - this.lastHeartbeatOk) / 60_000);
    this.startedAt.setTime(this.now().getTime());
    this.logger.warn(
      `No heartbeat for ${minutes} minutes (the PC was asleep, or the background sender was paused); emails through Mailgun wait for a new check with Mailgun`,
    );
    try {
      if (await mailgunConnected(this.mailgun)) await enqueueCatchUp("startup");
    } catch (err) {
      this.logger.error("Couldn't queue the check with Mailgun after the gap; the hourly check queues it again", err);
    }
    return true;
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(HEARTBEAT_MS, signal);
      if (signal.aborted) break;
      await this.checkWallClock();
      try {
        const ok = await renewLease(this.id);
        if (!ok) {
          this.loseLease("Another background sender took over the lease; stopped taking tasks and waiting");
          break;
        }
        this.lastHeartbeatOk = Date.now();
        this.throttled.clear("heartbeat");
      } catch (err) {
        this.throttled.error("heartbeat", "Couldn't save the heartbeat", err);
        if (Date.now() - this.lastHeartbeatOk > LEASE_SAFETY_MS) {
          this.loseLease("No heartbeat saved for 45 s; stopped taking tasks until the lease is back");
          break;
        }
      }
    }
  }

  /** One lane's loop: a task after the other while there are due ones, else a look every 2 s. */
  private async runnerLoop(runner: JobRunner, signal: AbortSignal): Promise<void> {
    const key = `runner:${runner.laneName}`;
    while (!signal.aborted) {
      let ran = false;
      try {
        ran = await runner.tick();
        this.throttled.clear(key);
      } catch (err) {
        this.throttled.error(key, `The task runner (${runner.laneName} lane) hit a problem`, err);
      }
      if (!ran) await sleep(RUNNER_INTERVAL_MS, signal);
    }
  }

  private async periodicLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(PERIODIC_CHECK_MS, signal);
      if (signal.aborted) break;
      await this.runPeriodicCheck();
    }
  }

  private async runPeriodicCheck(): Promise<void> {
    try {
      const enqueued = await checkPeriodicTasks(this.now(), undefined, this.logger);
      if (enqueued.length > 0) this.logger.info(`Queued periodic task(s): ${enqueued.join(", ")}`);
    } catch (err) {
      this.logger.error("Couldn't check the periodic tasks", err);
    }
  }

  /**
   * Graceful stop (Ctrl+C from NSSM, the console closing, or {type:"shutdown"} over IPC): stop
   * claiming, ask the running tasks (one per lane) to stop, wait up to 3 s (the tasks, the sending loop and the event
   * lane, side by side), release the lease, disconnect. Everything finishes within NSSM's 4-second
   * window. A Mailgun request in flight is never aborted; if the process exits first, its email stays
   * "Sending" and the reconciler checks it with Mailgun at the next start (§4.2.3, §4.3.6). A paid address check or
   * Claude call in flight isn't aborted either: its task stops starting new ones and lets it finish meanwhile
   * (M5-DESIGN §0.2 rule 11).
   */
  shutdown(reason: string): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopping = true;
    this.stoppedPromise = (async () => {
      this.logger.info(`Stopping (${reason})`);
      this.abortAllRunners();
      this.session?.abort();
      this.stopSignal.abort();
      const [runnersIdle, sendingIdle, eventsIdle] = await Promise.all([
        Promise.all(this.runners.map((runner) => runner.waitForIdle(SHUTDOWN_JOB_WAIT_MS))),
        this.sending.waitForIdle(SHUTDOWN_JOB_WAIT_MS),
        this.eventLane.waitForIdle(SHUTDOWN_JOB_WAIT_MS),
      ]);
      this.runners.forEach((runner, i) => {
        if (!runnersIdle[i]) {
          this.logger.warn(`The running task (${runner.laneName} lane) didn't stop in time; it will run again on the next start`);
        }
      });
      if (!sendingIdle) {
        this.logger.warn("An email was still being sent; the next start puts it back in the queue or checks it with Mailgun");
      }
      if (!eventsIdle) this.logger.warn("A Mailgun report or a reply was still being processed; it is processed again on the next start");
      try {
        await withTimeout(releaseLease(this.id), SHUTDOWN_STEP_TIMEOUT_MS);
      } catch (err) {
        this.logger.error("Couldn't release the lease", err);
      }
      try {
        await withTimeout(db.$disconnect(), SHUTDOWN_STEP_TIMEOUT_MS);
      } catch {
        /* exiting anyway */
      }
      this.logger.info("Stopped");
    })().finally(() => this.resolveStopped());
    return this.stoppedPromise;
  }
}

/**
 * What to do with a stop request: "graceful" for the first one; "force" (quit at once) only for a
 * second request from the SAME source, like pressing Ctrl+C twice; "ignore" for a request from
 * another source while already stopping. One Ctrl+C in a start.bat window reaches the worker twice
 * (the console event, and possibly start.bat's own stop message), and closing the window also
 * closes the IPC channel: none of those may cut the clean shutdown short.
 */
export function stopDecision(firstSource: string | null, source: string): "graceful" | "force" | "ignore" {
  if (firstSource === null) return "graceful";
  return firstSource === source ? "force" : "ignore";
}

/** Wires Ctrl+C / Ctrl+Break / console close / IPC "shutdown" to a graceful stop. */
function installProcessHandlers(worker: BackgroundWorker, logger: Logger): void {
  let firstSource: string | null = null;
  const stop = (source: string, reason: string = source) => {
    const decision = stopDecision(firstSource, source);
    if (decision === "force") {
      logger.warn(`${reason} again: stopping right away`);
      process.exit(0);
    }
    if (decision === "ignore") return; // already stopping cleanly
    firstSource = source;
    void worker.shutdown(reason);
  };
  for (const sig of ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const) {
    process.on(sig, () => stop(sig));
  }
  process.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "shutdown") stop("shutdown message");
  });
  if (typeof process.send === "function") {
    // Started by start.bat's supervisor: if it goes away, don't keep running on our own.
    process.on("disconnect", () => stop("disconnect", "the start window closed"));
  }
  process.on("uncaughtException", (err) => {
    logger.error("Unexpected problem", err instanceof Error ? (err.stack ?? err.message) : err);
    firstSource ??= "unexpected problem";
    void worker.shutdown("unexpected problem").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (err) => {
    logger.error("Unexpected problem (unhandled promise)", err instanceof Error ? (err.stack ?? err.message) : err);
  });
}

export async function runWorker(opts: { once?: boolean } & WorkerOptions = {}): Promise<number> {
  const logger = opts.logger ?? log;
  const worker = new BackgroundWorker(opts);
  if (opts.once) {
    try {
      return await worker.runOnce();
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  }
  installProcessHandlers(worker, logger);
  await Promise.race([worker.run(), worker.whenStopped()]);
  await worker.whenStopped();
  return 0;
}

/** `--self-test`: can this build reach the database? */
export async function selfTest(): Promise<number> {
  try {
    await db.$queryRawUnsafe("SELECT 1");
    process.stdout.write("worker self-test ok\n");
    return 0;
  } catch (err) {
    log.error(`Self-test failed (database ${databaseFilePath()})`, err);
    return 1;
  }
}
