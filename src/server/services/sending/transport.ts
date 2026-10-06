import type { SendMode } from "@/generated/prisma/client";
import type { PauseKind } from "@/core/system-state";
import type { MailgunContextResult } from "@/server/mailgun/context";
import type { SendGuard } from "@/server/mailgun/types";
import { MailgunTransport } from "./mailgun-transport";

/**
 * Every email leaves through an EmailTransport (PLAN.md B6.8, M3-DESIGN §4.3.1). Dry runs use the
 * dry-run transport: nothing goes over the network, the email is simply "accepted" and the stored
 * row is what the dry-run outbox shows. Test mode and live campaigns go to Mailgun through
 * MailgunTransport (./mailgun-transport), which the sending loop only builds for the one gated
 * email of a tick (sending hours, limits, pacing and the final check all passed).
 *
 * A Mailgun transport never throws anything but TransportError, whose `failure` says exactly what
 * happened, so the loop can tell "Mailgun said no to this email" from "Mailgun may have it"
 * (§4.3.5): only the second one can hide an accepted email.
 */

export type OutgoingMessage = {
  emailId: number;
  campaignId: number;
  step: number;
  /**
   * The full From line, e.g. "Ali from Polygon Paradise <ali@send.example.com>"; in shared-From mode the shared address
   * with the sender's display name, "Ali from Polygon Paradise <contact@example.com>" (SHARED-FROM-DESIGN §2.3).
   */
  from: string;
  /** The address as typed on the person (shown in logs). */
  to: string;
  /** The normalised address: exactly what Mailgun gets (and what the test-list guard checks). */
  toNorm: string;
  subject: string;
  text: string;
  html: string;
  /** Stored without angle brackets. */
  messageId: string;
  inReplyTo: string | null;
  /** Space-separated earlier Message-IDs, oldest first, without angle brackets. */
  references: string | null;
  sendId: string;
  /**
   * The row's Reply-To (OutboundEmail.replyTo): the sender's own address on the sending domain in shared-From mode,
   * where replies land; null in per-person mode. The Mailgun domain is `mailgunDomainOf(from, replyTo)`, and the
   * transport refuses a From off the sending domain without a Reply-To on it (fail closed, SHARED-FROM-DESIGN §2.4).
   */
  replyTo?: string | null;
  /**
   * M6-DESIGN §2.3: `testListOnly(mode, campaign.launchedGoLive === true)`, from the loop's claimed row: test mode for
   * good, and a live campaign launched before go-live, may only reach the test list. The Mailgun client's guard judges
   * it again; missing counts as true (fail closed).
   */
  testListOnly?: boolean;
};

export type TransportResult = {
  /** The provider's id for the accepted message (Mailgun: lowercase, no angle brackets). */
  providerId: string;
  /** When the provider accepted it (defaults to now). */
  acceptedAt?: Date;
};

export interface EmailTransport {
  /** Which campaigns it sends for. */
  readonly mode: SendMode;
  /** Hands the email over. Resolves once accepted; throws when it wasn't. */
  send(message: OutgoingMessage): Promise<TransportResult>;
}

/** What went wrong with one send, as the sending loop acts on it (M3-DESIGN §4.3.1, §4.3.5). */
export type TransportFailure =
  /** A 4xx "no" about this one email (400 …); nothing was accepted. `message` is Mailgun's own text. */
  | { kind: "rejected"; message: string; detail: string | null }
  /** 429: Mailgun asked us to slow down. */
  | { kind: "rate-limited"; retryAt: Date; message: string }
  /** 401/403, business verification, not allowed/disabled/suspended, 402/409: an account-level answer. */
  | { kind: "pause"; pause: PauseKind; reason: string; fixText: string; mailgunMessage: string }
  /** 404 on the send (may be temporary; the domain check decides whether to pause). */
  | { kind: "not-found"; message: string }
  /** Mailgun may have it: timeout, network, 5xx, 3xx, 2xx without an id, anything else after the request started. */
  | { kind: "ambiguous"; message: string }
  /**
   * Nothing left this PC. `guard` = the client's own test-list guard refused the address (the loop
   * skips the row "not on the test list"); `pause` = a problem the Owner must fix first.
   */
  | {
      kind: "blocked";
      message: string;
      guard?: boolean;
      pause?: { kind: PauseKind; reason: string; fixText: string };
    };

/** A failure's sentence for logs ("pause" carries Mailgun's text and our reason instead). */
export function failureText(failure: TransportFailure): string {
  return failure.kind === "pause" ? failure.mailgunMessage || failure.reason : failure.message;
}

/** Thrown by a transport; `failure` says what happened. */
export class TransportError extends Error {
  constructor(readonly failure: TransportFailure) {
    super(failureText(failure));
    this.name = "TransportError";
  }
}

export function isTransportError(err: unknown): err is TransportError {
  return err instanceof TransportError;
}

/** Dry run: nothing is sent anywhere. The email counts as accepted straight away. */
export class DryRunTransport implements EmailTransport {
  readonly mode = "DRY_RUN" as const;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async send(message: OutgoingMessage): Promise<TransportResult> {
    return { providerId: `dry-run:${message.messageId}`, acceptedAt: this.clock() };
  }
}

/** Modes the sending loop can send in (TEST and LIVE only through the gates, M3-DESIGN §4.3.3). */
export const SENDABLE_MODES: readonly SendMode[] = ["DRY_RUN", "TEST", "LIVE"];

/** Why a Mailgun email couldn't go out through a transport that has no Mailgun behind it. */
export const MAILGUN_NOT_READY = "Mailgun isn't connected, so this email wasn't sent. It stays in the queue.";

/** A transport that refuses every email without sending anything (Mailgun missing, or the practice copy). */
class BlockedTransport implements EmailTransport {
  constructor(
    readonly mode: SendMode,
    private readonly message: string,
  ) {}

  async send(): Promise<TransportResult> {
    throw new TransportError({ kind: "blocked", message: this.message });
  }
}

/**
 * The transport factory for one tick of the sending loop: dry runs get the dry-run transport; TEST
 * and LIVE get MailgunTransport on the connected context, or a transport that refuses everything
 * (nothing leaves the PC) when Mailgun isn't connected or this is the practice copy.
 */
export function makeTransportFactory(
  ctx: MailgunContextResult,
  opts: { practiceCopy?: boolean; guard: SendGuard; now?: () => Date },
): (mode: SendMode) => EmailTransport {
  const dryRun = new DryRunTransport(opts.now);
  return (mode: SendMode): EmailTransport => {
    if (mode === "DRY_RUN") return dryRun;
    if (opts.practiceCopy) return new BlockedTransport(mode, "The practice copy never sends real email.");
    if (!ctx.connected) return new BlockedTransport(mode, ctx.text || MAILGUN_NOT_READY);
    return new MailgunTransport({ mode, context: ctx, guard: opts.guard, now: opts.now });
  };
}

/**
 * Kept for Milestone 2 callers and tests: DRY_RUN only. TEST and LIVE return a transport that
 * throws TransportError "blocked" (nothing is sent): Mailgun emails only go out through the
 * sending loop's gates, which build their transport with makeTransportFactory.
 */
export function transportFor(mode: SendMode): EmailTransport {
  if (mode === "DRY_RUN") return new DryRunTransport();
  return new BlockedTransport(mode, MAILGUN_NOT_READY);
}
