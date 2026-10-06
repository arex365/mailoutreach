import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backupAge } from "@/core/backups/age";
import { copyFailedNote } from "@/core/backups/copy-note";
import { SCRIPT_BACKUP_PATTERN, scriptBackupDate, scriptBackupKind, scriptBackupsToDelete } from "@/core/backups/names";
import { isWindowOpen, parseWindow } from "@/core/sending/window";
import { parseInstanceState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { db, dbWrite } from "@/server/db";
import { databaseFilePath } from "@/server/env";
import { getSettings } from "@/server/settings";
import { logActivity } from "@/server/activity";
import { describeJobError, enqueueJob, PlainJobError } from "@/server/jobs";
import { readTyped } from "@/server/state-typed";
import { getWorkerStatus } from "@/server/worker-status";
import type { loadDueStats } from "@/server/services/sending/gates";

/**
 * Database backups (SPEC §13, PLAN.md B6.14, M6-DESIGN §3).
 *
 * - Only `runBackup` writes app backups (M6-DESIGN §0.2 rule 9). `VACUUM INTO` never runs on this process's thread
 *   (better-sqlite3 is synchronous: a large database would freeze the background sender's heartbeats, its lease and an
 *   email being handed to Mailgun): the child process `scripts/vacuum-into.mjs` writes a consistent snapshot to
 *   "<name>.db.tmp" and checks it with `PRAGMA quick_check`; only a healthy file is renamed to its final name, so a
 *   half-written or damaged file never counts as a backup. In WAL mode the snapshot is a plain read: nobody's writes
 *   are blocked.
 * - Retention per kind (§3.3): the newest `backups.keep` (14) daily backups and the newest `MANUAL_BACKUP_KEEP` (5) Back
 *   up now backups are kept, in the backups folder and in the second folder, so Back up now never pushes out a daily
 *   backup. A file without a Backup row (made after the backup that was restored) counts against neither and is deleted
 *   only once its name's date is `backups.keep` days old. The backup just made is never deleted, even when the PC's
 *   clock is behind and its name sorts before older
 *   ones; the Owner is told the clock looks wrong. The scripts' own backups (update.bat, restore.bat, database
 *   upgrades) are listed too and tidied up: the newest 3 of each kind, never one younger than 14 days. Only
 *   `pruneBackupFolders` deletes backup files.
 * - The second folder (§3.4): a marker file `outreach-backups.json` says which installation owns it, copies go through
 *   "<name>.tmp" with a free-space and size check, and the practice copy never copies there.
 * - The folder is <project>\backups for data\app.db. Any other database file (the practice copy, test databases) uses
 *   <project>\backups\<file name without .db>\ so they never mix.
 */

// ─────────────────────────── names and rules (pure) ───────────────────────────

export const BACKUP_KINDS = ["AUTO", "MANUAL", "PRE_UPDATE", "PRE_RESTORE"] as const;
export type BackupKindValue = (typeof BACKUP_KINDS)[number];

/** Every kind a listed backup can have: the Backup rows' kinds, plus the database upgrade backups of the scripts. */
export type BackupListKind = BackupKindValue | "PRE_MIGRATE";

/** One vocabulary everywhere: the app, restore.bat and the docs (M6-DESIGN §3.2). */
export const BACKUP_KIND_LABELS: Record<BackupListKind, string> = {
  AUTO: "Daily backup",
  MANUAL: "Back up now",
  PRE_UPDATE: "Before an update",
  PRE_RESTORE: "Before a restore",
  PRE_MIGRATE: "Before a database upgrade",
};

/** The label of a listed backup's kind; "Backup" for an app backup without a row (made after a restored backup). */
export function backupKindText(kind: BackupListKind | null): string {
  return kind ? BACKUP_KIND_LABELS[kind] : "Backup";
}

export function isBackupKind(value: unknown): value is BackupKindValue {
  return typeof value === "string" && (BACKUP_KINDS as readonly string[]).includes(value);
}

/** Dedupe keys for the "backup.run" job (one queued/running job per key). */
export const AUTO_BACKUP_DEDUPE_KEY = "backup:auto";
export const MANUAL_BACKUP_DEDUPE_KEY = "backup:manual";

export const DEFAULT_KEEP = 14;
/** Back up now backups kept (M6-DESIGN §3.3), next to the `backups.keep` daily ones. */
export const MANUAL_BACKUP_KEEP = 5;
/** The dashboard and Settings › Backups warn when the newest backup is older than this (one rule: @/core/backups/age). */
export { BACKUP_STALE_MS } from "@/core/backups/age";

/** app-2026-09-23-221405-k3x9.db (local time of the PC, seconds, 4 random characters). */
export const BACKUP_FILE_PATTERN = /^app-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9]{4})\.db$/;
const TMP_SUFFIX = ".tmp";
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The file in the second folder that says which installation owns it (M6-DESIGN §3.4). */
export const SECOND_FOLDER_MARKER = "outreach-backups.json";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "2026-09-23-221405" in the PC's local time (what the owner sees in Explorer and restore.bat). */
export function backupTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function randomSuffix(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += SUFFIX_ALPHABET[crypto.randomInt(SUFFIX_ALPHABET.length)];
  return s;
}

export function backupFileName(d: Date, suffix: string): string {
  if (!/^[a-z0-9]{4}$/.test(suffix)) throw new Error("A backup name suffix is 4 lowercase letters or digits.");
  return `app-${backupTimestamp(d)}-${suffix}.db`;
}

export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_PATTERN.test(name);
}

