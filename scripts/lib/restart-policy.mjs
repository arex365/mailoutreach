// When a program started by start.bat stops unexpectedly: wait a little, start it again,
// and wait longer each time it keeps failing. Optionally give up after too many crashes.

export class RestartPolicy {
  /**
   * @param {{ maxRestarts?: number, windowMs?: number, baseDelayMs?: number, maxDelayMs?: number, stableAfterMs?: number }} [options]
   *   maxRestarts: restarts allowed within windowMs (Infinity = never give up)
   *   stableAfterMs: a run that lasted this long resets the back-off
   */
  constructor({ maxRestarts = Infinity, windowMs = 10 * 60_000, baseDelayMs = 1000, maxDelayMs = 60_000, stableAfterMs = 5 * 60_000 } = {}) {
    this.maxRestarts = maxRestarts;
    this.windowMs = windowMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.stableAfterMs = stableAfterMs;
    this.crashTimes = [];
    this.consecutive = 0;
  }

  /**
   * Records a crash at `now` after the program ran for `uptimeMs`.
   * @returns {{ restart: boolean, delayMs: number, recentCrashes: number }}
   */
  crashed(now, uptimeMs = 0) {
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.windowMs);
    this.crashTimes.push(now);
    this.consecutive = uptimeMs >= this.stableAfterMs ? 1 : this.consecutive + 1;
    const recentCrashes = this.crashTimes.length;
    if (recentCrashes > this.maxRestarts) return { restart: false, delayMs: 0, recentCrashes };
    const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.consecutive - 1));
    return { restart: true, delayMs, recentCrashes };
  }
}
