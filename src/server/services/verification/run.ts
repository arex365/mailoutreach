import type { CompanyStatus, Prisma, RecipientState, Risk, VerificationStatus } from "@/generated/prisma/client";
import { parseEmail } from "@/core/email-address";
import { NEVER_EMAIL_STATUSES, type CompanyStatusValue } from "@/core/labels";
import { roundUsd } from "@/core/money";
import { VERIFY_NOTIFICATION } from "@/core/notification-types";
import {
  checkDecision,
  type CheckDecision,
  type PersonFacts,
  type RiskValue,
  type SuppressionReasonValue,
  type VerificationStatusValue,
} from "@/core/rules/eligibility";
import { safeZone } from "@/core/sending/capday";
import type { CheckPauseKind } from "@/core/system-state";
import { plural } from "@/core/text";
import { formatTime } from "@/core/time/format";
import { monthBounds, type MonthBounds } from "@/core/time/month";
import { checkNeedOf, liveCheckContext } from "@/core/verification/need";
import { isRealProvider } from "@/core/verification/policy";
import {
  MAX_UNKNOWNS_IN_A_ROW,
  type CheckResult,
  type CheckRunCounts,
  type CheckSingleOutcome,
  type CheckSource,
  type VerifyRunCarry,
  type VerifyRunPayload,
} from "@/core/verification/types";
import { checkFinishedTitle, checkPauseText, checkResultWords, checkRunActivity, checkRunSummary, recheckLeftOutNotice, reasonWords } from "@/core/verification/words";
import { logActivity } from "@/server/activity";
import { db, dbTx } from "@/server/db";
import { DeferJob, isDeferJob, PlainJobError, type JobContext } from "@/server/jobs";
import { notifyUsers } from "@/server/notifications";
import { scrubProviderText } from "@/server/secret-values";
import { finishCheck } from "@/server/services/campaigns/control";
import { loadEligibilitySettings, type EligibilitySettings } from "@/server/services/eligibility";
import { excludeUnsent } from "@/server/services/mail-events/stops";
import { getSettings } from "@/server/settings";
import { getVerifier, type Verifier, type VerifierResult, type VerifyOutcome } from "@/server/verification";
import { commitCheckResult, type CommitCheckInput, type CommitCheckOutcome } from "./commit";
import { CheckPacer, sleepFor } from "./pacer";
import { getChecksPause, pauseChecks } from "./pause";
import { dueRecheckPeople, RECHECK_CAMPAIGN_STATUSES } from "./recheck-sweep";
import { checkRunCounts, readVerifyRunCarry, readVerifyRunPayload, UNREADABLE_REASON } from "./runs";
import { RECHECK_LEFT_OUT_TEXT, settleRecheckForPerson } from "./settle";
import { checksThisMonth, limitFromSetting } from "./spend";

/**
 * The check job `verify.addresses` (docs/dev/M5-DESIGN.md §2.5, P6): runs in the worker's `checks` lane, one run at a
 * time, and checks a static list of people (or the Settings test's one address, or the people whose 24-hour re-check
 * has come) through the verifier adapter.
 *
 * In order: the gate (checks paused → wait; no usable key → fail, or pause for the re-check sweep); answers that came
 * back last time but couldn't be stored are stored first, each exactly once (never bought twice, never counted twice);
 * then the work list in chunks of 500, each person re-read and skipped without a call when a check can't or needn't
 * happen, and read again right before their paid call (address edited, checked by another run meanwhile, a newer
 * result, a Verify-step campaign launched); the office month's check limit before every paid call (calls in flight
 * reserved); the call itself (its own 30 s timeout, never the job's shutdown signal, never inside a transaction), 2 at a
 * time by default (the pacer, §2.5.1); and each answer stored at once by `commitCheckResult`, the one door (§2.6).
 *
 * The job never returns, throws or defers while a check is in flight (§0.2 rule 12): it stops starting, waits for the
 * calls in flight, stores their answers, then leaves. It yields every 60 s or when a more urgent check run waits, stops
 * at the next safe point when someone clicks Stop (after storing every paid answer), pauses every run on key, account
 * or unreadable-answer problems and at the monthly limit, and retries a pass after 10 minutes (at most 6 times) for
 * addresses Mailgun couldn't answer. Any other problem makes it wait a minute with everything it learned (never the
 * runner's retry, which would forget the time-outs of this run). A re-check whose paid answer can't be read counts as
 * the re-check (the waiting emails are left out), so it is never bought again every 15 minutes.
 * What it carries between runs is `VerifyRunCarry` (§5.8) with a few fields of its own (`VerifyJobCarry`).
 *
 * Addresses are personal data: logs and texts name people by id only (§0.2 rule 9); provider texts are scrubbed.
 */

// ───────────────────────── constants ─────────────────────────

/** People read per database round (skip rules and "already checked in this run" in one query each). */
export const CHECK_CHUNK = 500;
/** Cancel and yield are looked at every this many addresses. */
export const CHECK_EVERY_ITEMS = 10;
/** A run of the handler yields after this long (other runs of the lane get a turn). */
export const CHECK_YIELD_AFTER_MS = 60_000;
/** One in-pass retry after a 5xx or network error, after this wait. */
export const TRANSIENT_RETRY_MS = 2_000;
/** 429s for one address in one pass before it waits for the next pass. */
export const MAX_RATE_LIMITS_PER_PASS = 5;
/** Timed-out attempts after which an address isn't tried again in this run (each may have been billed). */
export const MAX_TIMEOUTS = 2;
/** Passes retried after a wait ("retry later"), and the wait. */
export const MAX_RETRY_PASSES = 6;
export const RETRY_PASS_MS = 10 * 60_000;
/** Unreadable answers in a row that pause every check run. */
export const MAX_UNREADABLE_IN_A_ROW = 3;
/** How long a paused run waits before looking again (a resume lets it go at once). */
export const PAUSED_RETRY_MS = 3_600_000;
/** How long a run waits when an answer couldn't be stored, or after any other problem. */
export const COMMIT_RETRY_MS = 60_000;
/**
 * Deferrals in a row because of a problem (an answer that couldn't be stored, or any other error), before the error
 * goes to the runner (its tries, then FAILED) like any other.
 */
export const MAX_COMMIT_DEFERS = 10;
/** The paid-call count after which this month's spend is read from the database again. */
const BUDGET_REFRESH_CALLS = 100;
const IN_CHUNK = 400;
/** The key of the Settings test's one typed address in the work list (people are keyed by their id). */
const SETTINGS_KEY = -1;

/** A payload that can't be read (a task from an older version, or a broken one). */
export const UNREADABLE_CHECK_TASK_TEXT = "This address check task can't be read. Start the checks again.";

// ───────────────────────── types ─────────────────────────

/** The check job's carry: the contract's `VerifyRunCarry` (P1 reads it) plus what only the job needs. */
export type VerifyJobCarry = VerifyRunCarry & {
  /** People of the current retry pass not handled yet (a pass that was interrupted by a yield or a pause). */
  passQueue: number[];
  /** Addresses finished so far (stored, skipped, refused or given up): the progress bar's "done". */
  done: number;
  /**
   * Deferrals in a row because of a problem: an answer that couldn't be stored, or an error. Every one keeps this carry
   * (timeouts, counters, the place in the list), so a retry never forgets what the failed run learned.
   */
  commitDefers: number;
  /** Re-check runs: the RECHECK recipients of the people this run handled (the senders' "left out" notices). */
  recheckRecipients: number[];
};

export type CheckRunLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, err?: unknown) => void;
};

