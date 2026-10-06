// Backup file names, reading the time back from a name, listing backups, and making one.
// Names look like app-preupdate-2026-09-23_14-05-09.db (local time of the PC).
//
// One vocabulary everywhere (M6-DESIGN §3.2): the background sender's backups (app-2026-09-23-221405-k3x9.db) are a
// "Daily backup" or "Back up now" (their kind is in the app's Backup rows, read-only here; no row: "Backup"), and the
// scripts' own backups are "Before an update", "Before a restore" and "Before a database upgrade". These name rules
// are a copy of src/core/backups/names.ts (the scripts don't import TypeScript); tests/unit/ops/backups.test.ts pins
// both to the same table.
import fs from "node:fs";
import path from "node:path";
import { databasePathFromUrl, parseEnv } from "./env-file.mjs";
import { openDatabase, vacuumInto } from "./sqlite.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** The background sender's backups (Daily backup, Back up now): app-2026-09-23-221405-k3x9.db, local time. */
export const APP_BACKUP_PATTERN = /^app-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9]{4})\.db$/;

/** The scripts' backups: app-preupdate-2026-09-23_14-05-09.db (and -2, -3… for a second one in the same second). */
export const SCRIPT_BACKUP_PATTERN =
  /^app-(preupdate|prerestore|premigrate)-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.db$/;

/** The labels of every kind, the same words as the app's Settings › Backups. */
export const BACKUP_KIND_LABELS = {
  AUTO: "Daily backup",
  MANUAL: "Back up now",
  PRE_UPDATE: "Before an update",
  PRE_RESTORE: "Before a restore",
  PRE_MIGRATE: "Before a database upgrade",
};

const SCRIPT_KINDS = { preupdate: "PRE_UPDATE", prerestore: "PRE_RESTORE", premigrate: "PRE_MIGRATE" };

/** The kind of a script backup ("PRE_UPDATE", "PRE_RESTORE", "PRE_MIGRATE") from its name, or null. */
export function scriptBackupKind(fileName) {
  const m = SCRIPT_BACKUP_PATTERN.exec(path.basename(String(fileName ?? "")));
  return m ? SCRIPT_KINDS[m[1]] : null;
}

/** True for the background sender's own backup names. */
export function isAppBackupName(fileName) {
  return APP_BACKUP_PATTERN.test(path.basename(String(fileName ?? "")));
}

/** Local time as 2026-09-23_14-05-09 (safe in file names). */
export function timestampForFile(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** app-<kind>-<time>.db, e.g. app-premigrate-2026-09-23_14-05-09.db */
export function backupFileName(kind, date = new Date()) {
  return `app-${kind}-${timestampForFile(date)}.db`;
}

function makeDate(y, mo, d, h = 0, mi = 0, s = 0, utc = false) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s);
  // Reject impossible dates such as 31 February (Date would roll them over).
  const check = utc ? date.getUTCDate() : date.getDate();
  return Number.isNaN(date.getTime()) || check !== d ? null : date;
}

/**
 * Reads the backup time from a file name. Understands
 *   2026-09-23_14-05-09 / 2026-09-23T14-05 / 2026-09-23 14:05:09 / 20260923-140509 / 2026-09-23 (date only),
 * each optionally followed by Z (UTC). Without Z the time is the PC's local time.
 */
export function parseBackupTime(fileName) {
  const name = path.basename(String(fileName ?? ""));
  // The background sender's names (daily and Back up now): app-2026-09-23-221405-k3x9.db, local time.
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) return makeDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  m = name.match(/(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})[-:.]?(\d{2})(?:[-:.]?(\d{2}))?(Z)?/i);
  if (m) return makeDate(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, Boolean(m[7]));
  m = name.match(/(?<!\d)(\d{4})(\d{2})(\d{2})[-_T]?(\d{2})(\d{2})(\d{2})?(Z)?(?!\d)/i);
  if (m) return makeDate(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, Boolean(m[7]));
  m = name.match(/(\d{4})-(\d{2})-(\d{2})(?![\d])/);
  if (m) return makeDate(+m[1], +m[2], +m[3]);
  return null;
}

/** Plain-language kind, from the name alone (the app's own backups need their Backup row: see backupLabel). */
export function backupKindLabel(fileName) {
  const kind = scriptBackupKind(fileName);
  if (kind) return BACKUP_KIND_LABELS[kind];
  const n = path.basename(String(fileName ?? "")).toLowerCase();
  if (n.includes("preupdate")) return BACKUP_KIND_LABELS.PRE_UPDATE;
  if (n.includes("prerestore")) return BACKUP_KIND_LABELS.PRE_RESTORE;
  if (n.includes("premigrate")) return BACKUP_KIND_LABELS.PRE_MIGRATE;
  if (n.includes("manual")) return BACKUP_KIND_LABELS.MANUAL;
  if (n.includes("auto") || n.includes("daily")) return BACKUP_KIND_LABELS.AUTO;
  return "Backup";
}

/**
 * The label restore.bat and status.bat show: an app backup by its Backup row's kind (`kinds`: file name → kind; no row
 * means "Backup", e.g. one made after the backup that was restored), anything else by its name.
 * @param {string} fileName
 * @param {Map<string, string>} [kinds]
 */
export function backupLabel(fileName, kinds = new Map()) {
  const name = path.basename(String(fileName ?? ""));
  if (isAppBackupName(name)) {
    const kind = kinds.get(name);
    return (kind && BACKUP_KIND_LABELS[kind]) || "Backup";
  }
  return backupKindLabel(name);
}

