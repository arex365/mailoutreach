import { enqueueJob } from "@/server/jobs";
import { getMailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { getSetting } from "@/server/settings";
import { casState, getState, setState } from "@/server/state";
import { failOrphanedDrafts } from "@/server/services/ai/drafts";
import { AUTO_BACKUP_DEDUPE_KEY, backupQuietNow } from "@/server/services/backups";
import { enqueueDueRechecks, VERIFY_RECHECK_TASK } from "@/server/services/verification/recheck-sweep";
import { log as defaultLog, type Logger } from "./log";
import { DAY_MS, HOUR_MS, MINUTE_MS, isBackupDue, isDailyDue, mayEnqueueAgain, parseDate } from "./schedule";

export { PERIODIC_CHECK_MS } from "./schedule";

/**
 * Periodic tasks (PLAN.md B8, M3-DESIGN §4.6): each has a lastSuccessAt in SystemState "task.<name>", written by its
 * job handler when it succeeds. They're checked at start-up and every 10 minutes; a due task is enqueued as a normal
 * job (with a dedupe key, so it's never queued twice). A task with `enabled` is skipped while that answers false
 * (the Mailgun tasks while Mailgun isn't connected), without counting as enqueued.
 */

export type TaskState = { lastSuccessAt: Date | null; lastEnqueuedAt: Date | null };
type StoredTaskState = { lastSuccessAt?: string | null; lastEnqueuedAt?: string | null };

export type DueContext = {
  /** Setting "sending.capDayTimeZone": the office's time zone for the daily guarantee and the fixed quiet hours. */
  timeZone: string;
  /**
   * Quiet time for the daily backup (M6-DESIGN §3.5): no gated email due with its sending window open right now
   * (backupQuietNow), null when that couldn't be told (the fixed 22:00–08:00 window decides). Computed once per check.
   */
  sendingQuiet: boolean | null;
};

export type PeriodicTask = {
  name: string;
  /** How often it should run. */
  intervalMs: number;
  /** After enqueueing, wait at least this long before enqueueing again (if it failed meanwhile). */
  retryAfterMs: number;
  /** Whether it should run now. Defaults to "last success is at least intervalMs old (or in the future)". */
  due?: (now: Date, lastSuccess: Date | null, ctx: DueContext) => boolean;
  /** Skipped (not enqueued, not recorded) while this answers false, e.g. a Mailgun task while Mailgun isn't connected. */
  enabled?: () => Promise<boolean>;
  enqueue: (now: Date) => Promise<void>;
};

export const CLEANUP_DEDUPE_KEY = "cleanup";

/**
 * Task names and dedupe keys of the Milestone 3 periodic tasks. The names are the ones the job handlers record
 * (CATCH_UP_TASK, DOMAIN_CHECK_TASK, WARMUP_TASK_NAME in ./jobs; not imported, because those modules import this one).
 */
export const CATCH_UP_HOURLY_TASK = "mailgun.catchUp.hourly";
export const DOMAIN_CHECK_6H_TASK = "mailgun.domainCheck.6h";
export const WARMUP_HOURLY_TASK = "warmup.hourly";
export const CATCH_UP_DEDUPE_KEY = "mailgun:catchup";
export const DOMAIN_CHECK_DEDUPE_KEY = "mailgun:domain-check";
export const WARMUP_DEDUPE_KEY = "warmup";
/** Job priorities (M3-DESIGN §4.6; the same numbers as JOB_PRIORITIES in ./jobs). */
const CATCH_UP_PRIORITY = 50;
const DOMAIN_CHECK_PRIORITY = 20;
const WARMUP_PRIORITY = 20;

/**
 * The Milestone 5 periodic tasks (M5-DESIGN §2.7, §3.9, §8 P11). Both record their own success when they have looked,
 * whether they found something to do or not, so an idle sweep doesn't run again at every 10-minute check.
 *  - `verify.recheck` (every 15 minutes): gives up re-checks 72 hours overdue and queues the `recheck` run of the address
 *    checks once a "Waiting for re-check" person's 24 hours are over (enqueueDueRechecks).
 *  - `ai.orphans` (every 30 minutes): drafts left in the queue by a drafting run that ended for good (it failed, was
 *    stopped, or its task is gone) become Failed "Claude couldn't be reached. Click Try again." (failOrphanedDrafts);
 *    it runs directly, not as a task.
 */
export const RECHECK_TASK = VERIFY_RECHECK_TASK;
export const AI_ORPHANS_TASK = "ai.orphans";

/**
 * True when Mailgun is connected (not the practice copy, a domain and a usable key saved). A test run without the
 * fake Mailgun server throws inside getMailgunContext on purpose; that counts as not connected here.
 */
export async function mailgunConnected(load: () => Promise<MailgunContextResult> = getMailgunContext): Promise<boolean> {
  try {
    return (await load()).connected;
  } catch {
    return false;
  }
}

/** Enqueues the check with Mailgun (catch-up) for `reason`: one at a time (dedupe), before most other jobs. */
export async function enqueueCatchUp(reason: "startup" | "hourly", createdById: number | null = null): Promise<void> {
  await enqueueJob({
    type: "mailgun.catchUp",
    payload: { reason },
    dedupeKey: CATCH_UP_DEDUPE_KEY,
    priority: CATCH_UP_PRIORITY,
    createdById,
  });
}

export const PERIODIC_TASKS: readonly PeriodicTask[] = [
  {
    name: "backup.daily",
    intervalMs: DAY_MS,
    retryAfterMs: HOUR_MS,
    due: (now, lastSuccess, ctx) => isBackupDue(now, lastSuccess, ctx.timeZone, ctx.sendingQuiet),
    enqueue: async () => {
      await enqueueJob({ type: "backup.run", payload: { kind: "AUTO" }, dedupeKey: AUTO_BACKUP_DEDUPE_KEY });
    },
  },
  {
    name: "cleanup.daily",
    intervalMs: DAY_MS,
    retryAfterMs: HOUR_MS,
    due: (now, lastSuccess) => isDailyDue(now, lastSuccess),
    enqueue: async () => {
      await enqueueJob({ type: "system.cleanup", dedupeKey: CLEANUP_DEDUPE_KEY });
    },
  },
  {
    // B6.11: bounces, complaints, unsubscribes and replies Mailgun has that no webhook brought (PC off, network down).
    name: CATCH_UP_HOURLY_TASK,
    intervalMs: HOUR_MS,
    retryAfterMs: 20 * MINUTE_MS,
    enabled: () => mailgunConnected(),
    enqueue: async () => {
      await enqueueCatchUp("hourly");
    },
  },
  {
    // The Domain checklist's rows (DNS, Mailgun's settings, remote access); the Live gate and the live holds read them.
    name: DOMAIN_CHECK_6H_TASK,
    intervalMs: 6 * HOUR_MS,
    retryAfterMs: HOUR_MS,
    enabled: () => mailgunConnected(),
    enqueue: async () => {
      await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: DOMAIN_CHECK_DEDUPE_KEY, priority: DOMAIN_CHECK_PRIORITY });
    },
  },
  {
    // Closed cap days for the warm-up ramp (also after every successful catch-up). Runs in the practice copy too.
    name: WARMUP_HOURLY_TASK,
    intervalMs: HOUR_MS,
    retryAfterMs: 20 * MINUTE_MS,
    enqueue: async () => {
      await enqueueJob({ type: "warmup.evaluate", dedupeKey: WARMUP_DEDUPE_KEY, priority: WARMUP_PRIORITY });
    },
  },
  {
    // M5: the 24-hour re-check of "no answer" addresses (the run itself is deduplicated as "verify:recheck").
    name: RECHECK_TASK,
    intervalMs: 15 * MINUTE_MS,
    retryAfterMs: 15 * MINUTE_MS,
    enqueue: async (now) => {
      await enqueueDueRechecks(now);
      await recordTaskSuccess(RECHECK_TASK, now);
    },
  },
  {
    // M5: drafts no drafting run will finish any more.
    name: AI_ORPHANS_TASK,
    intervalMs: 30 * MINUTE_MS,
    retryAfterMs: 30 * MINUTE_MS,
    enqueue: async (now) => {
      await failOrphanedDrafts(now);
      await recordTaskSuccess(AI_ORPHANS_TASK, now);
    },
  },
];

