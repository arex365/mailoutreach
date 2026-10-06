import { checkCatchUpAge } from "@/server/services/mailgun/catch-up";
import { checkPublicAddress, checkTunnel } from "@/server/services/checks/tunnel";
import { createThrottledLogger, log as defaultLog, type Logger } from "./log";

/**
 * The monitor loop (PLAN B8, M3-DESIGN §4.4.5, §4.4.7): while this worker holds the lease it checks remote access and
 * the catch-up's age on its own schedule, because the periodic checker's 10-minute granularity is too coarse:
 *  - cloudflared on this PC every 5 minutes (its version hourly), with the "Remote access is down" notice;
 *  - the public address (health, webhook path, Cloudflare Access) every 30 minutes;
 *  - "The app can't check with Mailgun" when no catch-up succeeded for 3 hours, looked at every 10 minutes.
 * Each check runs once at start. A failing check is logged (at most once a minute) and never stops the others.
 */

export const MONITOR_TICK_MS = 60_000;
export const TUNNEL_EVERY_MS = 5 * 60_000;
export const PUBLIC_EVERY_MS = 30 * 60_000;
export const CATCH_UP_AGE_EVERY_MS = 10 * 60_000;
export const METRICS_EVERY_MS = 60 * 60_000;

export type MonitorLoopOptions = {
  ownsLease: () => Promise<boolean>;
  logger?: Logger;
  now?: () => Date;
  /** Tests: answers the tunnel and public-address requests. */
  fetchImpl?: typeof fetch;
};

export type MonitorTick = { tunnel: boolean; publicAddress: boolean; catchUpAge: boolean };

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

export class MonitorLoop {
  private readonly logger: Logger;
  private readonly throttled: ReturnType<typeof createThrottledLogger>;
  private lastTunnel = Number.NEGATIVE_INFINITY;
  private lastMetrics = Number.NEGATIVE_INFINITY;
  private lastPublic = Number.NEGATIVE_INFINITY;
  private lastCatchUpAge = Number.NEGATIVE_INFINITY;
  private current: Promise<unknown> | null = null;

  constructor(private readonly opts: MonitorLoopOptions) {
    this.logger = opts.logger ?? defaultLog;
    this.throttled = createThrottledLogger(this.logger);
  }

  /** Runs every check that is due. Never throws; null without the lease. */
  async tick(): Promise<MonitorTick | null> {
    const work = (async (): Promise<MonitorTick | null> => {
      try {
        if (!(await this.opts.ownsLease())) return null;
      } catch (err) {
        this.throttled.error("lease", "The monitor couldn't check the lease", err);
        return null;
      }
      const now = this.opts.now ? this.opts.now() : new Date();
      const t = now.getTime();
      const done: MonitorTick = { tunnel: false, publicAddress: false, catchUpAge: false };
      if (t - this.lastTunnel >= TUNNEL_EVERY_MS) {
        this.lastTunnel = t;
        const metrics = t - this.lastMetrics >= METRICS_EVERY_MS;
        if (metrics) this.lastMetrics = t;
        try {
          await checkTunnel({ now, fetchImpl: this.opts.fetchImpl, metrics });
          done.tunnel = true;
          this.throttled.clear("tunnel");
        } catch (err) {
          this.throttled.error("tunnel", "The remote-access check hit a problem", err);
        }
      }
      if (t - this.lastPublic >= PUBLIC_EVERY_MS) {
        this.lastPublic = t;
        try {
          await checkPublicAddress({ now, fetchImpl: this.opts.fetchImpl });
          done.publicAddress = true;
          this.throttled.clear("public");
        } catch (err) {
          this.throttled.error("public", "The public-address check hit a problem", err);
        }
      }
      if (t - this.lastCatchUpAge >= CATCH_UP_AGE_EVERY_MS) {
        this.lastCatchUpAge = t;
        try {
          await checkCatchUpAge({ now });
          done.catchUpAge = true;
          this.throttled.clear("catchup");
        } catch (err) {
          this.throttled.error("catchup", "Checking the Mailgun catch-up's age hit a problem", err);
        }
      }
      return done;
    })();
    this.current = work;
    try {
      return await work;
    } finally {
      if (this.current === work) this.current = null;
    }
  }

  /** Runs until `signal` is aborted, looking once a minute for due checks. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await sleep(MONITOR_TICK_MS, signal);
    }
  }

  /** Resolves true once no check is running, or false after `timeoutMs` (shutdown). */
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
