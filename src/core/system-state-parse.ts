import { isCapDay } from "@/core/sending/capday";
import type {
  CapOverride,
  ReplyTestMailbox,
  ReplyTestOriginal,
  ReplyTestProvider,
  UnsubscribeSetup,
  UnsubscribeTestSetting,
} from "@/core/setting-types";
import type {
  AiPauseKind,
  AiPauseState,
  AiTokenState,
  CatchUpState,
  CatchUpSummary,
  CertificateState,
  CheckPauseKind,
  CheckPauseState,
  ChecklistGroup,
  ChecklistRecord,
  ChecklistRow,
  ChecklistRowKey,
  CheckStatus,
  DomainCheckState,
  HealthBaseline,
  InboxCheckState,
  InstanceState,
  LogsFormState,
  MailgunSetupState,
  NoticesState,
  OldDomainProblemState,
  OutageState,
  PacedSend,
  PacerState,
  PauseDetail,
  PauseKind,
  PauseState,
  RestoreDomain,
  RestoreReport,
  RestoreState,
  SendingDayState,
  SetupStep,
  SetupStepKey,
  TunnelState,
  WaitReason,
  WarmupDay,
  WarmupDayResult,
  WarmupState,
  WebhookStats,
} from "@/core/system-state";

/**
 * Lenient parsers for every SystemState shape of the Milestone 3 contract (docs/dev/M3-DESIGN.md §2.3, §4.2.7), the
 * Milestone 5 pauses and measured prompt tokens (docs/dev/M5-DESIGN.md §5.3), the Milestone 6 optional fields
 * (docs/dev/M6-DESIGN.md §7.2: left out when absent or invalid), the shared From address's rows, wait reason and
 * reply-test fields (docs/dev/SHARED-FROM-DESIGN.md §7.2: optional fields left out when absent or invalid), own-mailbox
 * mode's inbox check, wait reasons and optional fields (docs/dev/MAIN-DOMAIN-DESIGN.md §7.2: left out when absent or
 * invalid), and for the two structured Owner settings (§3.4).
 * Pure and browser-safe.
 *
 * Rules shared by every parser:
 *  - never throws: anything missing, of the wrong type or out of range falls back to the default shown in §2.3;
 *  - always returns a NEW object (arrays included), so a caller may change the result without touching a shared
 *    default or another caller's copy;
 *  - dates stay ISO strings (a string that doesn't parse as a date becomes null); cap days must be "YYYY-MM-DD".
 * Older stored shapes parse fine: `sending.pause` written by Milestone 2 as `{paused, reason}` keeps both fields, and
 * `mailgun.unsubscribeTest` without `domain` (or with extra fields such as `testSendId`/`sentAt`) loses nothing it needs.
 */

