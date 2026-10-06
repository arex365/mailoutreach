import type { Prisma } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { autoReasonLabel, possibleReplyReasons } from "@/core/replies/copy";
import { heldCompanyHint, removedContactHint, sameDomainHint, senderDomain } from "@/core/replies/hints";
import { replyLabel } from "@/core/replies/kind";
import { formatDateTime, formatShortDate, timeAgo } from "@/core/time/format";
import { db } from "@/server/db";
import { waitingReplyWhere } from "@/server/notifications";
import { QUIET_AFTER_MS } from "./process";

/**
 * "Replies waiting for an answer" (M4-DESIGN §4, §9.1) and the Owner's "Messages we couldn't link": read models for
 * the Notifications page (and M6's dashboard). Built from InboundMessage, never from notifications (read ones are
 * deleted after 90 days). A reply waits while it is processed, of kind REPLY, POSSIBLE_REPLY or UNLINKED, and not
 * answered; twins and spam never wait (their `answeredAt` is set at processing). Dry-run replies (campaign scope) are
 * listed with their badge but not counted in the bell (`waitingReplyCount`).
 */

/** The viewer (a SessionUser fits): whose "Yours" it is, and the zone dates are written in. */
export type WaitingViewer = { id: number; role: "OWNER" | "MEMBER"; timeZone: string };

/** One waiting reply as its card shows it (every date already written in the viewer's zone). */
export type WaitingReplyView = {
  id: number;
  kind: "REPLY" | "POSSIBLE_REPLY" | "UNLINKED";
  label: "" | "Dry run" | "Test";
  receivedIso: string;
  receivedAgo: string;
  receivedExact: string;
  /** Quiet rows: "Arrived on 12 Sep, before the app processed replies." / "… while the PC was off." */
  quietLine: string | null;
  fromEmail: string;
  /** The sender's name when they are a contact (a shared inbox is shown by its address); else null. */
  fromName: string | null;
  /** The sender is a live contact (a Person with exactly this address at a live company). */
  fromIsContact: boolean;
  company: { id: number; name: string } | null;
  /** The person the reply concerns (the linked email's recipient). */
  person: { id: number; name: string } | null;
  campaign: { id: number; name: string; step: number } | null;
  senderName: string | null;
  assigneeName: string | null;
  subject: string;
  firstLines: string;
  /** Why the app isn't sure (possible replies, and unlinked messages that may be automatic). */
  whyLines: string[];
  /** Unlinked replies: removed contact, same domain, on hold (§3.3.5). Never links by itself. */
  hints: string[];
  /** The company the Link dialog pre-selects: the domain hold's, else the first same-domain company. */
  hintCompanyId: number | null;
  /** A linked reply whose sender isn't a Person anywhere: "Add jonas@firma.de to Firma GmbH". */
  canAddPerson: boolean;
};

/** Waiting replies per page (§4.2). */
export const WAITING_PAGE_SIZE = 50;

const VIEW_SELECT = {
  id: true,
  kind: true,
  receivedAt: true,
  processedAt: true,
  source: true,
  fromEmail: true,
  subject: true,
  snippet: true,
  signals: true,
  bodyAvailable: true,
  autoReason: true,
  companyId: true,
  personId: true,
  campaignId: true,
  outboundEmailId: true,
  heldCompanyId: true,
  assigneeId: true,
  replyScope: true,
} as const;

type ViewRow = Prisma.InboundMessageGetPayload<{ select: typeof VIEW_SELECT }>;

/** A caller's `take` is capped at this (M6-DESIGN §4.2a: the dashboard asks for 5). */
export const WAITING_TAKE_MAX = 50;

/**
 * The `where` of waiting replies: everyone's, or the viewer's own (`assigneeId`). The shared rule
 * (`waitingReplyWhere`, M6-DESIGN D9) with dry-run replies included: they are listed with their badge.
 */
function waitingWhere(scope: "mine" | "everyone", viewerId: number): Prisma.InboundMessageWhereInput {
  return waitingReplyWhere(scope === "mine" ? { assigneeId: viewerId } : undefined, { dryRun: "include" });
}

const unique = <T>(list: Array<T | null | undefined>): T[] => [...new Set(list.filter((x): x is T => x !== null && x !== undefined))];

/** "Anna Berg", or the address for an unnamed person or a shared inbox. */
function personName(p: { id: number; name: string; email: string | null }): string {
  const name = p.name.trim();
  return name && name !== GENERAL_INBOX_NAME ? name : p.email || `Person ${p.id}`;
}

