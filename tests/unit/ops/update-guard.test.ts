/**
 * OPS-1: while update.bat hasn't finished (run\update-in-progress), nothing may start the
 * half-updated app. The marker file, the plain-language refusal, and the services' start type.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UPDATE_UNFINISHED_MESSAGE,
  clearUpdateMarker,
  readUpdateMarker,
  updateInProgress,
  writeUpdateMarker,
} from "../../../scripts/lib/update-marker.mjs";
import { startBlockMessage } from "../../../scripts/lib/app-control.mjs";
import { PATHS } from "../../../scripts/lib/paths.mjs";
import { START_MODE, parseStartType } from "../../../scripts/lib/services.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `update-guard-${process.pid}-${Date.now()}`);
const marker = path.join(dir, "run", "update-in-progress");

beforeAll(() => fs.mkdirSync(dir, { recursive: true }));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("run\\update-in-progress", () => {
  it("lives in run\\, where the background sender also looks for it", () => {
    expect(PATHS.updateMarker).toBe(path.join(ROOT, "run", "update-in-progress"));
    const workerSource = fs.readFileSync(path.join(ROOT, "worker", "index.ts"), "utf8");
    expect(workerSource).toContain('path.join(/*turbopackIgnore: true*/ process.cwd(), "run", "update-in-progress")');
  });

  it("is written, read and removed", () => {
    expect(readUpdateMarker(marker)).toBeNull();
    expect(updateInProgress(marker)).toBe(false);
    writeUpdateMarker({ step: "installing" }, marker);
    expect(updateInProgress(marker)).toBe(true);
    const data = readUpdateMarker(marker);
    expect(data).toMatchObject({ step: "installing", pid: process.pid });
    expect(Number.isNaN(Date.parse(String(data?.startedAt)))).toBe(false);
    clearUpdateMarker(marker);
    expect(updateInProgress(marker)).toBe(false);
    clearUpdateMarker(marker); // removing twice is fine
  });

  it("counts even when its contents can't be read", () => {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "not json");
    expect(readUpdateMarker(marker)).toEqual({});
    expect(updateInProgress(marker)).toBe(true);
    clearUpdateMarker(marker);
  });
});

describe("startBlockMessage", () => {
  it("refuses while update.bat hasn't finished, and says what to do", () => {
    expect(startBlockMessage({ updateUnfinished: true })).toBe(UPDATE_UNFINISHED_MESSAGE);
    expect(UPDATE_UNFINISHED_MESSAGE).toContain("Double-click update.bat");
    // The update comes first, even when the build is also out of date.
    expect(startBlockMessage({ updateUnfinished: true, build: { needed: true, reason: "changed" } })).toBe(UPDATE_UNFINISHED_MESSAGE);
  });

  it("refuses to start the services with a missing or out-of-date build", () => {
    expect(startBlockMessage({ updateUnfinished: false, build: { needed: true, reason: "changed" } })).toContain("update.bat");
    expect(startBlockMessage({ updateUnfinished: false, build: { needed: true, reason: "missing" } })).toContain("isn't completely built");
    expect(startBlockMessage({ updateUnfinished: false, build: { needed: true, reason: "worker-missing" } })).toContain("update.bat");
  });

  it("lets a finished install start", () => {
    expect(startBlockMessage({ updateUnfinished: false, build: { needed: false, reason: null } })).toBeNull();
    expect(startBlockMessage({ updateUnfinished: false })).toBeNull();
  });
});

describe("update.mjs order of steps", () => {
  // update.bat needs administrator rights, npm ci and a build, so it can't run in a test. This
  // keeps the order that matters: lock before changing anything, unlock only when all is done.
  it("locks before npm ci and lets the services start with Windows only after the health check", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "update.mjs"), "utf8");
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const order = [
      at("await stopApp("),
      at('writeUpdateMarker({ step: "stopped" })'),
      at('setServicesStartMode("manual")'),
      at("runNpmCi()"),
      at("await ensureMigrated("),
      at("runBuild("),
      at("clearUpdateMarker();\n  locked = false;"),
      at("await startApp("),
      at("await waitForHealth("),
      at('const auto = setServicesStartMode("automatic")'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("service start type (sc qc)", () => {
  const qc = (type: string) => `[SC] QueryServiceConfig SUCCESS\n\nSERVICE_NAME: OutreachWeb\n        TYPE               : 10  WIN32_OWN_PROCESS\n        START_TYPE         : ${type}\n`;

  it("tells manual from automatic start", () => {
    expect(parseStartType(qc("3   DEMAND_START"))).toBe("manual");
    expect(parseStartType(qc("2   AUTO_START  (DELAYED)"))).toBe("automatic");
    expect(parseStartType(qc("2   AUTO_START"))).toBe("automatic");
    expect(parseStartType(qc("4   DISABLED"))).toBe("disabled");
    expect(parseStartType("[SC] OpenService FAILED 1060")).toBeNull();
  });

  it("uses sc.exe's words for the two modes update.bat switches between", () => {
    expect(START_MODE).toEqual({ manual: "demand", automatic: "delayed-auto" });
  });
});
