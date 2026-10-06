/**
 * Picking the one extra page the website reader reads after the homepage (docs/dev/M5-DESIGN.md §3.4.7; research
 * ai-and-fetch-reference.md B7). Pure and browser-safe: it scores the homepage's links and never fetches anything.
 *
 * Bounded, because the links come from an untrusted page and this runs on the worker's thread: links longer than
 * PICKER_MAX_URL_CHARS or deeper than PICKER_MAX_SEGMENTS path segments are dropped before any work, keywords are
 * looked up per token run (linear in a link's length), and robots.txt is asked about PICKER_MAX_ROBOTS_CHECKS
 * candidates at most.
 */
import { getDomain } from "tldts";
import { MAX_URL_CHARS, siteBuilderSite } from "./site-rules";

/** A link found on the homepage: `href` is absolute (resolved against the page's final URL). */
export type PickerLink = { href: string; text: string; inNav: boolean };

/** Links longer than this (without query and fragment) are never a second page ("/about", "/galerie" are short). */
export const PICKER_MAX_URL_CHARS = 300;
/** Links with more path segments than this are never a second page. */
export const PICKER_MAX_SEGMENTS = 8;
/** robots.txt is asked about this many of the best candidates at most; if it refuses them all, the homepage is enough. */
export const PICKER_MAX_ROBOTS_CHECKS = 10;

export type PickSecondPageInput = {
  /** The homepage's final URL (after redirects). */
  homepage: URL;
  /** The homepage's language ("de", "nb", "en") or null. */
  homepageLang: string | null;
  links: readonly PickerLink[];
  /**
   * The cached robots.txt rules for a URL: false passes the link over for the next one; undefined (robots.txt for that
   * origin not read yet) counts as allowed, and the reader checks robots before fetching.
   */
  isAllowed?: (url: string) => boolean | undefined;
  /**
   * The reader's URL rules for a candidate (true = it may be requested). A refused link is passed over for the next
   * one, so the pick is always a page the reader can fetch. Without it, only the picker's own rules apply.
   */
  isFetchable?: (url: URL) => boolean;
};

export type PickedPage = { url: string; score: number };

/**
 * Research B7 score table: portfolio 5, products 4, about 3, services 2 (path segments or anchor words), plus the
 * Norwegian "portefølje" the planning research names (anthropic-ai.md, gotchas).
 */
const SCORE_WORDS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [5, ["portfolio", "gallery", "galerie", "galleri", "work", "works", "projects", "projekte", "prosjekter", "referenzen",
    "referanser", "showcase", "creations", "arbeiten", "werke", "portefølje"]],
  [4, ["products", "produkte", "produkter", "shop", "store", "butikk", "nettbutikk", "collections", "collection",
    "kollektion", "kolleksjon", "catalog", "catalogue", "katalog", "sortiment", "figures", "figuren", "figurer",
    "miniatures", "miniaturen", "miniatyrer"]],
  [3, ["about", "about-us", "aboutus", "who-we-are", "our-story", "studio", "company", "team", "ueber-uns", "uber-uns",
    "über uns", "wir-ueber-uns", "unternehmen", "firma", "geschichte", "om-oss", "om oss", "hvem-er-vi", "bedriften",
    "historie"]],
  [2, ["services", "leistungen", "dienstleistungen", "angebot", "tjenester", "what-we-do", "was-wir-tun", "hva-vi-gjor"]],
];

/** Research B7: links that never describe the company's work (legal, cart, account, contact, search, feeds …). */
const EXCLUDED_WORDS = [
  "login", "account", "konto", "cart", "warenkorb", "kasse", "checkout", "handlekurv", "handlevogn", "impressum",
  "datenschutz", "privacy", "personvern", "agb", "terms", "vilkar", "vilkår", "cookie", "kontakt", "contact", "jobs",
  "karriere", "faq", "hilfe", "hjelp", "versand", "shipping", "frakt", "retur", "returns", "widerruf", "search", "suche",
  "sok", "sitemap", "feed", "tag", "wp-admin", "wp-login", "cdn-cgi",
];

/** File links are never pages (research B7 lists .pdf .jpg .png .zip .mp4; the rest are the same kind). */
const FILE_EXTENSION =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico|zip|rar|7z|gz|tar|mp4|mov|avi|webm|mkv|mp3|wav|ogg|docx?|xlsx?|pptx?|stl|obj|3mf|fbx|blend)$/i;
/** Page extensions stripped before matching a path segment ("ueber-uns.html" → "ueber-uns"). */
const PAGE_EXTENSION = /\.(html?|shtml|php|aspx?|jsp)$/i;
const LANGUAGE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/;

/**
 * Canonical form for keyword matching: percent-decoded, NFKD without diacritics, lowercase, ø → o, æ → ae, ß → ss, and
 * the digraph spellings ue/oe/ae/aa folded like ü/ö/ä/å ("über-uns", "%C3%BCber-uns" and "ueber-uns" all match).
 */
export function canonicalWord(s: string): string {
  let t = s;
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep the raw text */
  }
  return t
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/ue/g, "u")
    .replace(/oe/g, "o")
    .replace(/ae/g, "a")
    .replace(/aa/g, "a");
}

