// run\update-in-progress: update.bat writes it before it changes the app's parts (npm ci, the
// database upgrade, the build) and removes it only when all of them succeeded. While it exists
// the install is half-updated, so start.bat, start-demo.bat, restore.bat, install-services.bat
// and the background sender refuse to start the app (PLAN.md B11: never start a half-built app).
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./paths.mjs";

export const UPDATE_UNFINISHED_MESSAGE =
  "update.bat hasn't finished installing the new version, so the app isn't started (it could be half-updated). " +
  "Double-click update.bat and let it finish: it starts the app by itself when everything is ready.";

/** The marker's contents ({ startedAt, ... }), {} when unreadable, or null when there is no marker. */
export function readUpdateMarker(file = PATHS.updateMarker) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function updateInProgress(file = PATHS.updateMarker) {
  return readUpdateMarker(file) !== null;
}

export function writeUpdateMarker(info = {}, file = PATHS.updateMarker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { startedAt: new Date().toISOString(), pid: process.pid, ...info };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function clearUpdateMarker(file = PATHS.updateMarker) {
  fs.rmSync(file, { force: true });
}
