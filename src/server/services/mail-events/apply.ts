import { Prisma, type EventSource, type SendMode, type SuppressionReason } from "@/generated/prisma/client";
import { normalizeEmail } from "@/core/email-address";
import { eventEffect, SUPPRESSION_PRECEDENCE, type EventEffect, type NormalizedEvent } from "@/core/mailgun/events";
import { countsAsReal } from "@/core/rules/mode";
import { db, dbTx, dbWrite, type DbOrTx, type Tx } from "@/server/db";
import { getSetting } from "@/server/settings";
import { markSent } from "@/server/services/sending/mark-sent";
import { stopRecipients, type StopReason } from "./stops";

/**
 * One way to apply a Mailgun event (PLAN B6.11, M3-DESIGN §4.4.2), whatever brought it: a webhook, the Logs catch-up,
 * a suppression-list pull or the dry-run outbox's "Simulate" buttons. Everything is idempotent and order-independent:
 * the same set of events, applied in any order and any number of times, gives the same rows (earliest dates, the
 * strongest stop and suppression).
 *
 * Scopes: an event may change the person, the do-not-email list and health ("real" scope) only when the email counts
 * as a real send; a dry run on real data or Mailgun's test mode changes only that campaign's own rows ("campaign");
 * "Send me a test" to your own reply inbox changes nothing ("none"), so your inbox never lands on the list.
 */

export type EventScope = "real" | "campaign" | "none";

export type ApplyResult = {
  status: "created" | "duplicate";
  eventId: number;
  outboundEmailId: number | null;
  testSendId: number | null;
  scope: EventScope;
  /** Recipients newly stopped by this event. */
  stopped: number;
  /** What happened to the address's do-not-email entry (null: the event doesn't suppress, or not in real scope). */
  suppression: "created" | "raised" | "kept" | null;
};

export type ApplyOptions = {
  now: Date;
  practiceCopy: boolean;
  /** Store the event as already processed (suppression-list events: the lane has nothing to do for them). */
  processed?: boolean;
  /**
   * The event comes from one of Mailgun's suppression lists (catch-up pull, §4.4.5 step 3): an address that is already
   * on the local list only gets `pushedToMailgunAt`; its reason and the person's flags stay as they are, because the
   * list entry may be the app's own push.
   */
  fromList?: boolean;
  /**
   * Setting "mailgun.domain" (read inside the transaction when not given). `pushedToMailgunAt` is only set from an
   * event of this domain: its lists are the ones the push keeps complete.
   */
  activeDomain?: string | null;
};

/** The email (or test email) an event belongs to. */
export type EventMatch =
  | {
      kind: "email";
      id: number;
      recipientId: number;
      campaignId: number;
      companyId: number | null;
      personId: number | null;
      toNorm: string;
      toEmail: string;
      mode: SendMode;
    }
  | { kind: "test"; id: number; purpose: string; to: string }
  | { kind: "none" };

const EMAIL_SELECT = {
  id: true,
  recipientId: true,
  campaignId: true,
  companyId: true,
  personId: true,
  toNorm: true,
  toEmail: true,
  mode: true,
} as const;

function emailMatch(row: {
  id: number;
  recipientId: number;
  campaignId: number;
  companyId: number | null;
  personId: number | null;
  toNorm: string;
  toEmail: string;
  mode: SendMode;
}): EventMatch {
  return { kind: "email", ...row };
}

/**
 * Finds the email an event belongs to, in this order: our Message-ID; Mailgun's own id saved as providerId (when it
 * rewrote ours); a test email (by Message-ID or provider id); our `send_id` user variable; a test email's
 * `test_send_id` user variable.
 */
export async function matchEvent(reader: DbOrTx, ev: Pick<NormalizedEvent, "messageId" | "userVariables">): Promise<EventMatch> {
  const messageId = ev.messageId;
  if (messageId) {
    const byId = await reader.outboundEmail.findUnique({ where: { messageId }, select: EMAIL_SELECT });
    if (byId) return emailMatch(byId);
    const byProvider = await reader.outboundEmail.findFirst({ where: { providerId: messageId }, orderBy: { id: "asc" }, select: EMAIL_SELECT });
    if (byProvider) return emailMatch(byProvider);
    const test = await reader.testSend.findFirst({
      where: { OR: [{ messageId }, { providerId: messageId }] },
      orderBy: { id: "asc" },
      select: { id: true, purpose: true, to: true },
    });
    if (test) return { kind: "test", ...test };
  }
  const sendId = ev.userVariables.send_id;
  if (sendId) {
    const bySend = await reader.outboundEmail.findUnique({ where: { sendId }, select: EMAIL_SELECT });
    if (bySend) return emailMatch(bySend);
  }
  const testSendId = Number(ev.userVariables.test_send_id);
  if (Number.isInteger(testSendId) && testSendId > 0) {
    const test = await reader.testSend.findUnique({ where: { id: testSendId }, select: { id: true, purpose: true, to: true } });
    if (test) return { kind: "test", ...test };
  }
  return { kind: "none" };
}

