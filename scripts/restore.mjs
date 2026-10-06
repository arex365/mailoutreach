// restore.bat [<backup file>] → node scripts/restore.mjs [<backup file>] [--yes]
//   [--db <path>]            database to restore into (default: DATABASE_URL from .env). Another file than
//                            the app's own is restored without stopping or starting the app, and without
//                            administrator rights (tests, the lead's rehearsal on data\manual-check\…).
//   [--backups-dir <path>]   where backups are listed and the current data is saved (default: backups\ for the app's
//                            own database, backups\<database name>\ for another one, as the app itself does, so a test
//                            database's backups never mix with the real ones)
// Puts the data back from a backup (PLAN.md B6.7, M6-DESIGN §3.7), in this order:
//   1. administrator rights, only for the app's own database while the background services are installed;
//   2. the chosen backup, opened read-only before anything is stopped: made by this version of the app or an older one
//      (every upgrade it has is known here), the practice copy's backup only for the practice copy (and the real app's
//      only for the real app), and a second "yes" when it comes from another database (normal when moving to a new PC);
//   3. enough free disk space for the saved copy, the temporary copy and the backup (about 2.2 × the database);
//   4. stop the app, then save the current data as "Before a restore" (if that fails, the app starts again and nothing
//      changed);
//   5. write data\RESTORED, then put the backup in place through a checked temporary file and a rename
//      (scripts/lib/restore-marker.mjs): anything that fails before the rename leaves the database as it was, the
//      marker goes back, and the app starts again;
//   6. upgrade it to this version → start the app again (not while update.bat is unfinished).
// The background sender reads data\RESTORED at its next start (M3-DESIGN §4.3.7): it pauses all sending, checks
// Mailgun for emails sent after the backup, and sending stays paused until the Owner has read the restore report and
// clicked Resume. The marker carries "version": 3; an older marker without a version (Milestones 1–2) is renamed at
// the first Milestone 3 start. It also lists the Mailgun sending domains the replaced database had ("domainsBefore",
// null when they couldn't be read), so the check covers a domain the restored backup doesn't know. The list names
// each backup's kind in the app's words: the kinds of the background sender's backups come from the app's Backup rows
// (read-only), the scripts' own from their names.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROOT, displayPath } from "./lib/paths.mjs";
import * as ui from "./lib/ui.mjs";
import { databasePathFromUrl, databaseUrlFor } from "./lib/env-file.mjs";
import {
  appBackupFolder,
  backupLabel,
  formatBytes,
  formatWhen,
  listBackups,
  makeBackup,
  readBackupKinds,
  restoredFromTime,
} from "./lib/backups.mjs";
import { listMigrationNames } from "./lib/migrations.mjs";
import { isSqliteFile, openDatabase, quickCheck } from "./lib/sqlite.mjs";
import { isElevated, waitForHealth } from "./lib/proc.mjs";
import { servicesInstalled } from "./lib/services.mjs";
import { ensureMigrated, readEnvFile } from "./lib/supervisor.mjs";
import { startApp, startBlocker, stopApp } from "./lib/app-control.mjs";
import { swapInBackup } from "./lib/restore-marker.mjs";

const { FriendlyError } = ui;
const GB = 1024 * 1024 * 1024;

/** The owner-facing sentences of the safety checks (M6-DESIGN §3.7). */
export const RESTORE_TEXTS = {
  needsAdmin:
    "The background services are installed, so restoring needs administrator rights. Double-click restore.bat (it asks Windows for permission).",
  newerVersion: "This backup was made by a newer version of the app. Update the app first, then restore it.",
  practiceMismatch:
    "This backup belongs to the practice copy, not the real app (or the other way round). Pick another backup.",
  otherDatabase: "This backup comes from another database (expected when moving to a new PC).",
  otherDatabaseQuestion: "This backup comes from another database (expected when moving to a new PC). Type yes to go on: ",
  noSpace: (needed, free) =>
    `There isn't enough free disk space for a safe restore: about ${needed} is needed and ${free} is free. Nothing was changed.`,
  saveFailed: (reason) => `Couldn't save your current data first (${reason}), so nothing was changed.`,
  copyFailed: (reason) => `Couldn't put the backup in place (${reason}). Your data is as it was before, and nothing else changed.`,
  damaged: (check) => `The backup is damaged (SQLite says: ${check}). Your data is as it was before, and nothing else changed.`,
  unreadable: (why) => `The backup is damaged (SQLite says: ${why}). Nothing was changed.`,
};

