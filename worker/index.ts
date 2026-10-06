// The background sender (worker) entry point. Bundled to dist/worker.mjs by scripts/build-worker.mjs
// and run by the OutreachWorker service (NSSM) or start.bat. PLAN.md B1 / B8.
//
//   node dist/worker.mjs               run until stopped (Ctrl+C, console closed, IPC {type:"shutdown"})
//   node dist/worker.mjs --self-test   connect, SELECT 1, print "worker self-test ok"; load the Milestone 5 packages,
//                                      print "packages ok"; exit 0 (exit 1 when either fails)
//   node dist/worker.mjs --once        take the lease, run start-up and one round of the loops, exit
// The background sender makes the daily and Back up now backups as tasks while it runs; update.bat, restore.bat and
// the database upgrade make their own through scripts/lib/backups.mjs (M6-DESIGN §3.2).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { log } from "./log";

// Must be set BEFORE anything imports @/server/db (it picks the worker's 10 s busy timeout).
// That's why every module that touches the database is loaded with await import() below.
process.env.OUTREACH_PROCESS = "worker";

// Modules shared with the web app (src/server/**) report problems with console.*; in the worker those lines get the
// same "<ISO time> <level> <message>" form as everything else in logs\worker.log.
console.log = (...args: unknown[]) => log.info(format(...args));
console.info = (...args: unknown[]) => log.info(format(...args));
console.warn = (...args: unknown[]) => log.warn(format(...args));
console.error = (...args: unknown[]) => log.error(format(...args));

// Stack traces in logs\*.log point at the TypeScript source (dist/worker.mjs.map).
process.setSourceMapsEnabled(true);

/** Written by update.bat while it replaces the app's parts (scripts/lib/update-marker.mjs). */
const UPDATE_MARKER = path.join(/*turbopackIgnore: true*/ process.cwd(), "run", "update-in-progress");
const UPDATE_CHECK_MS = 5_000;

/**
 * PLAN.md B11: never run a half-updated app. While update.bat hasn't finished (it stopped with an
 * error, or is still running), the worker doesn't touch the database or take any task. It waits
 * instead of exiting (the service manager would restart it over and over), and exits once
 * update.bat has finished, so the new version is started. Returns null when there's no update.
 */
async function waitWhileUpdating(once: boolean): Promise<number | null> {
  if (!fs.existsSync(UPDATE_MARKER)) return null;
  log.warn(
    "update.bat hasn't finished installing the new version (run\\update-in-progress), so the background sender " +
      "does nothing until it has. Double-click update.bat and let it finish.",
  );
  if (once) return 1;
  // Nothing to clean up while waiting: any stop request ends the process at once.
  const quit = () => process.exit(0);
  for (const sig of ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const) process.on(sig, quit);
  process.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "shutdown") quit();
  });
  if (typeof process.send === "function") process.on("disconnect", quit);
  while (fs.existsSync(UPDATE_MARKER)) await new Promise((resolve) => setTimeout(resolve, UPDATE_CHECK_MS));
  log.info("update.bat has finished. Stopping, so the new version starts.");
  return 0;
}

/**
 * `--self-test`, second half (docs/dev/M5-DESIGN.md §5.5): the bundle keeps npm packages external, so they must load
 * from node_modules at run time, in the forms the code imports them (the CJS ones through ESM interop). Loads the five
 * Milestone 5 packages, plus htmlparser2 and encoding-sniffer (cheerio's own dependencies, which the website reader
 * imports directly since the review fixes), and checks the exports the app uses; prints "packages ok", or which one
 * failed.
 */
async function packagesSelfTest(): Promise<number> {
  const checks: Array<[name: string, load: () => Promise<boolean>]> = [
    ["@anthropic-ai/sdk", async () => typeof (await import("@anthropic-ai/sdk")).default === "function"],
    ["cheerio", async () => typeof (await import("cheerio")).load === "function"],
    [
      "htmlparser2",
      async () => {
        const hp2 = await import("htmlparser2");
        return typeof hp2.Parser === "function" && typeof hp2.DomHandler === "function";
      },
    ],
    ["encoding-sniffer", async () => typeof (await import("encoding-sniffer")).decodeBuffer === "function"],
    [
      "undici",
      async () => {
        const undici = await import("undici");
        return typeof undici.fetch === "function" && typeof undici.Agent === "function" && typeof undici.buildConnector === "function";
      },
    ],
    ["robots-parser", async () => typeof (await import("robots-parser")).default === "function"],
    ["ipaddr.js", async () => typeof (await import("ipaddr.js")).default.isValid === "function"],
  ];
  for (const [name, load] of checks) {
    try {
      if (!(await load())) {
        log.error(`Self-test failed: the package ${name} loaded without the parts the app uses. Run update.bat.`);
        return 1;
      }
    } catch (err) {
      log.error(`Self-test failed: the package ${name} couldn't be loaded. Run update.bat.`, err);
      return 1;
    }
  }
  process.stdout.write("packages ok\n");
  return 0;
}

async function main(args: string[]): Promise<number> {
  if (args.includes("--self-test")) {
    const { selfTest } = await import("./main");
    const code = await selfTest();
    return code === 0 ? packagesSelfTest() : code;
  }
  const updating = await waitWhileUpdating(args.includes("--once"));
  if (updating !== null) return updating;
  // PLAN.md B11: refuse to start after a Node.js update until update.bat has reinstalled the native parts.
  const { NODE_UPDATED_MESSAGE, nodeAbiChanged } = await import("@/server/node-abi");
  if (nodeAbiChanged()) {
    log.error(NODE_UPDATED_MESSAGE);
    return 1;
  }
  const { runWorker } = await import("./main");
  return runWorker({ once: args.includes("--once") });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.error("The background sender stopped because of an unexpected problem", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
