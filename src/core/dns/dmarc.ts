import { parse } from "tldts";

/**
 * DMARC record reading (RFC 9989/9990; research deliverability-dns.md row 7, M3-DESIGN §4.1.9). Mailgun doesn't
 * report DMARC, so the app looks it up itself: `_dmarc.<domain>`, then up the tree towards the registrable domain.
 * The lookups live in @/server/services/checks/dmarc-walk (P4). Pure.
 */

/** The tags of one DMARC record that the checklist reads. */
export type DmarcPolicy = {
  /** "none" | "quarantine" | "reject" (lowercase), or null when missing. */
  p: string | null;
  /** Subdomain policy (defaults to `p` when missing; the caller applies that). */
  sp: string | null;
  /** Aggregate report addresses, e.g. "mailto:dmarc@send.example.com". */
  rua: string[];
  adkim: string | null;
  aspf: string | null;
  raw: string;
};

/** Receivers look at no more than this many names (RFC 9989 tree walk). */
const MAX_WALK = 8;

/**
 * The TXT records that are DMARC policy records (they start with the tag "v=DMARC1"). Anything else is discarded,
 * and when two or more remain the receiver ignores them all, which the caller reports.
 */
export function dmarcRecords(txt: readonly string[]): string[] {
  return txt.filter((r) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(r.trim()));
}

/** Reads the tags of one DMARC record. Tag names are case-insensitive; policy values come back lowercase. */
export function parseDmarc(record: string): DmarcPolicy {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key && !tags.has(key)) tags.set(key, value);
  }
  const lowerTag = (k: string) => {
    const v = tags.get(k);
    return v ? v.toLowerCase() : null;
  };
  const rua = (tags.get("rua") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return { p: lowerTag("p"), sp: lowerTag("sp"), rua, adkim: lowerTag("adkim"), aspf: lowerTag("aspf"), raw: record };
}

/**
 * The names whose `_dmarc` record applies to `domain`, in the order receivers look: the domain itself first, then
 * each parent, stopping before the public suffix (via tldts, so "mail.polygonparadise.com" gives
 * ["mail.polygonparadise.com", "polygonparadise.com"]). At most 8 names; a very long name jumps from itself to its
 * last 7 labels, as RFC 9989's tree walk does. Empty for a public suffix or something that isn't a domain.
 */
export function dmarcParents(domain: string): string[] {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!name || name.includes("..")) return [];
  const info = parse(name);
  if (info.isIp || !info.publicSuffix || !info.domain) return [];
  const suffixLabels = info.publicSuffix.split(".").length;
  const labels = name.split(".");
  const out = [name];
  // The next candidate after the full name: its parent, or its last 7 labels when the name is very long.
  let start = labels.length > MAX_WALK ? labels.length - (MAX_WALK - 1) : 1;
  for (; labels.length - start > suffixLabels && out.length < MAX_WALK; start++) {
    out.push(labels.slice(start).join("."));
  }
  return out;
}

/**
 * The name at which a report address on another domain must say it accepts reports for `policyDomain`
 * (RFC 9990): `<policyDomain>._report._dmarc.<ruaDomain>`.
 */
export function ruaAuthorizationName(policyDomain: string, ruaDomain: string): string {
  const clean = (d: string) => d.trim().toLowerCase().replace(/\.$/, "");
  return `${clean(policyDomain)}._report._dmarc.${clean(ruaDomain)}`;
}
