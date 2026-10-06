/**
 * The fixture transport (docs/dev/M5-DESIGN.md §7.3): serves saved fixture sites from files instead of the internet, so
 * tests and the lead's manual checks run the reader's real pipeline (URL rules, robots, politeness, caps, charset,
 * extraction, picking, site rules) without any network. Used by `defaultWebsiteReader` when OUTREACH_WEB_FIXTURES is set.
 *
 * Each site is a folder with `site.json`:
 *   {"origin": "https://www.figuren-werkstatt.example",
 *    "pages": {"/": {"status": 200, "contentType": "text/html; charset=utf-8", "file": "index.html"}, "/robots.txt": {…}},
 *    "redirects": {"/alt": "/galerie"},          // or {"to": "…", "status": 302}; absolute targets allowed
 *    "headers": {"x-robots-tag": "…"},           // added to every response of the site
 *    "extraOrigins": {"https://apex.example": {"pages": …, "redirects": …}},   // more origins served by the same site
 *    "fail": "connect" | "tls" | "reset" | "dns"} // every request to the origin fails like that
 * plus its HTML files (raw bytes: a windows-1252 file stays windows-1252) and optionally `claude.json` (the fake Claude's
 * answer for this site). An unknown path answers 404; an unknown origin fails like a host that doesn't exist.
 */
import fs from "node:fs";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import type { Transport, TransportResponse } from "./types";

export type FixturePage = {
  status?: number;
  /** The Content-Type header; null or missing = no header. */
  contentType?: string | null;
  /** A file in the site's folder. */
  file?: string;
  /** Inline content (generated sites in tests). */
  body?: string | Uint8Array;
  headers?: Record<string, string>;
};

export type FixtureRedirect = string | { to: string; status?: number };

export type FixtureFailure = "connect" | "tls" | "reset" | "dns";

export type FixtureOrigin = {
  pages?: Record<string, FixturePage>;
  redirects?: Record<string, FixtureRedirect>;
  headers?: Record<string, string>;
  fail?: FixtureFailure;
};

export type FixtureSite = FixtureOrigin & {
  origin: string;
  extraOrigins?: Record<string, FixtureOrigin>;
  /** The site's folder (files are read from here); set by the loader. */
  dir?: string;
};

export type FixtureCall = { url: string; at: number };

export type FixtureTransport = Transport & {
  /** Every request made, in order (tests assert what was and wasn't fetched). */
  readonly calls: FixtureCall[];
  /** The origins served. */
  origins(): string[];
};

/** Chunk size of fixture bodies, so the reader's streaming cap and cancel are exercised as with a real server. */
const CHUNK = 64 * 1024;

function netError(code: string, message: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

const FAILURES: Record<FixtureFailure, () => Error> = {
  connect: () => netError("ECONNREFUSED", "connect ECONNREFUSED (fixture)"),
  tls: () => netError("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames (fixture)"),
  reset: () => netError("ECONNRESET", "read ECONNRESET (fixture)"),
  dns: () => netError("ENOTFOUND", "getaddrinfo ENOTFOUND (fixture)"),
};

/** Reads every `<dir>/<site>/site.json`; a missing folder serves nothing (every origin is unknown). */
export function loadFixtureSites(dir: string): FixtureSite[] {
  if (!fs.existsSync(dir)) return [];
  const sites: FixtureSite[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const siteDir = path.join(dir, entry.name);
    const file = path.join(siteDir, "site.json");
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FixtureSite;
    if (typeof parsed.origin !== "string") throw new Error(`${file} has no "origin".`);
    sites.push({ ...parsed, dir: siteDir });
  }
  return sites;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + CHUNK);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

type Served = { origin: FixtureOrigin; dir: string | null };

function decodedPath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Serves fixture sites by origin + path. `dir` is the fixtures folder (null = only `opts.sites`); `opts.sites` adds
 * generated sites with inline bodies. `opts.now` stamps `calls` (default Date.now).
 */
export function fixtureTransport(dir: string | null, opts: { sites?: FixtureSite[]; now?: () => number } = {}): FixtureTransport {
  const now = opts.now ?? (() => Date.now());
  const served = new Map<string, Served>();
  const add = (origin: string, o: FixtureOrigin, siteDir: string | null) => {
    served.set(new URL(origin).origin, { origin: o, dir: siteDir });
  };
  for (const site of [...(dir ? loadFixtureSites(dir) : []), ...(opts.sites ?? [])]) {
    add(site.origin, site, site.dir ?? null);
    for (const [origin, extra] of Object.entries(site.extraOrigins ?? {})) add(origin, extra, site.dir ?? null);
  }
  const calls: FixtureCall[] = [];

  const bodyOf = (page: FixturePage, siteDir: string | null): Uint8Array => {
    if (page.body !== undefined) return typeof page.body === "string" ? Buffer.from(page.body, "utf8") : page.body;
    if (page.file && siteDir) return fs.readFileSync(path.join(siteDir, page.file));
    return new Uint8Array(0);
  };

  return {
    testAllowOrigin: null,
    calls,
    origins: () => [...served.keys()],
    async get(url, { signal }): Promise<TransportResponse> {
      if (signal.aborted) throw signal.reason;
      calls.push({ url: url.href, at: now() });
      const site = served.get(url.origin);
      if (!site) throw FAILURES.dns();
      if (site.origin.fail) throw FAILURES[site.origin.fail]();
      const pathname = url.pathname;
      const redirect = site.origin.redirects?.[pathname] ?? site.origin.redirects?.[decodedPath(pathname)];
      const baseHeaders = { ...(site.origin.headers ?? {}) };
      if (redirect !== undefined) {
        const to = typeof redirect === "string" ? redirect : redirect.to;
        const status = typeof redirect === "string" ? 301 : (redirect.status ?? 301);
        return { status, headers: new Headers({ ...baseHeaders, location: to }), body: streamOf(new Uint8Array(0)) };
      }
      const page = site.origin.pages?.[pathname] ?? site.origin.pages?.[decodedPath(pathname)];
      if (!page) {
        return {
          status: 404,
          headers: new Headers({ ...baseHeaders, "content-type": "text/html; charset=utf-8" }),
          body: streamOf(Buffer.from("<!doctype html><title>Not found</title><p>Not found</p>")),
        };
      }
      const headers = new Headers({ ...baseHeaders, ...(page.headers ?? {}) });
      if (page.contentType) headers.set("content-type", page.contentType);
      return { status: page.status ?? 200, headers, body: streamOf(bodyOf(page, site.dir)) };
    },
  };
}