// ───────────────────────── small readers ─────────────────────────

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A non-negative whole number, or the fallback. */
function count(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** An ISO date string (anything Date.parse understands), else null. */
function iso(v: unknown): string | null {
  return typeof v === "string" && v && !Number.isNaN(Date.parse(v)) ? v : null;
}

function capDayOrNull(v: unknown): string | null {
  return isCapDay(v) ? v : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strings(v: unknown): string[] {
  return list(v).filter((x): x is string => typeof x === "string");
}

/** Parses each entry, drops the ones that return null, keeps the newest `max` (newest last). */
function entries<T>(v: unknown, parse: (x: unknown) => T | null, max?: number): T[] {
  const out: T[] = [];
  for (const x of list(v)) {
    const p = parse(x);
    if (p !== null) out.push(p);
  }
  return max !== undefined && out.length > max ? out.slice(out.length - max) : out;
}

// ───────────────────────── global pause ─────────────────────────

const PAUSE_KINDS: readonly PauseKind[] = [
  "manual",
  "health-bounce",
  "health-complaint",
  "mailgun-auth",
  "mailgun-verification",
  "mailgun-not-allowed",
  "mailgun-domain",
  "mailgun-queue",
  "mailgun-settings",
  "restore",
  "copied-database",
];

/** True for a PauseKind of the contract. */
export function isPauseKind(v: unknown): v is PauseKind {
  return oneOf(v, PAUSE_KINDS) !== null;
}

/**
 * Not paused. Frozen, so it can never be changed by accident: build new states with parsePauseState or a spread plus
 * a new `also` array.
 */
export const NOT_PAUSED: PauseState = Object.freeze({
  paused: false,
  reason: "",
  kind: null,
  fixText: "",
  since: null,
  byUserId: null,
  detail: null,
  also: Object.freeze([]) as unknown as PauseState["also"],
}) as PauseState;

/** A fresh, changeable copy of NOT_PAUSED. */
export function notPaused(): PauseState {
  return { ...NOT_PAUSED, also: [] };
}

/** The details behind a pause (health numbers, Mailgun's text, queue "until"); null when nothing usable is stored. */
export function parsePauseDetail(v: unknown): PauseDetail | null {
  const o = obj(v);
  if (!o) return null;
  const d: PauseDetail = {};
  const c = numOrNull(o.count);
  if (c !== null) d.count = c;
  const s = numOrNull(o.sample);
  if (s !== null) d.sample = s;
  const w = numOrNull(o.window);
  if (w !== null) d.window = w;
  const l = numOrNull(o.limit);
  if (l !== null) d.limit = l;
  if (typeof o.mailgunMessage === "string") d.mailgunMessage = o.mailgunMessage;
  const until = iso(o.until);
  if (until) d.until = until;
  return Object.keys(d).length ? d : null;
}

export function parsePauseState(v: unknown): PauseState {
  const o = obj(v);
  if (!o) return notPaused();
  return {
    paused: o.paused === true,
    reason: str(o.reason),
    kind: oneOf(o.kind, PAUSE_KINDS),
    fixText: str(o.fixText),
    since: iso(o.since),
    byUserId: intOrNull(o.byUserId),
    detail: parsePauseDetail(o.detail),
    also: entries(o.also, (x) => {
      const e = obj(x);
      const kind = e ? oneOf(e.kind, PAUSE_KINDS) : null;
      if (!e || !kind) return null;
      return { kind, reason: str(e.reason), at: str(e.at), detail: parsePauseDetail(e.detail) };
    }),
  };
}

// ───────────────────────── health ─────────────────────────

export function parseHealthBaseline(v: unknown): HealthBaseline {
  const o = obj(v) ?? {};
  const a = obj(o.acknowledged);
  const ackKind = a ? oneOf(a.kind, ["health-bounce", "health-complaint"] as const) : null;
  return {
    since: iso(o.since),
    resumedById: intOrNull(o.resumedById),
    acknowledged: a && ackKind ? { kind: ackKind, count: count(a.count), sample: count(a.sample) } : null,
    warnedBounceAt: iso(o.warnedBounceAt),
    warnedComplaintAt: iso(o.warnedComplaintAt),
  };
}

// ───────────────────────── warm-up ─────────────────────────

const WARMUP_RESULTS: readonly WarmupDayResult[] = [
  "up",
  "hold-low-use",
  "hold-unhealthy",
  "hold-not-sending-day",
  "hold-at-max",
];

/** At most this many evaluated days are kept (newest last). */
export const WARMUP_HISTORY_MAX = 60;

function parseWarmupDay(v: unknown): WarmupDay | null {
  const o = obj(v);
  const day = o ? capDayOrNull(o.day) : null;
  const result = o ? oneOf(o.result, WARMUP_RESULTS) : null;
  if (!o || !day || !result) return null;
  return {
    day,
    cap: count(o.cap),
    used: count(o.used),
    result,
    bounces: count(o.bounces),
    bounceSample: count(o.bounceSample),
    complaints: count(o.complaints),
    complaintSample: count(o.complaintSample),
    stepAfter: count(o.stepAfter),
  };
}

export function parseWarmupState(v: unknown): WarmupState {
  const o = obj(v) ?? {};
  const out: WarmupState = {
    domain: strOrNull(o.domain),
    step: count(o.step),
    lastEvaluatedCapDay: capDayOrNull(o.lastEvaluatedCapDay),
    startedCapDay: capDayOrNull(o.startedCapDay),
    history: entries(o.history, parseWarmupDay, WARMUP_HISTORY_MAX),
  };
  // M6 (review GOLIVE-02): left out when missing, so states written before it parse exactly as before.
  const goLiveAt = iso(o.startedForGoLiveAt);
  if (goLiveAt) out.startedForGoLiveAt = goLiveAt;
  return out;
}

// ───────────────────────── pacing ─────────────────────────

const WAIT_REASONS: readonly WaitReason[] = [
  "paused",
  "restore-check",
  "mailgun-not-connected",
  "catch-up",
  "rate-limited",
  "mailgun-unreachable",
  "live-not-ready",
  "reply-route",
  "main-domain-mx",
  "pending-events",
  "outage-hold",
  "possible-reply",
  // Own-mailbox mode and the Mailgun plan (MAIN-DOMAIN-DESIGN §7.2).
  "plan-limit",
  "inbox-check",
  "outside-hours",
  "cap-reached",
  "sender-cap",
  "pacing",
  "nothing-due",
];

/** At most this many recent rejects are kept (the circuit breaker needs 3). */
export const RECENT_REJECTS_MAX = 3;

/** A stored gated send; a jitter factor outside 0.5–1.5 (or missing) becomes 1, the even spacing. */
function pacedSend(v: unknown): PacedSend | null {
  const o = obj(v);
  const at = o ? iso(o.at) : null;
  if (!o || !at) return null;
  const j = numOrNull(o.jitter);
  return { at, jitter: j !== null && j >= 0.5 && j <= 1.5 ? j : 1 };
}

export function parsePacerState(v: unknown): PacerState {
  const o = obj(v) ?? {};
  const w = obj(o.waiting);
  const reason = w ? oneOf(w.reason, WAIT_REASONS) : null;
  const byClass = obj(o.lastByClass) ?? {};
  return {
    nextSendAt: iso(o.nextSendAt),
    lastSentAt: iso(o.lastSentAt),
    lastGapSeconds: numOrNull(o.lastGapSeconds),
    lastByClass: { counted: pacedSend(byClass.counted), uncounted: pacedSend(byClass.uncounted) },
    backoffUntil: iso(o.backoffUntil),
    backoffReason: oneOf(o.backoffReason, ["rate-limited", "mailgun-unreachable"] as const),
    ambiguousStreak: count(o.ambiguousStreak),
    recentRejects: entries(
      o.recentRejects,
      (x) => {
        const r = obj(x);
        const at = r ? iso(r.at) : null;
        if (!r || !at) return null;
        return { at, toNorm: str(r.toNorm), message: str(r.message) };
      },
      RECENT_REJECTS_MAX,
    ),
    routeWaitSince: iso(o.routeWaitSince),
    waiting: w && reason ? { reason, until: iso(w.until), at: str(w.at) } : null,
  };
}

export function parseSendingDayState(v: unknown): SendingDayState {
  const o = obj(v) ?? {};
  return { capDay: capDayOrNull(o.capDay), capReachedNotifiedAt: iso(o.capReachedNotifiedAt) };
}

// ───────────────────────── catch-up ─────────────────────────

function parseCatchUpSummary(v: unknown): CatchUpSummary | null {
  const o = obj(v);
  if (!o) return null;
  return {
    domains: strings(o.domains),
    eventsApplied: count(o.eventsApplied),
    suppressionsAdded: count(o.suppressionsAdded),
    suppressionsPushed: count(o.suppressionsPushed),
    inboundStored: count(o.inboundStored),
    duplicatesFound: count(o.duplicatesFound),
  };
}

/** M6 (M6-DESIGN §7.2, L10): at most this many old-domain problems are kept, newest last. */
export const OLD_DOMAIN_PROBLEMS_MAX = 10;
/** M6: an old-domain problem's text is cut to this many characters. */
export const OLD_DOMAIN_TEXT_MAX = 300;

/** One old-domain problem: a non-empty domain, `since` and `lastAt` ISO, a text (cut to 300 characters); else null. */
function parseOldDomainProblem(v: unknown): OldDomainProblemState | null {
  const o = obj(v);
  if (!o) return null;
  const domain = strOrNull(o.domain);
  const since = iso(o.since);
  const lastAt = iso(o.lastAt);
  const text = strOrNull(o.text);
  if (!domain || !since || !lastAt || text === null) return null;
  return { domain, since, lastAt, text: text.slice(0, OLD_DOMAIN_TEXT_MAX) };
}

export function parseCatchUpState(v: unknown): CatchUpState {
  const o = obj(v) ?? {};
  const out: CatchUpState = {
    lastStartedAt: iso(o.lastStartedAt),
    lastFinishedAt: iso(o.lastFinishedAt),
    lastSuccessAt: iso(o.lastSuccessAt),
    lastError: strOrNull(o.lastError),
    lastErrorKind: oneOf(o.lastErrorKind, ["auth", "network", "server", "other"] as const),
    lastReason: oneOf(o.lastReason, ["startup", "hourly", "manual"] as const),
    lastSummary: parseCatchUpSummary(o.lastSummary),
  };
  // M6: the field is left out when there are none, so states written before M6 parse exactly as before.
  const oldDomains = entries(o.oldDomains, parseOldDomainProblem, OLD_DOMAIN_PROBLEMS_MAX);
  if (oldDomains.length > 0) out.oldDomains = oldDomains;
  // M6 (review DASHBOARD-1): left out while the check works, so states without it parse exactly as before.
  const failingSince = iso(o.failingSince);
  if (failingSince) out.failingSince = failingSince;
  return out;
}

export function parseOutageState(v: unknown): OutageState {
  const o = obj(v) ?? {};
  return {
    detectedAt: iso(o.detectedAt),
    from: iso(o.from),
    to: iso(o.to),
    beyondLogRetention: bool(o.beyondLogRetention),
    beyondMessageRetention: bool(o.beyondMessageRetention),
    handledAt: iso(o.handledAt),
    heldFor: iso(o.heldFor),
    heldTo: iso(o.heldTo),
    heldCount: count(o.heldCount),
  };
}

// ───────────────────────── restore ─────────────────────────

function parseRestoreReport(v: unknown): RestoreReport | null {
  const o = obj(v);
  const finishedAt = o ? iso(o.finishedAt) : null;
  if (!o || !finishedAt) return null;
  return {
    finishedAt,
    mailgunChecked: bool(o.mailgunChecked),
    passes: count(o.passes),
    windowFrom: iso(o.windowFrom),
    windowTo: iso(o.windowTo),
    olderThanRetention: bool(o.olderThanRetention),
    acceptedEvents: count(o.acceptedEvents),
    matchedByMessageId: count(o.matchedByMessageId),
    matchedBySendId: count(o.matchedBySendId),
    matchedByRecipient: count(o.matchedByRecipient),
    rowsCreated: count(o.rowsCreated),
    externalSends: count(o.externalSends),
    madeUnconfirmed: count(o.madeUnconfirmed),
    error: strOrNull(o.error),
  };
}

export function parseRestoreState(v: unknown): RestoreState {
  const o = obj(v) ?? {};
  const out: RestoreState = {
    status: oneOf(o.status, ["none", "pending", "scanning", "done", "failed"] as const) ?? "none",
    restoredFrom: iso(o.restoredFrom),
    scanFrom: iso(o.scanFrom),
    markerAt: iso(o.markerAt),
    file: strOrNull(o.file),
    handledAt: iso(o.handledAt),
    report: parseRestoreReport(o.report),
    acknowledgedAt: iso(o.acknowledgedAt),
    acknowledgedById: intOrNull(o.acknowledgedById),
  };
  // M6 (§3.7): who resumed after the restore. Each field is kept only when valid and left out otherwise, so states
  // written before M6 parse exactly as before.
  const resumedAt = iso(o.resumedAt);
  if (resumedAt) out.resumedAt = resumedAt;
  const resumedById = intOrNull(o.resumedById);
  if (resumedById !== null && resumedById > 0) out.resumedById = resumedById;
  // Review BACKUPS-7: the sending domains from before the restore. Absent stays absent (an older state or marker);
  // anything present but unreadable is null ("couldn't be read"), the safe side.
  if (Object.hasOwn(o, "domainsBefore")) out.domainsBefore = parseRestoreDomains(o.domainsBefore);
  return out;
}

/**
 * A list of Mailgun sending domains ({name, region}), as the RESTORED marker and RestoreState carry them: names
 * lowercased and trimmed, duplicates and entries without a usable name left out, a region other than "US" read as
 * "EU". null for anything that isn't a list (null itself included).
 */
export function parseRestoreDomains(v: unknown): RestoreDomain[] | null {
  if (!Array.isArray(v)) return null;
  const out: RestoreDomain[] = [];
  for (const item of v) {
    const o = obj(item);
    const name = o && typeof o.name === "string" ? o.name.trim().toLowerCase() : "";
    if (!name || name.length > 253 || !/^[a-z0-9.-]+$/.test(name) || out.some((d) => d.name === name)) continue;
    out.push({ name, region: o?.region === "US" ? "US" : "EU" });
  }
  return out;
}

// ───────────────────────── database instance ─────────────────────────

/**
 * Null unless all three fields are there: an unknown instance is treated as "not recorded yet". M6 (L8): `host` is
 * kept when it is a non-empty string and left out otherwise (rows written before M6 have none).
 */
export function parseInstanceState(v: unknown): InstanceState | null {
  const o = obj(v);
  if (!o) return null;
  const dbPath = strOrNull(o.dbPath);
  const id = strOrNull(o.id);
  const firstSeenAt = iso(o.firstSeenAt);
  if (!dbPath || !id || !firstSeenAt) return null;
  const host = strOrNull(o.host);
  return host ? { dbPath, id, firstSeenAt, host } : { dbPath, id, firstSeenAt };
}

// ───────────────────────── remote access ─────────────────────────

function parseHttpCheck(v: unknown): { at: string; ok: boolean; status: number | null; error: string | null } | null {
  const o = obj(v);
  const at = o ? iso(o.at) : null;
  if (!o || !at) return null;
  return { at, ok: bool(o.ok), status: intOrNull(o.status), error: strOrNull(o.error) };
}

export function parseTunnelState(v: unknown): TunnelState {
  const o = obj(v) ?? {};
  const protectedCheck = parseHttpCheck(o.appProtectedCheck);
  const pc = obj(o.appProtectedCheck);
  return {
    checkedAt: iso(o.checkedAt),
    state: oneOf(o.state, ["connected", "degraded", "down", "not-running", "unknown"] as const) ?? "unknown",
    readyConnections: count(o.readyConnections),
    port: intOrNull(o.port),
    connectorId: strOrNull(o.connectorId),
    version: strOrNull(o.version),
    versionWarning: strOrNull(o.versionWarning),
    downSince: iso(o.downSince),
    notifiedAt: iso(o.notifiedAt),
    publicCheck: parseHttpCheck(o.publicCheck),
    webhookPathCheck: parseHttpCheck(o.webhookPathCheck),
    appProtectedCheck: protectedCheck ? { ...protectedCheck, location: pc ? strOrNull(pc.location) : null } : null,
    selfCheckNonce: strOrNull(o.selfCheckNonce),
  };
}

// ───────────────────────── Mailgun setup ─────────────────────────

const SETUP_STEP_KEYS: readonly SetupStepKey[] = [
  "public-address",
  "tracking-open",
  "tracking-click",
  "unsubscribe",
  "spam-filter",
  "retention",
  "pii",
  "certificate",
  "https",
  "signing-key",
  "webhooks",
  "routes",
];

function parseSetupStep(v: unknown): SetupStep | null {
  const o = obj(v);
  const key = o ? oneOf(o.key, SETUP_STEP_KEYS) : null;
  if (!o || !key) return null;
  return { key, ok: boolOrNull(o.ok), text: str(o.text), detail: strOrNull(o.detail), at: str(o.at) };
}

function parseCertificate(v: unknown): CertificateState | null {
  const o = obj(v);
  const host = o ? strOrNull(o.host) : null;
  if (!o || !host) return null;
  return {
    host,
    status:
      oneOf(o.status, ["none", "processing", "active", "expired", "error", "not-in-plan", "cname-missing"] as const) ??
      "none",
    startedAt: iso(o.startedAt),
    lastPolledAt: iso(o.lastPolledAt),
    error: strOrNull(o.error),
  };
}

export function parseMailgunSetupState(v: unknown): MailgunSetupState {
  const o = obj(v) ?? {};
  return {
    runAt: iso(o.runAt),
    byUserId: intOrNull(o.byUserId),
    jobId: intOrNull(o.jobId),
    steps: entries(o.steps, parseSetupStep),
    certificate: parseCertificate(o.certificate),
  };
}

// ───────────────────────── domain checklist ─────────────────────────

const CHECKLIST_KEYS: readonly ChecklistRowKey[] = [
  "mailgun-domain",
  "spf",
  "dkim",
  "mx",
  "tracking-cname",
  "https-links",
  "dmarc",
  "tracking-off",
  "unsubscribe",
  "spam-filter",
  "retention",
  "signing-key",
  "webhooks",
  "reply-routes",
  "sending-allowed",
  "monthly-limit",
  "remote-access",
  "reply-test",
  "postmaster",
  "domain-age",
  // Shared-From mode (SHARED-FROM-DESIGN §7.2).
  "from-mx",
  "from-spf",
];
const CHECKLIST_GROUPS: readonly ChecklistGroup[] = ["mailgun", "dns", "settings", "connection", "optional"];
const CHECK_STATUSES: readonly CheckStatus[] = ["ok", "warn", "bad", "unknown", "info", "off"];

function parseChecklistRecord(v: unknown): ChecklistRecord | null {
  const o = obj(v);
  if (!o || typeof o.type !== "string") return null;
  return {
    type: o.type,
    name: str(o.name),
    fqdn: str(o.fqdn),
    value: str(o.value),
    priority: strOrNull(o.priority),
    found: strings(o.found),
  };
}

function parseChecklistRow(v: unknown): ChecklistRow | null {
  const o = obj(v);
  const key = o ? oneOf(o.key, CHECKLIST_KEYS) : null;
  if (!o || !key) return null;
  return {
    key,
    group: oneOf(o.group, CHECKLIST_GROUPS) ?? "optional",
    status: oneOf(o.status, CHECK_STATUSES) ?? "unknown",
    title: str(o.title),
    text: str(o.text),
    fix: strOrNull(o.fix),
    records: entries(o.records, parseChecklistRecord),
    detail: strOrNull(o.detail),
  };
}

/** At most this many MX hosts are kept as the last good MX (MAIN-DOMAIN-DESIGN O10). */
export const LAST_GOOD_MX_MAX = 10;

/** A host name: labels of letters, digits and dashes (no leading or trailing dash), at most 253 characters. */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * DomainCheckState.lastGoodMx (MAIN-DOMAIN-DESIGN O10): null stays null; an array of at most 10 `{priority: integer
 * 0–65535, host: a host name}` is kept (hosts lowercased, a trailing dot dropped); anything else (not a list, too long,
 * one bad entry) → undefined, so the field is dropped: a partial list would name fewer MX records to put back than the
 * mail provider needs, so the fix then falls back to "its help pages list them".
 */
function parseLastGoodMx(v: unknown): Array<{ priority: number; host: string }> | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > LAST_GOOD_MX_MAX) return undefined;
  const out: Array<{ priority: number; host: string }> = [];
  for (const item of v) {
    const e = obj(item);
    if (!e) return undefined;
    const priority = e.priority;
    const host = typeof e.host === "string" ? e.host.trim().toLowerCase().replace(/\.$/, "") : "";
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 65_535) return undefined;
    if (!HOST_NAME.test(host)) return undefined;
    out.push({ priority, host });
  }
  return out;
}

