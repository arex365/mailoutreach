/**
 * Pacing (PLAN B6.6, M3-DESIGN §4.1.2): gated emails go out one at a time, spread evenly over the open time left in
 * the cap day, with random gaps so the rhythm doesn't look automated. Pure; the random source is passed in so tests
 * can fix it.
 *
 * The sending loop draws one random factor after each gated send and keeps it; every tick then recomputes the gap
 * after that send from the emails due NOW (the gates, §4.3.2), so a campaign launched meanwhile shortens the wait at
 * once instead of waiting for a gap planned when fewer emails were due.
 */

/** The gap varies by ±50 % around the even spacing. */
export const PACING_JITTER = 0.5;

/** The random factor for one gap, in [0.5, 1.5] (a broken random source gives 1, the even spacing). */
export function jitterFactor(random: () => number): number {
  const r = Number(random());
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
  return 1 - PACING_JITTER + 2 * PACING_JITTER * unit;
}

/**
 * The gap after a gated send, in milliseconds (B6.6): the open time left spread over the emails that may still go
 * today PLUS ONE, `openSecondsLeft / (min(capacityLeft, dueCount) + 1)`, times the drawn factor, never below
 * `minGapSeconds`. N emails over N + 1 intervals keep the last one well inside the window: even at the largest
 * factor (1.5) the gap is at most 3/4 of the open time left, so the last email of the day never lands on the close.
 * `capacityLeft` may be `Infinity` (TEST rows and dry runs have no counted limit): the spacing then depends on
 * `dueCount` only. Returns null when there is nothing to pace: no due emails, no capacity left, or no open time left.
 */
export function paceGapMs(input: {
  openSecondsLeft: number;
  capacityLeft: number;
  dueCount: number;
  minGapSeconds: number;
  /** The drawn factor (jitterFactor); anything outside 0.5–1.5 counts as 1. */
  jitter: number;
}): number | null {
  const { openSecondsLeft, capacityLeft, dueCount } = input;
  if (!(dueCount > 0) || !(capacityLeft > 0) || !(openSecondsLeft > 0)) return null;
  if (!Number.isFinite(openSecondsLeft)) return null;
  const slots = Math.min(capacityLeft, dueCount);
  if (!Number.isFinite(slots)) return null;
  const baseSeconds = openSecondsLeft / (slots + 1);
  const j = Number(input.jitter);
  const factor = Number.isFinite(j) && j >= 1 - PACING_JITTER && j <= 1 + PACING_JITTER ? j : 1;
  const minGapMs = Math.max(0, Number.isFinite(input.minGapSeconds) ? input.minGapSeconds : 0) * 1000;
  return Math.round(Math.max(minGapMs, baseSeconds * factor * 1000));
}

/** paceGapMs with a factor drawn from `random` (one-off callers and tests). */
export function targetGapMs(input: {
  openSecondsLeft: number;
  capacityLeft: number;
  dueCount: number;
  minGapSeconds: number;
  random: () => number;
}): number | null {
  const { random, ...rest } = input;
  return paceGapMs({ ...rest, jitter: jitterFactor(random) });
}