/** Builds the card views of these rows with a handful of batched reads. */
async function buildViews(rows: readonly ViewRow[], viewer: WaitingViewer, now: Date): Promise<WaitingReplyView[]> {
  if (rows.length === 0) return [];
  const unlinked = rows.filter((r) => r.kind === "UNLINKED");
  const domains = unique(unlinked.map((r) => senderDomain(r.fromEmail)));
  const [companies, persons, emails, campaigns, senders, sameDomain] = await Promise.all([
    db.company.findMany({
      where: { id: { in: unique(rows.flatMap((r) => [r.companyId, r.heldCompanyId])) } },
      select: { id: true, name: true },
    }),
    db.person.findMany({ where: { id: { in: unique(rows.map((r) => r.personId)) } }, select: { id: true, name: true, email: true } }),
    db.outboundEmail.findMany({
      where: { id: { in: unique(rows.map((r) => r.outboundEmailId)) } },
      select: { id: true, step: true, mode: true, senderId: true, campaignId: true },
    }),
    db.campaign.findMany({ where: { id: { in: unique(rows.map((r) => r.campaignId)) } }, select: { id: true, name: true } }),
    db.person.findMany({
      where: { emailNorm: { in: unique(rows.map((r) => r.fromEmail)) } },
      select: {
        id: true,
        name: true,
        isGeneric: true,
        emailNorm: true,
        deletedAt: true,
        company: { select: { id: true, name: true, deletedAt: true } },
      },
    }),
    domains.length
      ? db.company.findMany({
          where: { domain: { in: domains }, deletedAt: null },
          select: { id: true, name: true, domain: true },
          orderBy: { id: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
  ]);
  const byId = <T extends { id: number }>(list: readonly T[]) => new Map(list.map((x) => [x.id, x]));
  const companyMap = byId(companies);
  const personMap = byId(persons);
  const emailMap = byId(emails);
  const campaignMap = byId(campaigns);
  const senderMap = new Map(senders.map((p) => [p.emailNorm ?? "", p]));
  const users = byId(
    await db.user.findMany({
      where: { id: { in: unique([...emails.map((e) => e.senderId), ...rows.map((r) => r.assigneeId)]) } },
      select: { id: true, name: true },
    }),
  );

  return rows.map((r): WaitingReplyView => {
    const email = r.outboundEmailId !== null ? emailMap.get(r.outboundEmailId) : undefined;
    const company = r.companyId !== null ? companyMap.get(r.companyId) : undefined;
    const person = r.personId !== null ? personMap.get(r.personId) : undefined;
    const campaign = email ? campaignMap.get(email.campaignId) : undefined;
    const sender = senderMap.get(r.fromEmail);
    const fromIsContact = Boolean(sender && !sender.deletedAt && !sender.company.deletedAt);
    const fromName =
      sender && fromIsContact && !sender.isGeneric && sender.name.trim() && sender.name !== GENERAL_INBOX_NAME ? sender.name.trim() : null;
    const quiet =
      r.processedAt !== null && r.source !== "SIMULATED" && r.processedAt.getTime() - r.receivedAt.getTime() > QUIET_AFTER_MS;
    const day = formatShortDate(r.receivedAt, viewer.timeZone, now);
    const possible = r.kind === "POSSIBLE_REPLY" || (r.kind === "UNLINKED" && (r.autoReason !== null || !r.bodyAvailable));

    const hints: string[] = [];
    let hintCompanyId: number | null = null;
    if (r.kind === "UNLINKED") {
      if (sender && (sender.deletedAt || sender.company.deletedAt)) {
        hints.push(
          removedContactHint({
            fromEmail: r.fromEmail,
            personName: sender.name,
            companyId: sender.company.id,
            companyName: sender.company.name,
            companyRemoved: Boolean(sender.company.deletedAt),
          }),
        );
      }
      const same = sameDomainHint(r.fromEmail, sameDomain);
      hints.push(...same.map((h) => h.text));
      const held = r.heldCompanyId !== null ? companyMap.get(r.heldCompanyId) : undefined;
      if (held) hints.push(heldCompanyHint(held.name));
      hintCompanyId = r.heldCompanyId ?? same[0]?.companyId ?? null;
    }
    const label = replyLabel(r.replyScope, email?.mode ?? null).replace(/:\s*$/, "") as WaitingReplyView["label"];

    return {
      id: r.id,
      kind: r.kind as WaitingReplyView["kind"],
      label,
      receivedIso: r.receivedAt.toISOString(),
      receivedAgo: timeAgo(r.receivedAt, now),
      receivedExact: formatDateTime(r.receivedAt, viewer.timeZone),
      quietLine: quiet
        ? r.source === "CATCHUP"
          ? `Arrived on ${day} while the PC was off.`
          : `Arrived on ${day}, before the app processed replies.`
        : null,
      fromEmail: r.fromEmail,
      fromName,
      fromIsContact,
      company: company ? { id: company.id, name: company.name } : null,
      person: person ? { id: person.id, name: personName(person) } : null,
      campaign: email && campaign ? { id: campaign.id, name: campaign.name, step: email.step } : null,
      senderName: email?.senderId ? (users.get(email.senderId)?.name ?? null) : null,
      assigneeName: r.assigneeId !== null ? (users.get(r.assigneeId)?.name ?? null) : null,
      subject: r.subject,
      firstLines: r.snippet,
      whyLines: possible ? possibleReplyReasons(r.signals, r.bodyAvailable, r.autoReason) : [],
      hints,
      hintCompanyId,
      canAddPerson: r.companyId !== null && !sender,
    };
  });
}

/** A page size from a caller's `take`: a whole number from 1 to 50; missing or unusable → 50 per page. */
function waitingPageSize(take: number | undefined): number {
  if (take === undefined || !Number.isFinite(take)) return WAITING_PAGE_SIZE;
  return Math.min(WAITING_TAKE_MAX, Math.max(1, Math.floor(take)));
}

/**
 * The waiting list (M4-DESIGN §4): "everyone" (every waiting reply) or "mine" (assigned to the viewer), oldest first,
 * 50 per page, or `take` per page (at most 50; the dashboard's list asks for 5, M6-DESIGN §4.2a). `mine` and
 * `everyone` are the two toggle counts; `total` the chosen view's, so "(3 more)" is `total − rows.length`.
 */
export async function listWaitingReplies(
  viewer: WaitingViewer,
  opts: { scope: "mine" | "everyone"; page?: number; now?: Date; take?: number },
): Promise<{ rows: WaitingReplyView[]; total: number; mine: number; everyone: number; page: number; pageCount: number }> {
  const now = opts.now ?? new Date();
  const pageSize = waitingPageSize(opts.take);
  const [mine, everyone] = await Promise.all([
    db.inboundMessage.count({ where: waitingWhere("mine", viewer.id) }),
    db.inboundMessage.count({ where: waitingWhere("everyone", viewer.id) }),
  ]);
  const total = opts.scope === "mine" ? mine : everyone;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  const rows = await db.inboundMessage.findMany({
    where: waitingWhere(opts.scope, viewer.id),
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: VIEW_SELECT,
  });
  return { rows: await buildViews(rows, viewer, now), total, mine, everyone, page, pageCount };
}

/** One reply by id for the pinned card (§4.3), whatever page or view it is on; null when it isn't waiting. */
export async function getWaitingReply(viewer: WaitingViewer, id: number, now: Date = new Date()): Promise<WaitingReplyView | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.inboundMessage.findFirst({ where: { id, ...waitingWhere("everyone", viewer.id) }, select: VIEW_SELECT });
  if (!row) return null;
  return (await buildViews([row], viewer, now))[0] ?? null;
}

/** The Owner's list looks back this far. */
export const OTHER_MESSAGES_DAYS = 30;
const OTHER_MESSAGES_MAX = 100;

/**
 * The Owner's "Messages we couldn't link (last 30 days)" (M4-DESIGN §5.5, §9.1): automatic replies, delivery notices
 * and messages Mailgun marked as spam that weren't linked to a company, newest first, with what each one was ("out of
 * office", "delivery failure", "help desk confirmation", "marked as spam by Mailgun"…). Empty for Members.
 */
export async function listOtherMessages(
  viewer: WaitingViewer,
  now: Date = new Date(),
): Promise<Array<{ id: number; fromEmail: string; subject: string; what: string; receivedExact: string }>> {
  if (viewer.role !== "OWNER") return [];
  const rows = await db.inboundMessage.findMany({
    where: {
      processedAt: { not: null },
      companyId: null,
      receivedAt: { gte: new Date(now.getTime() - OTHER_MESSAGES_DAYS * 86_400_000) },
      AND: [
        { OR: [{ answerOutcome: null }, { answerOutcome: { not: "duplicate" } }] },
        { OR: [{ kind: { in: ["AUTO_REPLY", "BOUNCE_NOTICE"] } }, { kind: "UNLINKED", answerOutcome: "spam" }] },
      ],
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: OTHER_MESSAGES_MAX,
    select: { id: true, kind: true, fromEmail: true, subject: true, autoReason: true, receivedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    fromEmail: r.fromEmail,
    subject: r.subject,
    what: autoReasonLabel(r.kind === "BOUNCE_NOTICE" ? (r.autoReason ?? "dsn") : r.autoReason),
    receivedExact: formatDateTime(r.receivedAt, viewer.timeZone),
  }));
}

/** A company as the Link dialog shows it after it was picked: its name, whether it was deleted, and its people. */
export type LinkCompanyView = { id: number; name: string; deleted: boolean; people: Array<{ id: number; label: string }> };

/** The picked company for the Link dialog (M4-DESIGN §9.1): its live people for the "Person" select. Null when unknown. */
export async function getLinkCompany(companyId: number): Promise<LinkCompanyView | null> {
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  const c = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      deletedAt: true,
      people: { where: { deletedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, email: true } },
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    deleted: c.deletedAt !== null,
    people: c.people.map((p) => {
      const name = personName(p);
      return { id: p.id, label: p.email && name !== p.email ? `${name} (${p.email})` : name };
    }),
  };
}
