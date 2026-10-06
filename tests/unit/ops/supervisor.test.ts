/**
 * The start.bat supervisor with small stand-in programs instead of `next start` and the real
 * background sender: start both, restart a crashed worker, stop through the stop file (with the
 * IPC shutdown message), skip that message after a console stop (Ctrl+C / closed window), and
 * give up on a web app that keeps crashing.
 * Review fix SECURITY-05: the "Before a database upgrade" backup of any database other than .env's goes to that
 * database's own backups folder (backups\<name>\, the app's backupFolderFor rule), never among the real app's backups.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Supervisor, ensureMigrated, premigrateBackupsDir } from "../../../scripts/lib/supervisor.mjs";
import { appBackupFolder, scriptBackupKind } from "../../../scripts/lib/backups.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `supervisor-${process.pid}-${Date.now()}`);
const fakeWeb = path.join(ROOT, "tests", "unit", "ops", "fixtures", "fake-web.mjs");
const fakeWorker = path.join(ROOT, "tests", "unit", "ops", "fixtures", "fake-worker.mjs");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

function readLogs(logsDir: string, prefix: string): string {
  if (!fs.existsSync(logsDir)) return "";
  return fs
    .readdirSync(logsDir)
    .filter((n) => n.startsWith(prefix))
    .map((n) => fs.readFileSync(path.join(logsDir, n), "utf8"))
    .join("\n");
}

async function waitFor(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Supervisor", () => {
  it("runs both programs, restarts a crashed worker and stops cleanly through the stop file", { timeout: 60_000 }, async () => {
    const port = await freePort();
    const logsDir = path.join(dir, "logs-a");
    const stopFile = path.join(dir, "a-stop.request");
    const supervisor = new Supervisor(
      {
        label: "Test app",
        port,
        host: "127.0.0.1",
        logPrefix: "a-",
        logsDir,
        pidFile: path.join(dir, "a.pid"),
        stopFile,
        extraEnv: { FAKE_WORKER_CRASH_FILE: path.join(dir, "a-crashed") },
        webArgs: [fakeWeb],
        workerEntry: { entry: fakeWorker },
        workerPolicy: { baseDelayMs: 100 },
        handleSignals: false,
        healthTimeoutMs: 20_000,
        openBrowser: false,
        printBanner: () => undefined,
      },
      "file:./data/test/not-used.db",
      {},
    );
    const done = supervisor.run();

    // The worker crashed once and was started again; the web stand-in answers.
    expect(await waitFor(() => readLogs(logsDir, "a-worker").includes("fake worker started"), 20_000)).toBe(true);
    const workerLog = readLogs(logsDir, "a-worker");
    expect(workerLog).toContain("fake worker crashing on purpose");
    expect(workerLog).toContain("OUTREACH_PROCESS=worker");
    expect(readLogs(logsDir, "a-start")).toContain("stopped unexpectedly");
    expect(await waitFor(() => readLogs(logsDir, "a-web").includes("fake web listening"), 10_000)).toBe(true);
    const webLog = readLogs(logsDir, "a-web");
    expect(webLog).toContain("NODE_ENV=production");
    expect(webLog).toContain("DATABASE_URL=file:./data/test/not-used.db");
    expect(await canConnect(port)).toBe(true);

    // stop.bat writes the stop file.
    fs.writeFileSync(stopFile, "please stop");
    expect(await done).toBe(0);
    expect(readLogs(logsDir, "a-worker")).toContain("fake worker got shutdown");
    expect(fs.existsSync(stopFile)).toBe(false);
    expect(await waitFor(() => true, 300)).toBe(true);
    expect(await canConnect(port)).toBe(false);
  });

  it("doesn't send its own stop message after Ctrl+C or closing the window (the worker got that event itself)", { timeout: 60_000 }, async () => {
    const port = await freePort();
    const logsDir = path.join(dir, "logs-c");
    const supervisor = new Supervisor(
      {
        label: "Test app",
        port,
        host: "127.0.0.1",
        logPrefix: "c-",
        logsDir,
        pidFile: path.join(dir, "c.pid"),
        stopFile: path.join(dir, "c-stop.request"),
        extraEnv: {},
        webArgs: [fakeWeb],
        workerEntry: { entry: fakeWorker },
        handleSignals: false,
        healthTimeoutMs: 20_000,
        workerStopTimeoutMs: 1500,
        openBrowser: false,
        printBanner: () => undefined,
      },
      "file:./data/test/not-used.db",
      {},
    );
    const done = supervisor.run();
    expect(await waitFor(() => readLogs(logsDir, "c-worker").includes("fake worker started"), 20_000)).toBe(true);

    // What the SIGINT / SIGBREAK / SIGHUP handlers do. The stand-in worker gets no console event
    // here, so after the short wait it is ended; the point is that no second stop request went out.
    void supervisor.shutdown("Ctrl+C", 0, { consoleSignal: true });
    expect(await done).toBe(0);
    expect(readLogs(logsDir, "c-worker")).not.toContain("fake worker got shutdown");
    expect(readLogs(logsDir, "c-start")).toContain("didn't finish within 2 seconds");
  });

  it("gives up with exit code 1 when the app keeps crashing", { timeout: 60_000 }, async () => {
    const port = await freePort();
    const logsDir = path.join(dir, "logs-b");
    const supervisor = new Supervisor(
      {
        label: "Test app",
        port,
        host: "127.0.0.1",
        logPrefix: "b-",
        logsDir,
        pidFile: path.join(dir, "b.pid"),
        stopFile: path.join(dir, "b-stop.request"),
        extraEnv: {},
        webArgs: ["-e", "console.log('crashing web'); process.exit(1)"],
        workerEntry: { entry: fakeWorker },
        webPolicy: { maxRestarts: 2, baseDelayMs: 50 },
        handleSignals: false,
        healthTimeoutMs: 30_000,
        openBrowser: false,
        printBanner: () => undefined,
      },
      "file:./data/test/not-used.db",
      {},
    );
    expect(await supervisor.run()).toBe(1);
    const own = readLogs(logsDir, "b-start");
    expect(own).toContain("has given up");
    expect(readLogs(logsDir, "b-web").match(/crashing web/g)?.length).toBe(3);
    // The worker was asked to stop too.
    expect(readLogs(logsDir, "b-worker")).toContain("fake worker got shutdown");
  });
});

describe("the backup before a database upgrade (SECURITY-05)", () => {
  const appRoot = path.resolve("C:/Outreach");

  it("keeps the app's own database's backup in backups\\, whatever way it is written", () => {
    const backups = path.join(appRoot, "backups");
    expect(premigrateBackupsDir(undefined, "file:./data/app.db", appRoot)).toBe(backups);
    expect(premigrateBackupsDir("file:./data/app.db", "file:./data/app.db", appRoot)).toBe(backups);
    expect(premigrateBackupsDir("file:C:/Outreach/DATA/App.db", undefined, appRoot)).toBe(backups);
    // .env naming another file makes THAT file the real app's database: its upgrade backups stay in backups\.
    expect(premigrateBackupsDir("file:D:/OutreachData/app.db", "file:D:/OutreachData/app.db", appRoot)).toBe(backups);
  });

  it("puts any other database's backup in that database's own folder, the one the app uses for it", () => {
    const cases: Array<[string, string]> = [
      ["file:./data/manual-check/m6-live.db", path.join(appRoot, "backups", "m6-live")],
      ["file:./data/demo.db", path.join(appRoot, "backups", "demo")],
      ["file:./data/test/app.db", path.join(appRoot, "backups", "app")],
    ];
    for (const [url, folder] of cases) {
      expect(premigrateBackupsDir(url, "file:./data/app.db", appRoot), url).toBe(folder);
      // The same folder scripts\lib\backups.mjs (and the app's backupFolderFor) gives it.
      expect(folder).toBe(appBackupFolder(path.resolve(appRoot, url.replace(/^file:/, "")), appRoot));
    }
    // When .env points elsewhere, the other files follow the app's backupFolderFor rule (data\app.db → backups\).
    expect(premigrateBackupsDir("file:./data/app.db", "file:D:/OutreachData/app.db", appRoot)).toBe(path.join(appRoot, "backups"));
    expect(premigrateBackupsDir("file:./data/other.db", "file:D:/OutreachData/app.db", appRoot)).toBe(path.join(appRoot, "backups", "other"));
  });

  it("ensureMigrated writes the backup into the folder it is given, and only then upgrades", async () => {
    const work = path.join(dir, "premigrate");
    fs.mkdirSync(work, { recursive: true });
    const dbFile = path.join(work, "m6-live.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);"); // no upgrade history: an upgrade is due
    db.close();
    const backupsDir = path.join(work, "backups", "m6-live");
    const realBackups = path.join(work, "backups");
    const order: string[] = [];
    const r = await ensureMigrated({
      databaseUrl: `file:${dbFile.replace(/\\/g, "/")}`,
      backupsDir,
      log: (line: string) => order.push(`log: ${line}`),
      migrate: () => {
        order.push("migrate");
        return { ok: true, output: "" };
      },
    });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(path.dirname(r.backupFile!)).toBe(backupsDir);
    expect(scriptBackupKind(path.basename(r.backupFile!))).toBe("PRE_MIGRATE");
    expect(fs.readdirSync(realBackups)).toEqual(["m6-live"]);
    expect(order.at(-1)).toBe("migrate");
    expect(order[0]).toMatch(/^log: Backed up the database first: /);
  });
});
