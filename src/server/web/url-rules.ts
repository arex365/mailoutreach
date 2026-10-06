/**
 * URL rules of the website reader (docs/dev/M5-DESIGN.md §3.4.2): checked for the start URL and before EVERY hop
 * (redirects, meta refresh, the second page, robots.txt), so no request ever goes to a private address, an unusual port,
 * a social or marketplace host or a domain-sale page.
 */
import net from "node:net";
import { MAX_URL_CHARS, isDomainSaleUrl, isSocialHost } from "@/core/ai/site-rules";
import type { SkipCode } from "@/core/ai/types";
import { isPublicIp, stripBrackets } from "./ssrf";

export type UrlSkip = { skip: SkipCode; detail: string };

/** The hostname without brackets and without one trailing dot ("instagram.com." is instagram.com). */
export function comparableHost(url: URL): string {
  return stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, "");
}

/**
 * The rules for one hop, or null when the URL may be requested: at most MAX_URL_CHARS characters (checked first, so no
 * later rule or robots.txt ever works on a longer one), http(s) only, no user name or password, no empty host labels
 * ("a..b"), port 80/443 only, IP literals must be public, and no social, marketplace or domain-sale host (a site
 * builder's `<name>.<builder>` site is the company's own). `allowOrigin` (a test transport's loopback origin) is let
 * through the port and IP rules, and nothing else is.
 */
export function checkHopUrl(url: URL, opts: { allowOrigin?: string | null } = {}): UrlSkip | null {
  if (url.href.length > MAX_URL_CHARS) {
    return { skip: "bad_url", detail: "The website address is too long." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { skip: "bad_url", detail: "Only http and https website addresses can be read." };
  }
  if (url.username || url.password) {
    return { skip: "bad_url", detail: "The website address contains a user name or password." };
  }
  const host = comparableHost(url);
  if (!host || (!host.includes(":") && host.split(".").some((label) => label === ""))) {
    return { skip: "bad_url", detail: "The website address has an empty part in its host name." };
  }
  const allowed = Boolean(opts.allowOrigin) && url.origin === opts.allowOrigin;
  if (!allowed) {
    if (url.port !== "") return { skip: "bad_url", detail: "The website address uses an unusual port." };
    if (net.isIP(host) !== 0 && !isPublicIp(host)) {
      return { skip: "private_address", detail: `The website address points to a private network (${host}).` };
    }
  }
  if (isSocialHost(host)) {
    return { skip: "social_only", detail: `${host} is a social or marketplace site, not the company's own website.` };
  }
  if (isDomainSaleUrl(url)) {
    return { skip: "parked", detail: `${host} sells domains; the company's website isn't there.` };
  }
  return null;
}

/**
 * The start URL from a company's website field: trimmed, https:// added when there is no scheme, parsed (IDN hosts
 * become punycode), a host with at least one dot, then the hop rules.
 */
export function parseStartUrl(
  website: string,
  opts: { allowOrigin?: string | null } = {},
): { ok: true; url: URL } | ({ ok: false } & UrlSkip) {
  const raw = website.trim();
  if (!raw) return { ok: false, skip: "no_website", detail: "The company has no website." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, skip: "bad_url", detail: "The website address can't be read." };
  }
  const host = comparableHost(url);
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!host.includes(".") && !host.includes(":")) {
      return { ok: false, skip: "bad_url", detail: "The website address has no domain ending (like .com)." };
    }
  }
  const bad = checkHopUrl(url, opts);
  return bad ? { ok: false, ...bad } : { ok: true, url };
}