export function taskStateKey(name: string): string {
  return `task.${name}`;
}

export async function readTaskState(name: string): Promise<TaskState> {
  const row = await getState<unknown>(taskStateKey(name));
  const v = (row && typeof row.value === "object" && row.value !== null ? row.value : {}) as StoredTaskState;
  return { lastSuccessAt: parseDate(v.lastSuccessAt), lastEnqueuedAt: parseDate(v.lastEnqueuedAt) };
}

/** Merges fields into "task.<name>" with compare-and-set, so the handler and the checker never lose each other's update. */
async function updateTaskState(name: string, patch: StoredTaskState): Promise<void> {
  const key = taskStateKey(name);
  for (let i = 0; i < 5; i++) {
    const row = await getState<unknown>(key);
    const current = row && typeof row.value === "object" && row.value !== null ? (row.value as StoredTaskState) : {};
    if (await casState<StoredTaskState>(key, row ? row.version : null, { ...current, ...patch })) return;
  }
  const row = await getState<StoredTaskState>(key);
  await setState<StoredTaskState>(key, { ...(row?.value ?? {}), ...patch });
}

/** Called by a task's job handler when it succeeded. */
export async function recordTaskSuccess(name: string, at = new Date()): Promise<void> {
  await updateTaskState(name, { lastSuccessAt: at.toISOString() });
}