/**
 * SystemState "domain.check". MAIN-DOMAIN-DESIGN §7.2: `replies` is kept only when exactly "own-mailbox" or "app" and
 * `lastGoodMx` only as parseLastGoodMx allows; both are left out otherwise, so states written before them parse exactly
 * as before.
 */
export function parseDomainCheckState(v: unknown): DomainCheckState {
  const o = obj(v) ?? {};
  const out: DomainCheckState = {
    domain: strOrNull(o.domain),
    region: oneOf(o.region, ["EU", "US"] as const),
    checkedAt: iso(o.checkedAt),
    lastVerifyAt: iso(o.lastVerifyAt),
    rows: entries(o.rows, parseChecklistRow),
    error: strOrNull(o.error),
  };
  const replies = oneOf(o.replies, ["own-mailbox", "app"] as const);
  if (replies) out.replies = replies;
  const lastGoodMx = parseLastGoodMx(o.lastGoodMx);
  if (lastGoodMx !== undefined) out.lastGoodMx = lastGoodMx;
  return out;
}

// ───────────────────────── the daily inbox check (MAIN-DOMAIN-DESIGN O33) ─────────────────────────

/**
 * SystemState "sending.inboxCheck": `at` an ISO date or null, `byUserId` a positive whole number or null; anything else
 * reads as the default (null).
 */
