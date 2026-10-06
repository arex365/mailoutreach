import crypto from "node:crypto";
import { formatFromHeader, senderAddressWords, senderHeaders } from "@/core/sending/from-address";
import { ownMailboxHeaders } from "@/core/sending/own-mailbox";

/** Moved to @/core/sending/from-address (SHARED-FROM-DESIGN §7.5); re-exported so every existing import keeps working. */
export { formatFromHeader };

/**
 * Sender snapshot, From line and message ids (PLAN.md B6.7, B6.8).
 *
 * A dry run of a sender without a sending address uses a placeholder: the From line is
 * "<sender display name> <<local part of the sender's login email>@your-sending-domain>" and
 * Message-IDs end in "@dry-run.invalid" (".invalid" can never be a real domain). When the sender
 * has a sender address on a connected sending domain, that address is used. Test mode and live
 * campaigns always need one: senderSnapshot refuses them without it (the launch already refuses
 * first, M3-DESIGN §4.3.9; this is the second line of defence).
 *
 * Shared-From mode (SHARED-FROM-DESIGN §2.3, `opts.teamFrom` set): the From line is "<display name> <shared address>"
 * and the sender's own address becomes the Reply-To (both from `senderHeaders`); the domain row and the Message-ID
 * domain stay the sender address's (the sending domain). A dry run without a sender address shows the shared address
 * with no Reply-To and "@dry-run.invalid" Message-IDs. Without `teamFrom`, everything is exactly as before.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.3, O5, `opts.ownMailbox` set): the sender address is ignored (nobody has one in
 * this mode); the From line is "<display name> <own From>" from `ownMailboxHeaders` (the one place, §0.2 rule 6), never
 * a Reply-To; the domain row is the sending domain's in every mode, and the Message-ID domain is the sending domain
 * (TEST/LIVE) or "dry-run.invalid" (DRY_RUN). Own-mailbox mode without a fitting From passes no option: a dry run then
 * takes the placeholder path, so dry runs never need a From.
 */

/** Thrown by senderSnapshot for a TEST/LIVE snapshot without a real sending address. */
export class NoSenderAddressError extends Error {
  /** `teamFrom`: shared-From mode, where the per-person address is called the "reply address" (F19). */
  constructor(senderName: string, opts: { teamFrom?: boolean } = {}) {
    const who = senderName.trim() || "The sender";
    super(`${who} has no ${senderAddressWords(opts.teamFrom === true).lower} yet. ${who} can add one in Settings › My profile.`);
    this.name = "NoSenderAddressError";
  }
}

export const DRY_RUN_SENDING_DOMAIN = "your-sending-domain";
export const DRY_RUN_MESSAGE_ID_DOMAIN = "dry-run.invalid";

/** The local part of a login email, lowercased and cleaned for use as a sender address. */
export function senderLocalPart(loginEmail: string): string {
  const local = (loginEmail.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9._+-]/g, "");
  return local.replace(/^\.+|\.+$/g, "") || "sender";
}

export type SenderSnapshot = {
  /** Campaign.fromName: the display name. */
  fromName: string;
  /**
   * Campaign.fromAddress: the bare From address, e.g. "ali@your-sending-domain"; the shared From address in
   * shared-From mode.
   */
  fromAddress: string;
  /** OutboundEmail.fromAddress: the full From line. */
  fromHeader: string;
  /**
   * Campaign.replyTo and OutboundEmail.replyTo: the sender's own address in shared-From mode (sent as Reply-To, where
   * replies land and the route catches them); null in per-person mode, and for a dry run without a sender address.
   */
  replyTo: string | null;
  /**
   * Campaign.sendingDomainId (null for the placeholder): the sender address's domain row, in both modes; the sending
   * domain's row in own-mailbox mode (every launch mode).
   */
  sendingDomainId: number | null;
  /**
   * The domain used in Message-IDs: the sender address's domain (the sending domain), in both modes; the sending domain
   * in own-mailbox mode (TEST/LIVE). Dry runs: "dry-run.invalid".
   */
  messageIdDomain: string;
};

/** Own-mailbox mode's snapshot input (MAIN-DOMAIN-DESIGN §2.3): the own From and the sending domain's row. */
export type OwnMailboxSnapshot = { from: string; domainId: number; domainName: string };

