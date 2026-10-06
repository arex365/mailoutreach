import path from "node:path";
import { databaseFilePath } from "../env";
import { isTestRun } from "../mailgun/base-url";

/**
 * Where Claude calls go (M5-DESIGN §3.5.2, §5.4, §7.4). This is the ONLY file that may contain Anthropic's real host
 * name; a unit test greps src/** and worker/** to keep it that way (the M3 Mailgun rule, copied).
 *
 * Fake mode: OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:<port>" sends every call to the local fake Claude server
 * (tests, the lead's manual checks). It is honoured only in exactly that form (never "localhost", which the Windows
 * hosts file can redirect) and never for the owner's database (data/app.db).
 *
 * Test run (OUTREACH_TEST_RUN=1, Vitest, NODE_ENV=test): without the override every Claude call is refused, so a
 * forgotten override fails instead of reaching the real API. tests/setup/env.ts points the override at a dead port.
 */

/** Anthropic's API: the only place it appears. */
export const ANTHROPIC_HOST = "https://api.anthropic.com";

/** Keys for the fake server start with this; the real Anthropic never gets one, and the fake gets nothing else. */
export const FAKE_ANTHROPIC_KEY_PREFIX = "sk-ant-fake-";

const OVERRIDE_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

/** Values already warned about, so a bad setting logs once per process, not on every call. */
const warned = new Set<string>();

function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[anthropic] ${text}`);
}

function validPort(p: string | undefined): boolean {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 && n <= 65_535;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * A base URL or key that must not be used for this target (nothing was sent). The message is written for people;
 * the Settings › AI page shows it as it is.
 */
export class ClaudeTargetError extends Error {
  readonly userFacing = true as const;
  constructor(
    message: string,
    readonly reason: "base-url" | "test-key" | "real-key-to-fake",
  ) {
    super(message);
    this.name = "ClaudeTargetError";
  }
}

/**
 * The fake-server base URL from OUTREACH_ANTHROPIC_BASE_URL when it is exactly http://127.0.0.1:<port> and the
 * database isn't the owner's app.db; otherwise null (an ignored value is logged once).
 */
export function anthropicBaseOverride(): string | null {
  const raw = trimBase(process.env.OUTREACH_ANTHROPIC_BASE_URL ?? "");
  if (!raw) return null;
  const m = OVERRIDE_PATTERN.exec(raw);
  if (!m || !validPort(m[1])) {
    warnOnce(
      `bad:${raw}`,
      `Ignoring OUTREACH_ANTHROPIC_BASE_URL=${raw}: only http://127.0.0.1:<port> is allowed (the local fake Claude server).`,
    );
    return null;
  }
  if (path.basename(databaseFilePath()).toLowerCase() === "app.db") {
    warnOnce(
      `appdb:${raw}`,
      `Refusing OUTREACH_ANTHROPIC_BASE_URL=${raw}: the fake Claude server is never used with the real database (app.db).`,
    );
    return null;
  }
  return raw;
}

/** True when every Claude call goes to the local fake server. */
export function isAnthropicFakeMode(): boolean {
  return anthropicBaseOverride() !== null;
}

/** The fake server in fake mode, else Anthropic's API. A test run without the fake throws. */
export function anthropicBaseUrl(): string {
  const override = anthropicBaseOverride();
  if (override) return override;
  if (isTestRun()) throw new Error("Test runs must use the fake Claude server (set OUTREACH_ANTHROPIC_BASE_URL).");
  return ANTHROPIC_HOST;
}

/** True for http://127.0.0.1:<port> (with or without a trailing slash). */
export function isLoopbackAnthropicBase(url: string): boolean {
  const m = LOOPBACK_ORIGIN.exec(trimBase(url));
  return Boolean(m && validPort(m[1]));
}

/**
 * Refuses any base URL except Anthropic's API (https) and http://127.0.0.1:<port>; in a test run, only the loopback
 * form. Throws ClaudeTargetError (nothing was sent).
 */
export function assertAllowedAnthropicBase(url: string): void {
  const base = trimBase(url);
  const ok = isTestRun() ? isLoopbackAnthropicBase(base) : base === ANTHROPIC_HOST || isLoopbackAnthropicBase(base);
  if (ok) return;
  throw new ClaudeTargetError(
    isTestRun()
      ? `Refused Anthropic base URL ${base}: test runs only talk to the fake Claude server (http://127.0.0.1:<port>).`
      : `Refused Anthropic base URL ${base}: only Anthropic's own API or the local fake Claude server is allowed.`,
    "base-url",
  );
}

/**
 * Test keys (sk-ant-fake-…) only go to the fake server, and the fake server only gets test keys (the M3 rule). Throws
 * ClaudeTargetError (nothing sent).
 */
export function assertAnthropicKeyMatchesTarget(apiKey: string, baseUrl: string): void {
  const toFake = isLoopbackAnthropicBase(baseUrl);
  const isFakeKey = apiKey.trim().startsWith(FAKE_ANTHROPIC_KEY_PREFIX);
  if (toFake && !isFakeKey) {
    throw new ClaudeTargetError(
      "The fake Claude server only takes test keys (sk-ant-fake-…). A real key is never sent to it.",
      "real-key-to-fake",
    );
  }
  if (!toFake && isFakeKey) {
    throw new ClaudeTargetError("This is a test key. Paste a key from the Anthropic Console.", "test-key");
  }
}

/** For the settings page and the worker's start-up log: where Claude calls go right now. */
export function describeAnthropicTarget(): string {
  const override = anthropicBaseOverride();
  if (override) return `Test server ${override}: nothing reaches the real Anthropic API`;
  if (isTestRun()) return "Test run without the fake Claude server: every Claude call is refused";
  return `Anthropic (${ANTHROPIC_HOST})`;
}