export function parseInboxCheckState(v: unknown): InboxCheckState {
  const o = obj(v) ?? {};
  const byUserId = intOrNull(o.byUserId);
  return { at: iso(o.at), byUserId: byUserId !== null && byUserId > 0 ? byUserId : null };
}

// ───────────────────────── small ones ─────────────────────────

export function parseLogsFormState(v: unknown): LogsFormState {
  const o = obj(v) ?? {};
  return {
    useDuration: bool(o.useDuration),
    learnedAt: iso(o.learnedAt),
    messageIdForm: oneOf(o.messageIdForm, ["plain", "bracketed"] as const),
    sendIdFilterOk: boolOrNull(o.sendIdFilterOk),
    provenAt: iso(o.provenAt),
  };
}

/** At most this many counted webhook rejections are kept (newest last). */
export const WEBHOOK_REJECTS_MAX = 10;

export function parseWebhookStats(v: unknown): WebhookStats {
  const o = obj(v) ?? {};
  return {
    lastEventAt: iso(o.lastEventAt),
    lastInboundAt: iso(o.lastInboundAt),
    lastRejectedAt: iso(o.lastRejectedAt),
    lastRejectReason: oneOf(o.lastRejectReason, ["signature", "stale", "unreadable", "no-key", "too-large"] as const),
    rejects: entries(o.rejects, (x) => iso(x), WEBHOOK_REJECTS_MAX),
  };
}

