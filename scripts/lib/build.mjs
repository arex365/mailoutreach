// Building the app: the same steps as `npm run build` (prisma generate, next build, the
// background sender bundle), run with node directly so npm's PowerShell shim is never involved.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { PATHS, ROOT } from "./paths.mjs";
import { buildDecision, computeBuildHash, readBuildMarker, writeBuildMarker } from "./build-marker.mjs";

/** Is a build needed? publicUrl is the APP_PUBLIC_URL the build would be made with. */
export function buildState({ publicUrl = "" } = {}) {
  return buildDecision({
    buildIdExists: fs.existsSync(PATHS.buildId),
    workerBundleExists: fs.existsSync(PATHS.workerBundle),
    workerBuildScriptExists: fs.existsSync(PATHS.buildWorkerScript),
    marker: readBuildMarker(PATHS.buildMarker),
    currentHash: computeBuildHash(ROOT, { publicUrl }),
  });
}

function run(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env });
  return r.status === 0;
}

/**
 * Builds everything. `env` should carry the settings the build must see (APP_PUBLIC_URL).
 * Returns { ok, message }. Never leaves a "fresh" marker behind a failed build.
 */
export function runBuild({ env = process.env, publicUrl = "", log = console.log } = {}) {
  const buildEnv = {
    ...env,
    APP_PUBLIC_URL: publicUrl,
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    DOTENV_CONFIG_QUIET: "true",
  };
  delete buildEnv.NODE_ENV; // next build sets it; a leftover "development" would break the build
  // Remove the marker first: if anything below fails, the next start knows the build is not usable.
  fs.rmSync(PATHS.buildMarker, { force: true });

  log("Preparing the database code (prisma generate)...");
  if (!run([PATHS.prismaCli, "generate"], buildEnv)) {
    return { ok: false, message: "Preparing the database code failed (prisma generate). The messages above say why." };
  }
  log("Building the screens (next build). This takes a few minutes...");
  if (!run([PATHS.nextCli, "build"], buildEnv)) {
    log("The first build attempt failed. Trying again with the slower, more compatible builder (webpack)...");
    if (!run([PATHS.nextCli, "build", "--webpack"], buildEnv)) {
      return { ok: false, message: "Building the screens failed (next build). The messages above say why." };
    }
  }
  if (fs.existsSync(PATHS.buildWorkerScript)) {
    log("Building the background sender...");
    if (!run([PATHS.buildWorkerScript], buildEnv)) {
      return { ok: false, message: "Building the background sender failed. The messages above say why." };
    }
  } else {
    log("The background sender has no build step yet, so start.bat will run it from its source files.");
  }
  if (!fs.existsSync(PATHS.buildId)) {
    return { ok: false, message: "The build finished but .next\\BUILD_ID is missing, so the build can't be used." };
  }
  writeBuildMarker(PATHS.buildMarker, computeBuildHash(ROOT, { publicUrl }), { node: process.versions.node });
  return { ok: true, message: "The app is built." };
}
