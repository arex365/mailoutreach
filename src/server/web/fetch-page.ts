/**
 * Fetching one page for the website reader (docs/dev/M5-DESIGN.md §3.4.4) and its robots.txt (§3.4.5): manual
 * redirects (≤ 5 hops per page, every hop through the URL rules, robots and politeness), status rules, the content-type
 * check, a 2 MB streaming cap on the decoded body, at most MAX_REQUESTS_PER_COMPANY requests per company, one retry for
 * 429/5xx/network errors, and never a retry (nor an http fallback, nor a robots retry) for a blocked address.
 */
import type { ReadableStream } from "node:stream/web";
import { MIMEType } from "node:util";
import { MAX_URL_CHARS } from "@/core/ai/site-rules";
import { MAX_REQUESTS_PER_COMPANY, WEB_USER_AGENT, type SkipCode } from "@/core/ai/types";
import { MIN_HOST_GAP_MS, hostGapMs } from "./politeness";
import {
  ROBOTS_BODY_CAP,
  ROBOTS_MAX_REDIRECTS,
  ROBOTS_TIMEOUT_MS,
  isFreshRobots,
  robotsRulesFor,
  robotsVerdict,
  type RobotsRules,
  type RobotsVerdict,
} from "./robots";
import { TEST_SOCKET_GUARD_CODE, errorCodes, isBlockedAddressError } from "./ssrf";
import type { HeaderGetter, Politeness, RobotsEntry, RobotsStore, Transport, TransportResponse } from "./types";
import { checkHopUrl } from "./url-rules";

/** Decoded bytes kept per page (undici decompresses, so this also guards against compression bombs). */
export const PAGE_BYTE_CAP = 2 * 1024 * 1024;
/** Network time allowed for one page with its redirect hops (politeness waits don't count). */
export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
/** Wait before the one retry of a 429, 5xx or network error when the site gives no Retry-After. */
export const RETRY_DELAY_MS = 10_000;
/** The longest Retry-After honoured. */
export const RETRY_AFTER_MAX_MS = 60_000;

export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": WEB_USER_AGENT,
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  "accept-language": "en;q=1.0, de;q=0.8, nb;q=0.7, no;q=0.7, *;q=0.3",
};
const ROBOTS_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": WEB_USER_AGENT,
  accept: "text/plain,*/*;q=0.5",
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const HTML_SNIFF = /<!doctype html|<html[\s>]/i;

/** Thrown when a company's request budget is spent (the reader keeps what it has). */
export class RequestCapReached extends Error {
  constructor() {
    super(`The reader made ${MAX_REQUESTS_PER_COMPANY} requests for this company, the most it makes.`);
    this.name = "RequestCapReached";
  }
}

/** Counts every HTTP request for one company: robots, pages, redirect hops, retries and the http fallback. */
export class RequestBudget {
  used = 0;
  constructor(readonly max: number = MAX_REQUESTS_PER_COMPANY) {}
  /** Throws when no request is left (checked before waiting for a host). */
  ensure(): void {
    if (this.used >= this.max) throw new RequestCapReached();
  }
  take(): void {
    this.ensure();
    this.used += 1;
  }
}

/** Everything one company's read shares. */
export type Session = {
  transport: Transport;
  /** A test transport's loopback origin (let through the port and IP rules), else null. */
  allowOrigin: string | null;
  budget: RequestBudget;
  politeness: Politeness;
  robotsStore: RobotsStore;
  /** robots.txt rules loaded during this read, per origin (the picker asks them without fetching). */
  robots: Map<string, RobotsRules>;
  /** Why robots.txt couldn't be fetched in this read, per origin (only a connection failure allows the http fallback). */
  robotsFailures: Map<string, NetFailure>;
  /** The job's signal: aborting it stops the read. */
  signal: AbortSignal;
  now: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pageTimeoutMs: number;
  retryDelayMs: number;
};

