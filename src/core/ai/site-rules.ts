/**
 * Site rules for AI personal lines (docs/dev/M5-DESIGN.md §3.4.8; research ai-and-fetch-reference.md B7): which pages
 * give "no line" without asking Claude, and the injection warning. Pure and browser-safe; the website reader applies
 * them to every page it reads, so a skip never costs a Claude call.
 */
import { getDomain } from "tldts";
import { isSharedDomain } from "@/core/shared-domains";
import type { SkipCode } from "./types";

/** Social, marketplace and link-in-bio hosts that are never a company's own website (added to the shared-domain list). */
export const SOCIAL_HOSTS: ReadonlySet<string> = new Set([
  "instagram.com", "instagr.am", "facebook.com", "fb.com", "fb.me", "tiktok.com", "linkedin.com", "x.com", "twitter.com",
  "linktr.ee", "linkin.bio", "beacons.ai", "etsy.com", "youtube.com", "youtu.be", "pinterest.com", "threads.net",
]);

/**
 * The longest web address the reader requests or follows (about what browsers and search engines accept). Longer ones
 * are refused by the URL rules and never collected as links, which also keeps robots.txt matching bounded.
 */
export const MAX_URL_CHARS = 2_048;

/**
 * Site builders whose `<name>.<builder>` subdomains are a person's or company's own website. They are on the
 * shared-domain list (the bare platform is shared) but, unlike wixsite.com or blogspot.com, not in the public suffix
 * list's private section, so tldts folds anna.wordpress.com into wordpress.com. Marketplaces and social sites with
 * per-account subdomains (tumblr, gumroad, artstation …) stay shared.
 */
export const SITE_BUILDER_DOMAINS: ReadonlySet<string> = new Set([
  "wordpress.com", "weebly.com", "squarespace.com", "bigcartel.com", "storenvy.com",
]);

/** Subdomains that belong to a site builder itself (its own pages, apps, help, language versions). */
const BUILDER_OWN_SUBS: ReadonlySet<string> = new Set([
  "www", "m", "mobile", "app", "apps", "api", "public-api", "help", "support", "blog", "news", "press", "status", "docs",
  "developer", "developers", "login", "account", "accounts", "admin", "dashboard", "static", "cdn", "files", "media",
  "images", "shop", "store", "community", "forum", "forums", "learn", "jobs", "careers", "about", "mail", "wordpress",
  "subscribe", "stats", "widgets", "pixel",
]);

/** Domain-sale and parking hosts (research B7, verbatim): a page there means the company has no site of its own. */
export const DOMAIN_SALE_HOSTS: ReadonlySet<string> = new Set([
  "sedo.com", "dan.com", "afternic.com", "hugedomains.com", "undeveloped.com", "parkingcrew.net", "bodis.com",
  "above.com", "atom.com", "sav.com",
]);

/** GoDaddy is a real business too: only its for-sale pages count as domain sales. */
const GODADDY_FOR_SALE_PATH = /\/(?:forsale|for-sale)(?:\/|$)/i;

/** Research B7, verbatim: a parked or for-sale domain. */
export const PARKED_PATTERN =
  /domain (is|may be) for sale|buy this domain|this domain is parked|parked free|domain parking|diese domain (ist|steht) zum verkauf|domain kaufen|denne (domenen|domene) er til salgs/i;

/**
 * Research B7's words: a placeholder, a server's default page or a suspended account. The words and phrases must stand
 * on their own (no letter or digit right before or after), so "Baustellenfahrzeuge" or "vedlikeholdsfri" in a real
 * shop's text don't count; the default-page patterns keep their form.
 */
export const PLACEHOLDER_PATTERN =
  /(?<![\p{L}\p{N}])(?:coming soon|under construction|launching soon|site is under maintenance|website is under maintenance|in kürze|demnächst|wartungsarbeiten|baustelle|kommer snart|under konstruksjon|vedlikehold|welcome to nginx|iis windows server|account suspended)(?![\p{L}\p{N}])|apache2 .*default page|it works!|index of \//iu;
/** A title that is the placeholder words plus at most this many other words is a placeholder, however long the text. */
export const PLACEHOLDER_TITLE_EXTRA_WORDS = 2;

/** Research C4, verbatim: page text addressed to an AI (a warning on the card, never a skip). */
export const INJECTION_PATTERN = /ignore (all|previous) instructions|you are (an|a) (ai|language model)|chatgpt|claude|system prompt/i;

/** Less readable text than this (characters) makes a page thin or, with app-shell signs, JavaScript-only. */
export const MIN_PAGE_TEXT = 300;
/** Metadata (title, description, og tags, JSON-LD) of at least this many characters can stand in for the page text. */
export const MIN_META_TEXT = 150;
/** External scripts that make a nearly empty page an app shell. */
export const JS_ONLY_SCRIPTS = 5;
/**
 * The placeholder words ("coming soon", "demnächst", "vedlikehold" …) also appear on real shops ("new dragons coming
 * soon"), so the page text and title are only checked while the text is shorter than this; with more text, only a
 * title that is little more than the placeholder words counts ("Coming soon", "Apache2 Ubuntu Default Page: It works").
 */
export const PLACEHOLDER_TEXT_MAX = 1_000;

