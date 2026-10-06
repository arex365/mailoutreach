// Makes one backup of the database into the backups folder (VACUUM INTO via better-sqlite3).
//   node scripts/backup-db.mjs [--kind manual] [--db <path>] [--out-dir <folder>] [--allow-raw-copy] [--json]
// update.mjs runs this as a separate process on purpose: once a process has loaded
// better-sqlite3, Windows locks its .node file and the following `npm ci` couldn't replace it.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PATHS, ROOT, displayPath } from "./lib/paths.mjs";
import { databasePathFromUrl } from "./lib/env-file.mjs";
import { makeBackup } from "./lib/backups.mjs";
import { readEnvFile } from "./lib/supervisor.mjs";
import * as ui from "./lib/ui.mjs";

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "manual" },
    db: { type: "string" },
    "out-dir": { type: "string" },
    "allow-raw-copy": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  strict: true,
});

const kind = String(values.kind).toLowerCase().replace(/[^a-z0-9]/g, "") || "manual";
const dbFile = values.db
  ? path.resolve(ROOT, values.db)
  : databasePathFromUrl(readEnvFile().DATABASE_URL || "file:./data/app.db", ROOT);

let exitCode = 0;
try {
  if (!fs.existsSync(dbFile)) {
    if (values.json) console.log(JSON.stringify({ ok: true, skipped: true }));
    else ui.info("There's no database yet, so there's nothing to back up.");
  } else {
    const outDir = values["out-dir"] ? path.resolve(ROOT, values["out-dir"]) : PATHS.backupsDir;
    const r = await makeBackup(kind, dbFile, outDir, { allowRawCopy: values["allow-raw-copy"] });
    if (values.json) console.log(JSON.stringify({ ok: true, file: r.file, method: r.method, size: r.size, warning: r.warning ?? null }));
    else ui.ok(`Backup saved: ${displayPath(r.file)}`);
  }
} catch (err) {
  exitCode = 1;
  const message = err instanceof Error ? err.message : String(err);
  if (values.json) console.log(JSON.stringify({ ok: false, error: message }));
  else ui.fail(`The backup failed: ${message}`);
}
process.exit(exitCode);
