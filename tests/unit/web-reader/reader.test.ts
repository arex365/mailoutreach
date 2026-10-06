import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TOTAL_TOKEN_CAP, estimateTextTokens, type ReadPageLike } from "@/core/ai/types";
import { fixtureTransport, type FixtureSite } from "@/server/web/fixture-transport";
import { immediatePoliteness } from "@/server/web/politeness";
import { capPagesToTokens, createReader, cutToTokens } from "@/server/web/reader";
import { memoryRobotsStore } from "@/server/web/robots";
import type { Politeness } from "@/server/web/types";

/** M5-DESIGN §3.4.1, §3.4.6 step 5, §3.4.6 step 7: the token cap, the second page's fate and the extraction watchdog. */

const SITES = path.resolve("tests/fixtures/sites");
const NOW = new Date("2026-09-26T10:00:00Z");
const LONG = "Carved oak owls and hares for garden centres, sealed with linseed oil and signed on the base. ";

function reader(sites: FixtureSite[], extra: { log?: (m: string) => void; watchdogMs?: number } = {}) {
  const transport = fixtureTransport(null, { sites });
  const r = createReader({ transport, robotsStore: memoryRobotsStore(), politeness: immediatePoliteness, sleep: async () => {}, ...extra });
  return {
    transport,
    read: (website: string) => r.read({ website, companyName: "X" }, { signal: new AbortController().signal, now: NOW }),
  };
}

const html = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe("token cap", () => {
  it("leaves texts within the cap alone", () => {
    expect(capPagesToTokens(["a".repeat(6_000), "b".repeat(6_000)])).toEqual(["a".repeat(6_000), "b".repeat(6_000)]);
  });

  it("gives each page half the budget, and a short page leaves the rest to the other", () => {
    const cyr = "ж".repeat(6_000);
    const [a, b] = capPagesToTokens([cyr, "short page"]);
    expect(b).toBe("short page");
    expect(estimateTextTokens(a!) + estimateTextTokens(b!)).toBeLessThanOrEqual(TOTAL_TOKEN_CAP);
    expect(estimateTextTokens(a!)).toBe(TOTAL_TOKEN_CAP - estimateTextTokens("short page"));
    const [c, d] = capPagesToTokens([cyr, cyr]);
    expect(estimateTextTokens(c!)).toBe(TOTAL_TOKEN_CAP / 2);
    expect(estimateTextTokens(d!)).toBe(TOTAL_TOKEN_CAP / 2);
  });

  it("cuts at a line break or space near the end", () => {
    const text = "word ".repeat(3_000);
    const cut = cutToTokens(text, 100);
    expect(estimateTextTokens(cut)).toBeLessThanOrEqual(100);
    expect(cut.endsWith("word")).toBe(true);
    expect(cutToTokens("short", 100)).toBe("short");
  });
});

