import { describe, expect, it } from "vitest";
import {
  SCRIPT_BACKUP_KEEP,
  SCRIPT_BACKUP_MIN_AGE_DAYS,
  SCRIPT_BACKUP_PATTERN,
  scriptBackupDate,
  scriptBackupKind,
  scriptBackupsToDelete,
} from "@/core/backups/names";

/**
 * The scripts' own backups (M6-DESIGN §3.2, §3.3): update.bat, restore.bat and the database upgrade save the database
 * as app-<kind>-YYYY-MM-DD_HH-MM-SS(-N).db. The app lists them with their kind and keeps the newest 3 of each kind,
 * never deleting one younger than 14 days.
 */

const DAY = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
/** A script backup's name for a local time (as scripts/lib/backups.mjs backupFileName writes it). */
function name(kind: "preupdate" | "prerestore" | "premigrate", d: Date, n?: number): string {
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `app-${kind}-${stamp}${n ? `-${n}` : ""}.db`;
}

describe("script backup names", () => {
  it("recognises the three kinds, with or without the same-second counter", () => {
    expect(scriptBackupKind("app-preupdate-2026-09-23_14-05-09.db")).toBe("PRE_UPDATE");
    expect(scriptBackupKind("app-prerestore-2026-09-23_14-05-09-2.db")).toBe("PRE_RESTORE");
    expect(scriptBackupKind("app-premigrate-2026-01-02_03-04-05.db")).toBe("PRE_MIGRATE");
    expect(SCRIPT_BACKUP_PATTERN.test("app-premigrate-2026-01-02_03-04-05.db")).toBe(true);
  });

  it("ignores everything else: the app's own backups, -wal companions, leftovers and other files", () => {
    for (const other of [
      "app-2026-09-23-221405-k3x9.db",
      "app-preupdate-2026-09-23_14-05-09.db-wal",
      "app-preupdate-2026-09-23_14-05-09.db.tmp-123-456",
      "app-manual-2026-09-23_14-05-09.db",
      "app-preupdate-2026-09-23.db",
      "notes.txt",
    ]) {
      expect(scriptBackupKind(other), other).toBeNull();
      expect(scriptBackupDate(other), other).toBeNull();
    }
  });

  it("reads the local time back from the name, and refuses impossible dates", () => {
    const d = new Date(2026, 8, 23, 14, 5, 9);
    expect(scriptBackupDate(name("preupdate", d))?.getTime()).toBe(d.getTime());
    expect(scriptBackupDate(name("prerestore", d, 3))?.getTime()).toBe(d.getTime());
    expect(scriptBackupDate("app-premigrate-2026-02-31_10-00-00.db")).toBeNull();
    expect(scriptBackupDate("app-premigrate-2026-13-01_10-00-00.db")).toBeNull();
    expect(scriptBackupDate("app-premigrate-2026-09-23_24-00-00.db")).toBeNull();
  });
});

describe("scriptBackupsToDelete", () => {
  const now = new Date(2026, 8, 27, 12, 0, 0);
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
  const files = (names: string[]) => names.map((n) => ({ name: n, mtimeMs: 0 }));

  it("keeps the newest 3 of each kind and deletes older ones that are at least 14 days old", () => {
    expect(SCRIPT_BACKUP_KEEP).toBe(3);
    expect(SCRIPT_BACKUP_MIN_AGE_DAYS).toBe(14);
    const updates = [40, 30, 20, 16, 15].map((d) => name("preupdate", daysAgo(d)));
    const migrates = [60, 50].map((d) => name("premigrate", daysAgo(d)));
    const del = scriptBackupsToDelete(files([...updates, ...migrates, "app-2026-01-01-000000-aaaa.db", "notes.db"]), now);
    // Newest 3 updates (15, 16, 20 days) stay; 30 and 40 go. Only 2 upgrades: both stay, however old.
    expect(new Set(del)).toEqual(new Set([updates[0], updates[1]]));
  });

  it("never deletes one younger than 14 days, even as the fourth of its kind", () => {
    const restores = [1, 2, 3, 5].map((d) => name("prerestore", daysAgo(d)));
    expect(scriptBackupsToDelete(files(restores), now)).toEqual([]);
    // Exactly 14 days old may go.
    const withOld = [...restores, name("prerestore", daysAgo(14))];
    expect(scriptBackupsToDelete(files(withOld), now)).toEqual([name("prerestore", daysAgo(14))]);
  });

  it("counts each kind on its own", () => {
    const mixed = [30, 31, 32, 33].flatMap((d) => [name("preupdate", daysAgo(d)), name("prerestore", daysAgo(d)), name("premigrate", daysAgo(d))]);
    const del = scriptBackupsToDelete(files(mixed), now);
    expect(del.sort()).toEqual([name("premigrate", daysAgo(33)), name("prerestore", daysAgo(33)), name("preupdate", daysAgo(33))].sort());
  });

  it("uses the file time when the name's date is impossible, and treats a future date as young", () => {
    const impossible = "app-preupdate-2026-02-31_10-00-00.db";
    const list = [
      ...[1, 2, 3].map((d) => ({ name: name("preupdate", daysAgo(d)), mtimeMs: 0 })),
      { name: impossible, mtimeMs: daysAgo(100).getTime() },
      { name: name("preupdate", new Date(now.getTime() + 300 * DAY)), mtimeMs: 0 },
    ];
    // The future one counts as the newest (kept with the 1- and 2-day ones); the 3-day one is young (kept); the
    // impossible one is dated by its file time, 100 days ago (deleted).
    expect(scriptBackupsToDelete(list, now)).toEqual([impossible]);
  });
});
