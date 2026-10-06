import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

// Runs the real worker entry point (through tsx, so no build is needed) against a temp database.
const t = await createTestDb("worker-process");
const { db } = await import("@/server/db");

type Proc = { child: ChildProcess; lines: string[]; exit: Promise<number | null> };
const procs: Proc[] = [];

function startWorker(args: string[] = []): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", "worker/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: t.url, DOTENV_QUIET: "true", NODE_ENV: "test" },
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

async function waitForLine(p: Proc, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!p.lines.some((l) => pattern.test(l))) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${pattern}. Output:\n${p.lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterAll(async () => {
  for (const p of procs) if (p.child.exitCode === null) p.child.kill();
  await db.$disconnect();
  fs.rmSync(path.join(process.cwd(), "backups", path.basename(t.file, ".db")), { recursive: true, force: true });
  // The worker's note next to the database (which database last ran here, on which computer).
  fs.rmSync(`${t.file}.instance`, { force: true });
  t.cleanup();
});

describe("worker process", () => {
  it("passes the self-test", async () => {
    const p = startWorker(["--self-test"]);
    expect(await p.exit).toBe(0);
    expect(p.lines).toContain("worker self-test ok");
  }, 60_000);

  it("runs as a single instance, waits instead of exiting, and stops within 4 s on a shutdown message", async () => {
    const a = startWorker();
    await waitForLine(a, /Lease taken/);
    await waitForLine(a, /Task #\d+ \(backup\.run\) finished/);
    for (const line of a.lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (info |warn |error) /);

    const b = startWorker();
    await waitForLine(b, /Another background sender is running; waiting/);
    expect(b.child.exitCode).toBeNull();

    const started = Date.now();
    a.child.send({ type: "shutdown" });
    expect(await a.exit).toBe(0);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(a.lines.some((l) => /Stopped$/.test(l))).toBe(true);

    // The lease was released: its heartbeat is set to 1970 so the next worker can take it at once.
    const lease = await db.workerLease.findUniqueOrThrow({ where: { id: 1 } });
    expect(lease.heartbeatAt.getTime()).toBe(0);

    b.child.send({ type: "shutdown" });
    expect(await b.exit).toBe(0);

    const backup = await db.job.findFirstOrThrow({ where: { type: "backup.run" } });
    expect(backup.status).toBe("DONE");
  }, 90_000);
});
