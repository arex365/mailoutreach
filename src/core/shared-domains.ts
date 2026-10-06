import { getDomain, parse } from "tldts";

/**
 * Domains shared by many unrelated people (free-mail and social/marketplace hosts).
 * They are NEVER used to group companies, find duplicates, apply the 30-day rule
 * or match replies (PLAN.md A5.2, B6.13). Hosted sub-domains such as
 * user.wixsite.com stay distinct because tldts knows the private public-suffix list.
 */

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "hotmail.co.uk",
  "hotmail.no", "live.com", "live.de", "live.no", "msn.com", "yahoo.com", "yahoo.de", "yahoo.co.uk",
  "yahoo.no", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de", "gmx.de", "gmx.net",
  "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de", "freenet.de", "posteo.de", "mailbox.org",
  "online.no", "outlook.no", "hotmail.se", "proton.me", "protonmail.com", "pm.me", "zoho.com",
  "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "naver.com", "hey.com",
  "fastmail.com", "tutanota.com", "tuta.io", "seznam.cz", "wp.pl", "o2.pl", "orange.fr", "free.fr",
  "laposte.net", "libero.it", "virgilio.it", "btinternet.com", "sky.com", "comcast.net", "verizon.net",
  "att.net", "bigpond.com", "telia.com", "telenor.no", "altibox.no", "lyse.net", "start.no",
]);

export const PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  "instagram.com", "instagr.am", "facebook.com", "fb.com", "fb.me", "tiktok.com", "linktr.ee",
  "linkin.bio", "beacons.ai", "patreon.com", "etsy.com", "cults3d.com", "myminifactory.com",
  "printables.com", "thingiverse.com", "artstation.com", "youtube.com", "youtu.be", "linkedin.com",
  "x.com", "twitter.com", "behance.net", "pinterest.com", "reddit.com", "twitch.tv", "kickstarter.com",
  "gumroad.com", "ko-fi.com", "cgtrader.com", "turbosquid.com", "sketchfab.com", "shapeways.com",
  "amazon.com", "amazon.de", "ebay.com", "ebay.de", "sites.google.com", "google.com", "wa.me",
  "whatsapp.com", "t.me", "discord.gg", "discord.com", "threads.net", "bsky.app", "tumblr.com",
  "deviantart.com", "carrd.co", "about.me", "notion.site", "wixsite.com", "squarespace.com",
  "weebly.com", "wordpress.com", "blogspot.com", "bigcartel.com", "storenvy.com", "gravatar.com",
]);

/**
 * Instagram paths that are pages of Instagram itself (posts, reels, stories …), never someone's
 * profile. The ONE list: parseWebsite, instagramHandle, the importer and the company panel use it.
 */
export const INSTAGRAM_NOT_PROFILES: ReadonlySet<string> = new Set([
  "p", "reel", "reels", "tv", "explore", "stories", "accounts", "direct", "about", "developer", "legal", "web",
  "press", "privacy", "terms", "challenge", "emails", "oauth",
]);

function isShared(registrable: string, extra?: ReadonlySet<string>): boolean {
  return FREE_MAIL_DOMAINS.has(registrable) || PLATFORM_DOMAINS.has(registrable) || (extra?.has(registrable) ?? false);
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

export function isSharedDomain(domain: string, extra?: ReadonlySet<string>): boolean {
  return isShared(domain.toLowerCase(), extra);
}

export type WebsiteInfo = {
  /** Cleaned URL to store/show, e.g. "https://www.acme.de" or "https://www.facebook.com/profile.php?id=100083123". */
  url: string;
  /** Registrable domain usable for matching, or null for shared hosts. */
  domain: string | null;
  /**
   * The ACCOUNT on a shared host, for exact matching only, e.g. "instagram.com/sculpt_by_anna",
   * "etsy.com/shop/foominis", "facebook.com/profile.php?id=100083123". Null when the link doesn't
   * point at one account (a post, a video, a search page, an unknown platform): then it never
   * matches anything.
   */
  profileKey: string | null;
  /** True when the website is only a social/marketplace profile. */
  isShared: boolean;
  /** Plain host without "www.", for display. */
  host: string;
};

// ───────────────────────── per-platform profile rules ─────────────────────────

type Parts = {
  /** Sub-domain in front of the platform's domain, lowercase ("" / "www" / "m" / "foominis"). */
  sub: string;
  /** Decoded path segments, as typed. */
  segs: string[];
  query: URLSearchParams;
};

type Platform = {
  /** Query parameters that identify the page (kept in the stored URL); all others are dropped. */
  params?: readonly string[];
  profile: (p: Parts) => string | null;
};

/** An account name in a path: letters, digits, "_", "." and "-" (no ":" "?" "/" …). */
const ACCOUNT = /^[\p{L}\p{N}_][\p{L}\p{N}._-]{0,99}$/u;
const LANGUAGE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;
/** Sub-domains that belong to the platform itself, never to one account. */
const PLAIN_SUBS = new Set([
  "", "www", "m", "mobile", "web", "touch", "business", "l", "lm", "mbasic", "help", "support", "blog", "magazine",
  "shop", "store", "community", "developer", "developers", "api", "status", "about", "jobs", "careers", "news", "press",
  "mail", "app", "apps", "accounts", "login", "static", "cdn", "docs", "forum", "forums", "learn", "learning",
]);

function isPlainSub(sub: string): boolean {
  return PLAIN_SUBS.has(sub) || /^[a-z]{2}$/.test(sub);
}

function account(raw: string | undefined, re: RegExp = ACCOUNT): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return re.test(s) ? s : null;
}

