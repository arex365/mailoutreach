/**
 * Milestone 3 contract (docs/dev/M3-DESIGN.md §2.3): SystemState keys and JSON shapes. Milestone 5 (M5-DESIGN §5.3)
 * adds the address check pause, the AI pause and the measured prompt tokens; Milestone 6 (M6-DESIGN §7.2) the
 * instance's host, the old-domain catch-up problems and who resumed after a restore (optional fields, no new keys).
 * The shared From address (SHARED-FROM-DESIGN §7.2) adds two checklist rows and one wait reason (no new keys).
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.2) adds the key "sending.inboxCheck", two wait reasons and two optional fields
 * of "domain.check" (no new checklist key, no new pause kind).
 * SystemState is worker-owned (PLAN B4): read with getState(), written with casState()/setState()
 * from @/server/state, always through the parse functions in @/core/system-state-parse.
 * Dates are ISO strings; cap days are "YYYY-MM-DD" (see @/core/sending/capday).
 */
import type { RepliesMode } from "@/core/sending/own-mailbox";

export const STATE_KEYS = {
  pause: "sending.pause",
  healthBaseline: "health.baseline",
  warmup: "warmup",
  pacer: "sending.pacer",
  sendingDay: "sending.day",
  catchUp: "mailgun.catchUp",
  outage: "catchup.outage",
  restore: "restore",
  tunnel: "tunnel.status",
  mailgunSetup: "mailgun.setup",
  domainCheck: "domain.check",
  logsForm: "mailgun.logsForm",
  webhooks: "webhooks.stats",
  notices: "notices",
  instance: "instance",
  // Milestone 5 (M5-DESIGN §5.3)
  checksPause: "checks.pause",
  aiPause: "ai.pause",
  aiTokens: "ai.tokens",
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.2, O33): the daily "I've read contact@…" click, written only by
  // markInboxChecked (services/sending/inbox-check.ts).
  inboxCheck: "sending.inboxCheck",
} as const;
export type StateKey = (typeof STATE_KEYS)[keyof typeof STATE_KEYS];

// ── global pause ──
export type PauseKind =
  | "manual"
  | "health-bounce"
  | "health-complaint"
  | "mailgun-auth"
  | "mailgun-verification"
  | "mailgun-not-allowed"
  | "mailgun-domain"
  | "mailgun-queue"
  | "mailgun-settings"
  | "restore"
  | "copied-database";
export type PauseDetail = {
  /** Health: problems counted, emails in the sample, window size, the limit ("more than N"). */
  count?: number;
  sample?: number;
  window?: number;
  limit?: number;
  /** Mailgun's own error text, shown behind "Details". */
  mailgunMessage?: string;
  /** Mailgun queue disabled until (ISO). */
  until?: string;
};
export type PauseState = {
  paused: boolean;
  /** Short, for the top-bar label "Paused: <reason>", e.g. "7 of the last 200 emails bounced". */
  reason: string;
  kind: PauseKind | null;
  /** What to do, full sentences, e.g. "Open the bounced list, …, then click Resume." */
  fixText: string;
  since: string | null;
  /** Who paused it (null = the app did). */
  byUserId: number | null;
  detail: PauseDetail | null;
  /** Other automatic causes that arrived while already paused (never replaces the first cause). */
  also: Array<{ kind: PauseKind; reason: string; at: string; detail: PauseDetail | null }>;
};

// ── health ──
export type HealthBaseline = {
  /** Only emails sent after this instant count (set when a health pause is resumed). */
  since: string | null;
  resumedById: number | null;
  acknowledged: { kind: "health-bounce" | "health-complaint"; count: number; sample: number } | null;
  /**
   * Half-limit warning sent. Cleared by the health check when the count falls below half the limit again, or when the
   * warning is more than 7 days old, so a new rise warns again.
   */
  warnedBounceAt: string | null;
  warnedComplaintAt: string | null;
};

