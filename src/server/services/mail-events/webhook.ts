import { normalizeWebhookEventData } from "@/core/mailgun/events";
import { lowerKeys, parseInboundForm } from "@/core/mailgun/inbound";
import { checkTimestamp, EVENT_MAX_AGE_MS, INBOUND_MAX_AGE_MS, verifyMailgunSignature } from "@/core/mailgun/signature";
import { parseTunnelState, parseWebhookStats, WEBHOOK_REJECTS_MAX } from "@/core/system-state-parse";
import { STATE_KEYS, type WebhookStats } from "@/core/system-state";
import { db, dbTx, isRetryableDbError } from "@/server/db";
import { readBodyCapped } from "@/server/http/read-body";
import { notifyOwner } from "@/server/notifications";
import { getSecret } from "@/server/secrets";
import { getSetting } from "@/server/settings";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import { applyMailEvent, ensureSentFromEvent, retryOnUnique } from "./apply";
import { storeInbound } from "./inbound-store";

/**
 * The two public webhook endpoints (PLAN B6.11, B10, M3-DESIGN §4.4.1): Mailgun's event reports
 * (POST /api/webhooks/mailgun/events) and its reply notifications (POST /api/webhooks/mailgun/inbound). No session:
 * the HMAC signature is the credential, and the one-time token stored in the same transaction as the event protects
 * the unsigned body against replays. Never isSameOrigin.
 *
 * Answers (Mailgun retries everything except 200 and 406 for about 8 hours):
 *  - 406: wrong content type, a body over the cap (it will never shrink), unreadable JSON/form, missing signature
 *    fields, a timestamp too old or too far in the future, an event we can't read;
 *  - 401: no signing key saved, or a wrong signature (retried, which gives time to fetch the right key);
 *  - 500: a database problem (retried);
 *  - 200: stored, or already stored (a replayed token or a duplicate event is a no-op).
 * Bodies are tiny JSON, never details. SystemState "webhooks.stats" records the last valid and rejected POSTs (at most
 * once a minute, except counted rejections); the monitor's own self-check is never recorded.
 */

export const EVENT_BODY_MAX = 256 * 1024;
/** The notify POST carries attachment metadata only (research §13.2), so 10 MB is plenty. */
export const INBOUND_BODY_MAX = 10 * 1024 * 1024;
/** Header the monitor loop sends with its own test POST (value: tunnel.status.selfCheckNonce). */
export const SELF_CHECK_HEADER = "x-outreach-self-check";

const STATS_EVERY_MS = 60_000;
const REJECT_NOTICE_WINDOW_MS = 3_600_000;
const REJECT_NOTICE_COUNT = 3;

type Kind = "event" | "inbound";
type RejectReason = NonNullable<WebhookStats["lastRejectReason"]>;

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

let lastRejectLogAt = 0;
/** A wrong signature is logged at most once a minute (internet scanners must not flood the log). */
function logRejected(kind: Kind, reason: RejectReason): void {
  const now = Date.now();
  if (now - lastRejectLogAt < STATS_EVERY_MS) return;
  lastRejectLogAt = now;
  console.warn(`[webhooks] refused a Mailgun ${kind} POST (${reason})`);
}

function ms(iso: string | null): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

/** When the last valid (signed, fresh) webhook of either kind arrived. */
function lastValidMs(s: WebhookStats): number {
  return Math.max(ms(s.lastEventAt), ms(s.lastInboundAt));
}

/** Records one answer in "webhooks.stats"; a failure here never changes the answer. */
class StatsRecorder {
  constructor(
    private readonly kind: Kind,
    private readonly now: Date,
    private readonly selfCheck: boolean,
  ) {}

  /** A valid webhook: at most once a minute, but always while counted rejections are waiting for one. */
  async valid(): Promise<void> {
    if (this.selfCheck) return;
    const at = this.now.toISOString();
    try {
      await updateTyped(STATE_KEYS.webhooks, parseWebhookStats, (cur) => {
        const last = ms(this.kind === "event" ? cur.lastEventAt : cur.lastInboundAt);
        const pending = cur.rejects.some((r) => ms(r) > lastValidMs(cur));
        if (!pending && this.now.getTime() - last < STATS_EVERY_MS) return null;
        return this.kind === "event" ? { ...cur, lastEventAt: at } : { ...cur, lastInboundAt: at };
      });
    } catch (err) {
      console.error("[webhooks] couldn't record the webhook stats", err);
    }
  }

