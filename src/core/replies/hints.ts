import { GENERAL_INBOX_NAME, normalizeEmail } from "@/core/email-address";
import { usableEmailDomain } from "@/core/shared-domains";
import { findEmailAddresses } from "./link-ids";
import { BOUNCE_LOCALPART, NOREPLY_LOCALPART } from "./phrases";

/**
 * Hints for a reply nobody could link (M4-DESIGN §3.3.5) and the suggested contact of a "has left the company"
 * auto-reply (§3.7). A hint never links anything by itself: the waiting-list card shows it and the Link dialog
 * pre-selects its company. Shared and free-mail domains (gmail.com, outlook.com, instagram.com, …) are never hinted.
 * Pure and browser-safe.
 */

/** A live company the processor found for a hint. */
export type HintCompany = { id: number; name: string; domain: string | null };

/** "C-1042". */
const code = (id: number) => `C-${id}`;

/**
 * The domain a sender's address can be compared with `Company.domain`: the registrable domain of the address
 * ("mail.firma.de" → "firma.de"), or null for shared and free-mail domains and unreadable addresses. The same rule
 * decides the domain hold (§3.3.4).
 */
export function senderDomain(fromEmail: string | null | undefined): string | null {
  const norm = normalizeEmail(fromEmail);
  if (!norm) return null;
  const domain = norm.slice(norm.lastIndexOf("@") + 1);
  return domain ? usableEmailDomain(domain) : null;
}

/**
 * "Same domain as Firma GmbH (C-1042)." for each live company (at most 3, in the given order) whose domain equals the
 * sender's. Nothing for shared or free-mail senders.
 */
export function sameDomainHint(fromEmail: string, companies: readonly HintCompany[]): Array<{ companyId: number; text: string }> {
  const domain = senderDomain(fromEmail);
  if (!domain) return [];
  const out: Array<{ companyId: number; text: string }> = [];
  const seen = new Set<number>();
  for (const c of companies) {
    if (!c.domain || c.domain.toLowerCase() !== domain || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ companyId: c.id, text: `Same domain as ${c.name} (${code(c.id)}).` });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * "anna@firma.de was Anna Berg at Firma GmbH (C-1042), who was removed." for a sender who was a contact before (a
 * deleted Person with that address). When the company itself was deleted: "…at Firma GmbH (C-1042), which was removed."
 * Without a name (or for a shared inbox): "anna@firma.de was a contact at …".
 */
export function removedContactHint(i: {
  fromEmail: string;
  personName: string | null;
  companyId: number;
  companyName: string;
  companyRemoved?: boolean;
}): string {
  const name = (i.personName ?? "").replace(/\s+/g, " ").trim();
  const who = name && name !== GENERAL_INBOX_NAME ? name : "a contact";
  const tail = i.companyRemoved ? "which was removed" : "who was removed";
  return `${i.fromEmail} was ${who} at ${i.companyName} (${code(i.companyId)}), ${tail}.`;
}

/** The "on hold" hint of a domain hold (§3.3.5): "Follow-ups to Firma GmbH wait until you link this reply or mark it." */
export function heldCompanyHint(companyName: string): string {
  return `Follow-ups to ${companyName} wait until you link this reply or mark it.`;
}

/** Our own domains, compared by their registrable part too ("send.example.com" also covers "example.com"). */
function ownDomainTest(ownDomains: readonly string[]): (domain: string) => boolean {
  const own = new Set<string>();
  for (const d of ownDomains) {
    const lower = (d ?? "").trim().toLowerCase();
    if (!lower) continue;
    own.add(lower);
    const registrable = usableEmailDomain(lower);
    if (registrable) own.add(registrable);
  }
  return (domain) => {
    if (own.has(domain)) return true;
    for (const d of own) if (domain.endsWith(`.${d}`)) return true;
    const registrable = usableEmailDomain(domain);
    return registrable !== null && own.has(registrable);
  };
}

/**
 * The address a "has left the company" auto-reply suggests instead (V38: "Please contact info@firma.de."): at most one
 * address from the text, skipping our own sending domains, the sender's own address and no-reply or mail-system
 * addresses, preferring one on the company's domain. Null when there is none.
 */
export function suggestedContact(
  text: string | null | undefined,
  opts: { fromEmail: string; companyDomain: string | null; ownDomains: readonly string[] },
): string | null {
  const from = normalizeEmail(opts.fromEmail);
  const isOwn = ownDomainTest(opts.ownDomains ?? []);
  const company = (opts.companyDomain ?? "").trim().toLowerCase() || null;
  const candidates = findEmailAddresses((text ?? "").slice(0, 4_000)).filter((a) => {
    const at = a.lastIndexOf("@");
    const local = a.slice(0, at);
    const domain = a.slice(at + 1);
    if (a === from || isOwn(domain)) return false;
    return !NOREPLY_LOCALPART.test(local) && !BOUNCE_LOCALPART.test(local);
  });
  if (candidates.length === 0) return null;
  if (company) {
    const onCompany = candidates.find((a) => {
      const domain = a.slice(a.lastIndexOf("@") + 1);
      return domain === company || domain.endsWith(`.${company}`) || usableEmailDomain(domain) === company;
    });
    if (onCompany) return onCompany;
  }
  return candidates[0]!;
}
