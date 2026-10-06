import { cancelEmailsOfCancelledCampaigns, resetStuckDryRunSends } from "@/server/services/sending/claim";
import {
  SEND_BATCH,
  runSendingMaintenance,
  sendingTick,
  type RenderFn,
  type SendingDeps,
  type TickResult,
} from "@/server/services/sending/loop";
import type { EmailTransport } from "@/server/services/sending/transport";
import type { MailgunContextResult } from "@/server/mailgun/context";
import type { SendMode } from "@/generated/prisma/client";
import { createThrottledLogger, log as defaultLog, type Logger } from "./log";

/**
 * The sending loop (PLAN.md B8, M3-DESIGN §4.3.3): every 5 s while this worker holds the lease it
 * sends what the gates allow (@/server/services/sending/loop), and every 5 minutes it runs the
 * maintenance (stuck dry-run sends, the follow-up sweeper, reservation expiry, from Milestone 4 the
 * outage-hold retry and the possible-reply holds (M4-DESIGN §2.8), finish checks). It
 * stops between two emails when the worker shuts down or loses its lease; a dry-run email
 * interrupted half-way is put back in the queue by the start-up reset, and a Mailgun email is
 * never aborted mid-request (if the process exits first, the reconciler checks it with Mailgun).
 *
 * `inFlight` holds the ids between claim and outcome, so the reconciler (worker/reconciler.ts)
 * never takes an email the loop is still sending.
 */

export const SENDING_TICK_MS = 5_000;
export const SENDING_MAINTENANCE_MS = 5 * 60_000;

export type SendingLoopOptions = {
  /** Checked before every claim. */
  ownsLease: () => Promise<boolean>;
  logger?: Logger;
  /** When the worker started: Mailgun emails wait for a check with Mailgun after it (the catch-up gate). */
  startedAt?: Date | null;
  /** Tests: a fake transport or render. */
  transportFor?: (mode: SendMode) => EmailTransport;
  render?: RenderFn;
  /** Tests: the Mailgun context (e.g. with fast retries against the fake server). */
  mailgun?: () => Promise<MailgunContextResult>;
  /** Tests: the pacing jitter's random source. */
  random?: () => number;
  now?: () => Date;
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

function describeTick(r: TickResult): string | null {
  const parts: string[] = [];
  if (r.sent) parts.push(`${r.sent} sent`);
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.retried) parts.push(`${r.retried} to try again`);
  if (r.failed) parts.push(`${r.failed} didn't send`);
  if (r.unknown) parts.push(`${r.unknown} to check with Mailgun`);
  if (r.held) parts.push(`${r.held} put back to wait (Mailgun, a pause, a hold or a reply to process)`);
  if (r.finished.length) parts.push(`campaign${r.finished.length === 1 ? "" : "s"} #${r.finished.join(", #")} finished`);
  return parts.length ? `Sending: ${parts.join(", ")}` : null;
}

export class SendingLoop {
  /** Email ids between claim and outcome (the reconciler leaves them alone). */
  readonly inFlight: ReadonlySet<number>;
  private readonly flight = new Set<number>();
  private readonly logger: Logger;
  private readonly throttled: ReturnType<typeof createThrottledLogger>;
  private current: Promise<unknown> | null = null;
  private lastMaintenanceAt = 0;

  constructor(private readonly opts: SendingLoopOptions) {
    this.logger = opts.logger ?? defaultLog;
    this.throttled = createThrottledLogger(this.logger);
    this.inFlight = this.flight;
  }

  private deps(signal: AbortSignal): SendingDeps {
    return {
      ownsLease: this.opts.ownsLease,
      signal,
      logger: this.logger,
      transportFor: this.opts.transportFor,
      render: this.opts.render,
      now: this.opts.now,
      startedAt: this.opts.startedAt ?? null,
      mailgun: this.opts.mailgun,
      random: this.opts.random,
      inFlight: this.flight,
    };
  }

  /** One round: maintenance when due, then the due emails. Never throws. */
  async tick(signal: AbortSignal): Promise<TickResult | null> {
    if (signal.aborted) return null;
    const work = (async () => {
      const nowMs = (this.opts.now ? this.opts.now() : new Date()).getTime();
      if (nowMs - this.lastMaintenanceAt >= SENDING_MAINTENANCE_MS) {
        this.lastMaintenanceAt = nowMs;
        try {
          if (await this.opts.ownsLease()) {
            // A hold step that fails is logged through the worker's logger and skipped (M4-DESIGN §2.10).
            const m = await runSendingMaintenance(new Date(nowMs), { logger: { error: (msg, err) => this.logger.error(msg, err) } });
            const bits: string[] = [];
            if (m.reset) bits.push(`${m.reset} interrupted email(s) put back in the queue`);
            if (m.cancelled) bits.push(`${m.cancelled} email(s) of cancelled campaigns cancelled`);
            if (m.sweep.created || m.sweep.finished) bits.push(`follow-ups repaired: ${m.sweep.created} created, ${m.sweep.finished} finished`);
            if (m.expiredReservations) bits.push(`${m.expiredReservations} reservation(s) expired`);
            if (m.outageHold?.applied) bits.push(`${m.outageHold.held} person(s) put on hold after the PC was off`);
            if (m.possibleReplyHeld) bits.push(`${m.possibleReplyHeld} person(s) put on hold for a possible reply`);
            if (m.outageReleased) bits.push(`${m.outageReleased} first email(s) released after the PC was off`);
            if (m.finished.length) bits.push(`campaign(s) #${m.finished.join(", #")} finished`);
            if (bits.length) this.logger.info(`Sending maintenance: ${bits.join("; ")}`);
            this.throttled.clear("maintenance");
          }
        } catch (err) {
          this.throttled.error("maintenance", "The sending maintenance hit a problem", err);
        }
      }
      try {
        const r = await sendingTick(this.deps(signal));
        const line = describeTick(r);
        if (line) this.logger.info(line);
        this.throttled.clear("tick");
        return r;
      } catch (err) {
        this.throttled.error("tick", "The sending loop hit a problem", err);
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

  /** Runs until `signal` is aborted (shutdown or lease lost). */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const r = await this.tick(signal);
      // A full batch means more is due: go again straight away (still between emails, so a stop is quick).
      if (r && r.picked >= SEND_BATCH && !r.stopped && r.sent + r.skipped > 0) continue;
      await sleep(SENDING_TICK_MS, signal);
    }
  }

  /** Resolves true once no email is being processed, or false after `timeoutMs`. */
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

/**
 * Start-up (B8): dry-run emails left "Sending" by a stopped worker go back to the queue (or are
 * cancelled when their campaign was cancelled meanwhile), and emails still waiting in cancelled
 * campaigns are cancelled. Mailgun emails left "Sending" are the reconciler's (never reset).
 */
export async function resetInterruptedDryRunSends(logger: Logger = defaultLog, now: Date = new Date()): Promise<number> {
  const n = await resetStuckDryRunSends(now);
  if (n > 0) logger.info(`Put ${n} interrupted dry-run email${n === 1 ? "" : "s"} back in the queue`);
  const cancelled = await cancelEmailsOfCancelledCampaigns();
  if (cancelled > 0) logger.info(`Cancelled ${cancelled} email${cancelled === 1 ? "" : "s"} still waiting in cancelled campaigns`);
  return n;
}