/** Why a request failed, from the error's `.cause` chain and the signals. */
export type NetFailure = "blocked" | "aborted" | "timeout" | "dns" | "guard" | "connect" | "network";

const DNS_CODES = new Set([
  "ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "EAI_AGAIN", "EAI_NONAME", "ENONAME", "EBADNAME",
  "EBADRESP", "EFORMERR", "ECANCELLED",
]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPROTO", "UND_ERR_CONNECT_TIMEOUT",
]);
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_)|SELF_SIGNED|HOSTNAME_MISMATCH/;

export function classifyNetError(err: unknown, attempt: AbortSignal | null, job: AbortSignal): NetFailure {
  if (isBlockedAddressError(err)) return "blocked";
  if (job.aborted) return "aborted";
  if (attempt?.aborted) return "timeout";
  const codes = errorCodes(err);
  if (codes.includes(TEST_SOCKET_GUARD_CODE)) return "guard";
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return "timeout";
  if (codes.some((c) => DNS_CODES.has(c))) return "dns";
  if (codes.some((c) => CONNECT_CODES.has(c) || TLS_CODE.test(c))) return "connect";
  return "network";
}

function firstCode(err: unknown): string {
  return errorCodes(err)[0] ?? (err instanceof Error ? err.name : "error");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The read was stopped"), { name: "AbortError" });
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    /* already closed */
  }
}

/** Streams at most `cap` bytes; the rest is cancelled (the partial body is kept and marked truncated). */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - n;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        n = cap;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a pending read after cancel: nothing to release */
    }
  }
  return { bytes: Buffer.concat(chunks, n), truncated };
}

/** Retry-After in milliseconds (seconds or an HTTP date), capped at 60 s; null when missing or unreadable. */
export function retryAfterMs(value: string | null, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(RETRY_AFTER_MAX_MS, Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - now.getTime()));
}

/**
 * One request in flight. `startedAt` (performance.now()) is when it was sent, after the politeness wait: timeouts
 * count network time from there, never the wait for the host.
 */
type Attempt = { res: TransportResponse; signal: AbortSignal; release: () => void; startedAt: number };

class SendFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly attempt: AbortSignal | null,
    /** When the request was sent (after the politeness wait). */
    readonly startedAt: number,
  ) {
    super("request failed");
  }
}

/** Waits for the host, takes one request from the budget and sends it; the caller reads or cancels the body, then releases. */
async function send(s: Session, url: URL, headers: Readonly<Record<string, string>>, gapMs: number, timeoutMs: number): Promise<Attempt> {
  s.budget.ensure();
  const release = await s.politeness.acquire(url.hostname, { signal: s.signal, minGapMs: gapMs });
  const startedAt = performance.now();
  let signal: AbortSignal | null = null;
  try {
    s.budget.take();
    signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))), s.signal]);
    const res = await s.transport.get(url, { signal, headers: { ...headers } });
    return { res, signal, release, startedAt };
  } catch (err) {
    release();
    if (err instanceof RequestCapReached) throw err;
    throw new SendFailure(err, signal, startedAt);
  }
}

function resolveLocation(location: string | null, base: URL): URL | null {
  if (!location) return null;
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}

// ───────────────────────── robots.txt ─────────────────────────

/**
 * A robots.txt answer, or "blocked" when a hop pointed at a private address (never cached, never retried). A network
 * failure is status 0; its kind is kept in `s.robotsFailures` for the http fallback decision.
 */
