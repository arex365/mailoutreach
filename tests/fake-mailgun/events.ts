import crypto from "node:crypto";

/**
 * Event builders for the fake Mailgun server (M3-DESIGN §6.1, research §2.2, §13.1, §15).
 *
 * Every event lives once in the fake as a FakeEvent and is rendered on demand in the two shapes Mailgun uses:
 *  - webhook `event-data` (toEventData): `timestamp` float seconds, `user-variables` an object (or [] when empty),
 *    `storage.url` a string, and the documented quirks (`storage: []` and `tags: ["*"]` on unsubscribes);
 *  - Logs items (toLogItem): `@timestamp` ISO, `user-variables` a JSON string, `storage.url` an array.
 * `message.headers["message-id"]` never has angle brackets, as in Mailgun's own payloads.
 */

export type FakeEventType = "accepted" | "delivered" | "failed" | "complained" | "unsubscribed" | "stored";

export type FakeDeliveryStatus = {
  code: number | null;
  message: string;
  description: string | null;
  bounceType?: "hard" | "soft" | null;
  enhancedCode?: string | null;
};

export type FakeEvent = {
  id: string;
  event: FakeEventType;
  at: Date;
  domain: string;
  recipient: string;
  /** Without angle brackets. */
  messageId: string;
  from: string;
  to: string;
  subject: string;
  tags: string[];
  userVariables: Record<string, string>;
  testMode: boolean;
  severity?: "permanent" | "temporary";
  reason?: string;
  logLevel: "info" | "warn" | "error";
  deliveryStatus?: FakeDeliveryStatus;
  storage?: { key: string; url: string };
  routed?: boolean;
  /** SMTP MAIL FROM ("" = the null sender). Default: the app's bounce address on the sending domain (own sends). */
  envelopeSender?: string;
};

/** `envelope` of an event: an inbound message's own MAIL FROM, else the app's bounce address (its own sends). */
function envelope(ev: FakeEvent): Record<string, string> {
  const sender = ev.envelopeSender ?? `bounce@${ev.domain}`;
  return { sender, targets: ev.recipient, transport: "smtp", "sending-ip": "127.0.0.1" };
}

/** A 22-character event id like Mailgun's ("unique within a day"). */
export function eventId(): string {
  return crypto.randomBytes(16).toString("base64url").slice(0, 22);
}

function recipientDomain(address: string): string {
  return address.split("@")[1] ?? "";
}

function flags(ev: FakeEvent): Record<string, boolean> {
  return {
    "is-authenticated": ev.event !== "stored",
    "is-routed": ev.routed === true,
    "is-big": false,
    "is-system-test": false,
    "is-test-mode": ev.testMode,
  };
}

function deliveryStatus(ev: FakeEvent): Record<string, unknown> | undefined {
  const d = ev.deliveryStatus;
  if (!d) return undefined;
  return {
    "attempt-no": 1,
    code: d.code,
    message: d.message,
    description: d.description,
    "enhanced-code": d.enhancedCode ?? null,
    "mx-host": `mx.${recipientDomain(ev.recipient) || "example.com"}`,
    ...(d.bounceType !== undefined ? { "bounce-type": d.bounceType } : {}),
    "session-seconds": 0.2,
    "certificate-verified": true,
    tls: true,
    utf8: true,
  };
}

function headers(ev: FakeEvent): Record<string, string> {
  return { "message-id": ev.messageId, from: ev.from, to: ev.to, subject: ev.subject };
}

/** The webhook `event-data` object (research §13.1). */
export function toEventData(ev: FakeEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event: ev.event,
    id: ev.id,
    timestamp: ev.at.getTime() / 1000,
    "log-level": ev.logLevel,
    recipient: ev.recipient,
    "recipient-domain": recipientDomain(ev.recipient),
    domain: { name: ev.domain },
    account: { id: "fake0000000000000000account" },
    message: { headers: headers(ev), attachments: [], size: 1024 },
    flags: flags(ev),
    envelope: envelope(ev),
    tags: ev.event === "unsubscribed" ? ["*"] : ev.tags,
    campaigns: [],
    "recipient-provider": "Other",
    "user-variables": Object.keys(ev.userVariables).length ? { ...ev.userVariables } : [],
  };
  if (ev.severity) out.severity = ev.severity;
  if (ev.reason) out.reason = ev.reason;
  const ds = deliveryStatus(ev);
  if (ds) out["delivery-status"] = ds;
  if (ev.event === "unsubscribed") {
    out.storage = [];
    out["client-info"] = { "client-type": "browser", "client-name": "Chrome" };
    out.geolocation = { country: "DE", region: "BE", city: "Berlin" };
  } else if (ev.storage) {
    out.storage = { key: ev.storage.key, url: ev.storage.url };
  }
  return out;
}

