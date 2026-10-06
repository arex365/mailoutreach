import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backupFileName as scriptBackupName } from "../../../scripts/lib/backups.mjs";
import { createTestDb } from "../helpers/test-db";

/**
 * The scripts' own backups in the app (M6-DESIGN §3.2, §3.3, L5): Settings › Backups lists them with their kind next
 * to the app's; after every app backup the newest 3 of each kind are kept and none younger than 14 days is deleted
 * (with its -wal companion); the scripts' and the app's leftovers older than a day go; the app's own backups are
 * untouched by all this. The names come from the scripts' own naming code, the times are faked.
 */

const t = await createTestDb("backups-scripts");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const backups = await import("@/server/services/backups");

const folder = backups.backupFolder();
const DAY = 86_400_000;
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);
const fastVacuum = async (dbFile: string, tmp: string): Promise<{ ok: true; size: number }> => {
  fs.copyFileSync(dbFile, tmp);
  return { ok: true, size: fs.statSync(tmp).size };
};

/** A file in the backups folder with its modification time `age` days ago. */
function put(name: string, age = 0): string {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  fs.writeFileSync(file, "backup");
  const at = daysAgo(age);
  fs.utimesSync(file, at, at);
  return name;
}

beforeEach(async () => {
  fs.rmSync(folder, { recursive: true, force: true });
  await setSetting("backups.keep", 14, null);
  await dbWrite((c) => c.backup.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
  t.cleanup();
});

describe("listing", () => {
  it("lists the app's and the scripts' backups together, newest first, each with its kind", async () => {
    const preupdate = put(scriptBackupName("preupdate", daysAgo(3)), 3);
    const prerestore = put(scriptBackupName("prerestore", daysAgo(1)), 1);
    const premigrate = put(scriptBackupName("premigrate", daysAgo(5)), 5);
    put(`${prerestore}-wal`, 1); // a raw copy's companion is never listed on its own
    put("notes.db", 0);
    const daily = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum, now: daysAgo(2) });
    const noRow = put(backups.backupFileName(daysAgo(4), "nrow"), 4);

    const list = await backups.listBackups();
    expect(list.map((b) => [b.fileName, b.kind, b.source, b.copiedTo])).toEqual([
      [prerestore, "PRE_RESTORE", "script", null],
      [daily.fileName, "AUTO", "app", null],
      [preupdate, "PRE_UPDATE", "script", null],
      [noRow, null, "app", null],
      [premigrate, "PRE_MIGRATE", "script", null],
    ]);
    expect(list.map((b) => backups.backupKindText(b.kind))).toEqual([
      "Before a restore",
      "Daily backup",
      "Before an update",
      "Backup",
      "Before a database upgrade",
    ]);
    // A script backup's date is the one in its name.
    expect(list[0]!.createdAt.getTime()).toBe(new Date(Math.floor(daysAgo(1).getTime() / 1000) * 1000).getTime());
  });
});

describe("pruning after every app backup", () => {
  it("keeps the newest 3 of each kind, and none younger than 14 days; a -wal companion goes with its file", async () => {
    const updates = [40, 30, 20, 16].map((d) => put(scriptBackupName("preupdate", daysAgo(d)), d));
    put(`${updates[0]}-wal`, 40);
    const restores = [1, 2, 3, 5].map((d) => put(scriptBackupName("prerestore", daysAgo(d)), d));
    const migrates = [100, 90].map((d) => put(scriptBackupName("premigrate", daysAgo(d)), d));
    const app = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });

    const files = new Set(fs.readdirSync(folder));
    // Updates: newest 3 kept (16, 20, 30 days); the 40-day one and its -wal go.
    expect(files.has(updates[0]!)).toBe(false);
    expect(files.has(`${updates[0]}-wal`)).toBe(false);
    for (const u of updates.slice(1)) expect(files.has(u), u).toBe(true);
    // Restores: a 5-day-old fourth stays (younger than 14 days).
    for (const r of restores) expect(files.has(r), r).toBe(true);
    // Only 2 upgrades: both stay, however old.
    for (const m of migrates) expect(files.has(m), m).toBe(true);
    expect(app.removed).toEqual([updates[0]]);
    expect(files.has(app.fileName)).toBe(true);
  });

  it("deletes the leftovers of interrupted backups older than a day, and nothing else", async () => {
    const scriptTmp = put(`${scriptBackupName("preupdate", daysAgo(3))}.tmp-1234-1727000000000`, 3);
    const appTmp = put(`${backups.backupFileName(daysAgo(2), "tmpa")}.tmp`, 2);
    const childTmp = put(`${backups.backupFileName(daysAgo(2), "tmpb")}.tmp.tmp-99-1727000000000`, 2);
    const youngTmp = put(`${backups.backupFileName(now, "tmpc")}.tmp`, 0);
    const other = put("my-copy.db.tmp", 30);
    await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });
    const files = new Set(fs.readdirSync(folder));
    expect(files.has(scriptTmp)).toBe(false);
    expect(files.has(appTmp)).toBe(false);
    expect(files.has(childTmp)).toBe(false);
    expect(files.has(youngTmp)).toBe(true);
    expect(files.has(other)).toBe(true);
  });

  it("leaves the app's own backups to their own rule", async () => {
    await setSetting("backups.keep", 2, null);
    const app = [1, 2].map((d) => put(backups.backupFileName(daysAgo(d), `app${d}`), d));
    // Daily backups of this database (with their rows): the keep rule counts them.
    await dbWrite((c) => c.backup.createMany({ data: app.map((fileName) => ({ fileName, sizeBytes: 6, kind: "AUTO" })) }));
    const scripts = [50, 60, 70, 80].map((d) => put(scriptBackupName("prerestore", daysAgo(d)), d));
    const made = await backups.runBackup({ kind: "AUTO", vacuum: fastVacuum });
    const files = new Set(fs.readdirSync(folder));
    // The app keeps 2 daily ones (the new one and the newer old one); the scripts keep 3 of theirs.
    expect(files.has(made.fileName)).toBe(true);
    expect(files.has(app[0]!)).toBe(true);
    expect(files.has(app[1]!)).toBe(false);
    expect(scripts.filter((s) => files.has(s))).toEqual(scripts.slice(0, 3));
    expect(new Set(made.removed)).toEqual(new Set([app[1], scripts[3]]));
  });
});
