import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_KEY_PREFIX,
  MAILGUN_HOSTS,
  assertAllowedBaseUrl,
  assertKeyMatchesTarget,
  describeMailgunTarget,
  isAllowedStorageUrl,
  isFakeMode,
  isTestRun,
  mailgunApiBase,
  mailgunBaseOverride,
} from "@/server/mailgun/base-url";
import { MailgunError } from "@/server/mailgun/errors";

/** Runs `fn` with these environment variables (undefined = unset), then restores them. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Outside a test run: no OUTREACH_TEST_RUN, no VITEST, NODE_ENV production (how run-prod and the services run). */
const PRODUCTION = { OUTREACH_TEST_RUN: undefined, VITEST: undefined, NODE_ENV: "production" };

/** Mailgun's own domain, derived so no real host name is written outside base-url.ts (M3-DESIGN §0.2 rule 3). */
const MG = new URL(MAILGUN_HOSTS.US).hostname.replace(/^api\./, "");
const STORAGE_EU = `https://storage-europe-west1.api.${MG}`;
const STORAGE_US = `https://storage-us-east4.api.${MG}`;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("the fake-mode override (§2.5)", () => {
  it("is honoured only as http://127.0.0.1:<port>", () => {
    const db = { DATABASE_URL: "file:./data/test/x.db" };
    withEnv({ ...db, OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" }, () => {
      expect(mailgunBaseOverride()).toBe("http://127.0.0.1:4010");
      expect(isFakeMode()).toBe(true);
    });
    withEnv({ ...db, OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010/" }, () => {
      expect(mailgunBaseOverride()).toBe("http://127.0.0.1:4010");
    });
    for (const bad of [
      "http://localhost:4010",
      "https://127.0.0.1:4010",
      "http://127.0.0.2:4010",
      "http://127.0.0.1",
      "http://127.0.0.1:4010/v3",
      "http://127.0.0.1:99999",
      MAILGUN_HOSTS.EU,
    ]) {
      withEnv({ ...db, OUTREACH_MAILGUN_BASE_URL: bad }, () => {
        expect(mailgunBaseOverride(), bad).toBeNull();
        expect(isFakeMode()).toBe(false);
      });
    }
    expect(warn).toHaveBeenCalled();
  });

  it("is refused for the owner's database (app.db)", () => {
    withEnv({ DATABASE_URL: "file:./data/app.db", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" }, () => {
      expect(mailgunBaseOverride()).toBeNull();
      expect(isFakeMode()).toBe(false);
    });
    withEnv({ DATABASE_URL: "file:C:/Outreach/data/APP.DB", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4011" }, () => {
      expect(mailgunBaseOverride()).toBeNull();
    });
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("app.db"))).toBe(true);
  });
});