/** The scope rules of §4.4.2 step 3. */
export function scopeFor(match: EventMatch, ev: Pick<NormalizedEvent, "isTestMode">, practiceCopy: boolean): EventScope {
  if (match.kind === "email") return countsAsReal(match.mode, practiceCopy) && !ev.isTestMode ? "real" : "campaign";
  if (match.kind === "test" && match.purpose === "SELF") return "none";
  return ev.isTestMode ? "none" : "real";
}

/** The address an event's effects use: the matched row's own address (the event may say "[redacted]"). */
export function addressFor(match: EventMatch, ev: Pick<NormalizedEvent, "recipient">): string | null {
  if (match.kind === "email") return match.toNorm;
  if (match.kind === "test") return normalizeEmail(match.to);
  return normalizeEmail(ev.recipient);
}

function suppressionRank(reason: string): number {
  return SUPPRESSION_PRECEDENCE.indexOf(reason);
}

function suppressionSource(source: EventSource): string {
  if (source === "WEBHOOK") return "webhook";
  if (source === "SIMULATED") return "simulated";
  return "mailgun-sync";
}

/** Sets a date column only when it is empty or later than `at` (earliest wins). Returns true when it changed. */
async function earliest(
  tx: Tx,
  table: "outboundEmail" | "person",
  where: { id: number } | { emailNorm: string },
  field: string,
  at: Date,
): Promise<boolean> {
  const filter = { ...where, OR: [{ [field]: null }, { [field]: { gt: at } }] };
  const data = { [field]: at };
  const res =
    table === "outboundEmail"
      ? await tx.outboundEmail.updateMany({ where: filter as Prisma.OutboundEmailWhereInput, data })
      : await tx.person.updateMany({ where: filter as Prisma.PersonWhereInput, data });
  return res.count > 0;
}

type ExistingSuppression = { id: number; reason: SuppressionReason; pushedToMailgunAt: Date | null } | null;

/**
 * The stop code that matches an address's do-not-email reason. A suppression-list entry for an address already on the
 * local list may be the app's own push (every local entry goes to Mailgun's unsubscribes list, whatever its reason), so
 * it stops with the reason the app already knows, never relabelling "do not email" or "bounced" as "unsubscribed".
 */
export function stopForReason(reason: SuppressionReason): StopReason {
  if (reason === "BOUNCED") return "bounced";
  if (reason === "UNSUBSCRIBED") return "unsubscribed";
  if (reason === "COMPLAINED") return "complained";
  return "suppressed";
}

/** Step 7: the person's flag and the do-not-email entry (real scope only). */
async function suppress(
  tx: Tx,
  address: string,
  effect: EventEffect,
  ev: NormalizedEvent,
  source: EventSource,
  opts: ApplyOptions & { activeDomain: string | null },
  existing: ExistingSuppression,
): Promise<{ suppression: "created" | "raised" | "kept"; changed: boolean }> {
  const reason = effect.suppression as SuppressionReason;
  // Mailgun already lists the address on the ACTIVE domain, so nothing needs pushing there. Simulated events and the
  // practice copy never talk to Mailgun.
  const onActiveList =
    effect.inMailgunList && source !== "SIMULATED" && !opts.practiceCopy && Boolean(ev.domain) && ev.domain === opts.activeDomain;
  const pushedAt = onActiveList ? opts.now : null;
  const detail = ev.deliveryStatus?.message ? ev.deliveryStatus.message.slice(0, 300) : null;

  if (existing && opts.fromList) {
    // Possibly our own push coming back: keep the reason and the person's flags; Mailgun has it, that's all.
    if (existing.pushedToMailgunAt === null && onActiveList) {
      await tx.suppression.update({ where: { id: existing.id }, data: { pushedToMailgunAt: opts.now } });
      return { suppression: "kept", changed: true };
    }
    return { suppression: "kept", changed: false };
  }

  let changed = false;
  if (effect.personField) changed = await earliest(tx, "person", { emailNorm: address }, effect.personField, ev.occurredAt);

  if (!existing) {
    await tx.suppression.create({
      data: { emailNorm: address, reason, source: suppressionSource(source), detail, pushedToMailgunAt: pushedAt },
    });
    return { suppression: "created", changed: true };
  }
  if (suppressionRank(reason) > suppressionRank(existing.reason)) {
    await tx.suppression.update({
      where: { id: existing.id },
      data: { reason, source: suppressionSource(source), detail, pushedToMailgunAt: pushedAt },
    });
    return { suppression: "raised", changed: true };
  }
  return { suppression: "kept", changed };
}

