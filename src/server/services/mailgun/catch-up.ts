import { normalizeLogItem, type NormalizedEvent } from "@/core/mailgun/events";
import { effectiveLogRetentionDays } from "@/core/mailgun/plan";
import { outageGapCovered } from "@/core/sequences/hold-reasons";
import { parseStoredLogOnly, parseStoredMessage, type ParsedInbound } from "@/core/mailgun/inbound";
import { safeZone } from "@/core/sending/capday";
import {
  OLD_DOMAIN_PROBLEMS_MAX,
  OLD_DOMAIN_TEXT_MAX,
  parseCatchUpState,
  parseMailgunSetupState,
  parseOutageState,
  parseUnsubscribeTest,
} from "@/core/system-state-parse";
import {
  STATE_KEYS,
  type CatchUpState,
  type CatchUpSummary,
  type MailgunSetupState,
  type OldDomainProblemState,
} from "@/core/system-state";
import { stepName } from "@/core/rules/wording";
import { formatShortDate, formatTime } from "@/core/time/format";
import { logActivity } from "@/server/activity";
import { db, dbTx, dbWrite } from "@/server/db";
import { describeJobError, PlainJobError } from "@/server/jobs";
import { clientFor, domainsToSync, getMailgunContext, mailgunSecrets, type MailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { isMailgunError, plainMailgunError, type MailgunError } from "@/server/mailgun/errors";
import type { MailgunClient } from "@/server/mailgun/client";
import type { MailgunRegion } from "@/server/mailgun/types";
import { activeOwnerId, createNotification, notifyOwner } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import { runHealthCheck } from "@/server/services/sending/health-check";
import { pauseSending } from "@/server/services/sending/pause";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import { applyMailEvent, ensureSentFromEvent, retryOnUnique, type ApplyResult } from "@/server/services/mail-events/apply";
import { storeInbound } from "@/server/services/mail-events/inbound-store";
import { loadPlanLimits } from "./plan";
import { pullSuppressions, pushLocalSuppressions } from "./suppressions";

/**
 * The catch-up with Mailgun (PLAN B6.11, SPEC "first catches up, then resumes sending", M3-DESIGN §4.4.5): at start-up,
 * every hour and on "Check with Mailgun now". For each domain whose events still matter (the active one, plus old ones
 * that sent live email in the last 60 days):
 *  1. the sending queue (active domain): Mailgun stopped accepting emails → pause;
 *  2. tracking (active domain): open/click tracking or unsubscribe handling drifted from what "Apply recommended
 *     settings" set → pause;
 *  3. pull Mailgun's three suppression lists; 4. push the local list (active domain);
 *  5. the Logs since the cursor (1 h overlap, never older than the plan keeps): every event through applyMailEvent,
 *     20 per transaction, then the proof of sending; a Message-ID accepted twice is reported; time the Logs no longer
 *     cover (the PC was off too long) is recorded as an outage gap for the outage hold (M4-DESIGN §2.8.3);
 *  6. stored replies whose notification never arrived: fetched and stored (or recorded from the log alone when the
 *     body has expired).
 * Cursors move only after a complete walk, never backwards, and stay 30 minutes behind (Mailgun's logs can be late).
 * "What the plan keeps" is `effectiveLogRetentionDays` (MAIN-DOMAIN-DESIGN O26): the saved number, never more than the
 * Mailgun plan keeps (1 day on Free; own-mailbox mode with no plan chosen assumes Free). In own-mailbox mode the pull
 * links new complaint and bounce entries to the email they concern (O34) and, after a pull that linked any, the health
 * check runs once.
 * SystemState "mailgun.catchUp" records the run; `lastSuccessAt` only when the ACTIVE domain completed (the catch-up
 * gate and the warm-up evaluation read only that: only the active domain sends). An older domain's problem never blocks
 * it: it is logged, named in the job summary and kept in `oldDomains` with since when (M6-DESIGN L10: Settings › Sending
 * & Mailgun and the dashboard show it, and the Owner hears once a day after 24 hours); a domain Mailgun no longer has is
 * forgotten (it can't send again).
 */

export type CatchUpReason = "startup" | "hourly" | "manual";

/** An older (inactive) domain the run couldn't check. It never blocks `lastSuccessAt`. */
export type OldDomainProblem = {
  domain: string;
  /** Mailgun no longer has the domain: the app stopped checking it. */
  gone: boolean;
  /** Plain sentence for the job summary. */
  text: string;
};

/** What a run returns: the stored summary, plus the older domains it couldn't check. */
export type CatchUpResult = CatchUpSummary & { oldDomainProblems: OldDomainProblem[] };

/** Events per transaction while applying the Logs (B5: ≲ 50 ms each). */
const LOGS_TX_BATCH = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Cursors stay this far behind the walk (Mailgun indexes events up to about 30 minutes late). */
export const CURSOR_LAG_MS = 30 * 60_000;
/** Overlap re-read before the logs cursor. */
export const LOGS_OVERLAP_MS = HOUR_MS;
/** Overlap re-read before the stored-replies cursor. */
export const STORED_OVERLAP_MS = 2 * HOUR_MS;
/** The monitor's "can't check with Mailgun" notice after this long without a successful catch-up. */
export const CATCH_UP_FAILING_AFTER_MS = 3 * HOUR_MS;

const LOG_EVENTS = ["accepted", "delivered", "failed", "complained", "unsubscribed"];

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const EMPTY_SUMMARY = (): CatchUpSummary => ({
  domains: [],
  eventsApplied: 0,
  suppressionsAdded: 0,
  suppressionsPushed: 0,
  inboundStored: 0,
  duplicatesFound: 0,
});

class Aborted extends Error {
  constructor() {
    super("The Mailgun check stopped because the background sender is stopping.");
    this.name = "Aborted";
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Aborted();
}

/** "auth", "network" (timeouts too), "server", else "other": what the catch-up gate may forgive (§4.3.2). */
export function catchUpErrorKind(err: unknown): NonNullable<CatchUpState["lastErrorKind"]> {
  if (!isMailgunError(err)) return "other";
  if (err.kind === "auth") return "auth";
  if (err.kind === "network" || err.kind === "timeout") return "network";
  if (err.kind === "server") return "server";
  return "other";
}

/** Logs dates are sent in whole seconds (RFC 2822): round the end up, so the last second's events are included. */
function queryEnd(now: Date): Date {
  return new Date(Math.ceil(now.getTime() / 1000) * 1000);
}

async function readCursor(key: string): Promise<Date | null> {
  const row = await db.syncCursor.findUnique({ where: { key } });
  const t = row ? Date.parse(row.value) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Moves a cursor forward (never backwards). */
async function advanceCursor(key: string, to: Date): Promise<void> {
  const current = await readCursor(key);
  if (current && current.getTime() >= to.getTime()) return;
  await dbWrite((c) =>
    c.syncCursor.upsert({ where: { key }, create: { key, value: to.toISOString() }, update: { value: to.toISOString() } }),
  );
}

type DomainRun = {
  ctx: MailgunContext;
  client: MailgunClient;
  domain: string;
  region: MailgunRegion;
  active: boolean;
  now: Date;
  practiceCopy: boolean;
  signal?: AbortSignal;
  summary: CatchUpSummary;
  setup: MailgunSetupState;
  unsubscribeSetup: string;
  logRetentionMs: number;
  messageRetentionMs: number;
  capZone: string;
  /** A normal API call made once when a storage GET answers 401/403 (see `confirmKey`). */
  keyCheck?: Promise<void>;
  /** MAIN-DOMAIN-DESIGN O34: own-mailbox mode (`ctx.replies`): the pull links new complaint and bounce entries. */
  ownMailbox: boolean;
  /** List entries the pulls of this run linked to an email (the health check runs once after the run when any). */
  linked: { count: number };
};

/** A setup step that "Apply recommended settings" completed: only a change after that counts as drift. */
function applied(setup: MailgunSetupState, key: "tracking-open" | "tracking-click" | "unsubscribe"): boolean {
  return setup.steps.some((s) => s.key === key && s.ok === true);
}

/** Steps 1–2: the sending queue and tracking drift (active domain only). */
async function checkAccount(r: DomainRun): Promise<void> {
  const queues = await r.client.getSendingQueues(r.domain);
  if (queues.regularDisabled) {
    const reason = queues.reason?.trim() || "no reason given";
    const until = queues.until
      ? ` Mailgun says until ${formatShortDate(queues.until, r.capZone, r.now)} ${formatTime(queues.until, r.capZone)}.`
      : "";
    await pauseSending({
      kind: "mailgun-queue",
      reason: "Mailgun stopped accepting emails",
      fixText: `Mailgun has stopped accepting emails from ${r.domain}: ${reason.replace(/\.+$/, "")}.${until} Check Mailgun's dashboard, then click Resume.`,
      detail: { mailgunMessage: queues.reason ?? undefined, ...(queues.until ? { until: queues.until.toISOString() } : {}) },
      now: r.now,
    });
  }

  const tracking = await r.client.getTracking(r.domain);
  const drift: Array<{ reason: string; fixText: string }> = [];
  if ((tracking.openActive && applied(r.setup, "tracking-open")) || (tracking.clickActive && applied(r.setup, "tracking-click"))) {
    drift.push({
      reason: "tracking is on in Mailgun",
      fixText: `Open or click tracking was switched on for ${r.domain} in Mailgun. Click Apply recommended settings in Settings › Domain checklist, then click Resume.`,
    });
  }
  if (r.unsubscribeSetup === "A" && !tracking.unsubscribeActive && applied(r.setup, "unsubscribe")) {
    drift.push({
      reason: "unsubscribe links are off",
      fixText: `Mailgun's unsubscribe handling is off for ${r.domain}, so unsubscribe links wouldn't work. Click Apply recommended settings in Settings › Domain checklist, then click Resume.`,
    });
  }
  for (const d of drift) {
    const res = await pauseSending({ kind: "mailgun-settings", reason: d.reason, fixText: d.fixText, now: r.now });
    // A new pause already told the Owner (sending.paused); otherwise the throttled notice does.
    if (!res.newlyPaused && (await shouldSendNotice("tracking-drift", r.now))) {
      await notifyOwner({ type: "system.mailgun", title: `Sending paused: ${d.reason}`, body: d.fixText, link: "/settings/domain" });
    }
  }
}

/** Mailgun's `flags.is-routed`: a message a route forwarded (a reply), never one of the app's own sends. */
function isRouted(raw: unknown): boolean {
  const flags = obj(obj(raw)?.flags);
  const v = flags?.["is-routed"];
  return v === true || v === "true" || v === "yes";
}

/**
 * The duplicate watch counts only the app's own sends on this domain: our Message-ID form ("pp.…@<domain>"), or our
 * `send_id` / `test_send_id` variable when Mailgun rewrote the Message-ID. A reply Mailgun forwarded through two of our
 * routes (To and Cc, or a sender address and the catch-all) has two `accepted` events with the prospect's own
 * Message-ID: that is not a duplicate.
 */
export function isOwnSend(ev: Pick<NormalizedEvent, "messageId" | "userVariables" | "raw">, domain: string): boolean {
  if (isRouted(ev.raw)) return false;
  const id = ev.messageId ?? "";
  if (id.startsWith("pp.") && id.endsWith(`@${domain.toLowerCase()}`)) return true;
  return Boolean(ev.userVariables.send_id || ev.userVariables.test_send_id);
}

/**
 * Reports a campaign email Mailgun accepted twice (activity once per email, notice at most once a day). Only campaign
 * emails count: a Message-ID that isn't one of them says nothing about the app sending twice (test emails only ever go
 * to your own mailboxes).
 */
async function reportDuplicate(messageId: string, r: DomainRun): Promise<void> {
  const email = await db.outboundEmail.findFirst({
    where: { OR: [{ messageId }, { providerId: messageId }] },
    select: { id: true, campaignId: true, companyId: true, personId: true, toEmail: true, step: true, mode: true },
  });
  if (!email) return;
  const earlier = await db.activityLog.findMany({
    where: { type: "email.duplicate", campaignId: email.campaignId, personId: email.personId },
    select: { data: true },
  });
  const logged = earlier.some((a) => (a.data as { emailId?: unknown } | null)?.emailId === email.id);
  if (logged) return;
  await logActivity({
    actorId: null,
    type: "email.duplicate",
    summary: "Mailgun accepted this email twice",
    campaignId: email.campaignId,
    companyId: email.companyId,
    personId: email.personId,
    mode: email.mode,
    data: { emailId: email.id, messageId, step: email.step, what: stepName(email.step) },
  });
  r.summary.duplicatesFound += 1;
  if (await shouldSendNotice("email-duplicate", r.now)) {
    await notifyOwner({
      type: "system.mailgun",
      title: "An email may have gone out twice",
      body: `Mailgun accepted the email to ${email.toEmail} twice. Please tell us: this shouldn't happen.`,
      link: `/campaigns/${email.campaignId}`,
    });
  }
}

/**
 * The Logs window (§2.4): from `max(cursor − 1 h, floor)`, where floor = now − log retention + 1 h (the first run starts
 * at the floor). Only a cursor BEFORE the floor means some time can't be checked any more: then the gap
 * {from: cursor, to: floor} is recorded for the outage hold (`recordOutageGap`, M4-DESIGN §2.8.3). A cursor inside the
 * window missed nothing, even when the extra hour of overlap is trimmed.
 */
export function logsWindow(cursor: Date | null, now: Date, logRetentionMs: number): { start: Date; gap: { from: Date; to: Date } | null } {
  const floor = new Date(now.getTime() - logRetentionMs + HOUR_MS);
  if (!cursor) return { start: floor, gap: null };
  const back = cursor.getTime() - LOGS_OVERLAP_MS;
  return {
    start: new Date(Math.max(back, floor.getTime())),
    gap: cursor.getTime() < floor.getTime() ? { from: cursor, to: floor } : null,
  };
}

/**
 * Records a gap the Logs can't cover any more in SystemState "catchup.outage" (M4-DESIGN §2.8.3), for the outage hold
 * (`applyOutageHold`, run by the catch-up job's onSuccess). One record is shared by every domain, so a gap never
 * overwrites another one that still has to be held:
 *  - a gap found and not yet held (`from` set, `handledAt` null): merged, `from = min`, `to = max`, `detectedAt = now`;
 *  - a gap starting inside the window whose hold was already applied (`outageGapCovered`): nothing (the same gap
 *    recorded again by an incomplete walk, or another domain's part of the same outage);
 *  - otherwise (no record, or the last hold is done and this gap starts before its window or at/after its end): a new
 *    record, `detectedAt = now`, `handledAt = null`, keeping `heldFor`/`heldTo`/`heldCount` of the last hold.
 * Returns whether the record changed.
 */
export async function recordOutageGap(gap: { from: Date; to: Date }, now: Date): Promise<boolean> {
  const from = gap.from.toISOString();
  const to = gap.to.toISOString();
  const res = await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) => {
    if (cur.from !== null && cur.handledAt === null) {
      const curTo = cur.to ?? to;
      return {
        ...cur,
        detectedAt: now.toISOString(),
        from: Date.parse(from) < Date.parse(cur.from) ? from : cur.from,
        to: Date.parse(to) > Date.parse(curTo) ? to : curTo,
        beyondLogRetention: true,
      };
    }
    if (cur.handledAt !== null && outageGapCovered(cur, { from })) return null;
    return { ...cur, detectedAt: now.toISOString(), from, to, beyondLogRetention: true, handledAt: null };
  });
  return res.written;
}

/** Step 5: every Logs event since the cursor, applied in transactions of 20, then the proof of sending. */
async function walkEventLogs(r: DomainRun): Promise<boolean> {
  const key = `${r.domain}:logs`;
  const cursor = await readCursor(key);
  const { start, gap } = logsWindow(cursor, r.now, r.logRetentionMs);
  // The PC was off longer than Mailgun keeps its logs: part of the time can't be checked (the outage hold).
  if (gap) await recordOutageGap(gap, r.now);
  const walkStartedAt = r.now;
  const accepted = new Map<string, Set<string>>();

  const walk = await r.client.walkLogs(
    {
      start,
      end: queryEnd(r.now),
      events: LOG_EVENTS,
      filters: [{ attribute: "domain", comparator: "=", value: r.domain }],
      sort: "asc",
    },
    async (items) => {
      checkAbort(r.signal);
      const events = items.map(normalizeLogItem).filter((e): e is NormalizedEvent => e !== null);
      for (const ev of events) {
        if (ev.type !== "accepted" || !ev.messageId || !isOwnSend(ev, r.domain)) continue;
        const ids = accepted.get(ev.messageId) ?? new Set<string>();
        ids.add(ev.providerEventId);
        accepted.set(ev.messageId, ids);
      }
      for (let i = 0; i < events.length; i += LOGS_TX_BATCH) {
        const batch = events.slice(i, i + LOGS_TX_BATCH);
        const results: ApplyResult[] = await retryOnUnique(() =>
          dbTx(async (tx) => {
            const out: ApplyResult[] = [];
            for (const ev of batch) out.push(await applyMailEvent(tx, ev, "LOGS", { now: r.now, practiceCopy: r.practiceCopy, activeDomain: r.ctx.domain }));
            return out;
          }),
        );
        for (let j = 0; j < results.length; j++) {
          const res = results[j]!;
          if (res.status === "created") r.summary.eventsApplied += 1;
          if (res.outboundEmailId !== null || res.testSendId !== null) {
            try {
              await ensureSentFromEvent(res, batch[j]!);
            } catch (err) {
              console.error("[catch-up] the proof-of-sending step failed; the event lane repeats it", err);
            }
          }
        }
        await yieldToEventLoop();
      }
    },
    { signal: r.signal },
  );
  checkAbort(r.signal);
  for (const [messageId, ids] of accepted) {
    if (ids.size >= 2) await reportDuplicate(messageId, r);
  }
  if (!walk.complete) return false;
  const endAt = Math.min(r.now.getTime(), walkStartedAt.getTime());
  await advanceCursor(key, new Date(endAt - CURSOR_LAG_MS));
  return true;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A 4xx answer (except 429) from a storage URL: that URL won't give this email (expired, on another storage host,
 * refused), so the next form is tried and, in the end, the reply is recorded from the log alone. Also a URL the app
 * refused to fetch (nothing was sent). 401/403 are handled by the caller (the key is checked first).
 */
function isStorageRefusal(err: MailgunError): boolean {
  if (!err.requestStarted) return true;
  if (err.status === null || err.status < 400 || err.status >= 500) return false;
  return err.kind !== "rate-limited";
}

/**
 * A storage GET answered 401/403. The API-host calls of this run already used the same key, but the key may have been
 * revoked since: one normal API call per domain run decides. Throws that call's error when the key really is bad (the
 * catch-up then pauses sending for the key, as for any other call); returns when the key is fine, so the storage answer
 * is only this email's problem and never pauses anything.
 */
async function confirmKey(r: DomainRun): Promise<void> {
  r.keyCheck ??= r.client.getSendingQueues(r.domain).then(() => undefined);
  await r.keyCheck;
}

type StoredFetch = { parsed: ParsedInbound | null } | { retryLater: unknown };

/**
 * A stored reply: the storage URLs Mailgun gave, then the API-host form; the log alone when the body expired or every
 * URL refused it (a 4xx), so one stored email can never stop the catch-up. A passing problem (timeout, network, 5xx,
 * 429) returns `retryLater` instead: the reply is fetched on the next run, unless it is already older than Mailgun keeps
 * message bodies (then the log alone, as for a 404).
 */
async function fetchStoredReply(r: DomainRun, item: Record<string, unknown>, ev: NormalizedEvent, key: string): Promise<StoredFetch> {
  const storage = obj(item.storage);
  const given = Array.isArray(storage?.url)
    ? storage.url.filter((u): u is string => typeof u === "string" && u.length > 0)
    : typeof storage?.url === "string"
      ? [storage.url]
      : [];
  const candidates = [...new Set([...given, `${r.client.baseUrl}/v3/domains/${r.domain}/messages/${encodeURIComponent(key)}`])];
  const expired = ev.occurredAt.getTime() < r.now.getTime() - r.messageRetentionMs;
  for (const url of candidates) {
    try {
      const json = await r.client.getStoredMessage(url);
      const parsed = parseStoredMessage(json, { recipient: ev.recipient, storageKey: key, at: ev.occurredAt });
      if (parsed) return { parsed };
    } catch (err) {
      if (!isMailgunError(err)) throw err;
      if (err.kind === "auth" && err.requestStarted) {
        await confirmKey(r);
        continue;
      }
      if (isStorageRefusal(err)) continue;
      if (expired) break;
      return { retryLater: err };
    }
  }
  const fromLog = parseStoredLogOnly(item);
  if (fromLog && expired) {
    // Only noted (Settings › Sending says some replies came back without their text): `from`, `to` and `handledAt`
    // stay as they are, because these log-only replies become possible replies that hold their own company (M4-DESIGN
    // §2.8.3, §3.4 rule 4); a record with nothing else is marked handled by applyOutageHold without holding anyone.
    await updateTyped(STATE_KEYS.outage, parseOutageState, (cur) =>
      cur.beyondMessageRetention ? null : { ...cur, detectedAt: cur.detectedAt ?? r.now.toISOString(), beyondMessageRetention: true },
    );
  }
  return { parsed: fromLog ? { ...fromLog, storageKey: fromLog.storageKey ?? key } : null };
}

/**
 * Step 6: replies Mailgun stored whose notification never reached the app. A reply that can't be fetched right now
 * doesn't stop the others: the cursor stays at it (so the next run reads it again), and after the walk its error is
 * thrown, so this run counts as failed for a passing reason (network/server) and is tried again.
 */
async function walkStoredReplies(r: DomainRun): Promise<boolean> {
  const key = `${r.domain}:stored`;
  const cursor = await readCursor(key);
  const floor = new Date(r.now.getTime() - r.logRetentionMs + HOUR_MS);
  const start = cursor && cursor.getTime() - STORED_OVERLAP_MS > floor.getTime() ? new Date(cursor.getTime() - STORED_OVERLAP_MS) : floor;
  let later: { err: unknown; at: number } | null = null;
  const walk = await r.client.walkLogs(
    {
      start,
      end: queryEnd(r.now),
      events: ["stored"],
      filters: [{ attribute: "domain", comparator: "=", value: r.domain }],
      sort: "asc",
    },
    async (items) => {
      for (const raw of items) {
        checkAbort(r.signal);
        const item = obj(raw);
        const ev = normalizeLogItem(raw);
        if (!item || !ev) continue;
        const storageKey = typeof obj(item.storage)?.key === "string" ? String(obj(item.storage)!.key) : null;
        if (storageKey && (await db.inboundMessage.findUnique({ where: { storageKey }, select: { id: true } }))) continue;
        let parsed: ParsedInbound | null;
        if (storageKey) {
          const got = await fetchStoredReply(r, item, ev, storageKey);
          if ("retryLater" in got) {
            console.error(`[catch-up] a stored reply on ${r.domain} couldn't be fetched now; the next check tries again`, got.retryLater);
            later = { err: later?.err ?? got.retryLater, at: Math.min(later?.at ?? Infinity, ev.occurredAt.getTime()) };
            continue;
          }
          parsed = got.parsed;
        } else {
          parsed = parseStoredLogOnly(item);
        }
        if (!parsed) continue;
        const stored = parsed;
        const res = await retryOnUnique(() => dbTx((tx) => storeInbound(tx, stored, "CATCHUP")));
        if (res.status === "created") r.summary.inboundStored += 1;
        await yieldToEventLoop();
      }
    },
    { signal: r.signal },
  );
  checkAbort(r.signal);
  if (!walk.complete) return false;
  const pending = later as { err: unknown; at: number } | null;
  const upTo = Math.min(r.now.getTime() - CURSOR_LAG_MS, pending?.at ?? Infinity);
  await advanceCursor(key, new Date(upTo));
  if (pending) throw pending.err;
  return true;
}

/** Every step for one domain. Returns true when every walk completed. */
async function catchUpDomain(r: DomainRun, progress?: () => Promise<void>): Promise<boolean> {
  let complete = true;
  if (r.active) await checkAccount(r);
  checkAbort(r.signal);
  const pulled = await pullSuppressions({
    client: r.client,
    domain: r.domain,
    activeDomain: r.ctx.domain,
    now: r.now,
    practiceCopy: r.practiceCopy,
    signal: r.signal,
    ...(r.ownMailbox ? { ownMailbox: true } : {}),
  });
  r.summary.suppressionsAdded += pulled.added;
  r.linked.count += pulled.linked;
  if (!pulled.complete) complete = false;
  checkAbort(r.signal);
  if (r.active) {
    const pushed = await pushLocalSuppressions({ now: r.now, mailgun: async () => r.ctx });
    r.summary.suppressionsPushed += pushed.pushed;
  }
  await progress?.();
  if (!(await walkEventLogs(r))) complete = false;
  await progress?.();
  if (!(await walkStoredReplies(r))) complete = false;
  return complete;
}

/** "3 updates, 1 new address on the do-not-email list, 1 reply recovered" (or "nothing new"), for job summaries. */
export function describeCatchUp(s: CatchUpSummary): string {
  const parts: string[] = [];
  if (s.eventsApplied) parts.push(`${s.eventsApplied} ${s.eventsApplied === 1 ? "update" : "updates"}`);
  if (s.suppressionsAdded) {
    parts.push(`${s.suppressionsAdded} new ${s.suppressionsAdded === 1 ? "address" : "addresses"} on the do-not-email list`);
  }
  if (s.suppressionsPushed) parts.push(`${s.suppressionsPushed} sent to Mailgun's list`);
  if (s.inboundStored) parts.push(`${s.inboundStored} ${s.inboundStored === 1 ? "reply" : "replies"} recovered`);
  if (s.duplicatesFound) parts.push(`${s.duplicatesFound} possible ${s.duplicatesFound === 1 ? "duplicate" : "duplicates"}`);
  return parts.length ? parts.join(", ") : "nothing new";
}

/** The older domains a run couldn't check, as sentences for the job summary ("" when none). */
export function describeOldDomainProblems(problems: readonly OldDomainProblem[]): string {
  return problems.map((p) => p.text).join(" ");
}

function clampDays(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * After a pull that linked list entries to their emails (MAIN-DOMAIN-DESIGN O34), the health check runs once so the
 * automatic pause sees them now; a failure is logged and never fails the run (the worker runs it after the run too).
 */
async function healthCheckAfterLinking(linked: number, now: Date): Promise<void> {
  if (linked <= 0) return;
  try {
    await runHealthCheck({ now });
  } catch (err) {
    console.error("[catch-up] the health check after the suppression pull failed; the next check runs it again", err);
  }
}

/** Mailgun answered "Domain not found" (after the client's one retry): the domain was deleted in Mailgun. */
function domainGone(err: unknown): boolean {
  return isMailgunError(err) && err.kind === "not-found" && err.requestStarted && /\bdomain\b.*\bnot found\b/i.test(err.mailgunMessage);
}

/**
 * An older domain's failure: logged and named in the job summary, never a failure of the run (only the active domain
 * sends, so only it holds sending and the warm-up). A domain Mailgun no longer has can't send or receive again: the
 * app forgets it (clears `lastLiveSendAt`, so `domainsToSync` leaves it out from now on). Never pauses sending: the
 * active domain, checked first with the same key, already proved the key.
 */
async function oldDomainProblem(d: { id: number; name: string }, err: unknown): Promise<OldDomainProblem> {
  if (domainGone(err)) {
    try {
      await dbWrite((c) => c.sendingDomain.updateMany({ where: { id: d.id, active: false }, data: { lastLiveSendAt: null } }));
    } catch (inner) {
      console.error(`[catch-up] couldn't stop checking ${d.name}`, inner);
    }
    console.warn(`[catch-up] Mailgun no longer has the old sending domain ${d.name}; the app stopped checking it.`);
    return { domain: d.name, gone: true, text: `The old domain ${d.name} is no longer in your Mailgun account, so the app stopped checking it.` };
  }
  console.error(`[catch-up] the old sending domain ${d.name} couldn't be checked; the next check tries again`, err);
  return { domain: d.name, gone: false, text: `Couldn't check the old domain ${d.name} this time: ${oldDomainReason(err)}. The next check tries again.` };
}

/** A short reason for an older domain's failure (the job summary names the domain; no fix steps: nothing to do). */
function oldDomainReason(err: unknown): string {
  if (!isMailgunError(err)) return "something unexpected went wrong";
  switch (err.kind) {
    case "auth":
      return "Mailgun didn't let the saved API key read it";
    case "network":
    case "timeout":
      return "Mailgun couldn't be reached";
    case "server":
      return "Mailgun had a problem on its side";
    case "rate-limited":
      return "Mailgun asked the app to slow down";
    default:
      return "Mailgun refused it";
  }
}

// ───────────────────────── old domains in the state (M6-DESIGN L10, §7.2, §7.3) ─────────────────────────

/** The Owner's notice about an old domain comes after this long without a check, at most once a day. */
export const OLD_DOMAIN_NOTICE_AFTER_MS = 24 * HOUR_MS;
/** The throttled notice's key (`shouldSendNotice`), type "system.mailgun". */
export const OLD_DOMAIN_NOTICE_KEY = "catchup-old-domain";

/**
 * `CatchUpState.oldDomains` after a run that went through the domains: one entry per older domain this run couldn't
 * check (not a gone one: the app stopped checking it), keeping the `since` of that domain's earlier entry (else now)
 * and `lastAt = now`. Every other earlier entry is dropped: that domain was checked fine this run, is gone, or isn't
 * synced any more (no live email for 60 days, or it is the active domain again). The text is cut to 300 characters;
 * at most 10 entries, the last ones kept (as the parser does). Pure.
 */
export function nextOldDomainProblems(
  previous: readonly OldDomainProblemState[] | undefined,
  problems: readonly OldDomainProblem[],
  now: Date,
): OldDomainProblemState[] {
  const since = new Map((previous ?? []).map((p) => [p.domain, p.since]));
  const at = now.toISOString();
  const out: OldDomainProblemState[] = [];
  for (const p of problems) {
    if (p.gone || out.some((o) => o.domain === p.domain)) continue;
    out.push({ domain: p.domain, since: since.get(p.domain) ?? at, lastAt: at, text: p.text.slice(0, OLD_DOMAIN_TEXT_MAX) });
  }
  return out.length > OLD_DOMAIN_PROBLEMS_MAX ? out.slice(out.length - OLD_DOMAIN_PROBLEMS_MAX) : out;
}

/**
 * The state after a run that went through the domains: `oldDomains` from `nextOldDomainProblems` (the field left out
 * when there are none, as the parser leaves it out, so states without problems look exactly as before M6).
 */
function withOldDomains(state: CatchUpState, problems: readonly OldDomainProblem[], now: Date): CatchUpState {
  const { oldDomains: previous, ...rest } = state;
  const list = nextOldDomainProblems(previous, problems, now);
  return list.length > 0 ? { ...rest, oldDomains: list } : rest;
}

/** The problem the Owner's notice is about: the one unchecked longest, once that is 24 hours or more; else null. */
export function oldDomainNoticeDue(list: readonly OldDomainProblemState[] | undefined, now: Date): OldDomainProblemState | null {
  let due: OldDomainProblemState | null = null;
  for (const p of list ?? []) {
    const since = Date.parse(p.since);
    if (!Number.isFinite(since) || now.getTime() - since < OLD_DOMAIN_NOTICE_AFTER_MS) continue;
    if (!due || since < Date.parse(due.since)) due = p;
  }
  return due;
}

/** The notice's words (§7.3); `sinceDay` is written in the Owner's zone, e.g. "25 Sep". */
export function oldDomainNoticeCopy(domain: string, sinceDay: string): { title: string; body: string; link: string } {
  return {
    title: "Couldn't check an old sending domain",
    body: `The app hasn't been able to check Mailgun's logs for the old domain ${domain} since ${sinceDay}. Replies and bounces to its last emails may be missed. Check that the domain still exists in Mailgun and that the key works.`,
    link: "/settings/sending",
  };
}

/**
 * Tells the Owner about an old domain that couldn't be checked for 24 hours (`oldDomainNoticeDue`), at most once per
 * 24 hours for all old domains together (`shouldSendNotice("catchup-old-domain")`). The date is written in the Owner's
 * time zone. Returns whether a notification was created.
 */
async function noticeOldDomains(list: readonly OldDomainProblemState[] | undefined, now: Date): Promise<boolean> {
  const due = oldDomainNoticeDue(list, now);
  if (!due) return false;
  const ownerId = await activeOwnerId();
  if (ownerId === null) return false;
  if (!(await shouldSendNotice(OLD_DOMAIN_NOTICE_KEY, now))) return false;
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { timeZone: true } });
  const copy = oldDomainNoticeCopy(due.domain, formatShortDate(due.since, safeZone(owner?.timeZone), now));
  await createNotification({ userId: ownerId, type: "system.mailgun", ...copy });
  return true;
}

