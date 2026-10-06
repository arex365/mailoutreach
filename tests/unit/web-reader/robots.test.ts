import { describe, expect, it } from "vitest";
import {
  ROBOTS_BODY_CAP,
  ROBOTS_CACHE_MS,
  ROBOTS_FAILURE_CACHE_MS,
  ROBOTS_MAX_PATTERN_CHARS,
  ROBOTS_MAX_RULES,
  ROBOTS_MAX_WILDCARD_CHARS,
  isFreshRobots,
  memoryRobotsStore,
  robotsAllows,
  robotsRulesFor,
  robotsTooComplex,
  robotsVerdict,
} from "@/server/web/robots";

/** M5-DESIGN §3.4.5, research B5: the product token, Claude-User, RFC 9309's status table and the cache times. */

const ORIGIN = "https://studio.example";
const at = new Date("2026-09-26T10:00:00Z");
const rules = (status: number, body = "") => robotsRulesFor(ORIGIN, { status, body, fetchedAt: at });
const url = (path: string) => new URL(path, ORIGIN);

describe("robots rules", () => {
  it("obeys the group for PolygonParadiseBot, never the full user agent", () => {
    const r = rules(200, "User-agent: PolygonParadiseBot\nDisallow: /shop\n\nUser-agent: *\nDisallow: /\n");
    expect(robotsVerdict(r, url("/about"))).toEqual({ kind: "disallowed", token: "Claude-User" });
    const own = rules(200, "User-agent: PolygonParadiseBot\nDisallow: /shop\n\nUser-agent: Claude-User\nAllow: /\n");
    expect(robotsVerdict(own, url("/about"))).toEqual({ kind: "allowed", crawlDelaySec: null });
    expect(robotsVerdict(own, url("/shop/x"))).toEqual({ kind: "disallowed", token: "PolygonParadiseBot" });
  });

  it("a Claude-User disallow skips the page too (the text goes to Claude)", () => {
    const r = rules(200, "User-agent: Claude-User\nDisallow: /\n");
    expect(robotsVerdict(r, url("/"))).toEqual({ kind: "disallowed", token: "Claude-User" });
    expect(robotsAllows(r, url("/"))).toBe(false);
  });

  it("ignores training-crawler tokens", () => {
    const r = rules(200, "User-agent: anthropic-ai\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n");
    expect(robotsVerdict(r, url("/"))).toEqual({ kind: "allowed", crawlDelaySec: null });
  });

  it("uses the larger crawl-delay of the two tokens", () => {
    const r = rules(200, "User-agent: *\nCrawl-delay: 20\n");
    expect(robotsVerdict(r, url("/"))).toEqual({ kind: "allowed", crawlDelaySec: 20 });
  });

  it("answers undefined for another origin (http and https are different origins)", () => {
    const r = rules(200, "User-agent: *\nDisallow: /private\n");
    expect(robotsAllows(r, new URL("http://studio.example/"))).toBeUndefined();
    expect(robotsAllows(r, new URL("https://www.studio.example/"))).toBeUndefined();
    expect(robotsAllows(r, url("/private/x"))).toBe(false);
    expect(robotsAllows(r, url("/public"))).toBe(true);
  });

  it.each([
    [404, "allowed"],
    [401, "allowed"],
    [403, "allowed"],
    [410, "allowed"],
    [301, "allowed"],
    [0, "unreachable"],
    [429, "unreachable"],
    [500, "unreachable"],
    [503, "unreachable"],
  ])("status %i → %s (RFC 9309)", (status, kind) => {
    expect(robotsVerdict(rules(status), url("/")).kind).toBe(kind);
  });

  it("an HTML body with status 200 just has no rules", () => {
    expect(robotsVerdict(rules(200, "<html><body>Hello</body></html>"), url("/"))).toEqual({ kind: "allowed", crawlDelaySec: null });
  });
});