/** `{ [noticeKey]: ISO }`: when each throttled Owner notice was last sent. Entries that aren't dates are dropped. */
export function parseNotices(v: unknown): NoticesState {
  const o = obj(v);
  const out: NoticesState = {};
  if (!o) return out;
  for (const [k, val] of Object.entries(o)) {
    const at = iso(val);
    if (at) out[k] = at;
  }
  return out;
}

// ───────────────────────── address checks and AI (Milestone 5, M5-DESIGN §5.3) ─────────────────────────

const CHECK_PAUSE_KINDS: readonly CheckPauseKind[] = [
  "auth",
  "payment",
  "not-allowed",
  "business-verification",
  "not-found",
  "unreadable",
  "monthly_limit",
];

const AI_PAUSE_KINDS: readonly AiPauseKind[] = [
  "key_rejected",
  "no_permission",
  "model_not_found",
  "tier_spend_cap",
  "own_spend_limit",
  "billing",
  "monthly_limit",
  "no_price",
];

/** Address checks not paused. Frozen: parseCheckPause returns a fresh copy. */
export const NOT_PAUSED_CHECKS: CheckPauseState = Object.freeze({
  paused: false,
  kind: null,
  text: "",
  since: null,
  until: null,
  detail: null,
}) as CheckPauseState;

