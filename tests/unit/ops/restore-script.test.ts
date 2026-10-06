/**
 * Runs the real restore script against temporary databases under data/test/ (never data/app.db).
 * With --db pointing at another file it doesn't stop or start the app. The safety checks of M6-DESIGN §3.7 run in this
 * process too, with stand-ins for everything that would touch the PC.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseUrlFor } from "../../../scripts/lib/env-file.mjs";
import { runMigrateDeploy } from "../../../scripts/lib/migrations.mjs";
import * as restore from "../../../scripts/restore.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `restore-${process.pid}-${Date.now()}`);
const current = path.join(dir, "current.db");
const backupsDir = path.join(dir, "backups");
const backupFile = path.join(backupsDir, "app-auto-2026-09-20_10-00-00.db");

function makeDb(file: string, companyName: string) {
  const r = runMigrateDeploy(databaseUrlFor(file, ROOT));
  if (!r.ok) throw new Error(r.output);
  const db = new Database(file);
  db.prepare("INSERT INTO Company (name, nameNorm, updatedAt) VALUES (?, ?, ?)").run(companyName, companyName.toLowerCase(), Date.now());
  db.close();
}

function companies(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM Company ORDER BY id").all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

/** A path as restore.mjs shows it: project-relative with backslashes. */
function shown(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("\\");
}
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runRestore(args: string[], input = "") {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "restore.mjs"), ...args, "--db", current, "--backups-dir", backupsDir], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    input,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

