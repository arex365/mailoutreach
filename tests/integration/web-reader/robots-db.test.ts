import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * M5-DESIGN §3.4.5: robots.txt answers are cached in `RobotsCache` (the `host` column holds the origin) for 24 h, 1 h
 * after a network error, 429 or 5xx; written with dbWrite outside any other transaction; the reader's default store.
 */

const t = await createTestDb("web-robots");
const { db } = await import("@/server/db");
const { dbRobotsStore } = await import("@/server/web/robots");
const { createReader } = await import("@/server/web/reader");
const { fixtureTransport } = await import("@/server/web/fixture-transport");
const { immediatePoliteness } = await import("@/server/web/politeness");

const SITES = path.resolve("tests/fixtures/sites");
const signal = () => new AbortController().signal;

beforeAll(async () => {
  await db.robotsCache.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("dbRobotsStore", () => {
  it("stores one row per origin and updates it", async () => {
    const store = dbRobotsStore();
    expect(await store.get("https://studio.example")).toBeNull();
    const at = new Date("2026-09-26T10:00:00Z");
    await store.put("https://studio.example", { status: 200, body: "User-agent: *\nDisallow: /x\n", fetchedAt: at });
    expect(await store.get("https://studio.example")).toEqual({ status: 200, body: "User-agent: *\nDisallow: /x\n", fetchedAt: at });
    const later = new Date("2026-09-27T10:00:00Z");
    await store.put("https://studio.example", { status: 503, body: "", fetchedAt: later });
    expect(await store.get("https://studio.example")).toEqual({ status: 503, body: "", fetchedAt: later });
    expect(await db.robotsCache.count({ where: { host: "https://studio.example" } })).toBe(1);
  });

  it("caps a huge body at 500 KiB", async () => {
    const store = dbRobotsStore();
    await store.put("https://big-robots.example", { status: 200, body: "#".repeat(600 * 1024), fetchedAt: new Date() });
    expect((await store.get("https://big-robots.example"))?.body.length).toBe(500 * 1024);
  });
});

describe("the reader's default robots cache", () => {
  it("fetches robots.txt once, writes one row and reuses it on the next read", async () => {
    let now = new Date("2026-09-26T10:00:00Z");
    const transport = fixtureTransport(SITES);
    const reader = createReader({ transport, politeness: immediatePoliteness, now: () => now });
    const read = () => reader.read({ website: "www.figuren-werkstatt.example", companyName: "Figuren Werkstatt" }, { signal: signal(), now });

    expect((await read()).ok).toBe(true);
    const row = await db.robotsCache.findUnique({ where: { host: "https://www.figuren-werkstatt.example" } });
    expect(row).toMatchObject({ status: 200, body: "User-agent: *\nDisallow: /intern/\n" });
    expect(row?.fetchedAt.toISOString()).toBe("2026-09-26T10:00:00.000Z");

    now = new Date("2026-09-27T09:59:00Z");
    expect((await read()).ok).toBe(true);
    const robotsCalls = () => transport.calls.filter((c) => c.url.endsWith("/robots.txt")).length;
    expect(robotsCalls()).toBe(1);

    now = new Date("2026-09-27T10:00:01Z");
    expect((await read()).ok).toBe(true);
    expect(robotsCalls()).toBe(2);
    const refreshed = await db.robotsCache.findUnique({ where: { host: "https://www.figuren-werkstatt.example" } });
    expect(refreshed?.fetchedAt.toISOString()).toBe("2026-09-27T10:00:01.000Z");
  });

  it("asks again an hour after robots.txt answered 503", async () => {
    let now = new Date("2026-09-26T12:00:00Z");
    const transport = fixtureTransport(null, {
      sites: [
        {
          origin: "https://robots-down.example",
          pages: {
            "/robots.txt": { status: 503, contentType: "text/plain", body: "busy" },
            "/": { contentType: "text/html", body: "<p>never read</p>" },
          },
        },
      ],
    });
    const reader = createReader({ transport, politeness: immediatePoliteness, now: () => now });
    const read = () => reader.read({ website: "robots-down.example", companyName: "X" }, { signal: signal(), now });
    expect(await read()).toMatchObject({ ok: false, skip: "unreachable" });
    now = new Date("2026-09-26T12:59:00Z");
    await read();
    expect(transport.calls.map((c) => c.url)).toEqual(["https://robots-down.example/robots.txt"]);
    now = new Date("2026-09-26T13:00:01Z");
    await read();
    expect(transport.calls).toHaveLength(2);
    expect(await db.robotsCache.findUnique({ where: { host: "https://robots-down.example" } })).toMatchObject({ status: 503 });
  });
});
