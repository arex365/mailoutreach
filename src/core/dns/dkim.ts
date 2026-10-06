// Server only: uses node:crypto (the domain check in the worker, and the tests; never the browser).
import { createPublicKey } from "node:crypto";

/**
 * DKIM record reading (RFC 6376; research deliverability-dns.md row 3, M3-DESIGN §4.1.9). Mailgun signs with either
 * a TXT key record (`<selector>._domainkey`) or, with Automatic Sender Security, two CNAMEs pointing at Mailgun.
 * The expected values always come from Mailgun's record list; this file only compares and measures.
 */

/** The `p=` value of a DKIM TXT record with all whitespace removed, or null when there is none (or it is empty: a revoked key). */
export function dkimPublicKey(record: string): string | null {
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "p") continue;
    const value = part.slice(eq + 1).replace(/\s+/g, "");
    return value ? value : null;
  }
  return null;
}

/**
 * The key size of an RSA DKIM public key (base64, as in `p=`): 1024, 2048, …; null when it isn't a readable RSA key.
 * Reads the usual SubjectPublicKeyInfo form, and the bare PKCS#1 form some DNS hosts publish.
 */
export function dkimKeyBits(p: string): number | null {
  const clean = p.replace(/\s+/g, "");
  if (!clean || !/^[A-Za-z0-9+/]+=*$/.test(clean)) return null;
  const der = Buffer.from(clean, "base64");
  for (const type of ["spki", "pkcs1"] as const) {
    try {
      const key = createPublicKey({ key: der, format: "der", type });
      if (key.asymmetricKeyType !== "rsa") return null;
      const bits = key.asymmetricKeyDetails?.modulusLength;
      return typeof bits === "number" && bits > 0 ? bits : null;
    } catch {
      // Try the next form.
    }
  }
  return null;
}

/** True when a CNAME answer points at the expected target (case-insensitive, trailing dots ignored). */
export function sameCnameTarget(found: string, expected: string): boolean {
  const clean = (v: string) => v.trim().toLowerCase().replace(/\.+$/, "");
  const a = clean(found);
  return a !== "" && a === clean(expected);
}