/** AI drafting not paused. Frozen: parseAiPause returns a fresh copy. */
export const NOT_PAUSED_AI: AiPauseState = Object.freeze({
  paused: false,
  kind: null,
  text: "",
  since: null,
  until: null,
  model: null,
  detail: null,
}) as AiPauseState;

/**
 * SystemState "checks.pause". Only a stored `paused: true` with a known kind is a pause; anything else (an unknown
 * kind from a newer or damaged row, a resumed state) reads as not paused. `until` is returned as stored: whether it has
 * passed is the reader's decision (getChecksPause).
 */
export function parseCheckPause(v: unknown): CheckPauseState {
  const o = obj(v);
  const kind = o ? oneOf(o.kind, CHECK_PAUSE_KINDS) : null;
  if (!o || o.paused !== true || !kind) return { ...NOT_PAUSED_CHECKS };
  return {
    paused: true,
    kind,
    text: str(o.text),
    since: iso(o.since),
    until: iso(o.until),
    detail: strOrNull(o.detail),
  };
}

/** SystemState "ai.pause", in the same way as parseCheckPause: unknown kinds read as not paused. */
export function parseAiPause(v: unknown): AiPauseState {
  const o = obj(v);
  const kind = o ? oneOf(o.kind, AI_PAUSE_KINDS) : null;
  if (!o || o.paused !== true || !kind) return { ...NOT_PAUSED_AI };
  return {
    paused: true,
    kind,
    text: str(o.text),
    since: iso(o.since),
    until: iso(o.until),
    model: strOrNull(o.model),
    detail: strOrNull(o.detail),
  };
}

