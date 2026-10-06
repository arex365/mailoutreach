// start.bat without background services: checks, upgrades the database, builds when needed,
// then runs the app (next start) and the background sender side by side, restarts them if they
// crash, writes their output to logs\, and stops both cleanly (PLAN.md B11).
// start-demo.bat reuses this with another port, database, log names and pid file.
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PATHS, ROOT, displayPath, inRoot } from "./paths.mjs";
import * as ui from "./ui.mjs";
import { NODE_UPDATED_MESSAGE, abiStatus, checkNodeVersion, dependenciesState, readRecordedAbi } from "./node-check.mjs";
import { databasePathFromUrl, parseEnv } from "./env-file.mjs";
import { migrationStatus, runMigrateDeploy } from "./migrations.mjs";
import { appBackupFolder, makeBackup } from "./backups.mjs";
import { buildState, runBuild } from "./build.mjs";
import { RestartPolicy } from "./restart-policy.mjs";
import { lanUrls } from "./lan.mjs";
import { UPDATE_UNFINISHED_MESSAGE, updateInProgress } from "./update-marker.mjs";
import {
  claimPidFile,
  isPidAlive,
  killTree,
  openInBrowser,
  portInUse,
  readPidFile,
  removeFile,
  sleep,
  supervisorState,
  waitForHealth,
} from "./proc.mjs";

