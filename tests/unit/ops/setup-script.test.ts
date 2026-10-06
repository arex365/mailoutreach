/**
 * Runs the real setup script (setup.bat's node part) against a temporary settings file and a
 * temporary database under data/test/ — never the project's .env or data/app.db.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnvValue, isValidEncryptionKey } from "../../../scripts/lib/env-file.mjs";
import { hashSetupCode } from "../../../scripts/lib/setup-code.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `setup-${process.pid}-${Date.now()}`);
const envFile = path.join(dir, "settings.env");
const dbFile = path.join(dir, "setup.db");
const abiFile = path.join(dir, ".node-abi");
const realEnv = path.join(ROOT, ".env");
const realDb = path.join(ROOT, "data", "app.db");
const realAbi = path.join(ROOT, "data", ".node-abi");

const fingerprint = (file: string) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing");

function runSetup(extra: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const k of ["DATABASE_URL", "APP_ENCRYPTION_KEY", "APP_PUBLIC_URL", "SETUP_CODE_HASH"]) delete env[k];
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "setup.mjs"), "--", "--env-file", envFile, "--db", dbFile, "--abi-file", abiFile, "--no-build", "--no-pause", ...extra],
    { cwd: ROOT, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const readEnv = () => fs.readFileSync(envFile, "utf8");
const CODE_RE = /\b([0-9A-Z]{5}(?:-[0-9A-Z]{1,5}){5})\b/;

let realEnvBefore = "";
let realDbBefore = "";
let realAbiMtimeBefore: number | null = null;

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true });
  realEnvBefore = fingerprint(realEnv);
  realDbBefore = fingerprint(realDb);
  realAbiMtimeBefore = fs.existsSync(realAbi) ? fs.statSync(realAbi).mtimeMs : null;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("setup.mjs end to end (temporary files)", () => {
  let key = "";
  let firstHash = "";

  // The first run creates the database (prisma migrate deploy), which can take more than the default 20 s while the
  // whole suite runs in parallel.
  it("creates the settings file and the database, and prints a setup code", { timeout: 90_000 }, () => {
    const r = runSetup();
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(envFile)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);

    const text = readEnv();
    key = getEnvValue(text, "APP_ENCRYPTION_KEY") ?? "";
    expect(isValidEncryptionKey(key)).toBe(true);
    expect(getEnvValue(text, "DATABASE_URL")).toBe(`file:./${path.relative(ROOT, dbFile).split(path.sep).join("/")}`);
    expect(getEnvValue(text, "APP_PUBLIC_URL")).toBe("");

    const code = r.out.match(CODE_RE)?.[1];
    expect(code, r.out).toBeTruthy();
    firstHash = getEnvValue(text, "SETUP_CODE_HASH") ?? "";
    expect(firstHash).toBe(hashSetupCode(code!));
    expect(r.out).toContain("double-click start.bat");
    expect(r.out).toContain("http://localhost:3000");
    expect(r.out).not.toContain("Setup is already done");

    // The Node ABI was recorded (in the temporary file, not data\.node-abi).
    expect(fs.readFileSync(abiFile, "utf8").trim()).toBe(process.versions.modules);

    // The migrations were applied.
    const db = new Database(dbFile, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    db.close();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["User", "Company", "_prisma_migrations"]));
  });

  it("keeps the key on a second run and makes a new code while nobody has signed up", () => {
    // Ten wrong codes were typed meanwhile: the app would refuse every code for an hour.
    const db = new Database(dbFile);
    const insert = db.prepare('INSERT INTO "LoginAttempt" (emailNorm, sourceKey, success, at) VALUES (?, ?, 0, ?)');
    for (let i = 0; i < 10; i++) insert.run("__setup__", "lan:192.168.1.50", Date.now());
    insert.run("someone@example.com", "lan:192.168.1.50", Date.now());
    db.close();

    const r = runSetup();
    expect(r.status, r.out).toBe(0);
    const text = readEnv();
    expect(getEnvValue(text, "APP_ENCRYPTION_KEY")).toBe(key);
    const code = r.out.match(CODE_RE)?.[1];
    expect(code).toBeTruthy();
    const hash = getEnvValue(text, "SETUP_CODE_HASH");
    expect(hash).toBe(hashSetupCode(code!));
    expect(hash).not.toBe(firstHash);
    expect(r.out).not.toContain("Setup is already done");
    expect(r.out).toContain("up to date");

    // The new code starts with a clean slate; other sign-in attempts are kept.
    const check = new Database(dbFile, { readonly: true });
    const left = check.prepare('SELECT emailNorm FROM "LoginAttempt"').all() as { emailNorm: string }[];
    check.close();
    expect(left).toEqual([{ emailNorm: "someone@example.com" }]);
  });

  it("writes the new code where the app reads it when a setting is in the file twice", () => {
    // Someone pasted a second SETUP_CODE_HASH line at the end: the app (dotenv) uses the last one.
    fs.writeFileSync(envFile, readEnv() + 'SETUP_CODE_HASH="pasted-by-hand"\r\n');
    const r = runSetup();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("more than once");
    const text = readEnv();
    const code = r.out.match(CODE_RE)?.[1];
    expect(dotenv.parse(text).SETUP_CODE_HASH).toBe(hashSetupCode(code!));
    expect(text.match(/^SETUP_CODE_HASH=/gm)).toHaveLength(1);
    expect(dotenv.parse(text).APP_ENCRYPTION_KEY).toBe(key);
  });

  it("says 'Setup is already done' once a user exists, and changes nothing", () => {
    const db = new Database(dbFile);
    db.prepare(
      `INSERT INTO "User" (email, name, role, signature, timeZone, active, createdAt, updatedAt)
       VALUES ('owner@example.com', 'Owner', 'OWNER', '', 'Asia/Karachi', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.close();
    const before = readEnv();
    const r = runSetup();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Setup is already done");
    expect(r.out).not.toMatch(CODE_RE);
    expect(readEnv()).toBe(before);
  });

  it("updates only the public address line when one is given", () => {
    const before = readEnv().split(/\r?\n/);
    const r = runSetup(["--public-url", "https://outreach.example.com/"]);
    expect(r.status, r.out).toBe(0);
    const after = readEnv().split(/\r?\n/);
    expect(after).toHaveLength(before.length);
    after.forEach((line, i) => {
      if (line.startsWith("APP_PUBLIC_URL=")) expect(line).toBe('APP_PUBLIC_URL="https://outreach.example.com"');
      else expect(line).toBe(before[i]);
    });
    expect(r.out).toContain("--no-build");
  });

  it("refuses a public address that isn't https, without changing anything", () => {
    const before = readEnv();
    const r = runSetup(["--public-url", "http://outreach.example.com"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("https://");
    expect(readEnv()).toBe(before);
  });

  it("adds a missing key to an existing settings file but never replaces one", () => {
    fs.writeFileSync(envFile, readEnv().replace(/^APP_ENCRYPTION_KEY=.*$/m, 'APP_ENCRYPTION_KEY=""'));
    expect(runSetup().status).toBe(0);
    const added = getEnvValue(readEnv(), "APP_ENCRYPTION_KEY") ?? "";
    expect(isValidEncryptionKey(added)).toBe(true);
    expect(runSetup().status).toBe(0);
    expect(getEnvValue(readEnv(), "APP_ENCRYPTION_KEY")).toBe(added);
  });

  it("never touched the project's real .env, data/app.db or data/.node-abi", () => {
    expect(fingerprint(realEnv)).toBe(realEnvBefore);
    expect(fingerprint(realDb)).toBe(realDbBefore);
    expect(fs.existsSync(realAbi) ? fs.statSync(realAbi).mtimeMs : null).toBe(realAbiMtimeBefore);
  });
});
