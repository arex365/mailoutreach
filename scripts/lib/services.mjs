// The two Windows services made by install-services.bat (NSSM): OutreachWeb and OutreachWorker.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { PATHS } from "./paths.mjs";
import { sleep } from "./proc.mjs";

export const WEB_SERVICE = "OutreachWeb";
export const WORKER_SERVICE = "OutreachWorker";

const STATE_NAMES = {
  1: "STOPPED",
  2: "START_PENDING",
  3: "STOP_PENDING",
  4: "RUNNING",
  5: "CONTINUE_PENDING",
  6: "PAUSE_PENDING",
  7: "PAUSED",
};

/**
 * Reads `sc query <name>` output. Error 1060 means "not installed".
 * @returns {{ installed: boolean, state: string | null, error?: string }}
 */
export function parseScQuery(output, exitCode) {
  const text = String(output ?? "");
  if (exitCode === 1060 || /FAILED 1060\b/.test(text)) return { installed: false, state: null };
  const m = text.match(/STATE\s*:\s*(\d+)\s*([A-Z_]*)/);
  if (m) return { installed: true, state: STATE_NAMES[Number(m[1])] ?? (m[2] || "UNKNOWN") };
  if (exitCode === 0) return { installed: true, state: "UNKNOWN" };
  return { installed: false, state: null, error: text.trim() || `sc.exe exit code ${exitCode}` };
}

export function queryService(name) {
  const r = spawnSync("sc.exe", ["query", name], { encoding: "utf8", windowsHide: true });
  return parseScQuery(`${r.stdout ?? ""}${r.stderr ?? ""}`, r.status);
}

/** True when install-services.bat has set the app up as background services. */
export function servicesInstalled() {
  return queryService(WEB_SERVICE).installed;
}

/**
 * True only when tools\nssm.exe exists and its SHA-256 matches tools\nssm.sha256 (the same check
 * as Get-VerifiedNssm in scripts\lib\ops-common.ps1). The scripts run NSSM as administrator, so a
 * changed file must never be used.
 */
export function nssmFingerprintMatches(nssmFile = PATHS.nssm, shaFile = PATHS.nssmSha) {
  try {
    const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0].toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(expected)) return false;
    const actual = crypto.createHash("sha256").update(fs.readFileSync(nssmFile)).digest("hex").toUpperCase();
    return actual === expected;
  } catch {
    return false;
  }
}

function control(action, name) {
  // Checked before every use: this runs elevated (start.bat, stop.bat, update.bat, restore.bat).
  const useNssm = nssmFingerprintMatches();
  const r = useNssm
    ? spawnSync(PATHS.nssm, [action, name], { encoding: "utf8", windowsHide: true, timeout: 90_000 })
    : spawnSync("sc.exe", [action, name], { encoding: "utf8", windowsHide: true });
  // NSSM writes UTF-16; dropping the NUL bytes leaves readable text.
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\u0000/g, "").trim();
  const note =
    !useNssm && fs.existsSync(PATHS.nssm)
      ? "tools\\nssm.exe doesn't match its recorded fingerprint (tools\\nssm.sha256), so Windows' own sc.exe was used instead."
      : null;
  return { status: r.status, output, note };
}

/** Service start types, as `sc.exe config <name> start= <mode>` spells them. */
export const START_MODE = { manual: "demand", automatic: "delayed-auto" };

/**
 * Reads `sc qc <name>` output: "START_TYPE : 3 DEMAND_START" → "manual",
 * "2 AUTO_START (DELAYED)" / "2 AUTO_START" → "automatic", "4 DISABLED" → "disabled".
 */
export function parseStartType(output) {
  const m = String(output ?? "").match(/START_TYPE\s*:\s*(\d+)/);
  if (!m) return null;
  return { 2: "automatic", 3: "manual", 4: "disabled" }[Number(m[1])] ?? "other";
}

export function queryStartType(name) {
  const r = spawnSync("sc.exe", ["qc", name], { encoding: "utf8", windowsHide: true });
  return parseStartType(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/**
 * Sets both services to start by hand ("manual") or with Windows ("automatic", delayed like
 * install-services.bat sets them). update.bat uses "manual" while it replaces the app's parts,
 * so a restart of the PC in the middle (or after a failed update) never starts a half-updated app.
 * Needs administrator rights. Returns { ok, message }.
 */
export function setServicesStartMode(mode) {
  const scMode = mode === "manual" ? START_MODE.manual : START_MODE.automatic;
  for (const name of [WEB_SERVICE, WORKER_SERVICE]) {
    if (!queryService(name).installed) continue;
    const r = spawnSync("sc.exe", ["config", name, "start=", scMode], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) {
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { ok: false, message: `Windows didn't let the script change how ${name} starts. ${output}`.trim() };
    }
  }
  return {
    ok: true,
    message: mode === "manual" ? "The services start only by hand until this finishes." : "The services start with Windows again.",
  };
}

export async function waitForServiceState(name, wanted, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = queryService(name);
  while (Date.now() < deadline) {
    if (last.state === wanted) return true;
    await sleep(1000);
    last = queryService(name);
  }
  return last.state === wanted;
}

const FRIENDLY = { [WEB_SERVICE]: "the app", [WORKER_SERVICE]: "the background sender" };

/** Stops the background sender first, then the app. Returns { ok, message }. */
export async function stopServices(log = () => undefined) {
  for (const name of [WORKER_SERVICE, WEB_SERVICE]) {
    const q = queryService(name);
    if (!q.installed || q.state === "STOPPED") continue;
    log(`Stopping ${FRIENDLY[name]} (${name})...`);
    const r = control("stop", name);
    if (r.note) log(r.note);
    if (!(await waitForServiceState(name, "STOPPED", 60_000))) {
      return { ok: false, message: `Windows couldn't stop ${name} within a minute. ${r.output}`.trim() };
    }
  }
  return { ok: true, message: "Both services are stopped." };
}

/** Starts the app first, then the background sender. Returns { ok, message }. */
export async function startServices(log = () => undefined) {
  for (const name of [WEB_SERVICE, WORKER_SERVICE]) {
    const q = queryService(name);
    if (!q.installed) return { ok: false, message: `The service ${name} isn't installed. Run install-services.bat.` };
    if (q.state === "RUNNING") continue;
    log(`Starting ${FRIENDLY[name]} (${name})...`);
    const r = control("start", name);
    if (r.note) log(r.note);
    if (!(await waitForServiceState(name, "RUNNING", 60_000))) {
      return {
        ok: false,
        message: `Windows couldn't start ${name}. Look at logs\\${name === WEB_SERVICE ? "web" : "worker"}.log for the reason. ${r.output}`.trim(),
      };
    }
  }
  return { ok: true, message: "Both services are running." };
}