// ── warm-up ──
export type WarmupDayResult = "up" | "hold-low-use" | "hold-unhealthy" | "hold-not-sending-day" | "hold-at-max";
export type WarmupDay = {
  day: string;
  cap: number;
  used: number;
  result: WarmupDayResult;
  bounces: number;
  bounceSample: number;
  complaints: number;
  complaintSample: number;
  /** 0-based step after this day. */
  stepAfter: number;
};
export type WarmupState = {
  /** The sending domain this ramp belongs to; a different domain restarts the ramp. "" in the practice copy. */
  domain: string | null;
  /** 0-based index into the warm-up table. */
  step: number;
  lastEvaluatedCapDay: string | null;
  startedCapDay: string | null;
  /** Newest last, at most 60. */
  history: WarmupDay[];
  /**
   * M6 (review GOLIVE-02): the go-live (Setting "sending.goLiveAt", ISO) this ramp was restarted for. The self-healing
   * restart compares it with the setting instead of recomputing the go-live day in today's cap-day zone, so changing
   * that zone never restarts the ramp. Absent in states written before it (then the cap days are compared once and
   * the go-live is recorded).
   */
  startedForGoLiveAt?: string;
};

// ── pacing ──
export type WaitReason =
  | "paused"
  | "restore-check"          // a restore is being checked with Mailgun (§4.3.7)
  | "mailgun-not-connected"
  | "catch-up"               // "Waiting for the check with Mailgun"
  | "rate-limited"           // Mailgun 429
  | "mailgun-unreachable"    // back-off after timeouts/5xx/404 on a send
  | "live-not-ready"         // LIVE rows held: Setup isn't A, or tracking/unsubscribe settings drifted
  | "reply-route"            // LIVE rows held: the sender's reply route isn't working
  | "main-domain-mx"         // LIVE rows held: the main domain's MX points to Mailgun or is missing (shared-From mode, SHARED-FROM-DESIGN F27)
  | "pending-events"         // every due candidate has an unprocessed event or reply (§4.3.4)
  | "outage-hold"            // M4: TEST/LIVE follow-ups wait while an outage is found but its hold isn't applied yet
  | "possible-reply"         // M4: the company has a possible reply nobody has decided yet (M4-DESIGN §2.5.1 step 3)
  | "plan-limit"             // TEST/LIVE rows held: the Mailgun plan's daily limit is used up in the last 24 hours (MAIN-DOMAIN-DESIGN O23)
  | "inbox-check"            // LIVE follow-ups held in own-mailbox mode until someone has read the own mailbox today after the person's last email (MAIN-DOMAIN-DESIGN O33)
  | "outside-hours"
  | "cap-reached"
  | "sender-cap"
  | "pacing"
  | "nothing-due";
/** One gated send: when it went, and the random factor (0.5–1.5) drawn for the gap after it. */
export type PacedSend = { at: string; jitter: number };
export type PacerState = {
  /** When the next email of the class just sent was planned, at the time of that send (for display only). */
  nextSendAt: string | null;
  /** The last gated send of any class (no two gated sends closer than the smallest gap). */
  lastSentAt: string | null;
  lastGapSeconds: number | null;
  /**
   * The last gated send of each class (counted: LIVE, and dry runs in the practice copy; uncounted: TEST and the
   * other gated dry runs). Each tick recomputes the gap after it from that class's CURRENT due emails, so a new
   * campaign or a resumed one shortens the wait at once and the other class never waits for this one.
   */
  lastByClass: { counted: PacedSend | null; uncounted: PacedSend | null };
  /** No Mailgun send before this (429 reset, or the back-off after uncertain outcomes or a 404). */
  backoffUntil: string | null;
  backoffReason: "rate-limited" | "mailgun-unreachable" | null;
  /** Uncertain outcomes (timeout, network, 5xx, 3xx) in a row; a 200 resets it. Back-off 5, 15, then 60 min. */
  ambiguousStreak: number;
  /** The last refused sends (rejected outcomes), newest last, at most 3: the circuit breaker (§4.3.5). */
  recentRejects: Array<{ at: string; toNorm: string; message: string }>;
  /** Since when LIVE rows wait for a working reply route (Owner notice after 1 hour). */
  routeWaitSince: string | null;
  /** Why gated emails are waiting right now (written only when it changes, or once a minute). */
  waiting: { reason: WaitReason; until: string | null; at: string } | null;
};
export type SendingDayState = { capDay: string | null; capReachedNotifiedAt: string | null };

