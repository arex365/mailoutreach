import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_BACKUP_PATTERN,
  BACKUP_KIND_LABELS as SCRIPT_KIND_LABELS,
  SCRIPT_BACKUP_PATTERN as SCRIPT_PATTERN_MJS,
  appBackupFolder,
  backupFileName,
  backupKindLabel,
  backupLabel,
  formatBytes,
  listBackups,
  makeBackup,
  newestBackupStatus,
  parseBackupTime,
  readBackupKinds,
  restoredFromTime,
  scriptBackupKind as scriptBackupKindMjs,
  sortBackupsNewestFirst,
  timestampForFile,
} from "../../../scripts/lib/backups.mjs";
import { isSqliteFile, quickCheck } from "../../../scripts/lib/sqlite.mjs";
import { SCRIPT_BACKUP_PATTERN, scriptBackupDate, scriptBackupKind } from "@/core/backups/names";
import { BACKUP_FILE_PATTERN, BACKUP_KIND_LABELS } from "@/server/services/backups";

// The app's names and labels are compared with the scripts' copy: keep the real database client out of it.
vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn(), withWriteLock: vi.fn() }));

describe("backup file names", () => {
  it("uses the PC's local time in a file-safe form", () => {
    const d = new Date(2026, 8, 23, 14, 5, 9);
    expect(timestampForFile(d)).toBe("2026-09-23_14-05-09");
    expect(backupFileName("preupdate", d)).toBe("app-preupdate-2026-09-23_14-05-09.db");
  });

  it("reads the time back from our own names", () => {
    const d = new Date(2026, 8, 23, 14, 5, 9);
    expect(parseBackupTime(backupFileName("premigrate", d))?.getTime()).toBe(d.getTime());
    expect(parseBackupTime("C:\\x\\backups\\app-prerestore-2026-01-02_03-04-05.db")?.getTime()).toBe(new Date(2026, 0, 2, 3, 4, 5).getTime());
  });

  it("understands other common styles (the background sender's daily names, compact, UTC)", () => {
    expect(parseBackupTime("app-2026-09-23T01-30.db")?.getTime()).toBe(new Date(2026, 8, 23, 1, 30, 0).getTime());
    expect(parseBackupTime("app-2026-09-23 01:30:15.db")?.getTime()).toBe(new Date(2026, 8, 23, 1, 30, 15).getTime());
    expect(parseBackupTime("backup-20260923-013015.db")?.getTime()).toBe(new Date(2026, 8, 23, 1, 30, 15).getTime());
    expect(parseBackupTime("app-2026-09-23T01-30-15Z.db")?.toISOString()).toBe("2026-09-23T01:30:15.000Z");
    expect(parseBackupTime("app-daily-2026-09-23.db")?.getTime()).toBe(new Date(2026, 8, 23).getTime());
    // What the background sender actually writes (src/server/services/backups.ts backupFileName).
    expect(parseBackupTime("app-2026-09-23-221405-k3x9.db")?.getTime()).toBe(new Date(2026, 8, 23, 22, 14, 5).getTime());
  });

  it("returns null for names without a (valid) time", () => {
    expect(parseBackupTime("my-copy.db")).toBeNull();
    expect(parseBackupTime("app-2026-02-31_10-00-00.db")).toBeNull();
    expect(parseBackupTime("app-2026-13-01_10-00-00.db")).toBeNull();
    expect(parseBackupTime("")).toBeNull();
  });

  it("describes the kind of backup in plain words", () => {
    expect(backupKindLabel("app-preupdate-2026-09-23_14-05-09.db")).toBe("Before an update");
    expect(backupKindLabel("app-prerestore-x.db")).toBe("Before a restore");
    expect(backupKindLabel("app-premigrate-x.db")).toBe("Before a database upgrade");
    expect(backupKindLabel("app-manual-x.db")).toBe("Back up now");
    expect(backupKindLabel("app-auto-x.db")).toBe("Daily backup");
    expect(backupKindLabel("something.db")).toBe("Backup");
  });

  it("labels the background sender's backups by their Backup row, in the app's words", () => {
    const daily = "app-2026-09-23-221405-k3x9.db";
    const manual = "app-2026-09-24-101500-ab12.db";
    const kinds = new Map([
      [daily, "AUTO"],
      [manual, "MANUAL"],
    ]);
    expect(backupLabel(daily, kinds)).toBe("Daily backup");
    expect(backupLabel(manual, kinds)).toBe("Back up now");
    expect(backupLabel("app-2026-09-25-101500-zz99.db", kinds)).toBe("Backup"); // no row
    expect(backupLabel(`C:\\x\\backups\\${daily}`, kinds)).toBe("Daily backup");
    expect(backupLabel("app-preupdate-2026-09-23_14-05-09.db", kinds)).toBe("Before an update");
    expect(backupLabel(daily)).toBe("Backup");
  });
});

