import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * runBackup (M6-DESIGN §3.3–§3.5): VACUUM INTO and quick_check run in the child process scripts/vacuum-into.mjs, never
 * on this process's thread (the background sender keeps its heartbeat); a file that fails SQLite's check never counts
 * and nothing is pruned; retention is per kind (Back up now never pushes out a daily backup); the second folder gets
 * its copy through "<name>.tmp" with a free-space and size check and a marker naming this installation.
 */

const t = await createTestDb("backups-run");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const backups = await import("@/server/services/backups");
const { acquireLease, releaseLease, renewLease } = await import("../../../worker/lease");

const folder = backups.backupFolder();
const tempDirs: string[] = [];
let ownerId = 0;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-run-backup-"));
  tempDirs.push(dir);
  return dir;
}

/** A fast stand-in for the child process: a copy of the database file, reported as checked. */
const fastVacuum = async (dbFile: string, tmp: string): Promise<{ ok: true; size: number }> => {
  fs.copyFileSync(dbFile, tmp);
  return { ok: true, size: fs.statSync(tmp).size };
};

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { email: "arslan@example.com", name: "Arslan", role: "OWNER" } }));
  ownerId = owner.id;
});

beforeEach(async () => {
  fs.rmSync(folder, { recursive: true, force: true });
  await setSetting("backups.keep", 14, null);
  await setSetting("backups.secondFolder", null, null);
  await dbWrite(async (c) => {
    await c.backup.deleteMany({});
    await c.notification.deleteMany({});
    await c.systemState.deleteMany({ where: { key: "instance" } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

describe("the snapshot runs in a child process", () => {
  it("the service never opens SQLite itself for VACUUM INTO", () => {
    const source = fs.readFileSync(path.resolve("src/server/services/backups.ts"), "utf8");
    expect(source).not.toMatch(/from "better-sqlite3"/);
    expect(source).not.toMatch(/prepare\("VACUUM INTO/);
    expect(source).toContain('"scripts", "vacuum-into.mjs"');
  });

  it("the real child process writes a checked copy while the heartbeat keeps being saved", async () => {
    expect((await acquireLease("backup-heartbeat")).acquired).toBe(true);
    let beats = 0;
    const timer = setInterval(() => {
      void renewLease("backup-heartbeat").then((ok) => {
        if (ok) beats += 1;
      });
    }, 20);
    try {
      // The real vacuum in its child process, then a slow finish: the event loop and the database stay free throughout.
      const slow = async (dbFile: string, tmp: string) => {
        const r = await backups.vacuumInChildProcess(dbFile, tmp);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return r;
      };
      const result = await backups.runBackup({ kind: "MANUAL", userId: ownerId, vacuum: slow });
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(fs.existsSync(result.filePath + ".tmp")).toBe(false);
    } finally {
      clearInterval(timer);
      await releaseLease("backup-heartbeat");
    }
    expect(beats).toBeGreaterThanOrEqual(5);
  });

  it("the child process answers in JSON, also for a file SQLite can't read", async () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad.db");
    const bytes = Buffer.alloc(8192, 0x5a);
    bytes.write("SQLite format 3\u0000", 0, "latin1");
    fs.writeFileSync(bad, bytes);
    const r = await backups.vacuumInChildProcess(bad, path.join(dir, "out.db.tmp"));
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "out.db.tmp"))).toBe(false);
    const missing = await backups.vacuumInChildProcess(path.join(dir, "missing.db"), path.join(dir, "out2.db.tmp"));
    expect(missing).toMatchObject({ ok: false, check: null });
  });
});

describe("a backup that fails SQLite's check", () => {
  it("renames nothing, prunes nothing, and says so plainly", async () => {
    await setSetting("backups.keep", 1, null);
    fs.mkdirSync(folder, { recursive: true });
    const old = [1, 2].map((day) => backups.backupFileName(new Date(2020, 0, day, 12, 0, 0), `old${day}`));
    for (const name of old) fs.writeFileSync(path.join(folder, name), "old backup");
    const damaged = async (_db: string, tmp: string) => {
      fs.writeFileSync(tmp, "half a file");
      return { ok: false as const, error: "PRAGMA quick_check answered: *** in database main ***", check: "*** in database main ***" };
    };
    await expect(backups.runBackup({ kind: "AUTO", vacuum: damaged })).rejects.toThrow(
      `The backup file failed SQLite's check (*** in database main ***). The previous backups were kept. Try Back up now again; if it fails again, the database may be damaged: see "Backups and restore" in the README.`,
    );
    expect(fs.readdirSync(folder).sort()).toEqual([...old].sort());
    expect(await db.backup.count()).toBe(0);
    const failed = await db.activityLog.findFirstOrThrow({ where: { type: "backup.failed" }, orderBy: { id: "desc" } });
    expect(failed.summary).toMatch(/^The backup failed: The backup file failed SQLite's check/);
  });

  it("a snapshot that couldn't be written at all (a full disk) keeps the old wording", async () => {
    const full = async () => ({ ok: false as const, error: "database or disk is full", check: null });
    await expect(backups.runBackup({ kind: "AUTO", vacuum: full })).rejects.toThrow(/^Couldn't write the backup file in .+\. Check that the disk isn't full/);
  });
});

describe("retention per kind", () => {
  it("twenty Back up now backups leave all 14 daily ones (and keep 5 of their own)", async () => {
    const base = new Date(2026, 8, 1, 23, 0, 0).getTime();
    const daily: string[] = [];
    for (let i = 0; i < 14; i++) {
      daily.push((await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum, now: new Date(base + i * 86_400_000) })).fileName);
    }
    const manual: string[] = [];
    for (let i = 0; i < 20; i++) {
      manual.push((await backups.runBackup({ kind: "MANUAL", vacuum: fastVacuum, now: new Date(base + 14 * 86_400_000 + i * 60_000) })).fileName);
    }
    const files = new Set(fs.readdirSync(folder).filter(backups.isBackupFileName));
    for (const d of daily) expect(files.has(d), d).toBe(true);
    expect(manual.filter((m) => files.has(m))).toEqual(manual.slice(15));
    expect(files.size).toBe(19);
    expect(await db.backup.count()).toBe(19);
    // The next daily backup pushes out only the oldest daily one.
    const next = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum, now: new Date(base + 20 * 86_400_000) });
    expect(next.removed).toEqual([daily[0]]);
  });
});

describe("the copy to the second folder", () => {
  it("goes through <name>.tmp and writes the marker naming this installation", async () => {
    const second = tempDir();
    await setState("instance", { dbPath: "c:/x/app.db", id: "this-install", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    await setSetting("backups.secondFolder", second, null);
    const destinations: string[] = [];
    const result = await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      secondFolderIo: {
        copyFile: async (from, to) => {
          destinations.push(to);
          fs.copyFileSync(from, to);
        },
      },
    });
    expect(destinations).toEqual([path.join(second, `${result.fileName}.tmp`)]);
    expect(result).toMatchObject({ copiedTo: second, copyError: null });
    expect(fs.readdirSync(second).sort()).toEqual([result.fileName, backups.SECOND_FOLDER_MARKER].sort());
    expect(await backups.readSecondFolderMarker(second)).toMatchObject({ instanceId: "this-install" });
    expect((await db.backup.findUniqueOrThrow({ where: { fileName: result.fileName } })).copiedTo).toBe(second);
  });

  it("a short copy or a full drive leaves no backup file there, and the Owner hears why", async () => {
    const second = tempDir();
    await setSetting("backups.secondFolder", second, null);
    const short = await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      secondFolderIo: { copyFile: async (_from, to) => fs.writeFileSync(to, "only a part") },
    });
    expect(short).toMatchObject({ copiedTo: null, copyError: expect.stringMatching(/^copied \d+ of \d+ bytes$/) });
    expect(fs.readdirSync(second)).toEqual([]);
    expect((await db.notification.findFirstOrThrow({ where: { type: "backup.copyFailed" } })).body).toContain(
      `Couldn't copy the backup to ${second}: the copy came out incomplete.`,
    );

    await dbWrite((c) => c.notification.deleteMany({}));
    const full = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum, secondFolderIo: { statfs: async () => ({ bavail: 1024, bsize: 1 }) } });
    expect(full.copiedTo).toBeNull();
    expect(fs.readdirSync(second)).toEqual([]);
    expect((await db.notification.findFirstOrThrow({ where: { type: "backup.copyFailed" } })).body).toContain(`${second}: that drive is full.`);

    await dbWrite((c) => c.notification.deleteMany({}));
    const nospc = await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      secondFolderIo: {
        copyFile: async (_from, to) => {
          fs.writeFileSync(to, "half");
          throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });
        },
      },
    });
    expect(nospc.copiedTo).toBeNull();
    expect(fs.readdirSync(second)).toEqual([]);

    await dbWrite((c) => c.notification.deleteMany({}));
    await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      secondFolderIo: {
        copyFile: async () => {
          throw Object.assign(new Error("EFBIG: file too large"), { code: "EFBIG" });
        },
      },
    });
    expect((await db.notification.findFirstOrThrow({ where: { type: "backup.copyFailed" } })).body).toContain(
      "the drive is formatted FAT32, which can't hold files over 4 GB",
    );
  });

  it("a folder whose marker names another installation gets no copy and nothing there is pruned", async () => {
    const second = tempDir();
    await setState("instance", { dbPath: "c:/x/app.db", id: "this-install", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    fs.writeFileSync(path.join(second, backups.SECOND_FOLDER_MARKER), JSON.stringify({ instanceId: "another-install" }));
    const theirs = [1, 2, 3].map((day) => backups.backupFileName(new Date(2020, 0, day, 12, 0, 0), `oth${day}`));
    for (const name of theirs) fs.writeFileSync(path.join(second, name), "their backup");
    await setSetting("backups.keep", 1, null);
    await setSetting("backups.secondFolder", second, null);
    const result = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });
    expect(result.copiedTo).toBeNull();
    expect(result.copyError).toContain("another installation");
    expect(fs.readdirSync(second).sort()).toEqual([...theirs, backups.SECOND_FOLDER_MARKER].sort());
    expect((await db.notification.findFirstOrThrow({ where: { type: "backup.copyFailed" } })).body).toContain(
      "this folder belongs to another copy of the app",
    );
  });

  it("the second folder keeps 14 daily and 5 Back up now backups too, and tidies its old .tmp files", async () => {
    const second = tempDir();
    await setSetting("backups.secondFolder", second, null);
    const stale = path.join(second, `${backups.backupFileName(new Date(2020, 0, 1, 12, 0, 0), "tmp1")}.tmp`);
    fs.writeFileSync(stale, "left over");
    const old = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(stale, old, old);
    await setSetting("backups.keep", 2, null);
    const base = new Date(2026, 8, 1, 23, 0, 0).getTime();
    // Files without a row count against no kind (review BACKUPS-1): a recent one stays, one older than the keep window
    // (2 days here) goes.
    const recentNoRow = backups.backupFileName(new Date(base - 86_400_000), "nrw1");
    const oldNoRow = backups.backupFileName(new Date(2020, 0, 2, 12, 0, 0), "nrw2");
    fs.writeFileSync(path.join(second, recentNoRow), "copied yesterday, made after a restored backup");
    fs.writeFileSync(path.join(second, oldNoRow), "copied long ago");
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push((await backups.runBackup({ kind: "MANUAL", vacuum: fastVacuum, now: new Date(base + i * 60_000) })).fileName);
    const a = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum, now: new Date(base + 3 * 60_000) });
    const inSecond = new Set(fs.readdirSync(second));
    expect(inSecond.has(stale.split(path.sep).pop()!)).toBe(false);
    for (const m of made) expect(inSecond.has(m), m).toBe(true);
    expect(inSecond.has(a.fileName)).toBe(true);
    expect(inSecond.has(recentNoRow)).toBe(true);
    expect(inSecond.has(oldNoRow)).toBe(false);
  });

  it("a backup over 2 GiB is still copied: the real size is compared, only the row's size is capped (review BACKUPS-2)", async () => {
    const second = tempDir();
    await setSetting("backups.secondFolder", second, null);
    const huge = 3 * 1024 ** 3; // 3 GiB, reported by the stand-in instead of written
    const result = await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      sizeOf: async () => huge,
      secondFolderIo: { statfs: async () => ({ bavail: huge + 100 * 1024 * 1024, bsize: 1 }) },
    });
    expect(result).toMatchObject({ sizeBytes: huge, copiedTo: second, copyError: null });
    expect(result.summary).toBe("Daily backup saved (3.0 GB).");
    expect(fs.existsSync(path.join(second, result.fileName))).toBe(true);
    const row = await db.backup.findUniqueOrThrow({ where: { fileName: result.fileName } });
    expect(row).toMatchObject({ sizeBytes: 2_147_483_647, copiedTo: second });

    // The free-space check uses the real size too: 2.5 GiB free isn't enough for a 3 GiB backup.
    const short = await backups.runBackup({
      kind: "AUTO",
      vacuum: fastVacuum,
      sizeOf: async () => huge,
      secondFolderIo: { statfs: async () => ({ bavail: 2.5 * 1024 ** 3, bsize: 1 }) },
    });
    expect(short.copiedTo).toBeNull();
    expect(short.copyError).toMatch(/needed$/);
  });

  it("Windows refusing access says to run install-services.bat, then Back up now (review SCREENS-03)", async () => {
    const second = tempDir();
    await setSetting("backups.secondFolder", second, null);
    const denied = await backups.runBackup({
      kind: "MANUAL",
      vacuum: fastVacuum,
      secondFolderIo: {
        copyFile: async () => {
          throw Object.assign(new Error("EPERM: operation not permitted, copyfile"), { code: "EPERM" });
        },
      },
    });
    expect(denied.copiedTo).toBeNull();
    const note = await db.notification.findFirstOrThrow({ where: { type: "backup.copyFailed" } });
    expect(note.body).toBe(
      `Couldn't copy the backup to ${second}: the app isn't allowed to save files in that folder. The backup itself is saved on this PC. ` +
        "If the app runs as a Windows service, run install-services.bat on the office PC so the background sender may write there, then click Back up now in Settings › Backups.",
    );
    // Back up now shows the task's summary: it says the copy failed and what to do.
    expect(denied.summary).toMatch(
      /^Backup saved \(.+\)\. The copy to the second folder failed: the app isn't allowed to save files in that folder\. If the app runs as a Windows service, run install-services\.bat on the office PC, then click Back up now\.$/,
    );
    expect(fs.readdirSync(second).filter(backups.isBackupFileName)).toEqual([]);
  });
});

