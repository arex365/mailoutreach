import { z } from "zod";

/** Punycode conversion that works in the browser and in Node (WHATWG URL). */
function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return "";
  }
}

/**
 * Email address parsing and normalisation (PLAN.md B6.13).
 * - We never rewrite the local part (no Gmail dot/plus tricks): the address we store is the address we send to.
 * - The domain is lowercased and converted to punycode (æøå.no → xn--…).
 * - norm = full address lowercased: the dedupe key.
 */

export type ParsedEmail = {
  email: string; // address to send to
  norm: string; // lowercase dedupe key
  local: string;
  domain: string;
  displayName: string | null;
};

const emailSchema = z.email();

export function parseEmail(input: string | null | undefined): ParsedEmail | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  let displayName: string | null = null;
  // "Name <addr@x.com>"
  const angle = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (angle) {
    displayName = angle[1]!.trim() || null;
    s = angle[2]!.trim();
  }
  s = s.replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim();
  s = s.replace(/[\s,;:.)\]]+$/, "").replace(/^[\s(\[]+/, "");
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  const rawDomain = s.slice(at + 1).toLowerCase();
  const domain = domainToASCII(rawDomain);
  if (!domain) return null;
  const email = `${local}@${domain}`;
  if (!emailSchema.safeParse(email).success) return null;
  return { email, norm: email.toLowerCase(), local, domain, displayName };
}

export function normalizeEmail(input: string | null | undefined): string | null {
  return parseEmail(input)?.norm ?? null;
}

/** Local parts that belong to a shared inbox rather than a person ("General inbox"). */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "info", "contact", "kontakt", "hello", "hallo", "hei", "hey", "hi", "post", "postmottak", "firmapost",
  "mail", "email", "e-mail", "office", "buero", "buro", "bureau", "sales", "salg", "verkauf", "vertrieb",
  "support", "service", "kundeservice", "kundenservice", "customerservice", "team", "admin", "booking",
  "bestilling", "order", "orders", "bestellung", "bestellungen", "anfrage", "anfragen", "enquiries",
  "enquiry", "inquiries", "inquiry", "studio", "shop", "store", "butikk", "print", "druck", "marketing",
  "press", "presse", "jobs", "career", "careers", "hr", "billing", "invoice", "accounts", "general",
  "welcome", "mail.info", "noreply", "no-reply", "webmaster", "hostmaster", "postmaster",
]);

export function isRoleAddress(localOrEmail: string): boolean {
  const local = (localOrEmail.includes("@") ? localOrEmail.split("@")[0]! : localOrEmail).toLowerCase();
  if (ROLE_LOCAL_PARTS.has(local)) return true;
  const base = local.split(/[+._-]/)[0] ?? local;
  return ROLE_LOCAL_PARTS.has(base) && base.length >= 4;
}

/** The name shown for a role address person. */
export const GENERAL_INBOX_NAME = "General inbox";
