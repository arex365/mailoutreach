import { EVENT_BATCH, processPendingMailEvents, type ProcessResult } from "@/server/services/mail-events/process";
import { INBOUND_BATCH } from "@/server/services/replies/process";
import { createThrottledLogger, log as defaultLog, type Logger } from "./log";

/**
 * The event lane (PLAN B8, M3-DESIGN §4.4.3, M4-DESIGN §3.9): every second while this worker holds the lease, it
 * processes the stored Mailgun events (proof of sending, activity, complaint notifications), then the stored replies
 * (linking, classification, stops, holds, notifications: `processPendingInbound`, wired by worker/main.ts).
 * It is a loop of its own, not a job, so a long import never delays it: the send-time guard waits for unprocessed
 * events and replies of an address or company, so they must be handled within a second or two.
 */

export const EVENT_LANE_IDLE_MS = 1_000;

export type EventLaneOptions = {
  /** Checked before each tick. */
  ownsLease: () => Promise<boolean>;
  logger?: Logger;
  now?: () => Date;
  /** Called with the real bounces and complaints after a tick that found some (the worker runs the health check). */
  onProblems?: (p: ProcessResult["problems"]) => Promise<void>;
  /**
   * Processes stored replies (M4-DESIGN §3.9); returns how many it handled (processed + failed). The lane calls it with
   * `limit: INBOUND_BATCH` (20) after the events; worker/main.ts wires `processPendingInbound` with its back-off map.
   */
  processInbound?: (opts: { now: Date; limit: number }) => Promise<number>;
};

/** One lane round: the mail events' result, plus how many replies were handled (0 without `processInbound`). */
export type LaneTickResult = ProcessResult & { inbound: number };

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

/** True when a round filled a batch of events or of replies, so more are probably waiting: go again at once. */
export function laneHasMore(r: Pick<LaneTickResult, "processed" | "inbound"> | null): boolean {
  return r !== null && (r.processed >= EVENT_BATCH || r.inbound >= INBOUND_BATCH);
}

export class EventLane {
  private readonly logger: Logger;
  private readonly throttled: ReturnType<typeof createThrottledLogger>;
  /** Failures per event id, so a bad event is given up after 5 tries (processPendingMailEvents). */
  private readonly failures = new Map<number, number>();
  private current: Promise<unknown> | null = null;

  constructor(private readonly opts: EventLaneOptions) {
    this.logger = opts.logger ?? defaultLog;
    this.throttled = createThrottledLogger(this.logger);
  }

  /**
   * One round: pending events, then pending replies, then `onProblems`. Never throws; null without the lease. A
   * problem with the replies is logged (throttled) and never stops the events, and the other way round.
   */
  async tick(): Promise<LaneTickResult | null> {
    const work = (async (): Promise<LaneTickResult | null> => {
      try {
        if (!(await this.opts.ownsLease())) return null;
        const now = this.opts.now ? this.opts.now() : new Date();
        const result = await processPendingMailEvents({
          now,
          limit: EVENT_BATCH,
          failures: this.failures,
          logger: { error: (m, err) => this.logger.error(m, err) },
        });
        let inbound = 0;
        if (this.opts.processInbound) {
          try {
            inbound = await this.opts.processInbound({ now, limit: INBOUND_BATCH });
            this.throttled.clear("inbound");
          } catch (err) {
            this.throttled.error("inbound", "Processing replies hit a problem", err);
          }
        }
        if (result.problems.bounces > 0 || result.problems.complaints > 0) {
          try {
            await this.opts.onProblems?.(result.problems);
          } catch (err) {
            this.throttled.error("problems", "The health check after new bounces or complaints hit a problem", err);
          }
        }
        this.throttled.clear("tick");
        return { ...result, inbound };
      } catch (err) {
        this.throttled.error("tick", "The event lane hit a problem", err);
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

  /** Runs until `signal` is aborted: straight on after a full batch of events or replies, else a 1 s pause. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const r = await this.tick();
      if (laneHasMore(r)) continue;
      await sleep(EVENT_LANE_IDLE_MS, signal);
    }
  }

  /** Resolves true once no tick is running, or false after `timeoutMs` (shutdown). */
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