function jsonOf(raw: unknown): Prisma.InputJsonValue {
  if (raw === null || raw === undefined) return {};
  return raw as Prisma.InputJsonValue;
}

/**
 * Applies one event inside `tx` (§4.4.2):
 *  1. already stored (same dedupe key) → "duplicate": nothing is written, but the matched ids are returned so the
 *     caller's proof-of-sending step can still repair a row whose markSent never ran;
 *  2. match the email; 3. decide the scope;
 *  5. the email's date field (earliest wins);
 *  6. the stop (the matched row's address; every campaign in real scope, else only that row's recipient; a
 *     suppression-list entry for an address already on the local list stops with the local reason's code);
 *  7. real scope: the person's flag (earliest wins) and the do-not-email entry (strongest reason wins);
 *  4. the MailEvent row itself, unprocessed (except "other" events and `processed`), with stopAppliedAt when 5–7 changed
 *     anything.
 * No network here: the caller runs `ensureSentFromEvent` after the transaction.
 */
export async function applyMailEvent(tx: Tx, ev: NormalizedEvent, source: EventSource, opts: ApplyOptions): Promise<ApplyResult> {
  const existing = await tx.mailEvent.findUnique({
    where: { dedupeKey: ev.dedupeKey },
    select: { id: true, outboundEmailId: true, testSendId: true },
  });
  const match = await matchEvent(tx, ev);
  const scope = scopeFor(match, ev, opts.practiceCopy);
  const outboundEmailId = match.kind === "email" ? match.id : null;
  const testSendId = match.kind === "test" ? match.id : null;
  if (existing) {
    return {
      status: "duplicate",
      eventId: existing.id,
      outboundEmailId: existing.outboundEmailId ?? outboundEmailId,
      testSendId: existing.testSendId ?? testSendId,
      scope,
      stopped: 0,
      suppression: null,
    };
  }

  const effect = eventEffect(ev);
  let changed = false;
  let stopped = 0;
  let suppression: ApplyResult["suppression"] = null;

  // 5. The email's own date field.
  if (match.kind === "email" && effect.dateField) {
    changed = (await earliest(tx, "outboundEmail", { id: match.id }, effect.dateField, ev.occurredAt)) || changed;
  }

  // 6. The stop. The address's do-not-email entry is read once, here, for steps 6 and 7.
  const address = addressFor(match, ev);
  const existingSuppression: ExistingSuppression =
    scope === "real" && effect.suppression && address
      ? await tx.suppression.findUnique({ where: { emailNorm: address }, select: { id: true, reason: true, pushedToMailgunAt: true } })
      : null;
  // A list entry for an address the app already lists (possibly its own push coming back): stop with the reason the
  // app knows (§4.4.5: such an entry "only gets pushedToMailgunAt").
  const stopReason: StopReason | null =
    opts.fromList && existingSuppression ? stopForReason(existingSuppression.reason) : effect.stop;
  if (stopReason && scope !== "none" && address) {
    if (scope === "real" && effect.stopEveryCampaign) {
      stopped = await stopRecipients(tx, {
        emailNorm: address,
        reason: stopReason,
        scope: "real",
        recipientId: match.kind === "email" ? match.recipientId : null,
        now: opts.now,
      });
    } else if (match.kind === "email") {
      stopped = await stopRecipients(tx, {
        emailNorm: address,
        reason: stopReason,
        scope: "campaign",
        recipientId: match.recipientId,
        now: opts.now,
      });
    }
    if (stopped > 0) changed = true;
  }

  // 7. Person flag and do-not-email entry (real scope only).
  if (scope === "real" && effect.suppression && address) {
    const activeDomain =
      opts.activeDomain !== undefined
        ? opts.activeDomain
        : await tx.setting
            .findUnique({ where: { key: "mailgun.domain" }, select: { value: true } })
            .then((r) => (typeof r?.value === "string" ? r.value.trim().toLowerCase() : null));
    const s = await suppress(tx, address, effect, ev, source, { ...opts, activeDomain }, existingSuppression);
    suppression = s.suppression;
    if (s.changed) changed = true;
  }

  // 4. The event row.
  const row = await tx.mailEvent.create({
    data: {
      dedupeKey: ev.dedupeKey,
      type: ev.type,
      severity: ev.severity,
      reason: ev.reason,
      occurredAt: ev.occurredAt,
      messageId: ev.messageId,
      recipient: ev.recipient,
      outboundEmailId,
      testSendId,
      isTestMode: ev.isTestMode,
      source,
      raw: jsonOf(ev.raw),
      stopAppliedAt: changed ? opts.now : null,
      processedAt: opts.processed || ev.type === "other" ? opts.now : null,
    },
    select: { id: true },
  });
  return { status: "created", eventId: row.id, outboundEmailId, testSendId, scope, stopped, suppression };
}

