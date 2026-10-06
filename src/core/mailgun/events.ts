/**
 * Mailgun delivery events (research mailgun-api-reference §2.2 and §13.1, mailgun-events.md, M3-DESIGN §4.1.7).
 * Webhook `event-data` and Logs API items describe the same events in slightly different shapes; both are turned
 * into one `NormalizedEvent`, and `eventEffect` says what an event does to the app's rows. Pure; parsed leniently
 * (Mailgun adds fields over time and several fields have more than one shape).
 */

/** The event types the app acts on; everything else (opened, clicked, rejected, stored, …) is "other". */
export type MailEventType = "accepted" | "delivered" | "failed" | "complained" | "unsubscribed" | "other";

/** One Mailgun event in the app's own shape, whether it came from a webhook, the Logs API or a simulation. */
export type NormalizedEvent = {
  /** `${providerEventId}:${YYYY-MM-DD UTC of occurredAt}` (Mailgun's id is only unique within a day); simulated: `sim:${emailId}:${type}`. */
  dedupeKey: string;
  providerEventId: string;
  type: MailEventType;
  severity: "permanent" | "temporary" | null;
  /** Lowercase: "bounce", "suppress-bounce", "old", "generic", … */
  reason: string | null;
  occurredAt: Date;
  /** Lowercase, no angle brackets. */
  messageId: string | null;
  /** Lowercase. May read "[redacted]" when the domain redacts personal data. */
  recipient: string | null;
  userVariables: Record<string, string>;
  tags: string[];
  isTestMode: boolean;
  /** The sending domain, lowercase. */
  domain: string | null;
  deliveryStatus: { code: number | null; message: string | null; description: string | null; bounceType: string | null } | null;
  raw: unknown;
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A trimmed, non-empty string (numbers become strings), else null. */
function text(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function lower(v: unknown): string | null {
  return text(v)?.toLowerCase() ?? null;
}

/** Our Message-ID form: trimmed, without the angle brackets, lowercase; empty → null. */
export function normalizeMessageId(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().replace(/^<\s*/, "").replace(/\s*>$/, "").trim().toLowerCase();
  return id ? id : null;
}

/**
 * Mailgun's `user-variables`: an object in webhooks, `[]` when empty, a JSON-encoded string in Logs items. Values
 * become strings; nested values become JSON. Anything unreadable gives `{}`.
 */
export function parseUserVariables(v: unknown): Record<string, string> {
  let value = v;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!isObj(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    out[k] = typeof raw === "string" ? raw : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
  return out;
}

function eventType(v: unknown): MailEventType {
  const e = lower(v);
  return e === "accepted" || e === "delivered" || e === "failed" || e === "complained" || e === "unsubscribed" ? e : "other";
}

function severityOf(v: unknown): "permanent" | "temporary" | null {
  const s = lower(v);
  return s === "permanent" || s === "temporary" ? s : null;
}

function deliveryStatusOf(v: unknown): NormalizedEvent["deliveryStatus"] {
  if (!isObj(v)) return null;
  const rawCode = v.code;
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? Math.trunc(rawCode)
      : typeof rawCode === "string" && /^\d+$/.test(rawCode.trim())
        ? Number(rawCode.trim())
        : null;
  return {
    code,
    message: text(v.message),
    description: text(v.description),
    bounceType: lower(v["bounce-type"]),
  };
}

function domainOf(v: unknown): string | null {
  if (isObj(v)) return lower(v.name);
  return lower(v);
}

function messageIdOf(raw: Obj): string | null {
  const message = raw.message;
  if (isObj(message) && isObj(message.headers)) {
    const id = message.headers["message-id"];
    if (typeof id === "string") return normalizeMessageId(id);
  }
  return typeof raw["message-id"] === "string" ? normalizeMessageId(raw["message-id"]) : null;
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The fields both shapes share, once the id, type and time are known. */
function build(raw: Obj, providerEventId: string, occurredAt: Date): NormalizedEvent {
  const flags = isObj(raw.flags) ? raw.flags : {};
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    dedupeKey: `${providerEventId}:${utcDay(occurredAt)}`,
    providerEventId,
    type: eventType(raw.event),
    severity: severityOf(raw.severity),
    reason: lower(raw.reason),
    occurredAt,
    messageId: messageIdOf(raw),
    recipient: lower(raw.recipient),
    userVariables: parseUserVariables(raw["user-variables"]),
    tags,
    isTestMode: isTrue(flags["is-test-mode"]),
    domain: domainOf(raw.domain),
    deliveryStatus: deliveryStatusOf(raw["delivery-status"]),
    raw,
  };
}

/** Epoch seconds (a float, or a numeric string) → Date; null when unreadable. */
function fromEpochSeconds(v: unknown): Date | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(Math.round(n * 1000));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An ISO (or other `Date.parse`-able) string → Date; null when unreadable. */
function fromDateString(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * A webhook's `event-data` object → NormalizedEvent. Null when it is unreadable: not an object, or no `id`, `event`
 * or `timestamp` (float epoch seconds). Handles the documented quirks: `storage: []`, `user-variables: []`,
 * `delivery-status.description: null`, `tags: ["*"]`.
 */
export function normalizeWebhookEventData(eventData: unknown): NormalizedEvent | null {
  if (!isObj(eventData)) return null;
  const id = text(eventData.id);
  const event = text(eventData.event);
  const at = fromEpochSeconds(eventData.timestamp);
  if (!id || !event || !at) return null;
  return build(eventData, id, at);
}

/**
 * A Logs API item → NormalizedEvent. Same rules as the webhook shape, but the time is `@timestamp` (ISO) and
 * `user-variables` is a JSON string. Null when `id`, `event` or the time is missing.
 */
export function normalizeLogItem(item: unknown): NormalizedEvent | null {
  if (!isObj(item)) return null;
  const id = text(item.id);
  const event = text(item.event);
  const at = fromDateString(item["@timestamp"]) ?? fromEpochSeconds(item.timestamp);
  if (!id || !event || !at) return null;
  return build(item, id, at);
}

/**
 * The event the dry-run outbox's "Simulate" buttons apply (§4.4.8): delivered, a hard bounce, a complaint or an
 * unsubscribe for one dry-run email. Its dedupe key `sim:<emailId>:<type>` makes a repeat a no-op.
 */
export function makeSimulatedEvent(input: {
  kind: "delivered" | "bounce" | "complaint" | "unsubscribe";
  emailId: number;
  messageId: string;
  recipient: string;
  now: Date;
}): NormalizedEvent {
  const messageId = normalizeMessageId(input.messageId);
  const recipient = input.recipient.trim().toLowerCase() || null;
  const domain = messageId && messageId.includes("@") ? messageId.slice(messageId.lastIndexOf("@") + 1) : null;
  const byKind = {
    delivered: { type: "delivered" as const, severity: null, reason: null, deliveryStatus: { code: 250, message: "Simulated delivery", description: null, bounceType: null }, tags: [] as string[] },
    bounce: { type: "failed" as const, severity: "permanent" as const, reason: "bounce", deliveryStatus: { code: 550, message: "Simulated bounce: mailbox unavailable", description: null, bounceType: "hard" }, tags: [] as string[] },
    complaint: { type: "complained" as const, severity: null, reason: null, deliveryStatus: null, tags: [] as string[] },
    unsubscribe: { type: "unsubscribed" as const, severity: null, reason: null, deliveryStatus: null, tags: ["*"] },
  }[input.kind];
  const providerEventId = `sim-${input.emailId}-${input.kind}`;
  return {
    dedupeKey: `sim:${input.emailId}:${byKind.type}`,
    providerEventId,
    type: byKind.type,
    severity: byKind.severity,
    reason: byKind.reason,
    occurredAt: new Date(input.now.getTime()),
    messageId,
    recipient,
    userVariables: {},
    tags: byKind.tags,
    isTestMode: false,
    domain,
    deliveryStatus: byKind.deliveryStatus,
    raw: { simulated: true, kind: input.kind, emailId: input.emailId },
  };
}

/** What applying an event changes (see `eventEffect`); the scope rules of §4.4.2 decide how far it reaches. */
export type EventEffect = {
  /** The OutboundEmail date this event sets (earliest wins). */
  dateField: "deliveredAt" | "tempFailedAt" | "bouncedAt" | "complainedAt" | "unsubscribedAt" | null;
  /** The recipient stop code. */
  stop: "bounced" | "complained" | "unsubscribed" | null;
  /** true: every open recipient with that address, in every campaign (real scope only); false: only the matched row's recipient. */
  stopEveryCampaign: boolean;
  suppression: "BOUNCED" | "COMPLAINED" | "UNSUBSCRIBED" | null;
  personField: "bouncedAt" | "complainedAt" | "unsubscribedAt" | null;
  /** Mailgun already lists the address (hard bounce, complaint, unsubscribe, suppress-*), so nothing needs pushing. */
  inMailgunList: boolean;
  /** Permanent non-suppress-* failures count toward the bounce health rule; never test mode (complaints: §4.2.5). */
  health: "bounce" | null;
  /** Mailgun accepted our email (every type except "other"): see "proof of sending", §4.4.2. */
  provesAccepted: boolean;
};

const NO_EFFECT: EventEffect = {
  dateField: null,
  stop: null,
  stopEveryCampaign: false,
  suppression: null,
  personField: null,
  inMailgunList: false,
  health: null,
  provesAccepted: false,
};

const HARD_REASONS: ReadonlySet<string> = new Set(["bounce", "hardfail", "suppress-bounce"]);

/** A `failed` event Mailgun won't retry: severity permanent, a `suppress-*` drop, or (severity missing) a hard bounce. */
function isPermanentFailure(ev: NormalizedEvent): boolean {
  if (ev.type !== "failed") return false;
  if (ev.severity === "permanent") return true;
  if (ev.severity === "temporary") return false;
  const reason = ev.reason ?? "";
  return reason.startsWith("suppress-") || HARD_REASONS.has(reason) || ev.deliveryStatus?.bounceType === "hard";
}

/**
 * A hard bounce: a permanent failure whose reason is `bounce`, `hardfail` or `suppress-bounce`, or whose
 * delivery-status bounce type is "hard". Only hard bounces put the address on the do-not-email list (§9.2 item 7).
 */
export function isHardBounce(ev: NormalizedEvent): boolean {
  if (!isPermanentFailure(ev)) return false;
  return HARD_REASONS.has(ev.reason ?? "") || ev.deliveryStatus?.bounceType === "hard";
}

function effectFor(ev: NormalizedEvent): EventEffect {
  switch (ev.type) {
    case "accepted":
      return { ...NO_EFFECT, provesAccepted: true };
    case "delivered":
      return { ...NO_EFFECT, dateField: "deliveredAt", provesAccepted: true };
    case "complained":
      return {
        dateField: "complainedAt",
        stop: "complained",
        stopEveryCampaign: true,
        suppression: "COMPLAINED",
        personField: "complainedAt",
        inMailgunList: true,
        health: null,
        provesAccepted: true,
      };
    case "unsubscribed":
      return {
        dateField: "unsubscribedAt",
        stop: "unsubscribed",
        stopEveryCampaign: true,
        suppression: "UNSUBSCRIBED",
        personField: "unsubscribedAt",
        inMailgunList: true,
        health: null,
        provesAccepted: true,
      };
    case "failed": {
      const reason = ev.reason ?? "";
      const dropped = { dateField: "bouncedAt" as const, stopEveryCampaign: true, inMailgunList: true, health: null, provesAccepted: true };
      if (reason === "suppress-bounce") {
        return { ...dropped, stop: "bounced", suppression: "BOUNCED", personField: "bouncedAt" };
      }
      if (reason === "suppress-unsubscribe") {
        return { ...dropped, stop: "unsubscribed", suppression: "UNSUBSCRIBED", personField: "unsubscribedAt" };
      }
      if (reason === "suppress-complaint") {
        return { ...dropped, stop: "complained", suppression: "COMPLAINED", personField: "complainedAt" };
      }
      if (reason.startsWith("suppress-")) {
        // Another list Mailgun keeps: it refused to deliver, so this email bounced, but we don't know which list.
        return { ...NO_EFFECT, dateField: "bouncedAt", stop: "bounced", inMailgunList: true, provesAccepted: true };
      }
      if (!isPermanentFailure(ev)) return { ...NO_EFFECT, dateField: "tempFailedAt", provesAccepted: true };
      if (isHardBounce(ev)) {
        return {
          dateField: "bouncedAt",
          stop: "bounced",
          stopEveryCampaign: true,
          suppression: "BOUNCED",
          personField: "bouncedAt",
          inMailgunList: true,
          health: "bounce",
          provesAccepted: true,
        };
      }
      // espblock, generic, old, blacklisted, unknown, …: stop this recipient and count it, but no lifetime block.
      return { ...NO_EFFECT, dateField: "bouncedAt", stop: "bounced", health: "bounce", provesAccepted: true };
    }
    default:
      return { ...NO_EFFECT };
  }
}

/**
 * What an event does (M3-DESIGN §4.1.7 table): the OutboundEmail date it sets, the stop, the suppression and person
 * flag (real scope only, decided by the caller), whether Mailgun already lists the address, whether it counts for
 * the bounce health rule, and whether it proves Mailgun accepted the email. A `suppress-*` drop reads "Bounced" on
 * the campaign and never counts for health; test-mode events never count for health.
 */
export function eventEffect(ev: NormalizedEvent): EventEffect {
  const effect = effectFor(ev);
  return ev.isTestMode ? { ...effect, health: null } : effect;
}

/** Stop codes from weakest to strongest: a later code replaces an earlier one on an already-stopped recipient. */
export const STOP_PRECEDENCE: readonly string[] = ["bounced", "unsubscribed", "complained"];

/** Suppression reasons from weakest to strongest: a later reason replaces an earlier one (§4.4.2 step 7). */
export const SUPPRESSION_PRECEDENCE: readonly string[] = ["MANUAL", "INVALID", "BOUNCED", "UNSUBSCRIBED", "COMPLAINED"];

/**
 * The single result an email shows (campaign page, recipient panel): complained, then unsubscribed, then bounced,
 * then delivered, then sent; null when it hasn't gone out.
 */
export function displayResult(d: {
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  bouncedAt?: Date | null;
  unsubscribedAt?: Date | null;
  complainedAt?: Date | null;
}): "complained" | "unsubscribed" | "bounced" | "delivered" | "sent" | null {
  if (d.complainedAt) return "complained";
  if (d.unsubscribedAt) return "unsubscribed";
  if (d.bouncedAt) return "bounced";
  if (d.deliveredAt) return "delivered";
  if (d.sentAt) return "sent";
  return null;
}
