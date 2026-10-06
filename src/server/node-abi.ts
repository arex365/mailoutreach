import fs from "node:fs";
import path from "node:path";

/**
 * Node ABI guard (PLAN.md B11). setup.bat / update.bat record `process.versions.modules` in
 * data\.node-abi after installing the native parts (SQLite driver, password hasher). If Node.js is
 * updated afterwards (for example by winget), those parts no longer load, so the web app and the
 * background sender refuse to start with a plain message instead of an obscure native-module error.
 * start.bat checks the same file itself (scripts/lib/node-check.mjs); this covers services mode.
 */

export const NODE_UPDATED_MESSAGE =
  "Node was updated: run update.bat. (Parts of the app were installed for a different Node.js version, " +
  "so the app can't start until update.bat reinstalls them. Your data is fine.)";

export function recordedAbiFile(cwd: string = /*turbopackIgnore: true*/ process.cwd()): string {
  return path.join(cwd, "data", ".node-abi");
}

/** The recorded ABI ("137"), or null when there's no record (a developer PC, tests, before setup). */
export function readRecordedAbi(file: string = recordedAbiFile()): string | null {
  try {
    const v = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
    return v && /^\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** True only when a record exists and differs from this Node.js. A missing record never blocks. */
export function nodeAbiChanged(recorded: string | null = readRecordedAbi(), current: string = process.versions.modules): boolean {
  return recorded !== null && recorded !== String(current).trim();
}

/** For the web app's start-up hook: print the message and stop when the ABI changed. */
export function exitIfNodeAbiChanged(): void {
  if (!nodeAbiChanged()) return;
  console.error(NODE_UPDATED_MESSAGE);
  process.exit(1);
}