/** The local time encoded in a backup file name, or null for other files. */
export function backupDateFromName(name: string): Date | null {
  const m = BACKUP_FILE_PATTERN.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  const date = new Date(y!, mo! - 1, d!, h!, mi!, s!);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "keep" setting → a whole number of at least 1 (never delete every backup). */
export function normalizeKeep(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_KEEP;
  return Math.min(Math.max(Math.floor(n), 1), 1000);
}

export type BackupFileInfo = { name: string; mtimeMs?: number };

/** "app-YYYY-MM-DD-HHmmss": the fixed-width timestamp part of a backup name. */
const STAMP_LENGTH = "app-0000-00-00-000000".length;

/**
 * Which backup files to delete so that only the newest `keep` remain. Only files named like our
 * backups are considered; anything else in the folder is left alone. Names sort by their timestamp;
 * two backups made in the same second are ordered by their file time.
 * `protect` (the backup just made) is never deleted and counts as one of the `keep`: when the PC's
 * clock is behind, its name sorts before older backups, and it must not be the one that goes.
 */
export function selectBackupsToDelete(
  files: readonly (string | BackupFileInfo)[],
  keep: number,
  protect?: string | null,
): string[] {
  const ours = files
    .map((f) => (typeof f === "string" ? { name: f, mtimeMs: 0 } : { name: f.name, mtimeMs: f.mtimeMs ?? 0 }))
    .filter((f) => isBackupFileName(f.name));
  ours.sort((a, b) => {
    const sa = a.name.slice(0, STAMP_LENGTH);
    const sb = b.name.slice(0, STAMP_LENGTH);
    if (sa !== sb) return sa < sb ? 1 : -1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
  const protectedHere = Boolean(protect) && ours.some((f) => f.name === protect);
  const others = protectedHere ? ours.filter((f) => f.name !== protect) : ours;
  const keepOthers = normalizeKeep(keep) - (protectedHere ? 1 : 0);
  return others.slice(keepOthers).map((f) => f.name);
}

/**
 * Retention per kind (M6-DESIGN §3.3): the newest `keep` daily backups (row kind AUTO) and the newest
 * `MANUAL_BACKUP_KEEP` Back up now backups (row kind MANUAL). `protect` is never deleted and counts in its own kind, so
 * any number of Back up now clicks never pushes out a daily backup.
 *
 * A file without a row (kind null) counts against neither quota (review BACKUPS-1). After a restore, the restored
 * database has no rows for the backups made after the restored one (not even for the restored backup itself), so
 * counting those as daily would push real daily backups out right when the Owner is going through them. Such a file is
 * deleted only once the date in its name is more than `keep` days before `now` (one named later than `now`, after the
 * PC's clock went back, stays).
 */
export function selectBackupsToDeleteByKind(
  files: ReadonlyArray<BackupFileInfo & { kind: BackupKindValue | null }>,
  keep: number,
  protect?: string | null,
  now: Date = new Date(),
): string[] {
  const manual = files.filter((f) => f.kind === "MANUAL");
  const daily = files.filter((f) => f.kind !== null && f.kind !== "MANUAL");
  const windowMs = normalizeKeep(keep) * DAY_MS;
  const rowlessExpired = files
    .filter((f) => f.kind === null && f.name !== protect && isBackupFileName(f.name))
    .filter((f) => {
      const at = backupDateFromName(f.name);
      return at !== null && now.getTime() - at.getTime() > windowMs;
    })
    .map((f) => f.name);
  return [
    ...selectBackupsToDelete(daily, keep, protect),
    ...selectBackupsToDelete(manual, MANUAL_BACKUP_KEEP, protect),
    ...rowlessExpired,
  ];
}

/**
 * Leftovers of an interrupted backup: the app's "<backup>.db.tmp", the child process's "<backup>.db.tmp.tmp-<pid>-<ms>"
 * and the scripts' "app-<kind>-….db.tmp-<pid>-<ms>". Nothing else counts.
 */
export function isBackupLeftover(name: string): boolean {
  const m = /^(app-.+?\.db)(?:\.tmp|\.tmp\.tmp-\d+-\d+|\.tmp-\d+-\d+)$/.exec(name);
  return m !== null && (isBackupFileName(m[1]!) || SCRIPT_BACKUP_PATTERN.test(m[1]!));
}

/** Two hours of slack, so a daylight-saving change is never taken for a wrong clock. */
const CLOCK_SLACK_MS = 2 * 60 * 60 * 1000;

/**
 * The newest backup whose name says it was made later than `now` (the PC's clock is behind, e.g.
 * after a power cut reset it), or null when the clock looks right.
 */
export function backupNewerThanClock(names: readonly string[], now: Date): { name: string; at: Date } | null {
  let newest: { name: string; at: Date } | null = null;
  for (const name of names) {
    const at = backupDateFromName(name);
    if (!at || at.getTime() <= now.getTime() + CLOCK_SLACK_MS) continue;
    if (!newest || at.getTime() > newest.at.getTime()) newest = { name, at };
  }
  return newest;
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === "") return true;
  if (process.platform === "win32" && /^[a-z]:/i.test(rel)) return false; // another drive
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** <cwd>\backups for <cwd>\data\app.db; <cwd>\backups\<name>\ for any other database file. */
export function backupFolderFor(dbFile: string, cwd: string): string {
  const root = path.join(cwd, "backups");
  if (samePath(dbFile, path.join(cwd, "data", "app.db"))) return root;
  const base = path.basename(path.resolve(dbFile)).replace(/\.[^.]*$/, "");
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "database";
  return path.join(root, safe);
}

/** Folder for the database this process uses. */
export function backupFolder(): string {
  return backupFolderFor(databaseFilePath(), /*turbopackIgnore: true*/ process.cwd());
}

/** "12.3 MB", "840 KB", "512 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** The disk-space line (Settings › Backups; the dashboard's `disk-low` item says the same). */
export function diskLowText(freeBytes: number): string {
  return `The office PC's disk is almost full (${formatBytes(freeBytes)} free). Backups and sending stop when it's full.`;
}

// ─────────────────────────── making a backup ───────────────────────────

/**
 * What the checked snapshot (`scripts/vacuum-into.mjs`) answered. `check` is quick_check's answer when it wasn't "ok";
 * `missingHelper` says the helper itself isn't in the app's folder (nothing was started).
 */
export type VacuumResult =
  | { ok: true; size: number }
  | { ok: false; error: string; check: string | null; missingHelper?: boolean };

/** Free space of a folder's drive (fs.promises.statfs's shape); tests pass a stand-in. */
export type StatfsLike = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export type RunBackupOptions = {
  kind: BackupKindValue;
  /** Who asked for it (manual backups); null for automatic ones. */
  userId?: number | null;
  now?: Date;
  /** Tests: the checked snapshot (default: the child process scripts/vacuum-into.mjs). */
  vacuum?: (db: string, tmp: string) => Promise<VacuumResult>;
  /** Tests: the file operations of the copy to the second folder (a failing disk, a short copy, a full drive). */
  secondFolderIo?: { copyFile?: (from: string, to: string) => Promise<void>; statfs?: StatfsLike };
  /** Tests: a file's size in bytes (the backup and its copy), so a backup over 2 GiB needs no 2 GiB file. */
  sizeOf?: (file: string) => Promise<number>;
};

/** The Backup row's `sizeBytes` is an Int: a larger size is stored as this (the real size is used everywhere else). */
const MAX_ROW_SIZE = 2_147_483_647;

export type BackupResult = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  kind: BackupKindValue;
  /** The second folder the file was copied to, or null. */
  copiedTo: string | null;
  /** Why the copy to the second folder failed (the main backup is fine). */
  copyError: string | null;
  /** Older backups deleted from the backups folder (app backups per kind, and script backups). */
  removed: string[];
  /** An existing backup is dated later than the PC's clock: the clock is probably behind. */
  clockLooksWrong: boolean;
  summary: string;
};

/** Thrown when a backup is requested while this process is already making one. */
export class BackupBusyError extends PlainJobError {
  constructor() {
    super("A backup is already being made. Wait a minute, then try again.");
    this.name = "BackupBusyError";
  }
}

/** A backup problem told in plain words (shown as it is); technical text goes in `detail`. */
class PlainBackupError extends PlainJobError {
  constructor(message: string, detail?: string | null) {
    super(message, detail);
    this.name = "PlainBackupError";
  }
}

/** A copy problem found by the app itself (not the file system), with its plain reason. */
class CopyProblem extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
    this.name = "CopyProblem";
  }
}

/** Why a copy to the second folder failed, in plain words (the system's message stays in the task's result). */
export function copyFailureReason(err: unknown): string {
  if (err instanceof CopyProblem) return err.reason;
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  switch (code) {
    case "ENOENT":
      return "the folder isn't there (is the drive or USB stick plugged in?)";
    case "EACCES":
    case "EPERM":
      return "the app isn't allowed to save files in that folder";
    case "ENOSPC":
      return "that drive is full";
    case "EFBIG":
      return "the drive is formatted FAT32, which can't hold files over 4 GB";
    case "EEXIST":
      return "a file with the same name is already there";
    case "EBUSY":
      return "the folder is busy in another program";
    default:
      return "something unexpected went wrong";
  }
}

/**
 * The copy-failed notification's last sentence: what to do, by why the copy failed. Windows refused access
 * (EPERM/EACCES, `notAllowed`): the service accounts only get access through install-services.bat, which makes no
 * copy itself (review SCREENS-03).
 */