/** Injection points (tests). Every default is the real thing. */
export type VerifyRunDeps = {
  /** The checker (default `getVerifier()`). */
  verifier?: () => Promise<VerifierResult>;
  /** The one door that stores a result (default `commitCheckResult`); tests make it fail. */
  commit?: (input: CommitCheckInput) => Promise<CommitCheckOutcome>;
  /** The clock of every stored time, deferral, month and re-check (default the real time). */
  now?: () => Date;
  /** Elapsed time in ms for the pacer, the 60 s yield and the retry waits (default Date.now). */
  clockMs?: () => number;
  /** Waits `ms` or rejects when `signal` aborts (default a timer). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The pacer's jitter (default Math.random). */
  random?: () => number;
  /** Default 60 s. */
  yieldAfterMs?: number;
  /** Default 2 s. */
  transientRetryMs?: number;
  /** Where the job logs (the worker passes its own). */
  logger?: CheckRunLogger;
};

/** What the finished job stores as its result (read by `checkRunView`, §6.11). */
export type VerifyRunResult = {
  summary: string;
  counts: CheckRunCounts;
  carry: VerifyJobCarry;
  single?: CheckSingleOutcome;
  stopped?: boolean;
};

type PersonRow = {
  id: number;
  companyId: number;
  email: string | null;
  emailNorm: string | null;
  deletedAt: Date | null;
  verificationStatus: VerificationStatus | null;
  verificationRisk: Risk | null;
  verifiedAt: Date | null;
  verificationProvider: string | null;
  verificationDisposable: boolean;
  verificationUnknowns: number;
  unsubscribedAt: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  company: { status: CompanyStatus; deletedAt: Date | null };
};

/** What the run reads about a person (per chunk, and again right before their paid call). */
const PERSON_SELECT = {
  id: true,
  companyId: true,
  email: true,
  emailNorm: true,
  deletedAt: true,
  verificationStatus: true,
  verificationRisk: true,
  verifiedAt: true,
  verificationProvider: true,
  verificationDisposable: true,
  verificationUnknowns: true,
  unsubscribedAt: true,
  bouncedAt: true,
  complainedAt: true,
  company: { select: { status: true, deletedAt: true } },
} as const satisfies Prisma.PersonSelect;

type RowSummary = { status: VerificationStatus; risk: Risk; isDisposable: boolean; reasons: unknown };

/** A RECHECK recipient of a person: `due` when its re-check has come; `emailNorm` is the address its email was made for. */
type RecheckRow = { id: number; due: boolean; emailNorm: string };

function isUnreadableRow(reasons: unknown): boolean {
  return Array.isArray(reasons) && reasons.includes(UNREADABLE_REASON);
}

/** One address to call. */
type Target = { key: number; personId: number | null; companyId: number | null; email: string; emailNorm: string };

type SkipCounter = keyof VerifyRunCarry["skipped"];

type Decision =
  | { kind: "call"; target: Target }
  | { kind: "skip"; counter: SkipCounter | null; skipReason: CheckSingleOutcome["skipReason"] }
  /** Re-check runs: settle this person's RECHECK recipients without a call. */
  | { kind: "settle" }
  /**
   * Re-check runs: the re-check was bought already (by this run or another since it fell due) and its answer couldn't
   * be read. That was the re-check: the waiting emails are left out "Address couldn't be checked", without a call.
   */
  | { kind: "give-up" }
  /**
   * This run already stored an answer for the address (a resumed run), or (panel, `reused`) another run checked the
   * person after this one was queued: nothing to pay.
   */
  | { kind: "checked"; row: RowSummary; reused?: boolean }
  /** Verify-step runs: the campaign isn't a draft any more (launched, cancelled or gone): the run stops, no call. */
  | { kind: "closed" }
  | { kind: "ignore" };

/** What happened when a call was about to start. */
type StartOutcome =
  | { kind: "started" }
  /** Stopped before it started (a stop, a pause, the monthly limit): the item goes back for the next run. */
  | { kind: "stopped" }
  /** The address (edited meanwhile) is in flight for someone else: the item waits for the end of the pass. */
  | { kind: "requeued" }
  /** Fresh data says no call is needed any more. */
  | { kind: "not-needed"; decision: Exclude<Decision, { kind: "call" }> };

type StopCause =
  | { kind: "cancel" }
  | { kind: "yield" }
  | { kind: "shutdown" }
  | { kind: "pause"; pause: Exclude<CheckPauseKind, "monthly_limit" | "unreadable">; detail: string | null }
  | { kind: "unreadable" }
  | { kind: "monthly" }
  | { kind: "commit" }
  | { kind: "error"; err: unknown };

const quietInfo: CheckRunLogger = {
  info: () => undefined,
  warn: (m) => console.warn(`[checks] ${m}`),
  error: (m, err) => console.error(`[checks] ${m}`, err ?? ""),
};

// ───────────────────────── the carry ─────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function ids(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0) : [];
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** The job's carry as stored in its result (anything missing or broken at its empty value). */
export function readVerifyJobCarry(v: unknown): VerifyJobCarry {
  const o = obj(v);
  return {
    ...readVerifyRunCarry(v),
    passQueue: ids(o.passQueue),
    done: count(o.done),
    commitDefers: count(o.commitDefers),
    recheckRecipients: ids(o.recheckRecipients),
  };
}

function uniq(list: readonly number[]): number[] {
  return [...new Set(list)];
}

// ───────────────────────── the run ─────────────────────────

/** The handler of `verify.addresses` (the worker's job definition wraps it with its logger). */
export async function runVerifyAddresses(
  payload: unknown,
  ctx: JobContext,
  deps: VerifyRunDeps = {},
): Promise<Prisma.InputJsonValue & { summary: string }> {
  const p = readVerifyRunPayload(payload);
  if (!p) throw new PlainJobError(UNREADABLE_CHECK_TASK_TEXT);
  const result = await new CheckRun(p, ctx, deps).run();
  return result as unknown as Prisma.InputJsonValue & { summary: string };
}

class CheckRun {
  private readonly now: () => Date;
  private readonly clockMs: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: CheckRunLogger;
  private readonly commit: (input: CommitCheckInput) => Promise<CommitCheckOutcome>;
  private readonly source: CheckSource;
  private readonly single: boolean;
  private readonly carry: VerifyJobCarry;
  private readonly startedMs: number;
  private readonly stopController = new AbortController();

  private verifier!: Verifier;
  private pacer!: CheckPacer;
  private settings!: EligibilitySettings;
  private zone = "Asia/Karachi";
  private limitUsd = 100;
  private included = 0;
  private recheckRecent = false;

  /** The work list's person ids (the Settings test: one pseudo key). */
  private list: number[] = [];
  private total = 0;
  private buffer: number[] = [];
  /** Items back at the end of the pass (a 429). */
  private requeue: number[] = [];
  /** Items to try again after a stop (a pause answer, or the one taken when the run stopped). */
  private putBack: number[] = [];
  private readonly rate429 = new Map<number, number>();
  private readonly doneKeys = new Set<number>();
  private readonly inFlightKeys = new Set<number>();
  private readonly inFlightNorms = new Set<string>();
  private readonly recheckTracked: Set<number>;
  private stopCause: StopCause | null = null;
  private handled = 0;

  // chunk data (fresh per chunk; entries overwritten, never cleared)
  private readonly people = new Map<number, PersonRow>();
  private readonly suppression = new Map<string, SuppressionReasonValue>();
  private readonly checkedInJob = new Map<string, RowSummary>();
  private readonly recheckRows = new Map<number, RecheckRow[]>();
  private readonly dueAt = new Map<number, Date>();
  /** Re-check runs: the latest unreadable answer per address (any run) since its re-check fell due. */
  private readonly unreadableSince = new Map<string, Date>();
  /** Verify-step runs: the campaign is still a draft, and the people whose recipient the launch hasn't handled yet. */
  private campaignOpen = true;
  private readonly wizardPending = new Set<number>();
  /** Panel runs: the answer shown is another run's (checked after this one was queued), so no "checked" entry here. */
  private panelReused = false;

  // this office month's check spend (only the checks lane pays for checks, so these reservations are complete)
  private month: MonthBounds | null = null;
  private baseUsd = 0;
  private baseCount = 0;
  private sinceUsd = 0;
  private sinceCount = 0;
  private reservedUsd = 0;
  private reservedCount = 0;
  private callsSinceRefresh = 0;

