import type { EventSource, SendMode } from "@/generated/prisma/client";
import { eventEffect, type MailEventType, type NormalizedEvent } from "@/core/mailgun/events";
import { stepTitle } from "@/core/rules/wording";
import { logActivity } from "@/server/activity";
import { db, dbTx, dbWrite } from "@/server/db";
import { notifyOwner } from "@/server/notifications";
import { getSetting } from "@/server/settings";
import { shouldSendNotice } from "@/server/state-typed";
import { ensureSentFromEvent, scopeFor, type EventMatch, type EventScope } from "./apply";

/**
 * The event lane's work (M3-DESIGN §4.4.3): every stored MailEvent that isn't processed yet, oldest first. Stops,
 * suppressions and dates were already applied when the event was stored; what is left here is:
 *  1. the proof of sending (outside any transaction; markSent has its own), so an `accepted` event stays unprocessed
 *     until the email it proves is recorded as sent;
 *  2. in one short transaction: mark it processed (compare-and-set) and write the activity ("Delivered to …",
 *     "Bounced: … (reason)", "… marked the email as spam", "… unsubscribed") and, for a real complaint, the Owner's
 *     notification;
 *  3. count the real bounces and complaints of our emails, so the caller can run the health check.
 * A failing event is retried on the next tick; after 5 failures it is set processed without its activity (logged, and
 * notice "event-failed"), so one bad event can never hold an address for ever (the send-time guard waits for it).
 */

export type ProcessResult = { processed: number; problems: { bounces: number; complaints: number } };

/** Events handled per call (one lane tick). */
export const EVENT_BATCH = 50;
/** After this many failures an event is given up (set processed without its activity). */
export const EVENT_MAX_FAILURES = 5;

type Logger = { error: (message: string, err?: unknown) => void };

const defaultLogger: Logger = { error: (m, err) => console.error(`[event-lane] ${m}`, err ?? "") };

/** Failures per event id when the caller keeps no map of its own (one per process). */
const sharedFailures = new Map<number, number>();

type EventRow = {
  id: number;
  type: string;
  severity: string | null;
  reason: string | null;
  occurredAt: Date;
  messageId: string | null;
  recipient: string | null;
  outboundEmailId: number | null;
  testSendId: number | null;
  isTestMode: boolean;
  source: EventSource;
  raw: unknown;
};

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asType(v: string): MailEventType {
  return v === "accepted" || v === "delivered" || v === "failed" || v === "complained" || v === "unsubscribed" ? v : "other";
}

/** The stored row as a NormalizedEvent again (the delivery status comes from the raw payload). */
export function rowEvent(row: EventRow): NormalizedEvent {
  const raw = obj(row.raw);
  const ds = obj(raw?.["delivery-status"]);
  const code = ds && typeof ds.code === "number" ? ds.code : ds && typeof ds.code === "string" && /^\d+$/.test(ds.code) ? Number(ds.code) : null;
  return {
    dedupeKey: "",
    providerEventId: "",
    type: asType(row.type),
    severity: row.severity === "permanent" || row.severity === "temporary" ? row.severity : null,
    reason: row.reason,
    occurredAt: row.occurredAt,
    messageId: row.messageId,
    recipient: row.recipient,
    userVariables: {},
    tags: [],
    isTestMode: row.isTestMode,
    domain: null,
    deliveryStatus: ds
      ? { code, message: text(ds.message), description: text(ds.description), bounceType: text(ds["bounce-type"])?.toLowerCase() ?? null }
      : null,
    raw: row.raw,
  };
}

/** A short, plain reason for "Bounced: anna@studio.de (<reason>)". */
export function shortBounceReason(ev: Pick<NormalizedEvent, "reason" | "deliveryStatus">): string {
  const r = ev.reason ?? "";
  if (r === "suppress-bounce") return "it bounced before";
  if (r === "suppress-unsubscribe") return "it unsubscribed before";
  if (r === "suppress-complaint") return "it marked an email as spam before";
  if (r.startsWith("suppress-")) return "Mailgun won't deliver to it";
  const msg = ev.deliveryStatus?.description || ev.deliveryStatus?.message;
  if (msg) {
    const one = msg.replace(/\s+/g, " ").trim();
    return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
  }
  return r || "no reason given";
}