function set(words: string[]): ReadonlySet<string> {
  return new Set(words);
}

/** "platform/<first segment>" unless the first segment is one of the platform's own pages. */
function firstSegment(base: string, reserved: ReadonlySet<string>, re: RegExp = ACCOUNT): Platform["profile"] {
  return ({ segs }) => {
    const a = account(segs[0], re);
    return a && !reserved.has(a) ? `${base}/${a}` : null;
  };
}

/** "platform/<word>/<account>" where <word> is one of `words` (after an optional language segment). */
function afterWord(base: string, words: ReadonlySet<string>, keyWord: string, allowLanguage: boolean): Platform["profile"] {
  return ({ segs }) => {
    const i = allowLanguage && segs.length > 2 && LANGUAGE.test(segs[0]!) && !words.has(segs[0]!.toLowerCase()) ? 1 : 0;
    if (!words.has((segs[i] ?? "").toLowerCase())) return null;
    const a = account(segs[i + 1]);
    return a ? `${base}/${keyWord}/${a}` : null;
  };
}

/** "platform/<sub>" for platforms that give every account its own sub-domain (anna.tumblr.com). */
function subdomainAccount(base: string, fallback?: Platform["profile"]): Platform["profile"] {
  return (p) => {
    if (!isPlainSub(p.sub)) {
      const a = account(p.sub.split(".").pop());
      return a ? `${base}/${a}` : null;
    }
    return fallback ? fallback(p) : null;
  };
}

const INSTAGRAM_HANDLE = /^[a-z0-9._]{1,30}$/;

const instagram: Platform = {
  profile: ({ segs }) => {
    const h = account(segs[0], INSTAGRAM_HANDLE);
    return h && !INSTAGRAM_NOT_PROFILES.has(h) ? `instagram.com/${h}` : null;
  },
};

const FACEBOOK_RESERVED = set([
  "profile.php", "people", "pages", "pg", "p", "groups", "events", "watch", "marketplace", "gaming", "share", "sharer",
  "sharer.php", "photo", "photo.php", "photos", "story.php", "permalink.php", "hashtag", "login", "login.php", "help",
  "policies", "privacy", "business", "ads", "public", "search", "home.php", "home", "reel", "reels", "videos", "video.php",
  "media", "l.php", "dialog", "plugins", "notes", "settings", "messages", "friends", "bookmarks", "fundraisers",
  "stories", "legal", "about", "careers", "recover", "checkpoint", "index.php", "profile", "story", "posts", "tr",
  "live", "places", "jobs", "donate", "lite", "mobile", "apps", "games", "latest", "notifications",
]);
const FB_ID = /^\d{5,20}$/;
const facebookId = (id: string) => `facebook.com/profile.php?id=${id}`;

const facebook: Platform = {
  params: ["id"],
  profile: ({ segs, query }) => {
    const first = (segs[0] ?? "").toLowerCase();
    if (first === "profile.php") {
      const id = (query.get("id") ?? "").trim();
      return FB_ID.test(id) ? facebookId(id) : null;
    }
    // facebook.com/people/Anna-Sculpts/100083123/ and the old facebook.com/pages/Acme/123456789
    if (first === "people" || first === "pages") return FB_ID.test(segs[2] ?? "") ? facebookId(segs[2]!) : null;
    // The newer facebook.com/p/Anna-Sculpts-100083123/
    if (first === "p") {
      const m = /-(\d{5,20})$/.exec(segs[1] ?? "");
      return m ? facebookId(m[1]!) : null;
    }
    // facebook.com/100083123 is the same profile as profile.php?id=100083123.
    if (FB_ID.test(first)) return facebookId(first);
    if (first === "pg") return firstSegment("facebook.com", FACEBOOK_RESERVED)({ sub: "", segs: segs.slice(1), query });
    return firstSegment("facebook.com", FACEBOOK_RESERVED)({ sub: "", segs, query });
  },
};

