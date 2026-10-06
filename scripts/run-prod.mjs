// start.bat (when the background services are NOT installed) → node scripts/run-prod.mjs --open
// Runs the app and the background sender in this window until it is closed or stop.bat is used.
//
// Options (each also as an environment variable, for reuse):
//   --port <n>          PORT                    default 3000
//   --host <ip>         OUTREACH_HOST           default 0.0.0.0 (reachable from the office)
//   --db <path>         OUTREACH_DATABASE_URL   default DATABASE_URL from .env
//   --log-prefix <p>    OUTREACH_LOG_PREFIX     logs\<p>web-YYYY-MM-DD.log, logs\<p>worker-…
//   --pid-file <path>   OUTREACH_PID_FILE       default run\supervisor.pid
//   --stop-file <path>  OUTREACH_STOP_FILE      default run\stop.request
//   --no-build                                  never build (refuse when there is no build)
//   --open                                      open the browser once the app answers
//   --no-public-address                         test runs only: no public address at all (see below)
//
// A database other than the app's own (.env's DATABASE_URL) is a test run (M3-DESIGN §2.5): the app and the
// background sender get OUTREACH_TEST_RUN=1, so every Mailgun call is refused unless OUTREACH_MAILGUN_BASE_URL
// points at the local fake Mailgun server (http://127.0.0.1:<port>). A forgotten fake never reaches the real Mailgun.
// A test run also gets APP_PUBLIC_URL=http://127.0.0.1:<port> (unless this window already set a loopback one), so the
// remote-access checks never reach .env's real Cloudflare address (M6-DESIGN §0.2 rule 13, §3.9).
// With --no-public-address (MAIN-DOMAIN-DESIGN §8 P8, the own-mailbox screen checks) a test run has no public address
// at all, like an office PC without remote access: APP_PUBLIC_URL is emptied for the app and the background sender
// instead of set to a loopback one (empty, not left out, so neither .env nor the app's own .env loading fills it in).
// The option is refused on the app's own database.
// Its "Before a database upgrade" backup goes to that database's own folder, backups\<file name without .db>\
// (premigrateBackupsDir in lib/supervisor.mjs), never among the real app's backups (review fix SECURITY-05).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PATHS, ROOT } from "./lib/paths.mjs";
import { databasePathFromUrl, databaseUrlFor } from "./lib/env-file.mjs";
import { readEnvFile, runSupervisor } from "./lib/supervisor.mjs";
import * as ui from "./lib/ui.mjs";

/**
 * True when `databaseUrl` names another file than the app's own database (.env's DATABASE_URL, or data\app.db when
 * .env has none). No `databaseUrl` means the app's own. Paths are compared resolved and case-insensitively (Windows).
 */
export function isOtherDatabase(databaseUrl, envDatabaseUrl, root = ROOT) {
  if (!databaseUrl) return false;
  const mine = path.resolve(databasePathFromUrl(databaseUrl, root)).toLowerCase();
  const app = path.resolve(databasePathFromUrl(envDatabaseUrl || "file:./data/app.db", root)).toLowerCase();
  return mine !== app;
}