/** True for the unique-key error a create gets when the other process stored the same row first. */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2002";
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

/**
 * Runs `fn` again when it lost a unique-key race (the web process and the worker stored the same event or reply at the
 * same moment): the second run then sees the stored row and answers "duplicate".
 */
export async function retryOnUnique<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err) || i >= tries - 1) throw err;
    }
  }
}

/**
 * Applies one event in its own short transaction, then runs the proof-of-sending step (its failure is logged, never
 * thrown: the event lane repeats it). Reads Setting "practice.copy".
 */
export async function applyMailEventNow(
  ev: NormalizedEvent,
  source: EventSource,
  opts: { now?: Date; processed?: boolean; fromList?: boolean } = {},
): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const practiceCopy = (await getSetting("practice.copy")) === true;
  const result = await retryOnUnique(() =>
    dbTx((tx) => applyMailEvent(tx, ev, source, { now, practiceCopy, processed: opts.processed, fromList: opts.fromList })),
  );
  try {
    await ensureSentFromEvent(result, ev);
  } catch (err) {
    console.error("[mail-events] the proof-of-sending step failed; the event lane will repeat it", err);
  }
  return result;
}

/** Event types that prove Mailgun accepted the email (every type except "other"). */
function provesAccepted(type: string): boolean {
  return type === "accepted" || type === "delivered" || type === "failed" || type === "complained" || type === "unsubscribed";
}

const TEST_OPEN_STATUSES = ["SENDING", "UNKNOWN", "UNCONFIRMED"] as const;

/**
 * Proof of sending (§4.4.2, §9.2 item 25): any Mailgun event about one of our TEST/LIVE emails means Mailgun accepted
 * it, so it must never be sent again. When the matched row isn't SENT yet (UNKNOWN, UNCONFIRMED, even QUEUED), its
 * providerId is saved first (compare-and-set, when empty) from the event's Message-ID, then markSent records it with
 * the earliest proving event's time. Test emails still SENDING/UNKNOWN become SENT the same way. Dry-run rows are never
 * touched. Idempotent; runs outside any transaction (markSent has its own).
 */
export async function ensureSentFromEvent(
  r: Pick<ApplyResult, "outboundEmailId"> & { testSendId?: number | null },
  ev: Pick<NormalizedEvent, "type" | "occurredAt" | "messageId">,
): Promise<"sent" | "already" | "not-proof" | "no-row"> {
  if (!provesAccepted(ev.type)) return "not-proof";

  if (r.outboundEmailId !== null) {
    const row = await db.outboundEmail.findUnique({
      where: { id: r.outboundEmailId },
      select: { id: true, mode: true, status: true, providerId: true },
    });
    if (!row) return "no-row";
    if (row.mode === "DRY_RUN") return "not-proof";
    if (row.status === "SENT") return "already";
    const first = await db.mailEvent.findFirst({
      where: { outboundEmailId: row.id, type: { in: ["accepted", "delivered", "failed", "complained", "unsubscribed"] } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    });
    const acceptedAt = first && first.occurredAt.getTime() < ev.occurredAt.getTime() ? first.occurredAt : ev.occurredAt;
    let providerId = row.providerId;
    if (!providerId && ev.messageId) {
      await dbWrite((c) =>
        c.outboundEmail.updateMany({
          where: { id: row.id, providerId: null, status: { not: "SENT" } },
          data: { providerId: ev.messageId },
        }),
      );
      providerId = ev.messageId;
    }
    const res = await markSent(row.id, acceptedAt, { providerId });
    return res.alreadySent ? "already" : "sent";
  }

  if (r.testSendId !== null && r.testSendId !== undefined) {
    const test = await db.testSend.findUnique({ where: { id: r.testSendId }, select: { id: true, status: true, providerId: true } });
    if (!test) return "no-row";
    if (test.status === "SENT") return "already";
    if (!(TEST_OPEN_STATUSES as readonly string[]).includes(test.status)) return "already";
    const res = await dbWrite((c) =>
      c.testSend.updateMany({
        where: { id: test.id, status: { in: [...TEST_OPEN_STATUSES] } },
        data: { status: "SENT", providerId: test.providerId ?? ev.messageId ?? null, error: null },
      }),
    );
    return res.count > 0 ? "sent" : "already";
  }
  return "no-row";
}