const etsy: Platform = {
  profile: subdomainAccount("etsy.com/shop", ({ segs }) => {
    const i = segs.length > 2 && LANGUAGE.test(segs[0]!) ? 1 : 0;
    const word = (segs[i] ?? "").toLowerCase();
    const a = account(segs[i + 1]);
    if (!a) return null;
    if (word === "shop") return `etsy.com/shop/${a}`;
    if (word === "people") return `etsy.com/people/${a}`;
    return null;
  }),
};

const youtube: Platform = {
  params: ["v", "list"],
  profile: ({ segs }) => {
    const first = segs[0] ?? "";
    if (first.startsWith("@")) {
      const a = account(first.slice(1));
      return a ? `youtube.com/@${a}` : null;
    }
    const word = first.toLowerCase();
    if (word === "channel" || word === "c" || word === "user") {
      const a = account(segs[1]);
      return a ? `youtube.com/${word}/${a}` : null;
    }
    return null;
  },
};

/** "@name" as the first segment (tiktok.com/@anna, threads.net/@anna, printables.com/@Anna_123). */
function atHandle(base: string, allowLanguage = false): Platform["profile"] {
  return ({ segs }) => {
    const i = allowLanguage && segs.length > 1 && LANGUAGE.test(segs[0]!) ? 1 : 0;
    const first = segs[i] ?? "";
    if (!first.startsWith("@")) return null;
    const a = account(first.slice(1));
    return a ? `${base}/@${a}` : null;
  };
}

const X_RESERVED = set([
  "home", "search", "explore", "i", "intent", "share", "hashtag", "settings", "messages", "notifications", "login",
  "logout", "signup", "tos", "privacy", "compose", "account", "jobs", "about", "download", "search-advanced",
]);

const PATREON_RESERVED = set([
  "posts", "join", "login", "signup", "home", "explore", "search", "messages", "settings", "checkout", "bepatron",
  "policy", "policies", "about", "notifications", "library", "collection", "product", "create", "pricing", "apps",
  "careers", "legal", "user", "c", "m", "creators", "discover", "shop",
]);

const patreon: Platform = {
  params: ["u"],
  profile: ({ segs, query }) => {
    const first = (segs[0] ?? "").toLowerCase();
    if (first === "c") {
      const a = account(segs[1]);
      return a ? `patreon.com/${a}` : null;
    }
    if (first === "user") {
      const u = (query.get("u") ?? "").trim();
      return /^\d{1,20}$/.test(u) ? `patreon.com/user?u=${u}` : null;
    }
    return firstSegment("patreon.com", PATREON_RESERVED)({ sub: "", segs, query });
  },
};

