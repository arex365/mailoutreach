import type { DmarcFind } from "@/core/dns/checklist";
import { dmarcParents, dmarcRecords, parseDmarc } from "@/core/dns/dmarc";
import type { DnsLookup } from "@/core/dns/types";

/**
 * DMARC policy discovery (RFC 9989 tree walk; research deliverability-dns.md row 7): `_dmarc.<domain>`, then each
 * parent up to (not including) the public suffix, at most 8 names. The first name with DMARC records decides: exactly
 * one record is the policy, two or more cancel each other ("duplicates"). A policy found on a parent is "inherited"
 * (the subdomain uses the parent's `sp`, else its `p`).
 */
export async function findDmarc(domain: string, lookup: DnsLookup): Promise<DmarcFind> {
  const self = domain.trim().toLowerCase().replace(/\.$/, "");
  for (const name of dmarcParents(self)) {
    const ans = await lookup.txt(`_dmarc.${name}`);
    if (!ans.ok) {
      if (ans.code === "missing") continue;
      return { at: null, policy: null, duplicates: false, inherited: false, error: ans.detail || ans.code };
    }
    const records = dmarcRecords(ans.value);
    if (records.length === 0) continue;
    const inherited = name !== self;
    if (records.length > 1) return { at: name, policy: null, duplicates: true, inherited, error: null };
    return { at: name, policy: parseDmarc(records[0]!), duplicates: false, inherited, error: null };
  }
  return { at: null, policy: null, duplicates: false, inherited: false, error: null };
}
