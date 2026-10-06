// setup.bat → node scripts/setup.mjs -- [options]
// (The "--" matters when calling node directly: without it Node itself grabs --env-file.)
//   [--env-file <path>]    settings file to create/update (default .env)
//   [--db <path>]          database file to create/upgrade (default: DATABASE_URL from the settings file)
//   [--public-url <url>]   the public https address ("" or "none" = not set up yet); skips the question
//   [--build]              build even when the build is up to date
//   [--no-build]           never build
//   [--no-pause]           don't wait for a key press at the end
//   [--abi-file <path>]    where to record the Node ABI (default data\.node-abi; tests use a temp file)
//
// Safe to run again at any time (PLAN.md B10): it never replaces APP_ENCRYPTION_KEY or the
// database, only upgrades it. While no user exists it prints a new one-time setup code.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PATHS, ROOT, displayPath } from "./lib/paths.mjs";
import * as ui from "./lib/ui.mjs";
import {
  databasePathFromUrl,
  databaseUrlFor,
  dedupeEnvText,
  generateEncryptionKey,
  getEnvValue,
  isValidEncryptionKey,
  newEnvFileText,
  setEnvValue,
  validatePublicUrl,
  writeFileAtomic,
} from "./lib/env-file.mjs";
import { checkNodeVersion, dependenciesState, nativeSmokeTest, writeRecordedAbi } from "./lib/node-check.mjs";
import { countUsers, migrationStatus, runMigrateDeploy } from "./lib/migrations.mjs";
import { makeBackup } from "./lib/backups.mjs";
import { buildState, runBuild } from "./lib/build.mjs";
import { portInUse, runNpmCi, supervisorState } from "./lib/proc.mjs";
import { WEB_SERVICE, WORKER_SERVICE, queryService } from "./lib/services.mjs";
import { clearSetupCodeAttempts, generateSetupCode, hashSetupCode, writeSetupCodeHash } from "./lib/setup-code.mjs";
import { updateInProgress } from "./lib/update-marker.mjs";

const { FriendlyError } = ui;

