/**
 * Pure helpers behind the Message step's autosave (unit-tested):
 * - `SerialQueue` runs saves strictly one after another;
 * - `SaveResult` says whether a save worked and whether trying again can help;
 * - `retryDelayMs` spaces out retries after the connection dropped.
 */

export type SaveResult = { ok: true } | { ok: false; retryable: boolean; error: string };

export const SAVED: SaveResult = { ok: true };

const noop = () => undefined;

/**
 * Runs tasks one at a time. A task starts only when every task before it has finished, and it is
 * called straight after that check with nothing awaited in between, so whatever its synchronous
 * part reads (the last saved picture of the steps, the follow-up renumbering) is up to date.
 * Without this, two saves waiting for the same slow save both sent the same renumbering, and the
 * server moved people's Review edits twice.
 */
export class SerialQueue<T> {
  private running: Promise<T> | null = null;

  /** True while a task runs. */
  get busy(): boolean {
    return this.running !== null;
  }

  async run(task: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.then(noop, noop);
    const current = task();
    this.running = current;
    try {
      return await current;
    } finally {
      if (this.running === current) this.running = null;
    }
  }

  /** Resolves once nothing runs any more. */
  async idle(): Promise<void> {
    while (this.running) await this.running.then(noop, noop);
  }
}

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];
const MAX_RETRY_DELAY_MS = 60_000;

/** How long to wait before trying again after `failures` failed saves in a row (1 = the first). */
export function retryDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < 1) return RETRY_DELAYS_MS[0]!;
  return RETRY_DELAYS_MS[Math.floor(failures) - 1] ?? MAX_RETRY_DELAY_MS;
}

/**
 * True when a save was refused because the campaign isn't a draft any more (launched, or
 * cancelled, by a teammate or in another tab), or is being launched right now. The wizard then
 * offers the campaign page. Matches the wording of notDraftText() and LAUNCHING_TEXT in the
 * campaigns service (a test keeps them together).
 */
export function isNotDraftError(error: string): boolean {
  return /already been launched|was cancelled|being launched right now/i.test(error);
}
