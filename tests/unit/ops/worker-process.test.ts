/**
 * The real background sender entry point (worker/index.ts through tsx), started in a temporary
 * working folder so it never sees the project's .env, run\ or data\ files.
 *   OPS-1: while run\update-in-progress exists it does nothing (no database), and exits when it's gone.
 *   OPS-3: a second stop request from another source (start.bat's IPC message after the console
 *          event, the IPC channel closing) doesn't cut the clean shutdown short.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../integration/helpers/test-db";

const ROOT = path.resolve(".");
const TSX = pathToFileURL(path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const ENTRY = path.join(ROOT, "worker", "index.ts");
const base = path.join(ROOT, "data", "test", `worker-process-${process.pid}-${Date.now()}`);

type Proc = { child: ChildProcess; lines: string[]; exit: Promise<number | null> };
const procs: Proc[] = [];

function startWorker(cwd: string, databaseUrl: string, args: string[] = []): Proc {
  const child = spawn(process.execPath, ["--import", TSX, ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TSX_TSCONFIG_PATH: path.join(ROOT, "tsconfig.worker.json"),
      DOTENV_CONFIG_QUIET: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const lines: string[] = [];
  const collect = (d: Buffer) => lines.push(...String(d).split(/\r?\n/).filter(Boolean));
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const proc = { child, lines, exit };
  procs.push(proc);
  return proc;
}

async function waitForLine(p: Proc, pattern: RegExp, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (!p.lines.some((l) => pattern.test(l))) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${pattern}. Output:\n${p.lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => fs.mkdirSync(base, { recursive: true }));
afterAll(() => {
  for (const p of procs) if (p.child.exitCode === null) p.child.kill();
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* a file may still be open on Windows; data/test is ignored anyway */
  }
});

describe("background sender and update.bat's lock", () => {
  it("does nothing while update.bat hasn't finished, and exits once it has", { timeout: 90_000 }, async () => {
    const cwd = path.join(base, "updating");
    fs.mkdirSync(path.join(cwd, "run"), { recursive: true });
    const marker = path.join(cwd, "run", "update-in-progress");
    fs.writeFileSync(marker, JSON.stringify({ step: "building" }));
    const dbFile = path.join(cwd, "must-not-exist.db");
    const url = "file:" + dbFile.replace(/\\/g, "/");

    // --once refuses straight away.
    const once = startWorker(cwd, url, ["--once"]);
    expect(await once.exit).toBe(1);
    expect(once.lines.join("\n")).toContain("update.bat hasn't finished");

    const w = startWorker(cwd, url);
    await waitForLine(w, /update\.bat hasn't finished/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(w.child.exitCode).toBeNull(); // waits, doesn't exit (the service manager would restart-loop it)
    expect(fs.existsSync(dbFile)).toBe(false); // never opened the database

    fs.rmSync(marker);
    expect(await w.exit).toBe(0);
    expect(w.lines.join("\n")).toContain("update.bat has finished");
    expect(fs.existsSync(dbFile)).toBe(false);
  });
});

describe("background sender stop requests", () => {
  // Generous limits: the real worker starts through tsx (compiling its whole import graph) and makes a real first
  // backup in a child process (scripts/vacuum-into.mjs, M6). Alone this takes about 15 s, but in a cold, fully parallel
  // `npm run check` it once needed more than 120 s. The stop itself is bounded (worker/main.ts SHUTDOWN_* limits).
  it("finishes a clean stop when the IPC channel closes right after the stop message", { timeout: 240_000 }, async () => {
    const t = await createTestDb("worker-stop");
    const cwd = path.join(base, "stop");
    fs.mkdirSync(cwd, { recursive: true });
    const w = startWorker(cwd, t.url);
    await waitForLine(w, /Lease taken/, 90_000);
    await waitForLine(w, /Task #\d+ \(backup\.run\) finished/, 90_000);

    // Hold the database's write lock, so the clean stop (which releases the lease) is still running
    // when the second request arrives: SQLite makes the worker wait for the lock, then give up.
    const blocker = new Database(t.file);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      // start.bat's stop message, then the channel closing (start.bat's window going away).
      w.child.send({ type: "shutdown" });
      w.child.disconnect();
      expect(await w.exit).toBe(0);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const out = w.lines.join("\n");
    expect(out).toContain("Stopping (shutdown message)");
    expect(out).not.toContain("stopping right away");
    expect(w.lines.some((l) => /Stopped$/.test(l))).toBe(true);
    fs.rmSync(`${t.file}.instance`, { force: true }); // the worker's note next to the database
    t.cleanup();
  });
});