export function copyFixText(notAllowed: boolean): string {
  return notAllowed
    ? "If the app runs as a Windows service, run install-services.bat on the office PC so the background sender may write there, then click Back up now in Settings › Backups."
    : "Check that the drive is connected and the folder still exists, then click Back up now in Settings › Backups.";
}

/** A file's size in bytes. */
async function fileSize(file: string): Promise<number> {
  return (await fsp.stat(file)).size;
}

/** How long the checked snapshot may take before it is stopped. */
export const VACUUM_TIMEOUT_MS = 30 * 60_000;

/**
 * Where the app's own folder may be (the folder with package.json, dist\ and scripts\): the working folder (the
 * services' AppDirectory, start.bat's folder) and the folder above the running program's own (dist\worker.mjs,
 * worker\index.ts).
 */
export function appRootCandidates(
  cwd: string = /*turbopackIgnore: true*/ process.cwd(),
  entry: string | undefined = process.argv[1],
): string[] {
  const roots = [path.resolve(/*turbopackIgnore: true*/ cwd)];
  if (entry) roots.push(path.dirname(path.dirname(path.resolve(/*turbopackIgnore: true*/ entry))));
  return roots;
}

/**
 * scripts\vacuum-into.mjs of this installation (review SECURITY-03), or null when it isn't there: looked for only in
 * the app's own folder (a candidate of appRootCandidates that holds package.json), never in a folder above it. Whatever
 * a parent folder such as C:\scripts holds must never run with the app's rights.
 */
export function vacuumScriptPath(
  roots: readonly string[] = appRootCandidates(),
  exists: (file: string) => boolean = (f) => fs.existsSync(/*turbopackIgnore: true*/ f),
): string | null {
  for (const root of roots) {
    if (!exists(path.join(/*turbopackIgnore: true*/ root, "package.json"))) continue;
    const candidate = path.join(/*turbopackIgnore: true*/ root, "scripts", "vacuum-into.mjs");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The environment the backup helper gets (review SECURITY-03): what Windows and Node need to start a program, never
 * the app's keys (APP_ENCRYPTION_KEY) or its database address (the helper gets --db).
 */
const HELPER_ENV_KEYS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "COMSPEC"]);

export function vacuumChildEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && HELPER_ENV_KEYS.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** The backup's failure when the helper is missing from the app's folder (e.g. half-way through a manual update). */
export const HELPER_MISSING_TEXT =
  "Some of the app's files are missing (scripts\\vacuum-into.mjs), so no backup was made. If you were updating the app, finish the update first, then click Back up now in Settings › Backups.";

/**
 * The default snapshot: `node scripts/vacuum-into.mjs --db <file> --out <tmp> --json` in a child process (M6-DESIGN
 * §3.5), so this process's event loop keeps running. Resolves with its JSON answer; a child that can't start, stops
 * without an answer or runs longer than 30 minutes (then it is stopped) is a failure without a `check`. Without the
 * helper in the app's folder (`script` null) nothing is started: `missingHelper`.
 */
export function vacuumInChildProcess(
  dbFile: string,
  tmpFile: string,
  timeoutMs = VACUUM_TIMEOUT_MS,
  script: string | null = vacuumScriptPath(),
): Promise<VacuumResult> {
  if (!script) {
    return Promise.resolve({ ok: false, error: "scripts\\vacuum-into.mjs isn't in the app's folder", check: null, missingHelper: true });
  }
  // The script's own folder's parent is the app's folder.
  const cwd = path.dirname(path.dirname(script));
  return new Promise<VacuumResult>((resolve) => {
    let settled = false;
    const limit: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (r: VacuumResult) => {
      if (settled) return;
      settled = true;
      if (limit.timer) clearTimeout(limit.timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [script, "--db", dbFile, "--out", tmpFile, "--json"], {
        cwd,
        // Next's typing insists on NODE_ENV; the helper doesn't need it.
        env: vacuumChildEnv() as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, error: errorMessage(err), check: null });
      return;
    }
    let out = "";
    let errText = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (errText += b.toString("utf8")));
    limit.timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "The backup took longer than 30 minutes and was stopped.", check: null });
    }, timeoutMs);
    child.on("error", (err) => finish({ ok: false, error: errorMessage(err), check: null }));
    child.on("close", (code) => {
      const last = out.trim().split(/\r?\n/).pop() ?? "";
      const parsed = parseVacuumAnswer(last);
      finish(
        parsed ?? {
          ok: false,
          error: `The backup helper stopped without an answer (exit code ${String(code)})${errText.trim() ? `: ${errorMessage(errText)}` : ""}`,
          check: null,
        },
      );
    });
  });
}

function parseVacuumAnswer(line: string): VacuumResult | null {
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== "object") return null;
    const o = v as { ok?: unknown; size?: unknown; error?: unknown; check?: unknown };
    if (o.ok === true && typeof o.size === "number") return { ok: true, size: o.size };
    if (o.ok === false) {
      return { ok: false, error: typeof o.error === "string" ? o.error : "unknown error", check: typeof o.check === "string" ? o.check : null };
    }
    return null;
  } catch {
    return null;
  }
}

let backupInProgress = false;

/** Makes one backup now. Two backups never run at the same time in one process. */
export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  if (!isBackupKind(options.kind)) throw new Error(`Unknown backup kind "${String(options.kind)}".`);
  if (backupInProgress) throw new BackupBusyError();
  backupInProgress = true;
  try {
    return await makeBackup(options);
  } catch (err) {
    const { error } = describeJobError(err);
    await logActivity({
      actorId: options.userId ?? null,
      type: "backup.failed",
      summary: `The backup failed: ${error.replace(/\.$/, "")}`,
    }).catch(() => undefined);
    throw err;
  } finally {
    backupInProgress = false;
  }
}

