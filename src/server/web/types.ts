/**
 * The website reader's shapes (docs/dev/M5-DESIGN.md §3.4.1). The reader runs in the worker only: web code never imports
 * src/server/web (a unit test greps for it). Page text is untrusted data: it is never logged, never rendered as HTML and
 * never followed except through the page picker (§0.2 rule 6).
 */
import type { ReadableStream } from "node:stream/web";
import type { SkipCode } from "@/core/ai/types";

export type { SkipCode };

/** Notes a page can carry (kept on its snapshot so a reused snapshot gives the same flags). */
export type PageNote = "metadata-only" | "hidden-text";
/** Notes on a whole read. */
export type ReadNote = "metadata-only" | "second-page-failed" | "http-fallback" | "hidden-text";

export type ReadPage = {
  kind: "homepage" | "second_page";
  /** The URL this page was requested at (for the homepage: the website, or its http:// form after the fallback). */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  /** Decoded bytes read (at most 2 MB). */
  bytes: number;
  truncated: boolean;
  title: string | null;
  lang: string | null;
  /** Exactly what Claude will be sent: the extracted, cleaned text (≤ PAGE_TEXT_CAP characters, within the token cap);
   *  for a metadata-only page, its metaText (the reader swaps it in after classifyPage). */
  text: string;
  /** Title + meta description + og tags + JSON-LD names/descriptions: only classifyPage reads it; never sent, never stored. */
  metaText: string;
  notes: PageNote[];
};

export type ReadResult =
  | { ok: true; pages: ReadPage[]; notes: ReadNote[]; injectionHint: boolean; requests: number }
  | { ok: false; skip: SkipCode; detail: string | null; pages: ReadPage[]; requests: number };

export interface WebsiteReader {
  /** Never throws: any unexpected error becomes `{ok: false, skip: "unreachable"}` for this company only. */
  read(input: { website: string; companyName: string }, opts: { signal: AbortSignal; now: Date }): Promise<ReadResult>;
}

/** What a transport needs from response headers (undici's and the global Headers both fit). */
export type HeaderGetter = { get(name: string): string | null };

export type TransportResponse = {
  status: number;
  headers: HeaderGetter;
  /** The (decompressed) body; the caller always reads or cancels it. */
  body: ReadableStream<Uint8Array> | null;
};

/**
 * One GET without following redirects (the reader follows them itself, checking every hop). Network failures reject
 * (undici's "fetch failed" with the real error in `.cause`; EBLOCKEDADDRESS anywhere in the chain = a private address).
 */
export interface Transport {
  get(url: URL, opts: { signal: AbortSignal; headers: Record<string, string> }): Promise<TransportResponse>;
  /**
   * The one loopback origin a test transport may reach (`createRealTransport({testAllowOrigin})`): the URL rules let
   * exactly this origin through the port and IP checks. Null or missing for every other transport.
   */
  readonly testAllowOrigin?: string | null;
}

/** A robots.txt answer as cached per origin (`RobotsCache` row: `host` holds the origin). */
export type RobotsEntry = {
  /** HTTP status; 0 = network error or timeout. */
  status: number;
  /** The text (≤ 500 KiB); "" when there was none. */
  body: string;
  fetchedAt: Date;
};

/** Where robots.txt answers are cached: the database in the worker, a Map in unit tests. */
export interface RobotsStore {
  get(origin: string): Promise<RobotsEntry | null>;
  put(origin: string, entry: RobotsEntry): Promise<void>;
}

/** Per-host politeness (in memory, per worker process): one request at a time per host, with a gap between them. */
export interface Politeness {
  /**
   * Waits until `host` is free and at least `minGapMs` have passed since its previous request ended, then holds the host
   * until the returned `release` is called (after the response body was read or cancelled). Rejects when `signal` aborts.
   */
  acquire(host: string, opts: { signal: AbortSignal; minGapMs: number }): Promise<() => void>;
}
