import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { launchTo, setupM3, type M3World } from "../sending-m3/helpers";
import type { DueStats } from "@/server/services/sending/gates";

/**
 * backupStatus (M6-DESIGN §3.6): the newest app backup and its age (never, stale after 36 hours, ok), the second
 * folder and whether the last copy there failed (only for backups made after the folder was set; never in the practice
 * copy), the background sender, and the disk space (a stand-in statfs). backupQuietNow (§3.5): quiet unless a gated
 * email is due in a zone whose sending window is open; any problem → null. The local fake Mailgun only.
 */

const t = await createTestDb("backups-status");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const backups = await import("@/server/services/backups");

const HOUR = 3_600_000;
const GB = 1024 ** 3;
const folder = backups.backupFolder();
const tempDirs: string[] = [];
const now = new Date("2026-09-23T08:00:00.000Z");
const statfs = (free: number) => async () => ({ bavail: free, bsize: 1 });

/** An app backup file in the backups folder, with its row (unless `row` is false). */
async function appBackup(at: Date, kind: "AUTO" | "MANUAL", opts: { row?: boolean; copiedTo?: string | null } = {}) {
  const fileName = backups.backupFileName(at, backups.randomSuffix());
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, fileName), "backup");
  if (opts.row !== false) {
    await dbWrite((c) => c.backup.create({ data: { fileName, sizeBytes: 6, kind, copiedTo: opts.copiedTo ?? null, createdAt: at } }));
  }
  return fileName;
}

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: ["q1@quiet-berlin.de", "q2@quiet-ny.com"] });
});

beforeEach(async () => {
  fs.rmSync(folder, { recursive: true, force: true });
  await dbWrite(async (c) => {
    await c.backup.deleteMany({});
    await c.workerLease.deleteMany({});
  });
  await setSetting("backups.secondFolder", null, null);
  await setSetting("practice.copy", false, null);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  t.cleanup();
});

describe("backupStatus", () => {
  it("never: no app backup yet (a script backup doesn't count)", async () => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "app-preupdate-2026-09-23_09-00-00.db"), "x");
    const s = await backups.backupStatus(now, { statfs: statfs(100 * GB) });
    expect(s).toMatchObject({ newest: null, age: "never", secondFolder: null, lastCopyFailed: false, workerRunning: false, diskLow: false });
    expect(s.freeBytes).toBe(100 * GB);
    expect(s.dbBytes).toBeGreaterThan(0);
  });

  it("ok within 36 hours, stale after, with the newest app backup's kind", async () => {
    await appBackup(new Date(now.getTime() - 40 * HOUR), "AUTO");
    const manual = await appBackup(new Date(now.getTime() - 35 * HOUR), "MANUAL");
    const ok = await backups.backupStatus(now, { statfs: statfs(100 * GB) });
    expect(ok.age).toBe("ok");
    expect(ok.newest).toEqual({ at: new Date(now.getTime() - 35 * HOUR), kind: "MANUAL", fileName: manual });
    expect((await backups.backupStatus(new Date(now.getTime() + 2 * HOUR), { statfs: statfs(100 * GB) })).age).toBe("stale");
  });

  it("says whether the background sender runs", async () => {
    await dbWrite((c) => c.workerLease.create({ data: { id: 1, workerId: "w", heartbeatAt: new Date(now.getTime() - 10_000), startedAt: now } }));
    expect((await backups.backupStatus(now, { statfs: statfs(100 * GB) })).workerRunning).toBe(true);
    expect((await backups.backupStatus(new Date(now.getTime() + 5 * 60_000), { statfs: statfs(100 * GB) })).workerRunning).toBe(false);
  });

  it("the last copy failed: only for a backup made after the second folder was set, and never in the practice copy", async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-status-"));
    tempDirs.push(second);
    // A backup made before the folder was set: not the folder's fault.
    await appBackup(new Date(Date.now() - HOUR), "AUTO");
    await setSetting("backups.secondFolder", second, null);
    expect(await backups.backupStatus(now, { statfs: statfs(100 * GB) })).toMatchObject({ secondFolder: second, lastCopyFailed: false });
    // After it: a newest backup without a copy has failed; with one it hasn't.
    const later = new Date(Date.now() + HOUR);
    await appBackup(later, "AUTO");
    expect((await backups.backupStatus(now, { statfs: statfs(100 * GB) })).lastCopyFailed).toBe(true);
    await appBackup(new Date(later.getTime() + HOUR), "MANUAL", { copiedTo: second });
    expect((await backups.backupStatus(now, { statfs: statfs(100 * GB) })).lastCopyFailed).toBe(false);
    // A newest file without a row (made after a restored backup) can't tell.
    await appBackup(new Date(later.getTime() + 2 * HOUR), "AUTO", { row: false });
    expect((await backups.backupStatus(now, { statfs: statfs(100 * GB) })).lastCopyFailed).toBe(false);
    // The practice copy never copies, so nothing failed and there is no second folder.
    await appBackup(new Date(later.getTime() + 3 * HOUR), "AUTO");
    await setSetting("practice.copy", true, null);
    expect(await backups.backupStatus(now, { statfs: statfs(100 * GB) })).toMatchObject({ secondFolder: null, lastCopyFailed: false });
  });

  it("the disk is low below 2 GB free, or below three times the database", async () => {
    expect((await backups.backupStatus(now, { statfs: statfs(1.9 * GB) })).diskLow).toBe(true);
    expect((await backups.backupStatus(now, { statfs: statfs(2.1 * GB) })).diskLow).toBe(false);
    const dbBytes = (await backups.backupStatus(now, { statfs: statfs(100 * GB) })).dbBytes;
    // A (pretend) database larger than 2/3 GB needs three times its size.
    expect((await backups.backupStatus(now, { statfs: statfs(2 * GB + 1) })).diskLow).toBe(3 * dbBytes > 2 * GB + 1);
    // Unknown free space is never "low".
    const unknown = await backups.backupStatus(now, {
      statfs: async () => {
        throw new Error("not supported");
      },
    });
    expect(unknown).toMatchObject({ freeBytes: null, diskLow: false });
  });
});