async function makeBackup(options: RunBackupOptions): Promise<BackupResult> {
  const { kind, userId = null } = options;
  const now = options.now ?? new Date();
  const dbFile = path.resolve(databaseFilePath());
  if (!fs.existsSync(dbFile)) {
    throw new PlainBackupError(`The database file ${dbFile} is missing, so there's nothing to back up.`);
  }
  const folder = backupFolder();
  await fsp.mkdir(folder, { recursive: true });
  await ensureFreeSpace(folder, dbFile);

  const { fileName, finalPath, tmpPath } = await pickFreeName(folder, now);
  let snapshot: VacuumResult;
  try {
    snapshot = await (options.vacuum ?? vacuumInChildProcess)(dbFile, tmpPath);
  } catch (err) {
    snapshot = { ok: false, error: errorMessage(err), check: null };
  }
  if (!snapshot.ok) {
    // Nothing is renamed and nothing is pruned: the previous backups stay exactly as they were.
    await removeQuietly(tmpPath);
    if (snapshot.missingHelper) throw new PlainBackupError(HELPER_MISSING_TEXT, snapshot.error);
    if (snapshot.check) {
      throw new PlainBackupError(
        `The backup file failed SQLite's check (${snapshot.check}). The previous backups were kept. Try Back up now again; if it fails again, the database may be damaged: see "Backups and restore" in the README.`,
        snapshot.error,
      );
    }
    throw new PlainBackupError(
      `Couldn't write the backup file in ${folder}. Check that the disk isn't full and that the folder can be saved to, then try again.`,
      snapshot.error,
    );
  }
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    await removeQuietly(tmpPath);
    throw new PlainBackupError(
      `Couldn't write the backup file in ${folder}. Check that the disk isn't full and that the folder can be saved to, then try again.`,
      errorMessage(err),
    );
  }
  const sizeOf = options.sizeOf ?? fileSize;
  // The real size decides everything (the copy's check, the free space, the words); only the row is capped to its Int
  // column (review BACKUPS-2: a capped size made every copy of a backup over 2 GiB "come out incomplete").
  const sizeBytes = await sizeOf(finalPath);

  const settings = await getSettings(["backups.keep", "backups.secondFolder", "practice.copy"] as const);
  const keep = normalizeKeep(settings["backups.keep"]);
  // The row first, so the second folder's retention already knows this backup's kind.
  await dbWrite((c) =>
    c.backup.create({ data: { fileName, sizeBytes: Math.min(sizeBytes, MAX_ROW_SIZE), kind, copiedTo: null, createdAt: now } }),
  );

  // Second copy (optional; never in the practice copy). A failure here never loses the main backup.
  let copiedTo: string | null = null;
  let copyError: string | null = null;
  let copyReason = "";
  let copyNotAllowed = false;
  const second = settings["practice.copy"] === true ? "" : (settings["backups.secondFolder"] ?? "").trim();
  if (second) {
    const copy = await copyToSecondFolder({ second, fileName, finalPath, sizeBytes, now, io: options.secondFolderIo, sizeOf });
    if (copy.ok) {
      copiedTo = second;
      await dbWrite((c) => c.backup.updateMany({ where: { fileName }, data: { copiedTo } }));
    } else {
      copyError = copy.error;
      copyReason = copy.reason;
      copyNotAllowed = copy.notAllowed;
    }
  }

  // A clock that is behind names new backups "older" than existing ones: say so (they're still kept).
  const existing = (await listBackupFileNames(folder)) ?? [];
  const aheadOfClock = backupNewerThanClock(
    existing.filter((n) => n !== fileName),
    now,
  );

  // Keep the newest of each kind (never the one just made), tidy the scripts' backups and leftovers, and forget rows
  // whose file is gone. The second folder is pruned only after a good copy.
  const pruned = await pruneBackupFolders({ folder, second: copiedTo, keep, protect: fileName, now });
  const remaining = await listBackupFileNames(folder);
  if (remaining !== null) {
    await dbWrite((c) => c.backup.deleteMany({ where: { fileName: { notIn: remaining } } }));
  }

  if (copyError) {
    await notifyOwner({
      type: "backup.copyFailed",
      title: "Couldn't copy the backup to the second folder",
      body: `Couldn't copy the backup to ${second}: ${copyReason}. The backup itself is saved on this PC. ${copyFixText(copyNotAllowed)}`,
      link: "/settings/backups",
    });
  }

  if (aheadOfClock) {
    await notifyOwner(
      {
        type: "backup.clockWrong",
        title: "The office PC's clock looks wrong",
        body:
          `A backup named ${aheadOfClock.name} is dated later than the PC's clock says it is now. ` +
          "New backups are still saved and kept, but their dates will look wrong. " +
          "Set the correct date and time in Windows Settings › Time & language on the office PC.",
        link: "/settings/backups",
      },
      { onlyIfNoUnread: true },
    );
  }

  const size = formatBytes(sizeBytes);
  const who = userId ? await userName(userId) : null;
  const saved =
    kind === "AUTO"
      ? `Daily backup saved (${size}).`
      : kind === "PRE_UPDATE"
        ? `Backup saved before an update (${size}).`
        : kind === "PRE_RESTORE"
          ? `Backup saved before a restore (${size}).`
          : `Backup saved (${size}).`;
  // The task's summary (Back up now shows it): whether the second copy worked, so the page tells the whole story.
  const copyNote = copyError ? copyFailedNote(copyReason, copyNotAllowed) : "";
  const summary = `${saved}${copyNote}${aheadOfClock ? " The PC's clock looks wrong: check its date and time." : ""}`;
  await logActivity({
    actorId: userId,
    type: "backup.done",
    summary: kind === "MANUAL" && who ? `${who} backed up the database (${size})` : saved.replace(/\.$/, ""),
    data: { fileName, sizeBytes, kind, copiedTo },
  });

  // A restore marker that was handled but couldn't be deleted (an antivirus lock) is tried again with every backup,
  // so at least daily (review BACKUPS-4). Never a reason for the backup to fail.
  try {
    await (await import("@/server/services/sending/restore")).deleteHandledRestoreMarker();
  } catch {
    /* tried again with the next backup */
  }

  return {
    fileName,
    filePath: finalPath,
    sizeBytes,
    kind,
    copiedTo,
    copyError,
    removed: [...pruned.removed, ...pruned.removedScripts],
    clockLooksWrong: Boolean(aheadOfClock),
    summary,
  };
}

async function pickFreeName(folder: string, now: Date) {
  for (let i = 0; i < 10; i++) {
    const fileName = backupFileName(now, randomSuffix());
    const finalPath = path.join(folder, fileName);
    const tmpPath = finalPath + TMP_SUFFIX;
    if (!fs.existsSync(finalPath) && !fs.existsSync(tmpPath)) return { fileName, finalPath, tmpPath };
  }
  throw new PlainBackupError("Couldn't find a free file name for the backup. Try again in a second.");
}

async function ensureFreeSpace(folder: string, dbFile: string): Promise<void> {
  let free: number;
  let needed: number;
  try {
    const stats = await fsp.statfs(folder);
    free = Number(stats.bavail) * Number(stats.bsize);
    const dbSize = (await fsp.stat(dbFile)).size;
    const walSize = await fsp.stat(dbFile + "-wal").then((s) => s.size, () => 0);
    needed = Math.ceil((dbSize + walSize) * 1.1) + 5 * MB;
  } catch {
    return; // Can't tell on this system: let VACUUM INTO report a real problem.
  }
  if (Number.isFinite(free) && free < needed) {
    throw new PlainBackupError(
      `There isn't enough free disk space: the backup needs about ${formatBytes(needed)} and only ` +
        `${formatBytes(free)} is free. Delete some files or empty the Recycle Bin, then try again.`,
    );
  }
}

