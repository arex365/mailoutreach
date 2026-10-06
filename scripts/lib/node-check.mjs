// Node.js version checks, the installed-parts check and the ABI guard (PLAN.md B2, B11).
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./paths.mjs";

export const MIN_NODE = "24.18.0";
export const RECOMMENDED_NODE = "24.21.0";

/**
 * Where to get Node.js 24 (M6-DESIGN §6.6): nodejs.org's 24.x folder, never the front page, whose "LTS" button moves
 * to Node.js 26 (which the app refuses). The same words as the .bat files and the Install guide.
 */
const NODE_24_SOURCE = "Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi)";

/** "Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi)". */
export const NODE_DOWNLOAD_TEXT = `Install ${NODE_24_SOURCE}`;

export const NODE_UPDATED_MESSAGE =
  "Node was updated: run update.bat. (Parts of the app were installed for a different Node.js version, " +
  "so the app can't start until update.bat reinstalls them. Your data is fine.)";

export function parseVersion(version) {
  const m = String(version ?? "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The app needs Node.js 24 (at least 24.18). 24.21.0 or newer is recommended (security fixes). Every message names
 * the 24.x download folder (NODE_DOWNLOAD_TEXT), because nodejs.org's front page offers Node.js 26.
 * Returns { ok, recommendUpgrade, message }.
 */
export function checkNodeVersion(version = process.versions.node) {
  const v = parseVersion(version);
  if (!v) return { ok: false, recommendUpgrade: false, message: `Couldn't read the Node.js version (${version}).` };
  if (v[0] < 24 || compareVersions(v, MIN_NODE) < 0) {
    return {
      ok: false,
      recommendUpgrade: true,
      message: `This PC has Node.js ${version}, which is too old for the app. ${NODE_DOWNLOAD_TEXT}, then run this again.`,
    };
  }
  if (v[0] >= 25) {
    return {
      ok: false,
      recommendUpgrade: false,
      // The Node.js installer never replaces a newer version, so the newer one goes first.
      message: `This PC has Node.js ${version}, but the app needs Node.js 24. Uninstall Node.js in Windows' Settings (Apps, Installed apps), then install ${NODE_24_SOURCE}, then double-click update.bat.`,
    };
  }
  if (compareVersions(v, RECOMMENDED_NODE) < 0) {
    return {
      ok: true,
      recommendUpgrade: true,
      message: `Node.js ${version} works, but ${RECOMMENDED_NODE} and newer have security fixes. When you have 5 minutes: double-click stop.bat, install ${NODE_24_SOURCE}, then double-click update.bat.`,
    };
  }
  return { ok: true, recommendUpgrade: false, message: `Node.js ${version} is installed.` };
}

/**
 * "missing" when node_modules isn't there, "outdated" when package-lock.json changed after the
 * last install (npm writes node_modules/.package-lock.json at the end of every install).
 */
export function dependenciesStateFrom({ nodeModulesExists, lockMtimeMs, hiddenLockMtimeMs }) {
  if (!nodeModulesExists || hiddenLockMtimeMs == null) return "missing";
  if (lockMtimeMs != null && lockMtimeMs > hiddenLockMtimeMs + 1000) return "outdated";
  return "ok";
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function dependenciesState() {
  return dependenciesStateFrom({
    nodeModulesExists: fs.existsSync(PATHS.nodeModules),
    lockMtimeMs: mtime(PATHS.lockFile),
    hiddenLockMtimeMs: mtime(PATHS.hiddenLockFile),
  });
}

/** The Node ABI recorded by setup.bat / update.bat (for example "137"), or null. */
export function readRecordedAbi(file = PATHS.abiFile) {
  try {
    const v = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
    return v || null;
  } catch {
    return null;
  }
}

export function writeRecordedAbi(file = PATHS.abiFile, abi = process.versions.modules) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${abi}\n`, "utf8");
}

/** "ok" | "missing" | "changed" */
export function abiStatus(recorded, current = process.versions.modules) {
  if (!recorded) return "missing";
  return String(recorded).trim() === String(current).trim() ? "ok" : "changed";
}

/**
 * Loads the two native parts (the SQLite driver and the password hasher) and uses them once.
 * If this fails, Node.js and the installed parts don't match.
 */
export async function nativeSmokeTest() {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 40 + 2 AS answer").get();
    db.close();
    if (!row || row.answer !== 42) throw new Error("unexpected answer from SQLite");
  } catch (err) {
    return { ok: false, part: "better-sqlite3", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const argon2 = await import("@node-rs/argon2");
    const hash = await argon2.hash("smoke-test");
    if (!String(hash).startsWith("$argon2") || !(await argon2.verify(hash, "smoke-test"))) {
      throw new Error("unexpected result from argon2");
    }
  } catch (err) {
    return { ok: false, part: "@node-rs/argon2", error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}