/** What the site rules look at: a page's cleaned text, its metadata text and a few app-shell signs from the extraction. */
export type SitePage = {
  title: string | null;
  /** The cleaned page text (what Claude would be sent). */
  text: string;
  /** Title + meta description + og tags + JSON-LD names and descriptions. */
  metaText: string;
  /** Target of `<meta http-equiv="refresh">`, when the page has one. */
  refreshUrl?: string | null;
  /** An empty app root (#root, #__next, #__nuxt, #app, [ng-version]). */
  emptyAppRoot?: boolean;
  /** A `<noscript>` asking the reader to enable JavaScript. */
  noscriptAsksForJs?: boolean;
  /** `<script src>` elements. */
  externalScripts?: number;
};

export type PageVerdict = {
  verdict: "ok" | SkipCode;
  /** True when a JavaScript-only page is kept because its metadata says enough: the reader sends `metaText` instead. */
  metadataOnly: boolean;
};

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** A title that is the placeholder words with at most PLACEHOLDER_TITLE_EXTRA_WORDS other words ("Studio Nord – Coming soon"). */
export function isPlaceholderTitle(title: string): boolean {
  const m = PLACEHOLDER_PATTERN.exec(title);
  if (!m) return false;
  const rest = `${title.slice(0, m.index)} ${title.slice(m.index + m[0].length)}`;
  return rest.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length <= PLACEHOLDER_TITLE_EXTRA_WORDS;
}

/**
 * The own website on a site builder: "anna.wordpress.com" (or "www.anna.wordpress.com") → "anna.wordpress.com", else
 * null (another host, the bare platform, one of the platform's own subdomains, a two-letter language subdomain or a
 * deeper host). The reader treats it like anna.wixsite.com: a real site, and its own registrable domain.
 */
export function siteBuilderSite(host: string): string | null {
  const h = bareHost(host).replace(/^www\./, "");
  const dot = h.indexOf(".");
  if (dot <= 0) return null;
  const label = h.slice(0, dot);
  if (!SITE_BUILDER_DOMAINS.has(h.slice(dot + 1))) return null;
  if (BUILDER_OWN_SUBS.has(label) || /^[a-z]{2}(?:-[a-z]{2})?$/.test(label)) return null;
  return h;
}

/**
 * True for a social, marketplace or link-in-bio host (the shared-domain list plus SOCIAL_HOSTS); subdomains included,
 * except a site builder's `<name>.<builder>` sites (siteBuilderSite), which are the company's own website.
 */
export function isSocialHost(host: string): boolean {
  const h = bareHost(host);
  if (!h) return false;
  if (siteBuilderSite(h)) return false;
  const registrable = getDomain(h, { allowPrivateDomains: true }) ?? h;
  return SOCIAL_HOSTS.has(registrable) || isSharedDomain(registrable) || isSharedDomain(h.replace(/^www\./, ""));
}

/** True for a page on a domain-sale host (sedo.com, dan.com, … and GoDaddy's for-sale pages). */
export function isDomainSaleUrl(url: URL | string): boolean {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  const h = bareHost(u.hostname);
  const registrable = getDomain(h, { allowPrivateDomains: true }) ?? h;
  if (DOMAIN_SALE_HOSTS.has(registrable)) return true;
  return registrable === "godaddy.com" && GODADDY_FOR_SALE_PATH.test(u.pathname);
}

/**
 * The site rules in order (§3.4.8): social host → parked → placeholder → JavaScript-only (kept as metadata-only when the
 * metadata has ≥ 150 characters) → thin. `finalUrl` (when known) lets GoDaddy's for-sale pages count as parked.
 */
export function pageVerdict(page: SitePage, opts: { finalHost: string; finalUrl?: string | null }): PageVerdict {
  const result = (verdict: PageVerdict["verdict"], metadataOnly = false): PageVerdict => ({ verdict, metadataOnly });
  if (isSocialHost(opts.finalHost)) return result("social_only");

  const finalSale = opts.finalUrl ? isDomainSaleUrl(opts.finalUrl) : isDomainSaleUrl(`https://${bareHost(opts.finalHost)}/`);
  const refreshSale = page.refreshUrl ? isDomainSaleUrl(page.refreshUrl) : false;
  const title = page.title ?? "";
  if (finalSale || refreshSale || PARKED_PATTERN.test(`${title}\n${page.text}`)) return result("parked");

  const shortText = page.text.length < PLACEHOLDER_TEXT_MAX;
  if ((shortText && (PLACEHOLDER_PATTERN.test(title) || PLACEHOLDER_PATTERN.test(page.text))) || isPlaceholderTitle(title)) {
    return result("placeholder");
  }

  const text = page.text.trim().length;
  const meta = page.metaText.trim().length;
  if (text < MIN_PAGE_TEXT) {
    const appShell = Boolean(page.emptyAppRoot) || Boolean(page.noscriptAsksForJs) || (page.externalScripts ?? 0) >= JS_ONLY_SCRIPTS;
    if (appShell) return meta >= MIN_META_TEXT ? result("ok", true) : result("js_only");
    if (meta < MIN_META_TEXT) return result("thin");
  }
  return result("ok");
}

/**
 * `"ok"` or the skip code for a page (§3.4.8). A JavaScript-only page whose metadata says enough is `"ok"`: the reader
 * then sends its metadata text and notes it `metadata-only` (use `pageVerdict` to see that case).
 */
export function classifyPage(page: SitePage, opts: { finalHost: string; finalUrl?: string | null }): "ok" | SkipCode {
  return pageVerdict(page, opts).verdict;
}

/** True when the text contains words addressed to an AI (a warning for the reviewer only; never a skip). */
export function injectionHint(text: string): boolean {
  return INJECTION_PATTERN.test(text);
}