beforeAll(() => {
  fs.mkdirSync(backupsDir, { recursive: true });
  makeDb(current, "Current company");
  makeDb(backupFile, "Backup company");
  // The file itself is newer than its name says, so the name's time is the earlier one.
  const later = new Date(2026, 8, 21, 12, 0, 0);
  fs.utimesSync(backupFile, later, later);
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("restore.mjs end to end (temporary files)", () => {
  it("cancels without changing anything unless you type yes", () => {
    const r = runRestore([backupFile], "\n");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Cancelled. Nothing was changed.");
    expect(companies(current)).toEqual(["Current company"]);
  });

  it("saves the current data, puts the backup in place and writes the restore marker", () => {
    const r = runRestore([backupFile, "--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Restored your data from 20 Sep 2026, 10:00");
    // Milestone 3: sending stays paused until the Owner has read the restore report and clicked Resume.
    expect(r.out).toMatch(/\|\s+Sending stays paused until you've read the restore report/);
    expect(r.out).toContain("in Settings › Sending & Mailgun and clicked Resume,");
    expect(r.out).not.toContain("From Milestone 3 on");
    expect(r.out).toContain("wasn't stopped or started");
    // Which database is overwritten, and an undo command for that database (restore.bat alone would restore into the
    // app's own database; review SECURITY-02).
    expect(r.out).toContain(`Into:   ${shown(current)} (not the app's own database)`);
    expect(r.out).toMatch(
      new RegExp(`To undo this restore, run: {2}node scripts\\\\restore\\.mjs \\S*app-prerestore-\\S+\\.db --db ${escape(shown(current))} --backups-dir ${escape(shown(backupsDir))}`),
    );

    expect(companies(current)).toEqual(["Backup company"]);

    const saved = fs.readdirSync(backupsDir).filter((n) => n.startsWith("app-prerestore-"));
    expect(saved).toHaveLength(1);
    expect(companies(path.join(backupsDir, saved[0]!))).toEqual(["Current company"]);

    const marker = JSON.parse(fs.readFileSync(path.join(dir, "RESTORED"), "utf8"));
    // Version 3: the background sender acts on it (an unversioned M1/M2 marker is only renamed). `db` names the
    // restored database, so the practice copy's worker (same folder) leaves the marker for the real one.
    expect(marker.version).toBe(3);
    expect(marker.db).toBe("current.db");
    expect(marker.restoredFrom).toBe(new Date(2026, 8, 20, 10, 0, 0).toISOString());
    expect(marker.file).toBe(path.basename(backupFile));
    expect(Number.isNaN(Date.parse(marker.at))).toBe(false);
  });

  it("finds a backup by its name in the backups folder", () => {
    const r = runRestore([path.basename(backupFile)], "\n");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("From:   20 Sep 2026, 10:00");
  });

  it("refuses a damaged backup before anything is stopped or changed", () => {
    const damaged = path.join(backupsDir, "app-manual-2026-09-22_08-00-00.db");
    const bytes = Buffer.alloc(8192, 0x5a);
    bytes.write("SQLite format 3\u0000", 0, "latin1");
    fs.writeFileSync(damaged, bytes);
    const before = companies(current);
    const savedBefore = fs.readdirSync(backupsDir).filter((n) => n.startsWith("app-prerestore-")).length;
    // The marker of the restore before this one (not yet read by the background sender) must survive.
    const markerBefore = fs.readFileSync(path.join(dir, "RESTORED"), "utf8");
    const r = runRestore([damaged, "--yes"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("The backup is damaged (SQLite says:");
    expect(r.out).toContain("Nothing was changed.");
    expect(fs.readdirSync(backupsDir).filter((n) => n.startsWith("app-prerestore-"))).toHaveLength(savedBefore);
    expect(companies(current)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "RESTORED"), "utf8")).toBe(markerBefore);
    // Without an earlier marker, a damaged backup leaves none.
    fs.rmSync(path.join(dir, "RESTORED"));
    expect(runRestore([damaged, "--yes"]).status).toBe(1);
    expect(fs.existsSync(path.join(dir, "RESTORED"))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("RESTORED"))).toEqual([]);
    expect(companies(current)).toEqual(before);
  });

  it("says clearly when the restored data can't be upgraded: the backup is in place, the marker written, the undo file named", { timeout: 120_000 }, () => {
    // A backup whose upgrade history is broken: prisma migrate deploy tries to create the tables
    // again and fails.
    const broken = path.join(backupsDir, "app-auto-2026-09-21_09-00-00.db");
    makeDb(broken, "Broken backup company");
    const db = new Database(broken);
    db.prepare("DELETE FROM _prisma_migrations WHERE migration_name = (SELECT MIN(migration_name) FROM _prisma_migrations)").run();
    db.close();
    fs.rmSync(path.join(dir, "RESTORED"), { force: true });
    const savedBefore = new Set(fs.readdirSync(backupsDir).filter((n) => n.startsWith("app-prerestore-")));

    const r = runRestore([broken, "--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("is in place");
    expect(r.out).toContain("upgrading it to this version's database failed");
    // The data now is the backup's, and the restore marker says so (PLAN.md B6.7 order).
    expect(companies(current)).toEqual(["Broken backup company"]);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, "RESTORED"), "utf8"));
    expect(marker.file).toBe(path.basename(broken));
    // The file with the data from just before the restore is named, with the command to undo it.
    const saved = fs.readdirSync(backupsDir).filter((n) => n.startsWith("app-prerestore-") && !savedBefore.has(n));
    expect(saved).toHaveLength(1);
    expect(r.out).toContain(`To undo this restore, run:  node scripts\\restore.mjs`);
    expect(r.out).toContain(saved[0]!);
  });

  it("refuses files that aren't SQLite databases", () => {
    const text = path.join(backupsDir, "notes.db");
    fs.writeFileSync(text, "just some text");
    const r = runRestore([text, "--yes"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("isn't a database backup");
  });

  it("explains when the backup can't be found", () => {
    const r = runRestore(["no-such-backup.db", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Can't find the backup");
  });
});

/**
 * restore.bat's safety (M6-DESIGN §3.7), in this process with stand-ins for everything that touches the PC: the
 * answers typed, the services and administrator checks, stopping and starting the app, the database upgrade, the
 * "Before a restore" backup, the free space and the copy. The "app's database" here is a temporary file named as such
 * through the stand-in .env values: nothing ever stops, starts or opens the real app.
 */
describe("restore.mjs safety (in this process, with stand-ins)", () => {
  type Deps = NonNullable<Parameters<typeof restore.runRestore>[2]>;
  const sdir = path.join(ROOT, "data", "test", `restore-safety-${process.pid}-${Date.now()}`);
  const template = path.join(sdir, "template.db");
  const target = path.join(sdir, "data", "app-copy.db");
  const sbackups = path.join(sdir, "backups");
  let n = 0;

  /** A copy of a migrated database with one company and, optionally, settings, an installation id and extra rows. */
  function makeCopy(file: string, company: string, extra: { practice?: boolean; instanceId?: string; migration?: string; backupRows?: Array<[string, string]> } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    fs.copyFileSync(template, file);
    const db = new Database(file);
    try {
      db.prepare("INSERT INTO Company (name, nameNorm, updatedAt) VALUES (?, ?, ?)").run(company, company.toLowerCase(), Date.now());
      if (extra.practice !== undefined) {
        db.prepare(`INSERT INTO "Setting" (key, value, updatedAt) VALUES ('practice.copy', ?, ?)`).run(JSON.stringify(extra.practice), Date.now());
      }
      if (extra.instanceId) {
        db.prepare(`INSERT INTO "SystemState" (key, value, version, updatedAt) VALUES ('instance', ?, 1, ?)`).run(
          JSON.stringify({ dbPath: "c:/x/app.db", id: extra.instanceId, firstSeenAt: "2026-09-01T00:00:00.000Z" }),
          Date.now(),
        );
      }
      if (extra.migration) {
        db.prepare(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, 'x', ?, ?, ?, 1)`,
        ).run(`m-${++n}`, Date.now(), extra.migration, Date.now());
      }
      for (const [fileName, kind] of extra.backupRows ?? []) {
        db.prepare(`INSERT INTO "Backup" (fileName, createdAt, sizeBytes, kind) VALUES (?, ?, 1, ?)`).run(fileName, Date.now(), kind);
      }
    } finally {
      db.close();
    }
    return file;
  }

  const appEnv = () => ({ DATABASE_URL: databaseUrlFor(target, ROOT) });
  const noStop = () => {
    throw new Error("stopApp must not be called");
  };
  /** Everything that would touch the PC, replaced; each test overrides what it is about. */
  function standIns(overrides: Partial<Deps> & { answers?: string[] } = {}) {
    const calls = { stop: 0, start: 0, services: 0 };
    const answers = [...(overrides.answers ?? [])];
    const deps: Deps = {
      root: ROOT,
      env: {},
      ask: async () => answers.shift() ?? "",
      servicesInstalled: () => (calls.services++, false),
      isElevated: () => true,
      stopApp: (async () => (calls.stop++, { ok: true, services: false, wasRunning: true, message: "The app is stopped." })) as Deps["stopApp"],
      startApp: (async () => (calls.start++, { ok: true, message: "started" })) as Deps["startApp"],
      startBlocker: () => null,
      waitForHealth: (async () => ({ ok: true })) as unknown as Deps["waitForHealth"],
      ensureMigrated: (async () => ({ ok: true, changed: false, backupFile: null })) as Deps["ensureMigrated"],
      freeBytes: async () => null,
      ...overrides,
    };
    return { deps, calls };
  }

  async function run(values: { yes?: boolean; db?: string }, positionals: string[], deps: Deps) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      await restore.runRestore({ "backups-dir": sbackups, ...values }, positionals, deps);
      return { error: null as string | null, out: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), out: lines.join("\n") };
    } finally {
      spy.mockRestore();
    }
  }

  const marker = () => path.join(path.dirname(target), "RESTORED");
  const prerestores = () => (fs.existsSync(sbackups) ? fs.readdirSync(sbackups).filter((f) => f.startsWith("app-prerestore-")) : []);

  beforeAll(() => {
    fs.mkdirSync(sbackups, { recursive: true });
    const r = runMigrateDeploy(databaseUrlFor(template, ROOT));
    if (!r.ok) throw new Error(r.output);
  }, 60_000);

  beforeEach(() => {
    fs.rmSync(marker(), { force: true });
    for (const f of prerestores()) fs.rmSync(path.join(sbackups, f), { force: true });
    makeCopy(target, "Current company", { practice: false, instanceId: "this-install" });
  });

  afterAll(() => {
    fs.rmSync(sdir, { recursive: true, force: true });
  });

  it("labels the list in the app's words: kinds of app backups from the Backup rows, script backups by name", async () => {
    const daily = "app-2026-09-25-221405-aaaa.db";
    const manual = "app-2026-09-26-101500-bbbb.db";
    const noRow = "app-2026-09-26-231500-cccc.db";
    makeCopy(target, "Current company", { backupRows: [[daily, "AUTO"], [manual, "MANUAL"]] });
    for (const name of [daily, manual, noRow, "app-preupdate-2026-09-24_09-00-00.db", "app-premigrate-2026-09-23_09-00-00.db"]) {
      makeCopy(path.join(sbackups, name), "Old company");
    }
    const { deps } = standIns({ answers: [""] });
    const r = await run({ db: target }, [], deps);
    expect(r.error).toBeNull();
    const line = (name: string) => r.out.split("\n").find((l) => l.includes(`(${name},`)) ?? "";
    expect(line(daily)).toMatch(/ {2}Daily backup {2}\(/);
    expect(line(manual)).toMatch(/ {2}Back up now {2}\(/);
    expect(line(noRow)).toMatch(/ {2}Backup {2}\(/);
    expect(line("app-preupdate-2026-09-24_09-00-00.db")).toMatch(/ {2}Before an update {2}\(/);
    expect(line("app-premigrate-2026-09-23_09-00-00.db")).toMatch(/ {2}Before a database upgrade {2}\(/);
    expect(r.out).toContain("Cancelled. Nothing was changed.");
    for (const name of [daily, manual, noRow, "app-preupdate-2026-09-24_09-00-00.db", "app-premigrate-2026-09-23_09-00-00.db"]) {
      fs.rmSync(path.join(sbackups, name));
    }
  });

  it("needs administrator rights only for the app's own database", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-20_10-00-00.db"), "Backup company", { practice: false, instanceId: "this-install" });
    // A test copy with the services installed: no elevation needed, and the services aren't even asked about.
    const test = standIns({ servicesInstalled: () => true, isElevated: () => false, stopApp: noStop as unknown as Deps["stopApp"] });
    const ok = await run({ yes: true, db: target }, [backup], test.deps);
    expect(ok.error).toBeNull();
    expect(companies(target)).toEqual(["Backup company"]);
    expect(ok.out).toContain("That isn't the app's own database, so the app wasn't stopped or started.");

    // The app's own database with the services installed and no elevation: refused before anything happens.
    makeCopy(target, "Current company", { practice: false, instanceId: "this-install" });
    const app = standIns({ env: appEnv(), servicesInstalled: () => true, isElevated: () => false, stopApp: noStop as unknown as Deps["stopApp"] });
    const refused = await run({ yes: true }, [backup], app.deps);
    expect(refused.error).toBe(restore.RESTORE_TEXTS.needsAdmin);
    expect(companies(target)).toEqual(["Current company"]);
  });

  it("refuses a backup made by a newer version of the app, before anything is stopped", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-21_10-00-00.db"), "Future company", { practice: false, migration: "29990101000000_from_the_future" });
    const { deps, calls } = standIns({ env: appEnv() });
    const r = await run({ yes: true }, [backup], deps);
    expect(r.error).toBe("This backup was made by a newer version of the app. Update the app first, then restore it.");
    expect(calls.stop).toBe(0);
    expect(companies(target)).toEqual(["Current company"]);
    expect(prerestores()).toEqual([]);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("refuses the practice copy's backup for the real app (and the other way round)", async () => {
    const practice = makeCopy(path.join(sbackups, "app-auto-2026-09-22_10-00-00.db"), "Made-up company", { practice: true });
    const r = await run({ yes: true, db: target }, [practice], standIns().deps);
    expect(r.error).toBe("This backup belongs to the practice copy, not the real app (or the other way round). Pick another backup.");
    expect(companies(target)).toEqual(["Current company"]);
    makeCopy(target, "Made-up current", { practice: true });
    const real = makeCopy(path.join(sbackups, "app-auto-2026-09-22_11-00-00.db"), "Real company", { practice: false });
    expect((await run({ yes: true, db: target }, [real], standIns().deps)).error).toBe(restore.RESTORE_TEXTS.practiceMismatch);
  });

  it("asks a second yes for a backup of another database (moving to a new PC); --yes answers both", async () => {
    const other = makeCopy(path.join(sbackups, "app-auto-2026-09-23_10-00-00.db"), "Other PC company", { practice: false, instanceId: "old-pc-install" });
    const cancelled = await run({ db: target }, [other], standIns({ answers: ["yes", ""] }).deps);
    expect(cancelled.error).toBeNull();
    expect(cancelled.out).toContain("Cancelled. Nothing was changed.");
    expect(companies(target)).toEqual(["Current company"]);

    const confirmed = await run({ db: target }, [other], standIns({ answers: ["yes", "yes"] }).deps);
    expect(confirmed.error).toBeNull();
    expect(companies(target)).toEqual(["Other PC company"]);

    makeCopy(target, "Current company", { practice: false, instanceId: "this-install" });
    const withYes = await run({ yes: true, db: target }, [other], standIns().deps);
    expect(withYes.error).toBeNull();
    expect(withYes.out).toContain("This backup comes from another database (expected when moving to a new PC).");
    expect(companies(target)).toEqual(["Other PC company"]);
  });

  it("refuses when there isn't enough free disk space, before anything is stopped", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-24_10-00-00.db"), "Backup company", { practice: false, instanceId: "this-install" });
    const { deps, calls } = standIns({ env: appEnv(), freeBytes: async () => 1000 });
    const r = await run({ yes: true }, [backup], deps);
    expect(r.error).toMatch(/^There isn't enough free disk space for a safe restore: about [\d.]+ (KB|MB) is needed and 1000 bytes is free\. Nothing was changed\.$/);
    expect(calls.stop).toBe(0);
    expect(companies(target)).toEqual(["Current company"]);
    expect(restore.sizeText(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(restore.sizeText(0.9 * 1024 ** 3)).toBe("0.9 GB");
  });

  it("when the current data can't be saved first: nothing changes and the app starts again", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-25_10-00-00.db"), "Backup company", { practice: false, instanceId: "this-install" });
    const { deps, calls } = standIns({
      env: appEnv(),
      makeBackup: async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    });
    const r = await run({ yes: true }, [backup], deps);
    expect(r.error).toBe("Couldn't save your current data first (the disk is full), so nothing was changed. The app was started again.");
    expect(calls).toMatchObject({ stop: 1, start: 1 });
    expect(companies(target)).toEqual(["Current company"]);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("when the backup vanishes during the copy: the database is untouched, the marker put back, the app started again", async () => {
    const stick = makeCopy(path.join(sdir, "stick", "app-auto-2026-09-26_10-00-00.db"), "Stick company", { practice: false, instanceId: "this-install" });
    const { deps, calls } = standIns({
      env: appEnv(),
      copyFile: (from: string, to: string) => {
        if (path.resolve(from) === path.resolve(stick)) throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${from}'`), { code: "ENOENT" });
        fs.copyFileSync(from, to);
      },
    });
    const r = await run({ yes: true }, [stick], deps);
    expect(r.error).toBe(
      "Couldn't put the backup in place (the backup file can't be read any more: is its drive still plugged in?). Your data is as it was before, and nothing else changed. The app was started again.",
    );
    expect(calls).toMatchObject({ stop: 1, start: 1 });
    expect(companies(target)).toEqual(["Current company"]);
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes(".restore-"))).toEqual([]);
    // The current data was saved before (the undo backup exists).
    expect(prerestores()).toHaveLength(1);
  });

  it("restores the app's own database end to end: stopped, saved, swapped, marker written, started again", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-26_12-00-00.db"), "Backup company", { practice: false, instanceId: "this-install" });
    const { deps, calls } = standIns({ env: appEnv() });
    const r = await run({ yes: true }, [backup], deps);
    expect(r.error).toBeNull();
    expect(calls).toMatchObject({ stop: 1, start: 1 });
    expect(companies(target)).toEqual(["Backup company"]);
    expect(JSON.parse(fs.readFileSync(marker(), "utf8"))).toMatchObject({ version: 3, db: "app-copy.db", file: path.basename(backup) });
    expect(prerestores()).toHaveLength(1);
    expect(companies(path.join(sbackups, prerestores()[0]!))).toEqual(["Current company"]);
    expect(r.out).toContain("Kind:   Daily backup");
    expect(r.out).toContain(`Into:   ${shown(target)}\n`);
    expect(r.out).toContain(`To undo this restore, run:  restore.bat ${shown(path.join(sbackups, prerestores()[0]!))}`);
    expect(r.out).toContain("in Settings › Sending & Mailgun and clicked Resume,");
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes(".restore-"))).toEqual([]);
  });

  /** runRestore with only the options given (no --backups-dir), its console output collected. */
  async function runPlain(values: { yes?: boolean; db?: string }, positionals: string[], deps: Deps) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      await restore.runRestore(values, positionals, deps);
      return { error: null as string | null, out: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), out: lines.join("\n") };
    } finally {
      spy.mockRestore();
    }
  }

  it("another database's backups default to backups\\<its name>\\, never the real app's folder (review BACKUPS-10)", async () => {
    // A root of its own (under data\test), so nothing near the real backups folder is touched.
    const root = path.join(sdir, "root");
    const other = makeCopy(path.join(root, "data", "m6-live.db"), "Current company", { practice: false, instanceId: "this-install" });
    const own = path.join(root, "backups", "m6-live");
    const name = "app-2026-09-26-101500-dddd.db";
    const backup = makeCopy(path.join(own, name), "Backup company", { practice: false, instanceId: "this-install" });
    // This root has no prisma\migrations to compare the backup's upgrades with: leave its history out.
    const b = new Database(backup);
    b.exec(`DROP TABLE "_prisma_migrations"`);
    b.close();

    const r = await runPlain({ yes: true, db: other }, [name], standIns({ root }).deps);
    expect(r.error).toBeNull();
    expect(companies(other)).toEqual(["Backup company"]);
    const saved = fs.readdirSync(own).filter((f) => f.startsWith("app-prerestore-"));
    expect(saved).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, "backups")).filter((f) => f.startsWith("app-prerestore-"))).toEqual([]);
    expect(r.out).toContain(`--db ${shown(other)} --backups-dir ${shown(own)}`);
  });

  it("the marker lists the sending domains of the data being replaced; null when that data can't be read (review BACKUPS-7)", async () => {
    const backup = makeCopy(path.join(sbackups, "app-auto-2026-09-27_08-00-00.db"), "Backup company", { practice: false, instanceId: "this-install" });
    const day = 86_400_000;
    const current = new Database(target);
    try {
      const put = current.prepare(`INSERT INTO "Setting" (key, value, updatedAt) VALUES (?, ?, ?)`);
      put.run("mailgun.domain", JSON.stringify("MG.Current.example"), Date.now());
      put.run("mailgun.region", JSON.stringify("US"), Date.now());
      const domain = current.prepare(`INSERT INTO "SendingDomain" (name, region, active, lastLiveSendAt, createdAt) VALUES (?, ?, ?, ?, ?)`);
      domain.run("mg.current.example", "US", 1, null, Date.now()); // the same one again
      domain.run("mg.recent.example", "EU", 0, Date.now() - 10 * day, Date.now()); // sent live 10 days ago
      domain.run("mg.stale.example", "EU", 0, Date.now() - 100 * day, Date.now()); // not for 100 days
      domain.run("mg.never.example", "EU", 0, null, Date.now()); // never sent live
    } finally {
      current.close();
    }
    const ok = await run({ yes: true, db: target }, [backup], standIns().deps);
    expect(ok.error).toBeNull();
    expect(JSON.parse(fs.readFileSync(marker(), "utf8")).domainsBefore).toEqual([
      { name: "mg.current.example", region: "US" },
      { name: "mg.recent.example", region: "EU" },
    ]);

    // Data that SQLite can't read: the domains are unknown (the background sender's check then asks the Owner).
    fs.rmSync(marker(), { force: true });
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });
    fs.writeFileSync(target, "not a database any more");
    const damaged = await run({ yes: true, db: target }, [backup], standIns().deps);
    expect(damaged.error).toBeNull();
    expect(companies(target)).toEqual(["Backup company"]);
    expect(JSON.parse(fs.readFileSync(marker(), "utf8")).domainsBefore).toBeNull();
  });
});

