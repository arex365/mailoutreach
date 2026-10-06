import fs from "node:fs";
import { recomputeProfileKeys } from "@/server/services/imports/profile-keys";
import { restoreMarkerPath } from "@/server/services/sending/restore";
import { casState, getState } from "@/server/state";
import { log as defaultLog, type Logger } from "./log";

/**
 * One-off data repairs after an update. Each runs once per database, at worker start-up while this
 * worker holds the lease (so only one process runs it), and is remembered in SystemState
 * "repair.<name>". A repair that fails is logged and tried again on the next start; it never
 * stops the worker from starting. Every repair must be safe to run again.
 */

export type OneOffRepair = {
  name: string;
  /** Does the work and returns a short summary for the log. */
  run: () => Promise<string>;
};

/** What an M1/M2 restore marker is renamed to (it is kept, so nothing is lost). */
export const PRE_M3_MARKER_SUFFIX = ".pre-m3";

/**
 * M3-DESIGN §4.6, §9.2 item 20: Milestone 1 and 2 restores wrote a RESTORED marker without a `version` field and never
 * paused anything. Such a marker found at the first Milestone 3 start is renamed `RESTORED.pre-m3` instead of pausing
 * sending for a restore that happened long ago. A marker with a `version` (written by this version's restore.bat) is
 * never touched: restoring a pre-M3 backup, whose database hasn't run this repair yet, still pauses. A marker that
 * isn't readable JSON is left alone too (the restore check treats it as a restore, which is the safe side).
 */
export function renameOldRestoreMarker(markerPath: string = restoreMarkerPath()): string {
  let text: string;
  try {
    text = fs.readFileSync(markerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "no restore marker";
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "the restore marker isn't readable, so it is left for the restore check";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "the restore marker isn't readable, so it is left for the restore check";
  }
  if ("version" in parsed) return "the restore marker comes from this version, so it is left for the restore check";
  fs.renameSync(markerPath, markerPath + PRE_M3_MARKER_SUFFIX);
  return `renamed an older restore marker to RESTORED${PRE_M3_MARKER_SUFFIX} (restores made before the sending update never paused sending)`;
}

export const ONE_OFF_REPAIRS: readonly OneOffRepair[] = [
  {
    // Profile links used to be keyed "host + first path segment", so unrelated Etsy shops,
    // Facebook profiles and Instagram posts matched each other as duplicates.
    name: "profileKeys.perPlatform",
    run: async () => {
      const r = await recomputeProfileKeys();
      return `checked ${r.checked} compan${r.checked === 1 ? "y" : "ies"} with profile links, fixed ${r.changed}`;
    },
  },
  {
    // Must run before the restore check at start-up (worker/main.ts), which acts on any marker still there.
    name: "m3.oldRestoreMarker",
    run: async () => renameOldRestoreMarker(),
  },
];

export function repairStateKey(name: string): string {
  return `repair.${name}`;
}

/** Runs every repair that hasn't run on this database yet. Returns the names that ran now. */
export async function runOneOffRepairs(
  logger: Logger = defaultLog,
  repairs: readonly OneOffRepair[] = ONE_OFF_REPAIRS,
  now = new Date(),
): Promise<string[]> {
  const ran: string[] = [];
  for (const repair of repairs) {
    const key = repairStateKey(repair.name);
    try {
      if (await getState(key)) continue;
      const summary = await repair.run();
      // null = the row must not exist yet; if another process wrote it meanwhile, that's fine too.
      await casState(key, null, { doneAt: now.toISOString(), summary });
      logger.info(`One-off repair "${repair.name}" done: ${summary}`);
      ran.push(repair.name);
    } catch (err) {
      logger.error(`The one-off repair "${repair.name}" failed; it will be tried again on the next start`, err);
    }
  }
  return ran;
}
