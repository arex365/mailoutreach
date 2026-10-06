// Processes, pid files, ports, the health check and opening things on Windows.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT } from "./paths.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readPidFile(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone or locked; harmless */
  }
}

/** True while a process with this id exists. */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** "node.exe" for a running process, or null. */
export function processImageName(pid) {
  const r = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  const m = String(r.stdout ?? "").match(/^"([^"]+)","(\d+)"/m);
  return m && Number(m[2]) === pid ? m[1] : null;
}

/** Full command line of a process (null if Windows won't tell). Takes about a second. */
export function processCommandLine(pid) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  const text = String(r.stdout ?? "").trim();
  return r.status === 0 && text ? text : null;
}

/**
 * Is the program behind this pid file (start.bat or start-demo.bat) still running?
 * Guards against a stale file whose number now belongs to some other program.
 */
export function supervisorState(pidFile) {
  const pid = readPidFile(pidFile);
  if (!pid) return { running: false, pid: null };
  if (pid === process.pid || !isPidAlive(pid)) return { running: false, pid, stale: true };
  const image = processImageName(pid);
  if (image && image.toLowerCase() !== "node.exe") return { running: false, pid, stale: true };
  const cmd = processCommandLine(pid);
  if (cmd && !/run-prod|start-demo/i.test(cmd)) return { running: false, pid, stale: true };
  return { running: true, pid };
}

function fileAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Claims a pid file for this process, atomically: the file is created with the "wx" flag, which
 * fails when it already exists, so two start.bat windows opened at the same moment can't both
 * win. A file left behind by a program that has ended is removed first, but only while it still
 * holds that same old number. An empty file younger than a few seconds means another window is
 * claiming it right now.
 * @param {string} file
 * @param {{ pid?: number, state?: (file: string) => { running: boolean, pid: number | null } }} [options]
 *   `state` tells whether the program behind a pid file still runs (tests pass a stand-in).
 * @returns {Promise<{ ok: true } | { ok: false, pid: number | null }>}
 */
export async function claimPidFile(file, { pid = process.pid, state = supervisorState } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, `${pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    const current = readPidFile(file);
    if (current === pid) return { ok: true };
    if (current === null) {
      // Being written by another window this very moment, or an empty leftover.
      if (fileAgeMs(file) < 3_000 && Date.now() < deadline) {
        await sleep(200);
        continue;
      }
      if (readPidFile(file) === null) removeFile(file);
      if (Date.now() >= deadline) return { ok: false, pid: null };
      continue;
    }
    const st = state(file);
    if (st.running) return { ok: false, pid: st.pid };
    if (readPidFile(file) === current) removeFile(file);
    if (Date.now() >= deadline) return { ok: false, pid: readPidFile(file) };
  }
}

/** Ends a process and everything it started (taskkill /T /F). */
export function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** True when something already listens on this port (or it can't be opened). */
export async function portInUse(port) {
  if (await canConnect(port, "127.0.0.1")) return true;
  return !(await canListen(port, "0.0.0.0"));
}

/**
 * One look at GET /api/health. answered = the web server replied at all;
 * healthy = it replied 200 with ok:true.
 */
export async function checkHealth(port, timeoutMs = 4000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { answered: true, healthy: res.status === 200 && Boolean(body?.ok), status: res.status, body };
  } catch {
    return { answered: false, healthy: false, status: null, body: null };
  }
}

/** Polls the health check until it passes (or only answers, with requireHealthy=false). */
export async function waitForHealth(port, timeoutMs, { requireHealthy = true, shouldStop } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { answered: false, healthy: false, status: null, body: null };
  while (Date.now() < deadline) {
    if (shouldStop?.()) break;
    last = await checkHealth(port);
    if (requireHealthy ? last.healthy : last.answered) return { ...last, ok: true };
    await sleep(1000);
  }
  return { ...last, ok: false };
}

/** Opens a web address in the default browser (also from an elevated window, via Explorer). */
export function openInBrowser(url) {
  try {
    const child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* the address is printed anyway */
  }
}

/** Starts a .bat file in its own new console window (like double-clicking it). */
export function startInNewWindow(windowTitle, batFile, args = []) {
  const extra = args.map((a) => ` "${a}"`).join("");
  const command = `"start "${windowTitle}" /D "${ROOT}" "${batFile}"${extra}"`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

/** True when this window has administrator rights. */
export function isElevated() {
  const r = spawnSync("net.exe", ["session"], { stdio: "ignore", windowsHide: true });
  if (r.status === 0) return true;
  const f = spawnSync("fltmc.exe", [], { stdio: "ignore", windowsHide: true });
  return f.status === 0;
}

/** Runs npm ci with the npm that belongs to this Node.js (never npm.ps1). */
export function runNpmCi() {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const env = { ...process.env, npm_config_fund: "false", npm_config_audit: "false", npm_config_update_notifier: "false" };
  const r = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, "ci"], { cwd: ROOT, stdio: "inherit", env })
    : spawnSync("cmd.exe", ["/d", "/s", "/c", '"npm ci"'], { cwd: ROOT, stdio: "inherit", env, windowsVerbatimArguments: true });
  return { ok: r.status === 0, status: r.status };
}
