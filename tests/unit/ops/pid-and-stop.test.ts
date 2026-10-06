/**
 * OPS-11: two start.bat windows opened at the same moment can't both claim run\supervisor.pid.
 * OPS-7: stop.bat / update.bat / restore.bat wait for a window that is upgrading the database or
 * building, never end a database upgrade, and never call a forced stop during a build "safe".
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimPidFile, isPidAlive, readPidFile } from "../../../scripts/lib/proc.mjs";
import {
  clearPhase,
  phaseFileFor,
  readPhase,
  stopResultMessage,
  stopSupervisor,
  writePhase,
} from "../../../scripts/lib/supervisor.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `pid-stop-${process.pid}-${Date.now()}`);
const fixture = path.join(ROOT, "tests", "unit", "ops", "fixtures", "fake-run-prod.mjs");
const children: ChildProcess[] = [];

beforeAll(() => fs.mkdirSync(dir, { recursive: true }));
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Fake = { child: ChildProcess; out: string[]; exit: Promise<number | null> };

function startFake(env: Record<string, string>): Fake {
  const child = spawn(process.execPath, [fixture], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out: string[] = [];
  child.stdout!.on("data", (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr!.on("data", (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, out, exit };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const runningAs = (file: string) => ({ running: true, pid: readPidFile(file) });

describe("claimPidFile", () => {
  it("lets exactly one of two claims made at the same moment win", async () => {
    const file = path.join(dir, "same-moment.pid");
    const state = (f: string) => runningAs(f);
    const [a, b] = await Promise.all([claimPidFile(file, { pid: 111, state }), claimPidFile(file, { pid: 222, state })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const winner = a.ok ? 111 : 222;
    expect(readPidFile(file)).toBe(winner);
    expect(a.ok ? b : a).toEqual({ ok: false, pid: winner });
  });

  it("takes over a file left behind by a program that has ended", async () => {
    const file = path.join(dir, "stale.pid");
    fs.writeFileSync(file, "999999\n");
    const r = await claimPidFile(file, { pid: 333, state: (f: string) => ({ running: false, pid: readPidFile(f), stale: true }) });
    expect(r).toEqual({ ok: true });
    expect(readPidFile(file)).toBe(333);
  });

  it("waits for a file that another window is writing right now", async () => {
    const file = path.join(dir, "being-written.pid");
    fs.writeFileSync(file, "");
    setTimeout(() => fs.writeFileSync(file, "444\n"), 300);
    const r = await claimPidFile(file, { pid: 555, state: (f: string) => runningAs(f) });
    expect(r).toEqual({ ok: false, pid: 444 });
    expect(readPidFile(file)).toBe(444);
  });

  it("with two real processes started together, only one claims the file", { timeout: 30_000 }, async () => {
    const file = path.join(dir, "race.pid");
    const env = { FAKE_MODE: "claim", FAKE_PID_FILE: file, FAKE_HOLD_MS: "6000" };
    const a = startFake(env);
    const b = startFake(env);
    expect(await waitFor(() => a.out.length > 0 && b.out.length > 0, 20_000)).toBe(true);
    const results = [JSON.parse(a.out[0]!), JSON.parse(b.out[0]!)] as { ok: boolean; pid?: number }[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results[0]!.ok ? a : b;
    expect(readPidFile(file)).toBe(winner.child.pid);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, pid: winner.child.pid });
  });
});

describe("phase file", () => {
  it("sits next to the pid file and belongs to one process", () => {
    expect(phaseFileFor(path.join("run", "supervisor.pid"))).toBe(path.join("run", "supervisor.phase"));
    expect(phaseFileFor(path.join("run", "demo.pid"))).toBe(path.join("run", "demo.phase"));
    const pidFile = path.join(dir, "phase.pid");
    writePhase(pidFile, "building");
    expect(readPhase(pidFile, process.pid)).toMatchObject({ phase: "building" });
    expect(readPhase(pidFile, process.pid + 1)).toBeNull();
    clearPhase(pidFile);
    expect(fs.existsSync(phaseFileFor(pidFile))).toBe(false);
  });
});

describe("stopSupervisor while start.bat is busy", () => {
  it("waits for a database upgrade to finish instead of ending it", { timeout: 60_000 }, async () => {
    const pidFile = path.join(dir, "wait.pid");
    const stopFile = path.join(dir, "wait-stop.request");
    const fake = startFake({ FAKE_MODE: "busy", FAKE_PID_FILE: pidFile, FAKE_STOP_FILE: stopFile, FAKE_PHASE: "migrating", FAKE_BUSY_MS: "7000" });
    expect(await waitFor(() => fake.out.includes("busy"), 20_000)).toBe(true);
    const lines: string[] = [];
    const r = await stopSupervisor({ pidFile, stopFile, timeoutMs: 3000, busyTimeoutMs: 30_000, log: (l: string) => lines.push(l) });
    expect(r).toMatchObject({ wasRunning: true, forced: false, refused: false, busy: "migrating" });
    expect(await fake.exit).toBe(0);
    expect(fake.out).toContain("stopped cleanly");
    expect(lines.join("\n")).toContain("upgrading the database");
    expect(stopResultMessage("The app", r)).toBe("The app has stopped.");
  });

  it("never ends a database upgrade, even after waiting long: it leaves the stop request for later", { timeout: 60_000 }, async () => {
    const pidFile = path.join(dir, "refuse.pid");
    const stopFile = path.join(dir, "refuse-stop.request");
    const fake = startFake({ FAKE_MODE: "busy", FAKE_PID_FILE: pidFile, FAKE_STOP_FILE: stopFile, FAKE_PHASE: "migrating", FAKE_BUSY_MS: "60000" });
    expect(await waitFor(() => fake.out.includes("busy"), 20_000)).toBe(true);
    const r = await stopSupervisor({ pidFile, stopFile, timeoutMs: 300, busyTimeoutMs: 1500, log: () => undefined });
    expect(r).toMatchObject({ wasRunning: true, forced: false, refused: true, busy: "migrating" });
    expect(isPidAlive(fake.child.pid)).toBe(true);
    expect(fs.existsSync(stopFile)).toBe(true);
    const message = stopResultMessage("The app", r);
    expect(message).toContain("upgrading the database");
    expect(message).not.toMatch(/safe/i);
    fake.child.kill();
  });

  it("ends a build that takes far too long, and doesn't call that safe", { timeout: 60_000 }, async () => {
    const pidFile = path.join(dir, "build.pid");
    const stopFile = path.join(dir, "build-stop.request");
    const fake = startFake({ FAKE_MODE: "busy", FAKE_PID_FILE: pidFile, FAKE_STOP_FILE: stopFile, FAKE_PHASE: "building", FAKE_BUSY_MS: "60000" });
    expect(await waitFor(() => fake.out.includes("busy"), 20_000)).toBe(true);
    const r = await stopSupervisor({ pidFile, stopFile, timeoutMs: 300, busyTimeoutMs: 1500, log: () => undefined });
    expect(r).toMatchObject({ wasRunning: true, forced: true, forcedDuring: "building", refused: false });
    expect(await fake.exit).not.toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(phaseFileFor(pidFile))).toBe(false);
    const message = stopResultMessage("The app", r);
    expect(message).toContain("build");
    expect(message).not.toMatch(/safe/i);
  });

  it("still says an ordinary forced stop is safe", () => {
    expect(stopResultMessage("The app", { wasRunning: true, forced: true, forcedDuring: null, refused: false })).toContain("safe");
  });
});