/** Free bytes on a folder's drive, or null when that can't be told (a missing folder, an unusual file system). */
async function freeBytesOf(dir: string, statfs: StatfsLike = (d) => fsp.statfs(d)): Promise<number | null> {
  try {
    const s = await statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/**
 * Copies the backup just made to the second folder (M6-DESIGN §3.4): the folder's marker must name this installation
 * (a folder without one gets it now); the drive needs the backup's size plus 5 MB free; the copy goes to
 * "<name>.tmp", its size is compared with the backup, then it is renamed. Any failure removes the ".tmp".
 * `sizeBytes` is the backup's real size (never the row's capped one). `notAllowed`: Windows refused access
 * (EPERM/EACCES), which install-services.bat fixes for the services.
 */
async function copyToSecondFolder(a: {
  second: string;
  fileName: string;
  finalPath: string;
  sizeBytes: number;
  now: Date;
  io?: RunBackupOptions["secondFolderIo"];
  sizeOf: (file: string) => Promise<number>;
}): Promise<{ ok: true } | { ok: false; reason: string; error: string; notAllowed: boolean }> {
  const copyFile = a.io?.copyFile ?? ((from: string, to: string) => fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL));
  try {
    const instanceId = await currentInstanceId();
    const marker = await readSecondFolderMarker(a.second);
    if (marker && marker.instanceId !== instanceId) {
      throw new CopyProblem(
        "this folder belongs to another copy of the app",
        `${SECOND_FOLDER_MARKER} names another installation (${marker.instanceId})`,
      );
    }
    if (!marker && instanceId) await writeSecondFolderMarker(a.second, instanceId, a.now);

    const free = await freeBytesOf(a.second, a.io?.statfs);
    const needed = a.sizeBytes + 5 * MB;
    if (free !== null && free < needed) {
      throw new CopyProblem("that drive is full", `${free} bytes free, ${needed} needed`);
    }

    const dest = path.join(a.second, a.fileName);
    const tmp = dest + TMP_SUFFIX;
    if (fs.existsSync(dest)) throw Object.assign(new Error(`${dest} already exists`), { code: "EEXIST" });
    await removeQuietly(tmp);
    try {
      await copyFile(a.finalPath, tmp);
      const copied = await a.sizeOf(tmp);
      if (copied !== a.sizeBytes) {
        throw new CopyProblem("the copy came out incomplete", `copied ${copied} of ${a.sizeBytes} bytes`);
      }
      await fsp.rename(tmp, dest);
    } catch (err) {
      await removeQuietly(tmp);
      throw err;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: copyFailureReason(err), error: errorMessage(err), notAllowed: isPermissionError(err) };
  }
}

/** Names of our backup files in a folder, or null if the folder can't be read. */
async function listBackupFileNames(folder: string): Promise<string[] | null> {
  try {
    return (await fsp.readdir(folder)).filter(isBackupFileName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
}

type FolderEntry = { name: string; mtimeMs: number };

/** A folder's file names with their times; empty when it can't be read. */
async function folderEntries(folder: string): Promise<FolderEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(folder);
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      mtimeMs: await fsp.stat(path.join(folder, name)).then((s) => s.mtimeMs, () => 0),
    })),
  );
}

/** Deletes one file; a file already gone counts as deleted, one that is open elsewhere is tried again next time. */
async function deleteFile(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function removeQuietly(file: string): Promise<void> {
  await fsp.rm(file, { force: true }).catch(() => undefined);
}

/** The `Backup` rows' kinds of these files (read before rows of vanished files are deleted). */
async function kindsOf(names: readonly string[]): Promise<Map<string, BackupKindValue>> {
  const out = new Map<string, BackupKindValue>();
  for (let i = 0; i < names.length; i += 500) {
    const rows = await db.backup.findMany({
      where: { fileName: { in: names.slice(i, i + 500) } },
      select: { fileName: true, kind: true },
    });
    for (const r of rows) if (isBackupKind(r.kind)) out.set(r.fileName, r.kind);
  }
  return out;
}

/**
 * The only place that deletes backup files (M6-DESIGN §0.2 rule 9, §3.3), after every app backup:
 *  - the backups folder: app backups beyond the newest `keep` daily and `MANUAL_BACKUP_KEEP` Back up now ones
 *    (`protect` never goes), and app backups without a row once their name's date is `keep` days before `now` (they
 *    count against neither kind: selectBackupsToDeleteByKind); script backups beyond the newest 3 of each kind but
 *    never one younger than 14 days, with their -wal/-shm companions; leftovers of interrupted backups
 *    (`isBackupLeftover`) older than a day;
 *  - the second folder, when given (only after a good copy): its app backups the same way per kind (files without a
 *    row by their age) and its "<backup>.tmp" leftovers older than a day. Script backups are never copied there.
 * Anything else in either folder is left alone. Returns the deleted names.
 */
export async function pruneBackupFolders(opts: {
  folder: string;
  second?: string | null;
  keep: number;
  protect: string | null;
  now: Date;
}): Promise<{ removed: string[]; removedScripts: string[]; removedInSecond: string[] }> {
  // Leftovers are aged by their file time, which is always the PC's real clock.
  const dayAgo = Date.now() - DAY_MS;
  const main = await folderEntries(opts.folder);
  const second = opts.second ? await folderEntries(opts.second) : [];
  const kinds = await kindsOf([
    ...new Set([...main, ...second].map((e) => e.name).filter(isBackupFileName)),
  ]);
  const withKinds = (entries: FolderEntry[]) =>
    entries.filter((e) => isBackupFileName(e.name)).map((e) => ({ ...e, kind: kinds.get(e.name) ?? null }));

  const removed: string[] = [];
  for (const name of selectBackupsToDeleteByKind(withKinds(main), opts.keep, opts.protect, opts.now)) {
    if (await deleteFile(path.join(opts.folder, name))) removed.push(name);
  }

  const removedScripts: string[] = [];
  for (const name of scriptBackupsToDelete(main, opts.now)) {
    if (!(await deleteFile(path.join(opts.folder, name)))) continue;
    removedScripts.push(name);
    for (const companion of ["-wal", "-shm"]) await removeQuietly(path.join(opts.folder, name + companion));
  }

  for (const e of main) {
    if (isBackupLeftover(e.name) && e.mtimeMs < dayAgo) await deleteFile(path.join(opts.folder, e.name));
  }

  const removedInSecond: string[] = [];
  if (opts.second) {
    for (const name of selectBackupsToDeleteByKind(withKinds(second), opts.keep, opts.protect, opts.now)) {
      if (await deleteFile(path.join(opts.second, name))) removedInSecond.push(name);
    }
    for (const e of second) {
      const base = e.name.endsWith(TMP_SUFFIX) ? e.name.slice(0, -TMP_SUFFIX.length) : "";
      if (isBackupFileName(base) && e.mtimeMs < dayAgo) await deleteFile(path.join(opts.second, e.name));
    }
  }
  return { removed, removedScripts, removedInSecond };
}

// ─────────────────────────── reading ───────────────────────────

export type BackupListItem = {
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  /**
   * An app backup's kind from its row (AUTO or MANUAL), null for a file with no row (e.g. made after the backup that
   * was restored); a script backup's kind from its name (PRE_UPDATE, PRE_RESTORE, PRE_MIGRATE).
   */
  kind: BackupListKind | null;
  copiedTo: string | null;
  /** "app": made by the background sender (Daily backup, Back up now); "script": by update.bat, restore.bat, setup. */
  source: "app" | "script";
};

/** App and script backups that exist on disk, newest first (the disk is the truth; rows add the kind). */
export async function listBackups(): Promise<BackupListItem[]> {
  const folder = backupFolder();
  let names: string[];
  try {
    names = await fsp.readdir(folder);
  } catch {
    return [];
  }
  const appNames = names.filter(isBackupFileName);
  const scriptNames = names.filter((n) => SCRIPT_BACKUP_PATTERN.test(n));
  if (appNames.length + scriptNames.length === 0) return [];
  const rows = appNames.length > 0 ? await db.backup.findMany({ where: { fileName: { in: appNames } } }) : [];
  const byName = new Map(rows.map((r) => [r.fileName, r]));
  const stat = async (fileName: string) => {
    try {
      // The backups folder is only known at run time: don't let the build trace the whole project.
      return await fsp.stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ folder, fileName));
    } catch {
      return null;
    }
  };
  const items = await Promise.all([
    ...appNames.map(async (fileName): Promise<BackupListItem | null> => {
      const st = await stat(fileName);
      if (!st?.isFile()) return null;
      const row = byName.get(fileName);
      return {
        fileName,
        sizeBytes: st.size,
        createdAt: row?.createdAt ?? backupDateFromName(fileName) ?? st.mtime,
        kind: row && isBackupKind(row.kind) ? row.kind : null,
        copiedTo: row?.copiedTo ?? null,
        source: "app",
      };
    }),
    ...scriptNames.map(async (fileName): Promise<BackupListItem | null> => {
      const st = await stat(fileName);
      if (!st?.isFile()) return null;
      return {
        fileName,
        sizeBytes: st.size,
        createdAt: scriptBackupDate(fileName) ?? st.mtime,
        kind: scriptBackupKind(fileName),
        copiedTo: null,
        source: "script",
      };
    }),
  ]);
  return items
    .filter((i): i is BackupListItem => i !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.fileName < b.fileName ? 1 : -1));
}

