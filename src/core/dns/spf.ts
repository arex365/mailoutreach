/**
 * SPF record reading (RFC 7208; research deliverability-dns.md row 2, M3-DESIGN §4.1.9). Only the checks the domain
 * checklist needs: which TXT records are SPF, what they include, how many DNS lookups they cost and how they end.
 * Counting nested includes needs DNS and lives in @/server/services/checks/spf-count (P4). Pure.
 */

/** The TXT records that are SPF records (they start with "v=spf1"). More than one means none of them counts. */
export function spfRecords(txt: readonly string[]): string[] {
  return txt.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
}

/** The terms after "v=spf1", split on spaces. */
function terms(record: string): string[] {
  return record.trim().split(/\s+/).slice(1).filter(Boolean);
}

/** A term without its qualifier ("+", "-", "~" or "?"). */
function withoutQualifier(term: string): string {
  return /^[+\-~?]/.test(term) ? term.slice(1) : term;
}

/** The domains of the record's `include:` terms, lowercase, in order. */
export function spfIncludes(record: string): string[] {
  const out: string[] = [];
  for (const term of terms(record)) {
    const t = withoutQualifier(term);
    const m = /^include:(.+)$/i.exec(t);
    if (m) out.push(m[1]!.toLowerCase().replace(/\.$/, ""));
  }
  return out;
}

/**
 * The DNS-lookup terms in THIS record (not counting what includes pull in): `include`, `a`, `mx`, `ptr`, `exists`
 * and the `redirect=` modifier count toward SPF's limit of 10; `all`, `ip4`, `ip6` and `exp=` don't.
 */
export function spfLookupTerms(record: string): number {
  let count = 0;
  for (const term of terms(record)) {
    const t = withoutQualifier(term).toLowerCase();
    if (t.startsWith("redirect=")) {
      count++;
      continue;
    }
    const name = /^([a-z0-9]+)/.exec(t)?.[1] ?? "";
    const rest = t.slice(name.length);
    if (rest !== "" && !rest.startsWith(":") && !rest.startsWith("/")) continue;
    if (name === "include" || name === "a" || name === "mx" || name === "ptr" || name === "exists") count++;
  }
  return count;
}

/** True when the record ends with `all` carrying this qualifier ("all" alone means "+all"). */
export function spfHasAll(record: string, qualifier: "+" | "~" | "-" | "?"): boolean {
  for (const term of terms(record)) {
    const q = /^[+\-~?]/.test(term) ? term[0] : "+";
    if (withoutQualifier(term).toLowerCase() === "all" && q === qualifier) return true;
  }
  return false;
}
