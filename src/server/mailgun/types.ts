/**
 * Shapes used by the Mailgun client (M3-DESIGN §4.2.2). The wire formats behind them are in
 * docs/dev/research/mailgun-api-reference.md; the client turns Mailgun's lenient JSON into these types.
 */

export type MailgunRegion = "EU" | "US";

/** Why an email goes to Mailgun: a campaign email, "Send me a test", or the reply test. */
export type SendPurpose = "campaign" | "self-test" | "reply-test";

/** The test-list guard, re-checked inside sendMessage before any request (§4.2.3, B6.5). */
export type SendGuard = {
  goLive: boolean;
  /** Normalised test-list addresses (Setting "sending.testList"). */
  testList: ReadonlySet<string>;
  /** "self-test" only: the acting user's own reply inbox, normalised. */
  ownInbox?: string | null;
};

export type SendMessageInput = {
  /**
   * The full From line, e.g. `Ali Khan <ali@send.example.com>`; in shared-From mode the shared address with the
   * sender's display name, `Ali Khan <contact@example.com>` (SHARED-FROM-DESIGN §2.3).
   */
  from: string;
  /** Exactly one bare address, already normalised; never a list (no , ; < > " or spaces). */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stored form (lowercase, no angle brackets); the client sends `<id>`. */
  messageId: string;
  /** Stored forms: one id / space-separated ids, no angle brackets. */
  inReplyTo?: string | null;
  references?: string | null;
  /**
   * Sent as `h:Reply-To`. Shared-From mode: the sender's own address on the sending domain (SHARED-FROM-DESIGN §2.3),
   * where replies land and the route catches them; the Mailgun domain is then this address's domain
   * (`mailgunDomainOf`). Null or absent in per-person mode (replies go to the From address).
   */
  replyTo?: string | null;
  /** At most 3. */
  tags: string[];
  /** Opaque ids only (sent as `v:<name>`). */
  variables: Record<string, string>;
  /** Mailgun test mode (`o:testmode=yes`): accepted, never delivered. */
  testMode?: boolean;
  /**
   * M6-DESIGN §2.3: the campaign's testListOnly(mode, launchedGoLive); after go-live a campaign email reaches a
   * non-test-list address only when this is false.
   */
  testListOnly?: boolean;
  purpose: SendPurpose;
  guard: SendGuard;
};

/** Mailgun's answer to a send: `id` lowercase without angle brackets. */
export type SendMessageResult = { id: string; message: string };

export type LogsFilter = { attribute: string; comparator: "=" | "!=" | "contains" | "not contains"; value: string };
export type LogsQuery = {
  start: Date;
  end: Date;
  events: string[];
  filters: LogsFilter[];
  sort?: "asc" | "desc";
  /** Page size, at most 100 (Mailgun's maximum). */
  limit?: number;
};
export type LogsWalk = {
  /** True when the walk reached the end: only then may a sync cursor move (B6.11). */
  complete: boolean;
  pages: number;
  items: number;
  stoppedBecause: "empty" | "no-next" | "same-token" | "page-guard" | "aborted";
};

export type SuppressionList = "bounces" | "complaints" | "unsubscribes";
export type SuppressionItem = { address: string; createdAt: Date | null; code: string | null; error: string | null; tags: string[] };

export type DnsRecordInfo = {
  recordType: string;
  name: string | null;
  value: string;
  priority: string | null;
  valid: "valid" | "invalid" | "unknown";
  isActive: boolean;
  cached: string[];
};
export type DomainInfo = {
  name: string;
  state: string | null;
  isDisabled: boolean;
  disabled: { code: string | null; note: string | null; permanently: boolean; reason: string | null; until: string | null } | null;
  spamAction: string | null;
  webPrefix: string;
  webScheme: "http" | "https" | null;
  /** Message retention in seconds. */
  messageTtl: number | null;
  webhooksRedactPii: boolean | null;
  useAutomaticSenderSecurity: boolean | null;
  sending: DnsRecordInfo[];
  receiving: DnsRecordInfo[];
};
export type TrackingSettings = {
  openActive: boolean;
  clickActive: boolean;
  unsubscribeActive: boolean;
  htmlFooter: string;
  textFooter: string;
  webScheme: "http" | "https" | null;
};
export type SendingQueues = { regularDisabled: boolean; reason: string | null; until: Date | null; scheduledDisabled: boolean };
export type CertificateStatus = { status: "none" | "processing" | "active" | "expired" | "error"; error: string | null };
export type WebhookType =
  | "delivered"
  | "permanent_fail"
  | "temporary_fail"
  | "complained"
  | "unsubscribed"
  | "accepted"
  | "opened"
  | "clicked";
/** v3 `urls` and legacy `url` merged. */
export type WebhookMap = Partial<Record<WebhookType, string[]>>;
export type MailgunRoute = {
  id: string;
  priority: number;
  description: string;
  expression: string;
  actions: string[];
  createdAt: string | null;
};
export type RouteInput = { priority: number; description: string; expression: string; actions: string[] };

/**
 * What GET /v4/address/validate answers (research verification-reference §2.2), for reference: the client returns the
 * parsed body as `unknown` and `fromMailgun` (@/core/verification/mailgun-map) reads it defensively, because the
 * fields are documented loosely (no enum for `result`, `reason` sometimes null or a bare string, v3-shaped bodies seen).
 */
export type MailgunValidationBody = {
  address?: string;
  /** "deliverable" | "undeliverable" | "do_not_send" | "catch_all" | "unknown" (no enum in Mailgun's spec). */
  result?: string;
  /** "low" | "medium" | "high" | "unknown". */
  risk?: string;
  reason?: string[] | string | null;
  is_disposable_address?: boolean;
  is_role_address?: boolean;
  did_you_mean?: string | null;
  engagement?: { engaging?: boolean; is_bot?: boolean; behavior?: string } | null;
  root_address?: string;
  last_seen?: number;
};

export type MailgunErrorKind =
  | "rejected"
  | "auth"
  | "payment"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "server"
  | "timeout"
  | "network"
  | "business-verification"
  | "not-allowed"
  | "unexpected"
  /** Refused by the client's own test-list guard: no request was made. */
  | "guard"
  /**
   * Refused by the client's own sender check: no request was made (SHARED-FROM-DESIGN §2.4, F8: the From line and
   * Reply-To don't fit the sending domain, `senderHeaderProblem`).
   */
  | "sender"
  /**
   * Mailgun refused a send because the plan's sending limit is reached (MAIN-DOMAIN-DESIGN O24): pause, never fail the
   * email for good. Only POST /messages (`classifyStatus(…, { send: true })`); every other endpoint keeps its kinds.
   */
  | "limit";
