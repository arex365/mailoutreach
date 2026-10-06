/**
 * The website reader (docs/dev/M5-DESIGN.md §3.4): reads a company's homepage and at most one more page, SSRF-safe and
 * polite, and hands back exactly the text Claude will be sent. One pipeline for every transport (undici or fixture
 * files), so fixture tests exercise the real logic. It never throws: an unexpected error becomes `unreachable` for this
 * company only. Page text is untrusted: it is never logged (the watchdog logs the host only).
 */
import { setTimeout as delay } from "node:timers/promises";
import { pickSecondPage } from "@/core/ai/picker";
import { injectionHint, pageVerdict } from "@/core/ai/site-rules";
import { TOTAL_TOKEN_CAP, estimateTextTokens, type SkipCode } from "@/core/ai/types";
import { extractPage, type ExtractedPage } from "./extract";
import {
  MAX_REDIRECTS,
  PAGE_TIMEOUT_MS,
  RETRY_DELAY_MS,
  RequestBudget,
  RequestCapReached,
  cachedRobotsAllows,
  fetchPage,
  type FetchedPage,
  type HopChain,
  type Session,
} from "./fetch-page";
import { createPoliteness } from "./politeness";
import { dbRobotsStore } from "./robots";
import type { Politeness, ReadNote, ReadPage, ReadResult, RobotsStore, Transport, WebsiteReader } from "./types";
import { checkHopUrl, parseStartUrl } from "./url-rules";

/**
 * A second page is dropped (note `second-page-failed`) when it isn't the company's content at all; a short gallery or
 * product list ("thin" for a homepage) still adds facts, so it is kept when it has any text.
 */
const SECOND_PAGE_DROPS: ReadonlySet<SkipCode> = new Set(["social_only", "parked", "placeholder", "js_only"]);

/** A crawl-delay above this (seconds) reads the homepage only. */
export const HOMEPAGE_ONLY_CRAWL_DELAY_SEC = 10;
/**
 * Extraction (or picking the second page) slower than this is logged (host only), so we see whether a separate thread
 * is ever needed (§1.5). Both run on the worker's thread and are linear and capped.
 */
export const EXTRACTION_WATCHDOG_MS = 2_000;

export type ReaderDeps = {
  transport: Transport;
  /** Default: the database (`RobotsCache`). */
  robotsStore?: RobotsStore;
  /** Default: a politeness of this reader's own with the real (or `now`) clock. */
  politeness?: Politeness;
  /** Clock for robots.txt freshness and the default politeness; default: the read's `now`. */
  now?: () => Date;
  /** Network time per page with its redirect hops (default 15 s; tests use less). */
  pageTimeoutMs?: number;
  /** Wait before the one retry when the site gives no Retry-After (default 10 s). */
  retryDelayMs?: number;
  /** How waits for retries happen (tests pass one that doesn't wait). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The watchdog's log line (default: console.warn). Never gets page text. */
  log?: (message: string) => void;
  /** Extraction or picking slower than this is logged (default EXTRACTION_WATCHDOG_MS). */
  watchdogMs?: number;
};

type PageRead = { page: ReadPage; extracted: ExtractedPage; fetched: FetchedPage };
type PageFailure = { skip: SkipCode; detail: string | null; fallback: boolean };

/** Details of a read that failed as a whole: our own sentences, never page text or an error message. */
const STOPPED = "Reading was stopped before it finished.";
const FAILED = "Something went wrong while reading the website.";

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/**
 * Cuts the pages' texts so that `estimateTextTokens` of all of them together stays within TOTAL_TOKEN_CAP (§3.3): each
 * page may keep half the budget, and a page that needs less leaves the rest to the other. Cuts fall on a line break or
 * a space when one is near.
 */
export function capPagesToTokens(texts: readonly string[], cap = TOTAL_TOKEN_CAP): string[] {
  const tokens = texts.map(estimateTextTokens);
  if (tokens.reduce((a, b) => a + b, 0) <= cap) return [...texts];
  const budgets: number[] = [];
  if (texts.length === 1) budgets.push(cap);
  else {
    const half = Math.floor(cap / texts.length);
    const spare = tokens.reduce((sum, t) => sum + Math.max(0, half - t), 0);
    let bonus = spare;
    for (const t of tokens) {
      const need = Math.max(0, t - half);
      const extra = Math.min(need, bonus);
      bonus -= extra;
      budgets.push(Math.min(t, half + extra));
    }
  }
  return texts.map((text, i) => cutToTokens(text, budgets[i]!));
}

