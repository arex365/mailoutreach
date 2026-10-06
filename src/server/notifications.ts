import type { Notification, Prisma } from "@/generated/prisma/client";
import { WAITING_KINDS } from "@/core/replies/types";
import { OUTAGE_HOLD_NOTIFICATION, type NotificationFilter } from "@/core/notification-types";
import { safeAppPath } from "@/core/safe-path";
import { db, dbWrite, type DbOrTx } from "./db";

/**
 * In-app notifications (PLAN.md B6.14, SPEC §10, M4-DESIGN §5). Shared by the web app and the worker.
 *
 * Types in use (keep this list up to date; M4-DESIGN §5.1 has the copy of the reply and outage types):
 *  reply.received            a new reply (to the assignee, the owner of the address it reached, and the Owner for the
 *                            catch-all); "<prefix>New reply from Firma GmbH"
 *  reply.possible            a message that may be a reply: its company's follow-ups wait until someone decides
 *  reply.unlinked            a reply we couldn't link to a company (or couldn't read: the fail-safe, to the Owner)
 *  reply.summary             "Older replies were found": one grouped notice per assignee for replies processed more
 *                            than 3 days after they arrived (at most one unread per 24 hours, hasUnreadSince)
 *  reply.attention           a spam filter holds your email, a person left the company, or a forward from their
 *                            mailbox failed (to the sender; once per person and reason per 30 days)
 *  reply.bounce              a delivery-failure notice reached our reply address: that address's follow-ups stopped
 *  outage.hold               follow-ups are on hold because the PC was off too long to check for replies (to each
 *                            affected active sender, in their own time zone, and one Owner version)
 *  campaign.finished         a campaign finished (to the sender and the creator)   (Milestone 2+)
 *  campaign.sender           someone else launched a campaign that sends as you    (Milestone 2+)
 *  campaign.reservationsExpired  a paused campaign let go of its companies (launcher + Owner)
 *  sending.paused            sending paused: "Sending paused: <reason>" (to the Owner; not for the Owner's own pause)
 *  sending.warning           half the bounce or complaint limit reached (to the Owner)
 *  sending.capReached        today's limit is reached, once per cap day (to the Owner)
 *  email.complained          a complaint, or new addresses on Mailgun's complaint list (to the Owner)
 *  email.unconfirmed         "1 email needs your decision": Retry or Skip (to the sender and the Owner)
 *  restore.checked           the check with Mailgun after a restore finished, or failed (to the Owner)
 *  verify.finished           address checks finished: "Address checks finished (for Germany Q4)" with the run's summary
 *                            (to the requester of a wizard, Contacts or list run; not for panel or Settings checks); and
 *                            "Left out after a second address check" (to the sender of each campaign where the re-check
 *                            sweep's run left someone out)                                           (Milestone 5)
 *  verify.paused             "Address checks paused" / "… stopped" (monthly limit) with the pause text (to the Owner)
 *  ai.draftsReady            "AI lines ready to review" when a Contacts or list drafting run finished (to the requester)
 *  ai.runStopped             "AI drafting stopped early": the run was about to cost more than expected (to the requester)
 *  ai.paused                 "AI drafting paused" / "… stopped" (monthly limit) with the pause text (to the Owner)
 *  auth.lockout              5 wrong passwords from one place: sign-in slowed down (to the Owner)
 *  user.joined, user.passwordReset, user.reactivated, user.ownershipTransferred, user.replyInbox
 *  user.senderAddress        a Member changed their sending address (to the Owner); in shared-From mode "… changed their
 *                            reply address", "From now on, replies to Ali's campaigns go to …" (SHARED-FROM-DESIGN §3.6)
 *  system.worker
 *  system.mailgun            Mailgun problems, at most once a day per notice key: key refused, not allowed, queue
 *                            stopped, tracking switched on, webhooks rejected, catch-up failing, certificate ready or
 *                            expired, options too large, Mailgun unreachable, sent but not recorded, message IDs
 *                            rewritten, an email accepted twice, a report skipped; and Apply / reply-test failures
 *  system.replyRoute         a reply route isn't working, or Mailgun won't forward to a reply inbox (to the Owner)
 *  system.tunnel             remote access (Cloudflare Tunnel) is down (to the Owner)
 *  task.failed, backup.failed, backup.copyFailed, backup.clockWrong   a background task / backup failed (to the Owner)
 *  sending.wentLive          "The app is live": the Owner switched on Go live (to every active user, from goLive();
 *                            link /dashboard; no pop-up group, filed under "Sending and system")      (Milestone 6)
 *  reply.inboxCheck          own-mailbox mode (MAIN-DOMAIN-DESIGN O33, §7.6): "Live emails wait for today's inbox check"
 *                            (INBOX_CHECK_TEXTS.notificationTitle/notificationBody), to the Owner from the sending loop
 *                            while a tick holds a live email for the inbox check (a follow-up, or since review SEND-1 a
 *                            first email to an already-emailed company); at most once per 24 hours (notice
 *                            key "inbox-check"); link /notifications#inbox-check; in the Replies pop-up group (on by
 *                            default) and the Notifications filter "Replies"
 *
 * Throttled Owner notices use SystemState "notices" (shouldSendNotice in @/server/state-typed), one per key per 24 h:
 *  mailgun-auth, mailgun-not-allowed, mailgun-queue, tracking-drift, webhook-rejected, catchup-failing, tunnel-down,
 *  cert-expired, options-too-large, mailgun-unreachable, reply-route-down, sent-not-recorded, message-id-rewritten,
 *  email-duplicate, event-failed, reply-inbox-suppressed;
 *  Milestone 5, type verify.paused (CHECK_PAUSE_NOTICE_KEYS): verify-auth, verify-payment, verify-refused (not allowed,
 *  business verification and not found share it), verify-unreadable, verify-monthly-limit;
 *  type ai.paused (AI_PAUSE_NOTICE_KEYS): ai-key, ai-permission, ai-model, ai-spend-cap, ai-own-limit, ai-billing,
 *  ai-monthly-limit, ai-no-price;
 *  Milestone 6, type system.mailgun: catchup-old-domain ("Couldn't check an old sending domain": an older sending domain
 *  the catch-up hasn't been able to check for 24 hours; one key for every old domain, naming the one unchecked longest).
 *  Shared From address (SHARED-FROM-DESIGN F27, §3.8), type system.mailgun, link /settings/domain, sent by the domain
 *  check (domain-check.ts, FROM_DOMAIN_NOTICE_TEXTS): from-mx-bad ("Mail for polygonparadise.com goes to the wrong
 *  place": the main domain's MX points to Mailgun or is missing, live emails wait) and from-spf-broken
 *  ("polygonparadise.com's SPF record is broken": 2+ records, a missing included record, or more than 10 lookups).
 *  Own-mailbox mode (MAIN-DOMAIN-DESIGN O10, O33, §7.6): from-mx-bad is also sent for the sending domain itself, with the
 *  own-mailbox body (FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn: a Mailgun MX, a null or missing MX, or Cloudflare Email
 *  Routing; live emails wait); from-spf-broken is never sent in that mode (it has no from-spf row); and inbox-check
 *  (type reply.inboxCheck, above) comes from the sending loop.
 * The Milestone 5 and 6 types have no pop-up group; the Notifications page files them under "Sending and system".
 *
 * Desktop pop-ups (if the person switched them on in that browser) are shown only for the types of the pop-up groups
 * the person chose (POPUP_GROUP_TYPES in @/core/notification-types; replies by default), created in the last 10 minutes
 * (popupsAfter). The Notifications page filters by notificationFilterOf (All · Unread · Replies · Campaigns · Sending
 * and system), and "Replies waiting for an answer" is built from InboundMessage, never from notifications (read ones
 * are deleted after 90 days).
 */