describe("mailgunApiBase", () => {
  it("uses the override in fake mode for both regions", () => {
    withEnv({ DATABASE_URL: "file:./data/test/x.db", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" }, () => {
      expect(mailgunApiBase("EU")).toBe("http://127.0.0.1:4010");
      expect(mailgunApiBase("US")).toBe("http://127.0.0.1:4010");
    });
  });

  it("uses Mailgun's host per region outside a test run", () => {
    withEnv({ ...PRODUCTION, OUTREACH_MAILGUN_BASE_URL: undefined }, () => {
      expect(isTestRun()).toBe(false);
      expect(mailgunApiBase("EU")).toBe(MAILGUN_HOSTS.EU);
      expect(mailgunApiBase("US")).toBe(MAILGUN_HOSTS.US);
    });
  });

  it("throws in a test run without the fake, even with NODE_ENV=production", () => {
    withEnv({ ...PRODUCTION, OUTREACH_TEST_RUN: "1", OUTREACH_MAILGUN_BASE_URL: undefined }, () => {
      expect(isTestRun()).toBe(true);
      expect(() => mailgunApiBase("EU")).toThrow("Test runs must use the fake Mailgun server (set OUTREACH_MAILGUN_BASE_URL).");
    });
    withEnv({ ...PRODUCTION, OUTREACH_TEST_RUN: "1", OUTREACH_MAILGUN_BASE_URL: "http://localhost:4010" }, () => {
      expect(() => mailgunApiBase("US")).toThrow(/fake Mailgun server/);
    });
    withEnv(
      { ...PRODUCTION, OUTREACH_TEST_RUN: "1", DATABASE_URL: "file:./data/app.db", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" },
      () => {
        expect(() => mailgunApiBase("EU")).toThrow(/fake Mailgun server/);
      },
    );
  });

  it("counts VITEST and NODE_ENV=test as test runs too", () => {
    withEnv({ OUTREACH_TEST_RUN: undefined, VITEST: "true", NODE_ENV: "production" }, () => expect(isTestRun()).toBe(true));
    withEnv({ OUTREACH_TEST_RUN: undefined, VITEST: undefined, NODE_ENV: "test" }, () => expect(isTestRun()).toBe(true));
  });
});

describe("assertAllowedBaseUrl", () => {
  it("allows Mailgun's hosts and the loopback fake outside a test run", () => {
    withEnv(PRODUCTION, () => {
      expect(() => assertAllowedBaseUrl(MAILGUN_HOSTS.EU)).not.toThrow();
      expect(() => assertAllowedBaseUrl(MAILGUN_HOSTS.US + "/")).not.toThrow();
      expect(() => assertAllowedBaseUrl("http://127.0.0.1:4010")).not.toThrow();
      for (const bad of [
        MAILGUN_HOSTS.EU.replace("https:", "http:"),
        `${MAILGUN_HOSTS.EU}.evil.com`,
        "https://evil.com",
        "http://localhost:4010",
      ]) {
        expect(() => assertAllowedBaseUrl(bad), bad).toThrow(MailgunError);
      }
    });
  });

  it("allows only the loopback fake in a test run", () => {
    withEnv({ ...PRODUCTION, OUTREACH_TEST_RUN: "1" }, () => {
      expect(() => assertAllowedBaseUrl("http://127.0.0.1:4010")).not.toThrow();
      try {
        assertAllowedBaseUrl(MAILGUN_HOSTS.EU);
        throw new Error("should refuse");
      } catch (err) {
        expect(err).toBeInstanceOf(MailgunError);
        expect((err as MailgunError).requestStarted).toBe(false);
        expect((err as MailgunError).message).toMatch(/test runs only talk to the fake/);
      }
    });
  });
});

describe("assertKeyMatchesTarget (key-fake- rules, both ways)", () => {
  const fakeKey = `${FAKE_KEY_PREFIX}api`;
  const realKey = "0123456789abcdef0123456789abcdef-12345678-12345678";

  it("sends test keys only to the fake and real keys only to Mailgun", () => {
    expect(() => assertKeyMatchesTarget(fakeKey, "http://127.0.0.1:4010")).not.toThrow();
    expect(() => assertKeyMatchesTarget(realKey, MAILGUN_HOSTS.EU)).not.toThrow();

    const toReal = (() => {
      try {
        assertKeyMatchesTarget(fakeKey, MAILGUN_HOSTS.EU);
      } catch (err) {
        return err as MailgunError;
      }
      return null;
    })();
    expect(toReal?.kind).toBe("auth");
    expect(toReal?.requestStarted).toBe(false);
    expect(toReal?.message).toBe("This is a test key. Paste the key from Mailgun › API Security.");

    expect(() => assertKeyMatchesTarget(realKey, "http://127.0.0.1:4010")).toThrow(/only takes test keys/);
  });

  it("uses the fake-mode setting when no target is given", () => {
    withEnv({ DATABASE_URL: "file:./data/test/x.db", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" }, () => {
      expect(() => assertKeyMatchesTarget(fakeKey)).not.toThrow();
      expect(() => assertKeyMatchesTarget(realKey)).toThrow(MailgunError);
    });
    withEnv({ ...PRODUCTION, OUTREACH_MAILGUN_BASE_URL: undefined }, () => {
      expect(() => assertKeyMatchesTarget(realKey)).not.toThrow();
      expect(() => assertKeyMatchesTarget(fakeKey)).toThrow(/test key/);
    });
  });
});

describe("isAllowedStorageUrl", () => {
  it("allows https Mailgun storage hosts for the real Mailgun", () => {
    withEnv(PRODUCTION, () => {
      const base = MAILGUN_HOSTS.EU;
      expect(isAllowedStorageUrl(`${STORAGE_EU}/v3/domains/d/messages/KEY`, base)).toBe(true);
      expect(isAllowedStorageUrl(`${STORAGE_US}/v3/domains/d/messages/KEY`, base)).toBe(true);
      expect(isAllowedStorageUrl(`${STORAGE_EU.replace("https:", "http:")}/v3/domains/d/messages/KEY`, base)).toBe(false);
      expect(isAllowedStorageUrl(`https://storage.${MG}.evil.com/x`, base)).toBe(false);
      expect(isAllowedStorageUrl("https://evil.com/x", base)).toBe(false);
      expect(isAllowedStorageUrl(STORAGE_US.replace("https://", "https://user:pw@") + "/x", base)).toBe(false);
      expect(isAllowedStorageUrl(`${STORAGE_US}:8443/x`, base)).toBe(false);
      expect(isAllowedStorageUrl("not a url", base)).toBe(false);
    });
  });

  it("allows only the fake's own origin in fake mode", () => {
    const base = "http://127.0.0.1:4010";
    expect(isAllowedStorageUrl("http://127.0.0.1:4010/v3/domains/d/messages/KEY", base)).toBe(true);
    expect(isAllowedStorageUrl("http://127.0.0.1:4011/v3/domains/d/messages/KEY", base)).toBe(false);
    expect(isAllowedStorageUrl(`${STORAGE_EU}/v3/domains/d/messages/KEY`, base)).toBe(false);
  });

  it("allows nothing real in a test run", () => {
    withEnv({ ...PRODUCTION, OUTREACH_TEST_RUN: "1" }, () => {
      expect(isAllowedStorageUrl(`${STORAGE_EU}/v3/x`, MAILGUN_HOSTS.EU)).toBe(false);
    });
  });
});

describe("describeMailgunTarget", () => {
  it("names the target for the settings page and the worker log", () => {
    withEnv({ DATABASE_URL: "file:./data/test/x.db", OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:4010" }, () => {
      expect(describeMailgunTarget("EU")).toBe("Test server http://127.0.0.1:4010: nothing reaches the real Mailgun");
    });
    withEnv({ ...PRODUCTION, OUTREACH_MAILGUN_BASE_URL: undefined }, () => {
      expect(describeMailgunTarget("EU")).toBe(`Mailgun EU (${MAILGUN_HOSTS.EU})`);
      expect(describeMailgunTarget("US")).toBe(`Mailgun US (${MAILGUN_HOSTS.US})`);
    });
  });
});