/** The canonical tokens of a text ("Über uns" → ["uber", "uns"]). */
function wordTokens(s: string): string[] {
  return canonicalWord(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A keyword as a canonical, hyphen-joined token phrase ("über uns" → "uber-uns"). */
function phrase(s: string): string {
  return wordTokens(s).join("-");
}

/** Each keyword phrase with its score (the highest, should a phrase be listed twice). */
const PHRASE_SCORES: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [score, words] of SCORE_WORDS) {
    for (const w of words) {
      const p = phrase(w);
      m.set(p, Math.max(score, m.get(p) ?? 0));
    }
  }
  return m;
})();
const EXCLUDED_PHRASES: ReadonlySet<string> = new Set(EXCLUDED_WORDS.map(phrase));
const ALL_PHRASES: readonly string[] = [...PHRASE_SCORES.keys(), ...EXCLUDED_PHRASES];
/** The most tokens in one keyword phrase ("wir-uber-uns"): the longest token run worth looking up. */
const MAX_PHRASE_TOKENS = Math.max(...ALL_PHRASES.map((p) => p.split("-").length));
/** First tokens of the phrases with several tokens: only a run starting with one of these can be longer than one. */
const PHRASE_STARTS: ReadonlySet<string> = new Set(ALL_PHRASES.filter((p) => p.includes("-")).map((p) => p.split("-")[0]!));

/**
 * The best keyword score in `haystacks` (each a token list: one path segment, or the anchor text), or null when an
 * excluded word is there. A phrase matches a whole-token run inside one haystack; every run of up to MAX_PHRASE_TOKENS
 * tokens is looked up once, so the work is linear in the number of tokens.
 */
function keywordScore(haystacks: readonly string[][]): number | null {
  let best = 0;
  for (const toks of haystacks) {
    for (let i = 0; i < toks.length; i++) {
      let run = toks[i]!;
      for (let n = 1; ; n++) {
        if (EXCLUDED_PHRASES.has(run)) return null;
        best = Math.max(best, PHRASE_SCORES.get(run) ?? 0);
        if (n >= MAX_PHRASE_TOKENS || i + n >= toks.length || !PHRASE_STARTS.has(toks[i]!)) break;
        run = `${run}-${toks[i + n]!}`;
      }
    }
  }
  return best;
}

/** The registrable domain; a site builder's `<name>.<builder>` site (like anna.wixsite.com) is its own. */
function registrable(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  return siteBuilderSite(h) ?? getDomain(h, { allowPrivateDomains: true }) ?? h;
}

function languageOf(segment: string | undefined): string | null {
  if (!segment || !LANGUAGE_SEGMENT.test(segment)) return null;
  const base = segment.slice(0, 2);
  return base === "no" || base === "nn" ? "nb" : base;
}

type Candidate = { url: string; path: string; score: number; index: number };

function pathOf(u: URL): string {
  return u.pathname.replace(/\/+$/, "") || "/";
}

function scoreLink(link: PickerLink, homepage: URL, homeLang: string | null): Omit<Candidate, "index"> | null {
  if (link.href.length > MAX_URL_CHARS) return null;
  let u: URL;
  try {
    u = new URL(link.href, homepage);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  // The URL rules only allow the default ports (a test server's own port is the homepage's).
  if (u.port !== homepage.port) return null;
  if (registrable(u.hostname) !== registrable(homepage.hostname)) return null;
  u.hash = "";
  u.search = "";
  if (u.href.length > PICKER_MAX_URL_CHARS) return null;
  const path = pathOf(u);
  if (path === "/" || (path === pathOf(homepage) && u.hostname === homepage.hostname)) return null;
  if (FILE_EXTENSION.test(u.pathname)) return null;

  const rawSegments = u.pathname.split("/").filter(Boolean);
  if (rawSegments.length > PICKER_MAX_SEGMENTS) return null;
  const segments = rawSegments.map((s) => wordTokens(s.replace(PAGE_EXTENSION, "")));
  const anchor = wordTokens(link.text.slice(0, 200));
  const base = keywordScore([...segments, anchor]);
  if (!base) return null;

  const lang = languageOf(segments[0]?.join("-"));
  const depth = segments.length - (lang ? 1 : 0);
  let score = base;
  if (link.inNav) score += 1;
  if (depth === 1) score += 1;
  if (lang === null || lang === "en" || (homeLang !== null && lang === homeLang)) score += 0.5;
  return { url: u.href, path: u.pathname, score };
}

/**
 * The homepage's best link to read as the second page, or null (homepage only). Scores by the research B7 table with
 * bonuses (+1 in nav/header, +1 path depth 1, +0.5 same language or an /en/ variant); keeps http(s) links on the
 * homepage's registrable domain and port (hosted subdomains such as anna.wixsite.com or anna.wordpress.com stay
 * distinct), without fragments or queries; drops excluded words, file links, overlong or deep links and links the
 * reader's URL rules refuse. Ties go to the shorter path, then to the first link on the page. robots.txt is asked about
 * the best PICKER_MAX_ROBOTS_CHECKS candidates at most.
 */
export function pickSecondPage(input: PickSecondPageInput): PickedPage | null {
  const byUrl = new Map<string, Candidate>();
  input.links.forEach((link, index) => {
    const scored = scoreLink(link, input.homepage, input.homepageLang);
    if (!scored) return;
    const seen = byUrl.get(scored.url);
    if (!seen) byUrl.set(scored.url, { ...scored, index });
    else if (scored.score > seen.score) seen.score = scored.score;
  });
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.index - b.index);
  let robotsChecks = 0;
  for (const c of ranked) {
    if (input.isFetchable && !input.isFetchable(new URL(c.url))) continue;
    if (input.isAllowed) {
      if (robotsChecks >= PICKER_MAX_ROBOTS_CHECKS) return null;
      robotsChecks++;
      if (input.isAllowed(c.url) === false) continue;
    }
    return { url: c.url, score: c.score };
  }
  return null;
}
