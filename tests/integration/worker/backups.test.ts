import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-backups");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const backups = await import("@/server/services/backups");
const { runBackupJob } = await import("../../../worker/jobs/backup");
const { readTaskState } = await import("../../../worker/periodic");

const folder = backups.backupFolder();
const tempDirs: string[] = [];
let ownerId = 0;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-backup-test-"));
  tempDirs.push(dir);
  return dir;
}

function countRows(file: string, table: string): number {
  const conn = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  } finally {
    conn.close();
  }
}

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { email: "arslan@example.com", name: "Arslan", role: "OWNER" } }));
  ownerId = owner.id;
  for (const [i, name] of ["Müller 3D", "Nordic Prints", "Studio Polar"].entries()) {
    const company = await dbWrite((c) => c.company.create({ data: { name, nameNorm: name.toLowerCase() } }));
    if (i < 2) {
      await dbWrite((c) =>
        c.person.create({ data: { companyId: company.id, name: `Person ${i}`, email: `p${i}@example.com`, emailNorm: `p${i}@example.com` } }),
      );
    }
  }
});

beforeEach(async () => {
  await setSetting("backups.keep", 14, null);
  await setSetting("backups.secondFolder", null, null);
  await dbWrite((c) => c.notification.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

describe("backup folder for a test database", () => {
  it("is a subfolder of backups named after the database file, never the real backups folder", () => {
    const expected = path.join(process.cwd(), "backups", path.basename(t.file, ".db"));
    expect(folder).toBe(expected);
    expect(folder).not.toBe(path.join(process.cwd(), "backups"));
  });
});

describe("runBackup", () => {
  it("writes a readable copy with the same rows and records it", async () => {
    const result = await backups.runBackup({ kind: "MANUAL", userId: ownerId });
    expect(backups.isBackupFileName(result.fileName)).toBe(true);
    expect(result.filePath).toBe(path.join(folder, result.fileName));
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.existsSync(result.filePath + ".tmp")).toBe(false);
    expect(result.sizeBytes).toBe(fs.statSync(result.filePath).size);
    expect(result.summary).toMatch(/^Backup saved \(\d+(\.\d)? (KB|MB)\)\.$/);

    for (const table of ["User", "Company", "Person"]) {
      expect(countRows(result.filePath, table)).toBe(countRows(t.file, table));
    }
    expect(countRows(result.filePath, "Company")).toBe(3);
    expect(countRows(result.filePath, "Person")).toBe(2);

    const row = await db.backup.findUniqueOrThrow({ where: { fileName: result.fileName } });
    expect(row).toMatchObject({ kind: "MANUAL", sizeBytes: result.sizeBytes, copiedTo: null });
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "backup.done" }, orderBy: { id: "desc" } });
    expect(activity.actorId).toBe(ownerId);
    expect(activity.summary).toMatch(/^Arslan backed up the database \(/);

    const list = await backups.listBackups();
    expect(list[0]).toMatchObject({ fileName: result.fileName, kind: "MANUAL", sizeBytes: result.sizeBytes });
  });

  it("keeps only the newest N daily backups and removes the rows of deleted ones", async () => {
    await setSetting("backups.keep", 3, null);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    const old = [1, 2, 3, 4].map((day) => backups.backupFileName(new Date(2020, 0, day, 12, 0, 0), "old" + day));
    for (const name of old) fs.writeFileSync(path.join(folder, name), "old backup");
    fs.writeFileSync(path.join(folder, "keep-me.db"), "not ours");
    await dbWrite((c) =>
      c.backup.createMany({
        data: old.slice(0, 3).map((fileName) => ({ fileName, sizeBytes: 10, kind: "AUTO", createdAt: backups.backupDateFromName(fileName)! })),
      }),
    );
    // A recent file without a row (made after a restored backup): it counts against no kind and stays for now.
    const noRow = backups.backupFileName(new Date(Date.now() - 86_400_000), "norw");
    fs.writeFileSync(path.join(folder, noRow), "made after the restored backup");

    const result = await backups.runBackup({ kind: "AUTO" });
    const files = fs.readdirSync(folder).filter(backups.isBackupFileName).sort();
    expect(files).toHaveLength(4);
    expect(files).toContain(result.fileName);
    expect(files).toContain(old[2]);
    expect(files).toContain(old[1]);
    expect(files).toContain(noRow);
    expect(new Set(result.removed)).toEqual(new Set([old[0], old[3]])); // the oldest daily one, and a year-old file without a row
    expect(fs.existsSync(path.join(folder, "keep-me.db"))).toBe(true);
    expect(await db.backup.count({ where: { fileName: old[0]! } })).toBe(0);

    const list = await backups.listBackups();
    expect(list.map((b) => b.fileName)).toEqual([result.fileName, ...files.filter((f) => f !== result.fileName).reverse()]);
    expect(list.find((b) => b.fileName === noRow)?.kind).toBeNull(); // file without a row
    expect(result.summary).toMatch(/^Daily backup saved/);
  });

  it("copies to the second folder and prunes it the same way, per kind", async () => {
    const second = tempDir();
    await setSetting("backups.keep", 2, null);
    await setSetting("backups.secondFolder", second, null);
    const a = await backups.runBackup({ kind: "AUTO" });
    const b = await backups.runBackup({ kind: "AUTO" });
    const c = await backups.runBackup({ kind: "AUTO" });
    expect(c.copiedTo).toBe(second);
    expect(c.copyError).toBeNull();
    const copies = fs.readdirSync(second).filter(backups.isBackupFileName);
    expect(new Set(copies)).toEqual(new Set([b.fileName, c.fileName]));
    expect(copies).not.toContain(a.fileName);
    expect(fs.readdirSync(second).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect((await db.backup.findUniqueOrThrow({ where: { fileName: c.fileName } })).copiedTo).toBe(second);
    // Back up now has its own 5: a manual one never pushes out the 2 daily copies.
    const m = await backups.runBackup({ kind: "MANUAL" });
    expect(new Set(fs.readdirSync(second).filter(backups.isBackupFileName))).toEqual(new Set([b.fileName, c.fileName, m.fileName]));
  });

  it("never copies in the practice copy", async () => {
    const second = tempDir();
    await setSetting("backups.secondFolder", second, null);
    await setSetting("practice.copy", true, null);
    try {
      const result = await backups.runBackup({ kind: "AUTO" });
      expect(result).toMatchObject({ copiedTo: null, copyError: null });
      expect(fs.readdirSync(second)).toEqual([]);
    } finally {
      await setSetting("practice.copy", false, null);
    }
  });

  it("keeps the main backup and tells the Owner when the second folder is missing", async () => {
    const missing = path.join(tempDir(), "unplugged-drive");
    await setSetting("backups.secondFolder", missing, null);
    const result = await backups.runBackup({ kind: "AUTO" });
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.copiedTo).toBeNull();
    expect(result.copyError).toBeTruthy();
    expect((await db.backup.findUniqueOrThrow({ where: { fileName: result.fileName } })).copiedTo).toBeNull();
    const note = await db.notification.findFirstOrThrow({ where: { userId: ownerId } });
    expect(note.title).toBe("Couldn't copy the backup to the second folder");
    expect(note.body).toContain(`Couldn't copy the backup to ${missing}: the folder isn't there (is the drive or USB stick plugged in?).`);
    expect(note.body).not.toMatch(/ENOENT|copyfile/i); // the system's wording stays out of the notification
    expect(note.link).toBe("/settings/backups");
  });

  it("never deletes the backup it just made when the PC's clock is behind, and tells the Owner once", async () => {
    await setSetting("backups.keep", 3, null);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    // Three daily backups from 2030 exist; the clock was reset and says 1 January 2025.
    const future = [1, 2, 3].map((day) => backups.backupFileName(new Date(2030, 0, day, 12, 0, 0), "fut" + day));
    for (const name of future) fs.writeFileSync(path.join(folder, name), "future backup");
    await dbWrite((c) =>
      c.backup.createMany({ data: future.map((fileName) => ({ fileName, sizeBytes: 13, kind: "AUTO", createdAt: backups.backupDateFromName(fileName)! })) }),
    );
    const clock = new Date(2025, 0, 1, 23, 0, 0);

    const result = await backups.runBackup({ kind: "AUTO", now: clock });
    const files = fs.readdirSync(folder).filter(backups.isBackupFileName);
    expect(files).toContain(result.fileName);
    expect(files).toHaveLength(3);
    expect(result.removed).toEqual([future[0]]);
    expect(await db.backup.count({ where: { fileName: result.fileName } })).toBe(1);
    expect(result.clockLooksWrong).toBe(true);
    expect(result.summary).toMatch(/^Daily backup saved \(.+\)\. The PC's clock looks wrong: check its date and time\.$/);

    const notes = await db.notification.findMany({ where: { userId: ownerId, type: "backup.clockWrong" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("The office PC's clock looks wrong");
    expect(notes[0]!.body).toContain(future[2]);

    // The next day (clock still behind): the newest one is kept again, and no second reminder piles up.
    const next = await backups.runBackup({ kind: "AUTO", now: new Date(2025, 0, 2, 23, 0, 0) });
    expect(fs.existsSync(next.filePath)).toBe(true);
    expect(fs.readdirSync(folder).filter(backups.isBackupFileName)).toHaveLength(3);
    expect(await db.notification.count({ where: { userId: ownerId, type: "backup.clockWrong" } })).toBe(1);
  });

  it("never runs two backups at once in the same process", async () => {
    const first = backups.runBackup({ kind: "MANUAL" });
    await expect(backups.runBackup({ kind: "MANUAL" })).rejects.toBeInstanceOf(backups.BackupBusyError);
    await first;
  });

  it("refuses an unknown kind", async () => {
    await expect(backups.runBackup({ kind: "WEEKLY" as never })).rejects.toThrow(/Unknown backup kind/);
  });
});

describe("backup.run job handler", () => {
  const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => {} };

  it("records the daily task's success for automatic backups only", async () => {
    await runBackupJob({ kind: "MANUAL" }, ctx);
    expect((await readTaskState("backup.daily")).lastSuccessAt).toBeNull();
    const result = await runBackupJob({ kind: "AUTO" }, ctx);
    expect(result.summary).toMatch(/^Daily backup saved/);
    const state = await readTaskState("backup.daily");
    expect(state.lastSuccessAt).toBeInstanceOf(Date);
    expect(Date.now() - state.lastSuccessAt!.getTime()).toBeLessThan(10_000);
  });

  it("rejects a payload with an unknown kind", async () => {
    await expect(runBackupJob({ kind: "HOURLY" }, ctx)).rejects.toThrow(/unknown kind/);
  });
});

describe("manual backup queue", () => {
  it("queues one manual backup at a time", async () => {
    const a = await backups.enqueueManualBackup(ownerId);
    const b = await backups.enqueueManualBackup(ownerId);
    expect(b.id).toBe(a.id);
    expect(await backups.getPendingManualBackupJob()).toMatchObject({ id: a.id, status: "QUEUED" });
    const job = await db.job.findUniqueOrThrow({ where: { id: a.id } });
    expect(job).toMatchObject({ type: "backup.run", payload: { kind: "MANUAL" }, createdById: ownerId });
  });
});

describe("checkSecondFolder (the full table is in tests/unit/backups-core/second-folder.test.ts)", () => {
  // Never ask Windows about drives from a test.
  const fixed = { driveTypeOf: async () => "fixed" as const };

  it("accepts an existing folder the app can write to", async () => {
    const dir = tempDir();
    const res = await backups.checkSecondFolder(`  "${dir}"  `, fixed);
    expect(res).toMatchObject({ ok: true, folder: path.resolve(dir) });
    expect(fs.readdirSync(dir)).toEqual([]); // the write test leaves nothing behind
  });

  it("explains what's wrong with other paths", async () => {
    const dir = tempDir();
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");
    const cases: Array<[string, RegExp]> = [
      ["", /Enter the full path/],
      ["Backups", /starting with the drive letter/],
      [path.join(dir, "nope"), /doesn't exist/],
      [file, /That's a file, not a folder/],
      [folder, /outside the app's folder/],
      [path.join(folder, "sub"), /outside the app's folder/],
    ];
    for (const [input, message] of cases) {
      const res = await backups.checkSecondFolder(input, fixed);
      expect(res.ok, input).toBe(false);
      if (!res.ok) expect(res.error).toMatch(message);
    }
  });

  it("reads this installation's id from the database to recognise another installation's folder", async () => {
    await setState("instance", { dbPath: "c:/outreach/data/app.db", id: "this-install", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    try {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, backups.SECOND_FOLDER_MARKER), JSON.stringify({ instanceId: "another-install" }));
      expect(await backups.checkSecondFolder(dir, fixed)).toEqual({ ok: false, error: backups.SECOND_FOLDER_TEXTS.otherInstall });
      fs.writeFileSync(path.join(dir, backups.SECOND_FOLDER_MARKER), JSON.stringify({ instanceId: "this-install" }));
      expect((await backups.checkSecondFolder(dir, fixed)).ok).toBe(true);
    } finally {
      await dbWrite((c) => c.systemState.deleteMany({ where: { key: "instance" } }));
    }
  });
});
