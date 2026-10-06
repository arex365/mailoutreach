// Creates a one-time setup code for the first Owner account and stores only its
// SHA-256 in .env (SETUP_CODE_HASH). Used by setup.bat (scripts/setup.mjs).
// Never touches APP_ENCRYPTION_KEY or any other line.
import crypto from "node:crypto";
import fs from "node:fs";
import { setEnvValue, writeFileAtomic } from "./env-file.mjs";
import { openDatabase } from "./sqlite.mjs";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // Crockford-ish, no I/L/O/U

export function generateSetupCode() {
  const bytes = crypto.randomBytes(16); // 128 bits
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  // 26 characters → 5 groups for reading aloud / typing.
  return out.match(/.{1,5}/g).join("-");
}

/** Same normalisation as the app uses when checking the code. */
export function normalizeSetupCode(code) {
  return String(code)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function hashSetupCode(code) {
  return crypto.createHash("sha256").update(normalizeSetupCode(code), "utf8").digest("hex");
}

/**
 * Replaces (or adds) the SETUP_CODE_HASH line in the given .env file. When the key is there more
 * than once, the last line is the one the app reads, so that one is replaced (earlier ones become
 * comments). Every other line stays exactly as it was.
 */
export function writeSetupCodeHash(envPath, hash) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  writeFileAtomic(envPath, setEnvValue(text, "SETUP_CODE_HASH", hash));
}

/** The app records wrong setup codes as sign-in attempts under this name (src/app/(auth)/actions.ts). */
export const SETUP_ATTEMPT_KEY = "__setup__";

/**
 * Forgets the wrong setup-code attempts, because a new code has just been made: tries with an
 * older code must not block the Owner from using the new one. Returns how many were removed.
 */
export async function clearSetupCodeAttempts(dbFile) {
  const db = await openDatabase(dbFile);
  try {
    const r = db.run('DELETE FROM "LoginAttempt" WHERE "emailNorm" = ?', SETUP_ATTEMPT_KEY);
    return Number(r?.changes ?? 0);
  } finally {
    db.close();
  }
}
