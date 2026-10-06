import { parseLogsFormState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { senderHeaderProblem } from "@/core/sending/from-address";
import { WEB_ONLY_LIST_UNSUBSCRIBE } from "@/core/sending/own-mailbox";
import {
  assertAllowedBaseUrl,
  assertKeyMatchesTarget,
  isAllowedStorageUrl,
  isLoopbackBase,
  mailgunApiBase,
} from "./base-url";
import { MailgunError, classifyStatus, errorText, retryAfterHintMs, retryAfterMs } from "./errors";
import { checkSendGuard } from "./send-guard";
import type {
  CertificateStatus,
  DnsRecordInfo,
  DomainInfo,
  LogsQuery,
  LogsWalk,
  MailgunRegion,
  MailgunRoute,
  RouteInput,
  SendingQueues,
  SendMessageInput,
  SendMessageResult,
  SuppressionItem,
  SuppressionList,
  TrackingSettings,
  WebhookMap,
  WebhookType,
} from "./types";

/**
 * The Mailgun REST client (M3-DESIGN §4.2.3). Plain fetch, no SDK. Request and response formats follow
 * docs/dev/research/mailgun-api-reference.md exactly.
 *
 * Safety rules built in:
 *  - the base URL is always checked (assertAllowedBaseUrl), and a test key only goes to the fake server;
 *  - every request uses `redirect: "error"`: a redirect could carry the key to another host;
 *  - sendMessage re-checks the test-list guard before anything else, is never retried and is never aborted from
 *    outside (only by its own 30 s timeout): aborting a POST Mailgun may already have accepted would turn a sent email
 *    into an unknown one;
 *  - other calls retry 429/5xx/timeouts up to 3 times (5xx and timeouts only when repeating is safe) and one 404 on
 *    domain endpoints after 5 s; paging follows Mailgun's links only on Mailgun's own origin;
 *  - a paid call (an address check, validateAddress) is exactly one request (`maxRetries: 0` governs every retry
 *    branch) and is never aborted from outside: the check job decides every retry (M5-DESIGN §0.2 rule 11, D29);
 *  - every failure is a MailgunError whose texts are redacted of the key and its Basic-auth form.
 */

export type MailgunClientOptions = {
  apiKey: string;
  region: MailgunRegion;
  /** Default mailgunApiBase(region); always passed through assertAllowedBaseUrl. */
  baseUrl?: string;
  /** Per request; default 30 s. */
  timeoutMs?: number;
  /** Wait before retry number `attempt` (0-based). Tests pass () => 0. */
  retryDelayMs?: (attempt: number) => number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Whether Logs queries use `end + duration` instead of `start + end` (learned once; default SystemState "mailgun.logsForm"). */
  logsForm?: { get(): Promise<boolean>; set(useDuration: boolean): Promise<void> };
  /**
   * Own-mailbox mode: the only From a send may carry (MAIN-DOMAIN-DESIGN O6, `ownMailboxRuleFrom`; "" = none fits yet, so
   * every send is refused); null/absent = app mode (today's sender check). `forRegion` copies it.
   */
  ownMailboxFrom?: string | null;
  /**
   * Own-mailbox mode's last resort (review REPLIES-03): whether its emails carry the app's own List-Unsubscribe with only
   * Mailgun's web link (`WEB_ONLY_LIST_UNSUBSCRIBE`, no `mailto:`). Asked before every send while `ownMailboxFrom` is set
   * (app mode never asks); default: Setting "mailgun.unsubscribeTest"'s `leaveOutMailto`, read lazily. Tests pass a stub.
   */
  leaveOutMailto?: () => Promise<boolean>;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Retries after the first try, for calls other than sends. */
export const MAX_RETRIES = 3;
export const MAX_RETRY_WAIT_MS = 60_000;
export const NOT_FOUND_RETRY_MS = 5_000;
const BACKOFF_MS = [1_000, 4_000, 15_000];
export const LOGS_PAGE_LIMIT = 100;
export const SUPPRESSION_PAGE_LIMIT = 1000;
/** Mailgun refuses 1,000 or more addresses per bulk call ("Batch size should be less than 1000"). */
export const UNSUBSCRIBE_BATCH = 999;
/** Never follow more pages than this in one walk. */
export const PAGE_GUARD = 1000;
export const ROUTES_PAGE_LIMIT = 100;
/** All `o:`, `h:` and `v:` fields of one email together (Mailgun's limit). */
export const SEND_OPTIONS_MAX_BYTES = 16_384;

/** RFC 2822 as Mailgun wants it: "Wed, 23 Sep 2026 10:00:00 -0000". */
export function rfc2822(d: Date): string {
  return d.toUTCString().slice(0, 25) + " -0000";
}

/** "<id>" / " <id> " → "id", lowercase. */
export function bareMessageId(v: string): string {
  return v.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}

type Body =
  | { kind: "form"; data: FormData }
  | { kind: "urlencoded"; data: URLSearchParams }
  | { kind: "json"; data: unknown };

type CallSpec = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below the base URL, e.g. "/v4/domains/send.example.com". */
  path?: string;
  /** An absolute URL (paging links, stored messages), already checked by the caller. */
  url?: string;
  query?: Array<[string, string]>;
  body?: Body;
  /** "GET /v4/domains/send.example.com", for errors and logs. */
  endpoint: string;
  /** Safe to repeat after an answer we never saw (GET, PUT, DELETE, upserts). Otherwise only a 429 is retried. */
  idempotent: boolean;
  /** Retry one 404 after 5 s: Mailgun's domain endpoints are "eventually consistent". */
  retryNotFound?: boolean;
  /**
   * Retries after the first try (default MAX_RETRIES). It governs every retry branch (timeouts, 429/5xx and the
   * `retryNotFound` retry): 0 means exactly one request, for paid calls (M5-DESIGN §2.2).
   */
  maxRetries?: number;
  /** Statuses handed back to the caller instead of thrown (and never retried). */
  allow?: readonly number[];
  accept?: string;
  signal?: AbortSignal;
  /**
   * POST /v3/{d}/messages (MAIN-DOMAIN-DESIGN O24): set only by `sendMessage`, so `classifyStatus` may read a 400/403
   * that says the plan's sending limit is reached as kind "limit". Every other call keeps today's kinds.
   */
  send?: boolean;
};

type CallResult = { status: number; headers: Headers; text: string; json: unknown };

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return null;
}