export type BackupStatus = {
  /** Newest app backup (Daily or Back up now); script backups don't count here. */
  newest: { at: Date; kind: BackupListKind | null; fileName: string } | null;
  /** backupAge(newest?.at ?? null, now).state: older than 36 hours is "stale". */
  age: "ok" | "stale" | "never";
  /** The second backup folder; null when none is set, and always in the practice copy. */
  secondFolder: string | null;
  /**
   * The newest app backup's row has no copy while a second folder is set and that backup is newer than the folder
   * setting (so a folder saved a minute ago isn't blamed for older backups); always false in the practice copy.
   */
  lastCopyFailed: boolean;
  workerRunning: boolean;
  /** Free bytes on the data folder's drive (fsp.statfs), null when unknown. */
  freeBytes: number | null;
  /** app.db + its -wal, in bytes. */
  dbBytes: number;
  /** freeBytes below max(2 GB, 3 × dbBytes). */
  diskLow: boolean;
};

/**
 * The backup facts Settings › Backups and the dashboard show (M6-DESIGN §3.6): the newest app backup and its age, the
 * second folder and whether the last copy there failed, whether the background sender runs, and the disk space.
 * Reads only. `deps` are for tests (a stand-in statfs) and for a caller that already listed the backups.
 */
export async function backupStatus(
  now: Date = new Date(),
  deps: { statfs?: StatfsLike; backups?: BackupListItem[] } = {},
): Promise<BackupStatus> {
  const [list, settings, worker, folderRow] = await Promise.all([
    deps.backups ?? listBackups(),
    getSettings(["backups.secondFolder", "practice.copy"] as const),
    getWorkerStatus(now),
    db.setting.findUnique({ where: { key: "backups.secondFolder" }, select: { updatedAt: true } }),
  ]);
  const practice = settings["practice.copy"] === true;
  const newestApp = list.find((b) => b.source === "app") ?? null;
  const secondFolder = practice ? null : (settings["backups.secondFolder"] ?? "").trim() || null;
  const lastCopyFailed =
    secondFolder !== null &&
    newestApp !== null &&
    newestApp.kind !== null &&
    newestApp.copiedTo === null &&
    folderRow !== null &&
    newestApp.createdAt.getTime() > folderRow.updatedAt.getTime();

  const dbFile = databaseFilePath();
  const sizeOf = (f: string) => fsp.stat(/*turbopackIgnore: true*/ f).then((s) => s.size, () => 0);
  const [dbSize, walSize, freeBytes] = await Promise.all([
    sizeOf(dbFile),
    sizeOf(dbFile + "-wal"),
    freeBytesOf(path.dirname(dbFile), deps.statfs),
  ]);
  const dbBytes = dbSize + walSize;
  return {
    newest: newestApp ? { at: newestApp.createdAt, kind: newestApp.kind, fileName: newestApp.fileName } : null,
    age: backupAge(newestApp?.createdAt ?? null, now).state,
    secondFolder,
    lastCopyFailed,
    workerRunning: worker.running,
    freeBytes,
    dbBytes,
    diskLow: freeBytes !== null && freeBytes < Math.max(2 * GB, 3 * dbBytes),
  };
}

/**
 * Quiet time for the daily backup (M6-DESIGN §3.5): true when no gated email (TEST/LIVE, or a dry run that keeps
 * sending hours) is due in a zone whose sending window is open now; false when one is. Any problem gives null, so the
 * fixed 22:00–08:00 window decides (worker/schedule.ts). `deps.loadDueStats` is for tests.
 */
export async function backupQuietNow(
  now: Date,
  deps: { loadDueStats?: typeof loadDueStats } = {},
): Promise<boolean | null> {
  try {
    const s = await getSettings(["sending.window", "defaultTimeZone", "practice.copy"] as const);
    const window = parseWindow(s["sending.window"]);
    // Loaded here, not at the top: the sending gates are the background sender's, and Settings › Backups never needs them.
    const load = deps.loadDueStats ?? (await import("@/server/services/sending/gates")).loadDueStats;
    const due = await load(now, {
      defaultZone: s.defaultTimeZone,
      practiceCopy: s["practice.copy"] === true,
    });
    return !due.some((d) => d.count > 0 && isWindowOpen(now, d.zone, window));
  } catch {
    return null;
  }
}

/** The manual backup that's waiting or running right now, if any. */
export async function getPendingManualBackupJob(): Promise<{ id: number; status: string } | null> {
  const job = await db.job.findUnique({
    where: { activeDedupeKey: MANUAL_BACKUP_DEDUPE_KEY },
    select: { id: true, status: true },
  });
  return job;
}

/** "Back up now": queues a manual backup for the background sender (one at a time). */
export async function enqueueManualBackup(userId: number): Promise<{ id: number; status: string }> {
  const job = await enqueueJob({
    type: "backup.run",
    payload: { kind: "MANUAL" },
    dedupeKey: MANUAL_BACKUP_DEDUPE_KEY,
    createdById: userId,
    priority: 5,
  });
  return { id: job.id, status: job.status };
}

// ─────────────────────────── the second folder ───────────────────────────

/** This database's installation id (SystemState "instance", written by the background sender at start), or null. */
export async function currentInstanceId(): Promise<string | null> {
  try {
    return parseInstanceState((await readTyped(STATE_KEYS.instance, (v) => v)).value)?.id ?? null;
  } catch {
    return null;
  }
}

export type SecondFolderMarker = { instanceId: string; host: string | null; savedAt: string | null };

/**
 * The second folder's `outreach-backups.json`, or null when there is none (or it isn't ours to read: not JSON, no
 * `instanceId`). Other errors (no permission, a missing drive) are thrown.
 */
export async function readSecondFolderMarker(
  folder: string,
  readFile: (file: string, encoding: "utf8") => Promise<string> = (f, e) => fsp.readFile(f, e),
): Promise<SecondFolderMarker | null> {
  let text: string;
  try {
    text = await readFile(path.join(folder, SECOND_FOLDER_MARKER), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const instanceId = typeof o.instanceId === "string" && o.instanceId.trim() ? o.instanceId.trim() : null;
    if (!instanceId) return null;
    return {
      instanceId,
      host: typeof o.host === "string" ? o.host : null,
      savedAt: typeof o.savedAt === "string" ? o.savedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Writes `outreach-backups.json` ({instanceId, host, savedAt}) into the second folder, through a temporary name and a
 * rename. Never creates the folder: an unplugged drive must stay a failed copy, not a new folder elsewhere.
 */
export async function writeSecondFolderMarker(folder: string, instanceId: string, now: Date = new Date()): Promise<void> {
  const file = path.join(folder, SECOND_FOLDER_MARKER);
  const tmp = `${file}.tmp-${process.pid}`;
  const text = JSON.stringify({ instanceId, host: os.hostname(), savedAt: now.toISOString() }, null, 2) + "\n";
  await fsp.writeFile(tmp, text, "utf8");
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

export type DriveType = "remote" | "removable" | "fixed" | "unknown";

/**
 * What Windows says a drive letter is (`[System.IO.DriveInfo]::new('Z').DriveType`, 10-second limit): "remote" for a
 * mapped network drive, "removable" (a USB stick), "fixed", else "unknown". Any problem is "unknown", which never
 * refuses a folder on its own.
 */
export function driveTypeOf(letter: string): Promise<DriveType> {
  if (process.platform !== "win32" || !/^[A-Za-z]$/.test(letter)) return Promise.resolve("unknown");
  return new Promise<DriveType>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `[System.IO.DriveInfo]::new('${letter.toUpperCase()}').DriveType`],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve("unknown");
        const t = String(stdout).trim().toLowerCase();
        resolve(t === "network" ? "remote" : t === "removable" ? "removable" : t === "fixed" ? "fixed" : "unknown");
      },
    );
  });
}