const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Appends lines to logs\<base>-YYYY-MM-DD.log (a new file each day). */
export class DailyLog {
  constructor(dir, base) {
    this.dir = dir;
    this.base = base;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(date = new Date()) {
    return path.join(this.dir, `${this.base}-${localDay(date)}.log`);
  }

  write(line) {
    const now = new Date();
    try {
      fs.appendFileSync(this.fileFor(now), `${localStamp(now)} ${line}\n`, "utf8");
    } catch {
      /* a full disk must not stop the app */
    }
  }
}

/** Checks shared by start.bat, start-demo.bat and update.bat. */
export function preflight() {
  const warnings = [];
  const node = checkNodeVersion();
  if (!node.ok) return { ok: false, message: node.message, warnings };
  if (node.recommendUpgrade) warnings.push(node.message);
  const deps = dependenciesState();
  if (deps === "missing") {
    return { ok: false, message: "The app's parts aren't installed yet. Double-click setup.bat first.", warnings };
  }
  if (deps === "outdated") {
    return { ok: false, message: "The app's parts are out of date (package-lock.json changed). Double-click update.bat first.", warnings };
  }
  const abi = abiStatus(readRecordedAbi(PATHS.abiFile));
  if (abi === "missing") return { ok: false, message: "Setup hasn't finished on this PC yet. Double-click setup.bat first.", warnings };
  if (abi === "changed") return { ok: false, message: NODE_UPDATED_MESSAGE, warnings };
  if (!fs.existsSync(PATHS.env)) {
    return {
      ok: false,
      message: "The settings file (.env) is missing. If you have a saved copy of .env, put it back in this folder. Otherwise double-click setup.bat.",
      warnings,
    };
  }
  return { ok: true, warnings };
}

export function readEnvFile(file = PATHS.env) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Where a database's "Before a database upgrade" backup goes (review fix SECURITY-05): the app's own database (.env's
 * DATABASE_URL, or data\app.db when .env has none) keeps it in backups\, as always; any other database (a test or
 * manual-check database that run-prod.mjs --db starts) in its own folder, backups\<file name without .db>\, the folder
 * the app's backupFolderFor gives it. So a test database's copy is never listed, restored or kept as the real app's.
 * Paths are compared resolved and case-insensitively (Windows).
 * @param {string | undefined} databaseUrl  the database being upgraded (none: the app's own)
 * @param {string | undefined} envDatabaseUrl  .env's DATABASE_URL
 * @param {string} [root]
 */
export function premigrateBackupsDir(databaseUrl, envDatabaseUrl, root = ROOT) {
  const appDb = path.resolve(databasePathFromUrl(envDatabaseUrl || "file:./data/app.db", root));
  const dbFile = databaseUrl ? path.resolve(databasePathFromUrl(databaseUrl, root)) : appDb;
  if (dbFile.toLowerCase() === appDb.toLowerCase()) return path.join(root, "backups");
  return appBackupFolder(dbFile, root);
}

/**
 * Brings a database up to date: nothing when every migration is applied; otherwise a backup
 * (when asked and the file exists) into `backupsDir` followed by prisma migrate deploy (`migrate`, a stand-in in tests).
 */
export async function ensureMigrated({ databaseUrl, backup = true, backupsDir = PATHS.backupsDir, log = ui.info, migrate = runMigrateDeploy }) {
  const dbFile = databasePathFromUrl(databaseUrl, ROOT);
  const status = await migrationStatus(dbFile);
  if (status.dbExists && status.pending && status.pending.length === 0) return { ok: true, changed: false, backupFile: null };
  let backupFile = null;
  if (status.dbExists && backup) {
    try {
      const b = await makeBackup("premigrate", dbFile, backupsDir);
      backupFile = b.file;
      log(`Backed up the database first: ${displayPath(b.file)}`);
    } catch (err) {
      return {
        ok: false,
        backupFile: null,
        message: `The database needs an upgrade, but the backup before it failed, so nothing was changed. ${err instanceof Error ? err.message : err}`,
      };
    }
  }
  log(status.dbExists ? "Upgrading the database to the new version..." : "Creating the database...");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const r = migrate(databaseUrl);
  if (!r.ok) {
    return {
      ok: false,
      backupFile,
      output: r.output,
      message:
        "The database upgrade failed." +
        (backupFile ? ` Your data was backed up just before it: ${displayPath(backupFile)}.` : "") +
        `\n\nDetails:\n${r.output}`,
    };
  }
  return { ok: true, changed: true, backupFile };
}

// --- What a start.bat window is busy with (run\supervisor.phase next to run\supervisor.pid) ---
// While it upgrades the database or builds the app, stop.bat / update.bat / restore.bat must not
// end it: a killed `prisma migrate deploy` can leave the database's upgrade history broken.

/** Phases during which the window must not be ended. */
export const BUSY_PHASES = ["migrating", "building"];

export function phaseFileFor(pidFile) {
  return pidFile.replace(/\.pid$/i, "") + ".phase";
}

export function writePhase(pidFile, phase, pid = process.pid) {
  try {
    fs.writeFileSync(phaseFileFor(pidFile), JSON.stringify({ pid, phase, since: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    /* only a hint for stop.bat */
  }
}

/** The phase of the process `pid` ({ phase, since }), or null (no file, or another process's). */
export function readPhase(pidFile, pid) {
  try {
    const data = JSON.parse(fs.readFileSync(phaseFileFor(pidFile), "utf8"));
    if (!data || typeof data.phase !== "string" || (pid != null && data.pid !== pid)) return null;
    return { phase: data.phase, since: typeof data.since === "string" ? data.since : null };
  } catch {
    return null;
  }
}

export function clearPhase(pidFile, pid = process.pid) {
  if (readPhase(pidFile, pid)) removeFile(phaseFileFor(pidFile));
}

/**
 * start.bat's "port already in use" sentence. The second sentence names the likeliest cause on the owner's PC, a
 * window still running `npm run dev` (MAIN-DOMAIN-DESIGN §8 P8, O30; every mode).
 */
export function portBusyMessage(port) {
  return (
    `Port ${port} is already in use, so the app can't start. ` +
    "If you started the app with npm run dev, close that window first (click in it and press Ctrl+C). " +
    `The app may already be running: try ` +
    `http://localhost:${port} in your browser. If the background services are installed, use start.bat and stop.bat ` +
    `to control them. Otherwise close the program that uses port ${port}, or restart the PC.`
  );
}

function waitForExit(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const isRunning = (child) => Boolean(child) && child.exitCode === null && child.signalCode === null;

/**
 * Runs the web app and the background sender side by side. Exported for tests, which pass
 * small stand-in programs through the webArgs / workerEntry options.
 */
export class Supervisor {
  constructor(o, databaseUrl, envValues = {}) {
    this.o = o;
    this.envValues = envValues;
    this.stopping = false;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    const logs = o.logsDir ?? PATHS.logsDir;
    this.ownLog = new DailyLog(logs, `${o.logPrefix}start`);
    const common = {
      ...process.env,
      ...o.extraEnv,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "production",
      PORT: String(o.port),
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      DOTENV_CONFIG_QUIET: "true",
    };
    this.webEnv = common;
    this.workerEnv = { ...common, OUTREACH_PROCESS: "worker" };
    this.procs = {
      web: {
        label: "The app",
        prefix: "[app]   ",
        log: new DailyLog(logs, `${o.logPrefix}web`),
        child: null,
        startedAt: 0,
        timer: null,
        // "max 5 times in 10 minutes", then give up with a clear message.
        policy: new RestartPolicy({ maxRestarts: 5, windowMs: 10 * 60_000, baseDelayMs: 1000, maxDelayMs: 30_000, ...o.webPolicy }),
      },
      worker: {
        label: "The background sender",
        prefix: "[sender]",
        log: new DailyLog(logs, `${o.logPrefix}worker`),
        child: null,
        startedAt: 0,
        timer: null,
        policy: new RestartPolicy({ baseDelayMs: 2000, maxDelayMs: 60_000, ...o.workerPolicy }),
      },
    };
  }

  note(message) {
    console.log(`${ui.dim("[start] ")} ${message}`);
    this.ownLog.write(message);
  }

  pipe(stream, p) {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      console.log(`${ui.dim(p.prefix)} ${line}`);
      p.log.write(line);
    });
  }

  workerCommand() {
    if (this.o.workerEntry) return { execArgv: [], ...this.o.workerEntry, env: this.workerEnv };
    if (fs.existsSync(PATHS.workerBundle)) return { entry: PATHS.workerBundle, execArgv: [], env: this.workerEnv };
    if (fs.existsSync(PATHS.workerSource)) {
      return {
        entry: PATHS.workerSource,
        execArgv: ["--import", "tsx"],
        env: { ...this.workerEnv, TSX_TSCONFIG_PATH: inRoot("tsconfig.worker.json") },
        fromSource: true,
      };
    }
    return null;
  }

  start(kind) {
    const p = this.procs[kind];
    p.timer = null;
    if (this.stopping) return;
    let child;
    try {
      if (kind === "web") {
        const args = this.o.webArgs ?? [PATHS.nextCli, "start", "-H", this.o.host, "-p", String(this.o.port), "--keepAliveTimeout", "100000"];
        child = spawn(process.execPath, args, { cwd: ROOT, env: this.webEnv, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        const cmd = this.workerCommand();
        if (!cmd) {
          this.note("The background sender isn't built yet (no dist\\worker.mjs), so only the screens are running and nothing is sent.");
          return;
        }
        if (cmd.fromSource && !p.toldFromSource) {
          this.note("Running the background sender from its source files, because dist\\worker.mjs doesn't exist.");
          p.toldFromSource = true;
        }
        child = fork(cmd.entry, [], { cwd: ROOT, env: cmd.env, execArgv: cmd.execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        child.on("message", () => undefined); // the worker may report; nothing to do with it here
      }
    } catch (err) {
      this.note(`Couldn't start ${p.label.toLowerCase()}: ${err instanceof Error ? err.message : err}`);
      p.startedAt = Date.now();
      this.onExit(kind, null, null, null, true);
      return;
    }
    p.child = child;
    p.startedAt = Date.now();
    this.pipe(child.stdout, p);
    this.pipe(child.stderr, p);
    child.once("error", (err) => {
      this.note(`${p.label} couldn't run: ${err.message}`);
      if (!child.pid) this.onExit(kind, child, null, null);
    });
    child.once("exit", (code, signal) => this.onExit(kind, child, code, signal));
  }

  onExit(kind, child, code, signal, force = false) {
    const p = this.procs[kind];
    if (!force && p.child !== child) return;
    p.child = null;
    const uptime = Date.now() - p.startedAt;
    if (this.stopping) return;
    // Wait a moment: after Ctrl+C every program in the window stops at once, and the
    // stop signal for this helper may arrive just after the child's exit.
    setTimeout(() => {
      if (this.stopping) return;
      this.note(`${p.label} stopped unexpectedly (exit code ${code ?? signal ?? "unknown"}).`);
      const d = p.policy.crashed(Date.now(), uptime);
      if (!d.restart) {
        this.note(
          `${p.label} stopped ${d.recentCrashes} times in 10 minutes, so start.bat has given up. ` +
            `The reason is in ${displayPath(p.log.fileFor())}. Fix it (or restart the PC), then double-click start.bat again.`,
        );
        void this.shutdown("it kept stopping", 1);
        return;
      }
      this.note(`Starting ${p.label.toLowerCase()} again in ${Math.max(1, Math.round(d.delayMs / 1000))} s...`);
      p.timer = setTimeout(() => this.start(kind), d.delayMs);
    }, 1000);
  }

  printBanner(health) {
    if (this.o.printBanner) {
      this.o.printBanner({ port: this.o.port, health });
      return;
    }
    const port = this.o.port;
    const lines = [`${this.o.label} is running.`, "", `On this PC:            http://localhost:${port}`];
    if (this.o.host === "0.0.0.0") {
      const lan = lanUrls(port);
      lan.forEach((a, i) => lines.push(`${i === 0 ? "Office computers:     " : "                      "} ${a.url}`));
      if (lan.length === 0) lines.push("Office computers:      (no office network found right now)");
    }
    const publicUrl = (this.envValues.APP_PUBLIC_URL ?? "").trim();
    lines.push(`Remote staff (https):  ${publicUrl || "not set up yet (see docs\\setup\\3-cloudflare.md)"}`);
    lines.push("");
    lines.push("Keep this window open while the app is in use.");
    lines.push("To stop it: close this window, press Ctrl+C, or double-click stop.bat.");
    console.log("");
    ui.box(lines);
    if (!health.healthy) {
      this.note(
        health.status === 200
          ? "The app answers, but it reports a database problem. Read the messages above."
          : `The app answers, but its health check replied ${health.status}. Read the messages above.`,
      );
    }
  }

  /**
   * Stops both programs. `consoleSignal` is true when the stop comes from the console itself
   * (Ctrl+C, Ctrl+Break, closing the window): Windows sends that event to every program in the
   * window, so the background sender already got it and is stopping. Sending it the IPC stop
   * message as well would count as a second request and make it quit without cleaning up.
   */
  async shutdown(reason, code = 0, { consoleSignal = false } = {}) {
    if (this.stopping) {
      // A second Ctrl+C: don't wait any longer.
      for (const p of Object.values(this.procs)) if (isRunning(p.child)) killTree(p.child.pid);
      return;
    }
    this.stopping = true;
    clearInterval(this.stopWatcher);
    for (const p of Object.values(this.procs)) if (p.timer) clearTimeout(p.timer);
    this.note(`Stopping (${reason})...`);
    const worker = this.procs.worker.child;
    if (isRunning(worker)) {
      if (!consoleSignal) {
        try {
          worker.send({ type: "shutdown" });
        } catch {
          /* the channel is already closed */
        }
      }
      const waitMs = this.o.workerStopTimeoutMs ?? 8000;
      const exited = await waitForExit(worker, waitMs);
      if (!exited) {
        this.note(
          `The background sender didn't finish within ${Math.round(waitMs / 1000)} seconds, so it was ended. (Every step it takes is crash-safe.)`,
        );
        killTree(worker.pid);
      }
    }
    const web = this.procs.web.child;
    if (isRunning(web)) killTree(web.pid);
    await sleep(300);
    clearPhase(this.o.pidFile);
    if (readPidFile(this.o.pidFile) === process.pid) removeFile(this.o.pidFile);
    removeFile(this.o.stopFile);
    this.note(code === 0 ? `${this.o.label} has stopped.` : `${this.o.label} has stopped because of the problem above.`);
    this.resolveDone(code);
  }

  async run() {
    if (this.o.handleSignals !== false) {
      process.on("SIGINT", () => void this.shutdown("Ctrl+C", 0, { consoleSignal: true }));
      process.on("SIGBREAK", () => void this.shutdown("Ctrl+Break", 0, { consoleSignal: true }));
      process.on("SIGHUP", () => void this.shutdown("the window was closed", 0, { consoleSignal: true }));
      process.on("uncaughtException", (err) => {
        this.note(`Unexpected problem in start.bat's helper: ${err?.stack ?? err}`);
        void this.shutdown("an unexpected problem", 1);
      });
    }
    this.stopWatcher = setInterval(() => {
      if (fs.existsSync(this.o.stopFile)) {
        removeFile(this.o.stopFile);
        void this.shutdown("stop.bat asked it to stop", 0);
      }
    }, 1000);

    this.note(`Starting ${this.o.label} on port ${this.o.port}...`);
    this.start("web");
    this.start("worker");
    const ready = await waitForHealth(this.o.port, this.o.healthTimeoutMs ?? 180_000, {
      requireHealthy: false,
      shouldStop: () => this.stopping,
    });
    if (!this.stopping) {
      if (ready.ok) {
        this.printBanner(ready);
        if (this.o.openBrowser) openInBrowser(`http://localhost:${this.o.port}`);
      } else {
        this.note("The app hasn't answered after 3 minutes. Read the messages above. If it keeps failing, restart the PC and try again.");
      }
    }
    return this.done;
  }
}

/**
 * Runs the app until it is stopped. Returns the exit code for the window (0 = normal stop).
 * @param {object} options see the defaults below
 */
export async function runSupervisor(options = {}) {
  const o = {
    label: "Polygon Paradise Outreach",
    port: 3000,
    host: "0.0.0.0",
    databaseUrl: undefined,
    logPrefix: "",
    pidFile: PATHS.supervisorPid,
    stopFile: PATHS.stopRequest,
    allowBuild: true,
    backupBeforeMigrate: true,
    openBrowser: false,
    extraEnv: {},
    missingBuildMessage: "The app hasn't been built yet. Double-click setup.bat first.",
    printBanner: null,
    ...options,
  };
  process.chdir(ROOT);
  ui.title(o.label);

  const pre = preflight();
  for (const w of pre.warnings) ui.warn(w);
  if (!pre.ok) {
    ui.fail(pre.message);
    return 1;
  }
  // update.bat stopped half-way: the parts, the database and the build may not match.
  if (updateInProgress()) {
    ui.fail(UPDATE_UNFINISHED_MESSAGE);
    return 1;
  }
  const envValues = readEnvFile();
  const databaseUrl = o.databaseUrl ?? envValues.DATABASE_URL ?? "file:./data/app.db";

  // Claim the pid file first and atomically, so a second window opened at the same moment stops
  // here, and install-services.bat can see start.bat is open even during a long build.
  const claim = await claimPidFile(o.pidFile);
  if (!claim.ok) {
    ui.fail(
      claim.pid
        ? `${o.label} is already running in another window (process ${claim.pid}). Use that window, or double-click stop.bat first.`
        : `${o.label} is being started in another window right now. Use that window, or double-click stop.bat first.`,
    );
    return 1;
  }
  // A stop request left over from before this window belongs to nobody now.
  removeFile(o.stopFile);
  const releasePid = () => {
    clearPhase(o.pidFile);
    if (readPidFile(o.pidFile) === process.pid) removeFile(o.pidFile);
  };
  process.on("exit", releasePid);
  if (await portInUse(o.port)) {
    ui.fail(portBusyMessage(o.port));
    releasePid();
    return 1;
  }
  // stop.bat can't reach this window while it upgrades or builds (those steps block it), so it
  // leaves its request in the stop file; honour it between the steps.
  const stopAsked = () => {
    if (!fs.existsSync(o.stopFile)) return false;
    removeFile(o.stopFile);
    ui.info("stop.bat asked the app to stop, so it wasn't started. Nothing was left half-done.");
    releasePid();
    return true;
  };

  ui.step("Checking the database");
  writePhase(o.pidFile, "migrating");
  const mig = await ensureMigrated({
    databaseUrl,
    backup: o.backupBeforeMigrate,
    backupsDir: premigrateBackupsDir(databaseUrl, envValues.DATABASE_URL),
  });
  clearPhase(o.pidFile);
  if (!mig.ok) {
    ui.fail(mig.message);
    releasePid();
    return 1;
  }
  ui.ok(mig.changed ? "The database is up to date now." : "The database is up to date.");
  if (stopAsked()) return 0;

  ui.step("Checking the build");
  const builtWithUrl = (envValues.APP_PUBLIC_URL ?? "").trim();
  const bs = buildState({ publicUrl: builtWithUrl });
  if (bs.needed) {
    if (o.allowBuild) {
      // The practice copy runs from the same build: rebuilding under it would break it mid-session.
      if (o.pidFile !== PATHS.demoPid && supervisorState(PATHS.demoPid).running) {
        ui.fail(
          "The app needs to be built again, but the practice copy (the start-demo.bat window) is open and uses the same build. " +
            "Close the practice copy, then double-click start.bat again.",
        );
        releasePid();
        return 1;
      }
      ui.info(
        bs.reason === "missing"
          ? "Building the app for the first time. This takes a few minutes..."
          : "The app's files changed since the last build, so it's being built again. This takes a few minutes...",
      );
      writePhase(o.pidFile, "building");
      const r = runBuild({ publicUrl: builtWithUrl, log: ui.info });
      clearPhase(o.pidFile);
      if (!r.ok) {
        ui.fail(`${r.message} The app was not started.`);
        releasePid();
        return 1;
      }
      ui.ok("The app is built.");
    } else if (bs.reason === "missing") {
      ui.fail(o.missingBuildMessage);
      releasePid();
      return 1;
    } else {
      ui.warn("The app's files changed since the last build. This uses the last build; start.bat builds the new one.");
    }
  } else {
    ui.ok("The app is built and up to date.");
  }
  if (stopAsked()) return 0;

  ui.step("Starting");
  const supervisor = new Supervisor(o, databaseUrl, envValues);
  return supervisor.run();
}

const BUSY_WORDS = {
  migrating: "upgrading the database",
  building: "building the app",
};

/**
 * Asks a running start.bat (or start-demo.bat) to stop through its stop.request file and waits.
 * Normally it waits up to `timeoutMs` and then ends it with taskkill. While the window upgrades
 * the database or builds the app it waits up to `busyTimeoutMs` instead (the window stops by
 * itself right after that step), and it never ends a database upgrade: then it gives up with
 * `refused` and leaves the stop request in place, so the window stops once the upgrade is done.
 * Returns { wasRunning, forced, forcedDuring, refused, busy, pid }.
 */
export async function stopSupervisor({
  pidFile = PATHS.supervisorPid,
  stopFile = PATHS.stopRequest,
  timeoutMs = 15_000,
  busyTimeoutMs = 20 * 60_000,
  log = ui.info,
} = {}) {
  const st = supervisorState(pidFile);
  if (!st.running) {
    if (st.stale) removeFile(pidFile);
    return { wasRunning: false, forced: false, forcedDuring: null, refused: false, busy: null };
  }
  fs.mkdirSync(path.dirname(stopFile), { recursive: true });
  fs.writeFileSync(stopFile, `${new Date().toISOString()}\n`, "utf8");
  log("Asked the app to stop. Waiting for it to finish what it's doing...");
  let deadline = Date.now() + timeoutMs;
  let busyDeadline = null;
  let told = null;
  let phase = null;
  while (isPidAlive(st.pid)) {
    phase = readPhase(pidFile, st.pid)?.phase ?? null;
    if (BUSY_PHASES.includes(phase)) {
      if (told !== phase) {
        log(`It is ${BUSY_WORDS[phase]} right now. Waiting for that to finish (this can take a few minutes); it stops right after.`);
        told = phase;
      }
      busyDeadline ??= Date.now() + busyTimeoutMs;
      // Once the step is done, the usual wait starts again from there.
      deadline = Math.max(deadline, Date.now() + timeoutMs);
      if (Date.now() >= busyDeadline) break;
    } else if (Date.now() >= deadline) {
      break;
    }
    await sleep(500);
  }
  let forced = false;
  let forcedDuring = null;
  if (isPidAlive(st.pid)) {
    phase = readPhase(pidFile, st.pid)?.phase ?? null;
    if (phase === "migrating") {
      // Ending `prisma migrate deploy` half-way can break the database's upgrade history.
      return { wasRunning: true, forced: false, forcedDuring: null, refused: true, busy: phase, pid: st.pid };
    }
    killTree(st.pid);
    forced = true;
    forcedDuring = BUSY_PHASES.includes(phase) ? phase : null;
    await sleep(1000);
  }
  removeFile(stopFile);
  if (readPidFile(pidFile) === st.pid) removeFile(pidFile);
  if (readPhase(pidFile, st.pid)) removeFile(phaseFileFor(pidFile));
  return { wasRunning: true, forced, forcedDuring, refused: false, busy: told, pid: st.pid };
}

/** Plain words for the result of stopSupervisor(), for stop.bat, update.bat and restore.bat. */
export function stopResultMessage(label, r, seconds = 15) {
  if (r.refused) {
    return `${label} is still upgrading the database, and stopping it in the middle could damage the upgrade, so it was left running. It stops by itself when the upgrade is done. Wait a few minutes, then try again.`;
  }
  if (r.forced && r.forcedDuring === "building") {
    return `${label} was still building the app after a long wait, so it was ended. Your data is fine, but that build didn't finish: start.bat builds it again the next time.`;
  }
  if (r.forced) return `${label} didn't stop within ${seconds} seconds, so it was ended. That's safe: every step the running app takes is crash-safe.`;
  return `${label} has stopped.`;
}
