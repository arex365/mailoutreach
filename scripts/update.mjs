// update.bat → node scripts/update.mjs
// Stop → back up → npm ci → check the native parts → upgrade the database → build → start →
// health check (PLAN.md B11). If any step fails it stops with a plain message and the restore
// command, and it never starts a half-built app.
//
// While it changes the app's parts it keeps two locks on, so nothing can start the half-updated
// app, not even a restart of the PC:
//   - run\update-in-progress: start.bat, start-demo.bat, restore.bat, install-services.bat and the
//     background sender refuse to start while it exists. Removed once npm ci, the database upgrade
//     and the build have all succeeded.
//   - with background services: both are set to start by hand (not with Windows). They go back to
//     starting with Windows only after the final health check passes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { PATHS, ROOT, displayPath, inRoot } from "./lib/paths.mjs";
import * as ui from "./lib/ui.mjs";
import { databasePathFromUrl } from "./lib/env-file.mjs";
import { checkNodeVersion, nativeSmokeTest, writeRecordedAbi } from "./lib/node-check.mjs";
import { runBuild } from "./lib/build.mjs";
import { isElevated, runNpmCi, waitForHealth } from "./lib/proc.mjs";
import { servicesInstalled, setServicesStartMode } from "./lib/services.mjs";
import { ensureMigrated, readEnvFile } from "./lib/supervisor.mjs";
import { startApp, stopApp } from "./lib/app-control.mjs";
import { clearUpdateMarker, writeUpdateMarker } from "./lib/update-marker.mjs";

const { FriendlyError } = ui;
const TOTAL = 7;
let backupFile = null;
let started = false;
/** run\update-in-progress exists (written by this run). */
let locked = false;
/** The services were switched to start by hand by this run and not switched back yet. */
let manualStart = false;

function stepTitle(n, text) {
  ui.step(`Step ${n} of ${TOTAL}: ${text}`);
}

/**
 * The backup runs in its own short-lived process: a process that has loaded better-sqlite3
 * keeps its .node file locked, and npm ci (step 3) must be able to replace it.
 */