/**
 * The sender snapshot fixed at launch (B4). `senderAddress` is the sender's current address on a
 * real domain, if any. TEST and LIVE without one throw NoSenderAddressError (never a placeholder).
 * `opts.teamFrom`: the shared From address (SHARED-FROM-DESIGN §2.3); null or absent = per-person mode.
 * `opts.ownMailbox`: own-mailbox mode with a fitting own From (MAIN-DOMAIN-DESIGN §2.3); `senderAddress` is then
 * ignored. `teamFrom` and `ownMailbox` together are a programming error and throw.
 */
export function senderSnapshot(
  user: { name: string; email: string; senderDisplayName: string | null },
  mode: "DRY_RUN" | "TEST" | "LIVE",
  senderAddress?: { address: string; domainId: number; domainName: string } | null,
  opts: { teamFrom?: string | null; ownMailbox?: OwnMailboxSnapshot | null } = {},
): SenderSnapshot {
  const fromName = (user.senderDisplayName ?? "").trim() || user.name.trim();
  const teamFrom = (opts.teamFrom ?? "").trim().toLowerCase() || null;
  if (opts.ownMailbox) {
    if (teamFrom) throw new Error("senderSnapshot: a shared From address and own-mailbox mode can't be used together.");
    const own = opts.ownMailbox;
    const from = own.from.trim().toLowerCase();
    if (!from) throw new Error("senderSnapshot: own-mailbox mode needs its From address.");
    // The one place an own-mailbox email's From line is made (§0.2 rule 6); never a Reply-To.
    const headers = ownMailboxHeaders({ displayName: fromName, from });
    return {
      fromName,
      fromAddress: from,
      fromHeader: headers.from,
      replyTo: headers.replyTo,
      sendingDomainId: own.domainId,
      messageIdDomain: mode === "DRY_RUN" ? DRY_RUN_MESSAGE_ID_DOMAIN : own.domainName.trim().toLowerCase(),
    };
  }
  if (!senderAddress && mode !== "DRY_RUN") throw new NoSenderAddressError(user.name, { teamFrom: teamFrom !== null });
  if (senderAddress) {
    const address = senderAddress.address.toLowerCase();
    // The one place a campaign's From line and Reply-To are made (§0.2 rule 5).
    const headers = senderHeaders({ displayName: fromName, senderAddress: address, teamFrom });
    return {
      fromName,
      fromAddress: teamFrom ?? address,
      fromHeader: headers.from,
      replyTo: headers.replyTo,
      sendingDomainId: senderAddress.domainId,
      messageIdDomain: mode === "DRY_RUN" ? DRY_RUN_MESSAGE_ID_DOMAIN : senderAddress.domainName.toLowerCase(),
    };
  }
  // A dry run without a sender address: the shared address (no Reply-To: there is no address to reply to), else the
  // placeholder.
  const address = teamFrom ?? `${senderLocalPart(user.email)}@${DRY_RUN_SENDING_DOMAIN}`;
  return {
    fromName,
    fromAddress: address,
    fromHeader: formatFromHeader(fromName, address),
    replyTo: null,
    sendingDomainId: null,
    messageIdDomain: DRY_RUN_MESSAGE_ID_DOMAIN,
  };
}

/** A new Message-ID, stored lowercase WITHOUT angle brackets: "pp.<24 hex>@dry-run.invalid". */
export function newMessageId(domain: string = DRY_RUN_MESSAGE_ID_DOMAIN): string {
  return `pp.${crypto.randomBytes(12).toString("hex")}@${domain.toLowerCase()}`;
}

/** A new random send id (sent to Mailgun as v:send_id, so the reconciler can find the email in the logs). */
export function newSendId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** The domain part of a stored Message-ID ("pp.x@dry-run.invalid" → "dry-run.invalid"). */
export function messageIdDomainOf(messageId: string): string {
  const at = messageId.lastIndexOf("@");
  return at >= 0 ? messageId.slice(at + 1) : DRY_RUN_MESSAGE_ID_DOMAIN;
}

/** References for the next email in a thread: the earlier ids, oldest first, space-separated, no brackets. */
export function nextReferences(previousReferences: string | null | undefined, previousMessageId: string): string {
  const ids = (previousReferences ?? "").split(/\s+/).filter(Boolean);
  if (!ids.includes(previousMessageId)) ids.push(previousMessageId);
  return ids.join(" ");
}