  /**
   * A refused POST. `counted` (the body parsed, its domain is ours and the timestamp is fresh, but the signature is
   * wrong) goes into `rejects` and may send the Owner notice; everything else only updates lastRejected* once a minute.
   */
  async reject(reason: RejectReason, status: number, counted = false): Promise<Response> {
    if (!this.selfCheck) {
      if (reason === "signature" || reason === "no-key") logRejected(this.kind, reason);
      try {
        await this.#record(reason, counted);
      } catch (err) {
        console.error("[webhooks] couldn't record the webhook stats", err);
      }
    }
    return answer(status, { error: reason });
  }

  async #record(reason: RejectReason, counted: boolean): Promise<void> {
    const at = this.now.toISOString();
    const res = await updateTyped(STATE_KEYS.webhooks, parseWebhookStats, (cur) => {
      if (counted) {
        return {
          ...cur,
          lastRejectedAt: at,
          lastRejectReason: reason,
          rejects: [...cur.rejects, at].slice(-WEBHOOK_REJECTS_MAX),
        };
      }
      if (cur.lastRejectReason === reason && this.now.getTime() - ms(cur.lastRejectedAt) < STATS_EVERY_MS) return null;
      return { ...cur, lastRejectedAt: at, lastRejectReason: reason };
    });
    if (!counted) return;
    // Notice when 3 counted rejections fell within an hour and no valid webhook arrived since the first of them.
    const since = lastValidMs(res.value);
    const recent = res.value.rejects.filter((r) => ms(r) > since && this.now.getTime() - ms(r) <= REJECT_NOTICE_WINDOW_MS);
    if (recent.length >= REJECT_NOTICE_COUNT && (await shouldSendNotice("webhook-rejected", this.now))) {
      await notifyOwner({
        type: "system.mailgun",
        title: "Mailgun's messages to the app are being rejected",
        body: "The webhook signing key saved in the app doesn't match Mailgun's. Click Apply recommended settings in Settings › Domain checklist to fetch it again.",
        link: "/settings/domain",
      });
    }
  }
}

/** True when the request carries the monitor's current self-check nonce. */
async function isSelfCheck(request: Request): Promise<boolean> {
  const header = (request.headers.get(SELF_CHECK_HEADER) ?? "").trim();
  if (!header) return false;
  try {
    const tunnel = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
    return Boolean(tunnel.selfCheckNonce) && tunnel.selfCheckNonce === header;
  } catch {
    return false;
  }
}

async function signingKey(): Promise<string | null> {
  try {
    const key = await getSecret("mailgun.webhookSigningKey");
    return key && key.trim() ? key.trim() : null;
  } catch {
    // Saved with another encryption key: treat as not saved (Apply fetches it again).
    return null;
  }
}

/** True when `name` is one of our sending domains (a counted rejection must be about our own domain). */
async function isOurDomain(name: unknown): Promise<boolean> {
  if (typeof name !== "string" || !name.trim()) return false;
  const row = await db.sendingDomain.findUnique({ where: { name: name.trim().toLowerCase() }, select: { id: true } });
  return row !== null;
}

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

