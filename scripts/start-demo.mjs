// start-demo.bat → node scripts/start-demo.mjs
// The practice copy (PLAN.md B6.5): a second copy of the app on port 3001 with made-up data in
// data\demo.db. It never sends anything, never touches data\app.db, and only this PC can open it.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { PATHS, ROOT } from "./lib/paths.mjs";
import { preflight, runSupervisor } from "./lib/supervisor.mjs";
import { UPDATE_UNFINISHED_MESSAGE, updateInProgress } from "./lib/update-marker.mjs";
import * as ui from "./lib/ui.mjs";

const DEMO_PORT = 3001;
const DEMO_DATABASE_URL = "file:./data/demo.db";

function practiceBanner() {
  console.log("");
  ui.box([
    "Practice copy: http://localhost:3001 — sign in as demo@example.com / practice-only-password",
    "(made-up data, nothing is ever sent)",
    "",
    "Keep this window open while you practise. To stop, close this window or press Ctrl+C.",
    "Your real data (data\\app.db) is not touched.",
  ]);
}

async function main() {
  process.chdir(ROOT);
  const pre = preflight();
  if (!pre.ok) {
    ui.title("Polygon Paradise Outreach: practice copy");
    ui.fail(pre.message);
    return 1;
  }
  // It runs from the app's parts and build, which may be half-updated.
  if (updateInProgress()) {
    ui.title("Polygon Paradise Outreach: practice copy");
    ui.fail(UPDATE_UNFINISHED_MESSAGE);
    return 1;
  }
  if (!fs.existsSync(PATHS.buildId)) {
    ui.title("Polygon Paradise Outreach: practice copy");
    ui.fail("The practice copy uses the app's build, and there isn't one yet. Double-click setup.bat first, then start-demo.bat again.");
    return 1;
  }
  if (!fs.existsSync(PATHS.demoDb)) {
    ui.title("Polygon Paradise Outreach: practice copy");
    ui.info("Creating the practice copy with made-up companies (only the first time)...");
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/make-demo-data.ts"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DOTENV_CONFIG_QUIET: "true" },
    });
    if (r.status !== 0) {
      ui.fail("Creating the practice data failed. The messages above say why.");
      return 1;
    }
  }
  return runSupervisor({
    label: "Polygon Paradise Outreach: practice copy",
    port: DEMO_PORT,
    host: "127.0.0.1",
    databaseUrl: DEMO_DATABASE_URL,
    logPrefix: "demo-",
    pidFile: PATHS.demoPid,
    stopFile: PATHS.demoStopRequest,
    allowBuild: false,
    backupBeforeMigrate: false,
    openBrowser: true,
    extraEnv: {
      APP_PUBLIC_URL: "",
      // Lets the app and the background sender know this is the practice copy. Its backups go to backups\demo\
      // (the app's backupFolderFor names the folder after data\demo.db).
      OUTREACH_PRACTICE: "1",
    },
    missingBuildMessage: "The practice copy uses the app's build, and there isn't one yet. Double-click setup.bat first.",
    printBanner: practiceBanner,
  });
}

process.exit(await main());
