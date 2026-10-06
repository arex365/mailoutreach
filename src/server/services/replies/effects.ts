import type { CompanyStatus, Prisma, SendMode } from "@/generated/prisma/client";
import { replyActivitySummary, replyAutoSummaryCopy, replySummaryCopy, type ReplyNotificationCopy } from "@/core/replies/copy";
import { ATTENTION_SENT_SIGNAL, type InboundKindValue, type LinkTarget, type ReplyScope } from "@/core/replies/types";
import { logActivity } from "@/server/activity";
import type { DbOrTx, Tx } from "@/server/db";
import { activeOwnerId, notifyUsers } from "@/server/notifications";
import { STOPPABLE_STATES, stopCompany, stopRecipients } from "@/server/services/mail-events/stops";
import { TWIN_COPY_SELECT } from "./link";

/**
 * The effects of a reply (M4-DESIGN §2.6, §2.7, §3.5, §4.2, §5.5), shared by processing (`processInboundMessage`) and
 * the decisions (Real reply, Link to a company). Everything here runs inside the caller's one short transaction, except
 * the audience lookup (a read done before it). Recipients are stopped only through `stopCompany` / `stopRecipients`
 * and held only through the hold functions (M4-DESIGN §0.2 rule 7).
 */

/** What a REPLY does (M4-DESIGN §3.5 row REPLY, §2.7). */
export type ReplyEffectInput = {
  inboundId: number;
  /** The linked company (from the email, the known contact or the link by hand). */
  companyId: number;
  /** The stored scope: "real" stops every campaign at the company; "campaign" only `campaignId`. */
  scope: ReplyScope;
  campaignId: number | null;
  /** The stored "changes status": may set the company Replied and write `repliedAt`. */
  changesStatus: boolean;
  receivedAt: Date;
  fromEmail: string;
  /** §0.3 "Replier": the known Person who wrote, else the person the linked email went to. */
  replierPersonIds: readonly number[];
  /** The replier is a known Person at another company: their own recipient rows stop too (§3.7). */
  crossCompany: boolean;
  /** The recipient the reply concerns (the activity's person). */
  personId: number | null;
  /** The linked email's mode (the status activity's mode), null without an email. */
  mode: SendMode | null;
  now: Date;
};

/** What a REPLY changed: the campaigns its stops touched (the caller runs `finishCheck` for each) and the status. */
export type ReplyEffectResult = { campaignIds: number[]; stopped: number; statusChanged: boolean };

/** The open recipients' campaigns for these where clauses (read before a stop, for the finish check after it). */
async function openCampaigns(tx: Tx, where: Prisma.CampaignRecipientWhereInput): Promise<number[]> {
  const rows = await tx.campaignRecipient.findMany({
    where: { ...where, included: true, state: { in: [...STOPPABLE_STATES] } },
    select: { campaignId: true },
    distinct: ["campaignId"],
  });
  return rows.map((r) => r.campaignId);
}

/**
 * A REPLY's stops, status and dates, inside `tx`:
 *  - `stopCompany` in scope: the repliers `replied`, everyone else at the company `company_replied` (§2.6);
 *  - a known Person at another company who answered: their own rows stop with `replied` (that company's status and
 *    other people are unchanged, §3.7);
 *  - in a scope that changes status: the company Not contacted / Contacted → Replied (compare-and-set; Client, Not
 *    interested, Do not contact and Replied are never changed) with the automatic `company.status` activity, and
 *    `repliedAt` (forward only) for the company and the repliers, never for a colleague who didn't write (§2.7).
 */