export type NotificationInput = {
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  /** An in-app path such as "/contacts?company=12". Anything else is dropped. */
  link?: string | null;
};

/** What the browser sees (dates as ISO strings). */
export type NotificationItem = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
};

export type UnreadSummary = { unread: number; latest: NotificationItem[] };

/**
 * Only same-app paths are allowed as links, so a notification can never send someone elsewhere.
 * Same check as the sign-in redirect (@/core/safe-path); links longer than 500 characters are dropped.
 */
export function safeNotificationLink(link: string | null | undefined): string | null {
  return safeAppPath(link, 500);
}

function toRow(input: NotificationInput) {
  return {
    userId: input.userId,
    type: input.type.slice(0, 100),
    title: input.title.trim().slice(0, 200),
    body: input.body ? input.body.trim().slice(0, 1000) : null,
    link: safeNotificationLink(input.link),
  };
}

export function toNotificationItem(n: Notification): NotificationItem {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  };
}

/** Creates one notification, inside an existing transaction (tx) or on its own. */
export async function createNotification(input: NotificationInput, tx?: DbOrTx): Promise<Notification> {
  const data = toRow(input);
  if (tx) return tx.notification.create({ data });
  return dbWrite((c) => c.notification.create({ data }));
}

/** The active Owner's id (the first by id), or null when there is none (e.g. before first-run setup). */
export async function activeOwnerId(reader: DbOrTx = db): Promise<number | null> {
  const owner = await reader.user.findFirst({
    where: { role: "OWNER", active: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return owner?.id ?? null;
}

/** Notifies the active Owner. Returns null when there is none (e.g. before first-run setup). */
export async function notifyOwner(input: Omit<NotificationInput, "userId">, tx?: DbOrTx): Promise<Notification | null> {
  const ownerId = await activeOwnerId(tx ?? db);
  if (ownerId === null) return null;
  return createNotification({ ...input, userId: ownerId }, tx);
}

/**
 * Creates one notification per distinct active user id (nulls, duplicates and switched-off users skipped), inside
 * `tx` or on its own, in the order the ids are given (M4-DESIGN §5.5 "one notification per reply per person").
 * Returns how many were created.
 */
export async function notifyUsers(
  userIds: Iterable<number | null | undefined>,
  input: Omit<NotificationInput, "userId">,
  tx?: DbOrTx,
): Promise<number> {
  const wanted: number[] = [];
  for (const id of userIds) {
    if (typeof id === "number" && Number.isInteger(id) && !wanted.includes(id)) wanted.push(id);
  }
  if (wanted.length === 0) return 0;
  const reader = tx ?? db;
  const active = new Set(
    (await reader.user.findMany({ where: { id: { in: wanted }, active: true }, select: { id: true } })).map((u) => u.id),
  );
  const data = wanted.filter((id) => active.has(id)).map((userId) => toRow({ ...input, userId }));
  if (data.length === 0) return 0;
  if (tx) await tx.notification.createMany({ data });
  else await dbWrite((c) => c.notification.createMany({ data }));
  return data.length;
}

/** Marks some (or all) of a user's notifications read. Returns how many changed. */
export async function markRead(userId: number, ids: number[] | "all", now = new Date()): Promise<number> {
  if (ids !== "all" && ids.length === 0) return 0;
  const res = await dbWrite((c) =>
    c.notification.updateMany({
      where: { userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
      data: { readAt: now },
    }),
  );
  return res.count;
}

/** The bell: unread count plus the latest few (read or not). */
export async function unreadSummary(userId: number, limit = 5): Promise<UnreadSummary> {
  const [unread, latest] = await Promise.all([
    db.notification.count({ where: { userId, readAt: null } }),
    db.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
  ]);
  return { unread, latest: latest.map(toNotificationItem) };
}

export const NOTIFICATIONS_PAGE_SIZE = 50;

export type NotificationPage = {
  items: NotificationItem[];
  total: number;
  unread: number;
  page: number;
  pageCount: number;
};

/** Types the "Campaigns" filter shows besides `campaign.*` (the same rule as notificationFilterOf). */
const CAMPAIGN_FILTER_TYPES = [OUTAGE_HOLD_NOTIFICATION, "email.unconfirmed"];

/**
 * The `where` of one list filter for one user (M4-DESIGN §5.5), the database form of `notificationFilterOf` from
 * @/core/notification-types: "replies" = `reply.*`; "campaigns" = `campaign.*`, `outage.hold` and
 * `email.unconfirmed`; "system" = everything else; "unread" = not read yet; "all" = everything.
 */
export function notificationFilterWhere(userId: number, filter: NotificationFilter): Prisma.NotificationWhereInput {
  const replies: Prisma.NotificationWhereInput = { type: { startsWith: "reply." } };
  const campaigns: Prisma.NotificationWhereInput = {
    OR: [{ type: { startsWith: "campaign." } }, { type: { in: CAMPAIGN_FILTER_TYPES } }],
  };
  switch (filter) {
    case "unread":
      return { userId, readAt: null };
    case "replies":
      return { userId, ...replies };
    case "campaigns":
      return { userId, ...campaigns };
    case "system":
      return { userId, AND: [{ NOT: replies }, { NOT: campaigns }] };
    default:
      return { userId };
  }
}

/**
 * The Notifications page: newest first, 50 per page, narrowed by a list filter (default "all"). `total` counts the
 * filtered list; `unread` is always every unread notification of the user (the page header).
 */
export async function listNotifications(
  userId: number,
  page = 1,
  pageSize = NOTIFICATIONS_PAGE_SIZE,
  filter: NotificationFilter = "all",
): Promise<NotificationPage & { filter: NotificationFilter }> {
  const where = notificationFilterWhere(userId, filter);
  const [total, unread] = await Promise.all([
    db.notification.count({ where }),
    db.notification.count({ where: { userId, readAt: null } }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const rows = await db.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (current - 1) * pageSize,
    take: pageSize,
  });
  return { items: rows.map(toNotificationItem), total, unread, page: current, pageCount, filter };
}

/** Pop-ups look back this far (M4-DESIGN §5.2): anything older is only in the bell and on the page. */
export const POPUP_WINDOW_MS = 10 * 60_000;
/** At most this many pop-up items per poll (the bell shows one batch pop-up when more are new, §5.3). */
export const POPUP_MAX_ITEMS = 5;

/**
 * The desktop pop-ups for one poll (M4-DESIGN §5.2): the user's notifications with `id > after`, of `types`, created
 * at or after `now − windowMs` (10 minutes). `items` = the oldest `max` (5) of them, oldest first; `count` = how many
 * match in total; `latestId` = the highest matching id (null when none). No types → nothing.
 */
export async function popupsAfter(
  userId: number,
  opts: { after: number; types: readonly string[]; now: Date; windowMs?: number; max?: number },
): Promise<{ items: NotificationItem[]; count: number; latestId: number | null }> {
  const types = [...new Set(opts.types)];
  if (types.length === 0) return { items: [], count: 0, latestId: null };
  const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after)) : 0;
  const since = new Date(opts.now.getTime() - (opts.windowMs ?? POPUP_WINDOW_MS));
  const where: Prisma.NotificationWhereInput = { userId, id: { gt: after }, type: { in: types }, createdAt: { gte: since } };
  const [items, count, latest] = await Promise.all([
    db.notification.findMany({ where, orderBy: { id: "asc" }, take: Math.max(0, Math.floor(opts.max ?? POPUP_MAX_ITEMS)) }),
    db.notification.count({ where }),
    db.notification.findFirst({ where, orderBy: { id: "desc" }, select: { id: true } }),
  ]);
  return { items: items.map(toNotificationItem), count, latestId: latest?.id ?? null };
}

/** The user's highest notification id, 0 when none (the bell's first poll only records it). */
export async function latestNotificationId(userId: number): Promise<number> {
  const row = await db.notification.findFirst({ where: { userId }, orderBy: { id: "desc" }, select: { id: true } });
  return row?.id ?? 0;
}

/**
 * Which dry-run replies (replyScope "campaign": a simulated reply on real data, or Mailgun's test mode) a waiting-reply
 * `where` covers: "exclude" (every count: the bell, the dashboard), "include" (the lists: shown with their badge, and
 * the rows a switched-off user hands to the Owner), "only" (the dashboard's "Dry-run replies waiting").
 */
export type WaitingDryRun = "exclude" | "include" | "only";

/**
 * The one "waiting reply" rule (M4-DESIGN §4.1, M6-DESIGN §4.3 and D9), shared by the bell, the dashboard, the Team
 * page and the waiting list: processed, not answered, kind REPLY / POSSIBLE_REPLY / UNLINKED; by default not a
 * dry-run reply (the counting rule). `extra` narrows it (e.g. `{assigneeId}`) and is ANDed, so its keys never clash
 * with the rule's own. In the practice copy simulated replies have the real scope, so they count.
 */
export function waitingReplyWhere(
  extra?: Prisma.InboundMessageWhereInput,
  opts: { dryRun?: WaitingDryRun } = {},
): Prisma.InboundMessageWhereInput {
  const base: Prisma.InboundMessageWhereInput = {
    kind: { in: [...WAITING_KINDS] },
    answeredAt: null,
    processedAt: { not: null },
  };
  const dryRun = opts.dryRun ?? "exclude";
  const parts: Prisma.InboundMessageWhereInput[] = [];
  if (dryRun === "exclude") parts.push({ OR: [{ replyScope: null }, { replyScope: { not: "campaign" } }] });
  if (dryRun === "only") parts.push({ replyScope: "campaign" });
  if (extra) parts.push(extra);
  return parts.length > 0 ? { ...base, AND: parts } : base;
}

/**
 * Waiting replies assigned to the user (`waitingReplyWhere`): dry-run replies are listed on the page but not counted
 * here (the bell's line "3 replies waiting for your answer"). The dashboard's per-user counts use the same rule.
 */
export async function waitingReplyCount(userId: number): Promise<number> {
  return db.inboundMessage.count({ where: waitingReplyWhere({ assigneeId: userId }) });
}

/** True when the user has an unread notification of this type created after `since` (the `reply.summary` rule, §5.5). */
export async function hasUnreadSince(userId: number, type: string, since: Date, reader: DbOrTx = db): Promise<boolean> {
  const row = await reader.notification.findFirst({
    where: { userId, type, readAt: null, createdAt: { gt: since } },
    select: { id: true },
  });
  return row !== null;
}