const PLATFORMS: Record<string, Platform> = {
  "instagram.com": instagram,
  "instagr.am": instagram,
  "facebook.com": facebook,
  "fb.com": facebook,
  "fb.me": facebook,
  "etsy.com": etsy,
  "cults3d.com": { profile: afterWord("cults3d.com", set(["users", "utilisateurs", "usuarios", "benutzer"]), "users", true) },
  "myminifactory.com": { profile: afterWord("myminifactory.com", set(["users"]), "users", true) },
  "linkedin.com": {
    profile: ({ segs }) => {
      const word = (segs[0] ?? "").toLowerCase();
      if (!["company", "in", "school", "showcase"].includes(word)) return null;
      const a = account(segs[1]);
      return a ? `linkedin.com/${word}/${a}` : null;
    },
  },
  "youtube.com": youtube,
  "youtu.be": { params: ["v", "list"], profile: () => null },
  "sites.google.com": {
    profile: ({ segs }) => {
      const word = (segs[0] ?? "").toLowerCase();
      if (word !== "view" && word !== "site") return null;
      const a = account(segs[1]);
      return a ? `sites.google.com/${word}/${a}` : null;
    },
  },
  "tiktok.com": { profile: atHandle("tiktok.com") },
  "threads.net": { profile: atHandle("threads.net") },
  "printables.com": { profile: atHandle("printables.com", true) },
  "patreon.com": patreon,
  "x.com": { profile: firstSegment("x.com", X_RESERVED, /^[a-z0-9_]{1,15}$/) },
  "twitter.com": { profile: firstSegment("x.com", X_RESERVED, /^[a-z0-9_]{1,15}$/) },
  "linktr.ee": { profile: firstSegment("linktr.ee", set(["s", "admin", "login", "register", "marketplace", "discover", "blog", "help", "pricing", "privacy", "terms"])) },
  "linkin.bio": { profile: firstSegment("linkin.bio", set(["login", "signup", "help", "privacy", "terms"])) },
  "beacons.ai": { profile: firstSegment("beacons.ai", set(["i", "login", "signup", "help", "privacy", "terms", "pricing", "blog"])) },
  "about.me": { profile: firstSegment("about.me", set(["login", "signup", "help", "privacy", "terms", "search", "discover"])) },
  "artstation.com": {
    profile: subdomainAccount(
      "artstation.com",
      firstSegment("artstation.com", set(["artwork", "search", "marketplace", "learning", "jobs", "blogs", "challenges", "prints", "contests", "about", "users", "channels", "guides", "studios", "a", "community", "signup", "login"])),
    ),
  },
  "thingiverse.com": { profile: firstSegment("thingiverse.com", set(["search", "explore", "groups", "customizer", "about", "login", "legal", "education", "apps", "newest", "popular", "featured", "challenges", "collections", "things", "designs", "make", "tag", "categories"])) },
  "ko-fi.com": { profile: firstSegment("ko-fi.com", set(["s", "post", "album", "explore", "manage", "account", "home", "about", "shop", "commissions", "gold", "login", "signup", "i", "blog"])) },
  "behance.net": { profile: firstSegment("behance.net", set(["gallery", "search", "galleries", "joblist", "assets", "live", "about", "hire", "onboarding", "blog", "moodboard", "collection"])) },
  "deviantart.com": { profile: subdomainAccount("deviantart.com", firstSegment("deviantart.com", set(["tag", "search", "popular", "daily-deviations", "about", "topic", "shop", "users", "join", "watch", "notifications", "settings", "core-membership", "groups"]))) },
  "sketchfab.com": { profile: firstSegment("sketchfab.com", set(["3d-models", "models", "search", "feed", "store", "categories", "tags", "blogs", "features", "pricing", "plans", "login", "signup", "developers", "about", "collections", "for-teams", "museums", "business"])) },
  "twitch.tv": { profile: firstSegment("twitch.tv", set(["directory", "videos", "search", "p", "settings", "subscriptions", "downloads", "jobs", "turbo", "wallet", "inventory", "drops", "login", "signup"])) },
  "pinterest.com": { profile: firstSegment("pinterest.com", set(["pin", "search", "ideas", "today", "explore", "business", "settings", "login", "signup", "about", "categories", "topics"])) },
  "bsky.app": { profile: afterWord("bsky.app", set(["profile"]), "profile", false) },
  "t.me": { profile: firstSegment("t.me", set(["s", "joinchat", "addstickers", "share", "c", "iv", "proxy", "socks", "login"])) },
  "reddit.com": {
    profile: ({ segs }) => {
      const word = (segs[0] ?? "").toLowerCase();
      const a = account(segs[1]);
      if (!a) return null;
      if (word === "user" || word === "u") return `reddit.com/user/${a}`;
      if (word === "r") return `reddit.com/r/${a}`;
      return null;
    },
  },
  "kickstarter.com": { profile: afterWord("kickstarter.com", set(["profile"]), "profile", false) },
  "cgtrader.com": { profile: afterWord("cgtrader.com", set(["designers"]), "designers", false) },
  "gravatar.com": { profile: firstSegment("gravatar.com", set(["avatar", "site", "support", "login", "signup", "connect", "profile", "blog"])) },
  "ebay.com": { profile: ({ segs }) => ebayKey(segs) },
  "ebay.de": { profile: ({ segs }) => ebayKey(segs) },
  "wa.me": { profile: ({ segs }) => (/^\d{6,16}$/.test(segs[0] ?? "") ? `wa.me/${segs[0]}` : null) },
  "discord.gg": { profile: firstSegment("discord.gg", set([])) },
  "discord.com": {
    profile: ({ segs }) => {
      const a = (segs[0] ?? "").toLowerCase() === "invite" ? account(segs[1]) : null;
      return a ? `discord.gg/${a}` : null;
    },
  },
  "tumblr.com": { profile: subdomainAccount("tumblr.com", firstSegment("tumblr.com", set(["dashboard", "explore", "search", "tagged", "login", "register", "settings", "inbox", "likes", "following", "blog", "policy", "help", "about", "privacy", "new"]))) },
  "gumroad.com": { profile: subdomainAccount("gumroad.com") },
  "carrd.co": { profile: subdomainAccount("carrd.co") },
  "notion.site": { profile: subdomainAccount("notion.site") },
  "wixsite.com": { profile: subdomainAccount("wixsite.com") },
  "squarespace.com": { profile: subdomainAccount("squarespace.com") },
  "weebly.com": { profile: subdomainAccount("weebly.com") },
  "wordpress.com": { profile: subdomainAccount("wordpress.com") },
  "blogspot.com": { profile: subdomainAccount("blogspot.com") },
  "bigcartel.com": { profile: subdomainAccount("bigcartel.com") },
  "storenvy.com": { profile: subdomainAccount("storenvy.com") },
};