export async function applyReplyEffects(tx: Tx, input: ReplyEffectInput): Promise<ReplyEffectResult> {
  const campaignId = input.scope === "campaign" ? input.campaignId : null;
  const touched = new Set<number>();
  const stop = await stopCompany(tx, {
    companyId: input.companyId,
    replierPersonIds: input.replierPersonIds,
    replierEmails: [input.fromEmail],
    inboundId: input.inboundId,
    campaignId,
    now: input.now,
  });
  for (const c of stop.campaignIds) touched.add(c);
  let stopped = stop.stopped;

  if (input.crossCompany) {
    const emailNorm = input.fromEmail.trim().toLowerCase();
    if (input.scope === "real") {
      for (const c of await openCampaigns(tx, { emailNorm })) touched.add(c);
      stopped += await stopRecipients(tx, { emailNorm, reason: "replied", scope: "real", inboundId: input.inboundId, now: input.now });
    } else if (campaignId !== null) {
      const own = await tx.campaignRecipient.findFirst({ where: { campaignId, emailNorm }, select: { id: true } });
      if (own) {
        touched.add(campaignId);
        stopped += await stopRecipients(tx, {
          emailNorm,
          reason: "replied",
          scope: "campaign",
          recipientId: own.id,
          inboundId: input.inboundId,
          now: input.now,
        });
      }
    }
  }

  let statusChanged = false;
  if (input.changesStatus) {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { status: true, deletedAt: true } });
    if (company && !company.deletedAt) {
      if (company.status === "NOT_CONTACTED" || company.status === "CONTACTED") {
        const from: CompanyStatus = company.status;
        const res = await tx.company.updateMany({ where: { id: input.companyId, status: from }, data: { status: "REPLIED" } });
        if (res.count === 1) {
          statusChanged = true;
          await logActivity(
            {
              actorId: null,
              type: "company.status",
              summary: replyActivitySummary({ type: "company.status", fromEmail: input.fromEmail }),
              companyId: input.companyId,
              personId: input.personId,
              campaignId: input.campaignId,
              data: { field: "status", from, to: "REPLIED", automatic: true, inboundId: input.inboundId },
              mode: input.mode,
            },
            tx,
          );
        }
      }
      await tx.company.updateMany({
        where: { id: input.companyId, OR: [{ repliedAt: null }, { repliedAt: { lt: input.receivedAt } }] },
        data: { repliedAt: input.receivedAt },
      });
    }
    if (input.replierPersonIds.length > 0) {
      await tx.person.updateMany({
        where: {
          id: { in: [...input.replierPersonIds] },
          deletedAt: null,
          OR: [{ repliedAt: null }, { repliedAt: { lt: input.receivedAt } }],
        },
        data: { repliedAt: input.receivedAt },
      });
    }
  }
  return { campaignIds: [...touched].sort((a, b) => a - b), stopped, statusChanged };
}

/**
 * A delivery-failure notice that names the address we wrote to (or no address): that address stops in scope, with
 * `bounced` (M4-DESIGN §3.5, D9): in real scope every campaign, in campaign scope only this recipient. No suppression
 * and no person flag: Mailgun's own events stay the authority. Returns the campaigns it touched.
 */
export async function applyBounceStop(
  tx: Tx,
  input: { toNorm: string; recipientId: number; campaignId: number; scope: ReplyScope; inboundId: number; now: Date },
): Promise<number[]> {
  const real = input.scope === "real";
  const campaigns = real
    ? await openCampaigns(tx, { OR: [{ emailNorm: input.toNorm }, { id: input.recipientId }] })
    : [input.campaignId];
  await stopRecipients(tx, {
    emailNorm: input.toNorm,
    reason: "bounced",
    scope: real ? "real" : "campaign",
    recipientId: input.recipientId,
    inboundId: input.inboundId,
    now: input.now,
  });
  return campaigns;
}

/** Who should answer a reply and who hears about it (M4-DESIGN §4.2). */
export type ReplyAudience = { assigneeId: number | null; notify: number[] };

/**
 * The assignee and the notify set (M4-DESIGN §4.2), read before the transaction:
 *  - linked to an email: the email's sender while active, else the Owner; notified: the assignee, the owner of the
 *    address the reply reached (when active and someone else), and the Owner when it reached the catch-all;
 *  - linked to a company without an email, or unlinked human mail: the owner of the address it reached while active,
 *    else the Owner; notified: the assignee (and the Owner for the catch-all);
 *  - simulated: the campaign's sender while active, else the Owner, and nobody else (a dry run's placeholder address
 *    has no SenderAddress, which would otherwise look like the catch-all);
 *  - unlinked automatic replies and delivery notices, spam and test replies: nobody.
 */
