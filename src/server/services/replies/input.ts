import type { InboundKind, InboundSource } from "@/generated/prisma/client";
import { parseMessageHeaders, type HeaderPair } from "@/core/mailgun/inbound";
import { hasBeenLive } from "@/core/replies/kind";
import { extractNewText, firstLines } from "@/core/replies/quote";
import type { ClassifyInput } from "@/core/replies/types";
import { activeOwnerId } from "@/server/notifications";
import { db, type DbOrTx } from "@/server/db";
import { internalSenders, type InternalSenders } from "@/server/services/mail-events/internal-senders";
import { getSettings } from "@/server/settings";

/**
 * What reply processing reads (M4-DESIGN §3.2, §3.8 steps 1–2, §3.10): one stored InboundMessage in the shape the
 * processor, the fail-safe and the decisions need, the classifier's input built from it (rows stored before M4 carry
 * only the collapsed snippet), its "first lines", and the settings every step shares. No writes here.
 */

/** The InboundMessage columns reply processing reads. */
export const INBOUND_ROW_SELECT = {
  id: true,
  storageKey: true,
  messageIdHeader: true,
  receivedAt: true,
  toAddress: true,
  senderAddressId: true,
  fromEmail: true,
  fromName: true,
  subject: true,
  snippet: true,
  inReplyTo: true,
  references: true,
  headers: true,
  envelopeSender: true,
  strippedText: true,
  bodyText: true,
  bodyAvailable: true,
  kind: true,
  autoReason: true,
  source: true,
  processedAt: true,
} as const;

/** One stored reply as reply processing sees it. */
export type InboundRow = {
  id: number;
  storageKey: string | null;
  messageIdHeader: string | null;
  receivedAt: Date;
  toAddress: string;
  senderAddressId: number | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  inReplyTo: string | null;
  references: string | null;
  headers: unknown;
  envelopeSender: string | null;
  strippedText: string | null;
  bodyText: string | null;
  bodyAvailable: boolean;
  kind: InboundKind | null;
  autoReason: string | null;
  source: InboundSource;
  processedAt: Date | null;
};

/** Loads one stored reply, or null when it doesn't exist. */
export async function loadInboundRow(id: number, reader: DbOrTx = db): Promise<InboundRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  return reader.inboundMessage.findUnique({ where: { id }, select: INBOUND_ROW_SELECT });
}

/** The stored `headers` JSON as [name, value] pairs (anything unreadable is dropped). */
export function rowHeaders(value: unknown): HeaderPair[] {
  return Array.isArray(value) ? parseMessageHeaders(value) : [];
}

/** The new text of a reply (Mailgun's stripped-text, else our cut of body-plain); "" for rows stored before M4. */
export function newTextOf(row: Pick<InboundRow, "strippedText" | "bodyText">): string {
  return extractNewText(row.strippedText, row.bodyText);
}

/** Stored snippets are cut to this length (as M3). */
const SNIPPET_MAX = 300;

/**
 * The "first lines" stored as the snippet when a reply is processed (M4-DESIGN §3.10): the first lines of the new
 * text, else the snippet stored under M3, else the subject. At most 300 characters.
 */
export function snippetOf(row: Pick<InboundRow, "strippedText" | "bodyText" | "snippet" | "subject">, newText = newTextOf(row)): string {
  const lines = firstLines(newText);
  const text = lines || row.snippet.replace(/\s+/g, " ").trim() || row.subject.replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : text;
}

/**
 * The text a delivery-failure notice is searched in for our own Message-IDs and the failed addresses (M4-DESIGN
 * §3.3.2): body-plain (the quoted original headers live there), else stripped-text, else the stored snippet.
 */
export function noticeTextOf(row: Pick<InboundRow, "bodyText" | "strippedText" | "snippet">): string {
  return row.bodyText ?? row.strippedText ?? row.snippet;
}

/**
 * The classifier's input for one stored reply (M4-DESIGN §3.4 rule 11): subject, sender, envelope sender, headers,
 * stripped-text, body-plain, the M3 snippet (the fallback for rows stored before M4), whether a body exists, the
 * subjects of our sent emails in the linked thread and whether a link was found.
 */
export function classifyInputOf(row: InboundRow, opts: { linked: boolean; sentSubjects: readonly string[] }): ClassifyInput {
  return {
    subject: row.subject,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    envelopeSender: row.envelopeSender,
    headers: rowHeaders(row.headers),
    strippedText: row.strippedText,
    bodyPlain: row.bodyText,
    snippet: row.snippet,
    bodyAvailable: row.bodyAvailable,
    sentSubjects: opts.sentSubjects,
    linked: opts.linked,
  };
}

/** What every processing step shares, read once per batch (M4-DESIGN §3.8 step 2). */
export type ReplyContext = {
  /** Setting "practice.copy": dry runs stand in for live sends. */
  practiceCopy: boolean;
  /**
   * The app has been live at least once (`hasBeenLive`: Setting "sending.goLive", or "sending.goLiveAt" set): only for
   * a reply linked to a company without an email, so a domain change that switched go-live off doesn't stop such a
   * reply from making the company Replied (review GOLIVE-01). A reply linked to an email is judged by that email's
   * campaign (`launchedGoLiveOf`, M6-DESIGN §2.2).
   */
  everLive: boolean;
  /** Our own addresses and the test-sender rule (P2, shared with the sending guard). */
  internal: InternalSenders;
  /** The active Owner (fail-safe assignee, catch-all notices), or null before first-run setup. */
  ownerId: number | null;
  /** Our sending domains (a "left the company" suggestion never points at them). */
  ownDomains: string[];
};

/** Reads the settings, internal addresses, Owner and sending domains reply processing needs. */
export async function loadReplyContext(reader: DbOrTx = db): Promise<ReplyContext> {
  const [settings, internal, ownerId, domains] = await Promise.all([
    getSettings(["practice.copy", "sending.goLive", "sending.goLiveAt"] as const),
    internalSenders(reader),
    activeOwnerId(reader),
    reader.sendingDomain.findMany({ select: { name: true } }),
  ]);
  return {
    practiceCopy: settings["practice.copy"] === true,
    everLive: hasBeenLive({ goLive: settings["sending.goLive"], goLiveAt: settings["sending.goLiveAt"] }),
    internal,
    ownerId,
    ownDomains: domains.map((d) => d.name.trim().toLowerCase()).filter(Boolean),
  };
}

/**
 * The launch flag of a linked email's campaign (`Campaign.launchedGoLive`, M6-DESIGN §2.2): whether its live sends
 * count as "emailed", so a reply to it may change the company's status (`replyScope`). Null without an email; a live
 * email of a campaign launched before go-live gives false, also after go-live. One primary-key read.
 */
export async function launchedGoLiveOf(reader: DbOrTx, email: { campaignId: number } | null): Promise<boolean | null> {
  if (!email) return null;
  const campaign = await reader.campaign.findUnique({ where: { id: email.campaignId }, select: { launchedGoLive: true } });
  return campaign?.launchedGoLive ?? null;
}
