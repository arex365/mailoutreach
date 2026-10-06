import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The Milestone 6 step-C contract pieces that touch the database (docs/dev/M6-DESIGN.md §7.1, §7.6–§7.8): the data-only
 * migration, the new setting defaults, `setSettingIn` inside a transaction, and the backups service's re-export of the
 * old-backup threshold.
 */

const t = await createTestDb("m6-contracts");
const { db, dbTx } = await import("@/server/db");
const { getSetting, getSettings, setSettingIn, SETTING_DEFAULTS } = await import("@/server/settings");
const { BACKUP_STALE_MS: SERVICE_BACKUP_STALE_MS } = await import("@/server/services/backups");
const { BACKUP_STALE_MS } = await import("@/core/backups/age");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("migration 20260927120000_m6_go_live", () => {
  const M6 = "20260927120000_m6_go_live";
  const dir = path.resolve("prisma", "migrations");

  it("fills the launch flag with false for campaigns launched before it, and touches nothing else", () => {
    const file = path.resolve("data", "test", `m6-migration-${process.pid}-${Date.now()}.db`);
    const raw = new Database(file);
    try {
      const names = fs
        .readdirSync(dir)
        .filter((n) => fs.existsSync(path.join(dir, n, "migration.sql")))
        .sort();
      expect(names).toContain(M6);
      for (const n of names.filter((x) => x < M6)) raw.exec(fs.readFileSync(path.join(dir, n, "migration.sql"), "utf8"));
      raw.exec(`INSERT INTO "User" ("id", "email", "name", "updatedAt") VALUES (1, 'owner@example.com', 'Arslan', CURRENT_TIMESTAMP);
        INSERT INTO "Campaign" ("id", "name", "status", "mode", "createdById", "launchedAt", "launchedGoLive", "updatedAt") VALUES
          (1, 'Launched before M5', 'RUNNING', 'LIVE', 1, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP),
          (2, 'Launched after go-live', 'RUNNING', 'LIVE', 1, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP),
          (3, 'Launched before go-live', 'FINISHED', 'LIVE', 1, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP),
          (4, 'Draft', 'DRAFT', NULL, 1, NULL, NULL, CURRENT_TIMESTAMP),
          (5, 'Old dry run', 'FINISHED', 'DRY_RUN', 1, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP);`);
      const before = raw.prepare(`SELECT COUNT(*) AS n FROM "Campaign"`).get() as { n: number };

      raw.exec(fs.readFileSync(path.join(dir, M6, "migration.sql"), "utf8"));

      const rows = raw.prepare(`SELECT "id", "launchedGoLive" FROM "Campaign" ORDER BY "id"`).all() as Array<{
        id: number;
        launchedGoLive: number | null;
      }>;
      expect(rows).toEqual([
        { id: 1, launchedGoLive: 0 },
        { id: 2, launchedGoLive: 1 },
        { id: 3, launchedGoLive: 0 },
        { id: 4, launchedGoLive: null },
        { id: 5, launchedGoLive: 0 },
      ]);
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM "Campaign"`).get()).toEqual(before);
    } finally {
      raw.close();
      fs.rmSync(file, { force: true });
    }
  });

  it("is what `prisma migrate deploy` applied to the test database", async () => {
    const applied = await db.$queryRawUnsafe<Array<{ migration_name: string; finished: number }>>(
      `SELECT "migration_name", "finished_at" IS NOT NULL AS "finished" FROM "_prisma_migrations" WHERE "migration_name" = ?`,
      M6,
    );
    expect(applied).toHaveLength(1);
    expect(Number(applied[0]!.finished)).toBe(1);
  });
});

describe("setting defaults (M6-DESIGN §7.1)", () => {
  it("adds when and on which domain go-live happened, and the Access opt-out, all unset", async () => {
    expect(SETTING_DEFAULTS["sending.goLiveAt"]).toBeNull();
    expect(SETTING_DEFAULTS["sending.goLiveDomain"]).toBeNull();
    expect(SETTING_DEFAULTS["remoteAccess.accessOff"]).toBe(false);
    expect(await getSettings(["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "remoteAccess.accessOff"] as const)).toEqual({
      "sending.goLive": false,
      "sending.goLiveAt": null,
      "sending.goLiveDomain": null,
      "remoteAccess.accessOff": false,
    });
  });
});

describe("setSettingIn", () => {
  it("writes several settings in one transaction, with who changed them", async () => {
    const at = "2026-09-27T09:05:00.000Z";
    await dbTx(async (tx) => {
      await setSettingIn(tx, "sending.goLive", true, 7);
      await setSettingIn(tx, "sending.goLiveAt", at, 7);
      await setSettingIn(tx, "sending.goLiveDomain", "send.example.com", 7);
      await setSettingIn(tx, "sending.mode", "LIVE", 7);
    });
    expect(await getSettings(["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "sending.mode"] as const)).toEqual({
      "sending.goLive": true,
      "sending.goLiveAt": at,
      "sending.goLiveDomain": "send.example.com",
      "sending.mode": "LIVE",
    });
    const row = await db.setting.findUnique({ where: { key: "sending.goLiveAt" } });
    expect(row?.updatedById).toBe(7);
  });

  it("overwrites an existing row (null included) and records a change by the app itself", async () => {
    await dbTx((tx) => setSettingIn(tx, "sending.goLiveAt", null, null));
    expect(await getSetting("sending.goLiveAt")).toBeNull();
    expect((await db.setting.findUnique({ where: { key: "sending.goLiveAt" } }))?.updatedById).toBeNull();
  });

  it("commits or rolls back with its transaction", async () => {
    await expect(
      dbTx(async (tx) => {
        await setSettingIn(tx, "remoteAccess.accessOff", true, 7);
        await setSettingIn(tx, "sending.goLiveDomain", "other.example.com", 7);
        throw new Error("Something changed while going live. Check the list again.");
      }),
    ).rejects.toThrow("Something changed");
    expect(await getSetting("remoteAccess.accessOff")).toBe(false);
    expect(await getSetting("sending.goLiveDomain")).toBe("send.example.com");
    expect(await db.setting.findUnique({ where: { key: "remoteAccess.accessOff" } })).toBeNull();
  });
});

describe("old-backup threshold", () => {
  it("is one value: the backups service re-exports the core constant", () => {
    expect(SERVICE_BACKUP_STALE_MS).toBe(BACKUP_STALE_MS);
    expect(BACKUP_STALE_MS).toBe(36 * 60 * 60 * 1000);
  });
});
