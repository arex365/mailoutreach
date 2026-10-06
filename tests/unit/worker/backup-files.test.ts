import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are tested here: keep the real database client out of it.
vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn(), withWriteLock: vi.fn() }));

const {
  BACKUP_KIND_LABELS,
  MANUAL_BACKUP_KEEP,
  backupDateFromName,
  backupFileName,
  backupFolderFor,
  backupKindText,
  backupNewerThanClock,
  copyFailureReason,
  diskLowText,
  formatBytes,
  isBackupFileName,
  isBackupLeftover,
  normalizeKeep,
  randomSuffix,
  selectBackupsToDelete,
  selectBackupsToDeleteByKind,
} = await import("@/server/services/backups");

describe("backup file names", () => {
  it("uses the local date and time to the second plus 4 random characters", () => {
    const d = new Date(2026, 8, 23, 22, 14, 5);
    expect(backupFileName(d, "ab12")).toBe("app-2026-09-23-221405-ab12.db");
    expect(backupFileName(new Date(2027, 0, 2, 3, 4, 5), "zz99")).toBe("app-2027-01-02-030405-zz99.db");
  });

  it("refuses a suffix that isn't 4 lowercase letters or digits", () => {
    expect(() => backupFileName(new Date(), "AB12")).toThrow();
    expect(() => backupFileName(new Date(), "abc")).toThrow();
  });

  it("makes random suffixes that fit the pattern", () => {
    for (let i = 0; i < 50; i++) expect(randomSuffix()).toMatch(/^[a-z0-9]{4}$/);
  });

  it("recognises only our backup files", () => {
    expect(isBackupFileName("app-2026-09-23-221405-ab12.db")).toBe(true);
    expect(isBackupFileName("app-2026-09-23-221405-ab12.db.tmp")).toBe(false);
    expect(isBackupFileName("my-copy.db")).toBe(false);
    expect(isBackupFileName("app-2026-09-23-2214-ab12.db")).toBe(false);
  });

  it("reads the date back from a name", () => {
    const d = new Date(2026, 8, 23, 22, 14, 5);
    expect(backupDateFromName(backupFileName(d, "k3x9"))?.getTime()).toBe(d.getTime());
    expect(backupDateFromName("notes.txt")).toBeNull();
  });

  it("has one label per kind, the same words everywhere (M6-DESIGN §3.2)", () => {
    expect(BACKUP_KIND_LABELS).toEqual({
      AUTO: "Daily backup",
      MANUAL: "Back up now",
      PRE_UPDATE: "Before an update",
      PRE_RESTORE: "Before a restore",
      PRE_MIGRATE: "Before a database upgrade",
    });
    expect(backupKindText("AUTO")).toBe("Daily backup");
    expect(backupKindText(null)).toBe("Backup");
  });

  it("recognises the leftovers of an interrupted backup, and nothing else", () => {
    for (const leftover of [
      "app-2026-09-23-221405-ab12.db.tmp",
      "app-2026-09-23-221405-ab12.db.tmp.tmp-1234-1727000000000",
      "app-preupdate-2026-09-23_14-05-09.db.tmp-1234-1727000000000",
      "app-prerestore-2026-09-23_14-05-09-2.db.tmp-8-9",
    ]) {
      expect(isBackupLeftover(leftover), leftover).toBe(true);
    }
    for (const other of [
      "app-2026-09-23-221405-ab12.db",
      "app-preupdate-2026-09-23_14-05-09.db",
      "app-preupdate-2026-09-23_14-05-09.db-wal",
      "my-copy.db.tmp",
      "app-notes.db.tmp",
      "outreach-backups.json",
    ]) {
      expect(isBackupLeftover(other), other).toBe(false);
    }
  });
});

describe("retention", () => {
  const names = Array.from({ length: 16 }, (_, i) => backupFileName(new Date(2026, 8, i + 1, 23, 0, 0), "aaaa"));

  it("keeps the newest N and deletes the rest, oldest first", () => {
    const shuffled = [...names].reverse().concat(["notes.txt", "my-copy.db", "app-2020-01-01-000000-zzzz.db.tmp"]);
    const del = selectBackupsToDelete(shuffled, 14);
    expect(del).toHaveLength(2);
    expect(new Set(del)).toEqual(new Set([names[0], names[1]]));
  });

  it("never touches files that aren't our backups", () => {
    const del = selectBackupsToDelete(["notes.txt", "my-copy.db", ...names], 1);
    expect(del).not.toContain("notes.txt");
    expect(del).not.toContain("my-copy.db");
    expect(del).toHaveLength(15);
  });

  it("deletes nothing when there are fewer than N", () => {
    expect(selectBackupsToDelete(names.slice(0, 5), 14)).toEqual([]);
  });

  it("always keeps at least one backup", () => {
    expect(selectBackupsToDelete(names, 0)).toHaveLength(15);
    expect(normalizeKeep(0)).toBe(1);
    expect(normalizeKeep(-5)).toBe(1);
    expect(normalizeKeep("nonsense")).toBe(14);
    expect(normalizeKeep(7.8)).toBe(7);
    expect(normalizeKeep("20")).toBe(20);
  });

  it("orders by time even when two backups share a second", () => {
    const a = backupFileName(new Date(2026, 8, 30, 10, 0, 0), "aaaa");
    const b = backupFileName(new Date(2026, 8, 30, 10, 0, 0), "zzzz");
    const old = backupFileName(new Date(2026, 8, 1, 10, 0, 0), "mmmm");
    expect(selectBackupsToDelete([old, a, b], 2)).toEqual([old]);
    // Same second: the file written last is the newest, whatever its random suffix.
    expect(
      selectBackupsToDelete(
        [
          { name: a, mtimeMs: 2_000 },
          { name: b, mtimeMs: 1_000 },
        ],
        1,
      ),
    ).toEqual([b]);
  });
});

