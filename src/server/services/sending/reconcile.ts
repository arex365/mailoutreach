import type { SendMode } from "@/generated/prisma/client";
import { normalizeLogItem, type NormalizedEvent } from "@/core/mailgun/events";
import { effectiveLogRetentionDays } from "@/core/mailgun/plan";
import { MAX_FUTURE_MS } from "@/core/mailgun/signature";
import { stepName } from "@/core/rules/wording";
import { mailgunDomainOf } from "@/core/sending/from-address";
import { parseLogsFormState } from "@/core/system-state-parse";
import { STATE_KEYS, type LogsFormState } from "@/core/system-state";
import { db, dbWrite } from "@/server/db";
import { createNotification } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import { readTyped, updateTyped } from "@/server/state-typed";
import { clientFor, getMailgunContext, type MailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { loadPlanLimits } from "@/server/services/mailgun/plan";
import type { MailgunClient } from "@/server/mailgun/client";
import type { LogsFilter, LogsQuery, MailgunRegion } from "@/server/mailgun/types";
import { endedCampaignMessage } from "./claim";
import { markSent } from "./mark-sent";

/**
 * The reconciler (PLAN B6.7, M3-DESIGN §4.3.6): every TEST/LIVE email whose outcome isn't known
 * gets settled with Mailgun, without ever sending an email twice. Runs right after start-up, then
 * every 10 minutes (worker/reconciler.ts), oldest first, 50 rows per step:
 *  1. "Sending" for more than 2 minutes and not in the sending loop's hands (the worker stopped mid-
 *     send) → "Checking whether it was sent" (UNKNOWN). Never reset: Mailgun may have it.
 *  2. UNKNOWN with Mailgun's id saved (the send was proven, only recording it failed) → markSent.
 *  3. Other UNKNOWN rows → looked up in Mailgun's logs by Message-ID, by send id and by recipient;
 *     any hit → markSent with the event's time.
 *  4. "Not sent" needs proof that an empty answer can be trusted: an email Mailgun certainly has
 *     (the positive control) must be found by the same queries first.
 *  5. Only then, and only for rows claimed 45+ minutes ago and still inside Mailgun's log retention,
 *     back to the queue with the SAME Message-ID (cancelled when the campaign has ended).
 *  6. Still undecided after 2 hours (or near the end of the log retention) → "Not sure it was sent"
 *     (UNCONFIRMED): the sender and the Owner are told and a person chooses Retry or Skip. A later
 *     proof of sending still turns it Sent automatically.
 * Without Mailgun, steps 1, 2 and 6 only. The events it sees are applied by the next catch-up (the
 * same Logs); the reconciler only records the sends.
 *
 * This PC's clock may be off; Mailgun stamps events with its own time. So every Logs query ends
 * LOGS_END_MARGIN_MS after "now" (the webhooks' 1 h allowance: Mailgun simply has nothing past its
 * own present), and the control's window is anchored on the control's own claim time (this PC's
 * clock, like the email's) and ends CONTROL_WINDOW_AFTER_MS after it: shorter than any requeued
 * email's window. With the clock behind, the control's event then falls outside its window before the
 * email's would, so a clock that hides the email's event also hides the control's: never requeued.
 */

export const RECONCILE_INTERVAL_MS = 10 * 60_000;
export const STUCK_SENDING_MS = 2 * 60_000;
export const NOT_SENT_MIN_AGE_MS = 45 * 60_000;
export const UNCONFIRMED_AFTER_MS = 2 * 3_600_000;
export const LOOKBACK_BEFORE_CLAIM_MS = 10 * 60_000;
export const CONTROL_LOOKBACK_MS = 6 * 3_600_000;
/** Every Logs query ends this long after this PC's "now" (the same 1 h allowance the webhooks give a slow clock). */
export const LOGS_END_MARGIN_MS = MAX_FUTURE_MS;
/**
 * The most time between an email's claim and Mailgun's "accepted" (preparing the email, then the 30 s POST), with
 * room to spare. The control's window is this much shorter than the shortest window a requeued email is searched in.
 */
export const CLAIM_TO_ACCEPTED_MAX_MS = 5 * 60_000;
/** The control is searched from 10 minutes before its claim to this long after it (1 h 40 min). */
export const CONTROL_WINDOW_AFTER_MS = NOT_SENT_MIN_AGE_MS + LOGS_END_MARGIN_MS - CLAIM_TO_ACCEPTED_MAX_MS;
export const RECONCILE_LIMIT = 50;
/** Pages read per log query (one email's events fit on the first page). */
const QUERY_MAX_PAGES = 20;

export const CHECKING_MESSAGE = "Checking with Mailgun whether it was sent";
export const NEVER_RECEIVED_MESSAGE = "Mailgun never received it; it will be sent again";
export const UNCONFIRMED_MESSAGE = "We couldn't confirm with Mailgun whether it was sent";

export type ReconcileResult = {
  checked: number;
  sent: number;
  requeued: number;
  cancelled: number;
  unconfirmed: number;
  stillUnknown: number;
  error: string | null;
};

const MAILGUN_MODES: SendMode[] = ["TEST", "LIVE"];

type UnknownRow = {
  id: number;
  campaignId: number;
  step: number;
  toEmail: string;
  toNorm: string;
  fromAddress: string;
  /** Shared-From mode: the Reply-To; the Logs to search are those of its domain (SHARED-FROM-DESIGN §2.3). */
  replyTo: string | null;
  messageId: string;
  sendId: string;
  claimedAt: Date | null;
  createdAt: Date;
  campaign: { name: string; status: "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "FINISHED" | "CANCELLED"; senderId: number | null };
};

type Search = { complete: boolean; events: NormalizedEvent[]; error: string | null };

/** Every event of one Logs query (normalised); `complete` only when the walk reached the end without an error. */
async function logSearch(client: MailgunClient, q: LogsQuery, signal?: AbortSignal): Promise<Search> {
  const events: NormalizedEvent[] = [];
  try {
    const walk = await client.walkLogs(
      q,
      async (items) => {
        for (const item of items) {
          const ev = normalizeLogItem(item);
          if (ev) events.push(ev);
        }
      },
      { signal, maxPages: QUERY_MAX_PAGES },
    );
    return { complete: walk.complete, events, error: walk.complete ? null : `The log search stopped early (${walk.stoppedBecause}).` };
  } catch (err) {
    return { complete: false, events, error: err instanceof Error ? err.message : String(err) };
  }
}

function messageIdValue(id: string, form: "plain" | "bracketed"): string {
  return form === "bracketed" ? `<${id}>` : id;
}

type Searcher = {
  client: MailgunClient;
  domain: string;
  signal?: AbortSignal;
};

function query(s: Searcher, start: Date, end: Date, events: string[], filter: LogsFilter): LogsQuery {
  return {
    start,
    end,
    events,
    filters: [{ attribute: "domain", comparator: "=", value: s.domain }, filter],
  };
}

/**
 * Looks for one email by its Message-ID in the proven form (both forms while unproven). Returns the
 * matching events, whether every query finished, and the form that found it.
 */
async function byMessageId(
  s: Searcher,
  messageId: string,
  start: Date,
  end: Date,
  form: LogsFormState["messageIdForm"],
): Promise<Search & { form: "plain" | "bracketed" | null }> {
  const forms: Array<"plain" | "bracketed"> = form ? [form] : ["plain", "bracketed"];
  let complete = true;
  let error: string | null = null;
  for (const f of forms) {
    const r = await logSearch(
      s.client,
      query(s, start, end, ["accepted", "delivered", "failed"], { attribute: "message_id", comparator: "=", value: messageIdValue(messageId, f) }),
      s.signal,
    );
    const hits = r.events.filter((e) => e.messageId === messageId);
    if (hits.length > 0) return { complete: true, events: hits, error: null, form: f };
    complete &&= r.complete;
    error ??= r.error;
  }
  return { complete, events: [], error, form: null };
}

async function bySendId(s: Searcher, sendId: string, start: Date, end: Date): Promise<Search> {
  const r = await logSearch(
    s.client,
    query(s, start, end, ["accepted", "delivered", "failed"], { attribute: "user_variables", comparator: "contains", value: sendId }),
    s.signal,
  );
  return { ...r, events: r.events.filter((e) => e.userVariables.send_id === sendId) };
}

async function byRecipient(s: Searcher, row: UnknownRow, start: Date, end: Date): Promise<Search> {
  const r = await logSearch(
    s.client,
    query(s, start, end, ["accepted", "failed"], { attribute: "recipient", comparator: "=", value: row.toNorm }),
    s.signal,
  );
  return { ...r, events: r.events.filter((e) => e.userVariables.send_id === row.sendId || e.messageId === row.messageId) };
}

async function saveLogsForm(change: Partial<LogsFormState>, now: Date): Promise<void> {
  await updateTyped(STATE_KEYS.logsForm, parseLogsFormState, (cur) => {
    const next = { ...cur, ...change };
    if (
      next.messageIdForm === cur.messageIdForm &&
      next.sendIdFilterOk === cur.sendIdFilterOk &&
      cur.provenAt !== null
    ) {
      return null;
    }
    return { ...next, provenAt: now.toISOString() };
  }).catch((err: unknown) => console.error("[reconcile] couldn't save what Mailgun's Logs filters do", err));
}

/**
 * The control's window: from 10 minutes before its claim (this PC's clock, like the email's) to
 * CONTROL_WINDOW_AFTER_MS after it, never past the email's own query end. Anchored on the claim, not
 * on sentAt, because sentAt may be Mailgun's own event time (proven from an event), which would hide a
 * clock that is off.
 */
function controlWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  const end = Math.min(anchor.getTime() + CONTROL_WINDOW_AFTER_MS, now.getTime() + LOGS_END_MARGIN_MS);
  return { start: new Date(anchor.getTime() - LOOKBACK_BEFORE_CLAIM_MS), end: new Date(end) };
}

/**
 * The positive control (§4.3.6 step 4): the newest email Mailgun certainly has (a SENT TEST/LIVE
 * row, else a test send with Mailgun's id) on the same domain, sent in the 6 hours before the
 * row's claim, must be found by the same query shapes over a window no longer than the row's (see
 * controlWindow: that also catches this PC's clock being behind Mailgun's). The proven forms are
 * remembered in SystemState "mailgun.logsForm".
 */
async function positiveControl(
  s: Searcher,
  claimedAt: Date,
  now: Date,
  logsForm: LogsFormState,
): Promise<{ ok: boolean; form: "plain" | "bracketed" | null }> {
  const from = new Date(claimedAt.getTime() - CONTROL_LOOKBACK_MS);
  const control = await db.outboundEmail.findFirst({
    where: {
      status: "SENT",
      mode: { in: MAILGUN_MODES },
      sentAt: { gte: from, lte: claimedAt },
      messageId: { endsWith: `@${s.domain}` },
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    select: { messageId: true, sendId: true, sentAt: true, claimedAt: true },
  });
  if (control?.sentAt) {
    const { start, end } = controlWindow(control.claimedAt ?? control.sentAt, now);
    const a = await byMessageId(s, control.messageId, start, end, logsForm.messageIdForm);
    const b = await bySendId(s, control.sendId, start, end);
    const sendIdOk = b.events.length > 0;
    if (a.form || sendIdOk) {
      await saveLogsForm({ ...(a.form ? { messageIdForm: a.form } : {}), ...(sendIdOk ? { sendIdFilterOk: true } : {}) }, now);
    }
    return { ok: a.form !== null && sendIdOk, form: a.form };
  }
  const test = await db.testSend.findFirst({
    where: {
      providerId: { not: null },
      messageId: { endsWith: `@${s.domain}` },
      sentAt: { gte: from, lte: claimedAt },
      status: "SENT",
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    select: { messageId: true, sentAt: true },
  });
  if (!test?.messageId) return { ok: false, form: null };
  // A test send's sentAt is this PC's time when it was handed to Mailgun.
  const tw = controlWindow(test.sentAt, now);
  const a = await byMessageId(s, test.messageId, tw.start, tw.end, logsForm.messageIdForm);
  if (a.form) await saveLogsForm({ messageIdForm: a.form }, now);
  // A test send carries no send id, so the send-id filter only counts as proven from an earlier campaign email.
  return { ok: a.form !== null && logsForm.sendIdFilterOk === true, form: a.form };
}

async function notifyUnconfirmed(row: UnknownRow): Promise<void> {
  const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, select: { id: true }, orderBy: { id: "asc" } });
  const to = new Set<number>();
  if (row.campaign.senderId) to.add(row.campaign.senderId);
  if (owner) to.add(owner.id);
  for (const userId of to) {
    await createNotification({
      userId,
      type: "email.unconfirmed",
      title: "1 email needs your decision",
      body: `We can't tell whether the ${stepName(row.step)} to ${row.toEmail} went out. Open the campaign and choose Retry or Skip.`,
      link: `/campaigns/${row.campaignId}`,
    });
  }
}

function regionOf(v: unknown): MailgunRegion {
  return v === "US" ? "US" : "EU";
}

/** One reconciler pass. Never throws for a Mailgun problem: the rows simply wait for the next pass. */
export async function reconcileSends(
  opts: {
    now?: Date;
    limit?: number;
    mailgun?: () => Promise<MailgunContextResult>;
    signal?: AbortSignal;
    inFlight?: ReadonlySet<number>;
  } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.floor(opts.limit ?? RECONCILE_LIMIT));
  const inFlight = opts.inFlight ?? new Set<number>();
  const result: ReconcileResult = { checked: 0, sent: 0, requeued: 0, cancelled: 0, unconfirmed: 0, stillUnknown: 0, error: null };
  const noteError = (text: string) => {
    result.error ??= text;
  };

  // 1. Sending for more than 2 minutes, and not in the sending loop's hands: the worker stopped mid-send.
  const stuck = await db.outboundEmail.findMany({
    where: { status: "SENDING", mode: { in: MAILGUN_MODES }, claimedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, claimedAt: true },
  });
  for (const r of stuck) {
    if (inFlight.has(r.id)) continue;
    await dbWrite((c) =>
      c.outboundEmail.updateMany({
        where: { id: r.id, status: "SENDING", claimedAt: r.claimedAt },
        data: { status: "UNKNOWN", lastError: CHECKING_MESSAGE },
      }),
    );
  }

  // 2. UNKNOWN with Mailgun's id: the send is proven, only recording it failed.
  const proven = await db.outboundEmail.findMany({
    where: { status: "UNKNOWN", mode: { in: MAILGUN_MODES }, providerId: { not: null } },
    orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, claimedAt: true, providerId: true, createdAt: true },
  });
  for (const r of proven) {
    result.checked += 1;
    try {
      await markSent(r.id, r.claimedAt ?? r.createdAt, { providerId: r.providerId });
      result.sent += 1;
    } catch (err) {
      result.stillUnknown += 1;
      noteError(`Couldn't record email #${r.id} as sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3–6. Other UNKNOWN rows.
  const unknown: UnknownRow[] = await db.outboundEmail.findMany({
    where: { status: "UNKNOWN", mode: { in: MAILGUN_MODES }, providerId: null },
    orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      campaignId: true,
      step: true,
      toEmail: true,
      toNorm: true,
      fromAddress: true,
      replyTo: true,
      messageId: true,
      sendId: true,
      claimedAt: true,
      createdAt: true,
      campaign: { select: { name: true, status: true, senderId: true } },
    },
  });
  if (unknown.length === 0) return result;

  const s = await getSettings(["mailgun.logRetentionDays"] as const);
  // MAIN-DOMAIN-DESIGN O26: never more days than the Mailgun plan keeps (today's reading of the setting first, so app
  // mode without a plan is unchanged).
  const retentionDays = effectiveLogRetentionDays(Math.max(1, Math.floor(Number(s["mailgun.logRetentionDays"]) || 5)), await loadPlanLimits());
  const retentionMs = retentionDays * 86_400_000;
  const unconfirmAfter = Math.min(UNCONFIRMED_AFTER_MS, retentionMs - 3_600_000);
  let ctx: MailgunContextResult;
  try {
    ctx = await (opts.mailgun ?? (() => getMailgunContext()))();
  } catch (err) {
    ctx = { connected: false, reason: "no-key", text: err instanceof Error ? err.message : String(err) };
  }
  let logsForm = (await readTyped(STATE_KEYS.logsForm, parseLogsFormState)).value;
  const regions = new Map<string, MailgunRegion>();
  const controls = new Map<string, boolean>();

  const searcherFor = async (mg: MailgunContext, domain: string): Promise<Searcher> => {
    if (!regions.has(domain)) {
      const row = await db.sendingDomain.findUnique({ where: { name: domain }, select: { region: true } });
      regions.set(domain, row ? regionOf(row.region) : mg.region);
    }
    return { client: clientFor(mg, regions.get(domain)!), domain, signal: opts.signal };
  };

  for (const row of unknown) {
    if (opts.signal?.aborted) break;
    result.checked += 1;
    const claimedAt = row.claimedAt ?? row.createdAt;
    const age = now.getTime() - claimedAt.getTime();
    // The Mailgun domain the email went through (§2.3): the Reply-To's in shared-From mode, else the From's.
    const domain = mailgunDomainOf(row.fromAddress, row.replyTo);

    if (ctx.connected && domain) {
      const searcher = await searcherFor(ctx, domain);
      const start = new Date(claimedAt.getTime() - LOOKBACK_BEFORE_CLAIM_MS);
      // Past "now": Mailgun stamps the event with its own time, which may be ahead of this PC's clock.
      const end = new Date(now.getTime() + LOGS_END_MARGIN_MS);
      const a = await byMessageId(searcher, row.messageId, start, end, logsForm.messageIdForm);
      if (a.form && logsForm.messageIdForm !== a.form) {
        await saveLogsForm({ messageIdForm: a.form }, now);
        logsForm = { ...logsForm, messageIdForm: a.form };
      }
      const b = a.events.length ? null : await bySendId(searcher, row.sendId, start, end);
      const c = a.events.length || b?.events.length ? null : await byRecipient(searcher, row, start, end);
      const hits = [...a.events, ...(b?.events ?? []), ...(c?.events ?? [])];
      if (hits.length > 0) {
        const earliest = hits.reduce((x, y) => (y.occurredAt.getTime() < x.occurredAt.getTime() ? y : x));
        const providerId = earliest.messageId ?? row.messageId;
        try {
          await dbWrite((cl) => cl.outboundEmail.updateMany({ where: { id: row.id, providerId: null }, data: { providerId } }));
          await markSent(row.id, earliest.occurredAt, { providerId });
          result.sent += 1;
        } catch (err) {
          result.stillUnknown += 1;
          noteError(`Couldn't record email #${row.id} as sent: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      for (const r of [a, b, c]) if (r?.error) noteError(r.error);
      const allComplete = a.complete && (b?.complete ?? false) && (c?.complete ?? false);
      const oldEnough = age >= NOT_SENT_MIN_AGE_MS;
      const insideRetention = claimedAt.getTime() - LOOKBACK_BEFORE_CLAIM_MS >= now.getTime() - retentionMs;
      if (allComplete && oldEnough && insideRetention) {
        if (!controls.has(domain)) {
          const control = await positiveControl(searcher, claimedAt, now, logsForm);
          if (control.form && logsForm.messageIdForm !== control.form) logsForm = { ...logsForm, messageIdForm: control.form };
          controls.set(domain, control.ok);
        }
        if (controls.get(domain)) {
          const ended = endedCampaignMessage(row.campaign.status);
          const res = await dbWrite((cl) =>
            cl.outboundEmail.updateMany({
              where: { id: row.id, status: "UNKNOWN", providerId: null },
              data: ended
                ? { status: "CANCELLED", claimedAt: null, lastError: ended }
                : { status: "QUEUED", claimedAt: null, dueAt: now, lastError: NEVER_RECEIVED_MESSAGE },
            }),
          );
          if (res.count === 1) {
            if (ended) result.cancelled += 1;
            else result.requeued += 1;
          }
          continue;
        }
      }
    } else if (!ctx.connected) {
      noteError(ctx.text || "Mailgun isn't connected.");
    }

    // 6. Still undecided after 2 hours (or near the end of Mailgun's log retention): a person decides.
    if (age >= unconfirmAfter) {
      const res = await dbWrite((cl) =>
        cl.outboundEmail.updateMany({
          where: { id: row.id, status: "UNKNOWN", providerId: null },
          data: { status: "UNCONFIRMED", lastError: UNCONFIRMED_MESSAGE },
        }),
      );
      if (res.count === 1) {
        result.unconfirmed += 1;
        try {
          await notifyUnconfirmed(row);
        } catch (err) {
          console.error("[reconcile] couldn't send the Retry-or-Skip notification", err);
        }
      }
    } else {
      result.stillUnknown += 1;
    }
  }
  return result;
}
