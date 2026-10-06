import type { Prisma, SendMode, SendStatus } from "@/generated/prisma/client";
import { senderDomain } from "@/core/replies/hints";
import { realModes } from "@/core/rules/mode";
import type { DbOrTx } from "@/server/db";
import type { InternalSenders } from "@/server/services/mail-events/internal-senders";
import type { InboundRow } from "./input";

/**
 * Linking a received message to one of our emails (M4-DESIGN §3.3). Every lookup is a read (the processor runs them
 * before its one short transaction) and every time window is measured from the message's **arrival**
 * (`receivedAt`), never from the processing time, so M3 backlog rows, catch-up recoveries and retried rows link to the
 * email that was out when the message arrived:
 *  1. by thread ids (§3.3.1): our Message-ID, else Mailgun's provider id, else a test email; no time limit;
 *  2. for delivery-failure notices, our ids quoted in the text, else the failed addresses it names (§3.3.2);
 *  3. for a challenge-response message, the addresses it names (§3.3.2);
 *  4. by the sender's address (§3.3.3): the newest email to it in the last 90 days;
 *  5. by known contact (§3.3.3b): a live Person with exactly that address links to their company.
 * Links 2–5 only use emails of the real modes (LIVE, plus DRY_RUN in the practice copy): TEST rows never, and a dry
 * run on real data never leaves the PC, so only a simulated reply may link to one (by its thread id).
 * There is no domain *matching*: an unknown address on a company's domain only holds that company (§3.3.4).
 */

/** PLAN B6.10 "last 90 days", measured back from the message's arrival. */
export const REPLY_FROM_MATCH_MS = 90 * 86_400_000;

/** The OutboundEmail columns a link carries. */
export const LINK_EMAIL_SELECT = {
  id: true,
  campaignId: true,
  recipientId: true,
  personId: true,
  companyId: true,
  senderId: true,
  step: true,
  mode: true,
  status: true,
  toEmail: true,
  toNorm: true,
  subject: true,
  messageId: true,
  providerId: true,
  sentAt: true,
  claimedAt: true,
  recipient: { select: { companyId: true } },
} as const;

/** One of our emails a message was linked to. `companyId` falls back to the recipient's company. */
export type LinkedEmail = {
  id: number;
  campaignId: number;
  recipientId: number;
  personId: number | null;
  companyId: number;
  senderId: number | null;
  step: number;
  mode: SendMode;
  status: SendStatus;
  toEmail: string;
  toNorm: string;
  subject: string;
  messageId: string;
  providerId: string | null;
  sentAt: Date | null;
  claimedAt: Date | null;
};

type EmailRow = Prisma.OutboundEmailGetPayload<{ select: typeof LINK_EMAIL_SELECT }>;

function toLinked(e: EmailRow): LinkedEmail {
  const { recipient, ...rest } = e;
  return { ...rest, companyId: e.companyId ?? recipient.companyId };
}

/** The arrival window of the from-address, known-contact, bounce-address and named-address links. */
export function replyWindow(receivedAt: Date): { gte: Date; lte: Date } {
  return { gte: new Date(receivedAt.getTime() - REPLY_FROM_MATCH_MS), lte: receivedAt };
}

/** The result of the thread-id lookup: one of our emails, or a test email (the reply test, "Send me a test"). */
export type ThreadHit = { type: "email"; email: LinkedEmail } | { type: "test"; testSendId: number };

/**
 * A dry-run email may be linked only by a simulated reply, or in the practice copy (where dry runs stand in for live
 * sends and signed reply webhooks are posted to them, PLAN B12). On real data a real message quoting a dry-run id
 * (which never left the PC) skips it.
 */
function usableEmail(e: { mode: SendMode }, opts: { simulated: boolean; practiceCopy: boolean }): boolean {
  return e.mode !== "DRY_RUN" || opts.simulated || opts.practiceCopy;
}

