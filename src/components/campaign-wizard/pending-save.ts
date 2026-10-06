/**
 * One change waiting for its (debounced) save. Pure and browser-safe (unit-tested in
 * tests/unit/campaign-wizard). The Schedule step uses it so that leaving the step (its Back link,
 * browser Back, Ctrl+K, a notification) saves a change that is still waiting instead of dropping it.
 */
export class PendingSave<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiting: { value: T } | null = null;

  /** Saves `value` with `run` after `delayMs`, replacing any change still waiting. */
  schedule(value: T, delayMs: number, run: (value: T) => void): void {
    this.clearTimer();
    this.waiting = { value };
    this.timer = setTimeout(() => {
      this.timer = null;
      const w = this.waiting;
      this.waiting = null;
      if (w) run(w.value);
    }, delayMs);
  }

  /** Runs the change still waiting right now, with `run`. Returns false when nothing was waiting. */
  flush(run: (value: T) => void): boolean {
    this.clearTimer();
    const w = this.waiting;
    this.waiting = null;
    if (!w) return false;
    run(w.value);
    return true;
  }

  /** Drops the change still waiting (the caller saves the latest value itself). */
  cancel(): void {
    this.clearTimer();
    this.waiting = null;
  }

  get hasWaiting(): boolean {
    return this.waiting !== null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