/**
 * SystemState "ai.tokens": measured system-prompt tokens per "<model>|<promptVersion>". Entries without a whole number
 * ≥ 0 and an ISO date are dropped.
 */
export function parseAiTokens(v: unknown): AiTokenState {
  const o = obj(v);
  const raw = o ? obj(o.entries) : null;
  const entries: AiTokenState["entries"] = {};
  if (!raw) return { entries };
  for (const [k, val] of Object.entries(raw)) {
    // A JSON key "__proto__" would set the prototype instead of an entry.
    if (k === "__proto__") continue;
    const e = obj(val);
    const measuredAt = e ? iso(e.measuredAt) : null;
    if (!e || !measuredAt || typeof e.systemTokens !== "number" || !Number.isInteger(e.systemTokens) || e.systemTokens < 0) {
      continue;
    }
    entries[k] = { systemTokens: e.systemTokens, measuredAt };
  }
  return { entries };
}

// ───────────────────────── Owner settings with a structure (§3.4) ─────────────────────────

/** Setting "sending.capOverride": null unless it has a valid cap day, a whole number ≥ 0, who and when. */
export function parseCapOverride(v: unknown): CapOverride | null {
  const o = obj(v);
  if (!o) return null;
  const capDay = capDayOrNull(o.capDay);
  const cap = typeof o.cap === "number" && Number.isFinite(o.cap) && o.cap >= 0 ? Math.floor(o.cap) : null;
  const byUserId = intOrNull(o.byUserId);
  const at = iso(o.at);
  if (!capDay || cap === null || byUserId === null || !at) return null;
  return { capDay, cap, byUserId, at };
}

const PROVIDERS: readonly ReplyTestProvider[] = ["gmail", "microsoft", "yahoo", "other"];
const SETUPS: readonly UnsubscribeSetup[] = ["A", "B", "C"];

const DMARC_ANSWERS = ["pass", "fail", "unsure"] as const;

function parseReplyTestMailbox(v: unknown): ReplyTestMailbox | null {
  const o = obj(v);
  const address = o ? strOrNull(o.address) : null;
  if (!o || !address) return null;
  const authOk = oneOf(o.authOk, ["pass", "fail", "unsure"] as const);
  const out: ReplyTestMailbox = {
    address,
    provider: oneOf(o.provider, PROVIDERS) ?? "other",
    inboxOk: boolOrNull(o.inboxOk),
    authOk,
    authFromHeaders: authOk !== null && bool(o.authFromHeaders),
  };
  // Shared-From mode (SHARED-FROM-DESIGN §7.2): kept only when present and well-typed, so per-person shapes stay as
  // they were (no new keys).
  if (o.placementOk === null || typeof o.placementOk === "boolean") out.placementOk = o.placementOk;
  const dmarcOk = oneOf(o.dmarcOk, DMARC_ANSWERS);
  if (o.dmarcOk === null || dmarcOk !== null) out.dmarcOk = dmarcOk;
  if (typeof o.dmarcFromHeaders === "boolean") out.dmarcFromHeaders = o.dmarcFromHeaders;
  return out;
}

/** A string or null, present in `o`; undefined when missing or of another type. */
function presentStrOrNull(o: Obj, k: string): string | null | undefined {
  const v = o[k];
  return v === null || typeof v === "string" ? v : undefined;
}

/** A boolean or null, present in `o`; undefined when missing or of another type. */
function presentBoolOrNull(o: Obj, k: string): boolean | null | undefined {
  const v = o[k];
  return v === null || typeof v === "boolean" ? v : undefined;
}

/**
 * The stored pasted original (SHARED-FROM-DESIGN F25): every field must be present and of its type (null only where the
 * type allows it), else the whole original is dropped (fail closed: a half-read original never counts as a pass).
 */
