import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_HOST,
  anthropicBaseOverride,
  anthropicBaseUrl,
  assertAllowedAnthropicBase,
  assertAnthropicKeyMatchesTarget,
  ClaudeTargetError,
  describeAnthropicTarget,
  isAnthropicFakeMode,
  isLoopbackAnthropicBase,
} from "@/server/anthropic/base-url";
import { createClaudeApi } from "@/server/anthropic/client";

/** M5-DESIGN §3.5.2, §5.4, §7.4: where Claude calls go, and the guards. Nothing here opens a connection. */

const ENV_KEYS = ["OUTREACH_ANTHROPIC_BASE_URL", "DATABASE_URL", "OUTREACH_TEST_RUN", "VITEST", "NODE_ENV"] as const;
/** process.env without Next's read-only NODE_ENV typing. */
const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** Runs `fn` as if this weren't a test run (the real app), then puts the environment back. */
function outsideTestRun<T>(fn: () => T): T {
  const keep = { t: env.OUTREACH_TEST_RUN, v: env.VITEST, n: env.NODE_ENV };
  delete env.OUTREACH_TEST_RUN;
  delete env.VITEST;
  env.NODE_ENV = "production";
  try {
    return fn();
  } finally {
    if (keep.t !== undefined) env.OUTREACH_TEST_RUN = keep.t;
    if (keep.v !== undefined) env.VITEST = keep.v;
    if (keep.n === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = keep.n;
  }
}

describe("anthropicBaseOverride", () => {
  it("honours exactly http://127.0.0.1:<port>", () => {
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:4020";
    expect(anthropicBaseOverride()).toBe("http://127.0.0.1:4020");
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:4020/";
    expect(anthropicBaseOverride()).toBe("http://127.0.0.1:4020");
    expect(isAnthropicFakeMode()).toBe(true);
  });

  it("the test setup's default is the dead port 19", () => {
    expect(saved.OUTREACH_ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:19");
    process.env.OUTREACH_ANTHROPIC_BASE_URL = saved.OUTREACH_ANTHROPIC_BASE_URL;
    expect(anthropicBaseOverride()).toBe("http://127.0.0.1:19");
  });

  it("ignores anything else (logged once)", () => {
    for (const bad of [
      "http://localhost:4020",
      "https://127.0.0.1:4020",
      "http://127.0.0.1:4020/v1",
      "http://127.0.0.1:9",
      "http://127.0.0.1:99999",
      "http://127.0.0.2:4020",
      "http://evil.invalid",
      "https://api.anthropic.com",
    ]) {
      process.env.OUTREACH_ANTHROPIC_BASE_URL = bad;
      expect(anthropicBaseOverride()).toBeNull();
    }
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "";
    expect(anthropicBaseOverride()).toBeNull();
    expect(isAnthropicFakeMode()).toBe(false);
  });

  it("is never used with the owner's database (app.db)", () => {
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:4020";
    process.env.DATABASE_URL = "file:./data/app.db";
    expect(anthropicBaseOverride()).toBeNull();
    process.env.DATABASE_URL = "file:./data/APP.DB";
    expect(anthropicBaseOverride()).toBeNull();
    process.env.DATABASE_URL = "file:./data/manual-m5.db";
    expect(anthropicBaseOverride()).toBe("http://127.0.0.1:4020");
  });
});

describe("anthropicBaseUrl", () => {
  it("is the override when set", () => {
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:4020";
    expect(anthropicBaseUrl()).toBe("http://127.0.0.1:4020");
  });

  it("throws in a test run without the override", () => {
    delete process.env.OUTREACH_ANTHROPIC_BASE_URL;
    expect(() => anthropicBaseUrl()).toThrow("Test runs must use the fake Claude server (set OUTREACH_ANTHROPIC_BASE_URL).");
    process.env.OUTREACH_ANTHROPIC_BASE_URL = "http://localhost:4020";
    expect(() => anthropicBaseUrl()).toThrow(/fake Claude server/);
    expect(describeAnthropicTarget()).toBe("Test run without the fake Claude server: every Claude call is refused");
  });

  it("is Anthropic's API in the real app", () => {
    delete process.env.OUTREACH_ANTHROPIC_BASE_URL;
    expect(outsideTestRun(() => anthropicBaseUrl())).toBe(ANTHROPIC_HOST);
    expect(outsideTestRun(() => describeAnthropicTarget())).toBe(`Anthropic (${ANTHROPIC_HOST})`);
  });
});

describe("assertAllowedAnthropicBase", () => {
  it("allows only the fake in a test run", () => {
    expect(() => assertAllowedAnthropicBase("http://127.0.0.1:4020")).not.toThrow();
    expect(isLoopbackAnthropicBase("http://127.0.0.1:4020/")).toBe(true);
    for (const bad of [ANTHROPIC_HOST, "http://evil.invalid", "http://localhost:4020", "https://127.0.0.1:4020"]) {
      expect(() => assertAllowedAnthropicBase(bad)).toThrow(ClaudeTargetError);
    }
  });

  it("allows Anthropic's API and the fake in the real app, nothing else", () => {
    outsideTestRun(() => {
      expect(() => assertAllowedAnthropicBase(ANTHROPIC_HOST)).not.toThrow();
      expect(() => assertAllowedAnthropicBase(`${ANTHROPIC_HOST}/`)).not.toThrow();
      expect(() => assertAllowedAnthropicBase("http://127.0.0.1:4020")).not.toThrow();
      expect(() => assertAllowedAnthropicBase("http://api.anthropic.com")).toThrow(ClaudeTargetError);
      expect(() => assertAllowedAnthropicBase("https://evil.invalid")).toThrow(ClaudeTargetError);
    });
  });
});

describe("assertAnthropicKeyMatchesTarget", () => {
  it("a test key only goes to the fake, and the fake only gets test keys", () => {
    expect(() => assertAnthropicKeyMatchesTarget("sk-ant-fake-key", "http://127.0.0.1:4020")).not.toThrow();
    expect(() => assertAnthropicKeyMatchesTarget("sk-ant-api03-realkey", ANTHROPIC_HOST)).not.toThrow();
    try {
      assertAnthropicKeyMatchesTarget("sk-ant-api03-realkey", "http://127.0.0.1:4020");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeTargetError);
      expect((err as ClaudeTargetError).reason).toBe("real-key-to-fake");
      expect((err as Error).message).not.toContain("realkey");
    }
    try {
      assertAnthropicKeyMatchesTarget("sk-ant-fake-key", ANTHROPIC_HOST);
      expect.unreachable();
    } catch (err) {
      expect((err as ClaudeTargetError).reason).toBe("test-key");
      expect((err as Error).message).toBe("This is a test key. Paste a key from the Anthropic Console.");
    }
  });

  it("createClaudeApi refuses a real host or a mismatched key before sending anything", () => {
    expect(() => createClaudeApi("sk-ant-fake-key", ANTHROPIC_HOST)).toThrow(ClaudeTargetError);
    expect(() => createClaudeApi("sk-ant-api03-realkey", "http://127.0.0.1:4020")).toThrow(ClaudeTargetError);
    expect(() => createClaudeApi("sk-ant-fake-key", "http://127.0.0.1:4020")).not.toThrow();
  });
});
