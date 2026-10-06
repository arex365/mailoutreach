/**
 * Retry schedule for failed background tasks (pure, unit-tested):
 * 1 minute after the first failure, 5 minutes after the second, 15 minutes after that.
 */

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** Delay before the next try, given how many attempts have been made so far (1-based). */
export function retryDelayMs(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index]!;
}

export function nextRetryAt(now: Date, attemptsMade: number): Date {
  return new Date(now.getTime() + retryDelayMs(attemptsMade));
}

/** Whether a failed attempt may be tried again. */
export function canRetry(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade < maxAttempts;
}