describe("second page", () => {
  const home = html(`<header><nav><a href="/gallery">Gallery</a></nav></header><main><p>${LONG.repeat(5)}</p></main>`);

  it("keeps a short gallery page (thin for a homepage) because it still has facts", async () => {
    const r = await reader([
      { origin: "https://owls.example", pages: { "/": { contentType: "text/html", body: home }, "/gallery": { contentType: "text/html", body: html("<p>Barn owl, 60 cm, oak.</p>") } } },
    ]).read("owls.example");
    expect(r.ok && r.pages.map((p) => p.kind)).toEqual(["homepage", "second_page"]);
    expect(r.ok && r.notes).toEqual([]);
    // The contract's ReadPageLike (what P8 hands to saveSnapshots) is satisfied by the reader's pages.
    const like: ReadPageLike[] = r.pages;
    expect(like[1]?.text).toBe("Barn owl, 60 cm, oak.");
  });

  it("drops a placeholder, a failing or an empty second page with the note second-page-failed", async () => {
    for (const page of [
      { contentType: "text/html", body: html("<h1>Coming soon</h1>") },
      { status: 500, contentType: "text/html", body: "error" },
      { contentType: "text/html", body: html("<p></p>") },
    ]) {
      const r = await reader([{ origin: "https://owls.example", pages: { "/": { contentType: "text/html", body: home }, "/gallery": page } }]).read("owls.example");
      expect(r.ok && r.pages.map((p) => p.kind)).toEqual(["homepage"]);
      expect(r.ok && r.notes).toEqual(["second-page-failed"]);
    }
  });

  it("isn't read when robots.txt disallows the best candidate; the next one is taken", async () => {
    const withAbout = html(`<nav><a href="/gallery">Gallery</a><a href="/about">About</a></nav><main><p>${LONG.repeat(5)}</p></main>`);
    const t = reader([
      {
        origin: "https://owls.example",
        pages: {
          "/robots.txt": { contentType: "text/plain", body: "User-agent: *\nDisallow: /gallery\n" },
          "/": { contentType: "text/html", body: withAbout },
          "/about": { contentType: "text/html", body: html(`<p>${LONG}</p>`) },
        },
      },
    ]);
    const r = await t.read("owls.example");
    expect(r.ok && r.pages[1]?.finalUrl).toBe("https://owls.example/about");
    expect(t.transport.calls.map((c) => c.url)).not.toContain("https://owls.example/gallery");
  });

  it("never picks a link the URL rules refuse (an unusual port); the next candidate is read", async () => {
    const withPort = html(
      `<nav><a href="https://owls.example:8443/portfolio">Portfolio</a><a href="/about">About</a></nav><main><p>${LONG.repeat(5)}</p></main>`,
    );
    const t = reader([
      {
        origin: "https://owls.example",
        pages: { "/": { contentType: "text/html", body: withPort }, "/about": { contentType: "text/html", body: html(`<p>${LONG}</p>`) } },
      },
    ]);
    const r = await t.read("owls.example");
    expect(r.ok && r.pages[1]?.finalUrl).toBe("https://owls.example/about");
    expect(r.ok && r.notes).toEqual([]);
    expect(t.transport.calls.some((c) => c.url.includes(":8443"))).toBe(false);
  });
});

describe("site builders", () => {
  it("reads a WordPress.com or Big Cartel site like a Wix site, and stays on that one site", async () => {
    const home = html(
      `<nav><a href="https://other-minis.wordpress.com/portfolio">Portfolio</a><a href="/about">About</a></nav><main><p>${LONG.repeat(5)}</p></main>`,
    );
    const t = reader([
      {
        origin: "https://anna-minis.wordpress.com",
        pages: { "/": { contentType: "text/html", body: home }, "/about": { contentType: "text/html", body: html(`<p>${LONG}</p>`) } },
      },
      { origin: "https://dragonforge.bigcartel.com", pages: { "/": { contentType: "text/html", body: home } } },
    ]);
    const r = await t.read("anna-minis.wordpress.com");
    expect(r.ok && r.pages.map((p) => p.finalUrl)).toEqual(["https://anna-minis.wordpress.com/", "https://anna-minis.wordpress.com/about"]);
    expect(await t.read("https://dragonforge.bigcartel.com")).toMatchObject({ ok: true });
    expect(t.transport.calls.some((c) => c.url.includes("other-minis"))).toBe(false);
    for (const website of ["https://wordpress.com/", "https://www.tumblr.com/anna", "anna.tumblr.com", "anna.gumroad.com"]) {
      expect(await t.read(website)).toMatchObject({ ok: false, skip: "social_only", requests: 0 });
    }
  });
});