function isDue(task: PeriodicTask, now: Date, lastSuccess: Date | null, ctx: DueContext): boolean {
  if (task.due) return task.due(now, lastSuccess, ctx);
  if (!lastSuccess) return true;
  const age = now.getTime() - lastSuccess.getTime();
  // A last success "in the future" means the PC's clock went back: run now rather than wait for the clock.
  return age < 0 || age >= task.intervalMs;
}

/**
 * Enqueues every due task. Returns the names of the tasks that were enqueued. `opts.quietNow` (tests) replaces
 * backupQuietNow, the daily backup's quiet-time answer.
 */
export async function checkPeriodicTasks(
  now = new Date(),
  tasks: readonly PeriodicTask[] = PERIODIC_TASKS,
  logger: Logger = defaultLog,
  opts: { quietNow?: (now: Date) => Promise<boolean | null> } = {},
): Promise<string[]> {
  let timeZone: string;
  try {
    timeZone = await getSetting("sending.capDayTimeZone");
  } catch {
    timeZone = "Asia/Karachi";
  }
  let sendingQuiet: boolean | null;
  try {
    sendingQuiet = await (opts.quietNow ?? backupQuietNow)(now);
  } catch {
    sendingQuiet = null;
  }
  const ctx: DueContext = { timeZone, sendingQuiet };
  const enqueued: string[] = [];
  for (const task of tasks) {
    try {
      const state = await readTaskState(task.name);
      if (!isDue(task, now, state.lastSuccessAt, ctx)) continue;
      if (!mayEnqueueAgain(now, state.lastEnqueuedAt, task.retryAfterMs)) continue;
      if (task.enabled && !(await task.enabled())) continue;
      await task.enqueue(now);
      await updateTaskState(task.name, { lastEnqueuedAt: now.toISOString() });
      enqueued.push(task.name);
    } catch (err) {
      logger.error(`Couldn't check the periodic task "${task.name}"`, err);
    }
  }
  return enqueued;
}