/** Who clicked "Simulate" (simulated events only): stored in the event's raw payload by simulate.ts. */
function simulatedBy(row: EventRow): { id: number; name: string } | null {
  if (row.source !== "SIMULATED") return null;
  const raw = obj(row.raw);
  const id = raw && typeof raw.byUserId === "number" ? raw.byUserId : null;
  const name = raw ? text(raw.byName) : null;
  return id !== null ? { id, name: name ?? "someone" } : null;
}

type EmailFacts = {
  id: number;
  step: number;
  mode: SendMode;
  toEmail: string;
  toNorm: string;
  recipientId: number;
  campaignId: number;
  companyId: number | null;
  personId: number | null;
  campaignName: string;
};

async function loadEmail(id: number): Promise<EmailFacts | null> {
  const e = await db.outboundEmail.findUnique({
    where: { id },
    select: {
      id: true,
      step: true,
      mode: true,
      toEmail: true,
      toNorm: true,
      recipientId: true,
      campaignId: true,
      companyId: true,
      personId: true,
      campaign: { select: { name: true } },
    },
  });
  return e ? { ...e, campaignName: e.campaign.name } : null;
}

/** Activity type and summary for an event; null = no activity (temporary failures, accepted, other). */
function activityFor(ev: NormalizedEvent, address: string): { type: string; summary: string } | null {
  switch (ev.type) {
    case "delivered":
      return { type: "email.delivered", summary: `Delivered to ${address}` };
    case "failed": {
      const effect = eventEffect(ev);
      if (effect.stop !== "bounced" && effect.stop !== "unsubscribed" && effect.stop !== "complained") return null;
      return { type: "email.bounced", summary: `Bounced: ${address} (${shortBounceReason(ev)})` };
    }
    case "complained":
      return { type: "email.complained", summary: `${address} marked the email as spam` };
    case "unsubscribed":
      return { type: "email.unsubscribed", summary: `${address} unsubscribed` };
    default:
      return null;
  }
}

/**
 * True when the same event (same type and severity, same email or address) was already processed under another row:
 * the webhook and the Logs can report one event twice, and it should read once in the activity log.
 */
async function hasProcessedTwin(row: EventRow): Promise<boolean> {
  const where = {
    id: { not: row.id },
    type: row.type,
    severity: row.severity,
    processedAt: { not: null },
    ...(row.messageId ? { messageId: row.messageId } : row.recipient ? { recipient: row.recipient } : { id: -1 }),
  };
  return (await db.mailEvent.count({ where })) > 0;
}

/** One event: proof of sending, then processed + activity in one transaction. Returns its health effects. */
async function processOne(row: EventRow, now: Date, practiceCopy: boolean): Promise<{ bounce: boolean; complaint: boolean }> {
  const ev = rowEvent(row);
  await ensureSentFromEvent({ outboundEmailId: row.outboundEmailId, testSendId: row.testSendId }, ev);

  const email = row.outboundEmailId !== null ? await loadEmail(row.outboundEmailId) : null;
  const test =
    row.testSendId !== null
      ? await db.testSend.findUnique({ where: { id: row.testSendId }, select: { id: true, purpose: true, to: true } })
      : null;
  const match: EventMatch = email
    ? {
        kind: "email",
        id: email.id,
        recipientId: email.recipientId,
        campaignId: email.campaignId,
        companyId: email.companyId,
        personId: email.personId,
        toNorm: email.toNorm,
        toEmail: email.toEmail,
        mode: email.mode,
      }
    : test
      ? { kind: "test", id: test.id, purpose: test.purpose, to: test.to }
      : { kind: "none" };
  const scope: EventScope = scopeFor(match, ev, practiceCopy);
  const address = email?.toEmail ?? test?.to ?? ev.recipient ?? "an unknown address";
  const activity = scope === "none" ? null : activityFor(ev, address);
  const twin = activity ? await hasProcessedTwin(row) : false;

  // Unmatched (and test-email) events log on the person with that address, if there is one.
  let personId = email?.personId ?? null;
  let companyId = email?.companyId ?? null;
  if (!email && activity && !twin && ev.recipient) {
    const person = await db.person.findUnique({ where: { emailNorm: ev.recipient }, select: { id: true, companyId: true } });
    personId = person?.id ?? null;
    companyId = person?.companyId ?? null;
  }
  const by = simulatedBy(row);

  const effect = eventEffect(ev);
  const realComplaint = scope === "real" && ev.type === "complained" && !ev.isTestMode;

  await dbTx(async (tx) => {
    const claimed = await tx.mailEvent.updateMany({ where: { id: row.id, processedAt: null }, data: { processedAt: now } });
    if (claimed.count !== 1 || !activity || twin) return;
    await logActivity(
      {
        actorId: by?.id ?? null,
        type: activity.type,
        summary: by ? `${activity.summary} (simulated by ${by.name})` : activity.summary,
        companyId,
        personId,
        campaignId: email?.campaignId ?? null,
        mode: email?.mode ?? null,
        data: {
          eventId: row.id,
          ...(email ? { emailId: email.id, step: email.step } : {}),
          ...(ev.reason ? { reason: ev.reason } : {}),
          ...(ev.deliveryStatus?.code !== null && ev.deliveryStatus?.code !== undefined ? { code: ev.deliveryStatus.code } : {}),
          ...(ev.deliveryStatus?.message ? { message: ev.deliveryStatus.message.slice(0, 500) } : {}),
          ...(row.source === "SIMULATED" ? { simulated: true } : {}),
        },
      },
      tx,
    );
    if (realComplaint) {
      await notifyOwner(
        {
          type: "email.complained",
          title: `${address} marked an email as spam`,
          body: email
            ? `${email.campaignName} · ${stepTitle(email.step)}. They won't be emailed again.`
            : "They won't be emailed again.",
          link: companyId ? `/contacts?company=${companyId}` : "/settings/deliverability",
        },
        tx,
      );
    }
  });

  return {
    bounce: scope === "real" && email !== null && effect.health === "bounce",
    complaint: realComplaint && email !== null,
  };
}

