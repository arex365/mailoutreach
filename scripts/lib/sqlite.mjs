// Small SQLite access for the operations scripts (backups, migration checks, user count).
// Uses better-sqlite3 like the app. If it can't load (for example right after a Node.js
// update, before update.bat reinstalls it), falls back to Node's built-in node:sqlite,
// so backups still work in exactly the situation where they matter most.
import fs from "node:fs";
import path from "node:path";

async function loadBetterSqlite() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default;
  } catch {
    return null;
  }
}

/**
 * Opens an existing database file. Returns { engine, get, all, run, exec, close }.
 * Throws a plain Error when the file is missing.
 */
export async function openDatabase(file, { readonly = false } = {}) {
  if (!fs.existsSync(file)) throw new Error(`The database file ${file} doesn't exist.`);
  const Better = await loadBetterSqlite();
  if (Better) {
    try {
      const db = new Better(file, { readonly, fileMustExist: true, timeout: 10_000 });
      return {
        engine: "better-sqlite3",
        get: (sql, ...params) => db.prepare(sql).get(...params),
        all: (sql, ...params) => db.prepare(sql).all(...params),
        run: (sql, ...params) => db.prepare(sql).run(...params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    } catch (err) {
      // A driver built for another Node.js version fails here, not at import time.
      if (!/NODE_MODULE_VERSION|was compiled against|invalid ELF|not a valid Win32/i.test(String(err))) throw err;
    }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: readonly, timeout: 10_000 });
  return {
    engine: "node:sqlite",
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/** True when the file starts with the SQLite header. */
export function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      return n === 16 && buf.toString("latin1") === "SQLite format 3\u0000";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Writes a consistent copy of the database with VACUUM INTO (safe while the app runs,
 * and it includes everything still waiting in the -wal file). Writes to a temporary
 * name first and renames on success.
 */
export async function vacuumInto(sourceFile, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp-${process.pid}-${Date.now()}`;
  const db = await openDatabase(sourceFile);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    db.close();
  }
  fs.renameSync(tmp, destFile);
  return { engine: db.engine, size: fs.statSync(destFile).size };
}

/** Runs PRAGMA quick_check. Returns "ok" or the first problem SQLite reports. */
export async function quickCheck(file) {
  const db = await openDatabase(file);
  try {
    const row = db.get("PRAGMA quick_check");
    const value = row ? Object.values(row)[0] : "no answer";
    return String(value);
  } finally {
    db.close();
  }
}