export type FolderCheck = { ok: true; folder: string; warning: string | null } | { ok: false; error: string };

/** Stand-ins for checkSecondFolder (tests): the file system, the drive types, this installation and the app folder. */
export type SecondFolderDeps = {
  fs?: {
    stat?: (p: string) => Promise<{ isDirectory(): boolean }>;
    writeFile?: (p: string, data: string, opts: { flag: string }) => Promise<void>;
    unlink?: (p: string) => Promise<void>;
    readFile?: (p: string, encoding: "utf8") => Promise<string>;
  };
  driveTypeOf?: (letter: string) => Promise<DriveType>;
  /** This installation's id (default: SystemState "instance"). */
  instanceId?: string | null;
  /** The app's folder (default: the working folder, which holds backups\ and data\). */
  appRoot?: string;
  /** The database's size, for the OneDrive estimate (default: the database file's size). */
  dbBytes?: number;
  /** Where Windows, the programs and the user profiles live (default: this process's environment). */
  env?: Record<string, string | undefined>;
};

/** The words of the second-folder checks (M6-DESIGN §3.4). */
export const SECOND_FOLDER_TEXTS = {
  empty: "Enter the full path of a folder, for example D:\\Backups.",
  tooLong: "That path is too long. Pick a folder with a shorter path.",
  network:
    "Network folders don't work while the app runs as a Windows service. Pick a folder on another drive, a USB stick or a OneDrive folder.",
  notAbsolute: "Enter the full path, starting with the drive letter, for example D:\\Backups.",
  driveRoot: (letter: string) => `Pick a folder on that drive, for example ${letter}:\\Outreach backups.`,
  insideApp: "Pick a folder outside the app's folder, so a copy survives if this folder is lost.",
  systemFolder:
    "Pick a folder of its own, for example a new folder on a USB stick or in OneDrive (not a Windows, program or whole-profile folder).",
  mappedDrive:
    "That drive letter points to a network folder, which doesn't work while the app runs as a Windows service. Pick a folder on another drive, a USB stick or a OneDrive folder.",
  missing: "That folder doesn't exist. Create it first (or plug in the drive), then try again.",
  isFile: "That's a file, not a folder. Enter the folder's path, for example D:\\Backups.",
  otherInstall: "This folder holds backups of another copy of the app. Pick an empty folder.",
  notAllowed:
    "The app isn't allowed to save files in that folder. Pick another folder, or give it permission in the folder's Properties › Security.",
  cantWriteYet:
    "The app can't write there yet. If it runs as a Windows service, run install-services.bat on the office PC now; otherwise give it permission in the folder's Properties › Security. Until then copies fail and the dashboard says so.",
  oneDrive: (bytes: number) =>
    `OneDrive keeps an online copy only while it is signed in and syncing on this PC. ${DEFAULT_KEEP} daily and ${MANUAL_BACKUP_KEEP} Back up now backups need about ${formatBytes(bytes)} of OneDrive space.`,
  removable: "Copies fail while the stick is unplugged; the dashboard tells you.",
  sameDrive: (letter: string) =>
    `This folder is on the same drive as the app (${letter}:). A copy there doesn't help if this drive fails.`,
} as const;

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? "";
const isPermissionError = (err: unknown) => errCode(err) === "EPERM" || errCode(err) === "EACCES";

/** An environment variable, looked up without regard to case (Windows' rule); empty counts as missing. */
function envValue(env: Record<string, string | undefined>, name: string): string | null {
  const want = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === want && value && value.trim()) return value.trim();
  }
  return null;
}

/** The folders of a user profile that are never a second backup folder themselves (a folder inside them is fine). */
const PROFILE_FOLDER_NAME = /^(documents|desktop|pictures|downloads|onedrive( - .+)?)$/i;
/** The profile folders that can also sit directly inside a OneDrive folder (OneDrive's folder backup). */
const MOVABLE_PROFILE_FOLDER_NAME = /^(documents|desktop|pictures|downloads)$/i;
/** OneDrive's own folder: "OneDrive", or "OneDrive - <organisation>" for a work account. */
const ONEDRIVE_NAME = /^onedrive( - .+)?$/i;

/** Windows' and the programs' usual folders, refused whatever the environment says (service-acl.mjs does the same). */
const DEFAULT_SYSTEM_FOLDERS = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
/** A path on a local drive letter (not a network share, not relative). */
const onDriveLetter = (p: string) => /^[A-Za-z]:[\\/]/.test(p);
/** A whole drive such as D:\. */
const isDriveRootPath = (p: string) => /^[A-Za-z]:$/.test(path.resolve(p).replace(/[\\/]+$/, ""));

/**
 * Windows' and the programs' folders: %WINDIR%, %SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, %ProgramW6432% and
 * %ProgramData% (a value that isn't a folder on a drive letter, or is a whole drive, is ignored), plus their usual
 * places on C:, which are refused either way. The same list as systemFolders() in scripts/lib/service-acl.mjs.
 */
function systemFolders(env: Record<string, string | undefined>): string[] {
  const fromEnv = ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]
    .map((name) => envValue(env, name))
    .filter((v): v is string => v !== null && onDriveLetter(v) && !isDriveRootPath(v));
  return [...fromEnv, ...DEFAULT_SYSTEM_FOLDERS].map((p) => path.resolve(p));
}

/**
 * The folders that hold the user profiles: the parent of %PUBLIC% and of %USERPROFILE% (unless that is a service's
 * profile inside Windows' folder), %SystemDrive%\Users and C:\Users. Never a whole drive. The same list as
 * profileFolders() in scripts/lib/service-acl.mjs.
 */
function profileFolders(env: Record<string, string | undefined>): string[] {
  const system = systemFolders(env);
  const out: string[] = [];
  const add = (p: string) => {
    if (onDriveLetter(p) && !isDriveRootPath(p)) out.push(path.resolve(p));
  };
  const pub = envValue(env, "PUBLIC");
  if (pub && onDriveLetter(pub)) add(path.dirname(path.resolve(/*turbopackIgnore: true*/ pub)));
  const home = envValue(env, "USERPROFILE");
  if (home && onDriveLetter(home) && !system.some((s) => isInside(home, s))) add(path.dirname(path.resolve(/*turbopackIgnore: true*/ home)));
  const drive = envValue(env, "SystemDrive");
  if (drive && /^[A-Za-z]:$/.test(drive)) add(`${drive}\\Users`);
  add("C:\\Users");
  return out;
}

