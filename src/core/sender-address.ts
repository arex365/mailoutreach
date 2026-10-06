import { isSharedDomain } from "@/core/shared-domains";
import { firstNameFrom, normalizeText } from "@/core/text";
import { ROUTE_CHECK_LOCAL_PREFIX } from "@/core/mailgun/routes";
import type { RepliesMode } from "@/core/sending/own-mailbox";

/**
 * Sender identity rules (PLAN B10, M3-DESIGN §4.5.7): the name before the @ of each teammate's sending address, and the
 * sending domain itself (§2.1). Pure and browser-safe, so My profile and Settings › Sending & Mailgun can check as you
 * type with exactly the rules the server applies.
 */

/**
 * Local parts kept for mail servers, the app's own routes and shared inboxes. A sender using one would receive (or
 * swallow) mail meant for the domain itself: postmaster@ and abuse@ are required by the mail standards, dmarc@ has its
 * own route, pp-route-check is the route probe.
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "postmaster",
  "abuse",
  "admin",
  "administrator",
  "hostmaster",
  "webmaster",
  "root",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "dmarc",
  "bounce",
  "bounces",
  "unsubscribe",
  "u",
  "mail",
  "email",
  "info",
  "support",
  "sales",
  "hello",
  "contact",
  ROUTE_CHECK_LOCAL_PREFIX,
]);

export const LOCAL_PART_TEXTS = {
  empty: "Choose the name before the @, for example ali.",
  invalid: "Use letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.",
} as const;

/** "<x> is kept for mail servers and can't be a sender address. Pick another name, for example your first name." */
export function reservedLocalPartText(localPart: string): string {
  return `${localPart} is kept for mail servers and can't be a sender address. Pick another name, for example your first name.`;
}

const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** True for a reserved local part, including anything that starts like the route probe ("pp-route-check-…"). */
export function isReservedLocalPart(localPart: string): boolean {
  const l = localPart.trim().toLowerCase();
  return RESERVED_LOCAL_PARTS.has(l) || l.startsWith(`${ROUTE_CHECK_LOCAL_PREFIX}-`);
}

/**
 * The name before the @: trimmed and lowercased; 1–64 characters of a–z, 0–9, dots, dashes and underscores, starting and
 * ending with a letter or number, no "..", and not reserved.
 */
export function validateLocalPart(input: string): { ok: true; localPart: string } | { ok: false; error: string } {
  const localPart = (input ?? "").trim().toLowerCase();
  if (!localPart) return { ok: false, error: LOCAL_PART_TEXTS.empty };
  if (!LOCAL_PART_PATTERN.test(localPart) || localPart.includes("..")) return { ok: false, error: LOCAL_PART_TEXTS.invalid };
  if (isReservedLocalPart(localPart)) return { ok: false, error: reservedLocalPartText(localPart) };
  return { ok: true, localPart };
}

/** Turns any text into the allowed characters: "Ali Khan" → "ali.khan", "Åse" → "ase". */
function cleanLocalPart(text: string): string {
  return normalizeText(text)
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64)
    .replace(/[._-]+$/g, "");
}

/**
 * A good first suggestion for the sending address: the person's first name ("Ali Khan" → "ali"), else the part
 * before the @ of their sign-in email, else "sender". Never a reserved or invalid local part.
 */
export function suggestedLocalPart(name: string, loginEmail: string): string {
  const candidates = [cleanLocalPart(firstNameFrom(name) || name), cleanLocalPart((loginEmail ?? "").split("@")[0] ?? "")];
  for (const c of candidates) {
    const v = validateLocalPart(c);
    if (v.ok) return v.localPart;
  }
  return "sender";
}

/**
 * The owner's own website domains: never the sending domain in app mode (§2.1, PLAN A4). They can still be the domain of
 * the shared From address, when the sending domain is their subdomain (SHARED-FROM-DESIGN §2.2, §2.5). In own-mailbox
 * mode polygonparadise.com itself may be the sending domain (MAIN-DOMAIN-DESIGN O7); its MX never points to Mailgun.
 */