  constructor(
    private readonly payload: VerifyRunPayload,
    private readonly ctx: JobContext,
    private readonly deps: VerifyRunDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.clockMs = deps.clockMs ?? (() => Date.now());
    this.sleep = deps.sleep ?? sleepFor;
    this.log = deps.logger ?? quietInfo;
    this.commit = deps.commit ?? commitCheckResult;
    this.source = payload.source;
    this.single = payload.source === "panel" || payload.source === "settings";
    this.carry = readVerifyJobCarry(ctx.carry ?? null);
    this.recheckTracked = new Set(this.carry.recheckRecipients);
    this.startedMs = this.clockMs();
    if ("recheckRecent" in payload) this.recheckRecent = payload.recheckRecent === true;
  }

  private get jobId(): number {
    return this.ctx.jobId;
  }

  private carryJson(): Prisma.InputJsonValue {
    this.carry.recheckRecipients = [...this.recheckTracked];
    return JSON.parse(JSON.stringify(this.carry)) as Prisma.InputJsonValue;
  }

  // ── 1. the gate ──

  async run(): Promise<VerifyRunResult> {
    const now = this.now();
    const pause = await getChecksPause(now);
    if (pause.paused) {
      const until = pause.until ? new Date(pause.until) : new Date(now.getTime() + PAUSED_RETRY_MS);
      throw new DeferJob(until, "paused", { carry: this.carryJson(), summary: pause.text || "Address checks are paused." });
    }
    const vr = await (this.deps.verifier ?? (() => getVerifier()))();
    if (!vr.ok) {
      if (this.source === "recheck") {
        // Nobody waits on this screen: pause every run (the Owner hears once a day) and look again in an hour.
        await pauseChecks("auth", vr.text, null, { now });
        throw new DeferJob(new Date(now.getTime() + PAUSED_RETRY_MS), "paused", { carry: this.carryJson(), summary: vr.text });
      }
      // Nothing was charged: starting refuses without a key, so the key was removed after the start.
      throw new PlainJobError(vr.text);
    }
    this.verifier = vr.verifier;

    const s = await getSettings(["verification.monthlyLimitUsd", "verification.includedPerMonth", "verification.concurrency", "sending.capDayTimeZone"] as const);
    this.limitUsd = limitFromSetting(s["verification.monthlyLimitUsd"]);
    const included = Number(s["verification.includedPerMonth"]);
    this.included = Number.isFinite(included) && included > 0 ? Math.floor(included) : 0;
    this.zone = safeZone(s["sending.capDayTimeZone"]);
    this.pacer = new CheckPacer({
      max: Number(s["verification.concurrency"]),
      now: this.clockMs,
      sleep: this.sleep,
      random: this.deps.random,
    });
    this.settings = await loadEligibilitySettings();

    // From here on the carry may hold what this run learned (answers, time-outs, counters): any error leaves through a
    // deferral that keeps it, never through the runner's retry, which only knows the carry this run started with.
    try {
      return await this.work();
    } catch (err) {
      if (isDeferJob(err)) throw err;
      return this.afterError(err);
    }
  }

  private async work(): Promise<VerifyRunResult> {
    // ── 2. answers that came back but couldn't be stored: first, so none is ever bought again ──
    await this.commitCarried();

    // ── 3. the work list ──
    await this.buildList();
    await this.refreshBudget(true);
    const onAbort = () => this.stop({ kind: "shutdown" });
    this.ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.pump();
    } finally {
      this.ctx.signal.removeEventListener("abort", onAbort);
    }
    if (this.stopCause) return this.afterStop(this.stopCause);