function parseReplyTestOriginal(v: unknown): ReplyTestOriginal | null {
  const o = obj(v);
  if (!o) return null;
  const domain = strOrNull(o.domain);
  const from = strOrNull(o.from);
  const address = strOrNull(o.address);
  const testSendId = intOrNull(o.testSendId);
  const readAt = iso(o.readAt);
  const returnPathDomain = presentStrOrNull(o, "returnPathDomain");
  const returnPathOk = presentBoolOrNull(o, "returnPathOk");
  const dmarc = o.dmarc === null ? null : oneOf(o.dmarc, ["pass", "fail"] as const);
  const dkimSigner = presentStrOrNull(o, "dkimSigner");
  const mailtoDomain = presentStrOrNull(o, "mailtoDomain");
  const mailtoOk = presentBoolOrNull(o, "mailtoOk");
  if (!domain || !from || !address || testSendId === null || !readAt) return null;
  if (returnPathDomain === undefined || returnPathOk === undefined || (o.dmarc !== null && dmarc === null)) return null;
  if (dkimSigner === undefined || mailtoDomain === undefined || mailtoOk === undefined) return null;
  const out: ReplyTestOriginal = { domain, from, address, testSendId, returnPathDomain, returnPathOk, dmarc, dkimSigner, mailtoDomain, mailtoOk, readAt };
  // MAIN-DOMAIN-DESIGN §7.2: optional, kept only when well-formed and left out otherwise (the original itself stays), so
  // originals stored before these fields parse exactly as before.
  if (o.unsubscribeScheme === null || o.unsubscribeScheme === "https" || o.unsubscribeScheme === "http") {
    out.unsubscribeScheme = o.unsubscribeScheme;
  }
  // Review SECURITY-03 (fail closed): a mailto: address that is there but not well formed drops the whole original, so
  // the reply test asks for it again instead of treating the header as having no unsubscribe-by-email address. Only
  // own-mailbox originals carry the field; app-mode shapes are unchanged.
  const mailtoAddress = o.mailtoAddress;
  if (mailtoAddress === null) out.mailtoAddress = null;
  else if (typeof mailtoAddress === "string" && isMailtoAddress(mailtoAddress)) out.mailtoAddress = mailtoAddress;
  else if (mailtoAddress !== undefined) return null;
  if (o.mailtoUnreadable === true) out.mailtoUnreadable = true;
  return out;
}

/**
 * A stored List-Unsubscribe mailto: address (MAIN-DOMAIN-DESIGN §7.2, review SECURITY-03): at most 998 characters (a
 * header line's limit: Mailgun's `u+…` tokens can be longer than RFC 5321's path), no spaces or angle brackets, and one
 * "@" with something on both sides (an "@" inside a quoted local part is allowed). The same rule as
 * `@/core/reply-test`'s `mailtoAddressIn`.
 */
function isMailtoAddress(v: string): boolean {
  const at = v.lastIndexOf("@");
  if (v.length === 0 || v.length > 998 || at <= 0 || at === v.length - 1 || /[\s<>]/.test(v)) return false;
  const local = v.slice(0, at);
  return !local.includes("@") || (local.length > 2 && local.startsWith('"') && local.endsWith('"'));
}

/**
 * Setting "mailgun.unsubscribeTest". Old stored shapes (with testSendId/sentAt, without domain) parse fine. The shared
 * From fields (`from`, `original`, SHARED-FROM-DESIGN §7.2) are kept only when present and well-typed; a stored shape
 * without them parses exactly as before.
 */
export function parseUnsubscribeTest(v: unknown): UnsubscribeTestSetting {
  const o = obj(v) ?? {};
  const out: UnsubscribeTestSetting = {
    setup: oneOf(o.setup, SETUPS) ?? "A",
    status: oneOf(o.status, ["untested", "passed", "failed"] as const) ?? "untested",
    domain: strOrNull(o.domain),
    mailboxes: entries(o.mailboxes, parseReplyTestMailbox),
    headersOk: boolOrNull(o.headersOk),
    decidedAt: iso(o.decidedAt),
    decidedById: intOrNull(o.decidedById),
    note: strOrNull(o.note),
  };
  if (o.from === null || typeof o.from === "string") out.from = o.from;
  if (o.original === null) out.original = null;
  else {
    const original = parseReplyTestOriginal(o.original);
    if (original) out.original = original;
  }
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.2): kept only when well-typed, left out otherwise (app-mode shapes unchanged).
  if (o.replies === "own-mailbox") out.replies = "own-mailbox";
  if (o.mailtoArrived === null || typeof o.mailtoArrived === "boolean") out.mailtoArrived = o.mailtoArrived;
  // Review REPLIES-03: the last-resort choice, kept only when exactly true (anything else = Mailgun's own header).
  if (o.leaveOutMailto === true) out.leaveOutMailto = true;
  return out;
}
