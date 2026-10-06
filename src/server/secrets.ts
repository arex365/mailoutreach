import crypto from "node:crypto";
import { db, dbWrite } from "./db";
import { encryptionKey } from "./env";

/**
 * Secrets (API keys, webhook signing key) stored encrypted with AES-256-GCM.
 * Format: "v1:" + base64(iv 12) + ":" + base64(tag 16) + ":" + base64(ciphertext).
 * The secret's name is used as additional authenticated data, so values can't be swapped.
 * Never return decrypted values to the browser — use secretInfo() for display.
 */

export type SecretKey =
  | "mailgun.apiKey"
  | "mailgun.sendingKey"
  | "mailgun.webhookSigningKey"
  | "verification.apiKey"
  | "anthropic.apiKey";

export function encryptSecret(name: string, plaintext: string, key = encryptionKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(name: string, stored: string, key = encryptionKey()): string {
  const [version, ivB64, tagB64, ctB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error(`Secret "${name}" has an unknown format.`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export async function setSecret(name: SecretKey, value: string, userId: number | null): Promise<void> {
  const trimmed = value.trim();
  const ciphertext = encryptSecret(name, trimmed);
  const last4 = trimmed.slice(-4);
  await dbWrite((c) =>
    c.secret.upsert({
      where: { key: name },
      create: { key: name, ciphertext, last4, updatedById: userId },
      update: { ciphertext, last4, updatedById: userId },
    }),
  );
}

export async function deleteSecret(name: SecretKey): Promise<void> {
  await dbWrite((c) => c.secret.deleteMany({ where: { key: name } }));
}

/** Server-side only. Returns null when the secret isn't set. */
export async function getSecret(name: SecretKey): Promise<string | null> {
  const row = await db.secret.findUnique({ where: { key: name } });
  if (!row) return null;
  return decryptSecret(name, row.ciphertext);
}

/** Safe to show in the UI: whether it's set, its last 4 characters and when it changed. */
export async function secretInfo(name: SecretKey) {
  const row = await db.secret.findUnique({
    where: { key: name },
    select: { last4: true, updatedAt: true, updatedById: true },
  });
  return row ? { set: true as const, ...row } : { set: false as const };
}