function ebayKey(segs: string[]): string | null {
  const word = (segs[0] ?? "").toLowerCase();
  const a = account(segs[1]);
  return a && (word === "usr" || word === "str") ? `ebay.com/${word}/${a}` : null;
}

/** Tracking parameters dropped from links on shared hosts we have no rule for. */
const TRACKING_PARAM =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|ref|ref_src|ref_url|referrer|si|mibextid|feature|trk|trackingid|lipi|originalsubdomain|_branch_.*|__tn__|__cft__.*|__xts__.*|click_key|click_sum|ga_.*|_ga|_gl|share_id|sfnsn|s|t)$/i;

function keptQuery(query: URLSearchParams, platform: Platform | null): string {
  const out = new URLSearchParams();
  for (const [k, v] of query) {
    const keep = platform ? (platform.params ?? []).includes(k) : !TRACKING_PARAM.test(k);
    if (keep && v !== "") out.append(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses a website/profile value typed by a person or found in an import. */
export function parseWebsite(input: string | null | undefined, extra?: ReadonlySet<string>): WebsiteInfo | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith("@") && !raw.includes(".")) return null; // a bare handle, not a website
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname.includes(".")) return null;
  const info = parse(hostname, { allowPrivateDomains: true });
  // With private suffixes, "anna.wixsite.com" is its own registrable domain (distinct per user),
  // while "www.instagram.com" → "instagram.com" (shared).
  const registrable = getDomain(hostname, { allowPrivateDomains: true }) ?? info.domain ?? hostname;
  const host = hostname.replace(/^www\./, "");
  const shared = isShared(registrable, extra) || isShared(host, extra);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  if (!shared) {
    // A company's own site: the domain identifies it; the query string is never needed.
    return { url: `${u.protocol}//${u.host}${path}`, domain: registrable, profileKey: null, isShared: false, host };
  }
  // A specific host rule wins (sites.google.com), else the registrable domain's (www.etsy.com → etsy.com).
  const platformDomain = PLATFORMS[host] ? host : registrable;
  const platform = PLATFORMS[platformDomain] ?? null;
  const sub = hostname === platformDomain ? "" : hostname.slice(0, -(platformDomain.length + 1));
  const segs = u.pathname.split("/").filter(Boolean).map(decodeSegment);
  const profileKey = platform ? platform.profile({ sub, segs, query: u.searchParams }) : null;
  return {
    url: `${u.protocol}//${u.host}${path}${keptQuery(u.searchParams, platform)}`,
    domain: null,
    profileKey,
    isShared: true,
    host,
  };
}

/** Registrable domain of an email address's domain, or null if it's a shared/free-mail domain. */
export function usableEmailDomain(emailDomain: string, extra?: ReadonlySet<string>): string | null {
  const d = emailDomain.toLowerCase();
  const registrable = getDomain(d, { allowPrivateDomains: true }) ?? d;
  if (isShared(registrable, extra) || isShared(d, extra)) return null;
  return registrable;
}

/**
 * Instagram handle from a profile link or "@handle" text, e.g. "sculpt_by_anna".
 * Links to posts, reels or stories (instagram.com/p/…) and Instagram's own pages give null.
 */
export function instagramHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  const link = /(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)(?:[/?#]\S*)?/i.exec(s);
  if (link) {
    // "instagram.com/anna, 12k followers": the comma isn't part of the link.
    const key = parseWebsite(link[0].replace(/[),.;:!?'"]+$/, ""))?.profileKey;
    return key?.startsWith("instagram.com/") ? key.slice("instagram.com/".length) : null;
  }
  const m = /^@?([A-Za-z0-9._]{1,30})$/.exec(s);
  if (!m) return null;
  const handle = m[1]!.toLowerCase();
  return INSTAGRAM_NOT_PROFILES.has(handle) ? null : handle;
}
