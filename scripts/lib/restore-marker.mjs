// data\RESTORED: the note restore.bat leaves for the background sender (PLAN.md B6.7, M3-DESIGN §4.3.7). At its next
// start the sender pauses all sending, checks Mailgun for emails sent after the backup and waits for the Owner.
//
// The marker goes in BEFORE the backup's data replaces the database, never after: a closed window, Ctrl+C during a
// slow check or a power cut anywhere after the swap then still leaves it. A marker on data that didn't change only
// pauses and checks Mailgun, which is the safe side. It is written through a temporary name and a rename, so it is
// never half-written. When the backup turns out to be damaged and the saved data goes back, or the backup can't be
// copied into place at all (the database is then untouched, M6-DESIGN §3.7), the marker goes back to what it was
// before this restore (usually: no marker).
import fs from "node:fs";
import path from "node:path";

/** @typedef {Array<{ name: string, region: string }> | null | undefined} DomainsBefore */

/** The marker's format (src/server/services/sending/restore.ts RESTORE_MARKER_VERSION). */
export const RESTORE_MARKER_VERSION = 3;

/** `<database folder>\RESTORED` (the practice copy's database shares the folder; the marker's `db` says whose it is). */
export function restoreMarkerFile(dbFile) {
  return path.join(path.dirname(dbFile), "RESTORED");
}

/**
 * The marker's JSON for a restore of `backupName` (made at `restoredFrom`) into `dbFile`. `domainsBefore` (review
 * BACKUPS-7) lists the Mailgun sending domains ({name, region}) the replaced database had, so the background sender's
 * check also walks a domain the restored backup doesn't know; null says they couldn't be read (the check then asks the
 * Owner to confirm); left out (undefined), the marker has no such field, as before.
 */
export function restoreMarkerText(dbFile, { restoredFrom, backupName, at = new Date(), domainsBefore = /** @type {DomainsBefore} */ (undefined) }) {
  const marker = {
    version: RESTORE_MARKER_VERSION,
    restoredFrom: restoredFrom instanceof Date ? restoredFrom.toISOString() : restoredFrom,
    at: at.toISOString(),
    file: backupName,
    db: path.basename(dbFile),
  };
  if (domainsBefore !== undefined) marker.domainsBefore = domainsBefore;
  return JSON.stringify(marker, null, 2) + "\n";
}

/** Writes `file` through `<file>.tmp-<pid>` and a rename: a crash leaves the old file or the new one, never half. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The marker's bytes, or null when there is none. */
export function readMarkerBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Puts the marker back as it was before this restore started: the earlier one, or none. */
export function putBackMarker(file, previous) {
  if (previous === null) fs.rmSync(file, { force: true });
  else writeFileAtomic(file, previous);
}

/** The marker back as it was; true when that worked (a marker left behind only pauses sending: the safe side). */
function tryPutBackMarker(markerFile, previous) {
  try {
    putBackMarker(markerFile, previous);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the backup in place, marker first (see the top of this file):
 *   1. write the marker (on failure nothing is changed: { ok: false, stage: "marker", error });
 *   2. await putInPlace(backupFile). restore.mjs's putInPlace copies to a temporary file, checks it and renames it over
 *      the database (M6-DESIGN §3.7), so when it throws the database is untouched: the marker goes back as it was →
 *      { ok: false, stage: "copy", error, code, markerPutBack } (a source on an unplugged stick, EBUSY, ENOSPC), or, when the
 *      error carries SQLite's `check` answer (the backup is damaged), { ok: false, stage: "check", check, … };
 *   3. check(dbFile): "ok" → { ok: true }; anything else, or an error → the backup is damaged: putInPlace(savedFile) and
 *      the marker back as it was → { ok: false, stage: "check", check, markerPutBack }. When the saved data can't be
 *      put back either, `putBackError` says why (the marker stays: it only pauses sending).
 * Without a saved file (there was no database before) the damaged backup and the marker stay: the marker only pauses.
 * `domainsBefore` goes into the marker (restoreMarkerText).
 */
export async function swapInBackup({
  dbFile,
  backupFile,
  savedFile,
  restoredFrom,
  putInPlace,
  check,
  now = new Date(),
  domainsBefore = /** @type {DomainsBefore} */ (undefined),
}) {
  const markerFile = restoreMarkerFile(dbFile);
  let previous;
  try {
    previous = readMarkerBytes(markerFile);
    writeFileAtomic(markerFile, restoreMarkerText(dbFile, { restoredFrom, backupName: path.basename(backupFile), at: now, domainsBefore }));
  } catch (err) {
    return { ok: false, stage: "marker", markerFile, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await putInPlace(backupFile);
  } catch (err) {
    const markerPutBack = tryPutBackMarker(markerFile, previous);
    if (err && typeof err === "object" && typeof err.check === "string") {
      return { ok: false, stage: "check", markerFile, check: err.check, markerPutBack };
    }
    const code = err && typeof err === "object" && typeof err.code === "string" ? err.code : null;
    return { ok: false, stage: "copy", markerFile, error: err instanceof Error ? err.message : String(err), code, markerPutBack };
  }
  const result = await Promise.resolve()
    .then(() => check(dbFile))
    .catch((err) => String(err instanceof Error ? err.message : err));
  if (result === "ok") return { ok: true, markerFile };
  let markerPutBack = false;
  if (savedFile) {
    try {
      await putInPlace(savedFile);
    } catch (err) {
      return { ok: false, stage: "check", markerFile, check: String(result), markerPutBack, putBackError: err instanceof Error ? err.message : String(err) };
    }
    markerPutBack = tryPutBackMarker(markerFile, previous);
  }
  return { ok: false, stage: "check", markerFile, check: String(result), markerPutBack };
}