async function fetchRobots(s: Session, origin: string): Promise<Omit<RobotsEntry, "fetchedAt"> | "blocked"> {
  let url = new URL("/robots.txt", `${origin}/`);
  const seen = new Set([url.href]);
  let remaining = ROBOTS_TIMEOUT_MS;
  let lastStatus = 0;
  for (let hop = 0; ; hop++) {
    const bad = checkHopUrl(url, { allowOrigin: s.allowOrigin });
    if (bad) return bad.skip === "private_address" ? "blocked" : { status: lastStatus || 404, body: "" };
    if (remaining <= 0) {
      s.robotsFailures.set(origin, "timeout");
      return { status: 0, body: "" };
    }
    let attempt: Attempt;
    try {
      attempt = await send(s, url, ROBOTS_HEADERS, MIN_HOST_GAP_MS, remaining);
    } catch (err) {
      if (!(err instanceof SendFailure)) throw err;
      const kind = classifyNetError(err.error, err.attempt, s.signal);
      if (kind === "blocked") return "blocked";
      if (kind === "aborted") throw abortReason(s.signal);
      s.robotsFailures.set(origin, hop === 0 ? kind : "network");
      return { status: 0, body: "" };
    }
    try {
      const { res } = attempt;
      lastStatus = res.status;
      if (REDIRECT_STATUSES.has(res.status)) {
        await cancelBody(res.body);
        const next = resolveLocation(res.headers.get("location"), url);
        // More than 5 redirects, a loop or no target: "unavailable", so everything may be read (RFC 9309).
        if (!next || seen.has(next.href) || hop + 1 > ROBOTS_MAX_REDIRECTS) return { status: res.status, body: "" };
        seen.add(next.href);
        url = next;
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        const { bytes } = await readCapped(res.body, ROBOTS_BODY_CAP);
        return { status: res.status, body: new TextDecoder("utf-8").decode(bytes) };
      }
      await cancelBody(res.body);
      return { status: res.status, body: "" };
    } catch (err) {
      const kind = classifyNetError(err, attempt.signal, s.signal);
      if (kind === "aborted") throw abortReason(s.signal);
      s.robotsFailures.set(origin, kind);
      return { status: 0, body: "" };
    } finally {
      attempt.release();
      remaining -= performance.now() - attempt.startedAt;
    }
  }
}

/** The robots verdict for `url`, reading its origin's robots.txt when this read hasn't yet (cache first). */
export async function robotsFor(s: Session, url: URL): Promise<RobotsVerdict | { kind: "blocked" }> {
  const origin = url.origin;
  let rules = s.robots.get(origin);
  if (!rules) {
    const cached = await s.robotsStore.get(origin);
    let entry: RobotsEntry | null = cached && isFreshRobots(cached, s.now()) ? cached : null;
    if (!entry) {
      const fetched = await fetchRobots(s, origin);
      if (fetched === "blocked") return { kind: "blocked" };
      entry = { ...fetched, fetchedAt: s.now() };
      await s.robotsStore.put(origin, entry);
    }
    rules = robotsRulesFor(origin, entry);
    s.robots.set(origin, rules);
  }
  return robotsVerdict(rules, url);
}

/** From the rules already loaded in this read only (never fetching): the picker's `isAllowed`. */
export function cachedRobotsAllows(s: Session, url: string): boolean | undefined {
  // The URL rules refuse longer addresses anyway; robots matching costs grow with the path's length.
  if (url.length > MAX_URL_CHARS) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const rules = s.robots.get(u.origin);
  if (!rules) return undefined;
  const v = robotsVerdict(rules, u);
  return v.kind === "allowed";
}

// ───────────────────────── pages ─────────────────────────

export type FetchedPage = {
  finalUrl: URL;
  status: number;
  headers: HeaderGetter;
  /** The raw Content-Type header. */
  contentType: string | null;
  charset: string | null;
  body: Buffer;
  truncated: boolean;
};

export type FetchSkip = {
  skip: SkipCode;
  detail: string | null;
  /** A connection or TLS failure on the https:// start URL: the reader tries http:// once. */
  fallback: boolean;
};

/** Redirect state of one page: every URL seen and the hops so far (redirects and meta refreshes count). */
export type HopChain = { seen: Set<string>; hops: number };

function skip(code: SkipCode, detail: string | null, fallback = false): { ok: false } & FetchSkip {
  return { ok: false, skip: code, detail, fallback };
}

