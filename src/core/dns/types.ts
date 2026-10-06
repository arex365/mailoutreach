/**
 * DNS lookups for the domain checklist (research deliverability-dns.md, M3-DESIGN §4.1.9, §4.4.7). The checks ask
 * two public resolvers (1.1.1.1 and 8.8.8.8) separately, because one resolver that answers "not found" never falls
 * back to the other; comparing the two tells "still spreading" apart from "missing". The node:dns implementation
 * lives in @/server/services/checks/dns-lookup (P4); tests use a fake table. Pure.
 */

/** One resolver's answer: the value, or why there is none ("missing" = NXDOMAIN/NODATA; "timeout"/"error" = couldn't check). */
export type DnsAnswer<T> = { ok: true; value: T } | { ok: false; code: "missing" | "timeout" | "error"; detail: string };

export interface DnsLookup {
  /** One string per TXT record, its chunks joined with "" (see `joinTxtChunks`). */
  txt(name: string): Promise<DnsAnswer<string[]>>;
  mx(name: string): Promise<DnsAnswer<Array<{ priority: number; exchange: string }>>>;
  cname(name: string): Promise<DnsAnswer<string[]>>;
  a(name: string): Promise<DnsAnswer<string[]>>;
}

/**
 * How two resolvers agree on a record: "both" = both see it right; "one" = only one does (still spreading, or the
 * other couldn't be asked); "none" = neither sees it right and both answered; "unknown" = neither sees it right and
 * at least one couldn't be asked (a timeout never makes a row red).
 */
export type Agreement = "both" | "one" | "none" | "unknown";

/** Compares two resolvers' answers with `isGood` (see `Agreement`). */
export function agree<T>(a: DnsAnswer<T>, b: DnsAnswer<T>, isGood: (v: T) => boolean): Agreement {
  const good = (x: DnsAnswer<T>) => x.ok && isGood(x.value);
  const unsure = (x: DnsAnswer<T>) => !x.ok && (x.code === "timeout" || x.code === "error");
  const goodCount = Number(good(a)) + Number(good(b));
  if (goodCount === 2) return "both";
  if (goodCount === 1) return "one";
  return unsure(a) || unsure(b) ? "unknown" : "none";
}

/**
 * Turns node:dns `resolveTxt` output (each record split into chunks of at most 255 characters) into one string per
 * record. Chunks are joined with nothing in between (RFC 7208 §3.3): "v=spf1 include:mailgun.org" + " ~all".
 */
export function joinTxtChunks(records: ReadonlyArray<readonly string[] | string>): string[] {
  return records.map((r) => (typeof r === "string" ? r : r.join("")));
}