describe("retention per kind (M6-DESIGN §3.3)", () => {
  const at = (day: number, hour = 23) => new Date(2026, 8, day, hour, 0, 0);
  const daily = Array.from({ length: 16 }, (_, i) => ({ name: backupFileName(at(i + 1), "dayx"), kind: "AUTO" as const }));
  const manual = Array.from({ length: 20 }, (_, i) => ({ name: backupFileName(at(i + 1, 12), "manx"), kind: "MANUAL" as const }));

  const now = at(21, 23); // 21 Sep, after the newest of these backups

  it("keeps 14 daily and 5 Back up now backups: any number of Back up now clicks never pushes out a daily one", () => {
    expect(MANUAL_BACKUP_KEEP).toBe(5);
    const del = new Set(selectBackupsToDeleteByKind([...daily, ...manual], 14, null, now));
    for (const d of daily.slice(2)) expect(del.has(d.name), d.name).toBe(false);
    expect(del.has(daily[0]!.name) && del.has(daily[1]!.name)).toBe(true);
    const keptManual = manual.filter((m) => !del.has(m.name)).map((m) => m.name);
    expect(keptManual).toEqual(manual.slice(15).map((m) => m.name));
    expect(del.size).toBe(2 + 15);
  });

  it("never deletes the one just made", () => {
    // The Back up now just made on a clock that is behind sorts oldest, yet stays; its own kind keeps 5 in total.
    const justMade = { name: backupFileName(new Date(2025, 0, 1, 12, 0, 0), "new1"), kind: "MANUAL" as const };
    const del = selectBackupsToDeleteByKind([...manual.slice(0, 5), justMade], 14, justMade.name, now);
    expect(del).toEqual([manual[0]!.name]);
  });

  it("a file without a row counts against neither kind, and goes only once it is older than the keep window (review BACKUPS-1)", () => {
    // 16 files without rows (1–16 Sep), judged on 21 Sep with keep 14: only 1–6 Sep are more than 14 days old.
    const noRow = daily.map((d) => ({ ...d, kind: null }));
    expect(new Set(selectBackupsToDeleteByKind(noRow, 14, null, now))).toEqual(new Set(noRow.slice(0, 6).map((d) => d.name)));
    // They never push out a daily backup that has a row: keep 2, two old daily backups with rows and two recent files
    // without rows (15 and 16 Sep) on 16 Sep: nothing goes (counted as daily, the two with rows would have gone).
    const rowed = [1, 2].map((d) => ({ name: backupFileName(at(d, 2), "rowd"), kind: "AUTO" as const }));
    expect(selectBackupsToDeleteByKind([...rowed, ...noRow.slice(14)], 2, null, at(16))).toEqual([]);
    // A name dated after the clock (the clock went back) is never "old".
    expect(selectBackupsToDeleteByKind([{ name: backupFileName(new Date(2030, 0, 1), "futr"), kind: null }], 1, null, now)).toEqual([]);
  });

  it("after restoring an older backup, the next backup deletes no daily backup older than the one restored", () => {
    // 14 daily backups (1–14 Sep, 23:00) and 5 Back up now backups (10–14 Sep, 12:00), all with rows; the next daily
    // backup (15 Sep) pushes out only 1 Sep.
    const days = Array.from({ length: 14 }, (_, i) => ({ name: backupFileName(at(i + 1), "dly1"), kind: "AUTO" as const }));
    const clicks = Array.from({ length: 5 }, (_, i) => ({ name: backupFileName(at(i + 10, 12), "man1"), kind: "MANUAL" as const }));
    const next = { name: backupFileName(at(15), "next"), kind: "AUTO" as const };
    const when = at(15, 23);
    expect(selectBackupsToDeleteByKind([...days, ...clicks, next], 14, next.name, when)).toEqual([days[0]!.name]);
    // Restoring 7 Sep's backup leaves rows only for 1–6 Sep (the restored backup doesn't hold its own row): the files
    // of 7–14 Sep and the Back up now ones have none. Nothing is deleted now (before: 1–6 Sep all went).
    const restored = [...days.map((d, i) => (i < 6 ? d : { ...d, kind: null })), ...clicks.map((c) => ({ ...c, kind: null })), next];
    expect(selectBackupsToDeleteByKind(restored, 14, next.name, when)).toEqual([]);
  });
});