/** "1.4 GB" (one decimal) for sizes from 0.1 GB, else "12.3 MB". */
export function sizeText(bytes) {
  return bytes >= 0.1 * GB ? `${(bytes / GB).toFixed(1)} GB` : formatBytes(bytes);
}

/** Why a file operation failed, in plain words. */
function reasonOf(err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  switch (code) {
    case "ENOSPC":
      return "the disk is full";
    case "EACCES":
    case "EPERM":
      return "Windows refused access to the file";
    case "EBUSY":
      return "a file is in use by another program";
    case "ENOENT":
      return "the backup file can't be read any more: is its drive still plugged in?";
    default:
      return String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").trim().replace(/\.$/, "") || "unknown error";
  }
}

/** A path as the owner types it: project-relative with backslashes, in quotes when it has a space. */
function argText(file) {
  const shown = displayPath(file);
  return /\s/.test(shown) ? `"${shown}"` : shown;
}

/**
 * The line that says how to undo a restore with the saved "Before a restore" copy (review SECURITY-02): restore.bat
 * for the app's own database; for any other database the full command with the same --db and --backups-dir, because
 * restore.bat alone would put that copy into the app's own database.
 * @param {{ saved: string, dbFile: string, backupsDir: string, isAppDatabase: boolean }} o
 */
export function undoCommand({ saved, dbFile, backupsDir, isAppDatabase }) {
  return isAppDatabase
    ? `To undo this restore, run:  restore.bat ${argText(saved)}`
    : `To undo this restore, run:  node scripts\\restore.mjs ${argText(saved)} --db ${argText(dbFile)} --backups-dir ${argText(backupsDir)}`;
}

function resolveBackupArg(arg, backupsDir, root) {
  const candidates = [path.resolve(root, arg), path.join(backupsDir, arg), path.join(backupsDir, path.basename(arg))];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** The 30 newest backups, each with its kind in the app's words (kinds of app backups from `dbFile`, read-only). */
async function chooseBackup(backupsDir, dbFile, ask) {
  const backups = listBackups(backupsDir);
  if (backups.length === 0) throw new FriendlyError("There are no backups in the backups folder yet.");
  const kinds = await readBackupKinds(dbFile);
  ui.step("Backups, newest first");
  const shown = backups.slice(0, 30);
  shown.forEach((b, i) => {
    const when = formatWhen(b.time ?? b.mtime);
    ui.say(`  ${String(i + 1).padStart(2)}.  ${when}  ${backupLabel(b.name, kinds)}  (${b.name}, ${formatBytes(b.size)})`);
  });
  if (backups.length > shown.length) ui.info(`(${backups.length - shown.length} older backups are not shown. Type restore.bat <file> to use one of them.)`);
  for (;;) {
    const answer = await ask("\n  Type the number of the backup to restore, or press Enter to cancel: ");
    if (answer === null || answer === "") return null;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1].file;
    ui.warn(`Type a number from 1 to ${shown.length}.`);
  }
}

