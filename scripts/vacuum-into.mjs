// The background sender's backups → node scripts/vacuum-into.mjs --db <database> --out <file.tmp> [--json]
// (M6-DESIGN §3.5). better-sqlite3 is synchronous: VACUUM INTO a large database on the background sender's own thread
// would freeze its heartbeats, its lease and an email being handed to Mailgun. So runBackup
// (src/server/services/backups.ts) runs it here, in a child process:
//   1. VACUUM INTO <out> (a consistent snapshot, safe while the app runs; written through a temporary name and renamed);
//   2. PRAGMA quick_check on <out>, so a damaged file never counts as a backup;
//   3. prints one JSON line: {"ok":true,"size":<bytes>} or {"ok":false,"error":"…","check":"<quick_check's answer>"|null}.
// It never renames <out> to the final backup name and never deletes other backups: runBackup does that, only on "ok".
// Exit code 0 on ok, 1 on a failure, 2 on wrong arguments.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { quickCheck, vacuumInto } from "./lib/sqlite.mjs";

/**
 * Makes the checked snapshot. Returns { ok: true, size } or { ok: false, error, check } (check is quick_check's answer
 * when the file was written but isn't healthy, else null). A file that fails the check is removed again.
 * @param {string} dbFile
 * @param {string} outFile
 */
export async function vacuumAndCheck(dbFile, outFile) {
  if (!fs.existsSync(dbFile)) return { ok: false, error: `The database file ${dbFile} doesn't exist.`, check: null };
  if (fs.existsSync(outFile)) return { ok: false, error: `${outFile} already exists.`, check: null };
  try {
    await vacuumInto(dbFile, outFile);
  } catch (err) {
    fs.rmSync(outFile, { force: true });
    return { ok: false, error: oneLine(err), check: null };
  }
  let check;
  try {
    check = await quickCheck(outFile);
  } catch (err) {
    check = oneLine(err);
  }
  if (check !== "ok") {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(outFile + suffix, { force: true });
    return { ok: false, error: `PRAGMA quick_check answered: ${check}`, check };
  }
  return { ok: true, size: fs.statSync(outFile).size };
}

function oneLine(err) {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").trim() || "unknown error";
}

async function main() {
  let values;
  try {
    values = parseArgs({
      options: { db: { type: "string" }, out: { type: "string" }, json: { type: "boolean", default: false } },
      strict: true,
    }).values;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: oneLine(err), check: null }));
    return 2;
  }
  if (!values.db || !values.out) {
    console.log(JSON.stringify({ ok: false, error: "Use --db <database> --out <file>.", check: null }));
    return 2;
  }
  const result = await vacuumAndCheck(path.resolve(values.db), path.resolve(values.out));
  if (values.json) console.log(JSON.stringify(result));
  else console.log(result.ok ? `Backup written and checked: ${values.out} (${result.size} bytes)` : `Backup failed: ${result.error}`);
  return result.ok ? 0 : 1;
}

/** True when this file is the program being run (not a module a test imported). */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && path.basename(entry).toLowerCase() === "vacuum-into.mjs";
}

if (isEntryPoint()) process.exit(await main());
