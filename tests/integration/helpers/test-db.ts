import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Creates a fresh SQLite database for one integration test file and points
 * DATABASE_URL at it. Import server modules (db, services) AFTER calling this.
 * Migrations are applied with `prisma migrate deploy` (the same command the owner's PC runs).
 */
export async function createTestDb(name = "t"): Promise<{ file: string; url: string; cleanup: () => void }> {
  const dir = path.resolve(process.cwd(), "data", "test");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  const url = "file:" + file.replace(/\\/g, "/");
  process.env.DATABASE_URL = url;
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  return {
    file,
    url,
    cleanup: () => {
      // ".instance": the note the background sender keeps next to its database (restore.ts instanceNotePath).
      for (const suffix of ["", "-wal", "-shm", "-journal", ".instance"]) {
        try {
          fs.rmSync(file + suffix, { force: true });
        } catch {
          /* file may still be open on Windows; data/test is ignored anyway */
        }
      }
    },
  };
}
