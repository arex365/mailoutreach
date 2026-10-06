// Folder permissions for the two background services (PLAN.md B11), used by install-services.bat.
// The service accounts (NT SERVICE\OutreachWeb and NT SERVICE\OutreachWorker) may READ and RUN the
// whole project folder, but CHANGE only the folders they write to: the data, backups, logs, run
// and .next folders (and a second backup folder on this PC, when one is set). Everything else,
// including the .bat files, scripts\, tools\nssm.exe and node_modules\, stays read-only for them.
// That matters because start.bat, stop.bat, update.bat and restore.bat run those files as
// administrator: a bug in the app must never be able to change what they run.
// The second backup folder is granted on its own, last (M6-DESIGN §3.4): a USB stick that is unplugged, a FAT/exFAT
// stick (no permissions to set) or a whole drive only give a warning; the services are still set up.
// Review fix SECURITY-01: the second folder is a value in the database, which the web app can write, and the grant
// below runs as administrator. So a folder inside the app (scripts\, tools\, node_modules\), a Windows or program
// folder, or a whole profile folder (C:\Users\<name>, its Documents, Desktop, Pictures, Downloads or OneDrive itself)
// is refused with a warning, the same folders Settings › Backups refuses (checkSecondFolder in
// src/server/services/backups.ts). Every folder ever granted stays in run\service-acl.txt (install-services.ps1 keeps
// the earlier entries), and a folder granted by an earlier run that isn't needed any more loses its grant here.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WEB_SERVICE, WORKER_SERVICE } from "./services.mjs";
import { openDatabase } from "./sqlite.mjs";

export const SERVICE_ACCOUNTS = [`NT SERVICE\\${WEB_SERVICE}`, `NT SERVICE\\${WORKER_SERVICE}`];

/** Folders inside the project that the services write to. Next.js writes its cache all over .next. */
export const SERVICE_WRITE_DIRS = ["data", "backups", "logs", "run", ".next"];

/** Where install-services.ps1 records every folder it gave the services access to (uninstall-services.ps1 reads it). */
export const ACL_RECORD = path.join("run", "service-acl.txt");

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

/** `key` is `parent` or a folder inside it (both from norm()). */
const isInside = (key, parent) => key === parent || key.startsWith(parent + path.sep);

/** A path on a local drive letter (not a network share, not relative). */
function isOnDriveLetter(p) {
  return /^[A-Za-z]:[\\/]/.test(String(p ?? "").trim());
}

/** A whole drive such as D:\ (the services never get change rights on one). */
export function isDriveRoot(p) {
  return /^[A-Za-z]:$/.test(path.resolve(String(p ?? "").trim()).replace(/[\\/]+$/, ""));
}