/**
 * Whether a second backup folder is one Windows, the programs or a whole user profile own (review SECURITY-01). This is
 * the same rule as secondFolderRefusal() in scripts/lib/service-acl.mjs (tests/unit/backups-core/second-folder-parity
 * checks both on one table), so Settings › Backups refuses exactly what install-services.bat would refuse (it gives the
 * background services change rights on the folder):
 *  - the app's own folder, a folder inside it or a folder that contains it;
 *  - anything inside Windows' or the programs' folders (systemFolders);
 *  - a folder that holds the user profiles (C:\Users), a user profile (C:\Users\<name>), or that profile's Documents,
 *    Desktop, Pictures, Downloads or OneDrive folder itself (C:\Users\polyg\OneDrive\Outreach backups is fine);
 *  - the OneDrive folder %OneDrive%, %OneDriveConsumer% or %OneDriveCommercial% names, wherever it is;
 *  - a Documents, Desktop, Pictures or Downloads folder directly inside a OneDrive folder (OneDrive's folder backup
 *    puts them there: C:\Users\polyg\OneDrive\Documents).
 * Paths are resolved and compared without regard to case.
 */
export function isSystemOrProfileFolder(folder: string, appRoot: string, env: Record<string, string | undefined> = process.env): boolean {
  const target = path.resolve(folder);
  if (isInside(target, appRoot) || isInside(appRoot, target)) return true;
  if (systemFolders(env).some((root) => isInside(target, root))) return true;

  const parent = path.dirname(target);
  const grandparent = path.dirname(parent);
  const wholeProfileFolder = PROFILE_FOLDER_NAME.test(path.basename(target));
  const profiles = profileFolders(env);
  if (profiles.some((users) => samePath(target, users) || samePath(parent, users) || (samePath(grandparent, users) && wholeProfileFolder))) {
    return true;
  }
  const oneDrives = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
    .map((name) => envValue(env, name))
    .filter((v): v is string => v !== null && onDriveLetter(v));
  if (oneDrives.some((v) => samePath(v, target))) return true;
  // OneDrive's folder backup moves Documents, Desktop and Pictures into the OneDrive folder
  // (C:\Users\<name>\OneDrive\Documents): those are whole profile folders too.
  if (!MOVABLE_PROFILE_FOLDER_NAME.test(path.basename(target))) return false;
  const inProfileOneDrive =
    ONEDRIVE_NAME.test(path.basename(parent)) && profiles.some((users) => samePath(path.dirname(grandparent), users));
  return inProfileOneDrive || oneDrives.some((v) => samePath(v, parent));
}

/**
 * Checks a second backup folder typed by the Owner (M6-DESIGN §3.4), in this order: empty, too long, a network path, not
 * a full path, a whole drive, inside the app's folder, a Windows, program or whole-profile folder (or one containing
 * the app's folder: isSystemOrProfileFolder), a mapped network drive, missing or a file, another installation's folder
 * (its marker). A folder the app may not see or write to yet (EPERM/EACCES: the web service's account before
 * install-services.bat granted it) is still accepted, with a warning. A good folder may carry one warning: OneDrive, a
 * removable drive, or the app's own drive.
 */
export async function checkSecondFolder(input: string, deps: SecondFolderDeps = {}): Promise<FolderCheck> {
  const T = SECOND_FOLDER_TEXTS;
  const io = {
    stat: deps.fs?.stat ?? ((p: string) => fsp.stat(p)),
    writeFile: deps.fs?.writeFile ?? ((p: string, data: string, opts: { flag: string }) => fsp.writeFile(p, data, opts)),
    unlink: deps.fs?.unlink ?? ((p: string) => fsp.unlink(p)),
    readFile: deps.fs?.readFile ?? ((p: string, e: "utf8") => fsp.readFile(p, e)),
  };
  const raw = input.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!raw) return { ok: false, error: T.empty };
  if (raw.length > 240) return { ok: false, error: T.tooLong };
  if (/^(\\\\|\/\/)/.test(raw)) return { ok: false, error: T.network };
  const absolute = process.platform === "win32" ? /^[a-zA-Z]:[\\/]/.test(raw) : path.isAbsolute(raw);
  if (!absolute) return { ok: false, error: T.notAbsolute };

  const folder = path.resolve(raw);
  const letter = /^([a-zA-Z]):/.exec(folder)?.[1]?.toUpperCase() ?? null;
  const trimmed = folder.replace(/[\\/]+$/, "");
  if (trimmed === "" || /^[a-zA-Z]:$/.test(trimmed)) return { ok: false, error: T.driveRoot(letter ?? "E") };
  const appRoot = deps.appRoot ?? /*turbopackIgnore: true*/ process.cwd();
  if (isInside(folder, appRoot)) return { ok: false, error: T.insideApp };
  if (isSystemOrProfileFolder(folder, appRoot, deps.env ?? process.env)) return { ok: false, error: T.systemFolder };
  const driveType = letter ? await (deps.driveTypeOf ?? driveTypeOf)(letter) : "unknown";
  if (driveType === "remote") return { ok: false, error: T.mappedDrive };

  const cantWriteYet: FolderCheck = { ok: true, folder, warning: T.cantWriteYet };
  let stats: { isDirectory(): boolean };
  try {
    stats = await io.stat(folder);
  } catch (err) {
    return isPermissionError(err) ? cantWriteYet : { ok: false, error: T.missing };
  }
  if (!stats.isDirectory()) return { ok: false, error: T.isFile };

  let marker: SecondFolderMarker | null = null;
  try {
    marker = await readSecondFolderMarker(folder, io.readFile);
  } catch (err) {
    if (isPermissionError(err)) return cantWriteYet;
  }
  if (marker) {
    const ours = deps.instanceId !== undefined ? deps.instanceId : await currentInstanceId();
    if (marker.instanceId !== ours) return { ok: false, error: T.otherInstall };
  }

  const probe = path.join(folder, `.outreach-write-test-${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    await io.writeFile(probe, "ok", { flag: "wx" });
    await io.unlink(probe);
  } catch (err) {
    await fsp.rm(probe, { force: true }).catch(() => undefined);
    return isPermissionError(err) ? cantWriteYet : { ok: false, error: T.notAllowed };
  }

  let warning: string | null = null;
  if (folder.split(/[\\/]+/).some((part) => /^onedrive( - .+)?$/i.test(part))) {
    const dbBytes = deps.dbBytes ?? (await fsp.stat(databaseFilePath()).then((s) => s.size, () => 0));
    warning = T.oneDrive((DEFAULT_KEEP + MANUAL_BACKUP_KEEP) * dbBytes);
  } else if (driveType === "removable") {
    warning = T.removable;
  } else {
    const appLetter = /^([a-zA-Z]):/.exec(path.resolve(/*turbopackIgnore: true*/ appRoot))?.[1]?.toUpperCase() ?? null;
    if (letter && appLetter === letter) warning = T.sameDrive(letter);
  }
  return { ok: true, folder, warning };
}

// ─────────────────────────── helpers ───────────────────────────

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().replace(/\.$/, "") || "unknown error";
}

async function userName(id: number): Promise<string | null> {
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  return u?.name ?? null;
}

async function notifyOwner(
  n: { type: string; title: string; body: string; link?: string },
  opts: { onlyIfNoUnread?: boolean } = {},
): Promise<void> {
  try {
    const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, select: { id: true } });
    if (!owner) return;
    if (opts.onlyIfNoUnread) {
      // One reminder at a time: don't pile up the same warning every day.
      const unread = await db.notification.count({ where: { userId: owner.id, type: n.type, readAt: null } });
      if (unread > 0) return;
    }
    await dbWrite((c) =>
      c.notification.create({
        data: { userId: owner.id, type: n.type, title: n.title, body: n.body, link: n.link ?? null },
      }),
    );
  } catch {
    /* a notification must never turn a good backup into a failed one */
  }
}
