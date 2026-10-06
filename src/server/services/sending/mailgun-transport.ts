import { normalizeEmail } from "@/core/email-address";
import { PLAN_TEXTS } from "@/core/mailgun/plan";
import {
  domainOfAddress,
  fromAddressOf,
  mailgunDomainOf,
  messageIdDomainOf as idDomainOf,
  senderHeaderProblem,
} from "@/core/sending/from-address";
import { db } from "@/server/db";
import { notifyOwner } from "@/server/notifications";
import { shouldSendNotice } from "@/server/state-typed";
import { SEND_OPTIONS_MAX_BYTES, bareMessageId } from "@/server/mailgun/client";
import { clientFor, type MailgunContext } from "@/server/mailgun/context";
import { AUTH_TEXT, BUSINESS_VERIFICATION_TEXT, isAuthorizedOnlyRefusal, isMailgunError } from "@/server/mailgun/errors";
import type { MailgunRegion, SendGuard, SendMessageInput } from "@/server/mailgun/types";
import {
  TransportError,
  type EmailTransport,
  type OutgoingMessage,
  type TransportFailure,
  type TransportResult,
} from "./transport";

/**
 * Test mode and live campaign emails go to Mailgun here (PLAN B6.7, B6.8, M3-DESIGN §4.3.1).
 *
 * Before the request, nothing leaves the PC when: the address isn't one bare, normalised address
 * ("rejected"), the From address isn't on a connected sending domain, or the email's extra fields
 * are too large for Mailgun (both "blocked" with a Mailgun-settings pause, because every email
 * after it would fail the same way). The client itself re-checks the test-list guard.
 *
 * Shared From address (SHARED-FROM-DESIGN §2.3, §2.4, fail closed): the Mailgun domain of an email is
 * `mailgunDomainOf(from, replyTo)` (the Reply-To's domain when there is one; per-person: the From's, as before), and it
 * must have a SendingDomain row (else NOT_ON_DOMAIN). The From and Reply-To must then fit that domain
 * (`senderHeaderProblem`), and a shared-From email (From off the domain) must carry a Message-ID on it; otherwise
 * nothing is sent and sending pauses with the "From or reply address" sentence. The client runs the same sender check
 * (kind "sender", mapped to the same pause).
 *
 * The request: `to` is the bare normalised address (what the guard checked), tags "outreach" and
 * "step-N", variables send_id/campaign_id/step (opaque ids), Mailgun's test mode for TEST
 * campaigns; the client adds tracking-opens/-clicks "no" to every send. Never o:tracking,
 * o:deliverytime, o:suppress-headers or h:List-Unsubscribe here: the one List-Unsubscribe the app ever sends (own-mailbox
 * mode with unsubscribe by email left out, review REPLIES-03) is added by `MailgunClient.sendMessage` itself, so campaign
 * emails, test emails and the reply test carry the same header.
 *
 * Every failure becomes a TransportError whose `failure` the sending loop acts on (§4.3.5).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O6, §2.4, the context's `replies`): the sender check compares with the context's
 * `ownMailboxFrom` (only today's own From, on the domain, no Reply-To; "" refuses everything) and the Message-ID must be
 * on the domain too. A refusal is "blocked" with the same pause and `ownMailbox: true`, so the loop fails a row blocked
 * a second time for good instead of pausing again (O35). A send refused because the plan's sending limit is reached
 * (kind "limit", O24) pauses and puts the email back; a free account limited to authorized recipients pauses with its
 * own sentence (O25, every mode).
 */

/** Moved to @/core/sending/from-address (SHARED-FROM-DESIGN §7.5); re-exported so every existing import keeps working. */
export { domainOfAddress, fromAddressOf };