/** Tracking "active": true only when Mailgun says so plainly. */
function isOn(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

/** Open/click tracking count as off only when Mailgun says false, "false" or "no" (research §10.1). */
function isNotOff(v: unknown): boolean {
  return !(v === false || v === "false" || v === "no");
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function basicAuth(key: string): string {
  return "Basic " + Buffer.from("api:" + key).toString("base64");
}

/** The key and its Basic-auth form: what errors must never contain. */
function secretsFor(key: string): string[] {
  return key ? [key, Buffer.from("api:" + key).toString("base64")] : [];
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function causeText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      parts.push(typeof code === "string" && !e.message.includes(code) ? `${e.message} (${code})` : e.message);
      e = (e as { cause?: unknown }).cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return parts.join(": ");
}

// ───────────────────────── response parsers ─────────────────────────

function parseRecord(v: unknown): DnsRecordInfo {
  const o = obj(v);
  const valid = o.valid === "valid" || o.valid === "invalid" ? o.valid : "unknown";
  return {
    recordType: strOrNull(o.record_type) ?? "",
    name: strOrNull(o.name),
    value: strOrNull(o.value) ?? "",
    priority: strOrNull(o.priority),
    valid,
    isActive: o.is_active === true,
    cached: Array.isArray(o.cached) ? o.cached.filter((x): x is string => typeof x === "string") : [],
  };
}

function parseDomainInfo(json: unknown, requested: string): DomainInfo {
  const body = obj(json);
  const d = obj(body.domain);
  const dis = body.domain && d.disabled && typeof d.disabled === "object" ? obj(d.disabled) : null;
  const scheme = d.web_scheme === "http" || d.web_scheme === "https" ? d.web_scheme : null;
  const ttl = typeof d.message_ttl === "number" ? d.message_ttl : Number(d.message_ttl);
  return {
    name: strOrNull(d.name) ?? requested,
    state: strOrNull(d.state),
    isDisabled: d.is_disabled === true,
    disabled: dis
      ? {
          code: strOrNull(dis.code),
          note: strOrNull(dis.note),
          permanently: dis.permanently === true,
          reason: strOrNull(dis.reason),
          until: strOrNull(dis.until),
        }
      : null,
    spamAction: strOrNull(d.spam_action),
    webPrefix: strOrNull(d.web_prefix) || "email",
    webScheme: scheme,
    messageTtl: Number.isFinite(ttl) && d.message_ttl !== null && d.message_ttl !== undefined ? ttl : null,
    webhooksRedactPii: boolOrNull(d.webhooks_redact_pii),
    useAutomaticSenderSecurity: boolOrNull(d.use_automatic_sender_security),
    sending: Array.isArray(body.sending_dns_records) ? body.sending_dns_records.map(parseRecord) : [],
    receiving: Array.isArray(body.receiving_dns_records) ? body.receiving_dns_records.map(parseRecord) : [],
  };
}

function parseSuppressionItem(v: unknown): SuppressionItem | null {
  const o = obj(v);
  const address = strOrNull(o.address)?.trim().toLowerCase();
  if (!address) return null;
  const created = strOrNull(o.created_at);
  const t = created ? Date.parse(created) : NaN;
  return {
    address,
    createdAt: Number.isNaN(t) ? null : new Date(t),
    code: strOrNull(o.code),
    error: strOrNull(o.error),
    tags: Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === "string") : [],
  };
}

const WEBHOOK_TYPES: readonly WebhookType[] = [
  "delivered",
  "permanent_fail",
  "temporary_fail",
  "complained",
  "unsubscribed",
  "accepted",
  "opened",
  "clicked",
];

/** v3 `{webhooks: {type: {urls} | {url} | null}}` (v4 answers the same mapping); `urls` and legacy `url` merged. */
function parseWebhookMap(json: unknown): WebhookMap {
  const body = obj(json);
  const hooks = body.webhooks && typeof body.webhooks === "object" ? obj(body.webhooks) : body;
  const out: WebhookMap = {};
  for (const type of WEBHOOK_TYPES) {
    const entry = hooks[type];
    if (!entry || typeof entry !== "object") continue;
    const e = obj(entry);
    const urls = new Set<string>();
    if (Array.isArray(e.urls)) for (const u of e.urls) if (typeof u === "string" && u) urls.add(u);
    if (typeof e.url === "string" && e.url) urls.add(e.url);
    if (urls.size) out[type] = [...urls];
  }
  return out;
}

function parseRoute(v: unknown): MailgunRoute | null {
  const o = obj(v);
  const id = strOrNull(o.id);
  if (!id) return null;
  const priority = typeof o.priority === "number" ? o.priority : Number(o.priority);
  const actions = Array.isArray(o.actions)
    ? o.actions.filter((x): x is string => typeof x === "string")
    : typeof o.actions === "string"
      ? [o.actions]
      : [];
  return {
    id,
    priority: Number.isFinite(priority) ? priority : 0,
    description: strOrNull(o.description) ?? "",
    expression: strOrNull(o.expression) ?? "",
    actions,
    createdAt: strOrNull(o.created_at),
  };
}

/** A route from `{route: {...}}` (the spec) or a bare route (what mailgun-go reports for PUT). */
function routeFrom(json: unknown, endpoint: string): MailgunRoute {
  const body = obj(json);
  const route = parseRoute(body.route && typeof body.route === "object" ? body.route : body);
  if (!route) {
    throw new MailgunError({ kind: "unexpected", status: 200, endpoint, message: `Mailgun's answer to ${endpoint} had no route.` });
  }
  return route;
}

function routeForm(r: RouteInput): URLSearchParams {
  const form = new URLSearchParams();
  form.append("priority", String(Math.floor(r.priority)));
  form.append("description", r.description);
  form.append("expression", r.expression);
  for (const a of r.actions) form.append("action", a);
  return form;
}

// ───────────────────────── the client ─────────────────────────

export class MailgunClient {
  readonly baseUrl: string;
  readonly region: MailgunRegion;
  readonly #apiKey: string;
  readonly #opts: MailgunClientOptions;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #useDuration: boolean | null = null;

  constructor(opts: MailgunClientOptions) {
    this.region = opts.region === "US" ? "US" : "EU";
    const base = (opts.baseUrl ?? mailgunApiBase(this.region)).trim().replace(/\/+$/, "");
    assertAllowedBaseUrl(base);
    this.baseUrl = base;
    this.#apiKey = (opts.apiKey ?? "").trim();
    this.#opts = opts;
    this.#timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
  }

  /** The same key and options on the other region's API host (in fake mode the same fake server). */
  forRegion(region: MailgunRegion): MailgunClient {
    if (region === this.region) return this;
    // A real API host belongs to one region; the fake server (loopback) answers for both.
    return new MailgunClient({ ...this.#opts, region, baseUrl: isLoopbackBase(this.baseUrl) ? this.baseUrl : undefined });
  }

  /** Never included in logs or JSON. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, region: this.region };
  }

  // ───────────── plumbing ─────────────

  #url(spec: CallSpec): string {
    if (spec.url) {
      const u = new URL(spec.url);
      if (u.origin !== new URL(this.baseUrl).origin && !isAllowedStorageUrl(spec.url, this.baseUrl)) {
        throw new MailgunError({
          kind: "unexpected",
          requestStarted: false,
          endpoint: spec.endpoint,
          message: `Refused to send the Mailgun key to ${u.origin}.`,
        });
      }
      return spec.url;
    }
    const q = spec.query?.length ? "?" + new URLSearchParams(spec.query).toString() : "";
    return this.baseUrl + (spec.path ?? "/") + q;
  }

  /** One HTTP request, no retries. Transport failures become MailgunErrors (timeout, network, redirect). */
  async #once(spec: CallSpec, key: string, external?: AbortSignal): Promise<CallResult> {
    assertKeyMatchesTarget(key, this.baseUrl);
    const url = this.#url(spec);
    const headers: Record<string, string> = {
      Authorization: basicAuth(key),
      Accept: spec.accept ?? "application/json",
    };
    // Lets the fake server answer like the other region would (research §15 "region" option). Loopback only.
    if (isLoopbackBase(this.baseUrl)) headers["x-outreach-region"] = this.region;
    let body: BodyInit | undefined;
    if (spec.body?.kind === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(spec.body.data);
    } else if (spec.body) {
      body = spec.body.data;
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = external ? AbortSignal.any([timeout, external]) : timeout;
    const secrets = secretsFor(key);
    const fail = (err: unknown, status: number | null): MailgunError => {
      if (external?.aborted) {
        return new MailgunError({
          kind: "network",
          status,
          endpoint: spec.endpoint,
          secrets,
          message: `Stopped waiting for Mailgun (${spec.endpoint}): the app is stopping.`,
        });
      }
      if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) {
        return new MailgunError({
          kind: "timeout",
          status,
          endpoint: spec.endpoint,
          secrets,
          message: `Mailgun didn't answer within ${Math.round(this.#timeoutMs / 100) / 10} s (${spec.endpoint}).`,
        });
      }
      const text = causeText(err);
      if (/redirect/i.test(text)) {
        return new MailgunError({
          kind: "unexpected",
          status,
          endpoint: spec.endpoint,
          secrets,
          message: `Mailgun answered ${spec.endpoint} with a redirect, which the app never follows.`,
        });
      }
      return new MailgunError({
        kind: "network",
        status,
        endpoint: spec.endpoint,
        secrets,
        message: `Couldn't reach Mailgun (${spec.endpoint}): ${text}`,
      });
    };
    let res: Response;
    try {
      res = await this.#fetch(url, { method: spec.method, headers, body, redirect: "error", signal });
    } catch (err) {
      throw fail(err, null);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw fail(err, res.status);
    }
    return { status: res.status, headers: res.headers, text, json: parseJson(text) };
  }

  /**
   * The MailgunError for a non-2xx answer. A 429's `retryAfterMs` is Mailgun's hint, or 60 s without one; with
   * `hintOnly` it stays null without a hint (the address checks back off on their own then, M5-DESIGN §2.5.1).
   */
  #statusError(res: CallResult, spec: CallSpec, key: string, opts: { hintOnly?: boolean } = {}): MailgunError {
    const text = errorText(res.text);
    const kind = classifyStatus(res.status, text, { send: spec.send === true });
    const retryAfter =
      res.status !== 429
        ? null
        : opts.hintOnly
          ? retryAfterHintMs(res.headers, text, this.#now())
          : retryAfterMs(res.headers, text, this.#now());
    return new MailgunError({
      kind,
      status: res.status,
      mailgunMessage: text,
      retryAfterMs: retryAfter,
      body: res.text,
      endpoint: spec.endpoint,
      secrets: secretsFor(key),
      message: `Mailgun answered ${res.status} to ${spec.endpoint}${text ? `: ${text}` : "."}`,
    });
  }

  #delay(attempt: number, fallback: number): number {
    return this.#opts.retryDelayMs ? Math.max(0, this.#opts.retryDelayMs(attempt)) : fallback;
  }

  async #wait(ms: number, spec: CallSpec): Promise<void> {
    try {
      await sleep(ms, spec.signal);
    } catch {
      throw new MailgunError({
        kind: "network",
        endpoint: spec.endpoint,
        message: `Stopped waiting for Mailgun (${spec.endpoint}): the app is stopping.`,
      });
    }
  }

  /**
   * A request with the retry rules for everything except sends. Returns 2xx and `allow`ed answers. `spec.maxRetries`
   * (default MAX_RETRIES) caps every retry branch: the timeout retry, the 429/5xx retry and the one 404 retry.
   */
  async #call(spec: CallSpec): Promise<CallResult> {
    const key = this.#apiKey;
    const maxRetries = Math.max(0, Math.floor(spec.maxRetries ?? MAX_RETRIES));
    let retries = 0;
    let notFoundRetried = false;
    for (;;) {
      let res: CallResult;
      try {
        res = await this.#once(spec, key, spec.signal);
      } catch (err) {
        // Timeouts are retried; a refused or broken connection is not (a forgotten fake fails fast, and the
        // periodic callers try again later anyway).
        const transient = err instanceof MailgunError && err.kind === "timeout" && err.requestStarted;
        if (transient && spec.idempotent && !spec.signal?.aborted && retries < maxRetries) {
          await this.#wait(this.#delay(retries, BACKOFF_MS[retries] ?? 15_000), spec);
          retries++;
          continue;
        }
        throw err;
      }
      if (res.status >= 200 && res.status < 300) return res;
      if (spec.allow?.includes(res.status)) return res;
      const err = this.#statusError(res, spec, key);
      if (
        res.status === 404 &&
        spec.retryNotFound &&
        maxRetries > 0 &&
        !notFoundRetried &&
        (!err.mailgunMessage || /domain/i.test(err.mailgunMessage))
      ) {
        notFoundRetried = true;
        await this.#wait(this.#delay(retries, NOT_FOUND_RETRY_MS), spec);
        continue;
      }
      const retryable = res.status === 429 || (res.status >= 500 && spec.idempotent);
      if (retryable && retries < maxRetries && !spec.signal?.aborted) {
        const fallback =
          res.status === 429
            ? Math.min(err.retryAfterMs ?? MAX_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS)
            : (BACKOFF_MS[retries] ?? 15_000);
        await this.#wait(this.#delay(retries, fallback), spec);
        retries++;
        continue;
      }
      throw err;
    }
  }

  // ───────────── sending ─────────────

  /**
   * POST /v3/{domain}/messages. The test-list guard runs first (no request when it refuses), then the sender check
   * (SHARED-FROM-DESIGN §2.4, fail closed): the From on `domain` (any Reply-To, as before), or on its main domain with
   * one bare Reply-To on `domain`; anything else → MailgunError kind "sender", no request. In own-mailbox mode (the
   * client's `ownMailboxFrom` option, MAIN-DOMAIN-DESIGN O6) only that From, on `domain`, with no Reply-To. Never
   * retried; only its own timeout can abort it. 200 with a readable id → the result. A 4xx → a classified, never
   * ambiguous error (a 400/403 whose text says the plan's sending limit is reached is kind "limit", O24). A timeout,
   * network error, 5xx, 3xx or a 2xx without a readable id → an ambiguous error (Mailgun may have it).
   */
  async sendMessage(domain: string, msg: SendMessageInput, opts: { apiKey?: string } = {}): Promise<SendMessageResult> {
    checkSendGuard(msg);
    const senderProblem = senderHeaderProblem(domain, msg.from, msg.replyTo, { ownMailboxFrom: this.#opts.ownMailboxFrom });
    if (senderProblem) {
      throw new MailgunError({
        kind: "sender",
        requestStarted: false,
        endpoint: `POST /v3/${domain}/messages`,
        message: `Stopped by the sender check: ${senderProblem}`,
        mailgunMessage: "",
      });
    }
    const endpoint = `POST /v3/${domain}/messages`;
    const bad = (message: string) =>
      new MailgunError({ kind: "unexpected", requestStarted: false, endpoint, message });
    const messageId = bareMessageId(msg.messageId ?? "");
    if (!messageId || /[\s<>]/.test(messageId) || !messageId.includes("@")) {
      throw bad("The email has no valid Message-ID, so it wasn't sent.");
    }
    if (msg.tags.length > 3) throw bad("Mailgun allows at most 3 tags per email.");
    const key = (opts.apiKey ?? this.#apiKey).trim();
    assertKeyMatchesTarget(key, this.baseUrl);

    const form = new FormData();
    form.append("from", msg.from);
    form.append("to", msg.to);
    form.append("subject", msg.subject);
    form.append("text", msg.text);
    form.append("html", msg.html);
    const options: Array<[string, string]> = [["h:Message-Id", `<${messageId}>`]];
    const ids = (v: string | null | undefined) =>
      (v ?? "")
        .split(/\s+/)
        .map(bareMessageId)
        .filter(Boolean)
        .map((id) => `<${id}>`)
        .join(" ");
    if (ids(msg.inReplyTo)) options.push(["h:In-Reply-To", ids(msg.inReplyTo)]);
    if (ids(msg.references)) options.push(["h:References", ids(msg.references)]);
    if (msg.replyTo) options.push(["h:Reply-To", msg.replyTo]);
    // Own-mailbox mode with unsubscribe by email left out (review REPLIES-03): the app's own List-Unsubscribe, so Mailgun
    // adds none with its mailto:. Campaign emails, "Send me a test" and the reply test all pass here, so the reply test's
    // pasted original proves what every email carries. App mode never asks.
    if (this.#opts.ownMailboxFrom) {
      let leaveOut: boolean;
      try {
        leaveOut = await (this.#opts.leaveOutMailto ?? defaultLeaveOutMailto)();
      } catch {
        throw bad("The app couldn't read how emails offer unsubscribing, so the email wasn't sent. Try again in a moment.");
      }
      if (leaveOut) options.push(["h:List-Unsubscribe", WEB_ONLY_LIST_UNSUBSCRIBE]);
    }
    options.push(["o:tracking-opens", "no"], ["o:tracking-clicks", "no"]);
    for (const tag of msg.tags) options.push(["o:tag", tag]);
    for (const [name, value] of Object.entries(msg.variables)) options.push([`v:${name}`, value]);
    if (msg.testMode) options.push(["o:testmode", "yes"]);
    const optionBytes = options.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (optionBytes > SEND_OPTIONS_MAX_BYTES) throw bad("An email's extra fields are too large for Mailgun.");
    for (const [k, v] of options) form.append(k, v);

    const spec: CallSpec = {
      method: "POST",
      path: `/v3/${enc(domain)}/messages`,
      body: { kind: "form", data: form },
      endpoint,
      idempotent: false,
      send: true,
    };
    // No outside signal on purpose: only the 30 s timeout may end this request.
    const res = await this.#once(spec, key);
    if (res.status >= 200 && res.status < 300) {
      const body = obj(res.json);
      const id = typeof body.id === "string" ? bareMessageId(body.id) : "";
      if (!id) {
        throw new MailgunError({
          kind: "unexpected",
          status: res.status,
          body: res.text,
          endpoint,
          secrets: secretsFor(key),
          message: `Mailgun answered ${res.status} to ${endpoint} without a readable id.`,
        });
      }
      return { id, message: typeof body.message === "string" ? body.message : "" };
    }
    if (res.status < 400 && res.status >= 300) {
      throw new MailgunError({
        kind: "unexpected",
        status: res.status,
        body: res.text,
        endpoint,
        secrets: secretsFor(key),
        message: `Mailgun answered ${endpoint} with ${res.status}, which the app never follows.`,
      });
    }
    throw this.#statusError(res, spec, key);
  }

  // ───────────── logs ─────────────

  async #logsUseDuration(): Promise<boolean> {
    if (this.#useDuration !== null) return this.#useDuration;
    const store = this.#opts.logsForm ?? defaultLogsForm(this.#now);
    this.#useDuration = await store.get();
    return this.#useDuration;
  }

  async #learnDuration(): Promise<void> {
    this.#useDuration = true;
    const store = this.#opts.logsForm ?? defaultLogsForm(this.#now);
    await store.set(true);
  }

  async #postLogs(q: LogsQuery, token: string | null, useDuration: boolean, signal?: AbortSignal) {
    const body: Record<string, unknown> = {};
    if (useDuration) {
      const hours = Math.max(1, Math.ceil((q.end.getTime() - q.start.getTime()) / 3_600_000));
      body.end = rfc2822(q.end);
      body.duration = `${hours}h`;
    } else {
      body.start = rfc2822(q.start);
      body.end = rfc2822(q.end);
    }
    body.events = q.events;
    if (q.filters.length) {
      body.filter = {
        AND: q.filters.map((f) => ({
          attribute: f.attribute,
          comparator: f.comparator,
          values: [{ label: f.value, value: f.value }],
        })),
      };
    }
    const limit = Math.min(LOGS_PAGE_LIMIT, Math.max(1, Math.floor(q.limit ?? LOGS_PAGE_LIMIT)));
    body.pagination = { sort: `timestamp:${q.sort ?? "asc"}`, limit, ...(token ? { token } : {}) };
    const res = await this.#call({
      method: "POST",
      path: "/v1/analytics/logs",
      body: { kind: "json", data: body },
      endpoint: "POST /v1/analytics/logs",
      idempotent: true,
      signal,
    });
    const json = obj(res.json);
    const next = obj(json.pagination).next;
    return {
      items: Array.isArray(json.items) ? (json.items as unknown[]) : [],
      next: typeof next === "string" && next ? next : null,
    };
  }

  async #queryLogs(q: LogsQuery, token: string | null, signal?: AbortSignal) {
    const useDuration = await this.#logsUseDuration();
    try {
      return await this.#postLogs(q, token, useDuration, signal);
    } catch (err) {
      // research §2.4: `duration` is marked required; if Mailgun insists, switch once and remember it.
      if (!useDuration && err instanceof MailgunError && err.status === 400 && /duration/i.test(err.mailgunMessage)) {
        await this.#learnDuration();
        return this.#postLogs(q, token, true, signal);
      }
      throw err;
    }
  }

  /** One page of POST /v1/analytics/logs. Pass the previous page's `next` as `token` with the identical query. */
  queryLogs(q: LogsQuery, token?: string | null): Promise<{ items: unknown[]; next: string | null }> {
    return this.#queryLogs(q, token ?? null);
  }

  /**
   * Walks every page (research §2.3): stops on an empty page, a missing `next`, a `next` equal to the token just sent
   * (all three complete), the page guard or an abort (both incomplete). `onPage` runs once per non-empty page.
   */
  async walkLogs(
    q: LogsQuery,
    onPage: (items: unknown[]) => Promise<void>,
    opts: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<LogsWalk> {
    const maxPages = Math.max(1, Math.floor(opts.maxPages ?? PAGE_GUARD));
    let token: string | null = null;
    let pages = 0;
    let items = 0;
    for (;;) {
      if (opts.signal?.aborted) return { complete: false, pages, items, stoppedBecause: "aborted" };
      if (pages >= maxPages) return { complete: false, pages, items, stoppedBecause: "page-guard" };
      let page: { items: unknown[]; next: string | null };
      try {
        page = await this.#queryLogs(q, token, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) return { complete: false, pages, items, stoppedBecause: "aborted" };
        throw err;
      }
      pages++;
      if (page.items.length === 0) return { complete: true, pages, items, stoppedBecause: "empty" };
      await onPage(page.items);
      items += page.items.length;
      if (!page.next) return { complete: true, pages, items, stoppedBecause: "no-next" };
      if (page.next === token) return { complete: true, pages, items, stoppedBecause: "same-token" };
      token = page.next;
    }
  }

  // ───────────── suppressions ─────────────

  /**
   * Pages through one suppression list (research §3.1): `limit=1000`, follow `paging.next` until a page is empty.
   * `next` must stay on the base URL's origin (else a MailgunError, nothing sent there) and never repeat the URL just
   * fetched; at most 1,000 pages. Complete only when an empty page (or a missing `next`) ended the walk.
   */
  async walkSuppressions(
    domain: string,
    list: SuppressionList,
    onPage: (items: SuppressionItem[]) => Promise<void>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ complete: boolean; pages: number; items: number }> {
    const endpoint = `GET /v3/${domain}/${list}`;
    const origin = new URL(this.baseUrl).origin;
    let url = `${this.baseUrl}/v3/${enc(domain)}/${list}?limit=${SUPPRESSION_PAGE_LIMIT}`;
    let pages = 0;
    let items = 0;
    for (;;) {
      if (opts.signal?.aborted || pages >= PAGE_GUARD) return { complete: false, pages, items };
      let res: CallResult;
      try {
        res = await this.#call({ method: "GET", url, endpoint, idempotent: true, retryNotFound: pages === 0, signal: opts.signal });
      } catch (err) {
        if (opts.signal?.aborted) return { complete: false, pages, items };
        throw err;
      }
      pages++;
      const json = obj(res.json);
      const page = (Array.isArray(json.items) ? json.items : [])
        .map(parseSuppressionItem)
        .filter((x): x is SuppressionItem => x !== null);
      if (!Array.isArray(json.items) || json.items.length === 0) return { complete: true, pages, items };
      await onPage(page);
      items += page.length;
      const next = obj(json.paging).next;
      if (typeof next !== "string" || !next) return { complete: true, pages, items };
      let nextOrigin: string;
      try {
        nextOrigin = new URL(next).origin;
      } catch {
        nextOrigin = "";
      }
      if (nextOrigin !== origin) {
        throw new MailgunError({
          kind: "unexpected",
          requestStarted: false,
          endpoint,
          message: `Mailgun's next-page link for ${list} points to another host (${nextOrigin || "unreadable"}); the app stopped paging so the key never leaves Mailgun.`,
        });
      }
      if (next === url) return { complete: true, pages, items };
      url = next;
    }
  }

  /** POST /v3/{domain}/unsubscribes as JSON, `tags ["*"]`, in batches of at most 999. */
  async addUnsubscribes(domain: string, entries: Array<{ address: string; createdAt?: Date }>): Promise<{ added: number }> {
    let added = 0;
    for (let i = 0; i < entries.length; i += UNSUBSCRIBE_BATCH) {
      const batch = entries.slice(i, i + UNSUBSCRIBE_BATCH).map((e) => ({
        address: e.address,
        tags: ["*"],
        ...(e.createdAt ? { created_at: rfc2822(e.createdAt) } : {}),
      }));
      await this.#call({
        method: "POST",
        path: `/v3/${enc(domain)}/unsubscribes`,
        body: { kind: "json", data: batch },
        endpoint: `POST /v3/${domain}/unsubscribes`,
        idempotent: true,
      });
      added += batch.length;
    }
    return { added };
  }

  /**
   * A 404 on a per-address suppression call means "not on that list" ("Address not found in bounces table"), unless
   * Mailgun says the domain itself is unknown: that must never read as "not suppressed".
   */
  #addressNotFound(res: CallResult, spec: CallSpec): boolean {
    if (res.status !== 404) return false;
    if (/domain not found/i.test(errorText(res.text))) throw this.#statusError(res, spec, this.#apiKey);
    return true;
  }

  /** GET /v3/{domain}/{list}/{address}: the entry, or null when the address isn't on that list (404). */
  async getSuppression(domain: string, list: SuppressionList, address: string): Promise<SuppressionItem | null> {
    const spec: CallSpec = {
      method: "GET",
      path: `/v3/${enc(domain)}/${list}/${enc(address)}`,
      endpoint: `GET /v3/${domain}/${list}/:address`,
      idempotent: true,
      allow: [404],
    };
    const res = await this.#call(spec);
    if (this.#addressNotFound(res, spec)) return null;
    return parseSuppressionItem(res.json) ?? { address: address.toLowerCase(), createdAt: null, code: null, error: null, tags: [] };
  }

  /** DELETE /v3/{domain}/{list}/{address}. */
  async deleteSuppression(domain: string, list: SuppressionList, address: string): Promise<"deleted" | "not-found"> {
    const spec: CallSpec = {
      method: "DELETE",
      path: `/v3/${enc(domain)}/${list}/${enc(address)}`,
      endpoint: `DELETE /v3/${domain}/${list}/:address`,
      idempotent: true,
      allow: [404],
    };
    const res = await this.#call(spec);
    return this.#addressNotFound(res, spec) ? "not-found" : "deleted";
  }

  // ───────────── domain, tracking, queues, certificate ─────────────

  /** GET /v4/domains/{domain}. */
  async getDomain(domain: string): Promise<DomainInfo> {
    const res = await this.#call({
      method: "GET",
      path: `/v4/domains/${enc(domain)}`,
      endpoint: `GET /v4/domains/${domain}`,
      idempotent: true,
      retryNotFound: true,
    });
    return parseDomainInfo(res.json, domain);
  }

  /** PUT /v4/domains/{domain}/verify (Mailgun re-checks the DNS records). */
  async verifyDomain(domain: string): Promise<DomainInfo> {
    const res = await this.#call({
      method: "PUT",
      path: `/v4/domains/${enc(domain)}/verify`,
      endpoint: `PUT /v4/domains/${domain}/verify`,
      idempotent: true,
      retryNotFound: true,
    });
    return parseDomainInfo(res.json, domain);
  }

  /** PUT /v4/domains/{domain} with exactly one field, so an error names that field. */
  async updateDomain(
    domain: string,
    field: {
      web_scheme?: "http" | "https";
      spam_action?: "disabled" | "tag" | "block";
      message_ttl?: number;
      webhooks_redact_pii?: boolean;
    },
  ): Promise<DomainInfo> {
    const endpoint = `PUT /v4/domains/${domain}`;
    const set = Object.entries(field).filter(([, v]) => v !== undefined);
    if (set.length !== 1) {
      throw new MailgunError({
        kind: "unexpected",
        requestStarted: false,
        endpoint,
        message: "updateDomain changes exactly one field per call.",
      });
    }
    const [name, value] = set[0]!;
    const form = new FormData();
    form.append(name, typeof value === "number" ? String(Math.floor(value)) : String(value));
    const res = await this.#call({
      method: "PUT",
      path: `/v4/domains/${enc(domain)}`,
      body: { kind: "form", data: form },
      endpoint,
      idempotent: true,
      retryNotFound: true,
    });
    return parseDomainInfo(res.json, domain);
  }

  /** GET /v3/domains/{domain}/tracking. */
  async getTracking(domain: string): Promise<TrackingSettings> {
    const res = await this.#call({
      method: "GET",
      path: `/v3/domains/${enc(domain)}/tracking`,
      endpoint: `GET /v3/domains/${domain}/tracking`,
      idempotent: true,
      retryNotFound: true,
    });
    const t = obj(obj(res.json).tracking);
    const open = obj(t.open);
    const click = obj(t.click);
    const unsub = obj(t.unsubscribe);
    return {
      openActive: isNotOff(open.active),
      clickActive: isNotOff(click.active),
      unsubscribeActive: isOn(unsub.active),
      htmlFooter: typeof unsub.html_footer === "string" ? unsub.html_footer : "",
      textFooter: typeof unsub.text_footer === "string" ? unsub.text_footer : "",
      webScheme: t.web_scheme === "http" || t.web_scheme === "https" ? t.web_scheme : null,
    };
  }

  async #putTracking(domain: string, which: "open" | "click" | "unsubscribe", fields: Array<[string, string]>) {
    const form = new FormData();
    for (const [k, v] of fields) form.append(k, v);
    await this.#call({
      method: "PUT",
      path: `/v3/domains/${enc(domain)}/tracking/${which}`,
      body: { kind: "form", data: form },
      endpoint: `PUT /v3/domains/${domain}/tracking/${which}`,
      idempotent: true,
      retryNotFound: true,
    });
  }

  /** PUT /v3/domains/{domain}/tracking/open. */
  async setOpenTracking(domain: string, active: boolean): Promise<void> {
    await this.#putTracking(domain, "open", [["active", String(active)]]);
  }

  /** PUT /v3/domains/{domain}/tracking/click. */
  async setClickTracking(domain: string, active: boolean): Promise<void> {
    await this.#putTracking(domain, "click", [["active", String(active)]]);
  }

  /** PUT /v3/domains/{domain}/tracking/unsubscribe; both footers are always sent, "" included. */
  async setUnsubscribeTracking(domain: string, active: boolean, footers: { html: string; text: string }): Promise<void> {
    await this.#putTracking(domain, "unsubscribe", [
      ["active", String(active)],
      ["html_footer", footers.html],
      ["text_footer", footers.text],
    ]);
  }

  /** GET /v3/domains/{domain}/sending_queues. */
  async getSendingQueues(domain: string): Promise<SendingQueues> {
    const res = await this.#call({
      method: "GET",
      path: `/v3/domains/${enc(domain)}/sending_queues`,
      endpoint: `GET /v3/domains/${domain}/sending_queues`,
      idempotent: true,
      retryNotFound: true,
    });
    const json = obj(res.json);
    const regular = obj(json.regular);
    const disabled = obj(regular.disabled);
    const until = typeof disabled.until === "string" ? Date.parse(disabled.until) : NaN;
    return {
      regularDisabled: regular.is_disabled === true,
      reason: typeof disabled.reason === "string" ? disabled.reason : null,
      until: Number.isNaN(until) ? null : new Date(until),
      scheduledDisabled: obj(json.scheduled).is_disabled === true,
    };
  }

  /** POST /v2/x509/{host}: 202 → "started", 409 → "already" (both: go and poll). */
  async startCertificate(host: string): Promise<"started" | "already"> {
    const res = await this.#call({
      method: "POST",
      path: `/v2/x509/${enc(host)}`,
      endpoint: `POST /v2/x509/${host}`,
      idempotent: true,
      allow: [409],
    });
    return res.status === 409 ? "already" : "started";
  }

  /** GET /v2/x509/{host}/status; 404 (never started) → "none". */
  async getCertificateStatus(host: string): Promise<CertificateStatus> {
    const res = await this.#call({
      method: "GET",
      path: `/v2/x509/${enc(host)}/status`,
      endpoint: `GET /v2/x509/${host}/status`,
      idempotent: true,
      allow: [404],
    });
    if (res.status === 404) return { status: "none", error: null };
    const json = obj(res.json);
    const s = json.status;
    const error = typeof json.error === "string" && json.error ? json.error : null;
    if (s === "processing" || s === "active" || s === "expired" || s === "error") return { status: s, error };
    return { status: "error", error: error ?? `Mailgun reported an unknown certificate status (${String(s)}).` };
  }

  /** PUT /v2/x509/{host}: 202 → "started", 429 → "in-progress" (not a rate limit here), 409 → "still-valid". */
  async regenerateCertificate(host: string): Promise<"started" | "in-progress" | "still-valid"> {
    const res = await this.#call({
      method: "PUT",
      path: `/v2/x509/${enc(host)}`,
      endpoint: `PUT /v2/x509/${host}`,
      idempotent: true,
      allow: [409, 429],
    });
    if (res.status === 429) return "in-progress";
    if (res.status === 409) return "still-valid";
    return "started";
  }

  // ───────────── webhooks (v3 GET, v4 POST/PUT/DELETE) ─────────────

  /** GET /v3/domains/{domain}/webhooks (there is no v4 GET). */
  async getWebhooks(domain: string): Promise<WebhookMap> {
    const res = await this.#call({
      method: "GET",
      path: `/v3/domains/${enc(domain)}/webhooks`,
      endpoint: `GET /v3/domains/${domain}/webhooks`,
      idempotent: true,
      retryNotFound: true,
    });
    return parseWebhookMap(res.json);
  }

  #webhookForm(url: string, types: WebhookType[]): URLSearchParams {
    const form = new URLSearchParams();
    form.append("url", url);
    for (const t of types) form.append("event_types", t);
    return form;
  }

  /** POST /v4/domains/{domain}/webhooks: one URL for several types. 400 "already exists" → use updateWebhook. */
  async createWebhook(domain: string, url: string, types: WebhookType[]): Promise<WebhookMap> {
    const res = await this.#call({
      method: "POST",
      path: `/v4/domains/${enc(domain)}/webhooks`,
      body: { kind: "urlencoded", data: this.#webhookForm(url, types) },
      endpoint: `POST /v4/domains/${domain}/webhooks`,
      idempotent: false,
      retryNotFound: true,
    });
    return parseWebhookMap(res.json);
  }

  /** PUT /v4/domains/{domain}/webhooks: replaces that URL's types. 404 "Webhook not found" → use createWebhook. */
  async updateWebhook(domain: string, url: string, types: WebhookType[]): Promise<WebhookMap> {
    const res = await this.#call({
      method: "PUT",
      path: `/v4/domains/${enc(domain)}/webhooks`,
      body: { kind: "urlencoded", data: this.#webhookForm(url, types) },
      endpoint: `PUT /v4/domains/${domain}/webhooks`,
      idempotent: true,
      retryNotFound: true,
    });
    return parseWebhookMap(res.json);
  }

  /** DELETE /v4/domains/{domain}/webhooks?url=…: removes the URL from every type. */
  async deleteWebhook(domain: string, url: string): Promise<WebhookMap> {
    const res = await this.#call({
      method: "DELETE",
      path: `/v4/domains/${enc(domain)}/webhooks`,
      query: [["url", url]],
      endpoint: `DELETE /v4/domains/${domain}/webhooks`,
      idempotent: true,
      retryNotFound: true,
    });
    return parseWebhookMap(res.json);
  }

  // ───────────── account ─────────────

  /** GET /v5/accounts/http_signing_key. Never POST: that regenerates the key and breaks every webhook in flight. */
  async getSigningKey(): Promise<string> {
    const endpoint = "GET /v5/accounts/http_signing_key";
    const res = await this.#call({ method: "GET", path: "/v5/accounts/http_signing_key", endpoint, idempotent: true });
    const key = obj(res.json).http_signing_key;
    if (typeof key !== "string" || !key.trim()) {
      throw new MailgunError({ kind: "unexpected", status: res.status, endpoint, message: "Mailgun's answer had no signing key." });
    }
    return key.trim();
  }

  /** GET /v5/accounts/limit/custom/monthly; 404 ("No threshold for account") → null. */
  async getMonthlyLimit(): Promise<{ limit: number; current: number; period: string } | null> {
    const res = await this.#call({
      method: "GET",
      path: "/v5/accounts/limit/custom/monthly",
      endpoint: "GET /v5/accounts/limit/custom/monthly",
      idempotent: true,
      allow: [404],
    });
    if (res.status === 404) return null;
    const json = obj(res.json);
    const limit = Number(json.limit);
    const current = Number(json.current);
    return {
      limit: Number.isFinite(limit) ? limit : 0,
      current: Number.isFinite(current) ? current : 0,
      period: typeof json.period === "string" ? json.period : "",
    };
  }

  // ───────────── address checks (account-wide, M5-DESIGN §2.2) ─────────────

  /**
   * GET /v4/address/validate?address=…&provider_lookup=true (research verification-reference §1). Exactly one request:
   * no retry on a timeout, a 5xx or a 429 (a check may be billed on every attempt; the check job owns every retry), and
   * no outside signal (only the client's own timeout ends it). Returns the parsed JSON body of a 2xx (null when it
   * isn't JSON) for `fromMailgun`. Failures are MailgunErrors whose endpoint label never contains the address; a 429's
   * `retryAfterMs` is Mailgun's hint or null. The v3 and public validation endpoints are never called.
   */
  async validateAddress(address: string): Promise<unknown> {
    const spec: CallSpec = {
      method: "GET",
      path: "/v4/address/validate",
      query: [
        ["address", address],
        ["provider_lookup", "true"],
      ],
      endpoint: "GET /v4/address/validate",
      idempotent: true,
      maxRetries: 0,
      // Handed back instead of thrown, so the error carries Mailgun's own hint only (see #statusError).
      allow: [429],
    };
    const res = await this.#call(spec);
    if (res.status === 429) throw this.#statusError(res, spec, this.#apiKey, { hintOnly: true });
    return res.json;
  }

  // ───────────── routes (account-wide) ─────────────

  /** Every route: GET /v3/routes with skip/limit=100 until a page is empty or `total_count` is reached. */
  async listRoutes(): Promise<MailgunRoute[]> {
    const out: MailgunRoute[] = [];
    let skip = 0;
    for (let page = 0; page < PAGE_GUARD; page++) {
      const res = await this.#call({
        method: "GET",
        path: "/v3/routes",
        query: [
          ["skip", String(skip)],
          ["limit", String(ROUTES_PAGE_LIMIT)],
        ],
        endpoint: "GET /v3/routes",
        idempotent: true,
      });
      const json = obj(res.json);
      const items = Array.isArray(json.items) ? json.items : [];
      if (items.length === 0) break;
      for (const item of items) {
        const r = parseRoute(item);
        if (r) out.push(r);
      }
      skip += items.length;
      const total = Number(json.total_count);
      if (Number.isFinite(total) && skip >= total) break;
    }
    return out;
  }

  /** POST /v3/routes (never repeated after an unclear answer, so no duplicate route is made). */
  async createRoute(r: RouteInput): Promise<MailgunRoute> {
    const endpoint = "POST /v3/routes";
    const res = await this.#call({
      method: "POST",
      path: "/v3/routes",
      body: { kind: "urlencoded", data: routeForm(r) },
      endpoint,
      idempotent: false,
    });
    return routeFrom(res.json, endpoint);
  }

  /** PUT /v3/routes/{id} with every field; the answer is `{route}` or a bare route. */
  async updateRoute(id: string, r: RouteInput): Promise<MailgunRoute> {
    const endpoint = `PUT /v3/routes/${id}`;
    const res = await this.#call({
      method: "PUT",
      path: `/v3/routes/${enc(id)}`,
      body: { kind: "urlencoded", data: routeForm(r) },
      endpoint,
      idempotent: true,
    });
    return routeFrom(res.json, endpoint);
  }

  /** DELETE /v3/routes/{id}. */
  async deleteRoute(id: string): Promise<"deleted" | "not-found"> {
    const res = await this.#call({
      method: "DELETE",
      path: `/v3/routes/${enc(id)}`,
      endpoint: `DELETE /v3/routes/${id}`,
      idempotent: true,
      allow: [404],
    });
    return res.status === 404 ? "not-found" : "deleted";
  }

  /** GET /v3/routes/match?address=…: the one route Mailgun would use, or null (404). */
  async matchRoute(address: string): Promise<MailgunRoute | null> {
    const endpoint = "GET /v3/routes/match";
    const res = await this.#call({
      method: "GET",
      path: "/v3/routes/match",
      query: [["address", address]],
      endpoint,
      idempotent: true,
      allow: [404],
    });
    if (res.status === 404) return null;
    return routeFrom(res.json, endpoint);
  }

  // ───────────── stored messages ─────────────

  /**
   * GET a stored email by the exact URL Mailgun gave (`message-url` / `storage.url`). Refuses any URL outside Mailgun's
   * hosts (or the fake server's origin in fake mode) without sending anything. A 404 (expired) throws "not-found".
   */
  async getStoredMessage(url: string): Promise<unknown> {
    const endpoint = "GET <storage>/messages/:key";
    if (!isAllowedStorageUrl(url, this.baseUrl)) {
      throw new MailgunError({
        kind: "unexpected",
        requestStarted: false,
        endpoint,
        message: "The app only fetches stored emails from Mailgun's own servers.",
      });
    }
    const res = await this.#call({ method: "GET", url, endpoint, idempotent: true });
    return res.json;
  }
}

/**
 * Default for `leaveOutMailto`: Setting "mailgun.unsubscribeTest"'s `leaveOutMailto` (loaded lazily, so importing the
 * client opens no database). Read fresh for every send: the Owner's choice applies to the very next email.
 */
async function defaultLeaveOutMailto(): Promise<boolean> {
  const { getSetting } = await import("../settings");
  return parseUnsubscribeTest(await getSetting("mailgun.unsubscribeTest")).leaveOutMailto === true;
}

/** Default Logs-form memory: SystemState "mailgun.logsForm" (loaded lazily, so importing the client opens no database). */
function defaultLogsForm(now: () => Date): { get(): Promise<boolean>; set(useDuration: boolean): Promise<void> } {
  return {
    async get() {
      const { readTyped } = await import("../state-typed");
      return (await readTyped(STATE_KEYS.logsForm, parseLogsFormState)).value.useDuration;
    },
    async set(useDuration: boolean) {
      const { updateTyped } = await import("../state-typed");
      await updateTyped(STATE_KEYS.logsForm, parseLogsFormState, (cur) =>
        cur.useDuration === useDuration ? null : { ...cur, useDuration, learnedAt: now().toISOString() },
      );
    },
  };
}