/**
 * Processes up to `limit` (50) unprocessed events, oldest first. Returns how many were handled and the real bounces
 * and complaints among them (for the health check). `failures` counts failures per event id across calls (the lane
 * keeps one map); at the 5th failure the event is set processed without its activity and notice "event-failed" goes
 * to the Owner (at most once a day).
 */
export async function processPendingMailEvents(
  opts: { now?: Date; limit?: number; failures?: Map<number, number>; logger?: Logger } = {},
): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const failures = opts.failures ?? sharedFailures;
  const logger = opts.logger ?? defaultLogger;
  const rows = await db.mailEvent.findMany({
    where: { processedAt: null },
    orderBy: { id: "asc" },
    take: Math.max(1, Math.floor(opts.limit ?? EVENT_BATCH)),
    select: {
      id: true,
      type: true,
      severity: true,
      reason: true,
      occurredAt: true,
      messageId: true,
      recipient: true,
      outboundEmailId: true,
      testSendId: true,
      isTestMode: true,
      source: true,
      raw: true,
    },
  });
  const result: ProcessResult = { processed: 0, problems: { bounces: 0, complaints: 0 } };
  if (rows.length === 0) return result;
  const practiceCopy = (await getSetting("practice.copy")) === true;

  for (const row of rows) {
    try {
      const effects = await processOne(row, now, practiceCopy);
      failures.delete(row.id);
      result.processed += 1;
      if (effects.bounce) result.problems.bounces += 1;
      if (effects.complaint) result.problems.complaints += 1;
    } catch (err) {
      const n = (failures.get(row.id) ?? 0) + 1;
      failures.set(row.id, n);
      if (n < EVENT_MAX_FAILURES) {
        logger.error(`Mailgun report #${row.id} couldn't be processed (try ${n} of ${EVENT_MAX_FAILURES})`, err);
        continue;
      }
      failures.delete(row.id);
      logger.error(`Gave up on Mailgun report #${row.id} after ${EVENT_MAX_FAILURES} tries`, err);
      try {
        await dbWrite((c) => c.mailEvent.updateMany({ where: { id: row.id, processedAt: null }, data: { processedAt: now } }));
        result.processed += 1;
        if (await shouldSendNotice("event-failed", now)) {
          await notifyOwner({
            type: "system.mailgun",
            title: "A Mailgun report couldn't be processed",
            body: "The app skipped one report from Mailgun after 5 tries. Nothing was sent because of it; details are in the background sender's log.",
            link: "/settings/sending",
          });
        }
      } catch (inner) {
        logger.error(`Couldn't set Mailgun report #${row.id} aside`, inner);
      }
    }
  }
  return result;
}