    // ── 8. after the pass ──
    if (this.carry.pending.length > 0) {
      if (!this.single && this.carry.retries < MAX_RETRY_PASSES) {
        this.carry.passQueue = uniq([...this.carry.passQueue, ...this.carry.pending]);
        this.carry.pending = [];
        this.carry.retries += 1;
        this.carry.commitDefers = 0;
        const at = new Date(this.now().getTime() + RETRY_PASS_MS);
        throw new DeferJob(at, "retry-later", { carry: this.carryJson(), summary: this.waitingText(at) });
      }
      this.giveUpPending();
    }
    return this.finish(false);
  }

  /** "Waiting: some checks will be tried again at 14:05." (the office's time zone). */
  private waitingText(at: Date): string {
    return `Waiting: some checks will be tried again at ${formatTime(at, this.zone)}.`;
  }

  // ── 2. carried answers ──

  /**
   * Stores the answers this run paid for but couldn't store (`carry.uncommitted`), each exactly once: `once` makes the
   * commit store nothing when this job already has the row (a run that stored it and then failed, or a worker that
   * died before saving the smaller carry, hands the same answer over again). Still failing: the run waits a minute.
   */
  private async commitCarried(): Promise<void> {
    while (this.carry.uncommitted.length > 0) {
      const item = this.carry.uncommitted[0]!;
      const person =
        this.source !== "settings" && item.personId !== null
          ? await db.person.findUnique({ where: { id: item.personId }, select: { id: true, companyId: true, email: true } })
          : null;
      const input: CommitCheckInput = {
        person: person ? { id: person.id, companyId: person.companyId, email: person.email ?? item.emailNorm, emailNorm: item.emailNorm } : null,
        emailNorm: item.emailNorm,
        result: item.result,
        unreadable: item.unreadable,
        provider: item.provider,
        costUsd: item.costUsd,
        jobId: this.jobId,
        source: this.source,
        now: this.now(),
        once: true,
      };
      let out: CommitCheckOutcome;
      try {
        out = await this.commit(input);
      } catch (err) {
        this.carry.commitDefers += 1;
        this.log.error(`Task #${this.jobId}: a stored answer still couldn't be saved`, err);
        if (this.carry.commitDefers > MAX_COMMIT_DEFERS) throw err;
        const at = new Date(this.now().getTime() + COMMIT_RETRY_MS);
        throw new DeferJob(at, "retry-later", { carry: this.carryJson(), summary: this.waitingText(at) });
      }
      this.carry.uncommitted.shift();
      this.carry.commitDefers = 0;
      const key = this.source === "settings" ? SETTINGS_KEY : (item.personId ?? SETTINGS_KEY);
      // A re-check whose paid answer couldn't be read: that was the re-check (never bought again every 15 minutes).
      if (this.source === "recheck" && item.unreadable && item.personId !== null) await this.giveUpRecheck(item.personId);
      this.finishKey(key);
      if (this.single) this.carry.single = this.singleFromResult(item.personId, item.result, item.unreadable, out.decision, null);
    }
  }

  // ── 3. the work list ──

  private async buildList(): Promise<void> {
    const p = this.payload;
    if (p.source === "settings") {
      this.list = [SETTINGS_KEY];
      this.carry.cursor = 0;
      this.total = 1;
      return;
    }
    if (p.source === "recheck") {
      // Recomputed on every run: people settled meanwhile are no longer due.
      const waiting = new Set([...this.carry.pending, ...this.carry.passQueue, ...this.carry.failed]);
      const due = await dueRecheckPeople(this.now());
      this.list = due
        .map((d) => d.personId)
        .filter((id) => !waiting.has(id) && (this.carry.timeouts[String(id)] ?? 0) < MAX_TIMEOUTS);
      this.carry.cursor = 0;
      this.total = this.carry.done + this.list.length + this.carry.passQueue.length + this.carry.pending.length;
      return;
    }
    this.list = uniq(p.personIds);
    this.total = this.list.length;
  }

  /** The next key to handle: the list from the cursor, then the current retry pass, then items back after a 429. */
  private async nextKey(): Promise<number | null> {
    for (;;) {
      if (this.buffer.length > 0) return this.buffer.shift()!;
      let next: number[];
      if (this.carry.cursor < this.list.length) {
        next = this.list.slice(this.carry.cursor, this.carry.cursor + CHECK_CHUNK);
        this.carry.cursor += next.length;
      } else if (this.carry.passQueue.length > 0) {
        next = this.carry.passQueue.splice(0, CHECK_CHUNK);
      } else if (this.requeue.length > 0) {
        next = this.requeue.splice(0, CHECK_CHUNK);
      } else {
        return null;
      }
      const failed = new Set(this.carry.failed);
      next = uniq(next).filter((k) => !this.doneKeys.has(k) && !this.inFlightKeys.has(k) && !failed.has(k));
      if (next.length === 0) continue;
      try {
        await this.loadChunk(next);
      } catch (err) {
        // Taken from the list but not read: back to the pass, so the run's error deferral keeps them.
        this.putBack.push(...next);
        throw err;
      }
      this.buffer = next;
    }
  }

  /**
   * Fresh data for a chunk: the people, their do-not-email rows, this run's answers, (re-checks) their waits and the
   * unreadable answers bought since they fell due, and (Verify step) whether the campaign is still a draft that hasn't
   * handled them.
   */
  private async loadChunk(keys: number[]): Promise<void> {
    const personIds = keys.filter((k) => k > 0);
    const norms: string[] = [];
    for (let i = 0; i < personIds.length; i += IN_CHUNK) {
      const found = await db.person.findMany({ where: { id: { in: personIds.slice(i, i + IN_CHUNK) } }, select: PERSON_SELECT });
      for (const p of found) {
        this.people.set(p.id, p);
        if (p.emailNorm) norms.push(p.emailNorm);
      }
    }
    if (keys.includes(SETTINGS_KEY) && this.payload.source === "settings") {
      const norm = parseEmail(this.payload.address)?.norm;
      if (norm) norms.push(norm);
    }
    await this.loadAddressFacts(norms);
    if (this.source === "recheck" && personIds.length > 0) {
      await this.loadRecheckRows(personIds);
      await this.loadUnreadableSince(personIds);
    }
    if (this.payload.source === "wizard" && personIds.length > 0) await this.loadWizardState(personIds);
  }

  /** The do-not-email rows of these addresses and this run's own answers for them. */
  private async loadAddressFacts(norms: readonly string[]): Promise<void> {
    for (let i = 0; i < norms.length; i += IN_CHUNK) {
      const part = norms.slice(i, i + IN_CHUNK);
      const [sup, rows] = await Promise.all([
        db.suppression.findMany({ where: { emailNorm: { in: part } }, select: { emailNorm: true, reason: true } }),
        db.verificationCheck.findMany({
          where: { jobId: this.jobId, emailNorm: { in: part } },
          select: { emailNorm: true, status: true, risk: true, isDisposable: true, reasons: true },
          orderBy: { id: "asc" },
        }),
      ]);
      for (const n of part) this.suppression.delete(n);
      for (const r of sup) this.suppression.set(r.emailNorm, r.reason as SuppressionReasonValue);
      for (const r of rows) this.checkedInJob.set(r.emailNorm, r);
    }
  }

  /** Re-check runs: these people's RECHECK recipients, which are due, and each person's latest due time. */
  private async loadRecheckRows(personIds: readonly number[]): Promise<void> {
    const now = this.now();
    for (let i = 0; i < personIds.length; i += IN_CHUNK) {
      const part = personIds.slice(i, i + IN_CHUNK);
      const rows = await db.campaignRecipient.findMany({
        where: { personId: { in: part }, state: "RECHECK" },
        select: { id: true, personId: true, emailNorm: true, recheckAt: true, campaign: { select: { status: true } } },
      });
      for (const id of part) {
        this.recheckRows.delete(id);
        this.dueAt.delete(id);
      }
      for (const r of rows) {
        const due = r.recheckAt !== null && r.recheckAt <= now && RECHECK_CAMPAIGN_STATUSES.includes(r.campaign.status);
        this.recheckRows.set(r.personId, [...(this.recheckRows.get(r.personId) ?? []), { id: r.id, due, emailNorm: r.emailNorm }]);
        if (due && r.recheckAt) {
          const seen = this.dueAt.get(r.personId);
          if (!seen || r.recheckAt > seen) this.dueAt.set(r.personId, r.recheckAt);
        }
      }
    }
  }

  /**
   * Re-check runs: unreadable answers (charged rows, any run or source) for these people's addresses since the
   * earliest of their due times. One since a person's re-check fell due was that re-check (§2.7): a lost "leave out"
   * never makes the sweep's next run buy it again.
   */
  private async loadUnreadableSince(personIds: readonly number[]): Promise<void> {
    const norms: string[] = [];
    let earliest: Date | null = null;
    for (const id of personIds) {
      const due = this.dueAt.get(id);
      const norm = this.people.get(id)?.emailNorm;
      if (!due || !norm) continue;
      norms.push(norm);
      if (!earliest || due < earliest) earliest = due;
    }
    if (!earliest) return;
    for (let i = 0; i < norms.length; i += IN_CHUNK) {
      const part = norms.slice(i, i + IN_CHUNK);
      const rows = await db.verificationCheck.findMany({
        where: { emailNorm: { in: part }, checkedAt: { gte: earliest } },
        select: { emailNorm: true, checkedAt: true, reasons: true },
      });
      for (const n of part) this.unreadableSince.delete(n);
      for (const r of rows) {
        if (!isUnreadableRow(r.reasons)) continue;
        const seen = this.unreadableSince.get(r.emailNorm);
        if (!seen || r.checkedAt > seen) this.unreadableSince.set(r.emailNorm, r.checkedAt);
      }
    }
  }

  /**
   * Verify-step runs (§6.1): its answers are for this draft only. Is the campaign still a draft, and which of these
   * people's recipients are still ticked and untouched by a launch (PENDING)?
   */
  private async loadWizardState(personIds: readonly number[]): Promise<void> {
    if (this.payload.source !== "wizard") return;
    const campaignId = this.payload.campaignId;
    const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    this.campaignOpen = campaign?.status === "DRAFT";
    for (let i = 0; i < personIds.length; i += IN_CHUNK) {
      const part = personIds.slice(i, i + IN_CHUNK);
      const rows = await db.campaignRecipient.findMany({
        where: { campaignId, personId: { in: part } },
        select: { personId: true, state: true, included: true },
      });
      for (const id of part) this.wizardPending.delete(id);
      for (const r of rows) if (r.included && r.state === "PENDING") this.wizardPending.add(r.personId);
    }
  }

  /**
   * Right before a paid call (its pool slot taken, maybe after a back-off): the facts the call depends on, read again,
   * so an answer that is no longer needed is never bought (§0.2 rule 11): the person (removed, address edited, checked
   * by another run meanwhile, a newer result) and, for the Verify step, the campaign and this person's recipient.
   */
  private async confirm(key: number): Promise<Decision> {
    if (key > 0) {
      const before = this.people.get(key)?.emailNorm ?? null;
      const fresh = await db.person.findUnique({ where: { id: key }, select: PERSON_SELECT });
      if (fresh) this.people.set(key, fresh);
      else this.people.delete(key);
      if (fresh?.emailNorm && fresh.emailNorm !== before) await this.loadAddressFacts([fresh.emailNorm]);
      if (this.payload.source === "wizard") await this.loadWizardState([key]);
    }
    return this.decide(key);
  }

  // ── 4. skip without calling ──

  private decide(key: number): Decision {
    if (this.payload.source === "settings") {
      const parsed = parseEmail(this.payload.address);
      if (!parsed) return { kind: "skip", counter: "noEmail", skipReason: "no-email" };
      const row = this.checkedInJob.get(parsed.norm);
      if (row) return { kind: "checked", row };
      if (this.carry.single) return { kind: "ignore" };
      return { kind: "call", target: { key, personId: null, companyId: null, email: parsed.email, emailNorm: parsed.norm } };
    }
    const person = this.people.get(key);
    const recheck = this.source === "recheck";
    if (recheck && !this.dueAt.has(key)) return { kind: "ignore" }; // settled meanwhile: nothing waits any more
    // The Verify step's answers are for its draft only: once it is launched (or cancelled, or gone) the run stops.
    if (this.payload.source === "wizard" && !this.campaignOpen) return { kind: "closed" };
    if (!person || person.deletedAt || !person.email || !person.emailNorm) {
      return recheck ? { kind: "settle" } : { kind: "skip", counter: "noEmail", skipReason: person && !person.deletedAt ? "no-email" : null };
    }
    const parsed = parseEmail(person.email);
    if (!parsed) return { kind: "skip", counter: "noEmail", skipReason: "no-email" };
    const suppressed = this.suppression.get(person.emailNorm) ?? null;
    if (suppressed || person.unsubscribedAt || person.bouncedAt || person.complainedAt) {
      return { kind: "skip", counter: "suppressed", skipReason: "suppressed" };
    }
    const row = this.checkedInJob.get(person.emailNorm);
    // A re-check whose paid answer couldn't be read is done: that answer was the re-check.
    if (row) return recheck && isUnreadableRow(row.reasons) ? { kind: "give-up" } : { kind: "checked", row };
    if ((this.carry.timeouts[String(key)] ?? 0) >= MAX_TIMEOUTS) return { kind: "ignore" };
    const target: Target = { key, personId: person.id, companyId: person.companyId, email: person.email, emailNorm: person.emailNorm };
    const real = isRealProvider(person.verificationProvider, this.settings.realProviders);
    const checkedSinceQueued = Boolean(
      person.verifiedAt && real && this.ctx.queuedAt && person.verifiedAt.getTime() >= this.ctx.queuedAt.getTime(),
    );
    if (this.source === "panel") {
      // The panel's "once a day" rule (§10.3 item 22), on fresh data: another run checked this person after the Check
      // was clicked (a Contacts run that had them in its list). Mailgun would answer the same and charge again.
      if (checkedSinceQueued && person.verificationStatus) {
        const status = person.verificationStatus;
        return {
          kind: "checked",
          row: { status, risk: person.verificationRisk ?? "UNKNOWN", isDisposable: person.verificationDisposable, reasons: [] },
          reused: true,
        };
      }
      return { kind: "call", target };
    }
    if (person.company.deletedAt || NEVER_EMAIL_STATUSES.has(person.company.status as CompanyStatusValue)) {
      return { kind: "skip", counter: "neverEmailed", skipReason: "never-emailed" };
    }

    if (recheck) {
      // "No answer" set to Skip: leave them out with the policy sentence, no paid re-check.
      if (this.settings.policy.unknown === "block") return { kind: "settle" };
      const due = this.dueAt.get(key)!;
      // A call can't release anybody any more: the address was edited (its result cleared with it), a result other
      // than "no answer" came meanwhile, one at least as new as the re-check time, or three "no answer"s in a row.
      // Settle as it stands (settleOne words each case).
      if (!person.verifiedAt || person.verificationStatus !== "UNKNOWN") return { kind: "settle" };
      if (person.verifiedAt.getTime() >= due.getTime()) return { kind: "settle" };
      if (person.verificationUnknowns >= MAX_UNKNOWNS_IN_A_ROW) return { kind: "settle" };
      // The waiting emails were made for another address: the answer for this one can't release them.
      const rows = this.recheckRows.get(key) ?? [];
      if (!rows.some((r) => r.due && r.emailNorm === person.emailNorm)) return { kind: "settle" };
      // Its re-check was bought already (by any run) and the answer couldn't be read.
      const unreadableAt = this.unreadableSince.get(person.emailNorm);
      if (unreadableAt && unreadableAt.getTime() >= due.getTime()) return { kind: "give-up" };
      return { kind: "call", target };
    }

    if (checkedSinceQueued) return { kind: "skip", counter: "fresh", skipReason: null };
    if (!this.recheckRecent) {
      const need = checkNeedOf(this.facts(person, suppressed), liveCheckContext(this.settings, this.now()));
      if (need === "none" || need === "wait") return { kind: "skip", counter: "fresh", skipReason: null };
    }
    // The launch has already handled (or someone unticked) this person: the answer can't help this campaign.
    if (this.payload.source === "wizard" && !this.wizardPending.has(key)) return { kind: "skip", counter: null, skipReason: null };
    return { kind: "call", target };
  }

  private facts(p: PersonRow, suppression: SuppressionReasonValue | null): PersonFacts {
    return {
      id: p.id,
      email: p.email,
      emailNorm: p.emailNorm,
      deleted: Boolean(p.deletedAt),
      verificationStatus: p.verificationStatus as VerificationStatusValue | null,
      verificationRisk: p.verificationRisk as RiskValue | null,
      verifiedAt: p.verifiedAt,
      verificationProvider: p.verificationProvider,
      verificationDisposable: p.verificationDisposable,
      verificationUnknowns: p.verificationUnknowns,
      unsubscribedAt: p.unsubscribedAt,
      bouncedAt: p.bouncedAt,
      complainedAt: p.complainedAt,
      suppression,
    };
  }

  /** A person a re-check run handles: remember their RECHECK recipients for the senders' notices. */
  private track(key: number): void {
    for (const r of this.recheckRows.get(key) ?? []) this.recheckTracked.add(r.id);
  }

  private async applyNoCall(key: number, d: Exclude<Decision, { kind: "call" }>): Promise<void> {
    if (this.source === "recheck" && d.kind !== "ignore") {
      this.track(key);
      if (key > 0) {
        if (d.kind === "give-up") await this.leaveOutUnchecked(key);
        else await dbTx((tx) => settleRecheckForPerson(tx, key, this.now(), { policy: this.settings.policy }));
      }
    }
    switch (d.kind) {
      case "skip":
        if (d.counter) this.carry.skipped[d.counter] += 1;
        if (this.single) {
          this.carry.single = {
            personId: key > 0 ? key : null,
            outcome: "skipped",
            skipReason: d.skipReason,
            status: null,
            risk: null,
            disposable: false,
            decision: null,
            ms: null,
            detail: null,
          };
        }
        break;
      case "checked":
        if (d.reused) this.panelReused = true;
        if (this.single && !this.carry.single) {
          const unreadable = Array.isArray(d.row.reasons) && d.row.reasons.includes(UNREADABLE_REASON);
          this.carry.single = this.singleFromResult(
            key > 0 ? key : null,
            { status: d.row.status, risk: d.row.risk, isDisposable: d.row.isDisposable },
            unreadable,
            null,
            null,
          );
        }
        break;
      default:
        break;
    }
    this.finishKey(key);
  }

  /** A single run's outcome from a result (the decision computed with the current policy when the commit gave none). */
  private singleFromResult(
    personId: number | null,
    result: Pick<CheckResult, "status" | "risk" | "isDisposable">,
    unreadable: boolean,
    decision: CheckDecision | null,
    ms: number | null,
  ): CheckSingleOutcome {
    if (unreadable) {
      return {
        personId,
        outcome: "not-reached",
        skipReason: null,
        status: null,
        risk: null,
        disposable: false,
        decision: null,
        ms,
        detail: reasonWords(UNREADABLE_REASON),
      };
    }
    const status = result.status as VerificationStatusValue;
    const risk = result.risk as RiskValue;
    return {
      personId,
      outcome: "checked",
      skipReason: null,
      status,
      risk,
      disposable: result.isDisposable,
      decision: decision ?? checkDecision(status, risk, this.settings.policy, { disposable: result.isDisposable }),
      ms,
      detail: null,
    };
  }

  // ── the pool ──

  private stop(cause: StopCause): void {
    if (this.stopCause) return;
    this.stopCause = cause;
    if (!this.stopController.signal.aborted) this.stopController.abort(new Error("Stopped starting checks"));
  }

  /** Cancel and yield every 10 addresses; the 60 s yield and the shutdown on every one. */
  private async timeToStop(): Promise<boolean> {
    if (this.stopCause) return true;
    if (this.ctx.signal.aborted) {
      this.stop({ kind: "shutdown" });
      return true;
    }
    if (this.clockMs() - this.startedMs >= (this.deps.yieldAfterMs ?? CHECK_YIELD_AFTER_MS) && this.handled > 0) {
      this.stop({ kind: "yield" });
      return true;
    }
    if (this.handled % CHECK_EVERY_ITEMS === 0) {
      if ((await this.ctx.cancelRequested?.()) ?? false) {
        this.stop({ kind: "cancel" });
        return true;
      }
      if (this.handled > 0 && ((await this.ctx.shouldYield?.()) ?? false)) {
        this.stop({ kind: "yield" });
        return true;
      }
    }
    return false;
  }

  /**
   * Hands out the work: skips are handled here one by one, calls start in the pool (at most `pacer.limit` in flight).
   * Always waits for every call in flight before it returns, whatever happened (§0.2 rule 12).
   */
  private async pump(): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    /** The item being handled: on an error it goes back to the pass unless it was finished or its call started. */
    let current: number | null = null;
    try {
      for (;;) {
        current = null;
        if (await this.timeToStop()) break;
        const key = await this.nextKey();
        current = key;
        if (key === null) {
          if (inFlight.size === 0) break;
          await Promise.race(inFlight);
          continue;
        }
        const d = this.decide(key);
        if (d.kind === "call" && this.inFlightNorms.has(d.target.emailNorm)) {
          // Never the same address twice in flight: it waits for the end of the pass.
          this.requeue.push(key);
          if (inFlight.size > 0) await Promise.race(inFlight);
          continue;
        }
        this.handled += 1;
        if (d.kind === "closed") {
          this.campaignClosed(key);
          break;
        }
        if (d.kind !== "call") {
          await this.applyNoCall(key, d);
          continue;
        }
        if (this.source === "recheck") this.track(key);
        const started = await this.startCall(key, inFlight);
        if (started.kind === "started") continue;
        if (started.kind === "stopped") {
          this.putBack.unshift(key);
          break;
        }
        if (started.kind === "requeued") {
          this.requeue.push(key);
          if (inFlight.size > 0) await Promise.race(inFlight);
          continue;
        }
        if (started.decision.kind === "closed") {
          this.campaignClosed(key);
          break;
        }
        await this.applyNoCall(key, started.decision);
      }
      current = null;
    } catch (err) {
      if (current !== null && !this.doneKeys.has(current) && !this.inFlightKeys.has(current) && !this.putBack.includes(current)) {
        this.putBack.unshift(current);
      }
      this.stop({ kind: "error", err });
    } finally {
      await Promise.allSettled([...inFlight]);
    }
  }

  /** A Verify-step run whose campaign isn't a draft any more stops like a Stop: nothing more is bought for it. */
  private campaignClosed(key: number): void {
    this.putBack.unshift(key);
    this.log.info(`Task #${this.jobId}: the campaign isn't a draft any more, so its address checks stop`);
    this.stop({ kind: "cancel" });
  }

  /**
   * Takes a pool slot, confirms on fresh data that the answer is still needed, checks the monthly limit with the calls
   * in flight reserved, and starts the call.
   */
  private async startCall(key: number, inFlight: Set<Promise<void>>): Promise<StartOutcome> {
    try {
      await this.pacer.acquire(this.stopController.signal);
    } catch {
      return { kind: "stopped" };
    }
    if (this.stopCause) {
      // Stopped while this call waited for its slot (another answer paused every run): it isn't started.
      this.pacer.release();
      return { kind: "stopped" };
    }
    let target: Target;
    let cost: number;
    try {
      const d = await this.confirm(key);
      if (d.kind !== "call") {
        this.pacer.release();
        return { kind: "not-needed", decision: d };
      }
      if (this.inFlightNorms.has(d.target.emailNorm)) {
        this.pacer.release();
        return { kind: "requeued" };
      }
      target = d.target;
      cost = await this.priceNextCall();
      if (this.stopCause) {
        this.pacer.release();
        return { kind: "stopped" };
      }
      if (cost > 0 && roundUsd(this.baseUsd + this.sinceUsd + this.reservedUsd + cost) > this.limitUsd) {
        this.pacer.release();
        this.stop({ kind: "monthly" });
        return { kind: "stopped" };
      }
    } catch (err) {
      this.pacer.release();
      throw err;
    }
    this.reservedUsd += cost;
    this.reservedCount += 1;
    this.callsSinceRefresh += 1;
    this.inFlightKeys.add(target.key);
    this.inFlightNorms.add(target.emailNorm);
    const task: Promise<void> = this.callTask(target, cost).finally(() => {
      this.reservedUsd = Math.max(0, this.reservedUsd - cost);
      this.reservedCount = Math.max(0, this.reservedCount - 1);
      this.inFlightKeys.delete(target.key);
      this.inFlightNorms.delete(target.emailNorm);
      this.pacer.release();
      inFlight.delete(task);
    });
    inFlight.add(task);
    return { kind: "started" };
  }

  // ── 5. the monthly budget ──

  /** Reads this month's check spend again when the month changed or after 100 calls (answers in between are added). */
  private async refreshBudget(force = false): Promise<void> {
    const now = this.now();
    const month = monthBounds(now, this.zone);
    const changed = !this.month || this.month.start.getTime() !== month.start.getTime();
    if (!force && !changed && this.callsSinceRefresh < BUDGET_REFRESH_CALLS) return;
    const before = { usd: this.sinceUsd, count: this.sinceCount };
    const spent = await checksThisMonth(now);
    this.month = month;
    this.baseUsd = spent.costUsd;
    this.baseCount = spent.count;
    // Answers stored while the sum was read may be counted twice: never too little.
    this.sinceUsd = Math.max(0, this.sinceUsd - before.usd);
    this.sinceCount = Math.max(0, this.sinceCount - before.count);
    this.callsSinceRefresh = 0;
  }

  /** What the next call costs: the price, or 0 while the plan's included checks aren't used up (in-flight ones counted). */
  private async priceNextCall(): Promise<number> {
    const price = this.verifier.pricePerCheck;
    if (!(price > 0)) return 0;
    await this.refreshBudget();
    const used = this.baseCount + this.sinceCount + this.reservedCount;
    return used < this.included ? 0 : price;
  }

  // ── 6. the call and its outcome ──

  private who(t: Target): string {
    return t.personId !== null ? `person #${t.personId}` : "the test address";
  }

  private async callTask(target: Target, cost: number): Promise<void> {
    try {
      await this.attempt(target, cost, false);
    } catch (err) {
      // Our own bug, not Mailgun's answer: nothing was stored, so it is tried again in the next pass.
      this.log.error(`Task #${this.jobId}: the check of ${this.who(target)} hit a problem`, err);
      this.toPending(target.key);
    }
  }

  private async attempt(target: Target, cost: number, retried: boolean): Promise<void> {
    let out: VerifyOutcome;
    try {
      out = await this.verifier.check(target.email, target.emailNorm);
    } catch (err) {
      this.log.error(`Task #${this.jobId}: the checker failed for ${this.who(target)}`, err);
      out = { ok: false, kind: "transient", retryAfterMs: null, timedOut: false, message: "The check failed.", detail: null };
    }
    if (out.ok) {
      this.pacer.onSuccess();
      await this.onAnswer(target, out, cost);
      return;
    }
    switch (out.kind) {
      case "rejected":
        await this.onRefused(target, out.detail);
        return;
      case "rate-limited": {
        this.pacer.on429(out.retryAfterMs);
        const n = (this.rate429.get(target.key) ?? 0) + 1;
        this.rate429.set(target.key, n);
        if (n >= MAX_RATE_LIMITS_PER_PASS) this.toPending(target.key);
        else this.requeue.push(target.key);
        return;
      }
      case "transient":
        if (out.timedOut) {
          await this.onTimeout(target);
          return;
        }
        if (!retried && !this.stopCause) {
          try {
            await this.sleep(this.deps.transientRetryMs ?? TRANSIENT_RETRY_MS, this.stopController.signal);
          } catch {
            this.toPending(target.key);
            return;
          }
          await this.attempt(target, cost, true);
          return;
        }
        this.toPending(target.key);
        return;
      default: {
        // The key, the account or the request itself: pause every check run; this address is checked after the resume.
        const cause: Extract<StopCause, { kind: "pause" }> = { kind: "pause", pause: out.kind, detail: null };
        this.putBack.push(target.key);
        this.stop(cause);
        this.log.warn(`Task #${this.jobId}: Mailgun refused address checks (${out.kind}); every check run pauses`);
        if (out.detail) cause.detail = await scrubProviderText(out.detail, { address: target.email });
      }
    }
  }

  private async onAnswer(target: Target, out: Extract<VerifyOutcome, { ok: true }>, cost: number): Promise<void> {
    const provider = this.verifier.provider;
    const input: CommitCheckInput = {
      person:
        target.personId !== null && target.companyId !== null
          ? { id: target.personId, companyId: target.companyId, email: target.email, emailNorm: target.emailNorm }
          : null,
      emailNorm: target.emailNorm,
      result: out.result,
      unreadable: out.unreadable,
      provider,
      costUsd: cost,
      jobId: this.jobId,
      source: this.source,
      now: this.now(),
    };
    let res: CommitCheckOutcome;
    try {
      res = await this.commit(input);
    } catch (err) {
      // Paid for and not stored: carried, and stored first on the next run (never bought again).
      this.carry.uncommitted.push({
        personId: target.personId,
        emailNorm: target.emailNorm,
        result: out.result,
        unreadable: out.unreadable,
        provider,
        costUsd: cost,
      });
      this.log.error(`Task #${this.jobId}: the answer for ${this.who(target)} couldn't be saved; it is saved first on the next try`, err);
      this.stop({ kind: "commit" });
      return;
    }
    this.sinceUsd += cost;
    if (isRealProvider(provider, this.settings.realProviders)) this.sinceCount += 1;
    if (out.unreadable) {
      this.carry.unreadableInARow += 1;
      this.log.warn(`Task #${this.jobId}: Mailgun's answer for ${this.who(target)} couldn't be read`);
      if (this.carry.unreadableInARow >= MAX_UNREADABLE_IN_A_ROW) this.stop({ kind: "unreadable" });
      // A re-check paid for with an answer we can't read: that was the re-check. The person is left alone (it isn't a
      // verdict), so without this the sweep's next run would buy it again every 15 minutes until the 72-hour rule.
      if (this.source === "recheck" && target.personId !== null) await this.leaveOutUnchecked(target.personId);
    } else {
      this.carry.unreadableInARow = 0;
    }
    if (this.single) this.carry.single = this.singleFromResult(target.personId, out.result, out.unreadable, res.decision, out.ms);
    this.finishKey(target.key);
  }

  private async onRefused(target: Target, providerDetail: string | null): Promise<void> {
    this.carry.refused += 1;
    if (target.personId !== null && !this.carry.failed.includes(target.personId)) this.carry.failed.push(target.personId);
    const detail = providerDetail ? await scrubProviderText(providerDetail, { address: target.email }) : null;
    this.log.warn(`Task #${this.jobId}: Mailgun refused to check ${this.who(target)}${detail ? ` (${detail})` : ""}`);
    if (this.single) {
      this.carry.single = {
        personId: target.personId,
        outcome: "refused",
        skipReason: null,
        status: null,
        risk: null,
        disposable: false,
        decision: null,
        ms: null,
        detail,
      };
    }
    if (this.source === "recheck" && target.personId !== null) await this.leaveOutUnchecked(target.personId);
    this.finishKey(target.key);
  }

  private async onTimeout(target: Target): Promise<void> {
    const k = String(target.key);
    const n = (this.carry.timeouts[k] ?? 0) + 1;
    this.carry.timeouts[k] = n;
    this.log.warn(`Task #${this.jobId}: the check of ${this.who(target)} timed out (${n} of ${MAX_TIMEOUTS}); Mailgun may have charged for it`);
    if (n < MAX_TIMEOUTS) {
      this.toPending(target.key);
      return;
    }
    this.carry.notReached += 1;
    this.carry.mayBeCharged += 1;
    if (this.single) this.carry.single = this.notReachedSingle(target.personId);
    if (this.source === "recheck" && target.personId !== null) await this.leaveOutUnchecked(target.personId);
    this.finishKey(target.key);
  }

  private notReachedSingle(personId: number | null): CheckSingleOutcome {
    return { personId, outcome: "not-reached", skipReason: null, status: null, risk: null, disposable: false, decision: null, ms: null, detail: null };
  }

  /** Re-check runs: a carried answer that couldn't be read was this person's re-check (their rows loaded if needed). */
  private async giveUpRecheck(personId: number): Promise<void> {
    if (!this.recheckRows.has(personId)) await this.loadRecheckRows([personId]);
    this.track(personId);
    await this.leaveOutUnchecked(personId);
  }

  /**
   * Re-check runs: an address Mailgun refused, that timed out twice, or whose paid answer couldn't be read can't get
   * (another) second check. Its waiting recipients are left out "Address couldn't be checked" now, instead of calling
   * (and maybe paying) again every 15 minutes until the 72-hour rule.
   */
  private async leaveOutUnchecked(personId: number): Promise<void> {
    const recipientIds = (this.recheckRows.get(personId) ?? []).filter((r) => r.due).map((r) => r.id);
    if (recipientIds.length === 0) return;
    try {
      await dbTx((tx) => excludeUnsent(tx, { recipientIds, reason: RECHECK_LEFT_OUT_TEXT.couldntBeChecked, now: this.now() }));
    } catch (err) {
      this.log.error(`Task #${this.jobId}: couldn't leave out person #${personId}'s waiting emails; the 72-hour rule does it later`, err);
    }
  }

  private toPending(key: number): void {
    if (!this.carry.pending.includes(key)) this.carry.pending.push(key);
  }

  /** An address reached its end in this run (stored, skipped, refused or given up). */
  private finishKey(key: number): void {
    if (this.doneKeys.has(key)) return;
    this.doneKeys.add(key);
    this.carry.done += 1;
    void this.ctx.progress(Math.min(this.carry.done, Math.max(this.total, this.carry.done)), Math.max(this.total, this.carry.done)).catch(() => undefined);
  }

  /** Pending addresses that won't be tried again in this run: "couldn't be checked right now". */
  private giveUpPending(): void {
    for (const key of this.carry.pending) {
      this.carry.notReached += 1;
      // A timed-out attempt may have been billed (the request left).
      if ((this.carry.timeouts[String(key)] ?? 0) > 0) this.carry.mayBeCharged += 1;
      if (this.single) this.carry.single = this.notReachedSingle(key > 0 ? key : null);
      this.finishKey(key);
    }
    this.carry.pending = [];
  }

  // ── 7. stops ──

  /** Untried items of this pass go back to the front of the pass, for the next run. */
  private saveBack(): void {
    const back = [...this.putBack, ...this.buffer, ...this.requeue];
    this.putBack = [];
    this.buffer = [];
    this.requeue = [];
    const pending = new Set(this.carry.pending);
    const seen = new Set<number>();
    this.carry.passQueue = [...back, ...this.carry.passQueue].filter((k) => {
      if (k <= 0 || seen.has(k) || this.doneKeys.has(k) || pending.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private async afterStop(cause: StopCause): Promise<VerifyRunResult> {
    // An error is the run's catch's to handle (it keeps this carry); anything else ends a stretch without problems.
    if (cause.kind === "error") throw cause.err;
    if (cause.kind !== "commit") this.carry.commitDefers = 0;
    const now = this.now();
    switch (cause.kind) {
      case "cancel":
        this.saveBack();
        // An answer paid for during the drain but not stored (its commit failed) is stored before the run ends; if it
        // still can't be, the run waits a minute with it (Stop stays requested, so the next run stores it and stops).
        await this.commitCarried();
        this.giveUpPending();
        return this.finish(true);
      case "yield":
      case "shutdown":
        this.saveBack();
        throw new DeferJob(now, "yield", { carry: this.carryJson() });
      case "pause": {
        this.saveBack();
        const text = checkPauseText(cause.pause);
        await pauseChecks(cause.pause, text, cause.detail, { now });
        throw new DeferJob(new Date(now.getTime() + PAUSED_RETRY_MS), "paused", { carry: this.carryJson(), summary: text });
      }
      case "unreadable": {
        this.saveBack();
        const text = checkPauseText("unreadable");
        await pauseChecks("unreadable", text, null, { now });
        throw new DeferJob(new Date(now.getTime() + PAUSED_RETRY_MS), "paused", { carry: this.carryJson(), summary: text });
      }
      case "monthly": {
        this.saveBack();
        const month = monthBounds(now, this.zone);
        const text = checkPauseText("monthly_limit", { limitUsd: this.limitUsd, resetLabel: month.resetLabel });
        await pauseChecks("monthly_limit", text, null, { until: month.end, now });
        throw new DeferJob(month.end, "paused", { carry: this.carryJson(), summary: text });
      }
      case "commit": {
        this.saveBack();
        const at = new Date(now.getTime() + COMMIT_RETRY_MS);
        throw new DeferJob(at, "retry-later", { carry: this.carryJson(), summary: this.waitingText(at) });
      }
    }
  }

  /**
   * Any error after the gate (a database problem in the pool, in a chunk read, in the finish…): the run waits a
   * minute and goes on with the carry it has now, so paid answers not stored yet, time-outs (each may have been
   * billed) and the counters survive. The runner's own retry would restart from the carry this run started with and
   * could try a timed-out address beyond MAX_TIMEOUTS. After MAX_COMMIT_DEFERS problems in a row the error goes to the
   * runner like any other (its tries, then FAILED); carried answers are stored at most once either way (`once`).
   */
  private afterError(err: unknown): never {
    this.saveBack();
    this.carry.commitDefers += 1;
    if (this.carry.commitDefers > MAX_COMMIT_DEFERS) throw err;
    this.log.error(`Task #${this.jobId} hit a problem; it tries again in a minute`, err);
    let nowMs: number;
    try {
      nowMs = this.now().getTime();
    } catch {
      nowMs = Date.now();
    }
    const at = new Date(nowMs + COMMIT_RETRY_MS);
    throw new DeferJob(at, "retry-later", { carry: this.carryJson(), summary: this.waitingText(at) });
  }

  // ── 9. finish ──

  private async finish(stopped: boolean): Promise<VerifyRunResult> {
    // Never end with a paid answer unstored (§0.2 rule 11): store it, or wait a minute with it.
    if (this.carry.uncommitted.length > 0) await this.commitCarried();
    const total = Math.max(this.total, this.carry.done);
    this.carry.recheckRecipients = [...this.recheckTracked];
    const counts = await checkRunCounts(this.jobId, this.carry);
    const summary = stopped
      ? `Stopped after ${this.carry.done.toLocaleString("en-US")} of ${plural(total, "address", "addresses")}.`
      : checkRunSummary(counts);
    await this.ctx.progress(Math.min(this.carry.done, total), total).catch(() => undefined);
    try {
      await this.report(counts, stopped);
    } catch (err) {
      this.log.error(`Task #${this.jobId}: couldn't log or announce the finished checks`, err);
    }
    const out: VerifyRunResult = { summary, counts, carry: this.carry };
    if (this.single && this.carry.single) out.single = this.carry.single;
    if (stopped) out.stopped = true;
    return JSON.parse(JSON.stringify(out)) as VerifyRunResult;
  }

  /** The `verify.run` / `person.checked` activity, the requester's `verify.finished`, and the re-check notices. */
  private async report(counts: CheckRunCounts, stopped: boolean): Promise<void> {
    const p = this.payload;
    const actorId = this.ctx.createdById;
    const actor = actorId ? await db.user.findUnique({ where: { id: actorId }, select: { name: true } }) : null;
    const actorName = actor?.name?.trim() || "Someone";

    if (p.source === "settings") return;
    if (p.source === "panel") {
      await this.reportPanel(actorId, actorName);
      return;
    }
    if (p.source === "recheck") {
      if (counts.checked > 0) {
        await logActivity({
          actorId: null,
          type: "verify.run",
          summary: checkRunActivity("The app", counts, null),
          data: { jobId: this.jobId, source: p.source, checked: counts.checked, costUsd: counts.costUsd },
        });
      }
      await this.reportRechecks();
      return;
    }

    const campaign =
      p.source === "wizard" ? await db.campaign.findUnique({ where: { id: p.campaignId }, select: { id: true, name: true } }) : null;
    await logActivity({
      actorId,
      type: "verify.run",
      summary: checkRunActivity(actorName, counts, campaign?.name ?? null),
      campaignId: campaign?.id ?? null,
      data: { jobId: this.jobId, source: p.source, checked: counts.checked, costUsd: counts.costUsd, stopped },
    });
    if (stopped || !actorId) return;
    const link =
      p.source === "wizard" ? `/campaigns/${p.campaignId}/setup/verify` : p.source === "list" && p.listId ? `/contacts?list=${p.listId}` : "/contacts";
    await notifyUsers([actorId], {
      type: VERIFY_NOTIFICATION.finished,
      title: checkFinishedTitle(campaign?.name ?? null),
      body: checkRunSummary(counts),
      link,
    });
  }

  /** "Ali checked anna@firma.de: can be emailed" (a "doesn't exist" result is already logged by the commit). */
  private async reportPanel(actorId: number | null, actorName: string): Promise<void> {
    const single = this.carry.single;
    // Another run's answer shown again (it checked this person after the Check was clicked): that run logged it.
    if (this.panelReused) return;
    if (!single || single.outcome !== "checked" || !single.status || single.personId === null) return;
    if (single.status === "INVALID" || single.status === "DO_NOT_SEND") return;
    const person = await db.person.findUnique({ where: { id: single.personId }, select: { id: true, companyId: true, email: true } });
    if (!person) return;
    const words = checkResultWords({ status: single.status, risk: single.risk, disposable: single.disposable, decision: single.decision ?? "block" });
    await logActivity({
      actorId,
      type: "person.checked",
      summary: `${actorName} checked ${person.email ?? "an address"}: ${words}`,
      companyId: person.companyId,
      personId: person.id,
      data: { jobId: this.jobId, source: "panel", status: single.status, risk: single.risk, decision: single.decision },
    });
  }

  /**
   * Re-check runs (§2.11): for each campaign where the second check left someone out, one `verify.finished` to its
   * sender ("1 person in Germany Q4 was left out: their address couldn't be checked. 2 others passed…"), and a finish
   * check (the last waiting recipient may have gone). Nothing when everybody passed.
   */
  private async reportRechecks(): Promise<void> {
    const tracked = [...this.recheckTracked];
    if (tracked.length === 0) return;
    const byCampaign = new Map<number, { leftOut: number; released: number }>();
    const released: ReadonlySet<RecipientState> = new Set(["SCHEDULED", "WAITING", "HELD", "FINISHED"]);
    for (let i = 0; i < tracked.length; i += IN_CHUNK) {
      const rows = await db.campaignRecipient.findMany({
        where: { id: { in: tracked.slice(i, i + IN_CHUNK) } },
        select: { campaignId: true, state: true },
      });
      for (const r of rows) {
        const c = byCampaign.get(r.campaignId) ?? { leftOut: 0, released: 0 };
        if (r.state === "EXCLUDED") c.leftOut += 1;
        else if (released.has(r.state)) c.released += 1;
        byCampaign.set(r.campaignId, c);
      }
    }
    for (const [campaignId, c] of byCampaign) {
      if (c.leftOut === 0) continue;
      const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { name: true, senderId: true, createdById: true } });
      if (!campaign) continue;
      const notice = recheckLeftOutNotice(campaign.name, c.leftOut, c.released);
      await notifyUsers([campaign.senderId ?? campaign.createdById], {
        type: VERIFY_NOTIFICATION.finished,
        title: notice.title,
        body: notice.body,
        link: `/campaigns/${campaignId}`,
      });
      await finishCheck(campaignId, { now: this.now() });
    }
  }
}
