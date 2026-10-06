import path from "node:path";
import { describe, expect, it } from "vitest";
import { portBusyMessage } from "../../../scripts/lib/supervisor.mjs";
import { NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS, isLoopbackUrl, isOtherDatabase, testRunEnv } from "../../../scripts/run-prod.mjs";

/**
 * run-prod.mjs (M3-DESIGN §2.5, §6.3): any database other than the app's own is a test run, so the app and the
 * background sender get OUTREACH_TEST_RUN=1 and refuse every Mailgun host but the local fake. M6-DESIGN §0.2 rule 13,
 * §3.9: a test run also gets a public address on this PC only, so the remote-access checks never reach .env's real
 * Cloudflare address. MAIN-DOMAIN-DESIGN §8 P8: `--no-public-address` gives a test run no public address at all (the
 * own-mailbox screen checks, like the owner's PC); refused on the app's own database. Importing the script only loads
 * its helpers; it starts nothing.
 */
const ROOT = path.resolve("C:/Outreach");

describe("run-prod.mjs test-run detection", () => {
  it("is not a test run on the app's own database (by default or named the same way)", () => {
    expect(isOtherDatabase(undefined, "file:./data/app.db", ROOT)).toBe(false);
    expect(isOtherDatabase("file:./data/app.db", "file:./data/app.db", ROOT)).toBe(false);
    // Same file, written differently: absolute, other case, no .env value (the default is data\app.db).
    expect(isOtherDatabase("file:C:/Outreach/data/APP.db", "file:./data/app.db", ROOT)).toBe(false);
    expect(isOtherDatabase("file:./data/app.db", undefined, ROOT)).toBe(false);
    expect(testRunEnv("file:./data/app.db", "file:./data/app.db", ROOT, { port: 3000, publicUrl: "https://outreach.example.com" })).toEqual({});
  });

  it("is a test run on any other database file", () => {
    expect(isOtherDatabase("file:./data/manual-m3.db", "file:./data/app.db", ROOT)).toBe(true);
    expect(isOtherDatabase("file:./data/demo.db", undefined, ROOT)).toBe(true);
    expect(isOtherDatabase("file:D:/copies/app.db", "file:./data/app.db", ROOT)).toBe(true);
    expect(testRunEnv("file:./data/manual-m3.db", "file:./data/app.db", ROOT, { port: 3102 }).OUTREACH_TEST_RUN).toBe("1");
  });
});

describe("run-prod.mjs gives a test run a public address on this PC only", () => {
  const db = "file:./data/manual-check/m6-busy.db";

  it("sets APP_PUBLIC_URL to 127.0.0.1 and the instance's port, whatever .env says", () => {
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3102 })).toEqual({
      OUTREACH_TEST_RUN: "1",
      APP_PUBLIC_URL: "http://127.0.0.1:3102",
    });
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3101, publicUrl: "https://outreach.example.com" })).toEqual({
      OUTREACH_TEST_RUN: "1",
      APP_PUBLIC_URL: "http://127.0.0.1:3101",
    });
    // The default port.
    expect(testRunEnv(db, "file:./data/app.db", ROOT).APP_PUBLIC_URL).toBe("http://127.0.0.1:3000");
  });

  it("keeps a loopback address the window already set (e.g. the fake Mailgun's --app)", () => {
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3102, publicUrl: "http://127.0.0.1:3100" })).toEqual({ OUTREACH_TEST_RUN: "1" });
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3102, publicUrl: "http://localhost:3100" })).toEqual({ OUTREACH_TEST_RUN: "1" });
  });

  it("with --no-public-address, empties APP_PUBLIC_URL instead: no loopback address, not .env's nor this window's", () => {
    const none = { OUTREACH_TEST_RUN: "1", APP_PUBLIC_URL: "" };
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3105, noPublicAddress: true })).toEqual(none);
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3105, publicUrl: "https://outreach.example.com", noPublicAddress: true })).toEqual(none);
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3105, publicUrl: "http://127.0.0.1:3105", noPublicAddress: true })).toEqual(none);
    // The child environment is this window's with the extra values on top (lib/supervisor.mjs): the address is gone.
    const windowEnv: Record<string, string | undefined> = { APP_PUBLIC_URL: "https://outreach.example.com", PATH: "x" };
    const child = { ...windowEnv, ...testRunEnv(db, undefined, ROOT, { noPublicAddress: true }) };
    expect(child.APP_PUBLIC_URL).toBe("");
    // Without the option: today's loopback address.
    expect(testRunEnv(db, "file:./data/app.db", ROOT, { port: 3105, noPublicAddress: false }).APP_PUBLIC_URL).toBe("http://127.0.0.1:3105");
  });

  it("refuses --no-public-address on the app's own database", () => {
    expect(NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS).toBe("--no-public-address is only for test runs on another database.");
    expect(() => testRunEnv("file:./data/app.db", "file:./data/app.db", ROOT, { noPublicAddress: true })).toThrow(NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS);
    expect(() => testRunEnv(undefined, "file:./data/app.db", ROOT, { port: 3000, noPublicAddress: true })).toThrow(NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS);
    expect(() => testRunEnv("file:C:/Outreach/data/APP.db", undefined, ROOT, { noPublicAddress: true })).toThrow(NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS);
  });

  it("start.bat's port message names a window still running npm run dev, right after its first sentence", () => {
    const text = portBusyMessage(3000);
    expect(text.startsWith("Port 3000 is already in use, so the app can't start. If you started the app with npm run dev, close that window first (click in it and press Ctrl+C). ")).toBe(true);
    expect(text).toContain("try http://localhost:3000 in your browser");
  });

  it("knows loopback addresses", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3100")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3100")).toBe(true);
    expect(isLoopbackUrl("http://localhost")).toBe(true);
    expect(isLoopbackUrl("https://outreach.example.com")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