describe("hostile robots.txt and link-heavy homepages (the worker's thread is shared with sending)", () => {
  /** 500 KiB of "*a*a…" rules: robots-parser matching costs O(pattern × path) per rule. */
  const hostileRobots = () => {
    const rule = `Disallow: /*${"a*".repeat(40)}z\n`;
    return `User-agent: *\nDisallow: /gallery\n${rule.repeat(Math.floor((500 * 1024) / rule.length))}`;
  };
  /** A 2 MB homepage whose nav holds 2,000 long links under the disallowed /gallery. */
  const linkHeavyHome = () => {
    const links = Array.from({ length: 2_000 }, (_, i) => `<a href="/gallery/${"a".repeat(900)}${i}">Gallery</a>`).join("");
    return html(`<nav>${links}</nav><main><p>${LONG.repeat(5)}</p></main>`);
  };

  it("a robots.txt too big to check leaves the site alone at once", async () => {
    const t = reader([
      {
        origin: "https://owls.example",
        pages: {
          "/robots.txt": { contentType: "text/plain", body: hostileRobots() },
          "/": { contentType: "text/html", body: linkHeavyHome() },
        },
      },
    ]);
    const t0 = performance.now();
    const r = await t.read("owls.example");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r).toMatchObject({ ok: false, skip: "robots_disallowed" });
    expect(t.transport.calls.map((c) => c.url)).toEqual(["https://owls.example/robots.txt"]);
  });

  it("robots.txt rules just under the limits and 2,000 disallowed long links: the pick finishes in milliseconds", async () => {
    // 4 KB of wildcard patterns (the per-group limit) and 2,000 candidates robots.txt refuses.
    const rules = `Disallow: /*${"a*".repeat(40)}z\n`.repeat(Math.floor(4_000 / 85));
    const links = Array.from({ length: 2_000 }, (_, i) => `<a href="/gallery/${"a".repeat(200)}${i}">Gallery</a>`).join("");
    const t = reader([
      {
        origin: "https://owls.example",
        pages: {
          "/robots.txt": { contentType: "text/plain", body: `User-agent: *\nDisallow: /gallery\n${rules}` },
          "/": { contentType: "text/html", body: html(`<nav>${links}</nav><main><p>${LONG.repeat(5)}</p></main>`) },
        },
      },
    ]);
    const t0 = performance.now();
    const r = await t.read("owls.example");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.ok && r.pages.map((p) => p.kind)).toEqual(["homepage"]);
    expect(t.transport.calls).toHaveLength(2);
  });
});

describe("page timeout", () => {
  it("counts network time only: politeness waits don't make a polite site with redirects 'too slow'", async () => {
    // Every request waits 80 ms for its host; the page may take 150 ms of network time. Three hops wait 240 ms.
    const slowHost: Politeness = {
      async acquire() {
        await delay(80);
        return () => {};
      },
    };
    const transport = fixtureTransport(null, {
      sites: [
        {
          origin: "https://owls.example",
          redirects: { "/": "/en", "/en": "/en/" },
          pages: { "/en/": { contentType: "text/html", body: html(`<main><p>${LONG.repeat(5)}</p></main>`) } },
        },
      ],
    });
    const r = await createReader({ transport, robotsStore: memoryRobotsStore(), politeness: slowHost, sleep: async () => {}, pageTimeoutMs: 150 }).read(
      { website: "owls.example", companyName: "X" },
      { signal: new AbortController().signal, now: NOW },
    );
    expect(r.ok && r.pages[0]?.finalUrl).toBe("https://owls.example/en/");
    expect(transport.calls.map((c) => c.url)).toEqual([
      "https://owls.example/robots.txt",
      "https://owls.example/",
      "https://owls.example/en",
      "https://owls.example/en/",
    ]);
  });
});

describe("watchdog", () => {
  it("logs slow extraction and slow picking with the host only, never page text", async () => {
    const logs: string[] = [];
    const t = reader([{ origin: "https://owls.example", pages: { "/": { contentType: "text/html", body: html(`<main><p>${LONG.repeat(5)}</p></main>`) } } }], {
      log: (m) => logs.push(m),
      watchdogMs: -1,
    });
    await t.read("owls.example");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^Reading owls\.example took \d+\.\d s to extract$/);
    expect(logs[1]).toMatch(/^Picking a second page of owls\.example took \d+\.\d s$/);
  });

  it("the real fixture folder loads", () => {
    expect(fixtureTransport(SITES).origins()).toContain("https://www.figuren-werkstatt.example");
    expect(fixtureTransport(path.join(SITES, "does-not-exist")).origins()).toEqual([]);
  });
});
