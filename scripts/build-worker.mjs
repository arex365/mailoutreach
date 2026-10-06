// Builds the background sender: worker/index.ts → dist/worker.mjs (PLAN.md B1, B2 "Milestone 1 spike").
//
//   node scripts/build-worker.mjs            build + self-test against a temporary database
//   node scripts/build-worker.mjs --no-test  build only
//
// The bundle keeps every npm package external (Prisma's runtime, better-sqlite3, dotenv) and bundles
// our own code, including the generated Prisma client in src/generated/prisma.
// If the bundle can't talk to the database, dist/worker.mjs becomes a small launcher that runs
// worker/index.ts through tsx instead, so the service command (node dist\worker.mjs) never changes.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "dist", "worker.mjs");
const skipTest = process.argv.includes("--no-test");

const say = (msg) => console.log(`[build-worker] ${msg}`);

const BANNER = [
  "// Polygon Paradise Outreach — background sender. Built by scripts/build-worker.mjs; don't edit.",
  'import { createRequire as __outreachCreateRequire } from "node:module";',
  "const require = __outreachCreateRequire(import.meta.url);",
].join("\n");

const LAUNCHER = `// Polygon Paradise Outreach — background sender (launcher).
// Written by scripts/build-worker.mjs because the esbuild bundle couldn't reach the database.
// It runs worker/index.ts directly through tsx; the service command stays "node dist\\worker.mjs".
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register({ tsconfig: path.join(root, "tsconfig.worker.json") });
await import(pathToFileURL(path.join(root, "worker", "index.ts")).href);
`;

async function bundle() {
  const { build } = await import("esbuild");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "worker", "index.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    sourcemap: true,
    tsconfig: path.join(root, "tsconfig.worker.json"),
    banner: { js: BANNER },
    logLevel: "warning",
    legalComments: "none",
  });
}

function writeLauncher() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, LAUNCHER, "utf8");
  fs.rmSync(outFile + ".map", { force: true });
}

/** Creates a throw-away database under data\test\ with every migration applied. */
function createTempDatabase() {
  const dir = path.join(root, "data", "test");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `build-worker-${process.pid}-${Date.now()}.db`);
  const url = "file:" + file.replace(/\\/g, "/");
  execFileSync(process.execPath, [path.join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  return {
    url,
    cleanup() {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true });
    },
  };
}

/** Runs `node dist/worker.mjs --self-test` against the temporary database. */
function selfTest(url) {
  const res = spawnSync(process.execPath, [outFile, "--self-test"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url, DOTENV_QUIET: "true" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return { ok: res.status === 0 && output.includes("worker self-test ok"), output, status: res.status };
}

async function main() {
  let bundled = true;
  try {
    await bundle();
    say(`Bundled worker/index.ts → ${path.relative(root, outFile)}`);
  } catch (err) {
    bundled = false;
    say(`Bundling failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (skipTest) {
    if (!bundled) {
      writeLauncher();
      say("NOTE: dist/worker.mjs is the tsx launcher (runs worker/index.ts directly).");
    }
    return 0;
  }

  let db;
  try {
    db = createTempDatabase();
  } catch (err) {
    say(`Couldn't create a temporary database for the self-test: ${err instanceof Error ? err.message : String(err)}`);
    if (!bundled) writeLauncher();
    return 1;
  }
  try {
    if (bundled) {
      const first = selfTest(db.url);
      if (first.ok) {
        say("Self-test passed: the bundle reaches the database through Prisma.");
        return 0;
      }
      say(`The bundle's self-test failed (exit ${first.status}):\n${first.output}`);
    }
    writeLauncher();
    say("NOTE: falling back to the tsx launcher: dist/worker.mjs now runs worker/index.ts through tsx.");
    const second = selfTest(db.url);
    if (second.ok) {
      say("Self-test passed with the tsx launcher.");
      return 0;
    }
    say(`The launcher's self-test failed too (exit ${second.status}):\n${second.output}`);
    return 1;
  } finally {
    db.cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