// ── catch-up ──
export type CatchUpSummary = {
  domains: string[];
  eventsApplied: number;
  suppressionsAdded: number;
  suppressionsPushed: number;
  inboundStored: number;
  /** Message-IDs Mailgun accepted twice (a duplicate that slipped through; §4.4.5). */
  duplicatesFound: number;
};
export type CatchUpState = {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  /** Every domain's steps completed. The catch-up gate and warm-up evaluation read only this. */
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Network/server failures allow the 15-minute fallback of the catch-up gate; auth never does. */
  lastErrorKind: "auth" | "network" | "server" | "other" | null;
  lastReason: "startup" | "hourly" | "manual" | null;
  lastSummary: CatchUpSummary | null;
  /** M6 (L10): older domains that couldn't be checked; absent or empty when none. */
  oldDomains?: OldDomainProblemState[];
  /**
   * M6 (review DASHBOARD-1): when the check started failing, the start of the first failed run since the last success
   * (or ever); absent while it works. Unlike `lastStartedAt`, which every retry moves, it stays put, so "failing for
   * more than 2 hours" can be told even when the check never succeeded.
   */
  failingSince?: string | null;
};
/** M6 (L10): an older sending domain the catch-up couldn't check, since when. */
export type OldDomainProblemState = { domain: string; since: string; lastAt: string; text: string };
export type OutageState = {
  detectedAt: string | null;
  /** The part of the time the app couldn't check, oldest first. */
  from: string | null;
  to: string | null;
  beyondLogRetention: boolean;
  beyondMessageRetention: boolean;
  /** When the hold of this outage was applied, or found unnecessary (M4-DESIGN §2.8.3); null = found, not held yet. */
  handledAt: string | null;
  /** The `from` of the gap whose hold was last applied (with heldTo: outageGapCovered). */
  heldFor: string | null;
  /** The `to` of the gap whose hold was last applied. */
  heldTo: string | null;
  /** How many recipients that hold put on hold. */
  heldCount: number;
};

// ── restore ──
export type RestoreReport = {
  finishedAt: string;
  mailgunChecked: boolean;
  /** 1 after the first walk, 2 after the second (35 min after the restore, when Mailgun's logs have caught up). */
  passes: number;
  windowFrom: string | null;
  windowTo: string | null;
  /** The backup is older than Mailgun's log retention, so some sends can't be checked. */
  olderThanRetention: boolean;
  acceptedEvents: number;
  matchedByMessageId: number;
  matchedBySendId: number;
  matchedByRecipient: number;
  rowsCreated: number;
  externalSends: number;
  madeUnconfirmed: number;
  error: string | null;
};
export type RestoreState = {
  /** pending/scanning (and failed or unchecked until acknowledged) hold every TEST/LIVE send (§4.3.7). */
  status: "none" | "pending" | "scanning" | "done" | "failed";
  restoredFrom: string | null;
  /** min(restoredFrom, newest ActivityLog.at in the restored database) − 1 h. */
  scanFrom: string | null;
  markerAt: string | null;
  file: string | null;
  handledAt: string | null;
  report: RestoreReport | null;
  acknowledgedAt: string | null;
  acknowledgedById: number | null;
  /** M6 (§3.7): when and by whom sending was resumed after this restore (any outcome); absent before M6. */
  resumedAt?: string | null;
  resumedById?: number | null;
  /**
   * Review BACKUPS-7: the Mailgun sending domains the database had just before the restore (restore.bat reads them
   * into the RESTORED marker), so the check also walks a domain the restored backup doesn't know. null: they couldn't
   * be read (the check then can't count as complete); absent: a marker from before this field (only the restored
   * database's domains are walked, as before).
   */
  domainsBefore?: RestoreDomain[] | null;
};
/** A Mailgun sending domain and its region, as RestoreState.domainsBefore lists them. */
export type RestoreDomain = { name: string; region: "EU" | "US" };