function jsonValue(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored date as milliseconds (Prisma writes numbers; older rows may hold text), or null. */
function storedTime(value) {
  if (typeof value === "number" || typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * The Mailgun sending domains a database uses (review BACKUPS-7): Setting "mailgun.domain" (with "mailgun.region"),
 * plus each SendingDomain row that is active or sent live email in the last 60 days (the background sender's own
 * domainsToSync rule; a date it can't read counts as recent). Names lowercased, each once.
 * @returns {Array<{ name: string, region: "EU" | "US" }>}
 */
function readSendingDomains(db, tables, now = new Date()) {
  /** @type {Array<{ name: string, region: "EU" | "US" }>} */
  const out = [];
  const add = (name, region) => {
    const n = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (n && !out.some((d) => d.name === n)) out.push({ name: n, region: region === "US" ? "US" : "EU" });
  };
  if (tables.has("Setting")) {
    const domain = db.get(`SELECT value FROM "Setting" WHERE key = 'mailgun.domain'`);
    const region = db.get(`SELECT value FROM "Setting" WHERE key = 'mailgun.region'`);
    add(domain ? jsonValue(domain.value) : null, region ? jsonValue(region.value) : null);
  }
  if (tables.has("SendingDomain")) {
    const since = now.getTime() - 60 * DAY_MS;
    for (const row of db.all(`SELECT name, region, active, lastLiveSendAt FROM "SendingDomain" ORDER BY id`)) {
      const active = row.active === true || Number(row.active) === 1;
      const sentLive = row.lastLiveSendAt !== null && row.lastLiveSendAt !== undefined;
      const last = sentLive ? storedTime(row.lastLiveSendAt) : null;
      if (active || (sentLive && (last === null || last >= since))) add(row.name, row.region);
    }
  }
  return out;
}

/**
 * What restore.bat checks in a database, opened read-only: its applied upgrades (null without the table), whether it
 * is the practice copy (Setting "practice.copy"), its installation id (SystemState "instance") and the Mailgun sending
 * domains it uses (readSendingDomains). Throws when SQLite can't read the file (a damaged backup). With `tidy`, the
 * -wal/-shm files a read-only look can leave next to a backup that nobody else has open are removed again.
 */
export async function inspectDatabase(file, { tidy = false } = {}) {
  const had = { wal: fs.existsSync(`${file}-wal`), shm: fs.existsSync(`${file}-shm`) };
  const db = await openDatabase(file, { readonly: true });
  try {
    const tables = new Set(db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => String(r.name)));
    const migrations = tables.has("_prisma_migrations")
      ? db.all(`SELECT migration_name AS name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`).map((r) => String(r.name))
      : null;
    const practiceRow = tables.has("Setting") ? db.get(`SELECT value FROM "Setting" WHERE key = 'practice.copy'`) : null;
    const instanceRow = tables.has("SystemState") ? db.get(`SELECT value FROM "SystemState" WHERE key = 'instance'`) : null;
    const instance = instanceRow ? jsonValue(instanceRow.value) : null;
    return {
      migrations,
      practiceCopy: practiceRow ? jsonValue(practiceRow.value) === true : false,
      instanceId: instance && typeof instance.id === "string" && instance.id.trim() ? instance.id.trim() : null,
      sendingDomains: readSendingDomains(db, tables),
    };
  } finally {
    db.close();
    if (tidy) {
      if (!had.wal) fs.rmSync(`${file}-wal`, { force: true });
      if (!had.shm) fs.rmSync(`${file}-shm`, { force: true });
    }
  }
}

/** Free bytes on a folder's drive, or null when that can't be told. */
async function defaultFreeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Puts a file in place of the database (M6-DESIGN §3.7 step 5): copy it to "<database>.restore-<pid>.tmp" (a -wal
 * companion is copied beside it and folded in with PRAGMA wal_checkpoint(TRUNCATE)), PRAGMA quick_check the copy, then
 * set the database's own -wal and -journal aside (they must never be paired with other data), delete its -shm and
 * rename the copy over it. Anything that fails before the rename leaves the database untouched and deletes the
 * temporary file; a failed rename puts the set-aside files back. A damaged copy throws an error carrying SQLite's
 * answer as `check`. The app must be stopped (restore.mjs stops it first).
 */
export function makePutInPlace(dbFile, { copyFile = (from, to) => fs.copyFileSync(from, to), check = quickCheck } = {}) {
  return async (source) => {
    const tmp = `${dbFile}.restore-${process.pid}.tmp`;
    const clean = () => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(tmp + suffix, { force: true });
    };
    clean();
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      copyFile(source, tmp);
      if (fs.existsSync(`${source}-wal`)) {
        copyFile(`${source}-wal`, `${tmp}-wal`);
        const db = await openDatabase(tmp);
        try {
          db.get("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
        }
      }
      const result = await Promise.resolve()
        .then(() => check(tmp))
        .catch((err) => String(err instanceof Error ? err.message : err));
      if (result !== "ok") throw Object.assign(new Error(`SQLite says: ${result}`), { check: String(result) });
      for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(tmp + suffix, { force: true });
    } catch (err) {
      clean();
      throw err;
    }
    const aside = [];
    try {
      for (const suffix of ["-wal", "-journal"]) {
        if (!fs.existsSync(dbFile + suffix)) continue;
        const parked = `${dbFile}.restore-${process.pid}.old${suffix}`;
        fs.renameSync(dbFile + suffix, parked);
        aside.push([parked, dbFile + suffix]);
      }
      fs.rmSync(`${dbFile}-shm`, { force: true });
      fs.renameSync(tmp, dbFile);
    } catch (err) {
      for (const [parked, original] of aside) {
        try {
          fs.renameSync(parked, original);
        } catch {
          /* left as <database>.restore-<pid>.old-wal: nothing reads it, and the data file is still the old one */
        }
      }
      clean();
      throw err;
    }
    for (const [parked] of aside) fs.rmSync(parked, { force: true });
  };
}

/** After the rename: the database in place opens and has its tables (the full check ran on the temporary copy). */
async function opensCheck(file) {
  const db = await openDatabase(file);
  try {
    db.get("SELECT count(*) AS n FROM sqlite_master");
    return "ok";
  } finally {
    db.close();
  }
}

/**
 * @typedef {object} RestoreDeps
 * @property {string} [root] the app's folder (default: this project)
 * @property {Record<string, string>} [env] the .env values (default: read from .env)
 * @property {(question: string) => Promise<string | null>} [ask] the answers typed
 * @property {() => boolean} [servicesInstalled]
 * @property {() => boolean} [isElevated]
 * @property {typeof stopApp} [stopApp]
 * @property {typeof startApp} [startApp]
 * @property {typeof startBlocker} [startBlocker]
 * @property {typeof waitForHealth} [waitForHealth]
 * @property {typeof ensureMigrated} [ensureMigrated]
 * @property {typeof makeBackup} [makeBackup] the "Before a restore" backup
 * @property {(dir: string) => Promise<number | null>} [freeBytes] free space on the database's drive
 * @property {(from: string, to: string) => void} [copyFile] the copy of the backup to its temporary file
 */

/**
 * The whole restore (see the top of this file). `values` are the parsed options (yes, db, backups-dir), `positionals`
 * the optional backup file. `deps` replace the pieces that touch the PC (tests): the answers typed (`ask`), the
 * services and administrator checks, stopping and starting the app, the database upgrade, the "Before a restore"
 * backup, the free space and the copy of the backup; plus `root` and the `.env` values.
 * @param {{ yes?: boolean, db?: string, "backups-dir"?: string }} values
 * @param {string[]} positionals
 * @param {RestoreDeps} [deps]
 */
export async function runRestore(values, positionals, deps = {}) {
  const root = deps.root ?? ROOT;
  const ask = deps.ask ?? ui.ask;
  const d = {
    servicesInstalled: deps.servicesInstalled ?? servicesInstalled,
    isElevated: deps.isElevated ?? isElevated,
    stopApp: deps.stopApp ?? stopApp,
    startApp: deps.startApp ?? startApp,
    startBlocker: deps.startBlocker ?? startBlocker,
    waitForHealth: deps.waitForHealth ?? waitForHealth,
    ensureMigrated: deps.ensureMigrated ?? ensureMigrated,
    makeBackup: deps.makeBackup ?? makeBackup,
    freeBytes: deps.freeBytes ?? defaultFreeBytes,
  };
  ui.title("Polygon Paradise Outreach: restore a backup");

  const env = deps.env ?? readEnvFile();
  const appDatabaseUrl = env.DATABASE_URL || "file:./data/app.db";
  const databaseUrl = values.db ? databaseUrlFor(values.db, root) : appDatabaseUrl;
  const dbFile = databasePathFromUrl(databaseUrl, root);
  const isAppDatabase = path.resolve(dbFile).toLowerCase() === path.resolve(databasePathFromUrl(appDatabaseUrl, root)).toLowerCase();
  // Another database's backups live in backups\<its name>\, as the app keeps them (review BACKUPS-10): its "Before a
  // restore" copy never lands among the real app's backups, where restore.bat would offer it as the real one.
  const backupsDir = values["backups-dir"]
    ? path.resolve(root, values["backups-dir"])
    : isAppDatabase
      ? path.join(root, "backups")
      : appBackupFolder(dbFile, root);

  // 1. Administrator rights only for the app's own database (a test copy never touches the services).
  let services = false;
  if (isAppDatabase) {
    services = d.servicesInstalled();
    if (services && !d.isElevated()) throw new FriendlyError(RESTORE_TEXTS.needsAdmin);
  }

  let file = null;
  if (positionals[0]) {
    file = resolveBackupArg(positionals[0], backupsDir, root);
    if (!file) throw new FriendlyError(`Can't find the backup "${positionals[0]}". Check the name; backups are in the backups folder.`);
  } else {
    file = await chooseBackup(backupsDir, dbFile, ask);
    if (!file) {
      ui.info("Cancelled. Nothing was changed.");
      return;
    }
  }
  if (path.resolve(file).toLowerCase() === path.resolve(dbFile).toLowerCase()) {
    throw new FriendlyError("That is the app's current database, not a backup. Choose a file from the backups folder.");
  }
  if (!isSqliteFile(file)) throw new FriendlyError(`${displayPath(file)} isn't a database backup (it isn't an SQLite file).`);

  // 2. The backup, read-only, before anything is stopped.
  let backupInfo;
  try {
    backupInfo = await inspectDatabase(file, { tidy: true });
  } catch (err) {
    throw new FriendlyError(RESTORE_TEXTS.unreadable(reasonOf(err)));
  }
  if (backupInfo.migrations) {
    // The upgrades this version of the app knows (prisma\migrations); a backup with any other was made by a newer one.
    const known = new Set(listMigrationNames(path.join(root, "prisma", "migrations")));
    if (backupInfo.migrations.some((m) => !known.has(m))) throw new FriendlyError(RESTORE_TEXTS.newerVersion);
  }
  let target = null;
  const hadDatabase = fs.existsSync(dbFile);
  if (hadDatabase) {
    try {
      target = await inspectDatabase(dbFile);
    } catch {
      target = null; // A damaged current database is a reason to restore, not to refuse.
    }
  }
  if (target && target.practiceCopy !== backupInfo.practiceCopy) throw new FriendlyError(RESTORE_TEXTS.practiceMismatch);
  const otherDatabase = Boolean(target?.instanceId && backupInfo.instanceId && target.instanceId !== backupInfo.instanceId);
  // The sending domains of the data being replaced go into the marker (review BACKUPS-7): none when there was no
  // database, null when it couldn't be read (the background sender's check then asks the Owner to confirm).
  const domainsBefore = !hadDatabase ? [] : target ? target.sendingDomains : null;

  const st = fs.statSync(file);
  const when = restoredFromTime({ fileName: path.basename(file), mtime: st.mtime });
  const kinds = await readBackupKinds(dbFile);
  ui.step("Please check");
  ui.info(`Backup: ${displayPath(file)} (${formatBytes(st.size)})`);
  ui.info(`Kind:   ${backupLabel(path.basename(file), kinds)}`);
  ui.info(`From:   ${formatWhen(when)}`);
  ui.info(`Into:   ${displayPath(dbFile)}${isAppDatabase ? "" : " (not the app's own database)"}`);
  ui.info("This puts your data back as it was at that time. Everything changed since then is replaced.");
  ui.info(
    isAppDatabase
      ? "Your current data is saved first, so you can undo this with restore.bat."
      : "That database's current data is saved first, so you can undo this (the command is shown at the end).",
  );
  if (!values.yes) {
    const answer = await ask("\n  Type yes to restore, or press Enter to cancel: ");
    if (!answer || answer.toLowerCase() !== "yes") {
      ui.info("Cancelled. Nothing was changed.");
      return;
    }
  }
  if (otherDatabase) {
    if (values.yes) {
      ui.info(RESTORE_TEXTS.otherDatabase);
    } else {
      const answer = await ask(`\n  ${RESTORE_TEXTS.otherDatabaseQuestion}`);
      if (!answer || answer.toLowerCase() !== "yes") {
        ui.info("Cancelled. Nothing was changed.");
        return;
      }
    }
  }

  // 3. Free space for the saved copy, the temporary copy and the backup, before anything is stopped.
  const needed = Math.ceil(2.2 * (sizeOf(dbFile) + sizeOf(`${dbFile}-wal`))) + st.size;
  const free = await d.freeBytes(path.dirname(path.resolve(dbFile)));
  if (free !== null && free < needed) throw new FriendlyError(RESTORE_TEXTS.noSpace(sizeText(needed), sizeText(free)));

  let stop = { ok: true, services, wasRunning: false, message: "" };
  if (isAppDatabase) {
    ui.step("Stopping the app");
    stop = await d.stopApp({ log: ui.info });
    if (!stop.ok) throw new FriendlyError(stop.message);
    ui.ok(stop.message);
  }
  const restartApp = isAppDatabase && (services || stop.wasRunning);
  /** After a failure that left the data as it was: start the app again if it ran before. Returns the sentence. */
  const startAgain = async () => {
    if (!restartApp) return "";
    const blocked = d.startBlocker({ services, publicUrl: (env.APP_PUBLIC_URL ?? "").trim() });
    if (blocked) return ` The app wasn't started again. ${blocked}`;
    const start = await d.startApp({ services, log: ui.info });
    return start.ok ? " The app was started again." : " Start the app again with start.bat.";
  };

  // 4. The current data first: without it, nothing changes.
  ui.step("Saving your current data");
  let saved = null;
  if (fs.existsSync(dbFile)) {
    try {
      const b = await d.makeBackup("prerestore", dbFile, backupsDir, { allowRawCopy: true });
      saved = b.file;
      ui.ok(`Saved as ${displayPath(b.file)}`);
    } catch (err) {
      const again = await startAgain();
      throw new FriendlyError(`${RESTORE_TEXTS.saveFailed(reasonOf(err))}${again}`);
    }
  } else {
    ui.info("There was no current database to save.");
  }

  // 5. The marker, then the backup through a checked temporary file and a rename.
  ui.step("Putting the backup in place");
  const putInPlace = makePutInPlace(dbFile, { copyFile: deps.copyFile });
  const undoLine = saved ? undoCommand({ saved, dbFile, backupsDir, isAppDatabase }) : null;
  // PLAN.md B6.7, M3-DESIGN §4.3.7: the marker (data\RESTORED) goes in BEFORE the backup's data replaces the
  // database, so a closed window or a power cut anywhere after the copy still leaves it. `db` names the restored
  // database, because the practice copy's database lives in the same folder and must leave this marker for the real one.
  const swap = await swapInBackup({
    dbFile,
    backupFile: file,
    savedFile: saved,
    restoredFrom: when,
    putInPlace,
    check: opensCheck,
    domainsBefore,
  });
  if (!swap.ok && swap.stage === "marker") {
    const again = await startAgain();
    throw new FriendlyError(
      `Couldn't write ${displayPath(swap.markerFile)} (${swap.error}), so nothing was changed. Check that the data folder isn't read-only, then run restore.bat again.${again}`,
    );
  }
  if (!swap.ok && swap.stage === "copy") {
    const again = await startAgain();
    throw new FriendlyError(`${RESTORE_TEXTS.copyFailed(reasonOf(Object.assign(new Error(swap.error), { code: swap.code })))}${again}`);
  }
  if (!swap.ok && swap.putBackError) {
    throw new FriendlyError(
      [
        `The backup is damaged (SQLite says: ${swap.check}), and your data couldn't be put back (${swap.putBackError}).`,
        undoLine ? `Run it again to get your data back. ${undoLine}` : null,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    );
  }
  if (!swap.ok) {
    const again = await startAgain();
    throw new FriendlyError(`${RESTORE_TEXTS.damaged(swap.check)}${again}`);
  }
  ui.ok("The backup is in place and SQLite says it's healthy.");

  // 6. A backup from before an update may need the newer database version.
  const mig = await d.ensureMigrated({ databaseUrl, backup: false, log: ui.info });
  if (!mig.ok) {
    throw new FriendlyError(
      [
        `The backup from ${formatWhen(when)} is in place (your data is now as it was then), but upgrading it to this version's database failed.`,
        isAppDatabase ? "The app was left stopped, because it can't run on data that isn't upgraded." : null,
        undoLine,
        "The details below say why. When that is fixed, run restore.bat again with the same backup.",
        "",
        mig.message,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    );
  }
  if (mig.changed) ui.ok("Upgraded the restored data to the current database version.");

  if (!isAppDatabase) {
    ui.info("That isn't the app's own database, so the app wasn't stopped or started.");
  } else if (restartApp) {
    // Never start a half-updated or half-built app (for example after update.bat failed).
    const blocked = d.startBlocker({ services, publicUrl: (env.APP_PUBLIC_URL ?? "").trim() });
    if (blocked) {
      ui.warn(`The app wasn't started again. ${blocked}`);
    } else {
      ui.step("Starting the app again");
      const start = await d.startApp({ services, log: ui.info });
      if (!start.ok) throw new FriendlyError(start.message);
      const health = await d.waitForHealth(3000, 180_000, { requireHealthy: false });
      if (health.ok) ui.ok("The app is running again at http://localhost:3000.");
      else ui.warn("The app hasn't answered yet. Run status.bat in a minute to check.");
    }
  } else {
    ui.info("The app wasn't running before, so it wasn't started. Double-click start.bat when you're ready.");
  }

  console.log("");
  ui.box([
    `Restored your data from ${formatWhen(when)}.`,
    "",
    "Sending stays paused until you've read the restore report",
    "in Settings › Sending & Mailgun and clicked Resume,",
    "so nobody gets the same email twice.",
  ]);
  if (undoLine) ui.info(undoLine);
}

/**
 * True when this file is the program being run (restore.bat, the tests' child process), not a module a test imported
 * for runRestore. Compared case-insensitively (Windows drive letters), and by name as a fallback.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (pathToFileURL(path.resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase()) return true;
  return path.basename(entry).toLowerCase().replace(/\.mjs$/, "") === "restore";
}

if (isEntryPoint()) {
  process.chdir(ROOT);
  let exitCode = 0;
  try {
    const { values, positionals } = parseArgs({
      options: { yes: { type: "boolean", default: false }, db: { type: "string" }, "backups-dir": { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    await runRestore(values, positionals, { root: ROOT });
  } catch (err) {
    exitCode = 1;
    console.log("");
    ui.fail(err instanceof Error ? err.message : String(err));
    if (!(err instanceof FriendlyError) && err instanceof Error && err.stack) console.log(ui.dim(err.stack));
  }
  ui.closeInput();
  process.exit(exitCode);
}