describe("robots.txt too complicated to check quickly (robots-parser costs O(pattern × path) per rule)", () => {
  const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
  const wildcard = `/*${"a*".repeat(40)}z`;

  it("too many rules, a too long pattern or too many wildcard characters in a group we use: nothing is read", () => {
    const tooMany = `User-agent: *\n${lines(ROBOTS_MAX_RULES + 1, (i) => `Disallow: /p${i}/`)}`;
    const tooLong = `User-agent: PolygonParadiseBot\nDisallow: /${"x".repeat(ROBOTS_MAX_PATTERN_CHARS)}`;
    const encodedTooLong = `User-agent: *\nDisallow: /${"ü".repeat(Math.ceil(ROBOTS_MAX_PATTERN_CHARS / 6))}`;
    const tooWild = `User-agent: Claude-User\n${lines(Math.ceil(ROBOTS_MAX_WILDCARD_CHARS / wildcard.length) + 1, () => `Disallow: ${wildcard}`)}`;
    for (const body of [tooMany, tooLong, encodedTooLong, tooWild]) {
      expect(robotsTooComplex(body)).toBe(true);
      const r = rules(200, body);
      expect(r.kind).toBe("too-complex");
      expect(robotsVerdict(r, url("/"))).toEqual({ kind: "too-complex" });
      expect(robotsAllows(r, url("/"))).toBe(false);
    }
  });

  it("real-sized files and groups other bots use are fine", () => {
    const shopifyLike = [
      "User-agent: *",
      ...Array.from({ length: 40 }, (_, i) => `Disallow: /*/collections/*sort_by*${i}`),
      "Sitemap: https://studio.example/sitemap.xml",
      "",
      "User-agent: AhrefsBot",
      "Crawl-delay: 10",
      ...Array.from({ length: 200 }, () => `Disallow: ${wildcard}`),
    ].join("\n");
    expect(robotsTooComplex(shopifyLike)).toBe(false);
    const r = rules(200, shopifyLike);
    expect(robotsVerdict(r, url("/about"))).toEqual({ kind: "allowed", crawlDelaySec: null });
    expect(robotsTooComplex(`User-agent: *\n${lines(ROBOTS_MAX_RULES, (i) => `Disallow: /p${i}/`)}`)).toBe(false);
  });

  it("follows robots-parser's grouping: consecutive User-agent lines share the rules after them", () => {
    const shared = `User-agent: SomeBot\nUser-agent: polygonparadisebot/2.0\n${lines(ROBOTS_MAX_RULES + 1, (i) => `Allow: /p${i}/  # comment`)}`;
    expect(robotsTooComplex(shared)).toBe(true);
    const later = `User-agent: *\nDisallow: /x\nUser-agent: SomeBot\n${lines(ROBOTS_MAX_RULES + 1, (i) => `Disallow: /p${i}/`)}`;
    expect(robotsTooComplex(later)).toBe(false);
  });

  it("a hostile 500 KiB file is refused in milliseconds instead of being matched for seconds", () => {
    const body = `User-agent: *\nDisallow: /gallery\n${lines(5_000, () => `Disallow: ${wildcard}`)}`.slice(0, ROBOTS_BODY_CAP);
    const t0 = performance.now();
    const r = rules(200, body);
    expect(robotsAllows(r, url(`/gallery/${"a".repeat(1_000)}i`))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("cache freshness", () => {
  it("keeps answers for 24 hours and failures for 1 hour", () => {
    const entry = (status: number, ageMs: number) => ({ status, body: "", fetchedAt: new Date(at.getTime() - ageMs) });
    expect(isFreshRobots(entry(200, ROBOTS_CACHE_MS - 1), at)).toBe(true);
    expect(isFreshRobots(entry(200, ROBOTS_CACHE_MS), at)).toBe(false);
    expect(isFreshRobots(entry(404, 3 * 3_600_000), at)).toBe(true);
    for (const status of [0, 429, 503]) {
      expect(isFreshRobots(entry(status, ROBOTS_FAILURE_CACHE_MS - 1), at)).toBe(true);
      expect(isFreshRobots(entry(status, ROBOTS_FAILURE_CACHE_MS), at)).toBe(false);
    }
    expect(isFreshRobots(entry(200, -60_000), at)).toBe(false);
  });
});

describe("memoryRobotsStore", () => {
  it("keeps entries per origin and counts writes", async () => {
    const store = memoryRobotsStore();
    expect(await store.get(ORIGIN)).toBeNull();
    await store.put(ORIGIN, { status: 200, body: "User-agent: *", fetchedAt: at });
    expect(await store.get(ORIGIN)).toEqual({ status: 200, body: "User-agent: *", fetchedAt: at });
    expect(store.writes).toBe(1);
  });
});