/**
 * Links by thread ids (M4-DESIGN §3.3.1), `ids` in the order of `threadIds` (In-Reply-To first, then References newest
 * → oldest). For each id: an OutboundEmail with that `messageId`, else with that `providerId` (Mailgun rewrote ours),
 * else a TestSend with that `messageId` or `providerId`. The first **usable** hit wins: a TEST/LIVE email always; a
 * dry-run email only for simulated replies or in the practice copy; a test email only when the sender is where test
 * replies come from (`isTestSender`: the test's `to`, a user, the test list), so a prospect answering a forwarded test
 * email is never filed as a test reply. Two queries for up to 50 ids; no time limit.
 */
export async function threadLink(
  reader: DbOrTx,
  ids: readonly string[],
  opts: { fromEmail: string; simulated: boolean; practiceCopy: boolean; internal: Pick<InternalSenders, "isTestSender">; tests?: boolean },
): Promise<ThreadHit | null> {
  if (ids.length === 0) return null;
  const list = [...ids];
  const [emails, tests] = await Promise.all([
    reader.outboundEmail.findMany({
      where: { OR: [{ messageId: { in: list } }, { providerId: { in: list } }] },
      orderBy: { id: "asc" },
      select: LINK_EMAIL_SELECT,
    }),
    opts.tests === false
      ? Promise.resolve([])
      : reader.testSend.findMany({
          where: { OR: [{ messageId: { in: list } }, { providerId: { in: list } }] },
          orderBy: { id: "asc" },
          select: { id: true, to: true, messageId: true, providerId: true },
        }),
  ]);
  for (const id of list) {
    const candidates = [...emails.filter((e) => e.messageId === id), ...emails.filter((e) => e.messageId !== id && e.providerId === id)];
    const email = candidates.find((e) => usableEmail(e, opts));
    if (email) return { type: "email", email: toLinked(email) };
    const test = tests.find((t) => t.messageId === id || t.providerId === id);
    if (test && opts.internal.isTestSender(opts.fromEmail, test.to)) return { type: "test", testSendId: test.id };
  }
  return null;
}

/**
 * The newest SENT email of the real modes to one of these addresses in the arrival window, trying the addresses in
 * order (index `(toNorm, sentAt)`). Used by the from-address, bounce-address and named-address links.
 */
export async function newestSentTo(
  reader: DbOrTx,
  addresses: readonly string[],
  opts: { receivedAt: Date; practiceCopy: boolean },
): Promise<LinkedEmail | null> {
  const seen = new Set<string>();
  for (const raw of addresses) {
    const toNorm = raw.trim().toLowerCase();
    if (!toNorm || seen.has(toNorm)) continue;
    seen.add(toNorm);
    const e = await reader.outboundEmail.findFirst({
      where: { toNorm, mode: { in: realModes(opts.practiceCopy) }, status: "SENT", sentAt: replyWindow(opts.receivedAt) },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      select: LINK_EMAIL_SELECT,
    });
    if (e) return toLinked(e);
  }
  return null;
}

/**
 * The newest SENT email of the real modes to a company in the arrival window (index `(companyId, sentAt)`), preferring
 * one to `personId` when given. Used by the known-contact link (§3.3.3b) and by linking by hand (§3.5).
 */
export async function newestSentToCompany(
  reader: DbOrTx,
  companyId: number,
  opts: { receivedAt: Date; practiceCopy: boolean; personId?: number | null },
): Promise<LinkedEmail | null> {
  const base: Prisma.OutboundEmailWhereInput = {
    companyId,
    mode: { in: realModes(opts.practiceCopy) },
    status: "SENT",
    sentAt: replyWindow(opts.receivedAt),
  };
  const orderBy: Prisma.OutboundEmailOrderByWithRelationInput[] = [{ sentAt: "desc" }, { id: "desc" }];
  if (opts.personId) {
    const mine = await reader.outboundEmail.findFirst({ where: { ...base, personId: opts.personId }, orderBy, select: LINK_EMAIL_SELECT });
    if (mine) return toLinked(mine);
  }
  const any = await reader.outboundEmail.findFirst({ where: base, orderBy, select: LINK_EMAIL_SELECT });
  return any ? toLinked(any) : null;
}

/** A contact whose address is exactly the sender's: a live Person at a live company. */
export type KnownPerson = { id: number; name: string; companyId: number; isGeneric: boolean };