describe("the backup helper comes only from the app's own folder (review SECURITY-03)", () => {
  it("is this project's scripts\\vacuum-into.mjs here, and a missing helper fails the backup plainly", async () => {
    expect(backups.vacuumScriptPath()).toBe(path.resolve("scripts", "vacuum-into.mjs"));
    await setSetting("backups.keep", 14, null);
    const before = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    await expect(
      backups.runBackup({ kind: "MANUAL", vacuum: (dbFile, tmp) => backups.vacuumInChildProcess(dbFile, tmp, 60_000, null) }),
    ).rejects.toThrow(backups.HELPER_MISSING_TEXT);
    expect(fs.existsSync(folder) ? fs.readdirSync(folder) : []).toEqual(before);
    const failed = await db.activityLog.findFirstOrThrow({ where: { type: "backup.failed" }, orderBy: { id: "desc" } });
    expect(failed.summary).toMatch(/^The backup failed: Some of the app's files are missing \(scripts\\vacuum-into\.mjs\), so no backup was made\./);
  });
});

describe("a restore marker handled but not deleted is tried again after a backup (review BACKUPS-4)", () => {
  it("deletes this database's handled marker, never a waiting one", async () => {
    const restore = await import("@/server/services/sending/restore");
    const marker = restore.restoreMarkerPath();
    const at = "2026-09-20T10:00:00.000Z";
    const write = () =>
      fs.writeFileSync(marker, JSON.stringify({ version: 3, restoredFrom: "2026-09-19T10:00:00.000Z", at, file: "b.db", db: path.basename(t.file) }));
    try {
      // Waiting to be handled: left alone.
      write();
      await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });
      expect(fs.existsSync(marker)).toBe(true);
      // Handled already (the restore state records it): the backup deletes it.
      await setState("restore", {
        status: "done",
        restoredFrom: "2026-09-19T10:00:00.000Z",
        scanFrom: null,
        markerAt: at,
        file: "b.db",
        handledAt: "2026-09-20T10:00:05.000Z",
        report: null,
        acknowledgedAt: null,
        acknowledgedById: null,
      });
      await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(marker, { force: true });
      await dbWrite((c) => c.systemState.deleteMany({ where: { key: "restore" } }));
    }
  });
});