async function drop(request: Request): Promise<void> {
  await request.body?.cancel().catch(() => undefined);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A signature field: strings as they are, numbers (a numeric timestamp) through String(). */
function field(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function serverError(err: unknown): Response {
  if (isRetryableDbError(err)) return answer(500, { error: "busy" });
  console.error("[webhooks] storing a Mailgun POST failed", err);
  return answer(500, { error: "server" });
}

/** POST /api/webhooks/mailgun/events: one delivery/bounce/complaint/unsubscribe report. */
export async function handleEventWebhook(request: Request, deps: { now?: Date } = {}): Promise<Response> {
  const now = deps.now ?? new Date();
  try {
    const stats = new StatsRecorder("event", now, await isSelfCheck(request));
    if (mediaType(request) !== "application/json") {
      await drop(request);
      return stats.reject("unreadable", 406);
    }
    const bytes = await readBodyCapped(request, EVENT_BODY_MAX);
    if (!bytes) return stats.reject("too-large", 406);
    let body: Record<string, unknown> | null;
    try {
      body = obj(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      body = null;
    }
    if (!body) return stats.reject("unreadable", 406);

    const sig = obj(body.signature);
    const timestamp = field(sig?.timestamp);
    const token = field(sig?.token);
    const signature = field(sig?.signature);
    if (!timestamp || !token || !signature) return stats.reject("unreadable", 406);

    const key = await signingKey();
    if (!key) return stats.reject("no-key", 401);
    const freshness = checkTimestamp(timestamp, now, EVENT_MAX_AGE_MS);
    if (!verifyMailgunSignature(key, timestamp, token, signature)) {
      const eventData = obj(body["event-data"]);
      const counted = freshness === "fresh" && (await isOurDomain(obj(eventData?.domain)?.name));
      return stats.reject("signature", 401, counted);
    }
    if (freshness !== "fresh") return stats.reject(freshness === "invalid" ? "unreadable" : "stale", 406);

    const ev = normalizeWebhookEventData(body["event-data"]);
    if (!ev) return stats.reject("unreadable", 406);

    const practiceCopy = (await getSetting("practice.copy")) === true;
    const result = await retryOnUnique(() =>
      dbTx(async (tx) => {
        if (await tx.webhookToken.findUnique({ where: { token }, select: { token: true } })) return null;
        await tx.webhookToken.create({ data: { token, receivedAt: now } });
        return applyMailEvent(tx, ev, "WEBHOOK", { now, practiceCopy });
      }),
    );
    if (result) {
      try {
        await ensureSentFromEvent(result, ev);
      } catch (err) {
        console.error("[webhooks] the proof-of-sending step failed; the event lane repeats it", err);
      }
    }
    await stats.valid();
    return answer(200, { ok: true });
  } catch (err) {
    return serverError(err);
  }
}

/** POST /api/webhooks/mailgun/inbound: a reply stored by Mailgun (from the routes' store(notify=…)). */
export async function handleInboundWebhook(request: Request, deps: { now?: Date } = {}): Promise<Response> {
  const now = deps.now ?? new Date();
  try {
    const stats = new StatsRecorder("inbound", now, await isSelfCheck(request));
    const type = mediaType(request);
    if (type !== "application/x-www-form-urlencoded" && type !== "multipart/form-data") {
      await drop(request);
      return stats.reject("unreadable", 406);
    }
    const bytes = await readBodyCapped(request, INBOUND_BODY_MAX);
    if (!bytes) return stats.reject("too-large", 406);
    const fields: Record<string, string> = {};
    try {
      const form = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
      for (const [k, v] of form) if (typeof v === "string" && !(k in fields)) fields[k] = v;
    } catch {
      return stats.reject("unreadable", 406);
    }

    const f = lowerKeys(fields);
    const timestamp = field(f.timestamp);
    const token = field(f.token);
    const signature = field(f.signature);
    if (!timestamp || !token || !signature) return stats.reject("unreadable", 406);

    const key = await signingKey();
    if (!key) return stats.reject("no-key", 401);
    const freshness = checkTimestamp(timestamp, now, INBOUND_MAX_AGE_MS);
    if (!verifyMailgunSignature(key, timestamp, token, signature)) {
      const counted = freshness === "fresh" && (await isOurDomain(f.domain));
      return stats.reject("signature", 401, counted);
    }
    if (freshness !== "fresh") return stats.reject(freshness === "invalid" ? "unreadable" : "stale", 406);

    const parsed = parseInboundForm(fields, now);
    if (!parsed) return stats.reject("unreadable", 406);

    // dbTx takes the write lock before the token check reads anything, so a worker writing at this moment (an import, a
    // backlog of replies) only makes this wait its turn; it never turns a reply into a 500 that Mailgun retries 10
    // minutes later, while a follow-up may already be due.
    await retryOnUnique(() =>
      dbTx(async (tx) => {
        if (await tx.webhookToken.findUnique({ where: { token }, select: { token: true } })) return null;
        await tx.webhookToken.create({ data: { token, receivedAt: now } });
        return storeInbound(tx, parsed, "NOTIFY");
      }),
    );
    await stats.valid();
    return answer(200, { ok: true });
  } catch (err) {
    return serverError(err);
  }
}
