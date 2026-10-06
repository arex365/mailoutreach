import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countUsers,
  listMigrationNames,
  migrationStatus,
  pendingMigrationNames,
} from "../../../scripts/lib/migrations.mjs";

describe("pendingMigrationNames", () => {
  it("lists the project's migrations the database hasn't finished", () => {
    expect(pendingMigrationNames(["001_init", "002_more", "003_last"], new Set(["001_init"]))).toEqual(["002_more", "003_last"]);
    expect(pendingMigrationNames(["001_init"], ["001_init"])).toEqual([]);
    expect(pendingMigrationNames([], [])).toEqual([]);
  });
});

describe("listMigrationNames", () => {
  it("finds the real migration folders, oldest first", () => {
    const names = listMigrationNames();
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual(names);
    expect(names.every((n: string) => fs.existsSync(path.join("prisma", "migrations", n, "migration.sql")))).toBe(true);
  });

  it("returns nothing for a missing folder", () => {
    expect(listMigrationNames(path.resolve("data", "test", "no-such-folder"))).toEqual([]);
  });
});

describe("migrationStatus and countUsers", () => {
  let dir = "";
  let migrations = "";

  beforeAll(() => {
    dir = path.resolve("data", "test", `migrations-${process.pid}-${Date.now()}`);
    migrations = path.join(dir, "migrations");
    for (const name of ["20260101000000_init", "20260201000000_more"]) {
      fs.mkdirSync(path.join(migrations, name), { recursive: true });
      fs.writeFileSync(path.join(migrations, name, "migration.sql"), "-- test");
    }
    fs.writeFileSync(path.join(migrations, "migration_lock.toml"), 'provider = "sqlite"');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says 'create it' when the database file doesn't exist", async () => {
    expect(await migrationStatus(path.join(dir, "missing.db"), migrations)).toEqual({ dbExists: false, pending: null });
  });

  it("can't tell (null) when Prisma's migration table is missing", async () => {
    const file = path.join(dir, "plain.db");
    new Database(file).close();
    expect(await migrationStatus(file, migrations)).toEqual({ dbExists: true, pending: null });
  });

  it("lists pending migrations and ignores failed or rolled-back ones", async () => {
    const file = path.join(dir, "partial.db");
    const db = new Database(file);
    db.exec(`CREATE TABLE _prisma_migrations (id TEXT, checksum TEXT, finished_at DATETIME, migration_name TEXT,
             logs TEXT, rolled_back_at DATETIME, started_at DATETIME, applied_steps_count INTEGER);
             INSERT INTO _prisma_migrations (id, migration_name, finished_at) VALUES ('1', '20260101000000_init', '2026-01-01');
             INSERT INTO _prisma_migrations (id, migration_name, finished_at) VALUES ('2', '20260201000000_more', NULL);
             CREATE TABLE "User" (id INTEGER PRIMARY KEY);`);
    db.close();
    expect(await migrationStatus(file, migrations)).toEqual({ dbExists: true, pending: ["20260201000000_more"] });
    expect(await countUsers(file)).toBe(0);

    const db2 = new Database(file);
    db2.exec(`UPDATE _prisma_migrations SET finished_at = '2026-02-01' WHERE id = '2'; INSERT INTO "User" (id) VALUES (1);`);
    db2.close();
    expect(await migrationStatus(file, migrations)).toEqual({ dbExists: true, pending: [] });
    expect(await countUsers(file)).toBe(1);
  });
});