const TOO_SLOW = "The website took too long to answer.";
const TOO_COMPLEX_ROBOTS = "The website's robots.txt is too long or complicated to follow, so the website was left alone.";

function statusText(status: number): string {
  return `The website answered HTTP ${status}.`;
}

function parseContentType(raw: string | null): { essence: string | null; charset: string | null } {
  if (!raw) return { essence: null, charset: null };
  try {
    const m = new MIMEType(raw);
    return { essence: m.essence, charset: m.params.get("charset") ?? null };
  } catch {
    return { essence: null, charset: null };
  }
}

/** True when X-Robots-Tag carries a `noai` directive (for any bot). */
export function hasNoAiDirective(value: string | null): boolean {
  return Boolean(value && /(^|[\s,:;])noai($|[\s,;])/i.test(value));
}

type PageStep =
  | { kind: "redirect"; next: URL }
  | { kind: "retry"; waitMs: number | null; detail: string }
  | { kind: "skip"; code: SkipCode; detail: string | null }
  | { kind: "page"; page: FetchedPage };

async function handleResponse(res: TransportResponse, url: URL, s: Session): Promise<PageStep> {
  const { status, headers } = res;
  if ((headers.get("cf-mitigated") ?? "").trim().toLowerCase() === "challenge") {
    await cancelBody(res.body);
    return { kind: "skip", code: "blocked", detail: "The website showed a bot challenge." };
  }
  if (REDIRECT_STATUSES.has(status)) {
    await cancelBody(res.body);
    const next = resolveLocation(headers.get("location"), url);
    if (!next) return { kind: "skip", code: "unreachable", detail: "The website sent a redirect without a target." };
    return { kind: "redirect", next };
  }
  if (status === 401 || status === 403 || status === 451) {
    await cancelBody(res.body);
    return { kind: "skip", code: "blocked", detail: statusText(status) };
  }
  if (status === 404 || status === 410) {
    await cancelBody(res.body);
    return { kind: "skip", code: "not_found", detail: statusText(status) };
  }
  if (status === 429 || status >= 500) {
    await cancelBody(res.body);
    return { kind: "retry", waitMs: retryAfterMs(headers.get("retry-after"), s.now()), detail: statusText(status) };
  }
  if (status < 200 || status >= 300) {
    await cancelBody(res.body);
    return { kind: "skip", code: "unreachable", detail: statusText(status) };
  }
  if (hasNoAiDirective(headers.get("x-robots-tag"))) {
    await cancelBody(res.body);
    return { kind: "skip", code: "robots_disallowed", detail: "The page is marked noai (X-Robots-Tag)." };
  }
  const contentType = headers.get("content-type");
  const { essence, charset } = parseContentType(contentType);
  if (essence !== null && !HTML_TYPES.has(essence)) {
    await cancelBody(res.body);
    return { kind: "skip", code: "not_html", detail: `The website sent ${essence}, not a web page.` };
  }
  const { bytes, truncated } = await readCapped(res.body, PAGE_BYTE_CAP);
  if (essence === null && !HTML_SNIFF.test(bytes.subarray(0, 512).toString("latin1"))) {
    return { kind: "skip", code: "not_html", detail: "The website didn't send a web page." };
  }
  return { kind: "page", page: { finalUrl: url, status, headers, contentType, charset, body: bytes, truncated } };
}

/**
 * Fetches one page from `start`, following redirects on `chain` (shared with the meta-refresh hops of the same page).
 * Skips come back as results; RequestCapReached and a job abort are thrown. `fallbackEligible`: `start` is the
 * homepage's https:// URL, so a connection or TLS failure there (or robots.txt unreadable over https) asks for the http
 * fallback instead of a retry.
 */
