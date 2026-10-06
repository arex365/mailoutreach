import path from "node:path";
import { databaseFilePath } from "../env";
import { MailgunError } from "./errors";
import type { MailgunRegion } from "./types";

/**
 * Where Mailgun calls go (M3-DESIGN §2.5, §6.4). This is the ONLY file that may contain Mailgun's real host names;
 * a unit test greps src/** and worker/** to keep it that way.
 *
 * Fake mode: OUTREACH_MAILGUN_BASE_URL = "http://127.0.0.1:<port>" sends every call to the local fake Mailgun server
 * (tests, the lead's manual checks, the screen checks). It is honoured only in exactly that form (never "localhost",
 * which the Windows hosts file can redirect) and never for the owner's database (data/app.db).
 *
 * Test run: OUTREACH_TEST_RUN=1 (also VITEST or NODE_ENV=test). A test run refuses every Mailgun host except the fake,
 * even though run-prod and the services force NODE_ENV=production.
 */

/** Mailgun's REST API per region: the only place these appear. */
export const MAILGUN_HOSTS = { EU: "https://api.eu.mailgun.net", US: "https://api.mailgun.net" } as const;
/** Mailgun's own domain; message storage hosts are its subdomains (storage-*.api.mailgun.net). */
const MAILGUN_DOMAIN_SUFFIX = ".mailgun.net";

/** Keys for the fake server start with this; the real Mailgun never gets one, and the fake gets nothing else. */
export const FAKE_KEY_PREFIX = "key-fake-";

const OVERRIDE_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

/** OUTREACH_TEST_RUN === "1", or running under Vitest, or NODE_ENV === "test". */
export function isTestRun(): boolean {
  return process.env.OUTREACH_TEST_RUN === "1" || Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/** Values already warned about, so a bad setting logs once per process, not on every call. */
const warned = new Set<string>();

function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[mailgun] ${text}`);
}

function validPort(p: string | undefined): boolean {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 && n <= 65_535;
}

/**
 * The fake-server base URL from OUTREACH_MAILGUN_BASE_URL when it is exactly http://127.0.0.1:<port> and the database
 * isn't the owner's app.db; otherwise null (an ignored value is logged once).
 */
export function mailgunBaseOverride(): string | null {
  const raw = (process.env.OUTREACH_MAILGUN_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  const m = OVERRIDE_PATTERN.exec(raw);
  if (!m || !validPort(m[1])) {
    warnOnce(
      `bad:${raw}`,
      `Ignoring OUTREACH_MAILGUN_BASE_URL=${raw}: only http://127.0.0.1:<port> is allowed (the local fake Mailgun server).`,
    );
    return null;
  }
  if (path.basename(databaseFilePath()).toLowerCase() === "app.db") {
    warnOnce(
      `appdb:${raw}`,
      `Refusing OUTREACH_MAILGUN_BASE_URL=${raw}: the fake Mailgun server is never used with the real database (app.db).`,
    );
    return null;
  }
  return raw;
}

/** True when every Mailgun call goes to the local fake server. */
export function isFakeMode(): boolean {
  return mailgunBaseOverride() !== null;
}

/** The fake server's base URL in fake mode, else the region's Mailgun host. A test run without the fake throws. */
export function mailgunApiBase(region: MailgunRegion): string {
  const override = mailgunBaseOverride();
  if (override) return override;
  if (isTestRun()) throw new Error("Test runs must use the fake Mailgun server (set OUTREACH_MAILGUN_BASE_URL).");
  return region === "US" ? MAILGUN_HOSTS.US : MAILGUN_HOSTS.EU;
}

/** True for http://127.0.0.1:<port> (with or without a trailing slash). */
export function isLoopbackBase(url: string): boolean {
  const m = LOOPBACK_ORIGIN.exec(url.trim().replace(/\/+$/, ""));
  return Boolean(m && validPort(m[1]));
}

/**
 * Refuses any base URL except Mailgun's two API hosts (https) and http://127.0.0.1:<port>; in a test run, only the
 * loopback form. Throws a MailgunError (nothing was sent) so callers handle it like any other Mailgun failure.
 */
export function assertAllowedBaseUrl(url: string): void {
  const base = url.trim().replace(/\/+$/, "");
  const real = base === MAILGUN_HOSTS.EU || base === MAILGUN_HOSTS.US;
  const ok = isTestRun() ? isLoopbackBase(base) : real || isLoopbackBase(base);
  if (ok) return;
  throw new MailgunError({
    kind: "unexpected",
    requestStarted: false,
    message: isTestRun()
      ? `Refused Mailgun base URL ${base}: test runs only talk to the fake Mailgun server (http://127.0.0.1:<port>).`
      : `Refused Mailgun base URL ${base}: only Mailgun's own API hosts or the local fake server are allowed.`,
  });
}

/**
 * Test keys (key-fake-…) only go to the fake server, and the fake server only gets test keys. `baseUrl` is the
 * target of the call; without it the fake-mode setting decides. Throws a plain MailgunError "auth" (nothing sent).
 */
export function assertKeyMatchesTarget(apiKey: string, baseUrl?: string): void {
  const toFake = baseUrl !== undefined ? isLoopbackBase(baseUrl) : isFakeMode();
  const isFakeKey = apiKey.trim().startsWith(FAKE_KEY_PREFIX);
  if (toFake && !isFakeKey) {
    throw new MailgunError({
      kind: "auth",
      requestStarted: false,
      message: "The fake Mailgun server only takes test keys (key-fake-…). A real key is never sent to it.",
    });
  }
  if (!toFake && isFakeKey) {
    throw new MailgunError({
      kind: "auth",
      requestStarted: false,
      message: "This is a test key. Paste the key from Mailgun › API Security.",
    });
  }
}

/**
 * Where a stored email may be fetched from (research §0.1): https on a Mailgun host (*.mailgun.net) for the real
 * Mailgun, or exactly the fake server's own origin when `baseUrl` is the fake. The key is never sent anywhere else.
 */
export function isAllowedStorageUrl(url: string, baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (isLoopbackBase(baseUrl)) return u.origin === new URL(baseUrl.trim()).origin;
  if (isTestRun()) return false;
  return u.protocol === "https:" && u.port === "" && u.hostname.toLowerCase().endsWith(MAILGUN_DOMAIN_SUFFIX);
}

/** For the settings page and the worker's start-up log: where Mailgun calls go right now. */
export function describeMailgunTarget(region: MailgunRegion): string {
  const override = mailgunBaseOverride();
  if (override) return `Test server ${override}: nothing reaches the real Mailgun`;
  if (isTestRun()) return "Test run without the fake Mailgun server: every Mailgun call is refused";
  return `Mailgun ${region} (${region === "US" ? MAILGUN_HOSTS.US : MAILGUN_HOSTS.EU})`;
}
