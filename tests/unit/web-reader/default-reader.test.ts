import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRealTransport, defaultWebsiteReader, immediatePoliteness, memoryRobotsStore, webFixturesDir } from "@/server/web";

/**
 * M5-DESIGN §5.4, §7.4 guards: the reader never reads a real website in a test run. `defaultWebsiteReader()` uses the
 * fixture sites when OUTREACH_WEB_FIXTURES is set (never with app.db) and throws in a test run without them.
 */

const saved = { fixtures: process.env.OUTREACH_WEB_FIXTURES, db: process.env.DATABASE_URL };

afterEach(() => {
  process.env.OUTREACH_WEB_FIXTURES = saved.fixtures;
  process.env.DATABASE_URL = saved.db;
});

describe("defaultWebsiteReader", () => {
  it("reads the fixture sites in tests (tests/setup/env.ts sets OUTREACH_WEB_FIXTURES)", async () => {
    expect(webFixturesDir()).toBe(path.resolve("tests/fixtures/sites"));
    const reader = defaultWebsiteReader({ robotsStore: memoryRobotsStore(), politeness: immediatePoliteness });
    const r = await reader.read(
      { website: "www.figuren-werkstatt.example", companyName: "Figuren Werkstatt" },
      { signal: new AbortController().signal, now: new Date() },
    );
    expect(r.ok && r.pages.map((p) => p.finalUrl)).toEqual([
      "https://www.figuren-werkstatt.example/",
      "https://www.figuren-werkstatt.example/galerie",
    ]);
  });

  it("throws in a test run without fixtures", () => {
    delete process.env.OUTREACH_WEB_FIXTURES;
    expect(() => defaultWebsiteReader()).toThrow("Test runs never read real websites (set OUTREACH_WEB_FIXTURES).");
    process.env.OUTREACH_WEB_FIXTURES = "  ";
    expect(() => defaultWebsiteReader()).toThrow("Test runs never read real websites");
  });

  it("never uses fixtures with the owner's app.db (and so throws in a test run)", () => {
    process.env.DATABASE_URL = "file:./data/app.db";
    expect(webFixturesDir()).toBeNull();
    expect(() => defaultWebsiteReader()).toThrow("Test runs never read real websites");
  });

  it("an injected transport is used as it is", () => {
    delete process.env.OUTREACH_WEB_FIXTURES;
    const transport = { get: async () => ({ status: 404, headers: new Headers(), body: null }) };
    expect(() => defaultWebsiteReader({ transport })).not.toThrow();
  });

  it("the real transport refuses to be built in a test run without a test origin", () => {
    expect(() => createRealTransport()).toThrow("Test runs never read real websites (set OUTREACH_WEB_FIXTURES).");
  });
});