/** `noticeOldDomains` after a run; a problem with the notice is logged and never fails the run. */
async function noticeOldDomainsSafely(list: readonly OldDomainProblemState[] | undefined, now: Date): Promise<void> {
  try {
    await noticeOldDomains(list, now);
  } catch (err) {
    console.error("[catch-up] couldn't tell the Owner about an old sending domain; the next check tries again", err);
  }
}

/**
 * One catch-up run. Returns the summary when the active domain completed (then `lastSuccessAt` is set; older domains
 * that couldn't be checked are listed in `oldDomainProblems`); throws a plain PlainJobError after recording the failure
 * otherwise (the job runner retries; the catch-up gate reads the error kind). A Mailgun "auth" answer for the active
 * domain pauses sending (`mailgun-auth`). Mailgun not connected (or the practice copy): nothing to check, an empty
 * summary. Either way, once the run went through the domains, the state's `oldDomains` is brought up to date in the
 * same write as the run's result (`nextOldDomainProblems`) and the Owner hears about an old domain unchecked for 24
 * hours (at most once a day).
 */
export async function runCatchUp(opts: {
  reason: CatchUpReason;
  now?: Date;
  signal?: AbortSignal;
  progress?: (done: number, total: number) => Promise<void>;
  mailgun?: () => Promise<MailgunContextResult>;
}): Promise<CatchUpResult> {
  const now = opts.now ?? new Date();
  await updateTyped(STATE_KEYS.catchUp, parseCatchUpState, (cur) => ({ ...cur, lastStartedAt: now.toISOString(), lastReason: opts.reason }));
  const summary = EMPTY_SUMMARY();
  const oldDomainProblems: OldDomainProblem[] = [];
  let failure: unknown = null;
  let failedDomain: { name: string; region: MailgunRegion } | null = null;
  let incomplete = false;
  // Set once the run goes through the domains: only then does it know which older domains it couldn't check (L10).
  // Before that (Mailgun not connected, the settings couldn't be read) `oldDomains` stays as it was.
  let wentThroughDomains = false;
  const oldDomainsAfter = (state: CatchUpState): CatchUpState =>
    wentThroughDomains ? withOldDomains(state, oldDomainProblems, now) : state;

  try {
    const ctx = await (opts.mailgun ?? getMailgunContext)();
    if (!ctx.connected) {
      await updateTyped(STATE_KEYS.catchUp, parseCatchUpState, (cur) => ({ ...cur, lastFinishedAt: now.toISOString() }));
      return { ...summary, oldDomainProblems };
    }
    const s = await getSettings([
      "practice.copy",
      "mailgun.logRetentionDays",
      "mailgun.messageRetentionDays",
      "mailgun.unsubscribeTest",
      "sending.capDayTimeZone",
    ] as const);
    // O26: never more days than the Mailgun plan keeps (today's clamp first, so app mode without a plan is unchanged).
    const logRetentionDays = effectiveLogRetentionDays(clampDays(s["mailgun.logRetentionDays"], 1, 30, 5), await loadPlanLimits());
    const ownMailbox = ctx.replies === "own-mailbox";
    const linked = { count: 0 };
    const setup = (await readTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState)).value;
    const domains = await domainsToSync(now);
    if (!domains.some((d) => d.name === ctx.domain)) domains.unshift({ id: ctx.domainId, name: ctx.domain, region: ctx.region });
    // Every domain below ends in `summary.domains` or `oldDomainProblems` (or the active domain's failure); an abort
    // throws before any of it is recorded.
    wentThroughDomains = true;

    const steps = domains.length * 3;
    let done = 0;
    const progress = async () => {
      done += 1;
      await opts.progress?.(Math.min(done, steps), steps);
    };

    for (const d of domains) {
      const active = d.name === ctx.domain;
      try {
        checkAbort(opts.signal);
        const r: DomainRun = {
          ctx,
          client: clientFor(ctx, d.region),
          domain: d.name,
          region: d.region,
          active,
          now,
          practiceCopy: s["practice.copy"] === true,
          signal: opts.signal,
          summary,
          setup,
          unsubscribeSetup: parseUnsubscribeTest(s["mailgun.unsubscribeTest"]).setup,
          logRetentionMs: logRetentionDays * DAY_MS,
          messageRetentionMs: clampDays(s["mailgun.messageRetentionDays"], 1, 7, 1) * DAY_MS,
          capZone: safeZone(typeof s["sending.capDayTimeZone"] === "string" ? s["sending.capDayTimeZone"] : null),
          ownMailbox,
          linked,
        };
        if (await catchUpDomain(r, progress)) summary.domains.push(d.name);
        else if (active) incomplete = true;
        else {
          console.error(`[catch-up] Mailgun's logs for the old sending domain ${d.name} couldn't be read to the end`);
          oldDomainProblems.push({
            domain: d.name,
            gone: false,
            text: `Couldn't read Mailgun's logs for the old domain ${d.name} to the end. The next check tries again.`,
          });
        }
        await progress();
      } catch (err) {
        if (err instanceof Aborted || opts.signal?.aborted) throw err;
        if (!active) {
          oldDomainProblems.push(await oldDomainProblem(d, err));
          continue;
        }
        failure ??= err;
        failedDomain ??= d;
        if (isMailgunError(err) && err.kind === "auth") await pauseForAuth(err, now);
      }
    }
    // O34: complaints and bounces the lists brought for emails the Logs no longer have count toward the pause now.
    await healthCheckAfterLinking(linked.count, now);
  } catch (err) {
    if (err instanceof Aborted || opts.signal?.aborted) throw err instanceof Aborted ? err : new Aborted();
    // Loading the context or the settings failed (e.g. a test run without the fake server): a failed run too.
    failure ??= err;
  }

  // The run's own clock: an injected `now` (tests) stays the time of the whole run.
  const doneAt = (opts.now ?? new Date()).toISOString();
  if (!failure && !incomplete) {
    const done = await updateTyped(STATE_KEYS.catchUp, parseCatchUpState, (cur) =>
      oldDomainsAfter({
        ...cur,
        lastFinishedAt: doneAt,
        lastSuccessAt: doneAt,
        lastError: null,
        lastErrorKind: null,
        lastSummary: summary,
        // Working again (review DASHBOARD-1): the failure streak is over.
        failingSince: null,
      }),
    );
    if (wentThroughDomains) await noticeOldDomainsSafely(done.value.oldDomains, now);
    return { ...summary, oldDomainProblems };
  }

  const secrets = await mailgunSecrets().catch(() => []);
  const plain = failure
    ? isMailgunError(failure)
      ? plainMailgunError(failure, { domain: failedDomain?.name, region: failedDomain?.region, now })
      : "Something unexpected went wrong."
    : "Mailgun's logs couldn't be read to the end. The app tries again soon.";
  const detail = failure ? (describeJobError(failure, secrets).detail ?? (failure instanceof Error ? failure.message : null)) : null;
  const lastError = `${plain}${detail && detail !== plain ? ` (${detail})` : ""}`.slice(0, 1000);
  const failed = await updateTyped(STATE_KEYS.catchUp, parseCatchUpState, (cur) =>
    oldDomainsAfter({
      ...cur,
      lastFinishedAt: doneAt,
      lastError,
      lastErrorKind: failure ? catchUpErrorKind(failure) : "other",
      lastSummary: summary,
      // Review DASHBOARD-1: the start of the first failed run stays put while every retry moves `lastStartedAt`.
      failingSince: cur.failingSince ?? now.toISOString(),
    }),
  );
  // The older domains were still checked (the active domain's failure never stops them), so their state and notice
  // are kept up to date on a failed run too.
  if (wentThroughDomains) await noticeOldDomainsSafely(failed.value.oldDomains, now);
  throw new PlainJobError(plain, detail);
}

