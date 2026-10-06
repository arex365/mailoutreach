import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Review fixes around the backup helper and the second copy, pure parts only (no database, no child process):
 *  - SECURITY-03: scripts\vacuum-into.mjs is found only in the app's own folder (the folder with package.json: the
 *    working folder, or the one above the running program's), never in a folder above it, and the helper gets only the
 *    environment it needs (never the app's keys or its database address);
 *  - SCREENS-03: a copy Windows refused (EPERM/EACCES) says to run install-services.bat, then Back up now; a backup's
 *    summary carries the copy's failure so Back up now shows it as a warning; the button follows a backup queued by
 *    Save folder, and a finished one going away changes nothing.
 */

// Only the pure helpers are tested here: keep the real database client out of it.
vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn(), withWriteLock: vi.fn() }));

const { appRootCandidates, copyFixText, HELPER_MISSING_TEXT, vacuumChildEnv, vacuumInChildProcess, vacuumScriptPath } = await import(
  "@/server/services/backups"
);
const { COPY_FAILED_PREFIX, NOT_ALLOWED_FIX, copyFailedNote, summaryHasCopyFailure } = await import("@/core/backups/copy-note");
const { startsFollowing } = await import("@/app/(app)/settings/backups/follow-job");

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-helper-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A folder shaped like the app's: package.json and, unless left out, scripts\vacuum-into.mjs. */
function appFolder(parent: string, name: string, { helper = true } = {}): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  if (helper) fs.writeFileSync(path.join(root, "scripts", "vacuum-into.mjs"), "// the helper");
  return root;
}

describe("the backup helper is found only in the app's own folder (SECURITY-03)", () => {
  it("from the working folder, or from the folder above the running program (dist\\worker.mjs)", () => {
    const base = tempDir();
    const root = appFolder(base, "Outreach");
    expect(appRootCandidates(root, path.join(root, "dist", "worker.mjs"))).toEqual([root, root]);
    expect(vacuumScriptPath([root])).toBe(path.join(root, "scripts", "vacuum-into.mjs"));
    // A background sender started from another working folder still finds its own app folder through dist\worker.mjs.
    const elsewhere = tempDir();
    expect(vacuumScriptPath(appRootCandidates(elsewhere, path.join(root, "dist", "worker.mjs")))).toBe(
      path.join(root, "scripts", "vacuum-into.mjs"),
    );
  });

  it("never in a folder above the app's, even when the app's own copy is missing (C:\\scripts)", () => {
    const base = tempDir();
    // What someone planted above the app folder: <parent>\scripts\vacuum-into.mjs (and a package.json there too).
    fs.mkdirSync(path.join(base, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(base, "scripts", "vacuum-into.mjs"), "// not ours");
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    const root = appFolder(base, "Outreach", { helper: false });
    expect(vacuumScriptPath(appRootCandidates(root, path.join(root, "dist", "worker.mjs")))).toBeNull();
    // A folder without package.json isn't the app's folder, whatever it holds.
    const loose = tempDir();
    fs.mkdirSync(path.join(loose, "scripts"));
    fs.writeFileSync(path.join(loose, "scripts", "vacuum-into.mjs"), "// not an app folder");
    expect(vacuumScriptPath([loose])).toBeNull();
  });

  it("without the helper nothing is started, and the answer says so", async () => {
    const r = await vacuumInChildProcess("C:\\nowhere\\app.db", "C:\\nowhere\\x.db.tmp", 1_000, null);
    expect(r).toMatchObject({ ok: false, check: null, missingHelper: true });
    expect(HELPER_MISSING_TEXT).toBe(
      "Some of the app's files are missing (scripts\\vacuum-into.mjs), so no backup was made. If you were updating the app, finish the update first, then click Back up now in Settings › Backups.",
    );
  });

  it("the helper gets only what Windows and Node need, never the app's keys or database address", () => {
    const env = vacuumChildEnv({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      TEMP: "C:\\Temp",
      APP_ENCRYPTION_KEY: "secret",
      DATABASE_URL: "file:./data/app.db",
      MAILGUN_API_KEY: "key-x",
      NODE_OPTIONS: "--inspect",
    });
    expect(env).toEqual({ Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\Temp" });
  });
});

describe("a copy the background sender may not write (SCREENS-03)", () => {
  it("the notification says to run install-services.bat, then Back up now; other failures keep the drive advice", () => {
    expect(copyFixText(true)).toBe(
      "If the app runs as a Windows service, run install-services.bat on the office PC so the background sender may write there, then click Back up now in Settings › Backups.",
    );
    expect(copyFixText(false)).toBe("Check that the drive is connected and the folder still exists, then click Back up now in Settings › Backups.");
  });

  it("a backup's summary carries the copy's failure, which Back up now shows as a warning", () => {
    expect(copyFailedNote("the app isn't allowed to save files in that folder", true)).toBe(
      ` ${COPY_FAILED_PREFIX} the app isn't allowed to save files in that folder. ${NOT_ALLOWED_FIX}`,
    );
    expect(copyFailedNote("that drive is full", false)).toBe(" The copy to the second folder failed: that drive is full.");
    expect(summaryHasCopyFailure(`Backup saved (12 MB).${copyFailedNote("that drive is full", false)}`)).toBe(true);
    expect(summaryHasCopyFailure("Backup saved (12 MB).")).toBe(false);
    expect(summaryHasCopyFailure(null)).toBe(false);
  });

  it("Back up now follows a backup queued by Save folder; a finished one going away changes nothing", () => {
    expect(startsFollowing(42, null)).toBe(true); // Save folder queued the first copy
    expect(startsFollowing(43, 42)).toBe(true); // a newer one
    expect(startsFollowing(42, 42)).toBe(false); // the one clicked here
    expect(startsFollowing(null, 42)).toBe(false); // it finished: what the button says about it stays
    expect(startsFollowing(null, null)).toBe(false);
  });
});
