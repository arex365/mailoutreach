import path from "node:path";

/**
 * Environment access shared by the web app and the worker.
 * Next.js loads .env itself; the worker and scripts import "dotenv/config" first.
 */

/** Absolute path (forward slashes) of the SQLite file, resolved against the project root (cwd). */
export function databaseFilePath(): string {
  const url = process.env.DATABASE_URL || "file:./data/app.db";
  const raw = url.replace(/^file:/, "");
  const abs = path.isAbsolute(raw) ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
  return abs.replace(/\\/g, "/");
}

/** 32-byte key used to encrypt secrets stored in the database. */
export function encryptionKey(): Buffer {
  const b64 = process.env.APP_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error("APP_ENCRYPTION_KEY is missing from .env. Run setup.bat to create it.");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY in .env must be 32 bytes (base64). Run setup.bat again.");
  }
  return key;
}

/** Public https address of the app (Cloudflare Tunnel), or null while not set up yet. */
export function publicUrl(): string | null {
  const v = (process.env.APP_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return v ? v : null;
}

export function setupCodeHash(): string | null {
  const v = (process.env.SETUP_CODE_HASH || "").trim();
  return v ? v : null;
}

export const isProduction = process.env.NODE_ENV === "production";
