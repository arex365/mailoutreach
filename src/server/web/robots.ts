/**
 * robots.txt for the website reader (docs/dev/M5-DESIGN.md §3.4.5; research ai-and-fetch-reference.md B5, RFC 9309).
 * Per origin (scheme://host[:port]; http and https are different origins), parsed with robots-parser for the product
 * token "PolygonParadiseBot" (never the full user agent) and, because the page text goes to Claude, also for
 * "Claude-User": a disallow for either skips the page. Cached in `RobotsCache` for 24 h (1 h after a network error, 429
 * or 5xx). Fetched with the same transport, URL rules and politeness as pages: ≤ 5 redirects (across hosts), 500 KiB,
 * 10 s. A file whose rules for our tokens are too many or too long to check quickly counts as "too complex": nothing on
 * that origin is read (see ROBOTS_MAX_RULES).
 */
import robotsParser from "robots-parser";
import { CLAUDE_USER_TOKEN, ROBOTS_PRODUCT_TOKEN } from "@/core/ai/types";
import type { RobotsEntry, RobotsStore } from "./types";

export const ROBOTS_CACHE_MS = 24 * 3_600_000;
/** A robots.txt that couldn't be read (network error, 429, 5xx) is asked again after an hour. */
export const ROBOTS_FAILURE_CACHE_MS = 3_600_000;
export const ROBOTS_BODY_CAP = 500 * 1024;
export const ROBOTS_TIMEOUT_MS = 10_000;
export const ROBOTS_MAX_REDIRECTS = 5;

/*
 * robots-parser checks every Allow/Disallow rule of the group it uses for each URL, allocates an array as long as the
 * URL's path per rule, and a pattern with "*" costs O(pattern × path). The site controls the file (up to 500 KiB) and
 * the reader runs on the worker's thread, so a group with more than these is "too complicated" and the site is left
 * alone (never read against its wishes). URLs are at most MAX_URL_CHARS long (the URL rules), so one check costs about
 * (ROBOTS_MAX_WILDCARD_CHARS + ROBOTS_MAX_RULES) × 2,048 steps at most: measured on this PC, about 20 ms for a
 * 2,048-character redirect target and under 5 ms for the picker's links (≤ 300 characters), against 1 to 15 s per
 * check before. Real files are far smaller (Shopify's default has about 40 rules and 1 KB of "*" patterns per group).
 */
/** Allow and Disallow lines one user-agent group may have. */
export const ROBOTS_MAX_RULES = 5_000;
/** Characters of one Allow or Disallow pattern (as robots-parser stores it, percent-encoded). */
export const ROBOTS_MAX_PATTERN_CHARS = 2_048;
/** Characters of all patterns with "*" in one user-agent group. */
export const ROBOTS_MAX_WILDCARD_CHARS = 4_096;

type Robot = ReturnType<typeof robotsParser>;

/** What a robots.txt answer means for the reader (RFC 9309 status table, research B5). */
export type RobotsRules =
  | { kind: "rules"; status: number; robot: Robot; crawlDelaySec: number | null }
  /** 3xx left over (more than 5 redirects) or 4xx: "unavailable", everything may be read. */
  | { kind: "allow-all"; status: number }
  /** 0 (network, timeout), 429 or 5xx: "unreachable", nothing may be read (skip `unreachable`). */
  | { kind: "disallow-all"; status: number }
  /** A 2xx robots.txt whose rules for our tokens are too many or too long to check: nothing is read. */
  | { kind: "too-complex"; status: number };

/** The verdict for one URL. `undefined`-like "unknown" never happens here: the reader loads the origin's rules first. */
export type RobotsVerdict =
  | { kind: "allowed"; crawlDelaySec: number | null }
  | { kind: "disallowed"; token: string }
  | { kind: "unreachable"; status: number }
  | { kind: "too-complex" };

function isFailureStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** True while a cached answer may still be used: 24 h, or 1 h for a network error, 429 or 5xx. */
export function isFreshRobots(entry: RobotsEntry, now: Date): boolean {
  const age = now.getTime() - entry.fetchedAt.getTime();
  return age >= 0 && age < (isFailureStatus(entry.status) ? ROBOTS_FAILURE_CACHE_MS : ROBOTS_CACHE_MS);
}

/** The largest crawl-delay either token is given (seconds), or null. */
function crawlDelayOf(robot: Robot): number | null {
  const values = [robot.getCrawlDelay(ROBOTS_PRODUCT_TOKEN), robot.getCrawlDelay(CLAUDE_USER_TOKEN)].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return values.length > 0 ? Math.max(...values) : null;
}

/** A user agent as robots-parser keys its groups: lowercase, without a "/version". */
function agentKey(value: string): string {
  const v = value.toLowerCase();
  const slash = v.indexOf("/");
  return (slash >= 0 ? v.slice(0, slash) : v).trim();
}

/** A pattern's length as robots-parser stores it (encodeURI, "%25" kept as "%"). */
function storedPatternLength(pattern: string): number {
  try {
    return encodeURI(pattern).replace(/%25/g, "%").length;
  } catch {
    return pattern.length;
  }
}