/** The same folders once each, compared case-insensitively. */
function unique(paths) {
  const seen = new Set();
  return paths.filter((p) => {
    const key = norm(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An environment value by name, whatever its case (Windows ignores the case; a test's plain object doesn't). */
function envValue(env, name) {
  if (!env) return undefined;
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The sentence Settings › Backups shows for the same folders (checkSecondFolder), so both say the same thing. */
export const OWN_FOLDER_TEXT =
  "Pick a folder of its own, for example a new folder on a USB stick or in OneDrive (not a Windows, program or whole-profile folder).";

/** Windows' and the programs' folders when the environment doesn't name them. */
const DEFAULT_SYSTEM_FOLDERS = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];

/**
 * Windows' and the programs' folders: %WINDIR%, %ProgramFiles%, %ProgramFiles(x86)% and %ProgramData% (and their
 * other names, %SystemRoot% and %ProgramW6432%), plus their usual places on C:, which are refused either way.
 * @param {Record<string, string | undefined>} [env]
 */
export function systemFolders(env = process.env) {
  const fromEnv = ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]
    .map((name) => envValue(env, name))
    .filter((v) => v !== undefined && isOnDriveLetter(v) && !isDriveRoot(v));
  return unique([...fromEnv, ...DEFAULT_SYSTEM_FOLDERS].map((p) => path.resolve(p)));
}

/**
 * The folders that hold the user profiles (C:\Users): the parent of %PUBLIC% and of %USERPROFILE% (unless that is a
 * service's profile inside Windows' folder), %SystemDrive%\Users and C:\Users. Never a whole drive.
 * @param {Record<string, string | undefined>} [env]
 */
export function profileFolders(env = process.env) {
  const system = systemFolders(env).map(norm);
  const out = [];
  const add = (p) => {
    if (p && isOnDriveLetter(p) && !isDriveRoot(p)) out.push(path.resolve(p));
  };
  const pub = envValue(env, "PUBLIC");
  if (pub && isOnDriveLetter(pub)) add(path.dirname(path.resolve(pub)));
  const home = envValue(env, "USERPROFILE");
  if (home && isOnDriveLetter(home) && !system.some((s) => isInside(norm(home), s))) add(path.dirname(path.resolve(home)));
  const drive = envValue(env, "SystemDrive");
  if (drive && /^[A-Za-z]:$/.test(drive)) add(`${drive}\\Users`);
  add("C:\\Users");
  return unique(out);
}

/** The folders of a profile that are never a second folder themselves (a new folder inside them is fine). */
const WHOLE_PROFILE_FOLDERS = ["documents", "desktop", "pictures", "downloads"];
/** OneDrive's own folder: "OneDrive", or "OneDrive - <organisation>" for a work account. */
const isOneDriveName = (name) => /^onedrive( - .+)?$/i.test(name);

/**
 * Why a second backup folder must never get the services' change rights, or null when it may (SECURITY-01): the app's
 * folder, a folder inside it or one that contains it; a Windows or program folder or a folder inside one; a profile
 * folder itself (C:\Users, C:\Users\<name>, or that profile's Documents, Desktop, Pictures, Downloads or OneDrive
 * folder, also where %OneDrive% says it is, and the Documents, Desktop, Pictures or Downloads folder directly inside a
 * OneDrive folder, where OneDrive's folder backup puts them). A folder inside those profile folders is fine, for
 * example C:\Users\polyg\OneDrive\Outreach backups. Paths are compared resolved and case-insensitively.
 * @param {string} dir
 * @param {{ root?: string | null, env?: Record<string, string | undefined> }} [o]
 * @returns {string | null}
 */
export function secondFolderRefusal(dir, { root = null, env = process.env } = {}) {
  const key = norm(String(dir ?? "").trim());
  if (root) {
    const rootKey = norm(root);
    if (isInside(key, rootKey)) return "it is the app's folder or a folder inside it";
    if (isInside(rootKey, key)) return "it contains the app's folder";
  }
  if (systemFolders(env).some((s) => isInside(key, norm(s)))) return "it is a Windows or program folder";
  const name = path.basename(path.resolve(String(dir ?? "").trim()));
  const wholeProfileFolder = WHOLE_PROFILE_FOLDERS.includes(name.toLowerCase()) || isOneDriveName(name);
  const profileKeys = profileFolders(env).map(norm);
  for (const profiles of profileKeys) {
    if (key === profiles) return "it holds every user's own folders";
    if (path.dirname(key) === profiles) return "it is a whole user folder";
    if (path.dirname(path.dirname(key)) === profiles && wholeProfileFolder) return `it is a whole ${name} folder`;
  }
  const oneDrives = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map((n) => envValue(env, n)).filter((v) => v && isOnDriveLetter(v)).map(norm);
  if (oneDrives.includes(key)) return "it is a whole OneDrive folder";
  // OneDrive's folder backup moves Documents, Desktop and Pictures into the OneDrive folder
  // (C:\Users\<name>\OneDrive\Documents): those are whole profile folders too.
  if (WHOLE_PROFILE_FOLDERS.includes(name.toLowerCase())) {
    const parent = path.dirname(key);
    const inProfileOneDrive = isOneDriveName(path.basename(parent)) && profileKeys.includes(path.dirname(path.dirname(parent)));
    if (inProfileOneDrive || oneDrives.includes(parent)) return `it is a whole ${name} folder`;
  }
  return null;
}

/**
 * The folders the services get "change" rights on: the app's own (`folders`) and, separately, the second backup
 * folder (`secondFolder`, or null), which grantServiceAccess handles last and may skip with a warning. Never the
 * project folder itself or a folder that contains it (that would give them the scripts again). A second folder that is
 * a network share or relative is left out; any other is passed on, so the grant can say why it refuses a whole drive,
 * a folder inside or above the app's folder, a Windows or program folder or a whole profile folder.
 * @param {{ root: string, databaseFile?: string | null, secondBackupFolder?: string | null }} o
 * @returns {{ folders: string[], secondFolder: string | null }}
 */
export function serviceWriteFolders({ root, databaseFile = null, secondBackupFolder = null }) {
  const candidates = SERVICE_WRITE_DIRS.map((d) => path.join(root, d));
  if (databaseFile) candidates.push(path.dirname(path.resolve(root, databaseFile)));
  const rootKey = norm(root);
  const aboveOrRoot = (key) => key === rootKey || rootKey.startsWith(key + path.sep);
  const seen = new Set();
  const folders = [];
  for (const dir of candidates) {
    const key = norm(dir);
    if (seen.has(key) || aboveOrRoot(key)) continue;
    seen.add(key);
    folders.push(path.resolve(dir));
  }
  const secondFolder = secondBackupFolder && isOnDriveLetter(secondBackupFolder) ? path.resolve(secondBackupFolder.trim()) : null;
  return { folders, secondFolder };
}

/** The folders run\service-acl.txt lists (an earlier install-services.bat's grants); [] when there is none. */
export function readAclRecord(root) {
  try {
    return fs
      .readFileSync(path.join(root, ACL_RECORD), "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/**
 * The folders an earlier run gave the services access to that this run doesn't (an earlier second backup folder, one
 * refused now, an earlier database folder). Never the project folder or a folder above it: install-services.ps1
 * decides the "read attributes" grants on those itself.
 * @param {{ root: string, previous: string[], current: string[] }} o
 */
export function staleGrants({ root, previous, current }) {
  const keep = new Set(current.map(norm));
  const rootKey = norm(root);
  return unique(previous.filter((p) => isOnDriveLetter(p)).map((p) => path.resolve(p))).filter((p) => {
    const key = norm(p);
    return !keep.has(key) && !isInside(rootKey, key);
  });
}

/** The Owner's second backup folder (Settings › Backups), or null. Never throws. */
export async function readSecondBackupFolder(dbFile) {
  try {
    const db = await openDatabase(dbFile, { readonly: true });
    try {
      const row = db.get(`SELECT value FROM "Setting" WHERE key = 'backups.secondFolder'`);
      const value = row ? JSON.parse(String(row.value)) : null;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The icacls calls, as argument lists (exported so the exact rights are tested). */
export function icaclsGrantCommands({ root, folders }) {
  return [
    // The whole project: read and run only. ":r" replaces any older, wider grant for these accounts.
    [root, "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)RX`), "/Q"],
    ...folders.map((dir) => [dir, "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)M`), "/Q"]),
  ];
}

/**
 * The icacls call for the second backup folder: change rights for both accounts, like the app's own folders (the web
 * app's write check on Settings › Backups needs them too).
 */
export function icaclsSecondFolderCommand(dir) {
  return [dir, "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)M`), "/Q"];
}

/** The icacls call that takes both accounts' own permissions off a folder (the same call uninstall-services.ps1 makes). */
export function icaclsRemoveCommand(dir) {
  return [dir, "/remove", ...SERVICE_ACCOUNTS, "/Q"];
}

/** The warning install-services.bat prints when the second backup folder couldn't be granted (M6-DESIGN §3.4). */
export function secondFolderWarning(dir, reason) {
  return `Couldn't give the background sender access to the second backup folder (${dir}): ${reason}. Copies there fail until the drive is plugged in and install-services.bat runs again.`;
}

/** The warning install-services.bat prints when it refuses the second backup folder (secondFolderRefusal). */
export function secondFolderRefusedWarning(dir, reason) {
  return `Didn't give the background sender access to the second backup folder (${dir}): ${reason}. ${OWN_FOLDER_TEXT} Save it in Settings › Backups, then run install-services.bat again.`;
}

/**
 * Sets the permissions (needs administrator rights). Creates the app's write folders first and grants them; a failure
 * there is { ok: false, … }, as before. Then the second backup folder, never created: a whole drive, a folder
 * secondFolderRefusal refuses, a missing folder (an unplugged stick) or an icacls failure (a FAT/exFAT stick has no
 * permissions) gives { ok: true, warning } and the folder isn't in `folders` (the list install-services.ps1 records for
 * uninstall-services.bat). Last, a folder an earlier run granted (`previous`, run\service-acl.txt) that this run doesn't
 * loses the services' permissions again (`revoked`); one that isn't there (an unplugged stick) keeps them until
 * uninstall-services.bat, which reads the record.
 * Returns { ok, folders, secondFolder (the second folder when it was granted, else null), error, warning, revoked }.
 * @param {{ root: string, folders: string[], secondFolder?: string | null, env?: Record<string, string | undefined>, previous?: string[], run?: (args: string[]) => { status: number | null, stdout?: string, stderr?: string } }} o
 *   `run` runs icacls.exe with the given arguments (tests pass a stand-in); `env` names Windows' folders
 *   (secondFolderRefusal); `previous` defaults to the folders run\service-acl.txt lists.
 */
export function grantServiceAccess({
  root,
  folders,
  secondFolder = null,
  env = process.env,
  previous = readAclRecord(root),
  run = (args) => spawnSync("icacls.exe", args, { encoding: "utf8", windowsHide: true }),
}) {
  const failed = (error) => ({ ok: false, folders, secondFolder: null, error, warning: null, revoked: [] });
  for (const dir of folders) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return failed(`Couldn't create ${dir}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const args of icaclsGrantCommands({ root, folders })) {
    const r = run(args);
    if (r.status !== 0) {
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return failed(`icacls ${args[0]}: ${output || `exit code ${r.status}`}`);
    }
  }

  let warning = null;
  let grantedSecond = null;
  const granted = [...folders];
  if (secondFolder) {
    let reason = null;
    const refused = isDriveRoot(secondFolder) ? null : secondFolderRefusal(secondFolder, { root, env });
    if (isDriveRoot(secondFolder)) {
      reason = "it is a whole drive, and the background sender only ever gets access to a folder";
    } else if (refused) {
      warning = secondFolderRefusedWarning(secondFolder, refused);
    } else if (!isExistingFolder(secondFolder)) {
      reason = "the folder isn't there (is the drive plugged in?)";
    } else {
      const r = run(icaclsSecondFolderCommand(secondFolder));
      if (r.status !== 0) {
        const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+/g, " ").trim();
        reason = `Windows said: ${output || `exit code ${r.status}`}`;
      }
    }
    if (reason) warning = secondFolderWarning(secondFolder, reason);
    if (!reason && !refused) {
      granted.push(secondFolder);
      grantedSecond = secondFolder;
    }
  }

  // Earlier grants this run doesn't make again: take them back where the folder is there (best effort, never fatal).
  const revoked = [];
  for (const dir of staleGrants({ root, previous, current: granted })) {
    if (!isExistingFolder(dir)) continue;
    if (run(icaclsRemoveCommand(dir)).status === 0) revoked.push(dir);
  }
  return { ok: true, folders: granted, secondFolder: grantedSecond, error: null, warning, revoked };
}

function isExistingFolder(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