function parseCli() {
  // Node itself looks at "--env-file <path>" even after the script name and stops when that file
  // doesn't exist yet, so setup.bat passes "--" first. Drop it here.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  try {
    return parseArgs({
      args: argv,
      options: {
        "env-file": { type: "string" },
        db: { type: "string" },
        "public-url": { type: "string" },
        build: { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        "no-pause": { type: "boolean", default: false },
        "abi-file": { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (err) {
    throw new FriendlyError(
      `${err instanceof Error ? err.message : err}\nUsage: setup.bat [--env-file <path>] [--db <path>] [--public-url <url>] [--build] [--no-build] [--no-pause] [--abi-file <path>]`,
    );
  }
}

/** Is the real app running? (either service, a start.bat window, or anything on port 3000) */
async function appRunningState() {
  const web = queryService(WEB_SERVICE);
  const worker = queryService(WORKER_SERVICE);
  for (const svc of [web, worker]) {
    if (svc.installed && svc.state && svc.state !== "STOPPED") return { running: true, how: "services" };
  }
  const sup = supervisorState(PATHS.supervisorPid);
  if (sup.running) return { running: true, how: "window" };
  if (await portInUse(3000)) return { running: true, how: "port" };
  return { running: false, how: null, servicesInstalled: web.installed };
}

/** The practice copy (start-demo.bat) runs from the same node_modules and .next as the app. */
function practiceCopyRunning() {
  return supervisorState(PATHS.demoPid).running;
}

const PRACTICE_OPEN = "The practice copy (the start-demo.bat window) is open, and it uses the app's parts and build.";

function runningExplanation(how) {
  if (how === "services") return "The app is running as a background service.";
  if (how === "window") return "The app is running in a start.bat window.";
  return "Something is using port 3000 (probably the app).";
}

function readKey(envPath) {
  return getEnvValue(fs.readFileSync(envPath, "utf8"), "APP_ENCRYPTION_KEY");
}

/** Creates the settings file, or adds missing lines. Never replaces an existing encryption key. */
function ensureEnvFile(envPath, { databaseUrl }) {
  if (!fs.existsSync(envPath)) {
    writeFileAtomic(
      envPath,
      newEnvFileText({ databaseUrl: databaseUrl ?? "file:./data/app.db", encryptionKey: generateEncryptionKey() }),
    );
    return { created: true, added: [], warnings: [] };
  }
  const before = fs.readFileSync(envPath, "utf8");
  let text = before;
  const added = [];
  const warnings = [];
  // A key set twice: the app uses the last line, so keep that one and turn the others into comments.
  const deduped = dedupeEnvText(text);
  if (deduped.keys.length) {
    text = deduped.text;
    warnings.push(
      `The settings file set ${deduped.keys.join(", ")} more than once. The app uses the last line, so that one was kept and the earlier lines were turned into comments (nothing was deleted).`,
    );
  }
  const key = getEnvValue(text, "APP_ENCRYPTION_KEY");
  if (key === undefined || key === "") {
    // An empty key means nothing was ever encrypted with it, so creating one is safe.
    text = setEnvValue(text, "APP_ENCRYPTION_KEY", generateEncryptionKey());
    added.push("APP_ENCRYPTION_KEY");
  } else if (!isValidEncryptionKey(key)) {
    warnings.push(
      "APP_ENCRYPTION_KEY in the settings file doesn't look right (it should be 32 random bytes). It was left exactly as it is. If you have a saved copy of .env, put it back.",
    );
  }
  if (getEnvValue(text, "DATABASE_URL") === undefined) {
    text = setEnvValue(text, "DATABASE_URL", databaseUrl ?? "file:./data/app.db");
    added.push("DATABASE_URL");
  }
  for (const k of ["APP_PUBLIC_URL", "SETUP_CODE_HASH"]) {
    if (getEnvValue(text, k) === undefined) {
      text = setEnvValue(text, k, "");
      added.push(k);
    }
  }
  if (text !== before) writeFileAtomic(envPath, text);
  return { created: false, added, warnings };
}

async function choosePublicUrl(current, cliValue) {
  if (cliValue !== undefined) {
    const v = validatePublicUrl(cliValue);
    if (!v.ok) throw new FriendlyError(v.error);
    return v.value;
  }
  if (!process.stdin.isTTY) return current;
  ui.step("The app's public address");
  ui.info("Remote staff and Mailgun reach the app through a secure https address, for example");
  ui.info("https://outreach.example.com. You set it up with Cloudflare: see docs\\setup\\3-cloudflare.md.");
  if (current) ui.info(`Now it is: ${current}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ui.ask(
      current
        ? "  Press Enter to keep it, type a new https address, or type none to remove it: "
        : "  Type the address, or press Enter to skip for now: ",
    );
    if (answer === null || answer === "") return current;
    const v = validatePublicUrl(answer);
    if (v.ok) return v.value;
    ui.warn(v.error);
  }
  ui.warn("The address stays as it was.");
  return current;
}

async function main(args) {
  process.chdir(ROOT);
  ui.title("Polygon Paradise Outreach: setup");

  // 1. Node.js
  ui.step("Checking Node.js");
  const node = checkNodeVersion();
  if (!node.ok) throw new FriendlyError(node.message);
  ui.ok(`Node.js ${process.versions.node} is installed.`);
  if (node.recommendUpgrade) ui.warn(node.message);

  const envPath = path.resolve(ROOT, args["env-file"] ?? ".env");
  const usingRealEnv = path.resolve(envPath) === path.resolve(PATHS.env);
  if (usingRealEnv && updateInProgress()) {
    throw new FriendlyError(
      "update.bat hasn't finished installing the new version. Double-click update.bat instead and let it finish: it updates the parts, the database and the build, and starts the app.",
    );
  }
  const running = await appRunningState();
  const practice = practiceCopyRunning();

  // 2. The app's parts
  ui.step("Checking the app's parts");
  const deps = dependenciesState();
  if (deps !== "ok") {
    if (running.running) {
      throw new FriendlyError(
        `${runningExplanation(running.how)} The app's parts need to be ${deps === "missing" ? "installed" : "updated"}, which can't happen while it runs. Double-click update.bat instead: it stops the app, updates it and starts it again.`,
      );
    }
    if (practice) {
      throw new FriendlyError(`${PRACTICE_OPEN} Close the practice copy first, then run setup.bat again.`);
    }
    ui.info(deps === "missing" ? "Installing the app's parts (npm ci). The first time this takes a few minutes..." : "Updating the app's parts (npm ci)...");
    const r = runNpmCi();
    if (!r.ok) {
      throw new FriendlyError(
        "Installing the app's parts failed (npm ci). Check the internet connection, close any window that runs the app, and run setup.bat again. If an antivirus program showed a warning, see docs\\setup\\1-install.md, Troubleshooting.",
      );
    }
    ui.ok("The app's parts are installed.");
  } else {
    ui.ok("The app's parts are installed.");
  }

  // 3. Native parts work with this Node.js
  const smoke = await nativeSmokeTest();
  if (!smoke.ok) {
    throw new FriendlyError(
      `A part of the app (${smoke.part}) doesn't work with this Node.js version. Double-click update.bat to reinstall the parts. If that doesn't help, install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).`,
      smoke.error,
    );
  }
  writeRecordedAbi(args["abi-file"] ? path.resolve(ROOT, args["abi-file"]) : PATHS.abiFile);
  ui.ok("The database and password parts work with this Node.js version.");

  // 4. Settings file
  ui.step("Checking the settings file");
  const dbOverride = args.db ? databaseUrlFor(args.db, ROOT) : undefined;
  const keyBefore = fs.existsSync(envPath) ? readKey(envPath) : undefined;
  const env = ensureEnvFile(envPath, { databaseUrl: dbOverride });
  if (env.created) ui.ok(`Created the settings file ${displayPath(envPath)} with a new encryption key.`);
  else if (env.added.length) ui.ok(`Added ${env.added.join(", ")} to ${displayPath(envPath)}. Everything else is unchanged.`);
  else ui.ok(`The settings file ${displayPath(envPath)} is complete. The encryption key is kept.`);
  for (const w of env.warnings) ui.warn(w);
  if (keyBefore && readKey(envPath) !== keyBefore) {
    throw new FriendlyError("Safety stop: the encryption key changed unexpectedly. Put back your saved copy of .env before doing anything else.");
  }

  // 5. Public address
  let envText = fs.readFileSync(envPath, "utf8");
  const currentUrl = (getEnvValue(envText, "APP_PUBLIC_URL") ?? "").trim();
  const newUrl = await choosePublicUrl(currentUrl, args["public-url"]);
  const urlChanged = newUrl !== currentUrl;
  if (urlChanged) {
    envText = setEnvValue(envText, "APP_PUBLIC_URL", newUrl);
    writeFileAtomic(envPath, envText);
    ui.ok(newUrl ? `Saved the public address: ${newUrl}` : "Removed the public address. Invite and reset links use the office address.");
  } else if (newUrl) {
    ui.ok(`Public address: ${newUrl}`);
  } else {
    ui.info("No public address yet. Remote staff and Mailgun need one: follow docs\\setup\\3-cloudflare.md, then run setup.bat again.");
  }

  // 6. Database
  ui.step("Checking the database");
  const databaseUrl = dbOverride ?? getEnvValue(envText, "DATABASE_URL") ?? "file:./data/app.db";
  const dbFile = databasePathFromUrl(databaseUrl, ROOT);
  const realDbFile = databasePathFromUrl(getEnvValue(fs.existsSync(PATHS.env) ? fs.readFileSync(PATHS.env, "utf8") : "", "DATABASE_URL"), ROOT);
  const isRealDb = path.resolve(dbFile).toLowerCase() === path.resolve(realDbFile).toLowerCase();
  const status = await migrationStatus(dbFile);
  const needsMigration = !status.dbExists || status.pending === null || status.pending.length > 0;
  if (needsMigration) {
    if (status.dbExists && isRealDb && running.running) {
      throw new FriendlyError(
        `${runningExplanation(running.how)} The database needs an upgrade, which is done while the app is stopped. Double-click update.bat instead.`,
      );
    }
    if (status.dbExists) {
      const b = await makeBackup("premigrate", dbFile, PATHS.backupsDir);
      ui.ok(`Backed up the database before upgrading it: ${displayPath(b.file)}`);
    }
    ui.info(status.dbExists ? "Upgrading the database..." : `Creating the database ${displayPath(dbFile)}...`);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const m = runMigrateDeploy(databaseUrl);
    if (!m.ok) throw new FriendlyError("Creating or upgrading the database failed (prisma migrate deploy).", m.output);
    ui.ok(status.dbExists ? "The database is upgraded." : "The database is created.");
  } else {
    ui.ok(`The database ${displayPath(dbFile)} is up to date.`);
  }

  // 7. First Owner account: a one-time setup code while there are no users.
  const users = await countUsers(dbFile);
  let setupCode = null;
  if (users === 0) {
    setupCode = generateSetupCode();
    writeSetupCodeHash(envPath, hashSetupCode(setupCode));
    if (keyBefore && readKey(envPath) !== keyBefore) {
      throw new FriendlyError("Safety stop: the encryption key changed unexpectedly. Put back your saved copy of .env before doing anything else.");
    }
    // Wrong tries with an older code must not lock the new code out (the app allows 10 an hour).
    try {
      await clearSetupCodeAttempts(dbFile);
    } catch (err) {
      ui.warn(
        `Couldn't reset the count of wrong setup codes (${err instanceof Error ? err.message : err}). If the app says there were too many tries, wait an hour.`,
      );
    }
  }

  // 8. Build
  let buildNote = null;
  if (args["no-build"]) {
    buildNote = urlChanged ? "The app wasn't rebuilt (--no-build). Run setup.bat again without --no-build so it uses the new address." : null;
  } else {
    const state = buildState({ publicUrl: newUrl });
    if (args.build || state.needed || urlChanged) {
      if (running.running && usingRealEnv) {
        buildNote = `${runningExplanation(running.how)} It wasn't rebuilt now. Double-click update.bat to rebuild and restart it.`;
      } else if (practiceCopyRunning()) {
        buildNote = `${PRACTICE_OPEN} So the app wasn't rebuilt now. Close the practice copy, then run setup.bat again.`;
      } else {
        ui.step("Building the app");
        const r = runBuild({ publicUrl: newUrl, log: ui.info });
        if (!r.ok) throw new FriendlyError(`${r.message} Fix the problem and run setup.bat again.`);
        ui.ok("The app is built.");
      }
    } else {
      ui.ok("The app is already built and up to date.");
    }
  }

  // 9. What next
  console.log("");
  if (buildNote) ui.warn(buildNote);
  if (setupCode) {
    ui.box([
      "Your one-time setup code:",
      "",
      `    ${setupCode}`,
      "",
      "Next step: double-click start.bat, open http://localhost:3000",
      "and enter this code to create the Owner account.",
    ]);
    ui.info("The code works once, and only on this PC or the office network.");
    ui.info("Running setup.bat again makes a new code and the old one stops working.");
    if (running.running && usingRealEnv) {
      ui.warn(
        running.how === "services"
          ? "The app is already running as a service: double-click stop.bat and then start.bat, so it picks up this new code."
          : "The app is already running: close the start.bat window and double-click start.bat again, so it picks up this new code.",
      );
    }
  } else {
    ui.ok("Setup is already done: the Owner account exists.");
    ui.info("To start the app, double-click start.bat and open http://localhost:3000.");
    ui.info("Forgot a password? Double-click reset-password.bat on this PC.");
  }
}

let args = { "no-pause": false };
let exitCode = 0;
try {
  args = parseCli();
  await main(args);
} catch (err) {
  exitCode = 1;
  console.log("");
  if (err instanceof FriendlyError) {
    ui.fail(err.message);
    if (err.details) {
      console.log("");
      console.log(ui.dim("Details:"));
      console.log(ui.dim(String(err.details)));
    }
  } else {
    ui.fail("Setup stopped because of an unexpected problem. Nothing that was already set up was lost.");
    console.log(ui.dim(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
}
if (!args["no-pause"]) await ui.pressAnyKey();
ui.closeInput();
process.exit(exitCode);
