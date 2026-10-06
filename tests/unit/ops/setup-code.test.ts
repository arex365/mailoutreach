/**
 * The one-time setup code: where its hash is written in .env (the line the app really reads),
 * and forgetting the wrong tries with older codes when setup.bat makes a new one.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrlFor, getEnvValue } from "../../../scripts/lib/env-file.mjs";
import { runMigrateDeploy } from "../../../scripts/lib/migrations.mjs";
import { SETUP_ATTEMPT_KEY, clearSetupCodeAttempts, hashSetupCode, writeSetupCodeHash } from "../../../scripts/lib/setup-code.mjs";

const ROOT = path.resolve(".");
const dir = path.join(ROOT, "data", "test", `setup-code-${process.pid}-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeSetupCodeHash", () => {
  it("replaces the last SETUP_CODE_HASH line, so the app (dotenv, last line wins) accepts the new code", () => {
    const file = path.join(dir, "dup.env");
    fs.writeFileSync(file, 'DATABASE_URL="file:./data/app.db"\r\nSETUP_CODE_HASH=""\r\nAPP_PUBLIC_URL=""\r\nSETUP_CODE_HASH="stale"\r\n');
    const hash = hashSetupCode("ABCDE-FGHJK");
    writeSetupCodeHash(file, hash);
    const text = fs.readFileSync(file, "utf8");
    expect(dotenv.parse(text).SETUP_CODE_HASH).toBe(hash);
    expect(getEnvValue(text, "SETUP_CODE_HASH")).toBe(hash);
    // Every other line is kept; the line ending style too.
    expect(text).toContain('DATABASE_URL="file:./data/app.db"\r\n');
    expect(text).toContain('APP_PUBLIC_URL=""\r\n');
    expect(text.match(/^SETUP_CODE_HASH=/gm)).toHaveLength(1);
  });

  it("adds the line when it's missing", () => {
    const file = path.join(dir, "missing.env");
    fs.writeFileSync(file, 'DATABASE_URL="file:./data/app.db"\n');
    writeSetupCodeHash(file, "abc");
    expect(fs.readFileSync(file, "utf8")).toBe('DATABASE_URL="file:./data/app.db"\nSETUP_CODE_HASH="abc"\n');
  });
});

describe("clearSetupCodeAttempts", () => {
  it("removes only the wrong setup-code tries", { timeout: 60_000 }, async () => {
    const dbFile = path.join(dir, "attempts.db");
    const r = runMigrateDeploy(databaseUrlFor(dbFile, ROOT));
    expect(r.ok, r.output).toBe(true);
    const db = new Database(dbFile);
    const insert = db.prepare('INSERT INTO "LoginAttempt" (emailNorm, sourceKey, success, at) VALUES (?, ?, 0, ?)');
    for (let i = 0; i < 10; i++) insert.run(SETUP_ATTEMPT_KEY, `lan:10.0.0.${i}`, Date.now());
    insert.run("owner@example.com", "lan:10.0.0.9", Date.now());
    db.close();

    expect(await clearSetupCodeAttempts(dbFile)).toBe(10);

    const check = new Database(dbFile, { readonly: true });
    const rows = check.prepare('SELECT emailNorm FROM "LoginAttempt"').all() as { emailNorm: string }[];
    check.close();
    expect(rows).toEqual([{ emailNorm: "owner@example.com" }]);
    expect(await clearSetupCodeAttempts(dbFile)).toBe(0);
  });
});