export const WEBSITE_DOMAINS: ReadonlySet<string> = new Set(["polygonparadise.com", "www.polygonparadise.com"]);

export const SENDING_DOMAIN_TEXTS = {
  empty: "Enter the sending domain you added in Mailgun, for example mail.polygonparadise.com.",
  invalid: "That isn't a domain name. Enter it the way Mailgun shows it, for example mail.polygonparadise.com.",
  /**
   * App mode, the website domain typed (MAIN-DOMAIN-DESIGN O30, replacing SHARED-FROM-DESIGN F30's sentence): names the
   * "How the app sends" choice, so the owner's own domain is one click away (own-mailbox mode) without overruling it.
   */
  website:
    "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4).",
  /** SHARED-FROM-DESIGN F30: Mailgun's sandbox domains (mailgun.org and *.mailgun.org) are for Mailgun's own tests. */
  sandbox:
    "That's Mailgun's sandbox domain, for tests only. Type mail.polygonparadise.com (add it in Mailgun first: Send › Domains › Add new domain).",
  shared: "That domain belongs to an email provider. Use your own sending domain, for example mail.polygonparadise.com.",
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN O7, §2.2): every example is polygonparadise.com, never mail.polygonparadise.com.
  www: "Type your domain without www., for example polygonparadise.com.",
  emptyOwn: "Enter the domain you send from, exactly as Mailgun shows it, for example polygonparadise.com.",
  invalidOwn: "That isn't a domain name. Enter it the way Mailgun shows it, for example polygonparadise.com.",
  sandboxOwn:
    "That's Mailgun's sandbox domain, for tests only. Type polygonparadise.com, the domain Mailgun lists under Send › Domains next to it.",
  sharedOwn: "That domain belongs to an email provider. Type your own domain, for example polygonparadise.com.",
} as const;

/**
 * Setting "mailgun.domain" (§2.1): a lowercase host name with 2+ labels of a–z, 0–9 and dashes (no leading or trailing
 * dash, each ≤ 63), ≤ 253 characters; not polygonparadise.com or www.polygonparadise.com; not Mailgun's sandbox
 * (mailgun.org or *.mailgun.org, SHARED-FROM-DESIGN F30); not a shared or free-mail domain (gmail.com …). A trailing dot
 * and "https://" pasted with it are forgiven.
 *
 * Own-mailbox mode (`opts.replies === "own-mailbox"`, MAIN-DOMAIN-DESIGN O7, §2.2): the same rules in the same order with
 * the `…Own` sentences, except that a name starting with "www." is refused (`www`) and a website domain without "www."
 * is allowed. Absent or "app": exactly today's rules and sentences.
 */
export function validateSendingDomain(
  input: string,
  opts: { replies?: RepliesMode } = {},
): { ok: true; domain: string } | { ok: false; error: string } {
  const own = opts.replies === "own-mailbox";
  const T = SENDING_DOMAIN_TEXTS;
  let d = (input ?? "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.+$/, "");
  if (!d) return { ok: false, error: own ? T.emptyOwn : T.empty };
  const invalid = own ? T.invalidOwn : T.invalid;
  if (d.length > 253) return { ok: false, error: invalid };
  const labels = d.split(".");
  if (labels.length < 2) return { ok: false, error: invalid };
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { ok: false, error: invalid };
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return { ok: false, error: invalid };
  if (own) {
    if (d.startsWith("www.")) return { ok: false, error: T.www };
  } else if (WEBSITE_DOMAINS.has(d)) {
    return { ok: false, error: T.website };
  }
  if (d === "mailgun.org" || d.endsWith(".mailgun.org")) return { ok: false, error: own ? T.sandboxOwn : T.sandbox };
  if (isSharedDomain(d)) return { ok: false, error: own ? T.sharedOwn : T.shared };
  return { ok: true, domain: d };
}
