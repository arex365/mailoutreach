// Well-known paths of the project. Everything resolves from the project root (never from
// the current directory), so the scripts behave the same however they are started.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Joins path parts onto the project root. */
export function inRoot(...parts) {
  return path.join(ROOT, ...parts);
}

export const PATHS = {
  env: inRoot(".env"),
  dataDir: inRoot("data"),
  appDb: inRoot("data", "app.db"),
  demoDb: inRoot("data", "demo.db"),
  abiFile: inRoot("data", ".node-abi"),
  restoredMarker: inRoot("data", "RESTORED"),
  backupsDir: inRoot("backups"),
  logsDir: inRoot("logs"),
  runDir: inRoot("run"),
  supervisorPid: inRoot("run", "supervisor.pid"),
  stopRequest: inRoot("run", "stop.request"),
  demoPid: inRoot("run", "demo.pid"),
  demoStopRequest: inRoot("run", "demo-stop.request"),
  // Written by update.bat while it replaces the app's parts; nothing starts the app while it exists.
  // worker/index.ts checks the same path (run\update-in-progress next to the working folder).
  updateMarker: inRoot("run", "update-in-progress"),
  nodeModules: inRoot("node_modules"),
  lockFile: inRoot("package-lock.json"),
  hiddenLockFile: inRoot("node_modules", ".package-lock.json"),
  buildId: inRoot(".next", "BUILD_ID"),
  buildMarker: inRoot(".next", "outreach-build.json"),
  workerBundle: inRoot("dist", "worker.mjs"),
  workerSource: inRoot("worker", "index.ts"),
  buildWorkerScript: inRoot("scripts", "build-worker.mjs"),
  migrationsDir: inRoot("prisma", "migrations"),
  prismaCli: inRoot("node_modules", "prisma", "build", "index.js"),
  nextCli: inRoot("node_modules", "next", "dist", "bin", "next"),
  nssm: inRoot("tools", "nssm.exe"),
  nssmSha: inRoot("tools", "nssm.sha256"),
  startBat: inRoot("start.bat"),
};

/** Project-relative path with backslashes, for messages the owner can copy ("backups\\x.db"). */
export function displayPath(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel.split(path.sep).join("\\");
}
