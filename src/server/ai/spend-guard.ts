import { roundUsd } from "@/core/money";

/**
 * The drafting run's spend guard (docs/dev/M5-DESIGN.md §0.3 "Spend guard", §3.3, D30): an in-process check before EVERY
 * Claude call. The job reserves the call's ceiling (the most it can cost) here first; the office month's spend plus
 * everything reserved plus the ceiling must stay within the monthly limit (Setting "ai.monthlyLimitUsd"), and the run's
 * spend likewise within its cap (125 % of the run's "at most" but never below one company's worst case, or the cap
 * rescaled after a model change; `startingRunCap` in run.ts, M5 review AI-3). Once the call
 * has been recorded (`recordCall`), `settle` turns the reservation into the recorded (or estimated) cost.
 *
 * Valid in one process only because only the worker's `ai` lane calls `messages.create`, one job at a time (a unit test
 * asserts `.createLine(` appears only in src/server/ai/** and tests), so the reservations here are all calls in flight.
 * Amounts are dollars rounded with roundUsd (§0.2 rule 10). Pure: no I/O.
 */

/** Which limit a refused call would have passed. */
export type SpendRefusal = "monthly_limit" | "run_cap";

export type SpendGuardInit = {
  /** The office month's AI spend when the handler started (drafts by `draftedAt`). */
  monthSpentUsd: number;
  /** Setting "ai.monthlyLimitUsd". */
  monthLimitUsd: number;
  /** What this run's drafts have recorded so far. */
  runSpentUsd: number;
  /** `carry.runCapUsd ?? startingRunCap(payload, model)` (125 % of "at most", at least one company's worst case). */
  runCapUsd: number;
};

export type SpendGuardState = SpendGuardInit & {
  /** The ceilings of the calls in flight. */
  reservedUsd: number;
  /** How many calls are in flight (reserved, not settled). */
  inFlight: number;
};

/** Float noise allowance: a call that fits exactly is allowed. */
const EPSILON = 1e-9;

/** A usable amount: finite and above zero, else 0. */
function amount(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export class SpendGuard {
  #monthSpent: number;
  #monthLimit: number;
  #runSpent: number;
  #runCap: number;
  readonly #reserved = new Map<number, number>();
  #nextToken = 1;

  constructor(init: SpendGuardInit) {
    this.#monthSpent = roundUsd(amount(init.monthSpentUsd));
    this.#monthLimit = amount(init.monthLimitUsd);
    this.#runSpent = roundUsd(amount(init.runSpentUsd));
    this.#runCap = amount(init.runCapUsd);
  }

  /** The sum of the ceilings of every call in flight. */
  get reservedUsd(): number {
    let sum = 0;
    for (const v of this.#reserved.values()) sum += v;
    return roundUsd(sum);
  }

  /**
   * Before EVERY createLine: reserves the call's ceiling, or says which limit it would pass (the monthly limit is looked
   * at first: it is the Owner's hard limit). A refused call must not be made.
   */
  reserve(ceilingUsd: number): { ok: true; token: number } | { ok: false; why: SpendRefusal } {
    const ceiling = amount(ceilingUsd);
    const reserved = this.reservedUsd;
    if (this.#monthSpent + reserved + ceiling > this.#monthLimit + EPSILON) return { ok: false, why: "monthly_limit" };
    if (this.#runSpent + reserved + ceiling > this.#runCap + EPSILON) return { ok: false, why: "run_cap" };
    const token = this.#nextToken++;
    this.#reserved.set(token, ceiling);
    return { ok: true, token };
  }

  /**
   * After the call was recorded (`recordCall` committed), or after a call that cost nothing (an error answer): the
   * reservation becomes the recorded or estimated cost (0 for an unbilled error). A token settles once; again is a no-op.
   */
  settle(token: number, costUsd: number): void {
    if (!this.#reserved.delete(token)) return;
    const cost = amount(costUsd);
    this.#monthSpent = roundUsd(this.#monthSpent + cost);
    this.#runSpent = roundUsd(this.#runSpent + cost);
  }

  /** The run's cap after a model change (M5-DESIGN §3.3 "The model can change during a run"). */
  setRunCap(usd: number): void {
    this.#runCap = amount(usd);
  }

  /** The monthly limit as saved now (the Owner may raise it during a run). */
  setMonthLimit(usd: number): void {
    this.#monthLimit = amount(usd);
  }

  /** For logs and tests. */
  get state(): SpendGuardState {
    return {
      monthSpentUsd: this.#monthSpent,
      monthLimitUsd: this.#monthLimit,
      runSpentUsd: this.#runSpent,
      runCapUsd: this.#runCap,
      reservedUsd: this.reservedUsd,
      inFlight: this.#reserved.size,
    };
  }
}