// ── which database file this is (a copy must not send the same emails again) ──
export type InstanceState = {
  dbPath: string;
  id: string;
  firstSeenAt: string;
  /** M6 (L8): os.hostname() at the last start; missing in rows written before M6. */
  host?: string;
};

// ── remote access (cloudflared) ──
export type TunnelState = {
  checkedAt: string | null;
  state: "connected" | "degraded" | "down" | "not-running" | "unknown";
  readyConnections: number;
  port: number | null;
  connectorId: string | null;
  version: string | null;
  /** Plain sentence when the version is known-bad or over a year old. */
  versionWarning: string | null;
  downSince: string | null;
  notifiedAt: string | null;
  /** GET <APP_PUBLIC_URL>/api/health from this PC, through Cloudflare. */
  publicCheck: { at: string; ok: boolean; status: number | null; error: string | null } | null;
  /** POST <APP_PUBLIC_URL>/api/webhooks/mailgun/events answered by the app itself (not an Access login page). */
  webhookPathCheck: { at: string; ok: boolean; status: number | null; error: string | null } | null;
  /** GET <APP_PUBLIC_URL>/contacts without cookies must redirect to *.cloudflareaccess.com (Access protects the app). */
  appProtectedCheck: { at: string; ok: boolean; status: number | null; location: string | null; error: string | null } | null;
  /** Random value the monitor sends as x-outreach-self-check; the webhook handler leaves such requests out of its stats. */
  selfCheckNonce: string | null;
};

// ── Mailgun setup ("Apply recommended settings") ──
export type SetupStepKey =
  | "public-address"
  | "tracking-open"
  | "tracking-click"
  | "unsubscribe"
  | "spam-filter"
  | "retention"
  | "pii"
  | "certificate"
  | "https"
  | "signing-key"
  | "webhooks"
  | "routes";
export type SetupStep = { key: SetupStepKey; ok: boolean | null; text: string; detail: string | null; at: string };
export type CertificateState = {
  host: string;
  status: "none" | "processing" | "active" | "expired" | "error" | "not-in-plan" | "cname-missing";
  startedAt: string | null;
  lastPolledAt: string | null;
  error: string | null;
};
export type MailgunSetupState = {
  runAt: string | null;
  byUserId: number | null;
  jobId: number | null;
  steps: SetupStep[];
  certificate: CertificateState | null;
};

// ── domain checklist ──
export type CheckStatus = "ok" | "warn" | "bad" | "unknown" | "info" | "off";
export type ChecklistRowKey =
  | "mailgun-domain"
  | "spf"
  | "dkim"
  | "mx"
  | "tracking-cname"
  | "https-links"
  | "dmarc"
  | "tracking-off"
  | "unsubscribe"
  | "spam-filter"
  | "retention"
  | "signing-key"
  | "webhooks"
  | "reply-routes"
  | "sending-allowed"
  | "monthly-limit"
  | "remote-access"
  | "reply-test"
  | "postmaster"
  | "domain-age"
  // Shared-From mode only (SHARED-FROM-DESIGN §3.2), titled with the From domain: its MX stays with the mail provider,
  // and its own SPF record. Never written in per-person mode.
  | "from-mx"
  | "from-spf";