describe("retention when the PC's clock is behind", () => {
  // Fourteen backups from October 2026 exist; the clock was reset and now says January 2025.
  const existing = Array.from({ length: 14 }, (_, i) => backupFileName(new Date(2026, 9, i + 1, 23, 0, 0), "aaaa"));
  const justMade = backupFileName(new Date(2025, 0, 1, 23, 0, 0), "new1");

  it("never deletes the backup that was just made, and still keeps N in total", () => {
    const del = selectBackupsToDelete([...existing, justMade], 14, justMade);
    expect(del).not.toContain(justMade);
    expect(del).toEqual([existing[0]]); // the oldest real one goes instead
    expect(15 - del.length).toBe(14);
  });

  it("without protection the new file would have been the one deleted (the old bug)", () => {
    expect(selectBackupsToDelete([...existing, justMade], 14)).toEqual([justMade]);
  });

  it("keeps only the protected one when N is 1", () => {
    expect(new Set(selectBackupsToDelete([...existing, justMade], 1, justMade))).toEqual(new Set(existing));
  });

  it("ignores a protected name that isn't in the folder", () => {
    expect(selectBackupsToDelete(existing, 13, "app-2020-01-01-000000-zzzz.db")).toEqual([existing[0]]);
  });

  it("spots backups dated later than the clock (with slack for daylight saving)", () => {
    const now = new Date(2025, 0, 1, 23, 0, 5);
    expect(backupNewerThanClock(existing, now)?.name).toBe(existing[13]);
    expect(backupNewerThanClock([justMade], now)).toBeNull();
    const anHourAhead = backupFileName(new Date(now.getTime() + 60 * 60 * 1000), "dstx");
    expect(backupNewerThanClock([anHourAhead], now)).toBeNull();
    expect(backupNewerThanClock(["notes.txt"], now)).toBeNull();
  });
});

describe("copy failure reasons", () => {
  it("puts common file errors into plain words", () => {
    const err = (code: string) => Object.assign(new Error(`${code}: raw system text`), { code });
    expect(copyFailureReason(err("ENOENT"))).toMatch(/plugged in/);
    expect(copyFailureReason(err("EPERM"))).toMatch(/isn't allowed/);
    expect(copyFailureReason(err("ENOSPC"))).toBe("that drive is full");
    expect(copyFailureReason(err("EFBIG"))).toBe("the drive is formatted FAT32, which can't hold files over 4 GB");
    expect(copyFailureReason(new Error("weird"))).toBe("something unexpected went wrong");
  });
});

describe("the disk-space line", () => {
  it("says how much is free", () => {
    expect(diskLowText(1.2 * 1024 * 1024 * 1024)).toBe(
      "The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.",
    );
  });
});

describe("backup folder", () => {
  const cwd = path.resolve("C:\\outreach");

  it("uses <project>\\backups for the real database", () => {
    expect(backupFolderFor(path.join(cwd, "data", "app.db"), cwd)).toBe(path.join(cwd, "backups"));
    // Forward slashes (how db.ts writes the path) and different letter case are the same file on Windows.
    if (process.platform === "win32") {
      expect(backupFolderFor(cwd.replace(/\\/g, "/").toUpperCase() + "/data/APP.db", cwd)).toBe(path.join(cwd, "backups"));
    }
  });

  it("uses a subfolder for the practice copy and test databases", () => {
    expect(backupFolderFor(path.join(cwd, "data", "demo.db"), cwd)).toBe(path.join(cwd, "backups", "demo"));
    expect(backupFolderFor(path.join(cwd, "data", "test", "t-123-456.db"), cwd)).toBe(
      path.join(cwd, "backups", "t-123-456"),
    );
    // A file called app.db somewhere else is not the real database.
    expect(backupFolderFor(path.join(cwd, "data", "test", "app.db"), cwd)).toBe(path.join(cwd, "backups", "app"));
  });

  it("keeps odd file names safe as folder names", () => {
    expect(backupFolderFor(path.join(cwd, "data", "my data!.db"), cwd)).toBe(path.join(cwd, "backups", "my_data_"));
    expect(backupFolderFor(path.join(cwd, "data", ".db"), cwd)).toBe(path.join(cwd, "backups", "database"));
  });
});

describe("formatBytes", () => {
  it("shows sizes in plain units", () => {
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(840 * 1024)).toBe("840 KB");
    expect(formatBytes(3.46 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatBytes(123 * 1024 * 1024)).toBe("123 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});
