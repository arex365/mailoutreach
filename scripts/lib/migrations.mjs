// Database upgrades ("prisma migrate deploy") and small read-only questions about a database.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATHS, ROOT } from "./paths.mjs";
import { openDatabase } from "./sqlite.mjs";

/** Names of the migration folders that contain a migration.sql, oldest first. */
export function listMigrationNames(dir = PATHS.migrationsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

/** Migrations in the project that the database hasn't finished yet. */
export function pendingMigrationNames(all, applied) {
  const done = applied instanceof Set ? applied : new Set(applied);
  return all.filter((name) => !done.has(name));
}

/** Finished migrations recorded in the database, or null when Prisma's table isn't there. */
export async function readAppliedMigrations(dbFile) {
  const db = await openDatabase(dbFile, { readonly: true });
  try {
    const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'");
    if (!table) return null;
    const rows = db.all(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    return new Set(rows.map((r) => r.migration_name));
  } finally {
    db.close();
  }
}

/**
 * { dbExists, pending } — pending is the list of missing migrations, or null when that
 * can't be told (then migrate deploy should simply run).
 */
export async function migrationStatus(dbFile, migrationsDir = PATHS.migrationsDir) {
  if (!fs.existsSync(dbFile)) return { dbExists: false, pending: null };
  let applied = null;
  try {
    applied = await readAppliedMigrations(dbFile);
  } catch {
    applied = null;
  }
  if (!applied) return { dbExists: true, pending: null };
  return { dbExists: true, pending: pendingMigrationNames(listMigrationNames(migrationsDir), applied) };
}

/** Runs `prisma migrate deploy` for the given DATABASE_URL. Returns { ok, output }. */
export function runMigrateDeploy(databaseUrl, { env = process.env } = {}) {
  const r = spawnSync(process.execPath, [PATHS.prismaCli, "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1", DOTENV_CONFIG_QUIET: "true" },
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim();
  return { ok: r.status === 0, output };
}

/** Number of user accounts (0 on a fresh database). */
export async function countUsers(dbFile) {
  const db = await openDatabase(dbFile, { readonly: true });
  try {
    const row = db.get('SELECT COUNT(*) AS n FROM "User"');
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}