/**
 * The kinds of the app's backups (`SELECT fileName, kind FROM Backup`) from a database, opened read-only. Any problem
 * (no database, an older one without the table, a locked or damaged file) gives an empty map: the labels then say
 * "Backup", never an error.
 * @returns {Promise<Map<string, string>>}
 */
export async function readBackupKinds(dbFile) {
  if (!dbFile || !fs.existsSync(dbFile)) return new Map();
  let db;
  try {
    db = await openDatabase(dbFile, { readonly: true });
    const rows = db.all(`SELECT "fileName" AS fileName, "kind" AS kind FROM "Backup"`);
    return new Map(rows.map((r) => [String(r.fileName), String(r.kind)]));
  } catch {
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * The background sender's backup folder for a database, as the app decides it (src/server/services/backups.ts
 * backupFolderFor): <root>\backups for <root>\data\app.db, <root>\backups\<file name without .db> for any other file.
 */
export function appBackupFolder(dbFile, root) {
  const base = path.join(root, "backups");
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (same(dbFile, path.join(root, "data", "app.db"))) return base;
  const name = path.basename(path.resolve(dbFile)).replace(/\.[^.]*$/, "");
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "database";
  return path.join(base, safe);
}

/**
 * The time a restored backup represents, for the restore marker. When both the name and the
 * file's modified time are known, the earlier one is used: the background sender then looks a
 * little further back in Mailgun's logs, which is the safe direction (PLAN.md B6.7).
 */
export function restoredFromTime({ fileName, mtime }) {
  const fromName = parseBackupTime(fileName);
  const fromFile = mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? mtime : null;
  if (fromName && fromFile) return fromName.getTime() <= fromFile.getTime() ? fromName : fromFile;
  return fromName ?? fromFile;
}

/** Sort key: time from the name, else the modified time. Newest first. */
export function sortBackupsNewestFirst(items) {
  return [...items].sort((a, b) => {
    const ta = (a.time ?? a.mtime)?.getTime() ?? 0;
    const tb = (b.time ?? b.mtime)?.getTime() ?? 0;
    return tb - ta || String(b.name).localeCompare(String(a.name));
  });
}

/** Every *.db file in the backups folder (not the temporary ones or -wal companions), newest first. */
export function listBackups(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (!/\.db$/i.test(name)) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    items.push({ name, file, size: st.size, mtime: st.mtime, time: parseBackupTime(name) });
  }
  return sortBackupsNewestFirst(items);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Sep 2026, 14:05" in the PC's local time. */
export function formatWhen(date) {
  if (!date) return "unknown time";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "27 Sep 22:14" in the PC's local time (the year added when it isn't this year's). */
function shortWhen(date, now) {
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "just now", "12 minutes ago", "7 hours ago", "3 days ago". */
function agoText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** The dashboard's old-backup warning threshold (src/core/backups/age.ts BACKUP_STALE_MS). */
export const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;

/**
 * status.bat's backup line (M6-DESIGN §3.9): the newest APP backup in the app's backup folder (script backups don't
 * hide failed daily ones), its kind from the Backup row (read-only; else "Backup"):
 *   { line: "Newest backup: 27 Sep 22:14, Daily backup (7 hours ago)", stale: false } or
 *   { line: "Newest backup: none yet", stale: true }.
 * `stale` is true when there is none or it is more than 36 hours old. The database comes from .env's DATABASE_URL.
 */
export async function newestBackupStatus(root, now = new Date()) {
  let env = {};
  try {
    env = parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8"));
  } catch {
    env = {};
  }
  const dbFile = databasePathFromUrl(env.DATABASE_URL || "file:./data/app.db", root);
  const newest = listBackups(appBackupFolder(dbFile, root)).find((b) => isAppBackupName(b.name));
  if (!newest) return { line: "Newest backup: none yet", stale: true };
  const at = newest.time ?? newest.mtime;
  const label = backupLabel(newest.name, await readBackupKinds(dbFile));
  const age = now.getTime() - at.getTime();
  return { line: `Newest backup: ${shortWhen(at, now)}, ${label} (${agoText(age)})`, stale: age > BACKUP_STALE_MS };
}

/**
 * Makes a backup of the database into the backups folder and returns its path.
 * VACUUM INTO first; if SQLite can't do that (a damaged file), falls back to copying the
 * file and its -wal file as they are (only safe while the app is stopped). A copy that fails half-way (a full disk)
 * leaves nothing behind that could later be mistaken for a backup.
 */
export async function makeBackup(kind, dbFile, backupsDir, { allowRawCopy = false } = {}) {
  fs.mkdirSync(backupsDir, { recursive: true });
  let dest = path.join(backupsDir, backupFileName(kind));
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(backupsDir, backupFileName(kind).replace(/\.db$/, `-${i}.db`));
  try {
    const r = await vacuumInto(dbFile, dest);
    return { file: dest, method: `VACUUM INTO (${r.engine})`, size: r.size };
  } catch (err) {
    if (!allowRawCopy) throw err;
    try {
      fs.copyFileSync(dbFile, dest);
      const wal = `${dbFile}-wal`;
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0) fs.copyFileSync(wal, `${dest}-wal`);
    } catch (copyErr) {
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}-wal`, { force: true });
      throw copyErr;
    }
    return { file: dest, method: "file copy", size: fs.statSync(dest).size, warning: String(err) };
  }
}