describe("backupQuietNow", () => {
  // Wednesday 23 Sep 2026: 08:00 UTC is 10:00 in Berlin (window 09:00–17:00 open) and 04:00 in New York (closed).
  const berlinDay = new Date("2026-09-23T08:00:00.000Z");
  const berlinNight = new Date("2026-09-23T21:00:00.000Z"); // 23:00 in Berlin, 17:00 in New York (closed: ends at 17:00)
  type Stats = DueStats;
  const stats = (rows: Stats) => async () => rows;

  it("quiet unless a gated email is due in a zone whose window is open", async () => {
    const berlin: Stats = [{ zone: "Europe/Berlin", counted: true, senderId: 1, count: 3 }];
    const ny: Stats = [{ zone: "America/New_York", counted: true, senderId: 1, count: 2 }];
    expect(await backups.backupQuietNow(berlinDay, { loadDueStats: stats(berlin) })).toBe(false);
    expect(await backups.backupQuietNow(berlinDay, { loadDueStats: stats(ny) })).toBe(true);
    expect(await backups.backupQuietNow(berlinNight, { loadDueStats: stats([...berlin, ...ny]) })).toBe(true);
    expect(await backups.backupQuietNow(berlinDay, { loadDueStats: stats([{ ...berlin[0]!, count: 0 }]) })).toBe(true);
    expect(await backups.backupQuietNow(berlinDay, { loadDueStats: stats([]) })).toBe(true);
  });

  it("any problem gives null (the fixed night window decides)", async () => {
    const broken = async () => {
      throw new Error("the database is busy");
    };
    expect(await backups.backupQuietNow(berlinDay, { loadDueStats: broken })).toBeNull();
  });

  it("reads the real due emails and the sending window", async () => {
    await setSettingValue("sending.window", { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
    expect(await backups.backupQuietNow(berlinDay)).toBe(true);
    // A live campaign to a Berlin company launched now: its first email is due while Berlin's window is open.
    await launchTo(world, ["q1@quiet-berlin.de"], { now: berlinDay, timeZone: "Europe/Berlin" });
    expect(await backups.backupQuietNow(berlinDay)).toBe(false);
    // At night in Berlin the same email waits for the window: quiet.
    expect(await backups.backupQuietNow(berlinNight)).toBe(true);
  });
});
