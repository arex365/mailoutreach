import { db } from "@/server/db";
import { getSettings } from "@/server/settings";

/**
 * "Is Mailgun set up?" for the dashboard (M6-DESIGN §4.6, critique R8). `getMailgunContext` decrypts the keys and may
 * write a SendingDomain row, which the dashboard must never do (§0.2 rule 8), so this reads only a setting and
 * whether a Secret row exists.
 */

/**
 * True on real data with a sending domain saved and a Mailgun API key row: no decryption (a key that can't be read
 * still counts as set up here; Settings › Sending & Mailgun says what's wrong with it), no write, no network.
 */
export async function mailgunConfigured(): Promise<boolean> {
  const s = await getSettings(["practice.copy", "mailgun.domain"] as const);
  if (s["practice.copy"] === true) return false;
  if (!(s["mailgun.domain"] ?? "").trim()) return false;
  const key = await db.secret.findUnique({ where: { key: "mailgun.apiKey" }, select: { key: true } });
  return key !== null;
}