/**
 * True when a group robots-parser may use for our tokens (theirs or "*") has more than ROBOTS_MAX_RULES rules, a
 * pattern longer than ROBOTS_MAX_PATTERN_CHARS, or more than ROBOTS_MAX_WILDCARD_CHARS of "*" patterns. One linear
 * pass that reads the file the way robots-parser 3 does: lines without comments, "key: value", consecutive
 * User-agent lines share the rules that follow them.
 */
export function robotsTooComplex(body: string): boolean {
  const tracked = new Set(["*", agentKey(ROBOTS_PRODUCT_TOKEN), agentKey(CLAUDE_USER_TOKEN)]);
  const groups = new Map<string, { rules: number; wildcard: number }>();
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf("#");
    const line = hash >= 0 ? raw.slice(0, hash) : raw;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) agents = [];
      if (value) agents.push(agentKey(value));
    } else if ((key === "allow" || key === "disallow") && value) {
      const length = storedPatternLength(value);
      if (length > ROBOTS_MAX_PATTERN_CHARS) return true;
      for (const agent of agents) {
        if (!tracked.has(agent)) continue;
        const g = groups.get(agent) ?? { rules: 0, wildcard: 0 };
        g.rules += 1;
        if (value.includes("*")) g.wildcard += length;
        if (g.rules > ROBOTS_MAX_RULES || g.wildcard > ROBOTS_MAX_WILDCARD_CHARS) return true;
        groups.set(agent, g);
      }
    }
    lastWasAgent = key === "user-agent";
  }
  return false;
}

/** Turns a cached answer for `origin` into rules. */
export function robotsRulesFor(origin: string, entry: RobotsEntry): RobotsRules {
  const { status } = entry;
  if (status >= 200 && status < 300) {
    if (robotsTooComplex(entry.body)) return { kind: "too-complex", status };
    const robot = robotsParser(`${origin}/robots.txt`, entry.body);
    return { kind: "rules", status, robot, crawlDelaySec: crawlDelayOf(robot) };
  }
  if (isFailureStatus(status)) return { kind: "disallow-all", status };
  return { kind: "allow-all", status };
}

/**
 * Whether the rules allow `url` for both tokens: true, false, or undefined when the URL isn't on the rules' origin
 * (robots-parser answers undefined for another protocol, host or port; the reader then reads that origin's robots.txt).
 */
export function robotsAllows(rules: RobotsRules, url: URL): boolean | undefined {
  if (rules.kind === "allow-all") return true;
  if (rules.kind === "disallow-all" || rules.kind === "too-complex") return false;
  const bot = rules.robot.isAllowed(url.href, ROBOTS_PRODUCT_TOKEN);
  const claude = rules.robot.isAllowed(url.href, CLAUDE_USER_TOKEN);
  if (bot === undefined || claude === undefined) return undefined;
  return bot && claude;
}

/** The reader's verdict for `url` under the rules of its own origin. */
export function robotsVerdict(rules: RobotsRules, url: URL): RobotsVerdict {
  if (rules.kind === "allow-all") return { kind: "allowed", crawlDelaySec: null };
  if (rules.kind === "disallow-all") return { kind: "unreachable", status: rules.status };
  if (rules.kind === "too-complex") return { kind: "too-complex" };
  if (rules.robot.isAllowed(url.href, ROBOTS_PRODUCT_TOKEN) === false) return { kind: "disallowed", token: ROBOTS_PRODUCT_TOKEN };
  if (rules.robot.isAllowed(url.href, CLAUDE_USER_TOKEN) === false) return { kind: "disallowed", token: CLAUDE_USER_TOKEN };
  return { kind: "allowed", crawlDelaySec: rules.crawlDelaySec };
}

/** For unit tests (and anything without a database): robots answers kept in a Map. */
export type MemoryRobotsStore = RobotsStore & { readonly entries: Map<string, RobotsEntry>; readonly writes: number };

export function memoryRobotsStore(): MemoryRobotsStore {
  const entries = new Map<string, RobotsEntry>();
  let writes = 0;
  return {
    entries,
    get writes() {
      return writes;
    },
    async get(origin) {
      return entries.get(origin) ?? null;
    },
    async put(origin, entry) {
      writes += 1;
      entries.set(origin, entry);
    },
  };
}

/**
 * The worker's store: one `RobotsCache` row per origin (the `host` column holds the origin), written with `dbWrite`
 * outside any other transaction. A database problem never stops a read: a failed get reads robots.txt again, a failed
 * put is ignored. The database module is loaded on first use, so importing the reader opens nothing.
 */
export function dbRobotsStore(): RobotsStore {
  const load = () => import("../db");
  return {
    async get(origin) {
      try {
        const { db } = await load();
        const row = await db.robotsCache.findUnique({ where: { host: origin } });
        return row ? { status: row.status, body: row.body, fetchedAt: row.fetchedAt } : null;
      } catch {
        return null;
      }
    },
    async put(origin, entry) {
      try {
        const { dbWrite } = await load();
        const body = entry.body.length > ROBOTS_BODY_CAP ? entry.body.slice(0, ROBOTS_BODY_CAP) : entry.body;
        await dbWrite((c) =>
          c.robotsCache.upsert({
            where: { host: origin },
            create: { host: origin, status: entry.status, body, fetchedAt: entry.fetchedAt },
            update: { status: entry.status, body, fetchedAt: entry.fetchedAt },
          }),
        );
      } catch {
        /* the next read asks again */
      }
    },
  };
}