/** The longest prefix of `text` whose token estimate is within `budget` (binary search; the estimate grows with length). */
export function cutToTokens(text: string, budget: number): string {
  if (estimateTextTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return (boundary > lo * 0.8 ? cut.slice(0, boundary) : cut).trimEnd();
}

/** Builds a reader around a transport (the real one in the worker, fixture files in tests). */
export function createReader(deps: ReaderDeps): WebsiteReader {
  const robotsStore = deps.robotsStore ?? dbRobotsStore();
  const politeness = deps.politeness ?? createPoliteness(deps.now ? { now: () => deps.now!().getTime() } : {});
  const log = deps.log ?? ((m: string) => console.warn(`[web] ${m}`));
  const sleep = deps.sleep ?? defaultSleep;
  const watchdogMs = deps.watchdogMs ?? EXTRACTION_WATCHDOG_MS;

  /** Fetches, extracts and follows a short meta refresh (one more hop on the same chain). */
  async function readPage(
    s: Session,
    start: URL,
    kind: ReadPage["kind"],
    opts: { fallbackEligible: boolean },
  ): Promise<{ ok: true; read: PageRead } | ({ ok: false } & PageFailure)> {
    const chain: HopChain = { seen: new Set([start.href]), hops: 0 };
    let url = start;
    let fallbackEligible = opts.fallbackEligible;
    for (;;) {
      const fetched = await fetchPage(s, url, chain, { fallbackEligible });
      if (!fetched.ok) return fetched;
      fallbackEligible = false;
      const page = fetched.page;
      const t0 = performance.now();
      const extracted = extractPage(page.body, {
        finalUrl: page.finalUrl.href,
        charset: page.charset,
        contentLanguage: page.headers.get("content-language"),
      });
      const ms = performance.now() - t0;
      if (ms > watchdogMs) log(`Reading ${page.finalUrl.hostname} took ${(ms / 1000).toFixed(1)} s to extract`);
      if (extracted.noai) return { ok: false, skip: "robots_disallowed", detail: "The page is marked noai.", fallback: false };

      const refresh = extracted.refresh;
      if (refresh?.url && refresh.delaySec <= 5) {
        const next = new URL(refresh.url);
        next.hash = "";
        const here = new URL(page.finalUrl.href);
        here.hash = "";
        if (next.href !== here.href) {
          if (chain.seen.has(next.href)) return { ok: false, skip: "redirect_loop", detail: "The website redirects in a loop.", fallback: false };
          chain.hops += 1;
          if (chain.hops > MAX_REDIRECTS) {
            return { ok: false, skip: "too_many_redirects", detail: `The website redirected more than ${MAX_REDIRECTS} times.`, fallback: false };
          }
          chain.seen.add(next.href);
          url = next;
          continue;
        }
      }
      const read: ReadPage = {
        kind,
        url: start.href,
        finalUrl: page.finalUrl.href,
        httpStatus: page.status,
        contentType: page.contentType,
        bytes: page.body.length,
        truncated: page.truncated || extracted.depthCut,
        title: extracted.title,
        lang: extracted.lang,
        text: extracted.text,
        metaText: extracted.metaText,
        notes: [...extracted.notes],
      };
      return { ok: true, read: { page: read, extracted, fetched: page } };
    }
  }

  /** Applies the site rules; a metadata-only page gets its metadata as text. Null = keep, else the skip code. */
  function applySiteRules(r: PageRead): SkipCode | null {
    const { verdict, metadataOnly } = pageVerdict(
      {
        title: r.page.title,
        text: r.page.text,
        metaText: r.page.metaText,
        refreshUrl: r.extracted.refresh?.url ?? null,
        emptyAppRoot: r.extracted.emptyAppRoot,
        noscriptAsksForJs: r.extracted.noscriptAsksForJs,
        externalScripts: r.extracted.externalScripts,
      },
      { finalHost: r.fetched.finalUrl.hostname, finalUrl: r.fetched.finalUrl.href },
    );
    if (verdict !== "ok") return verdict;
    if (metadataOnly) {
      r.page.text = r.page.metaText;
      if (!r.page.notes.includes("metadata-only")) r.page.notes.push("metadata-only");
    }
    return null;
  }

  async function run(input: { website: string; companyName: string }, s: Session): Promise<ReadResult> {
    const fail = (skip: SkipCode, detail: string | null, pages: ReadPage[] = []): ReadResult => ({
      ok: false,
      skip,
      detail,
      pages,
      requests: s.budget.used,
    });
    const start = parseStartUrl(input.website, { allowOrigin: s.allowOrigin });
    if (!start.ok) return fail(start.skip, start.detail);

    const notes = new Set<ReadNote>();
    let home: Awaited<ReturnType<typeof readPage>>;
    try {
      home = await readPage(s, start.url, "homepage", { fallbackEligible: start.url.protocol === "https:" });
      if (!home.ok && home.fallback) {
        const http = new URL(start.url.href);
        http.protocol = "http:";
        notes.add("http-fallback");
        home = await readPage(s, http, "homepage", { fallbackEligible: false });
      }
    } catch (err) {
      if (err instanceof RequestCapReached) return fail("unreachable", err.message);
      throw err;
    }
    if (!home.ok) return fail(home.skip, home.detail);
    const homeRead = home.read;
    const homeSkip = applySiteRules(homeRead);
    if (homeSkip) return fail(homeSkip, null, [homeRead.page]);

    const pages: ReadPage[] = [homeRead.page];
    const homeRules = s.robots.get(homeRead.fetched.finalUrl.origin);
    const crawlDelay = homeRules?.kind === "rules" ? homeRules.crawlDelaySec : null;
    if (crawlDelay === null || crawlDelay <= HOMEPAGE_ONLY_CRAWL_DELAY_SEC) {
      const t0 = performance.now();
      const pick = pickSecondPage({
        homepage: homeRead.fetched.finalUrl,
        homepageLang: homeRead.page.lang,
        links: homeRead.extracted.links,
        isAllowed: (url) => cachedRobotsAllows(s, url),
        isFetchable: (url) => checkHopUrl(url, { allowOrigin: s.allowOrigin }) === null,
      });
      const ms = performance.now() - t0;
      if (ms > watchdogMs) log(`Picking a second page of ${homeRead.fetched.finalUrl.hostname} took ${(ms / 1000).toFixed(1)} s`);
      if (pick) {
        try {
          const second = await readPage(s, new URL(pick.url), "second_page", { fallbackEligible: false });
          const verdict = second.ok ? applySiteRules(second.read) : null;
          if (!second.ok || (verdict !== null && SECOND_PAGE_DROPS.has(verdict)) || !second.read.page.text.trim()) {
            notes.add("second-page-failed");
          } else if (second.read.page.finalUrl !== homeRead.page.finalUrl) {
            pages.push(second.read.page);
          }
        } catch (err) {
          if (!(err instanceof RequestCapReached)) throw err;
          notes.add("second-page-failed");
        }
      }
    }

    const capped = capPagesToTokens(pages.map((p) => p.text));
    pages.forEach((p, i) => {
      p.text = capped[i]!;
      if (p.notes.includes("metadata-only")) p.metaText = p.text;
    });
    for (const p of pages) {
      if (p.notes.includes("metadata-only")) notes.add("metadata-only");
      if (p.notes.includes("hidden-text")) notes.add("hidden-text");
    }
    const hint = pages.some((p) => injectionHint(`${p.title ?? ""}\n${p.text}`));
    const order: ReadNote[] = ["metadata-only", "second-page-failed", "http-fallback", "hidden-text"];
    return { ok: true, pages, notes: order.filter((n) => notes.has(n)), injectionHint: hint, requests: s.budget.used };
  }

  return {
    async read(input, opts) {
      const s: Session = {
        transport: deps.transport,
        allowOrigin: deps.transport.testAllowOrigin ?? null,
        budget: new RequestBudget(),
        politeness,
        robotsStore,
        robots: new Map(),
        robotsFailures: new Map(),
        signal: opts.signal,
        now: deps.now ?? (() => opts.now),
        sleep,
        pageTimeoutMs: deps.pageTimeoutMs ?? PAGE_TIMEOUT_MS,
        retryDelayMs: deps.retryDelayMs ?? RETRY_DELAY_MS,
      };
      try {
        return await run(input, s);
      } catch {
        return {
          ok: false,
          skip: "unreachable",
          detail: opts.signal.aborted ? STOPPED : FAILED,
          pages: [],
          requests: s.budget.used,
        };
      }
    },
  };
}
