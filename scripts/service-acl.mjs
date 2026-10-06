// install-services.ps1 → node scripts/service-acl.mjs grant|folders
//   folders   print the folders the background services may change (JSON), change nothing
//   grant     (administrator) set the folder permissions: read and run the project folder,
//             change only those folders, then the second backup folder on its own (a failure there is only a
//             warning, M6-DESIGN §3.4). Prints { ok, folders, error, warning } as JSON on the last line.
import fs from "node:fs";
import { PATHS, ROOT } from "./lib/paths.mjs";
import { databasePathFromUrl, parseEnv } from "./lib/env-file.mjs";
import { grantServiceAccess, readSecondBackupFolder, serviceWriteFolders } from "./lib/service-acl.mjs";

const command = process.argv[2] ?? "folders";

/** The app's write folders and the Owner's second backup folder (Settings › Backups), read from the database. */
async function folders() {
  let env = {};
  try {
    env = parseEnv(fs.readFileSync(PATHS.env, "utf8"));
  } catch {
    env = {};
  }
  const databaseFile = databasePathFromUrl(env.DATABASE_URL || "file:./data/app.db", ROOT);
  const secondBackupFolder = fs.existsSync(databaseFile) ? await readSecondBackupFolder(databaseFile) : null;
  return serviceWriteFolders({ root: ROOT, databaseFile, secondBackupFolder });
}

let exitCode = 0;
try {
  const list = await folders();
  if (command === "grant") {
    const r = grantServiceAccess({ root: ROOT, folders: list.folders, secondFolder: list.secondFolder });
    console.log(JSON.stringify(r));
    if (!r.ok) exitCode = 1;
  } else if (command === "folders") {
    console.log(JSON.stringify({ ok: true, folders: list.folders, secondFolder: list.secondFolder, error: null, warning: null }));
  } else {
    console.log(JSON.stringify({ ok: false, folders: [], error: `Unknown command "${command}". Use folders or grant.`, warning: null }));
    exitCode = 2;
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, folders: [], error: err instanceof Error ? err.message : String(err), warning: null }));
  exitCode = 1;
}
process.exit(exitCode);