function backupInChildProcess(dbFile) {
  const r = spawnSync(
    process.execPath,
    [inRoot("scripts", "backup-db.mjs"), "--kind", "preupdate", "--db", dbFile, "--allow-raw-copy", "--json"],
    { cwd: ROOT, encoding: "utf8", windowsHide: true },
  );
  const lastLine = String(r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let result = null;
  try {
    result = JSON.parse(lastLine);
  } catch {
    result = null;
  }
  if (r.status !== 0 || !result?.ok || !result.file) {
    throw new FriendlyError(
      `The backup before the update failed, so nothing was changed. ${result?.error ?? String(r.stderr ?? "").trim()}`.trim(),
    );
  }
  return result;
}

async function main() {
  process.chdir(ROOT);
  ui.title("Polygon Paradise Outreach: update");

  const node = checkNodeVersion();
  if (!node.ok) throw new FriendlyError(node.message);
  if (node.recommendUpgrade) ui.warn(node.message);
  if (!fs.existsSync(PATHS.env)) {
    throw new FriendlyError("The settings file (.env) is missing. If you have a saved copy of .env, put it back in this folder. Otherwise double-click setup.bat.");
  }
  const services = servicesInstalled();
  if (services && !isElevated()) {
    throw new FriendlyError("The background services are installed, so update needs administrator rights. Double-click update.bat (it asks Windows for permission).");
  }
  const env = readEnvFile();
  const databaseUrl = env.DATABASE_URL || "file:./data/app.db";
  const dbFile = databasePathFromUrl(databaseUrl, ROOT);

  stepTitle(1, "stopping the app");
  const stop = await stopApp({ includeDemo: true, log: ui.info });
  if (!stop.ok) throw new FriendlyError(stop.message);
  ui.ok(stop.message);
  // From here on the install may be half-updated until step 6 has finished.
  writeUpdateMarker({ step: "stopped" });
  locked = true;
  if (services) {
    const manual = setServicesStartMode("manual");
    if (!manual.ok) {
      setServicesStartMode("automatic"); // in case one of the two was switched already
      clearUpdateMarker();
      locked = false;
      throw new FriendlyError(
        `${manual.message} Nothing was changed. Restart the PC (or double-click start.bat) to use the app as it was, and run update.bat again later.`,
      );
    }
    manualStart = true;
    ui.info("Until the update has finished, the services don't start by themselves (not even after a restart of the PC).");
  }

  stepTitle(2, "backing up your data");
  if (fs.existsSync(dbFile)) {
    const b = backupInChildProcess(dbFile);
    backupFile = b.file;
    ui.ok(`Saved a copy of your data: ${displayPath(b.file)}`);
    if (b.warning) ui.warn(`SQLite couldn't make a normal backup, so the file was copied as it is. (${b.warning})`);
  } else {
    ui.info("There's no database yet, so there's nothing to back up.");
  }

  stepTitle(3, "installing the app's parts (npm ci)");
  writeUpdateMarker({ step: "installing" });
  const ci = runNpmCi();
  if (!ci.ok) {
    throw new FriendlyError(
      "Installing the app's parts failed (npm ci). Check the internet connection and run update.bat again. If an antivirus program showed a warning, see docs\\setup\\1-install.md, Troubleshooting.",
    );
  }
  ui.ok("The app's parts are installed.");

  stepTitle(4, "checking the database and password parts");
  const smoke = await nativeSmokeTest();
  if (!smoke.ok) {
    throw new FriendlyError(
      `A part of the app (${smoke.part}) doesn't work with Node.js ${process.versions.node}. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi) and run update.bat again.`,
    );
  }
  writeRecordedAbi(PATHS.abiFile);
  ui.ok(`They work with Node.js ${process.versions.node}.`);

  stepTitle(5, "upgrading the database");
  writeUpdateMarker({ step: "upgrading the database" });
  // The backup in step 2 already covers this upgrade.
  const mig = await ensureMigrated({ databaseUrl, backup: false });
  if (!mig.ok) throw new FriendlyError(mig.message);
  ui.ok(mig.changed ? "The database is upgraded." : "The database was already up to date.");

  stepTitle(6, "building the app");
  writeUpdateMarker({ step: "building" });
  const build = runBuild({ publicUrl: (env.APP_PUBLIC_URL ?? "").trim(), log: ui.info });
  if (!build.ok) throw new FriendlyError(build.message);
  ui.ok("The app is built.");
  // Parts, database and build now belong together: the app may start again.
  clearUpdateMarker();
  locked = false;

  stepTitle(7, "starting the app");
  started = true;
  const start = await startApp({ services, log: ui.info });
  if (!start.ok) throw new FriendlyError(start.message);
  ui.info("Waiting for the app to answer (up to 3 minutes)...");
  const health = await waitForHealth(3000, 180_000, { requireHealthy: true });
  if (!health.ok) {
    throw new FriendlyError(
      health.answered
        ? "The app started, but its health check reports a problem. Run status.bat for details, and look at the newest file in the logs folder."
        : "The app didn't answer within 3 minutes. Look at the newest file in the logs folder, or run status.bat.",
    );
  }
  if (manualStart) {
    const auto = setServicesStartMode("automatic");
    if (!auto.ok) {
      throw new FriendlyError(`The app is running, but ${auto.message} Run update.bat again so it starts with Windows.`);
    }
    manualStart = false;
  }
  console.log("");
  ui.ok("Update finished. The app is running again at http://localhost:3000.");
  if (services) ui.info("The services start with Windows again.");
  else ui.info("It runs in the new start.bat window. Keep that window open.");
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.log("");
  ui.fail(`Update stopped: ${err instanceof Error ? err.message : err}`);
  if (!(err instanceof FriendlyError) && err instanceof Error && err.stack) console.log(ui.dim(err.stack));
  if (!started) ui.info("Nothing was started, so no emails go out.");
  if (locked) {
    ui.info(
      "The update isn't finished, so start.bat and restore.bat won't start the app until update.bat has run to the end" +
        (manualStart ? ", and the services won't start by themselves when the PC restarts." : "."),
    );
  } else if (manualStart) {
    ui.info("The services won't start by themselves when the PC restarts until update.bat has run to the end.");
  }
  if (backupFile) {
    const rel = displayPath(backupFile);
    ui.info(`Your data was saved first in ${rel}.`);
    ui.info(`If you need that data back, run:  restore.bat ${rel}`);
  }
  ui.info("When the problem is fixed, double-click update.bat again.");
}
ui.closeInput();
process.exit(exitCode);
