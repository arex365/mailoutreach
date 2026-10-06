import { normalizeEmail } from "@/core/email-address";
import { extractMessageIds, headerValues } from "@/core/mailgun/inbound";
import type { HeaderPair } from "./types";

/**
 * What a received message points at (M4-DESIGN §3.3.1, §3.3.2): the Message-IDs of its thread, our own ids quoted in
 * a delivery-failure notice, the addresses such a notice names, and the addresses a challenge-response message names.
 * The processor (P4) looks these up in the database. Pure and browser-safe.
 */

/** At most this many thread ids are looked up. */
export const MAX_THREAD_IDS = 50;
/** At most this many ids or addresses are taken from one text. */
const MAX_FOUND = 50;
/** Texts are read up to this length (the stored body-plain is at most 16,000 characters). */
const TEXT_MAX = 16_000;

/** Ids from a header value, a stored space-separated list, or an array of either. */
function idsOf(v: string | readonly string[] | null | undefined): string[] {
  if (!v) return [];
  const parts = typeof v === "string" ? [v] : v;
  const out: string[] = [];
  for (const part of parts) if (typeof part === "string") out.push(...extractMessageIds(part));
  return out;
}

/**
 * The thread ids of a message, most specific first: In-Reply-To, then References newest → oldest. Lowercase, no angle
 * brackets, de-duplicated, at most 50. Accepts the stored forms (bare ids, space-separated) and raw header values.
 */
export function threadIds(m: { inReplyTo: string | null; references: string | readonly string[] | null }): string[] {
  const ids = [...idsOf(m.inReplyTo), ...idsOf(m.references).reverse()];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_THREAD_IDS) break;
  }
  return out;
}

const OUR_ID = /pp\.[0-9a-f]{24}@[a-z0-9.-]+/gi;

/**
 * Our own Message-IDs found in a text (bounce notices quote the original headers): `pp.<24 hex>@domain`, lowercase,
 * in order, without duplicates.
 */
export function bodyMessageIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.slice(0, TEXT_MAX).matchAll(OUR_ID)) {
    const id = m[0].toLowerCase().replace(/[.-]+$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_FOUND) break;
  }
  return out;
}

const EMAIL_SOURCE =
  "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~.-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+";

/**
 * The email addresses written in a text, in order: normalised (lowercase, punycode domain), valid, unique. Web links
 * are skipped first, so "https://x.example/a@b" names nobody.
 */
export function findEmailAddresses(text: string | null | undefined, max = MAX_FOUND): string[] {
  if (!text) return [];
  const plain = text.slice(0, TEXT_MAX).replace(/https?:\/\/\S+/gi, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of plain.matchAll(new RegExp(EMAIL_SOURCE, "gu"))) {
    const norm = normalizeEmail(m[0].replace(/^[.]+/, ""));
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= max) break;
  }
  return out;
}

const LEADING_ADDRESS = new RegExp(`^<?(?:mailto:)?(${EMAIL_SOURCE})>?(?=$|[\\s:;,(<\\[])`, "iu");
const LEADING_NAMED_ADDRESS = new RegExp(`^[^@:<>()\\n]{1,80}[(<]\\s*(?:mailto:)?(${EMAIL_SOURCE})\\s*[)>]`, "iu");

/** The address a line starts with: "anna@firma.de", "<anna@firma.de>: host …", "Anna Berg (anna@firma.de)". */
function leadingAddress(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const hit = LEADING_ADDRESS.exec(t)?.[1] ?? LEADING_NAMED_ADDRESS.exec(t)?.[1];
  return hit ? normalizeEmail(hit) : null;
}

/** A line that introduces the failed addresses on the lines below it. */
const BOUNCE_INTRO =
  /delivery has failed to these recipients or groups|delivered to one or more|the following addresses? failed|the following address\(es\) failed|delivery to the following recipients? failed|konnte nicht zugestellt werden an|zustellung an folgende empfänger oder gruppen ist fehlgeschlagen|kunne ikke leveres til/iu;
/** The failed address on the same line as the sentence. */
const BOUNCE_INLINE = new RegExp(
  `(?:wasn't|was not|couldn't be|could not be|konnte nicht) (?:delivered|zugestellt werden) (?:to|an)\\s*:?\\s*<?(?:mailto:)?(${EMAIL_SOURCE})`,
  "giu",
);
const FINAL_RECIPIENT = new RegExp(`^\\s*final-recipient\\s*:\\s*rfc822\\s*;\\s*<?(${EMAIL_SOURCE})`, "gimu");

/**
 * The addresses a delivery-failure notice names (M4-DESIGN §3.3.1): `X-Failed-Recipients`, "Final-Recipient: rfc822; x",
 * the address lines after "Delivery has failed to these recipients or groups:" (and the same introductions from Exim,
 * Postfix and German Exchange), "wasn't delivered to x", and the addresses after "delivered to one or more …".
 * Normalised, unique, headers first. Empty when the notice names nobody.
 */
export function bounceRecipients(input: { headers: readonly HeaderPair[]; text: string | null }): string[] {
  const found: string[] = [];
  for (const v of headerValues(input.headers ?? [], "X-Failed-Recipients")) found.push(...findEmailAddresses(v));
  const text = (input.text ?? "").slice(0, TEXT_MAX).replace(/\r\n?/g, "\n");
  for (const m of text.matchAll(FINAL_RECIPIENT)) {
    const a = normalizeEmail(m[1]);
    if (a) found.push(a);
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(BOUNCE_INLINE)) {
      const a = normalizeEmail(m[1]);
      if (a) found.push(a);
    }
    if (!BOUNCE_INTRO.test(line)) continue;
    // The addresses follow on their own lines, possibly after blank lines or a short explanation (Postfix).
    let collected = 0;
    let looked = 0;
    for (let j = i + 1; j < lines.length && looked < 12; j++) {
      const next = lines[j]!;
      if (!next.trim()) continue;
      looked++;
      const a = leadingAddress(next);
      if (a) {
        found.push(a);
        collected++;
      } else if (collected > 0) break;
    }
  }
  return [...new Set(found)].slice(0, MAX_FOUND);
}

/**
 * The addresses a challenge-response message names (M4-DESIGN §3.3.2): in its subject and in the first 10 non-empty
 * lines of its new text (`extractNewText`). Normalised, unique, subject first.
 */
export function namedRecipients(input: { subject: string; text: string | null }): string[] {
  const head = (input.text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 10)
    .join("\n");
  return [...new Set([...findEmailAddresses(input.subject ?? ""), ...findEmailAddresses(head)])];
}