export async function fetchPage(
  s: Session,
  start: URL,
  chain: HopChain,
  opts: { fallbackEligible: boolean },
): Promise<{ ok: true; page: FetchedPage } | ({ ok: false } & FetchSkip)> {
  let url = start;
  let retried = false;
  let remaining = s.pageTimeoutMs;
  for (;;) {
    const atStart = url === start && opts.fallbackEligible && url.protocol === "https:";
    const bad = checkHopUrl(url, { allowOrigin: s.allowOrigin });
    if (bad) return skip(bad.skip, bad.detail);

    const robots = await robotsFor(s, url);
    if (robots.kind === "blocked") {
      return skip("private_address", `The website's robots.txt points to a private network (${url.hostname}).`);
    }
    if (robots.kind === "disallowed") return skip("robots_disallowed", `robots.txt asks ${robots.token} not to read this page.`);
    if (robots.kind === "too-complex") return skip("robots_disallowed", TOO_COMPLEX_ROBOTS);
    if (robots.kind === "unreachable") {
      const detail =
        robots.status === 0
          ? "robots.txt couldn't be read, so the website counts as closed to robots."
          : `robots.txt answered HTTP ${robots.status}, so the website counts as closed to robots.`;
      // A cached network failure (kind unknown in this read) may be a TLS problem too, so it also tries http once.
      const failure = s.robotsFailures.get(url.origin);
      const fallback = atStart && robots.status === 0 && (failure === undefined || failure === "connect");
      return skip("unreachable", detail, fallback);
    }
    if (remaining <= 0) return skip("unreachable", TOO_SLOW);

    let attempt: Attempt;
    try {
      attempt = await send(s, url, PAGE_HEADERS, hostGapMs(robots.crawlDelaySec), remaining);
    } catch (err) {
      if (!(err instanceof SendFailure)) throw err;
      remaining -= performance.now() - err.startedAt;
      const kind = classifyNetError(err.error, err.attempt, s.signal);
      if (kind === "blocked") return skip("private_address", `The website address points to a private network (${url.hostname}).`);
      if (kind === "aborted") throw abortReason(s.signal);
      if (kind === "timeout") return skip("unreachable", TOO_SLOW);
      if (kind === "dns") return skip("unreachable", `The website's address couldn't be found (${firstCode(err.error)}).`);
      if (kind === "guard") return skip("unreachable", "Test runs never connect to anything but their own server.");
      if (kind === "connect" && atStart) {
        return skip("unreachable", `The website couldn't be reached over https (${firstCode(err.error)}).`, true);
      }
      if (retried) return skip("unreachable", `The website couldn't be reached (${firstCode(err.error)}).`);
      retried = true;
      await s.sleep(s.retryDelayMs, s.signal);
      remaining = s.pageTimeoutMs;
      continue;
    }

    let step: PageStep;
    try {
      step = await handleResponse(attempt.res, url, s);
    } catch (err) {
      const kind = classifyNetError(err, attempt.signal, s.signal);
      if (kind === "aborted") throw abortReason(s.signal);
      if (kind === "blocked") return skip("private_address", `The website address points to a private network (${url.hostname}).`);
      step = kind === "timeout" ? { kind: "skip", code: "unreachable", detail: TOO_SLOW } : { kind: "retry", waitMs: null, detail: `The website stopped answering (${firstCode(err)}).` };
    } finally {
      attempt.release();
      remaining -= performance.now() - attempt.startedAt;
    }

    switch (step.kind) {
      case "page":
        return { ok: true, page: step.page };
      case "skip":
        return skip(step.code, step.detail);
      case "redirect": {
        if (chain.seen.has(step.next.href)) return skip("redirect_loop", "The website redirects in a loop.");
        chain.hops += 1;
        if (chain.hops > MAX_REDIRECTS) return skip("too_many_redirects", `The website redirected more than ${MAX_REDIRECTS} times.`);
        chain.seen.add(step.next.href);
        url = step.next;
        retried = false;
        continue;
      }
      case "retry": {
        if (retried) return skip("unreachable", step.detail);
        retried = true;
        await s.sleep(step.waitMs ?? s.retryDelayMs, s.signal);
        remaining = s.pageTimeoutMs;
        continue;
      }
    }
  }
}
