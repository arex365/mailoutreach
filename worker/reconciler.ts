import { RECONCILE_INTERVAL_MS, reconcileSends, type ReconcileResult } from "@/server/services/sending/reconcile";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { createThrottledLogger, log as defaultLog, type Logger } from "./log";

/**
 * The reconciler loop (PLAN B6.7, B8, M3-DESIGN §4.3.6): right after the worker takes the lease,
 * then every 10 minutes, it settles every test-mode and live email whose outcome isn't known with
 * Mailgun (@/server/services/sending/reconcile). It never touches an email the sending loop is still
 * sending (`inFlight`, wired from SendingLoop.inFlight by the worker), and never throws: a Mailgun
 * problem simply leaves the emails for the next pass.
 */

export type ReconcilerLoopOptions = {
  /** Checked before every pass. */
  ownsLease: () => Promise<boolean>;
  logger?: Logger;
  now?: () => Date;
  /** Tests: the Mailgun context (e.g. with fast retries against the fake server). */
  mailgun?: () => Promise<MailgunContextResult>;
  /** Ids the sending loop has between claim and outcome. */
  inFlight?: ReadonlySet<number>;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(r: ReconcileResult): string | null {
  const parts: string[] = [];
  if (r.sent) parts.push(`${r.sent} recorded as sent`);
  if (r.requeued) parts.push(`${r.requeued} never reached Mailgun and will be sent again`);
  if (r.cancelled) parts.push(`${r.cancelled} cancelled (campaign ended)`);
  if (r.unconfirmed) parts.push(`${r.unconfirmed} need a person's decision`);
  if (r.stillUnknown) parts.push(`${r.stillUnknown} still being checked`);
  return parts.length ? `Checked with Mailgun: ${parts.join(", ")}` : null;
}

export class ReconcilerLoop {
  private readonly logger: Logger;
  private readonly throttled: ReturnType<typeof createThrottledLogger>;
  private current: Promise<unknown> | null = null;

  constructor(private readonly opts: ReconcilerLoopOptions) {
    this.logger = opts.logger ?? defaultLog;
    this.throttled = createThrottledLogger(this.logger);
  }

  /** One pass (when this worker holds the lease). Never throws; null when nothing ran. */
  async tick(signal?: AbortSignal): Promise<ReconcileResult | null> {
    if (signal?.aborted) return null;
    const work = (async () => {
      try {
        if (!(await this.opts.ownsLease())) return null;
        const r = await reconcileSends({
          now: this.opts.now ? this.opts.now() : new Date(),
          mailgun: this.opts.mailgun,
          inFlight: this.opts.inFlight,
          signal,
        });
        const line = describe(r);
        if (line) this.logger.info(line);
        if (r.error) this.throttled.error("reconcile-mailgun", "Couldn't check every email with Mailgun", r.error);
        else this.throttled.clear("reconcile-mailgun");
        this.throttled.clear("reconcile");
        return r;
      } catch (err) {
        this.throttled.error("reconcile", "The check of unsure emails hit a problem", err);
        return null;
      }
    })();
    this.current = work;
    try {
      return await work;
    } finally {
      if (this.current === work) this.current = null;
    }
  }

  /** First pass right away, then every 10 minutes, until `signal` is aborted. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick(signal);
      await sleep(RECONCILE_INTERVAL_MS, signal);
    }
  }

  /** Resolves true once no pass is running, or false after `timeoutMs`. */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const cur = this.current;
    if (!cur) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([cur.then(() => true as const, () => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
