import { CHECK_CONCURRENCY_MAX } from "@/core/verification/types";

/**
 * How many address checks the check job has in flight, and when it may start the next one (docs/dev/M5-DESIGN.md
 * §2.5.1, research verification-reference §4). Mailgun limits validations by requests in flight and publishes no
 * number, so the pacer adapts:
 *  - it starts at min(2, the setting "verification.concurrency", 1–4);
 *  - a 429 drops the limit to 1 and pauses new starts for Mailgun's own wait hint when it gave one, otherwise for
 *    2 s × 2^n (n = the 429s in a row before this one, ±20 % jitter), never longer than 60 s;
 *  - 25 answers in a row without a 429 add one back, up to the setting.
 * The job itself keeps the same address from being in flight twice. No I/O: the clock, the sleep and the random
 * source are injected, so the rules are unit-tested with a fake clock.
 */

/** Where the limit starts (the setting may allow up to 4). */
export const PACER_START_LIMIT = 2;
/** Answers in a row without a 429 before one more check may run at once. */
export const PACER_CLIMB_AFTER = 25;
/** The first back-off after a 429 without a wait hint. */
export const PACER_BASE_WAIT_MS = 2_000;
/** The longest pause of new starts after a 429 (also caps Mailgun's own hint). */
export const PACER_MAX_WAIT_MS = 60_000;
/** ±20 % jitter on the computed back-off. */
export const PACER_JITTER = 0.2;

export type CheckPacerOptions = {
  /** Setting "verification.concurrency" (clamped to 1–4). */
  max: number;
  /** Milliseconds now (default Date.now). */
  now?: () => number;
  /** Waits `ms`, or rejects when `signal` aborts (default a timer). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A number in [0, 1) for the jitter (default Math.random). */
  random?: () => number;
};

/** The reason a wait ended early: the job stopped starting checks. */
function abortReason(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error ? r : new Error("Stopped");
}

/** A timer that ends early (rejecting) when `signal` aborts. */
export function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clampMax(max: number): number {
  const n = Math.floor(Number(max));
  return Number.isFinite(n) ? Math.min(CHECK_CONCURRENCY_MAX, Math.max(1, n)) : PACER_START_LIMIT;
}

export class CheckPacer {
  private readonly max: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private current: number;
  private inFlight = 0;
  private pausedUntil = 0;
  private successes = 0;
  private rateLimits = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: CheckPacerOptions) {
    this.max = clampMax(opts.max);
    this.nowMs = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? sleepFor;
    this.random = opts.random ?? Math.random;
    this.current = Math.min(PACER_START_LIMIT, this.max);
  }

  /** Checks allowed in flight right now. */
  get limit(): number {
    return this.current;
  }

  /** Checks in flight right now (acquired and not yet released). */
  get active(): number {
    return this.inFlight;
  }

  /** New starts wait until this instant (ms), after a 429. */
  get resumeAt(): number {
    return this.pausedUntil;
  }

  /**
   * Waits until one more check may start (fewer than `limit` in flight, and any 429 pause is over), then counts it as
   * in flight. Rejects when `signal` aborts (the job stopped starting checks); nothing is counted then.
   */
  async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const wait = this.pausedUntil - this.nowMs();
      if (wait > 0) {
        await this.sleep(wait, signal);
        continue;
      }
      if (this.inFlight < this.current) {
        this.inFlight += 1;
        return;
      }
      await this.waitForRoom(signal);
    }
  }

  /** A check that `acquire` let start has ended (answered, failed or given up). */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    this.wake();
  }

  /** An answer came back (any 200): 25 in a row without a 429 add one more check in flight, up to the setting. */
  onSuccess(): void {
    this.rateLimits = 0;
    this.successes += 1;
    if (this.successes >= PACER_CLIMB_AFTER && this.current < this.max) {
      this.current += 1;
      this.successes = 0;
      this.wake();
    }
  }

  /**
   * Mailgun answered 429: one check at a time from now on, and no new start for Mailgun's hint (`retryAfterMs`) or,
   * without one, 2 s × 2^n with ±20 % jitter (n = 429s in a row before this one), at most 60 s.
   */
  on429(retryAfterMs: number | null): void {
    this.successes = 0;
    this.rateLimits += 1;
    this.current = 1;
    const wait =
      retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(PACER_MAX_WAIT_MS, retryAfterMs)
        : this.backoffMs();
    this.pausedUntil = Math.max(this.pausedUntil, this.nowMs() + wait);
  }

  /** The computed wait after a 429 without a hint. */
  private backoffMs(): number {
    const base = Math.min(PACER_MAX_WAIT_MS, PACER_BASE_WAIT_MS * 2 ** Math.max(0, this.rateLimits - 1));
    const r = this.random();
    const jitter = 1 + PACER_JITTER * (2 * (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5) - 1);
    return Math.min(PACER_MAX_WAIT_MS, Math.round(base * jitter));
  }

  private waitForRoom(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(abortReason(signal));
      };
      this.waiters.push(done);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Lets every waiting `acquire` look again (a slot freed up, or the limit rose). */
  private wake(): void {
    const list = this.waiters;
    this.waiters = [];
    for (const w of list) w();
  }
}