/** True for an http(s) address on this PC only (127.0.0.1, localhost or ::1). */
export function isLoopbackUrl(url) {
  try {
    const h = new URL(String(url ?? "").trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

/** Why `--no-public-address` was refused: it would take the public address away from the real app. */
export const NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS = "--no-public-address is only for test runs on another database.";

/**
 * The extra environment for the app and the background sender. On another database (a test run): OUTREACH_TEST_RUN=1,
 * and APP_PUBLIC_URL=http://127.0.0.1:<port> unless `publicUrl` (this window's APP_PUBLIC_URL) is already a loopback
 * address. Nothing extra on the app's own database.
 *
 * `noPublicAddress` (the --no-public-address option, MAIN-DOMAIN-DESIGN §8 P8): a test run gets APP_PUBLIC_URL="" (no
 * public address, whatever this window or .env says) instead of a loopback one; on the app's own database it throws
 * NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS.
 * @param {string | undefined} databaseUrl
 * @param {string | undefined} envDatabaseUrl  .env's DATABASE_URL
 * @param {string} [root]
 * @param {{ port?: number, publicUrl?: string | undefined, noPublicAddress?: boolean }} [opts]
 * @returns {{ OUTREACH_TEST_RUN?: string, APP_PUBLIC_URL?: string }}
 */
export function testRunEnv(databaseUrl, envDatabaseUrl, root = ROOT, { port = 3000, publicUrl = undefined, noPublicAddress = false } = {}) {
  const other = isOtherDatabase(databaseUrl, envDatabaseUrl, root);
  if (noPublicAddress && !other) throw new Error(NO_PUBLIC_ADDRESS_ONLY_FOR_TESTS);
  if (!other) return {};
  // Empty rather than left out: the child starts from this window's environment, and the app and the background sender
  // would otherwise read the value from .env (dotenv and Next.js never replace a variable that is set, even to "").
  if (noPublicAddress) return { OUTREACH_TEST_RUN: "1", APP_PUBLIC_URL: "" };
  return isLoopbackUrl(publicUrl) ? { OUTREACH_TEST_RUN: "1" } : { OUTREACH_TEST_RUN: "1", APP_PUBLIC_URL: `http://127.0.0.1:${port}` };
}

async function main() {
  let values;
  try {
    values = parseArgs({
      options: {
        port: { type: "string" },
        host: { type: "string" },
        db: { type: "string" },
        "log-prefix": { type: "string" },
        "pid-file": { type: "string" },
        "stop-file": { type: "string" },
        "no-build": { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        "no-public-address": { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch (err) {
    ui.fail(String(err instanceof Error ? err.message : err));
    return 2;
  }

  const port = Number(values.port ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ui.fail(`"${values.port ?? process.env.PORT}" isn't a valid port number.`);
    return 2;
  }
  const fromRoot = (p) => (p ? path.resolve(ROOT, p) : undefined);
  const databaseUrl = values.db ? databaseUrlFor(values.db, ROOT) : process.env.OUTREACH_DATABASE_URL || undefined;

  const noPublicAddress = values["no-public-address"] === true;
  let extraEnv;
  try {
    extraEnv = testRunEnv(databaseUrl, readEnvFile(PATHS.env).DATABASE_URL, ROOT, { port, publicUrl: process.env.APP_PUBLIC_URL, noPublicAddress });
  } catch (err) {
    ui.fail(String(err instanceof Error ? err.message : err));
    return 2;
  }
  if (extraEnv.OUTREACH_TEST_RUN) {
    const base = (process.env.OUTREACH_MAILGUN_BASE_URL ?? "").trim();
    ui.info("This isn't the app's own database, so this is a test run: Mailgun calls only go to the local fake Mailgun");
    ui.info(base ? `server (OUTREACH_MAILGUN_BASE_URL=${base}).` : "server, and OUTREACH_MAILGUN_BASE_URL isn't set, so every Mailgun call is refused.");
    ui.info(
      noPublicAddress
        ? "It has no public address, like an office PC without remote access: Mailgun's reports come through the hourly check."
        : `Its public address is ${extraEnv.APP_PUBLIC_URL ?? process.env.APP_PUBLIC_URL}, on this PC only.`,
    );
  }

  return runSupervisor({
    port,
    host: values.host ?? process.env.OUTREACH_HOST ?? "0.0.0.0",
    databaseUrl,
    logPrefix: values["log-prefix"] ?? process.env.OUTREACH_LOG_PREFIX ?? "",
    pidFile: fromRoot(values["pid-file"] ?? process.env.OUTREACH_PID_FILE) ?? PATHS.supervisorPid,
    stopFile: fromRoot(values["stop-file"] ?? process.env.OUTREACH_STOP_FILE) ?? PATHS.stopRequest,
    allowBuild: !values["no-build"],
    openBrowser: values.open,
    extraEnv,
  });
}

/**
 * True when this file is the program being run (start.bat, the lead's checks), not a module a test imported for the
 * helpers above. Compared case-insensitively (Windows drive letters), and by name as a fallback, so start.bat can
 * never end up doing nothing.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (pathToFileURL(path.resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase()) return true;
  return path.basename(entry).toLowerCase().replace(/\.mjs$/, "") === "run-prod";
}

if (isEntryPoint()) process.exit(await main());