const NOT_A_BARE_ADDRESS = /[,;<>"\s]/;

/**
 * The Mailgun request for one campaign email. `to` is `message.toNorm`, after checking that the
 * person's address normalises to exactly it and that it is one bare address (no list, no display
 * name): otherwise TransportError "rejected" and nothing is sent.
 *
 * `testListOnly` (M6-DESIGN §2.3) tells the client's guard whether this email may only reach the test list: always in
 * test mode, and for a live email whenever the message doesn't say `testListOnly: false` (the loop sets it from the
 * campaign's launch flag), so a message without the flag fails closed.
 */
export function buildSendInput(message: OutgoingMessage, mode: "TEST" | "LIVE", guard: SendGuard): SendMessageInput {
  const to = message.toNorm;
  if (!to || NOT_A_BARE_ADDRESS.test(to) || normalizeEmail(message.to) !== to) {
    throw new TransportError({ kind: "rejected", message: "This email's address isn't a single valid address.", detail: null });
  }
  return {
    from: message.from,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    replyTo: message.replyTo ?? null,
    tags: ["outreach", `step-${message.step}`],
    variables: { send_id: message.sendId, campaign_id: String(message.campaignId), step: String(message.step) },
    testMode: mode === "TEST",
    testListOnly: mode === "TEST" || message.testListOnly !== false,
    purpose: "campaign",
    guard,
  };
}

/**
 * Bytes of every `o:`, `h:` and `v:` field Mailgun will get for this email (the client adds the
 * two tracking fields and the angle brackets the same way). Mailgun refuses more than 16 KB.
 */
export function sendOptionBytes(input: SendMessageInput): number {
  const ids = (v: string | null | undefined) =>
    (v ?? "")
      .split(/\s+/)
      .map(bareMessageId)
      .filter(Boolean)
      .map((id) => `<${id}>`)
      .join(" ");
  const options: Array<[string, string]> = [["h:Message-Id", `<${bareMessageId(input.messageId)}>`]];
  if (ids(input.inReplyTo)) options.push(["h:In-Reply-To", ids(input.inReplyTo)]);
  if (ids(input.references)) options.push(["h:References", ids(input.references)]);
  if (input.replyTo) options.push(["h:Reply-To", input.replyTo]);
  options.push(["o:tracking-opens", "no"], ["o:tracking-clicks", "no"]);
  for (const tag of input.tags) options.push(["o:tag", tag]);
  for (const [name, value] of Object.entries(input.variables)) options.push([`v:${name}`, value]);
  if (input.testMode) options.push(["o:testmode", "yes"]);
  return options.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
}

const NOT_ON_DOMAIN = {
  kind: "mailgun-settings" as const,
  reason: "a sender's address isn't on a sending domain",
  fixText: "The sender's address isn't on a connected sending domain. Check Settings › Sending & Mailgun, then click Resume.",
};

const TOO_LARGE = {
  kind: "mailgun-settings" as const,
  reason: "an email's extra fields are too large for Mailgun",
  fixText: "An email's extra fields are too large for Mailgun. This is a bug in the app: tell us, then click Resume.",
};

/**
 * SHARED-FROM-DESIGN §2.4 (fail closed): an email's From or Reply-To doesn't fit the Mailgun domain it goes through, or
 * a shared-From email's Message-ID is on another domain. Nothing is sent; the row goes back to the queue.
 */
export const SENDER_HEADERS_PAUSE = {
  kind: "mailgun-settings" as const,
  reason: "an email's From or reply address doesn't fit the sending domain",
  fixText:
    "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then click Resume.",
};

/**
 * A "blocked" failure of the own-mailbox sender check (MAIN-DOMAIN-DESIGN O35): the loop fails a row blocked twice in a
 * row for good (`OWN_MAILBOX_TEXTS.senderBlockedTwice`) instead of pausing again. The flag rides on the failure object
 * (TransportFailure itself is unchanged); read it with `isOwnMailboxBlock`.
 */
export type OwnMailboxBlocked = Extract<TransportFailure, { kind: "blocked" }> & { ownMailbox: true };

/** The failure of an own-mailbox email the sender check refused (nothing was sent). */
export function ownMailboxBlocked(message: string): OwnMailboxBlocked {
  return { kind: "blocked", message, pause: SENDER_HEADERS_PAUSE, ownMailbox: true };
}

/** True for a failure raised by the own-mailbox sender check (`ownMailboxBlocked`). */
export function isOwnMailboxBlock(failure: TransportFailure): boolean {
  return failure.kind === "blocked" && (failure as { ownMailbox?: unknown }).ownMailbox === true;
}

/** The pause sentence for a key Mailgun refused (§5.9), pointing at where the key is pasted. */
export const AUTH_PAUSE_FIX =
  "Mailgun didn't accept the API key. In Mailgun, open API Security, create a key with the Developer role, paste it in Settings › Sending & Mailgun, then click Resume.";

/**
 * Appended to the key pause's fix text when a shared-From email was refused while the domain sending key sends
 * (SHARED-FROM-DESIGN §2.4, §11 Q7: whether a domain sending key may send a From on another domain isn't confirmed).
 * It names the button that removes only the sending key (review SCREENS-01; `removeSendingKeyAction`).
 */
export const SENDING_KEY_TEAM_FROM_FIX =
  " If this started after the From address was set, remove the domain sending key (Settings › Sending & Mailgun › Advanced › Remove the sending key) and click Resume: the API key sends then.";

/**
 * A Mailgun client error → what the loop does (the table in M3-DESIGN §4.3.1). Anything that isn't a
 * MailgunError counts as "ambiguous": the request may have started, so Mailgun may have the email.
 * `teamFromWithSendingKey` (SHARED-FROM-DESIGN §2.4): the email was a shared-From one sent with the domain sending
 * key; a key Mailgun refused then says how to send with the API key instead.
 */
export function mailgunFailure(err: unknown, ctx: { domain: string; now: Date; teamFromWithSendingKey?: boolean }): TransportFailure {
  if (!isMailgunError(err)) {
    const text = err instanceof Error ? err.message : String(err);
    return { kind: "ambiguous", message: `Unexpected problem while handing the email to Mailgun: ${text}` };
  }
  const said = err.mailgunMessage || err.message;
  // Before the kind: a 5xx or 3xx answer (or a timeout) may have sent the email, whatever its text says. Only a 4xx or
  // a request that never started is a definite "no" (errors.ts `ambiguous`).
  if (err.ambiguous) return { kind: "ambiguous", message: err.message };
  switch (err.kind) {
    case "guard":
      return { kind: "blocked", message: err.message, guard: true };
    case "sender":
      // The client's own sender check (no request was made): the same pause as the transport's own check.
      return { kind: "blocked", message: err.message, pause: SENDER_HEADERS_PAUSE };
    case "rejected":
      return { kind: "rejected", message: said, detail: err.message };
    case "rate-limited":
      return { kind: "rate-limited", retryAt: new Date(ctx.now.getTime() + (err.retryAfterMs ?? 60_000)), message: said };
    case "auth":
      return {
        kind: "pause",
        pause: "mailgun-auth",
        reason: "Mailgun didn't accept the API key",
        fixText: err.requestStarted
          ? AUTH_PAUSE_FIX + (ctx.teamFromWithSendingKey === true ? SENDING_KEY_TEAM_FROM_FIX : "")
          : `${err.message} Then click Resume.`,
        mailgunMessage: said || AUTH_TEXT,
      };
    case "business-verification":
      return {
        kind: "pause",
        pause: "mailgun-verification",
        reason: "Mailgun business verification",
        fixText: BUSINESS_VERIFICATION_TEXT,
        mailgunMessage: said,
      };
    case "not-allowed":
      // MAIN-DOMAIN-DESIGN O25 (every mode): a free account that may only send to authorized recipients. The campaign
      // sentence only suggests a payment card, never authorizing a prospect's address.
      if (isAuthorizedOnlyRefusal(said) || isAuthorizedOnlyRefusal(err.message)) {
        return {
          kind: "pause",
          pause: "mailgun-not-allowed",
          reason: PLAN_TEXTS.authorizedReason,
          fixText: PLAN_TEXTS.authorizedOnlyCampaign,
          mailgunMessage: said,
        };
      }
      return {
        kind: "pause",
        pause: "mailgun-not-allowed",
        reason: `Mailgun won't send from ${ctx.domain}`,
        fixText: `Mailgun won't send from ${ctx.domain} right now. Check the banner in Mailgun, then click Resume.`,
        mailgunMessage: said,
      };
    case "payment":
    case "conflict":
      return {
        kind: "pause",
        pause: "mailgun-settings",
        reason: "Mailgun won't send for your account right now",
        fixText: "Mailgun answered that your account can't send right now. Check the banner and the billing page in Mailgun, then click Resume.",
        mailgunMessage: said,
      };
    case "not-found":
      return { kind: "not-found", message: said };
    case "limit":
      // MAIN-DOMAIN-DESIGN O24, §2.8: the plan's sending limit is reached; pause and put the email back, never fail it.
      return {
        kind: "pause",
        pause: "mailgun-not-allowed",
        reason: PLAN_TEXTS.limitReason,
        fixText: PLAN_TEXTS.limitRefused,
        mailgunMessage: said,
      };
    default:
      break;
  }
  if (err.ambiguous) return { kind: "ambiguous", message: err.message };
  if (!err.requestStarted) return { kind: "blocked", message: err.message };
  return { kind: "rejected", message: said, detail: err.message };
}

function regionOf(v: unknown): MailgunRegion {
  return v === "US" ? "US" : "EU";
}

async function noticeOptionsTooLarge(now: Date): Promise<void> {
  try {
    if (!(await shouldSendNotice("options-too-large", now))) return;
    await notifyOwner({
      type: "system.mailgun",
      title: "An email couldn't be handed to Mailgun",
      body: TOO_LARGE.fixText,
      link: "/settings/sending",
    });
  } catch (err) {
    console.error("[sending] couldn't send the options-too-large notice", err);
  }
}

export class MailgunTransport implements EmailTransport {
  readonly mode: "TEST" | "LIVE";
  private readonly context: MailgunContext;
  private readonly guard: SendGuard;
  private readonly clock: () => Date;

  constructor(opts: { mode: "TEST" | "LIVE"; context: MailgunContext; guard: SendGuard; now?: () => Date }) {
    this.mode = opts.mode;
    this.context = opts.context;
    this.guard = opts.guard;
    this.clock = opts.now ?? (() => new Date());
  }

  /** Sends one campaign email. Throws TransportError only. Never retried here, never aborted from outside. */
  async send(message: OutgoingMessage): Promise<TransportResult> {
    // The Mailgun domain is the route address's (SHARED-FROM-DESIGN §2.3): the Reply-To's domain when there is one,
    // else the From's (per-person mode, as before).
    const domain = mailgunDomainOf(message.from, message.replyTo);
    // Own-mailbox mode (MAIN-DOMAIN-DESIGN O6): decided by the context's mode only (§0.2 rule 5). Its sender check runs
    // before the domain lookup, so an own-mailbox email with a Reply-To (on whatever domain) or another From is always
    // the sender-check block (O35), never the "not on a sending domain" pause.
    const ownMailbox = this.context.replies === "own-mailbox";
    if (ownMailbox) {
      const problem = senderHeaderProblem(domain ?? "", message.from, message.replyTo, { ownMailboxFrom: this.context.ownMailboxFrom });
      if (problem) throw new TransportError(ownMailboxBlocked(`Stopped by the sender check: ${problem}`));
      // Its Message-ID must be on the domain it goes through (the reconciler and the reply test find it by that domain).
      if (idDomainOf(message.messageId) !== domain) {
        throw new TransportError(ownMailboxBlocked(`Stopped by the sender check: the Message-ID isn't on ${domain}.`));
      }
    }
    const row = domain
      ? await db.sendingDomain.findUnique({ where: { name: domain }, select: { name: true, region: true } })
      : null;
    if (!domain || !row) {
      throw new TransportError({ kind: "blocked", message: NOT_ON_DOMAIN.fixText, pause: NOT_ON_DOMAIN });
    }
    // §2.4, fail closed: the From on the domain (per-person), or on its main domain with a Reply-To on the domain.
    // (`ownMailboxFrom` is null in app mode: today's rules.)
    const problem = senderHeaderProblem(domain, message.from, message.replyTo, { ownMailboxFrom: this.context.ownMailboxFrom });
    if (problem) {
      const text = `Stopped by the sender check: ${problem}`;
      throw new TransportError(ownMailbox ? ownMailboxBlocked(text) : { kind: "blocked", message: text, pause: SENDER_HEADERS_PAUSE });
    }
    // A shared-From email (its From is off the domain: the From line's own domain, without the Reply-To, differs) must
    // also carry a Message-ID on the domain it goes through.
    const teamFrom = mailgunDomainOf(message.from, null) !== domain;
    if (teamFrom && idDomainOf(message.messageId) !== domain) {
      throw new TransportError({
        kind: "blocked",
        message: `Stopped by the sender check: the Message-ID isn't on ${domain}.`,
        pause: SENDER_HEADERS_PAUSE,
      });
    }
    const input = buildSendInput(message, this.mode, this.guard);
    if (sendOptionBytes(input) > SEND_OPTIONS_MAX_BYTES) {
      await noticeOptionsTooLarge(this.clock());
      throw new TransportError({ kind: "blocked", message: TOO_LARGE.fixText, pause: TOO_LARGE });
    }
    // The domain sending key only works for the connected domain; an older domain uses the account key.
    const connected = domain === this.context.domain;
    const client = connected ? this.context.sendClient : clientFor(this.context, regionOf(row.region));
    // A shared-From email sent with the domain sending key: a refused key then says how to send with the API key (§2.4).
    const teamFromWithSendingKey = teamFrom && connected && this.context.sendClient !== this.context.client;
    try {
      const res = await client.sendMessage(domain, input);
      return { providerId: res.id, acceptedAt: this.clock() };
    } catch (err) {
      const failure = mailgunFailure(err, { domain, now: this.clock(), teamFromWithSendingKey });
      // The client's own sender check (kind "sender", no request) in own-mailbox mode counts as the same block (O35).
      if (ownMailbox && isMailgunError(err) && err.kind === "sender" && failure.kind === "blocked") {
        throw new TransportError(ownMailboxBlocked(failure.message));
      }
      throw new TransportError(failure);
    }
  }
}