/** The live Person (not removed, company not deleted) with this exact address, or null (§0.3 "Replier", §3.3.3b). */
export async function knownPersonOf(reader: DbOrTx, fromEmail: string): Promise<KnownPerson | null> {
  const emailNorm = fromEmail.trim().toLowerCase();
  if (!emailNorm) return null;
  const p = await reader.person.findUnique({
    where: { emailNorm },
    select: { id: true, name: true, companyId: true, isGeneric: true, deletedAt: true, company: { select: { deletedAt: true } } },
  });
  if (!p || p.deletedAt || p.company.deletedAt) return null;
  return { id: p.id, name: p.name, companyId: p.companyId, isGeneric: p.isGeneric };
}

/** Recipient states that still have emails to come and that a possible-reply hold reaches. */
const HOLDABLE_STATES = ["SCHEDULED", "WAITING", "HELD"] as const;

/**
 * The domain hold (M4-DESIGN §3.3.4): the one live company whose `domain` equals the sender's registrable domain
 * (`senderDomain`: never shared or free-mail domains) and that has open recipients. Null when no company, or more
 * than one, matches: the hold is reversible but must never guess between companies.
 */
export async function domainHoldCompany(reader: DbOrTx, fromEmail: string): Promise<number | null> {
  const domain = senderDomain(fromEmail);
  if (!domain) return null;
  const companies = await reader.company.findMany({ where: { domain, deletedAt: null }, select: { id: true }, take: 20 });
  if (companies.length === 0) return null;
  const open = await reader.campaignRecipient.findMany({
    where: { companyId: { in: companies.map((c) => c.id) }, included: true, state: { in: [...HOLDABLE_STATES] } },
    select: { companyId: true },
    distinct: ["companyId"],
  });
  return open.length === 1 ? open[0]!.companyId : null;
}

/** The fields a twin copies from the row it duplicates (M4-DESIGN §3.7). */
export const TWIN_COPY_SELECT = {
  id: true,
  kind: true,
  autoReason: true,
  signals: true,
  linkMethod: true,
  outboundEmailId: true,
  personId: true,
  companyId: true,
  campaignId: true,
  replyScope: true,
  changesStatus: true,
  heldCompanyId: true,
  assigneeId: true,
  confirmedAt: true,
  confirmedById: true,
} as const;

/** The processed row a twin copies (its kind, reason, links, scope, assignee and confirmation). */
export type TwinSource = Prisma.InboundMessageGetPayload<{ select: typeof TWIN_COPY_SELECT }>;

/**
 * The row a message is a twin of (M4-DESIGN §3.7): another processed row with the same **non-empty** Message-ID and
 * the same sender (e.g. one reply sent to ali@ and Cc sara@), that is not itself a twin and whose processing didn't
 * fail (`autoReason "process-failed"` is never a twin source). Rows without a Message-ID are never twins.
 */
export async function findTwinSource(
  reader: DbOrTx,
  row: Pick<InboundRow, "id" | "messageIdHeader" | "fromEmail">,
): Promise<TwinSource | null> {
  const messageIdHeader = (row.messageIdHeader ?? "").trim();
  if (!messageIdHeader) return null;
  return reader.inboundMessage.findFirst({
    where: {
      id: { not: row.id },
      messageIdHeader,
      fromEmail: row.fromEmail,
      processedAt: { not: null },
      AND: [
        { OR: [{ autoReason: null }, { autoReason: { not: "process-failed" } }] },
        { OR: [{ answerOutcome: null }, { answerOutcome: { not: "duplicate" } }] },
      ],
    },
    orderBy: { id: "asc" },
    select: TWIN_COPY_SELECT,
  });
}

/** The subjects of our SENT emails in one recipient's thread (step 0..n), so "Re: <our subject>" is never an auto-subject. */
export async function sentSubjectsOf(reader: DbOrTx, recipientId: number): Promise<string[]> {
  const rows = await reader.outboundEmail.findMany({
    where: { recipientId, status: "SENT" },
    orderBy: { step: "asc" },
    select: { subject: true },
  });
  return [...new Set(rows.map((r) => r.subject).filter((s) => s.trim() !== ""))];
}