export async function audienceFor(
  reader: DbOrTx,
  input: {
    kind: InboundKindValue;
    link: LinkTarget;
    spam: boolean;
    /** The linked email's sender (`OutboundEmail.senderId`). */
    senderId: number | null;
    /** The SenderAddress the reply reached (null: the catch-all or an unknown address). */
    senderAddressId: number | null;
    simulated: boolean;
    ownerId: number | null;
  },
): Promise<ReplyAudience> {
  const none: ReplyAudience = { assigneeId: null, notify: [] };
  if (input.kind === "TEST_REPLY" || input.spam) return none;
  if ((input.kind === "AUTO_REPLY" || input.kind === "BOUNCE_NOTICE") && input.link === "none") return none;

  const addressOwner =
    input.senderAddressId !== null
      ? ((await reader.senderAddress.findUnique({ where: { id: input.senderAddressId }, select: { userId: true } }))?.userId ?? null)
      : null;
  const ids = [input.senderId, addressOwner].filter((id): id is number => id !== null);
  const active = new Set(
    ids.length ? (await reader.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } })).map((u) => u.id) : [],
  );
  const activeOr = (id: number | null) => (id !== null && active.has(id) ? id : input.ownerId);
  const catchAll = input.senderAddressId === null ? input.ownerId : null;
  const list = (...xs: Array<number | null>) => [...new Set(xs.filter((x): x is number => x !== null))];

  if (input.simulated) {
    const assigneeId = activeOr(input.senderId);
    return { assigneeId, notify: list(assigneeId) };
  }
  if (input.link === "email") {
    const assigneeId = activeOr(input.senderId);
    const addressUser = addressOwner !== null && active.has(addressOwner) ? addressOwner : null;
    return { assigneeId, notify: list(assigneeId, addressUser, catchAll) };
  }
  const assigneeId = activeOr(addressOwner);
  return { assigneeId, notify: list(assigneeId, catchAll) };
}

/**
 * The audience worked out before the transaction, checked again inside it (M4-DESIGN §4.2, §3.7 "Sender switched
 * off"): someone may have been switched off in between, after their waiting replies were handed to the Owner. A
 * switched-off assignee is replaced by the active Owner, who is then told as well (so the reply never sits unseen on the
 * list of someone who can't sign in); switched-off people are dropped from the notify set.
 */
export async function confirmAudience(tx: Tx, audience: ReplyAudience): Promise<ReplyAudience> {
  const ids = [...new Set([audience.assigneeId, ...audience.notify].filter((id): id is number => id !== null))];
  if (ids.length === 0) return audience;
  const active = new Set((await tx.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } })).map((u) => u.id));
  const notify = audience.notify.filter((id) => active.has(id));
  if (audience.assigneeId === null || active.has(audience.assigneeId)) return { assigneeId: audience.assigneeId, notify };
  const ownerId = await activeOwnerId(tx);
  return { assigneeId: ownerId, notify: ownerId === null || notify.includes(ownerId) ? notify : [...notify, ownerId] };
}

/** `reply.attention` goes out once per person (or sender address, unlinked) and reason per 30 days (§5.5). */
export const ATTENTION_EVERY_MS = 30 * 86_400_000;

/**
 * True when an earlier message with the same key (the person it concerns, else the sender's address, and the same
 * `autoReason`) whose `reply.attention` really went out (it carries `ATTENTION_SENT_SIGNAL`) was processed in the last
 * 30 days: a challenge filter or a "left the company" auto-reply answers every follow-up, and one notice is enough (the
 * timeline still gets each). Rows that told nobody don't count: a quiet row (only the grouped notice), a repeat that
 * was itself skipped, a possible reply that got the `reply.possible` notice, a delivery failure that stopped the address.
 */
export async function attentionSentRecently(
  reader: DbOrTx,
  input: { inboundId: number; personId: number | null; fromEmail: string; autoReason: string | null; now: Date },
): Promise<boolean> {
  const since = new Date(input.now.getTime() - ATTENTION_EVERY_MS);
  const rows = await reader.inboundMessage.findMany({
    where: {
      id: { not: input.inboundId },
      processedAt: { gte: since },
      autoReason: input.autoReason,
      ...(input.personId !== null ? { personId: input.personId } : { fromEmail: input.fromEmail }),
      OR: [{ answerOutcome: null }, { answerOutcome: { not: "duplicate" } }],
    },
    select: { signals: true },
  });
  return rows.some((r) => Array.isArray(r.signals) && r.signals.includes(ATTENTION_SENT_SIGNAL));
}

/** Grouped notices for quiet rows: at most one unread notice of each grouped kind per person per 24 hours (§5.5). */
export const SUMMARY_EVERY_MS = 24 * 3_600_000;