export type ChecklistGroup = "mailgun" | "dns" | "settings" | "connection" | "optional";
export type ChecklistRecord = {
  type: string;
  /** Host name as the owner types it in a DNS panel ("@", "email", "pdk1._domainkey"). */
  name: string;
  /** Full host name, for the tooltip. */
  fqdn: string;
  value: string;
  priority: string | null;
  /** What resolvers see now (joined), for "Details". */
  found: string[];
};
export type ChecklistRow = {
  key: ChecklistRowKey;
  group: ChecklistGroup;
  status: CheckStatus;
  title: string;
  text: string;
  fix: string | null;
  records: ChecklistRecord[];
  detail: string | null;
};
export type DomainCheckState = {
  domain: string | null;
  region: "EU" | "US" | null;
  checkedAt: string | null;
  lastVerifyAt: string | null;
  rows: ChecklistRow[];
  error: string | null;
  /**
   * MAIN-DOMAIN-DESIGN O36: the way of sending the rows were built for (Setting "mailgun.replies" at the check); missing
   * = "app" (every check stored before this field). Readers compare it with `checkMatchesMode` (@/core/dns/check-state).
   */
  replies?: RepliesMode;
  /**
   * MAIN-DOMAIN-DESIGN O10: own-mailbox mode, the sending domain's MX answer at the last check whose from-mx row was
   * "ok" (at most 10, never a Mailgun or Cloudflare Email Routing host), named in every red from-mx fix to put back.
   * Missing or null = none seen yet (or a check of another domain or mode cleared it).
   */
  lastGoodMx?: Array<{ priority: number; host: string }> | null;
};

// ── the daily inbox check (own-mailbox mode, MAIN-DOMAIN-DESIGN O33) ──
/**
 * SystemState "sending.inboxCheck": the last "I've read contact@…" click (`at` ISO, `byUserId` who clicked). Default
 * both null (nobody has checked yet). Written only by markInboxChecked; LIVE follow-ups in own-mailbox mode wait until
 * `at` lies in today's cap day and after the person's last SENT email.
 */
export type InboxCheckState = { at: string | null; byUserId: number | null };

// ── small ones ──
export type LogsFormState = {
  useDuration: boolean;
  learnedAt: string | null;
  /** How `message_id` must be written in a Logs filter, proven on a real accepted send (§4.3.6); null = not yet. */
  messageIdForm: "plain" | "bracketed" | null;
  /** The `user_variables contains <send_id>` filter found a known send. */
  sendIdFilterOk: boolean | null;
  provenAt: string | null;
};
export type WebhookStats = {
  /** Last valid (signed, fresh) event / inbound POST. */
  lastEventAt: string | null;
  lastInboundAt: string | null;
  lastRejectedAt: string | null;
  lastRejectReason: "signature" | "stale" | "unreadable" | "no-key" | "too-large" | null;
  /**
   * Counted rejections only (body parsed, its domain is ours, timestamp fresh, signature wrong), newest last, at most 10.
   * Internet noise and the monitor's self-check never land here.
   */
  rejects: string[];
};
export type NoticesState = Record<string, string>;

// ── address checks and AI (Milestone 5) ──
export type CheckPauseKind = "auth" | "payment" | "not-allowed" | "business-verification" | "not-found" | "unreadable" | "monthly_limit";
export type CheckPauseState = {
  paused: boolean;
  kind: CheckPauseKind | null;
  /** The full sentence (M5-DESIGN §2.12). */
  text: string;
  since: string | null;
  /** Lifts by itself at this instant (monthly_limit: the next office month's start); null = until the Owner resumes. */
  until: string | null;
  /** Mailgun's own text, scrubbed, for "Details". */
  detail: string | null;
};
export type AiPauseKind = "key_rejected" | "no_permission" | "model_not_found" | "tier_spend_cap" | "own_spend_limit" | "billing" | "monthly_limit" | "no_price";
export type AiPauseState = {
  paused: boolean;
  kind: AiPauseKind | null;
  text: string;
  since: string | null;
  /** Lifts by itself at this instant (monthly limit, Anthropic's tier cap); null = until the Owner resumes. */
  until: string | null;
  /** The model the pause is about (model_not_found). */
  model: string | null;
  detail: string | null;
};
/** Measured system-prompt tokens per "<model>|<promptVersion>" (M5-DESIGN §3.5.4). */
export type AiTokenState = { entries: Record<string, { systemTokens: number; measuredAt: string }> };