async function pauseForAuth(err: MailgunError, now: Date): Promise<void> {
  try {
    await pauseSending({
      kind: "mailgun-auth",
      reason: "Mailgun didn't accept the API key",
      fixText:
        "Mailgun didn't accept the saved API key. In Mailgun, open API Security, create a key with the Developer role, paste it in Settings › Sending & Mailgun, then click Resume.",
      detail: { mailgunMessage: err.mailgunMessage || undefined },
      now,
    });
  } catch (inner) {
    console.error("[catch-up] couldn't pause sending after an auth error", inner);
  }
}

/**
 * The monitor's check (§4.4.5): Mailgun is connected but no catch-up has succeeded for 3 hours (or none ever did and
 * the check has been failing for 3 hours, `failingSince`; or, before any run failed, the last one started more than 3
 * hours ago and never finished) → notice "catchup-failing" (at most once a day). Returns whether it sent. The last
 * start alone can't tell it: every retry moves it (review DASHBOARD-1).
 */
export async function checkCatchUpAge(opts: { now?: Date; mailgun?: () => Promise<MailgunContextResult> } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  let connected = false;
  try {
    connected = (await (opts.mailgun ?? getMailgunContext)()).connected;
  } catch {
    connected = false;
  }
  if (!connected) return false;
  const state = (await readTyped(STATE_KEYS.catchUp, parseCatchUpState)).value;
  const since = Date.parse(state.lastSuccessAt ?? state.failingSince ?? state.lastStartedAt ?? "");
  if (!Number.isFinite(since) || now.getTime() - since < CATCH_UP_FAILING_AFTER_MS) return false;
  if (!(await shouldSendNotice("catchup-failing", now))) return false;
  const zone = safeZone(((await getSettings(["sending.capDayTimeZone"] as const))["sending.capDayTimeZone"] as string | null) ?? null);
  const at = new Date(since);
  const when = now.getTime() - since < DAY_MS ? formatTime(at, zone) : `${formatShortDate(at, zone, now)} ${formatTime(at, zone)}`;
  await notifyOwner({
    type: "system.mailgun",
    title: "The app can't check with Mailgun",
    body: `The app hasn't been able to check Mailgun since ${when}. Bounces and unsubscribes may be late. Open Settings › Sending & Mailgun and click Check with Mailgun now.`,
    link: "/settings/sending",
  });
  return true;
}