/** What `sendReplyNotification` did: the row's own notice (to how many people), a grouped notice, or nothing. */
export type ReplyNotificationSent = { sent: "own" | "grouped" | "none"; count: number };

/**
 * Sends one reply notification inside `tx` (M4-DESIGN §5.1, §5.5): to `targets` (de-duplicated, switched-off users
 * skipped by `notifyUsers`), or, for a quiet row (received more than 3 days before processing), one grouped notice to
 * the assignee instead, unless they already have the same one unread from the last 24 hours. The grouped text depends
 * on where the row is: "Older replies were found … They're on Replies waiting for an answer" only for the kinds on
 * that list (`waiting`); delivery failure notices and automatic replies that need attention get "Older automatic
 * messages were found", which points at the Activity page instead.
 */
export async function sendReplyNotification(
  tx: Tx,
  input: {
    copy: ReplyNotificationCopy | null;
    targets: readonly number[];
    quiet: boolean;
    /** The row is on "Replies waiting for an answer" (REPLY, POSSIBLE_REPLY, UNLINKED). */
    waiting: boolean;
    assigneeId: number | null;
    now: Date;
  },
): Promise<ReplyNotificationSent> {
  const none: ReplyNotificationSent = { sent: "none", count: 0 };
  if (!input.copy) return none;
  if (input.quiet) {
    if (input.assigneeId === null) return none;
    const grouped = input.waiting ? replySummaryCopy() : replyAutoSummaryCopy();
    const since = new Date(input.now.getTime() - SUMMARY_EVERY_MS);
    const unread = await tx.notification.findFirst({
      where: { userId: input.assigneeId, type: grouped.type, link: grouped.link, readAt: null, createdAt: { gt: since } },
      select: { id: true },
    });
    if (unread) return none;
    const count = await notifyUsers([input.assigneeId], grouped, tx);
    return { sent: count > 0 ? "grouped" : "none", count };
  }
  const count = await notifyUsers(input.targets, input.copy, tx);
  return { sent: count > 0 ? "own" : "none", count };
}

/**
 * Copies a decided row's outcome to its twins (M4-DESIGN §3.7): the rows with the same Message-ID and sender that were
 * filed as duplicates get its kind, reason, links, scope, assignee and confirmation, and stay answered as duplicates,
 * so a twin never waits and never keeps a hold after the decision.
 */
export async function syncTwins(tx: Tx, sourceId: number): Promise<number> {
  const src = await tx.inboundMessage.findUnique({
    where: { id: sourceId },
    select: { ...TWIN_COPY_SELECT, messageIdHeader: true, fromEmail: true },
  });
  const messageIdHeader = (src?.messageIdHeader ?? "").trim();
  if (!src || !messageIdHeader) return 0;
  const res = await tx.inboundMessage.updateMany({
    where: { id: { not: sourceId }, messageIdHeader, fromEmail: src.fromEmail, answerOutcome: "duplicate" },
    data: {
      kind: src.kind,
      autoReason: src.autoReason,
      ...(src.signals !== null ? { signals: src.signals as Prisma.InputJsonValue } : {}),
      linkMethod: src.linkMethod,
      outboundEmailId: src.outboundEmailId,
      personId: src.personId,
      companyId: src.companyId,
      campaignId: src.campaignId,
      replyScope: src.replyScope,
      changesStatus: src.changesStatus,
      heldCompanyId: src.heldCompanyId,
      assigneeId: src.assigneeId,
      confirmedAt: src.confirmedAt,
      confirmedById: src.confirmedById,
    },
  });
  return res.count;
}

/** Names for sentences: a company (with its domain) and a person by id (one small read each; missing → null). */
export async function namesOf(
  reader: DbOrTx,
  ids: { companyId?: number | null; personId?: number | null },
): Promise<{ company: { id: number; name: string; domain: string | null; deletedAt: Date | null } | null; person: { id: number; name: string; email: string | null } | null }> {
  const [company, person] = await Promise.all([
    ids.companyId
      ? reader.company.findUnique({ where: { id: ids.companyId }, select: { id: true, name: true, domain: true, deletedAt: true } })
      : Promise.resolve(null),
    ids.personId ? reader.person.findUnique({ where: { id: ids.personId }, select: { id: true, name: true, email: true } }) : Promise.resolve(null),
  ]);
  return { company, person };
}
