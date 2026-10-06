/**
 * scripts/lib/restore-marker.mjs (CRASH-1): restore.bat writes data\RESTORED BEFORE the backup's data replaces the
 * database, so a closed window or a power cut at any later point still leaves the marker for the background sender.
 * Temporary files only (never data/app.db).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESTORE_MARKER_VERSION,
  putBackMarker,
  readMarkerBytes,
  restoreMarkerFile,
  restoreMarkerText,
  swapInBackup,
  writeFileAtomic,
} from "../../../scripts/lib/restore-marker.mjs";

let dir: string;
let dbFile: string;
let backupFile: string;
let savedFile: string;
let marker: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-restore-marker-"));
  dbFile = path.join(dir, "data", "app.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  backupFile = path.join(dir, "backups", "app-auto-2026-09-20_10-00-00.db");
  savedFile = path.join(dir, "backups", "app-prerestore-2026-09-23_10-00-00.db");
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(dbFile, "current data");
  fs.writeFileSync(backupFile, "backup data");
  fs.writeFileSync(savedFile, "current data");
  marker = restoreMarkerFile(dbFile);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const copy = (source: string) => fs.copyFileSync(source, dbFile);
const restoredFrom = new Date("2026-09-20T08:00:00.000Z");
const now = new Date("2026-09-23T10:00:00.000Z");

describe("restore marker file", () => {
  it("names the restored database and the backup, version 3", () => {
    expect(marker).toBe(path.join(dir, "data", "RESTORED"));
    const m = JSON.parse(restoreMarkerText(dbFile, { restoredFrom, backupName: "app-auto.db", at: now }));
    expect(m).toEqual({ version: RESTORE_MARKER_VERSION, restoredFrom: restoredFrom.toISOString(), at: now.toISOString(), file: "app-auto.db", db: "app.db" });
    expect(RESTORE_MARKER_VERSION).toBe(3);
  });

  it("lists the replaced database's sending domains when given, null when they couldn't be read (review BACKUPS-7)", async () => {
    const domains = [{ name: "mg.newer.example", region: "US" }];
    expect(JSON.parse(restoreMarkerText(dbFile, { restoredFrom, backupName: "b.db", at: now, domainsBefore: domains })).domainsBefore).toEqual(domains);
    expect(JSON.parse(restoreMarkerText(dbFile, { restoredFrom, backupName: "b.db", at: now, domainsBefore: null })).domainsBefore).toBeNull();
    expect("domainsBefore" in JSON.parse(restoreMarkerText(dbFile, { restoredFrom, backupName: "b.db", at: now }))).toBe(false);
    // swapInBackup passes them on.
    const res = await swapInBackup({ dbFile, backupFile, savedFile, restoredFrom, putInPlace: copy, check: async () => "ok", now, domainsBefore: domains });
    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).domainsBefore).toEqual(domains);
  });

  it("writes through a temporary name and leaves no temporary file behind", () => {
    writeFileAtomic(marker, "first");
    writeFileAtomic(marker, "second");
    expect(fs.readFileSync(marker, "utf8")).toBe("second");
    expect(fs.readdirSync(path.dirname(marker)).sort()).toEqual(["RESTORED", "app.db"]);
    expect(readMarkerBytes(path.join(dir, "nothing-here"))).toBeNull();
    putBackMarker(marker, Buffer.from("earlier"));
    expect(fs.readFileSync(marker, "utf8")).toBe("earlier");
    putBackMarker(marker, null);
    expect(fs.existsSync(marker)).toBe(false);
    // A rename that fails (a folder in the way) removes the temporary file and reports the error.
    fs.mkdirSync(path.join(marker, "busy"), { recursive: true });
    expect(() => writeFileAtomic(marker, "third")).toThrow();
    expect(fs.readdirSync(path.dirname(marker)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("swapInBackup: the marker goes in before the data changes", () => {
  it("the marker is already there when the backup is copied over the database and while SQLite checks it", async () => {
    const seen: Array<{ step: string; marker: boolean; data: string }> = [];
    const putInPlace = (source: string) => {
      seen.push({ step: "copy", marker: fs.existsSync(marker), data: fs.readFileSync(dbFile, "utf8") });
      copy(source);
    };
    const check = async (file: string) => {
      seen.push({ step: "check", marker: fs.existsSync(marker), data: fs.readFileSync(file, "utf8") });
      return "ok";
    };
    const res = await swapInBackup({ dbFile, backupFile, savedFile, restoredFrom, putInPlace, check, now });
    expect(res).toMatchObject({ ok: true, markerFile: marker });
    expect(seen).toEqual([
      { step: "copy", marker: true, data: "current data" },
      { step: "check", marker: true, data: "backup data" },
    ]);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ version: 3, file: path.basename(backupFile), db: "app.db", at: now.toISOString() });
  });

  it("a crash during the copy or the check (the window closed, a power cut) still leaves a readable marker", async () => {
    // The process dies inside the copy: nothing after it runs (the copy never finishes).
    let copying = false;
    void swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: () => {
        copying = true;
        return new Promise<void>(() => undefined);
      },
      check: async () => "ok",
      now,
    });
    await expect.poll(() => copying).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).version).toBe(3);

    // The process dies while SQLite checks the copied backup: the check never answers.
    fs.rmSync(marker);
    let checking = false;
    const neverAnswers = () => {
      checking = true;
      return new Promise<string>(() => undefined);
    };
    void swapInBackup({ dbFile, backupFile, savedFile, restoredFrom, putInPlace: copy, check: neverAnswers, now });
    await expect.poll(() => checking).toBe(true);
    expect(fs.readFileSync(dbFile, "utf8")).toBe("backup data");
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ version: 3, db: "app.db" });
  });

  it("a damaged backup puts the saved data back and removes the marker again", async () => {
    const res = await swapInBackup({ dbFile, backupFile, savedFile, restoredFrom, putInPlace: copy, check: async () => "*** in database main ***", now });
    expect(res).toMatchObject({ ok: false, stage: "check", check: "*** in database main ***", markerPutBack: true });
    expect(fs.readFileSync(dbFile, "utf8")).toBe("current data");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a damaged backup keeps the marker of an earlier restore the background sender hasn't read yet", async () => {
    fs.writeFileSync(marker, '{"version":3,"file":"earlier.db","db":"app.db"}');
    const res = await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: copy,
      check: async () => {
        throw new Error("file is not a database");
      },
      now,
    });
    expect(res).toMatchObject({ ok: false, stage: "check", check: "file is not a database" });
    expect(fs.readFileSync(marker, "utf8")).toBe('{"version":3,"file":"earlier.db","db":"app.db"}');
    expect(fs.readFileSync(dbFile, "utf8")).toBe("current data");
  });

  it("the backup can't be copied into place (an unplugged stick, EBUSY, ENOSPC): the database is untouched and the marker goes back", async () => {
    const res = await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, copyfile 'E:\\backup.db'"), { code: "ENOENT" });
      },
      check: async () => "ok",
      now,
    });
    expect(res).toMatchObject({ ok: false, stage: "copy", code: "ENOENT", markerPutBack: true });
    expect(res.error).toContain("ENOENT");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(dbFile, "utf8")).toBe("current data");

    // An earlier marker the background sender hasn't read yet comes back as it was.
    fs.writeFileSync(marker, '{"version":3,"file":"earlier.db","db":"app.db"}');
    await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: async () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })),
      check: async () => "ok",
      now,
    });
    expect(fs.readFileSync(marker, "utf8")).toBe('{"version":3,"file":"earlier.db","db":"app.db"}');
  });

  it("a copy that SQLite finds damaged before it is put in place: stage check, nothing changed, marker back", async () => {
    let checkedAfter = false;
    const res = await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: async () => Promise.reject(Object.assign(new Error("SQLite says: malformed"), { check: "*** in database main ***" })),
      check: async () => {
        checkedAfter = true;
        return "ok";
      },
      now,
    });
    expect(res).toMatchObject({ ok: false, stage: "check", check: "*** in database main ***", markerPutBack: true });
    expect(checkedAfter).toBe(false);
    expect(fs.readFileSync(dbFile, "utf8")).toBe("current data");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("damaged after it was put in place, and the saved data can't go back either: says why, the marker stays", async () => {
    let calls = 0;
    const res = await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: async (source: string) => {
        calls += 1;
        if (source === savedFile) throw new Error("the disk is full");
        copy(source);
      },
      check: async () => "damaged",
      now,
    });
    expect(calls).toBe(2);
    expect(res).toMatchObject({ ok: false, stage: "check", check: "damaged", markerPutBack: false, putBackError: "the disk is full" });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("without saved data (there was no database) the marker stays: it only pauses sending", async () => {
    const res = await swapInBackup({ dbFile, backupFile, savedFile: null, restoredFrom, putInPlace: copy, check: async () => "damaged", now });
    expect(res).toMatchObject({ ok: false, stage: "check" });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("when the marker can't be written, nothing is changed", async () => {
    fs.mkdirSync(marker); // a folder where the marker should go: the rename fails
    let copied = false;
    const res = await swapInBackup({
      dbFile,
      backupFile,
      savedFile,
      restoredFrom,
      putInPlace: () => {
        copied = true;
      },
      check: async () => "ok",
      now,
    });
    expect(res).toMatchObject({ ok: false, stage: "marker", markerFile: marker });
    expect(copied).toBe(false);
    expect(fs.readFileSync(dbFile, "utf8")).toBe("current data");
    expect(fs.readdirSync(path.dirname(marker)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