/**
 * One vocabulary (M6-DESIGN §3.2): the scripts keep their own copy of the name rules (they don't import TypeScript),
 * so both are pinned to the same table here.
 */
describe("the scripts' copy of the backup name rules matches the app's", () => {
  const table: Array<[name: string, kind: string | null, app: boolean]> = [
    ["app-preupdate-2026-09-23_14-05-09.db", "PRE_UPDATE", false],
    ["app-prerestore-2026-09-23_14-05-09-2.db", "PRE_RESTORE", false],
    ["app-premigrate-2026-01-02_03-04-05.db", "PRE_MIGRATE", false],
    ["app-2026-09-23-221405-k3x9.db", null, true],
    ["app-preupdate-2026-09-23_14-05-09.db-wal", null, false],
    ["app-2026-09-23-221405-k3x9.db.tmp", null, false],
    ["app-auto-2026-09-20_10-00-00.db", null, false],
    ["notes.db", null, false],
  ];

  it("recognises the same names, kinds and times", () => {
    expect(SCRIPT_PATTERN_MJS.source).toBe(SCRIPT_BACKUP_PATTERN.source);
    expect(APP_BACKUP_PATTERN.source).toBe(BACKUP_FILE_PATTERN.source);
    for (const [name, kind, app] of table) {
      expect(scriptBackupKindMjs(name), name).toBe(kind);
      expect(scriptBackupKind(name), name).toBe(kind);
      expect(APP_BACKUP_PATTERN.test(name), name).toBe(app);
      if (kind) expect(parseBackupTime(name)?.getTime(), name).toBe(scriptBackupDate(name)?.getTime());
    }
  });

  it("uses the same labels", () => {
    expect(SCRIPT_KIND_LABELS).toEqual(BACKUP_KIND_LABELS);
    expect(BACKUP_KIND_LABELS).toEqual({
      AUTO: "Daily backup",
      MANUAL: "Back up now",
      PRE_UPDATE: "Before an update",
      PRE_RESTORE: "Before a restore",
      PRE_MIGRATE: "Before a database upgrade",
    });
  });

  it("finds the same backup folder as the app", () => {
    const root = path.resolve("C:/Outreach");
    expect(appBackupFolder(path.join(root, "data", "app.db"), root)).toBe(path.join(root, "backups"));
    expect(appBackupFolder(path.join(root, "data", "demo.db"), root)).toBe(path.join(root, "backups", "demo"));
    expect(appBackupFolder("D:/OutreachData/app.db", root)).toBe(path.join(root, "backups", "app"));
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("restoredFromTime", () => {
  it("uses the earlier of the name's time and the file's time (the safe direction)", () => {
    const named = new Date(2026, 8, 20, 10, 0, 0);
    const earlierFile = new Date(2026, 8, 20, 9, 0, 0);
    const laterFile = new Date(2026, 8, 21, 9, 0, 0);
    expect(restoredFromTime({ fileName: backupFileName("auto", named), mtime: laterFile })?.getTime()).toBe(named.getTime());
    expect(restoredFromTime({ fileName: backupFileName("auto", named), mtime: earlierFile })?.getTime()).toBe(earlierFile.getTime());
  });

  it("falls back to whichever is known", () => {
    const mtime = new Date(2026, 8, 21, 9, 0, 0);
    expect(restoredFromTime({ fileName: "copy.db", mtime })).toBe(mtime);
    expect(restoredFromTime({ fileName: "app-2026-09-20_10-00-00.db", mtime: undefined })?.getTime()).toBe(
      new Date(2026, 8, 20, 10, 0, 0).getTime(),
    );
    expect(restoredFromTime({ fileName: "copy.db", mtime: undefined })).toBeNull();
  });
});

describe("sortBackupsNewestFirst", () => {
  it("sorts by the time in the name, else the modified time", () => {
    const items = [
      { name: "a.db", time: new Date(2026, 0, 1), mtime: new Date(2026, 5, 1) },
      { name: "b.db", time: null, mtime: new Date(2026, 3, 1) },
      { name: "c.db", time: new Date(2026, 8, 1), mtime: new Date(2026, 0, 1) },
    ];
    expect(sortBackupsNewestFirst(items).map((i: { name: string }) => i.name)).toEqual(["c.db", "b.db", "a.db"]);
  });
});

describe("making and listing backups", () => {
  let dir = "";
  let dbFile = "";

  beforeAll(() => {
    dir = path.resolve("data", "test", `backups-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    dbFile = path.join(dir, "source.db");
    const db = new Database(dbFile);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('Werkstatt Nord'), ('Fjordprint');");
    db.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a consistent copy with VACUUM INTO and lists it", async () => {
    const backups = path.join(dir, "backups");
    const r = await makeBackup("manual", dbFile, backups);
    expect(path.basename(r.file)).toMatch(/^app-manual-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
    expect(r.method).toContain("VACUUM INTO");
    expect(isSqliteFile(r.file)).toBe(true);
    expect(await quickCheck(r.file)).toBe("ok");
    const copy = new Database(r.file, { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
    copy.close();

    // A second backup in the same second gets its own name instead of overwriting.
    const r2 = await makeBackup("manual", dbFile, backups);
    expect(r2.file).not.toBe(r.file);

    fs.writeFileSync(path.join(backups, "notes.txt"), "not a backup");
    const listed = listBackups(backups);
    expect(listed).toHaveLength(2);
    expect(listed.every((b: { name: string }) => b.name.endsWith(".db"))).toBe(true);
    expect(fs.readdirSync(backups).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("recognises SQLite files", () => {
    const notDb = path.join(dir, "plain.db");
    fs.writeFileSync(notDb, "hello");
    expect(isSqliteFile(notDb)).toBe(false);
    expect(isSqliteFile(path.join(dir, "missing.db"))).toBe(false);
    expect(isSqliteFile(dbFile)).toBe(true);
  });

  it("returns an empty list for a missing folder", () => {
    expect(listBackups(path.join(dir, "nope"))).toEqual([]);
  });

  it("a raw copy that fails half-way leaves nothing that looks like a backup", async () => {
    const backups = path.join(dir, "raw-fail");
    // Not a database at all: VACUUM INTO fails, and so does the raw copy of a file that isn't there.
    await expect(makeBackup("prerestore", path.join(dir, "missing.db"), backups, { allowRawCopy: true })).rejects.toThrow();
    expect(fs.readdirSync(backups)).toEqual([]);
  });
});

/**
 * status.bat's "Newest backup" line (M6-DESIGN §3.9) and restore.bat's labels read the app's Backup rows read-only,
 * from a database of their own here (a temporary app folder: never data\app.db).
 */
describe("the kinds from the Backup rows and status.bat's newest-backup line", () => {
  let root = "";
  const now = new Date(2026, 8, 27, 12, 0, 0);
  const daily = "app-2026-09-27-050000-aaaa.db"; // 7 hours before `now` (local time)
  const manual = "app-2026-09-26-080000-bbbb.db";
  const noRow = "app-2026-09-20-080000-cccc.db";

  beforeAll(() => {
    root = path.resolve("data", "test", `status-line-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.mkdirSync(path.join(root, "backups"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), 'DATABASE_URL="file:./data/app.db"\n');
    const db = new Database(path.join(root, "data", "app.db"));
    db.exec(`CREATE TABLE "Backup" ("id" INTEGER PRIMARY KEY, "fileName" TEXT NOT NULL, "kind" TEXT NOT NULL)`);
    db.prepare(`INSERT INTO "Backup" ("fileName", "kind") VALUES (?, ?), (?, ?)`).run(daily, "AUTO", manual, "MANUAL");
    db.close();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the kinds, and gives an empty map for a missing or unsuitable database", async () => {
    const kinds = await readBackupKinds(path.join(root, "data", "app.db"));
    expect(Object.fromEntries(kinds)).toEqual({ [daily]: "AUTO", [manual]: "MANUAL" });
    expect((await readBackupKinds(path.join(root, "data", "nope.db"))).size).toBe(0);
    const plain = path.join(root, "plain.db");
    new Database(plain).close();
    expect((await readBackupKinds(plain)).size).toBe(0);
  });

  it("says when there is none yet", async () => {
    expect(await newestBackupStatus(root, now)).toEqual({ line: "Newest backup: none yet", stale: true });
  });

  it("names the newest app backup with its kind and age; the scripts' backups don't count", async () => {
    for (const name of [manual, noRow, "app-preupdate-2026-09-27_11-00-00.db"]) fs.writeFileSync(path.join(root, "backups", name), "x");
    expect(await newestBackupStatus(root, now)).toEqual({ line: "Newest backup: 26 Sep 08:00, Back up now (28 hours ago)", stale: false });
    fs.writeFileSync(path.join(root, "backups", daily), "x");
    expect(await newestBackupStatus(root, now)).toEqual({ line: "Newest backup: 27 Sep 05:00, Daily backup (7 hours ago)", stale: false });
    // Two days later it is old.
    expect(await newestBackupStatus(root, new Date(now.getTime() + 2 * 24 * 3_600_000))).toEqual({
      line: "Newest backup: 27 Sep 05:00, Daily backup (2 days ago)",
      stale: true,
    });
    // A file without a row is a plain "Backup".
    fs.rmSync(path.join(root, "backups", daily));
    fs.rmSync(path.join(root, "backups", manual));
    expect((await newestBackupStatus(root, now)).line).toBe("Newest backup: 20 Sep 08:00, Backup (7 days ago)");
  });
});
