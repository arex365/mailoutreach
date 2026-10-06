import type { InboundSource, Prisma } from "@/generated/prisma/client";
import { normalizeEmail } from "@/core/email-address";
import type { ParsedInbound } from "@/core/mailgun/inbound";
import type { Tx } from "@/server/db";

/**
 * The inbound store (M3-DESIGN §1.4, §4.4.4; M4-DESIGN §3.2): every reply Mailgun passes on (the signed notify POST,
 * the catch-up's stored-message fetch or log-only recovery, or a simulated reply) becomes one InboundMessage row,
 * unprocessed. Storing never classifies, links, stops or notifies: the worker's event lane does that within about a
 * second (`processInboundMessage`, M4-DESIGN §3.8), and until then the sending guard holds everything the row could
 * concern. Besides M3's fields, M4 keeps what the classifier needs: the envelope sender (SMTP MAIL FROM, "" = the null
 * sender), Mailgun's stripped-text and body-plain with their newlines, and whether a body exists at all (false for a
 * reply recovered from Mailgun's log after the stored message expired). Reply texts are cleared 30 days after
 * processing by the daily clean-up; the snippet stays.
 */

/** Stored subjects are cut to this length. */
export const INBOUND_SUBJECT_MAX = 500;
/** Mailgun's stripped-text (the new text) is kept up to this many characters (M4-DESIGN §3.2). */
export const STRIPPED_TEXT_MAX = 8_000;
/** Mailgun's body-plain is kept up to this many characters (M4-DESIGN §3.2). */
export const BODY_TEXT_MAX = 16_000;
const ADDRESS_MAX = 320;

/**
 * Newlines kept (\r\n → \n), cut to `max` characters (never half of a surrogate pair); missing → null, and with
 * `blankIsNull` (stripped-text: a blank one means Mailgun's parse failed) blank → null too.
 */
function keptText(v: string | null | undefined, max: number, blankIsNull: boolean): string | null {
  if (typeof v !== "string") return null;
  const text = v.replace(/\r\n?/g, "\n");
  if (blankIsNull && text.trim() === "") return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The envelope sender as stored (M4-DESIGN §3.2): "" = the null sender ("", "<>"), null = unknown, else the bare
 * address, lowercase. The parsers already give this form; the store only makes sure of it.
 */
function envelopeOf(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const bare = v.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
  return bare.slice(0, ADDRESS_MAX);
}

/** The M4 text fields of a parsed reply, ready to write (a ParsedInbound built before M4 has none: body available). */
function textFields(parsed: ParsedInbound) {
  return {
    envelopeSender: envelopeOf(parsed.envelopeSender),
    strippedText: keptText(parsed.strippedText, STRIPPED_TEXT_MAX, true),
    bodyText: keptText(parsed.bodyText, BODY_TEXT_MAX, false),
    bodyAvailable: parsed.bodyAvailable !== false,
  };
}

/**
 * A duplicate of a row recovered from Mailgun's log alone (no text) that arrives as a full copy (e.g. a later notify
 * retry after the storage fetch was refused): the stored row gets the copy's envelope sender, texts, headers and
 * snippet, and `bodyAvailable = true` (M4-DESIGN §3.2). A row not processed yet is then classified with its text; a
 * processed one keeps its kind (someone decides it anyway), but its card shows the text.
 */
async function upgradeLogOnly(tx: Tx, id: number, parsed: ParsedInbound): Promise<void> {
  if (parsed.bodyAvailable === false) return;
  await tx.inboundMessage.updateMany({
    where: { id, bodyAvailable: false },
    data: {
      ...textFields(parsed),
      bodyAvailable: true,
      headers: parsed.headers as unknown as Prisma.InputJsonValue,
      snippet: parsed.snippet,
    },
  });
}

/**
 * Stores one reply inside `tx`. Duplicate when a row with the same storage key exists, or (without a key) one with the
 * same Message-ID sent to the same address; a duplicate of a log-only row upgrades it with the new copy's text. The
 * sender is normalised (the raw value is kept when it doesn't parse); `senderAddressId` is set when the reply went to
 * one of our sending addresses. stripped-text (≤ 8,000 characters) and body-plain (≤ 16,000) keep their newlines.
 */
export async function storeInbound(
  tx: Tx,
  parsed: ParsedInbound,
  source: InboundSource,
): Promise<{ status: "created" | "duplicate"; id: number }> {
  const toAddress = parsed.recipient.trim().toLowerCase().slice(0, ADDRESS_MAX);
  if (parsed.storageKey) {
    const byKey = await tx.inboundMessage.findUnique({ where: { storageKey: parsed.storageKey }, select: { id: true, bodyAvailable: true } });
    if (byKey) {
      if (!byKey.bodyAvailable) await upgradeLogOnly(tx, byKey.id, parsed);
      return { status: "duplicate", id: byKey.id };
    }
  }
  if (parsed.messageIdHeader) {
    const byId = await tx.inboundMessage.findFirst({
      where: { messageIdHeader: parsed.messageIdHeader, toAddress },
      select: { id: true, storageKey: true, bodyAvailable: true },
    });
    if (byId && (!parsed.storageKey || !byId.storageKey)) {
      // The same reply arrived without a storage key before (or now): remember the key so the catch-up skips it.
      if (parsed.storageKey && !byId.storageKey) {
        await tx.inboundMessage.update({ where: { id: byId.id }, data: { storageKey: parsed.storageKey } });
      }
      if (!byId.bodyAvailable) await upgradeLogOnly(tx, byId.id, parsed);
      return { status: "duplicate", id: byId.id };
    }
  }

  const sender = await tx.senderAddress.findUnique({ where: { address: toAddress }, select: { id: true } });
  const fromEmail = (normalizeEmail(parsed.fromEmail) ?? parsed.fromEmail.trim()).slice(0, ADDRESS_MAX);
  const row = await tx.inboundMessage.create({
    data: {
      storageKey: parsed.storageKey,
      messageIdHeader: parsed.messageIdHeader,
      receivedAt: parsed.receivedAt,
      toAddress,
      senderAddressId: sender?.id ?? null,
      fromEmail,
      fromName: parsed.fromName ? parsed.fromName.slice(0, 200) : null,
      subject: parsed.subject.slice(0, INBOUND_SUBJECT_MAX),
      snippet: parsed.snippet,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references.length ? parsed.references.join(" ") : null,
      headers: parsed.headers as unknown as Prisma.InputJsonValue,
      ...textFields(parsed),
      kind: null,
      source,
      processedAt: null,
    },
    select: { id: true },
  });
  return { status: "created", id: row.id };
}