describe("undoCommand (review SECURITY-02)", () => {
  it("repeats --db and --backups-dir for another database; restore.bat for the app's own", () => {
    const saved = path.join(ROOT, "backups", "m6 live", "app-prerestore-2026-09-27_10-00-00.db");
    expect(restore.undoCommand({ saved, dbFile: path.join(ROOT, "data", "app.db"), backupsDir: path.join(ROOT, "backups"), isAppDatabase: true })).toBe(
      'To undo this restore, run:  restore.bat "backups\\m6 live\\app-prerestore-2026-09-27_10-00-00.db"',
    );
    expect(
      restore.undoCommand({
        saved,
        dbFile: path.join(ROOT, "data", "manual-check", "m6-live.db"),
        backupsDir: path.join(ROOT, "backups", "m6 live"),
        isAppDatabase: false,
      }),
    ).toBe(
      'To undo this restore, run:  node scripts\\restore.mjs "backups\\m6 live\\app-prerestore-2026-09-27_10-00-00.db" --db data\\manual-check\\m6-live.db --backups-dir "backups\\m6 live"',
    );
  });
});

describe("makePutInPlace", () => {
  const pdir = path.join(ROOT, "data", "test", `put-in-place-${process.pid}-${Date.now()}`);
  afterAll(() => fs.rmSync(pdir, { recursive: true, force: true }));

  it("folds a -wal companion into the copy and never pairs the old -wal with the new data", async () => {
    fs.mkdirSync(pdir, { recursive: true });
    const source = path.join(pdir, "raw-copy.db");
    const dbFile = path.join(pdir, "app.db");
    // A raw copy of a database in WAL mode whose last change is still only in its -wal (as makeBackup's fallback leaves).
    const live = new Database(path.join(pdir, "live.db"));
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.exec("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('in the file');");
    live.pragma("wal_checkpoint(TRUNCATE)");
    live.exec("INSERT INTO t VALUES ('only in the wal');");
    fs.copyFileSync(path.join(pdir, "live.db"), source);
    fs.copyFileSync(path.join(pdir, "live.db-wal"), `${source}-wal`);
    live.close();
    // The database being replaced has a -wal of its own.
    const old = new Database(dbFile);
    old.exec("CREATE TABLE other (x); INSERT INTO other VALUES (1);");
    old.close();
    fs.writeFileSync(`${dbFile}-wal`, "an old wal that must not be paired with the backup");

    await restore.makePutInPlace(dbFile)(source);
    const placed = new Database(dbFile, { readonly: true });
    expect((placed.prepare("SELECT name FROM t ORDER BY rowid").all() as { name: string }[]).map((r) => r.name)).toEqual(["in the file", "only in the wal"]);
    placed.close();
    expect(fs.readdirSync(pdir).filter((f) => f.includes(".restore-"))).toEqual([]);
  });

  it("a damaged copy is refused before the database is touched", async () => {
    const dbFile = path.join(pdir, "keep.db");
    const keep = new Database(dbFile);
    keep.exec("CREATE TABLE k (x); INSERT INTO k VALUES ('kept');");
    keep.close();
    const source = path.join(pdir, "damaged.db");
    fs.copyFileSync(dbFile, source);
    await expect(restore.makePutInPlace(dbFile, { check: async () => "*** in database main ***" })(source)).rejects.toMatchObject({
      check: "*** in database main ***",
    });
    const still = new Database(dbFile, { readonly: true });
    expect(still.prepare("SELECT x FROM k").get()).toEqual({ x: "kept" });
    still.close();
    expect(fs.readdirSync(pdir).filter((f) => f.includes(".restore-"))).toEqual([]);
  });
});
