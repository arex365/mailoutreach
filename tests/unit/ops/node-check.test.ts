import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_DOWNLOAD_TEXT,
  NODE_UPDATED_MESSAGE,
  RECOMMENDED_NODE,
  abiStatus,
  checkNodeVersion,
  compareVersions,
  dependenciesStateFrom,
  parseVersion,
  readRecordedAbi,
  writeRecordedAbi,
} from "../../../scripts/lib/node-check.mjs";

/** M6-DESIGN §6.6: every message names nodejs.org's 24.x folder, never the front page (its "LTS" becomes Node 26). */
const NODE_24_FOLDER = "https://nodejs.org/dist/latest-v24.x/";

describe("Node.js version check", () => {
  it("parses and compares versions", () => {
    expect(parseVersion("v24.21.0")).toEqual([24, 21, 0]);
    expect(parseVersion("junk")).toBeNull();
    expect(compareVersions("24.18.0", "24.21.0")).toBe(-1);
    expect(compareVersions("24.21.0", "24.21.0")).toBe(0);
    expect(compareVersions("25.0.0", "24.21.0")).toBe(1);
  });

  it("names the 24.x download folder in one sentence, shared with the .bat files", () => {
    expect(NODE_DOWNLOAD_TEXT).toBe(
      "Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi)",
    );
    // The recommended version stays a 24.x (the messages name the folder, not a fixed version).
    expect(RECOMMENDED_NODE).toBe("24.21.0");
  });

  it("refuses versions older than 24.18 and says where Node.js 24 comes from", () => {
    for (const v of ["22.12.0", "24.17.9", "20.0.0"]) {
      const r = checkNodeVersion(v);
      expect(r.ok).toBe(false);
      expect(r.message).toBe(`This PC has Node.js ${v}, which is too old for the app. ${NODE_DOWNLOAD_TEXT}, then run this again.`);
      expect(r.message).toContain(NODE_24_FOLDER);
      expect(r.message).toContain("(not 26)");
    }
  });

  it("refuses Node 25 and newer (the native parts are built for Node 24), newer version uninstalled first", () => {
    for (const v of ["25.1.0", "26.0.0"]) {
      const r = checkNodeVersion(v);
      expect(r.ok).toBe(false);
      expect(r.recommendUpgrade).toBe(false);
      expect(r.message).toContain("Node.js 24");
      expect(r.message).toContain(NODE_24_FOLDER);
      expect(r.message).toContain("the file ending in -x64.msi");
      // The Node.js installer never replaces a newer version, so the message says to uninstall it first.
      expect(r.message).toMatch(/Uninstall Node\.js .* then install Node\.js 24 \(not 26\)/);
      expect(r.message).toMatch(/then double-click update\.bat\.$/);
    }
  });

  it("accepts 24.18 to 24.20 but recommends the newer 24.x: stop.bat, install from the 24.x folder, update.bat", () => {
    expect(checkNodeVersion("24.18.0")).toMatchObject({ ok: true, recommendUpgrade: true });
    const r = checkNodeVersion("24.20.3");
    expect(r).toMatchObject({ ok: true, recommendUpgrade: true });
    expect(r.message).toContain(RECOMMENDED_NODE);
    expect(r.message).toContain("double-click stop.bat");
    expect(r.message).toContain(`install Node.js 24 (not 26) from ${NODE_24_FOLDER}`);
    expect(r.message).toMatch(/then double-click update\.bat\.$/);
  });

  it("never sends anyone to nodejs.org's front page", () => {
    for (const v of ["20.0.0", "24.17.9", "24.20.3", "25.1.0", "26.0.0"]) {
      const message = checkNodeVersion(v).message;
      expect(message).not.toMatch(/https:\/\/nodejs\.org(?!\/dist\/latest-v24\.x\/)/);
    }
  });

  it("is quiet from 24.21.0 on", () => {
    expect(checkNodeVersion("24.21.0")).toMatchObject({ ok: true, recommendUpgrade: false });
    expect(checkNodeVersion("v24.30.1")).toMatchObject({ ok: true, recommendUpgrade: false });
  });
});

describe("installed parts", () => {
  it("is missing without node_modules or npm's own lock record", () => {
    expect(dependenciesStateFrom({ nodeModulesExists: false, lockMtimeMs: 1, hiddenLockMtimeMs: 2 })).toBe("missing");
    expect(dependenciesStateFrom({ nodeModulesExists: true, lockMtimeMs: 1, hiddenLockMtimeMs: null })).toBe("missing");
  });

  it("is outdated when package-lock.json changed after the last install", () => {
    expect(dependenciesStateFrom({ nodeModulesExists: true, lockMtimeMs: 10_000, hiddenLockMtimeMs: 5_000 })).toBe("outdated");
  });

  it("is fine when npm installed after the lock file was written (with a second of slack)", () => {
    expect(dependenciesStateFrom({ nodeModulesExists: true, lockMtimeMs: 5_000, hiddenLockMtimeMs: 5_100 })).toBe("ok");
    expect(dependenciesStateFrom({ nodeModulesExists: true, lockMtimeMs: 5_500, hiddenLockMtimeMs: 5_000 })).toBe("ok");
  });
});

describe("ABI guard", () => {
  it("compares the recorded ABI with the running Node's", () => {
    expect(abiStatus(null, "137")).toBe("missing");
    expect(abiStatus("137", "137")).toBe("ok");
    expect(abiStatus("137\n", "137")).toBe("ok");
    expect(abiStatus("127", "137")).toBe("changed");
    expect(NODE_UPDATED_MESSAGE.startsWith("Node was updated: run update.bat")).toBe(true);
  });

  it("writes and reads the record file", () => {
    const file = path.resolve("data", "test", `node-abi-${process.pid}-${Date.now()}`);
    try {
      expect(readRecordedAbi(file)).toBeNull();
      writeRecordedAbi(file, "137");
      expect(fs.readFileSync(file, "utf8")).toBe("137\n");
      expect(readRecordedAbi(file)).toBe("137");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