/** The Logs item (research §2.2): `@timestamp`, `user-variables` as a JSON string, `storage.url` as an array. */
export function toLogItem(ev: FakeEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ev.id,
    event: ev.event,
    "@timestamp": ev.at.toISOString(),
    account: { id: "fake0000000000000000account" },
    domain: { name: ev.domain },
    recipient: ev.recipient,
    "recipient-domain": recipientDomain(ev.recipient),
    "recipient-provider": "Other",
    message: { headers: headers(ev), size: 1024 },
    "user-variables": JSON.stringify(ev.userVariables),
    tags: ev.event === "unsubscribed" ? ["*"] : ev.tags,
    flags: flags(ev),
    "log-level": ev.logLevel,
    envelope: envelope(ev),
  };
  if (ev.severity) out.severity = ev.severity;
  if (ev.reason) out.reason = ev.reason;
  const ds = deliveryStatus(ev);
  if (ds) out["delivery-status"] = ds;
  if (ev.storage) out.storage = { region: "europe-west1", env: "production", key: ev.storage.key, url: [ev.storage.url] };
  if (ev.event === "stored") {
    out.routes = [{ id: "fake-route", priority: 0, expression: "catch_all()", description: "", actions: "store()", match: { recipient: ev.recipient } }];
  }
  return out;
}

/** What a sent message contributes to its events. */
export type MessageFacts = {
  messageId: string;
  domain: string;
  recipient: string;
  from: string;
  to: string;
  subject: string;
  tags: string[];
  userVariables: Record<string, string>;
  testMode: boolean;
};

function base(m: MessageFacts, at: Date, event: FakeEventType, logLevel: FakeEvent["logLevel"]): FakeEvent {
  return {
    id: eventId(),
    event,
    at,
    domain: m.domain,
    recipient: m.recipient,
    messageId: m.messageId,
    from: m.from,
    to: m.to,
    subject: m.subject,
    tags: [...m.tags],
    userVariables: { ...m.userVariables },
    testMode: m.testMode,
    logLevel,
  };
}

export function acceptedEvent(m: MessageFacts, at: Date): FakeEvent {
  return base(m, at, "accepted", "info");
}

/** Delivered; in Mailgun's test mode the code is 650 and `is-test-mode` is true. */
export function deliveredEvent(m: MessageFacts, at: Date): FakeEvent {
  return {
    ...base(m, at, "delivered", "info"),
    deliveryStatus: m.testMode
      ? { code: 650, message: "Test mode", description: "Message was not delivered (test mode)." }
      : { code: 250, message: "OK", description: null, enhancedCode: "2.0.0" },
  };
}

export function tempFailEvent(m: MessageFacts, at: Date): FakeEvent {
  return {
    ...base(m, at, "failed", "warn"),
    severity: "temporary",
    reason: "generic",
    deliveryStatus: { code: 421, message: "4.4.0 Try again later", description: null, bounceType: "soft", enhancedCode: "4.4.0" },
  };
}

/** A permanent failure. `reason` "bounce"/"hardfail" is a hard bounce; `suppress-*` is Mailgun dropping a send. */
export function permanentFailEvent(m: MessageFacts, at: Date, opts: { reason?: string; code?: number } = {}): FakeEvent {
  const reason = opts.reason ?? "bounce";
  const suppressed = reason.startsWith("suppress-");
  const hard = reason === "bounce" || reason === "hardfail";
  return {
    ...base(m, at, "failed", "error"),
    severity: "permanent",
    reason,
    deliveryStatus: suppressed
      ? { code: 605, message: "Not delivering to previously bounced address", description: null, bounceType: null }
      : {
          code: opts.code ?? 550,
          message: "5.5.0 Requested action not taken: mailbox unavailable",
          description: null,
          bounceType: hard ? "hard" : "soft",
          enhancedCode: "5.5.0",
        },
  };
}

export function complainedEvent(m: MessageFacts, at: Date): FakeEvent {
  return base(m, at, "complained", "warn");
}

export function unsubscribedEvent(m: MessageFacts, at: Date): FakeEvent {
  return base(m, at, "unsubscribed", "info");
}

/**
 * The Logs `stored` event of an inbound email (catch-up finds replies whose notify POST was lost through it). Its
 * `envelope.sender` is the message's own MAIL FROM ("" = the null sender), which a log-only recovery reads.
 */
export function storedEvent(input: {
  domain: string;
  recipient: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  storage: { key: string; url: string };
  at: Date;
  envelopeSender: string;
}): FakeEvent {
  return {
    id: eventId(),
    event: "stored",
    at: input.at,
    domain: input.domain,
    recipient: input.recipient,
    messageId: input.messageId,
    from: input.from,
    to: input.to,
    subject: input.subject,
    tags: [],
    userVariables: {},
    testMode: false,
    logLevel: "info",
    storage: input.storage,
    routed: true,
    envelopeSender: input.envelopeSender,
  };
}
