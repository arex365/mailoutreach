import { spfIncludes, spfLookupTerms, spfRecords } from "@/core/dns/spf";
import type { DnsLookup } from "@/core/dns/types";

/**
 * SPF's 10-lookup limit (RFC 7208 §4.6.4; research deliverability-dns.md row 2): `include`, `a`, `mx`, `ptr`,
 * `exists` and `redirect` each cost one DNS lookup, and so does everything the included records cost in turn
 * (include:mailgun.org alone costs 5 today). More than 10 → some mail servers reject the email.
 *
 * Shared From address (SHARED-FROM-DESIGN §5, C2-6): the same walk also notes the `include:`/`redirect=` names that have
 * no SPF record at all ("dangling"): a receiver treats the whole record as broken (permerror). That happens after a DNS
 * move that lost a helper record (GoDaddy's `dc-…._spfm`), and it breaks the owner's everyday email.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §5, O11): the walk also lists every name it looked up (`names`), so the SPF row
 * can find Mailgun's include anywhere in the include tree (GoDaddy wraps it in `dc-…._spfm.<domain>`).
 */

/** Includes are followed this deep at most (a loop or a very deep chain is incomplete). */
const MAX_DEPTH = 10;

/** What one SPF record costs: the lookup count, whether the count is sure, and the names that have no SPF record. */
export type SpfLookupReport = {
  count: number;
  /** False when a lookup failed (timeout) or the chain was too deep: the count is then a lower bound. */
  complete: boolean;
  /**
   * `include:` and `redirect=` names (at any depth) whose TXT answer is "missing" (NXDOMAIN/NODATA) or holds no
   * `v=spf1` record. A timeout never makes a name dangling (it only makes the count incomplete).
   */
  dangling: string[];
  /**
   * MAIN-DOMAIN-DESIGN §5: every `include:` and `redirect=` name the walk looked up (at any depth), in walk order, each
   * once; dangling names and names whose lookup timed out included. The walk stops once the count passes 10, so a record
   * over 10 may not list every name (it is "bad" by its count first).
   */
  names: string[];
};

/** How the walk treats a name it meets again. */
export type SpfWalkOptions = {
  /**
   * Own-mailbox review DOMAIN-1: count a repeated `include:` (or `redirect=`) every time it appears, as a receiver does:
   * each one is evaluated again, so its whole subtree costs its lookups again (a record with include:mailgun.org twice
   * needs 5 more lookups than with it once). Each name is still asked of the resolver only once per walk, and `names` and
   * `dangling` still list it once. An include loop is cut by the depth limit, by which time the count is over 10.
   * Absent or false = the earlier walk (a name met again adds nothing), which app mode keeps (§0.2 rule 4).
   */
  countRepeats?: boolean;
};

function redirectOf(record: string): string | null {
  for (const term of record.trim().split(/\s+/).slice(1)) {
    const m = /^redirect=(.+)$/i.exec(term);
    if (m) return m[1]!.toLowerCase().replace(/\.$/, "");
  }
  return null;
}

type Walk = {
  lookup: DnsLookup;
  countRepeats: boolean;
  /** The names already walked (the earlier walk skips them). */
  seen: Set<string>;
  /** Each name's TXT answer, asked once per walk (a repeated include is counted again, never asked again). */
  answers: Map<string, ReturnType<DnsLookup["txt"]>>;
  dangling: string[];
  names: string[];
};

function note(list: string[], name: string): void {
  if (!list.includes(name)) list.push(name);
}

async function count(record: string, walk: Walk, depth: number): Promise<{ count: number; complete: boolean }> {
  let total = spfLookupTerms(record);
  let complete = true;
  if (depth >= MAX_DEPTH) return { count: total, complete: false };
  const redirect = redirectOf(record);
  const targets = [...spfIncludes(record), ...(redirect ? [redirect] : [])];
  for (const target of targets) {
    if (total > 10) break;
    if (!walk.countRepeats) {
      if (walk.seen.has(target)) continue;
      walk.seen.add(target);
    }
    note(walk.names, target);
    let asked = walk.answers.get(target);
    if (!asked) {
      asked = walk.lookup.txt(target);
      walk.answers.set(target, asked);
    }
    const ans = await asked;
    if (!ans.ok) {
      // A void lookup (NXDOMAIN/NODATA) still counts (above) but adds nothing; a timeout leaves the count unsure.
      if (ans.code !== "missing") complete = false;
      else note(walk.dangling, target);
      continue;
    }
    const inner = spfRecords(ans.value)[0];
    if (!inner) {
      note(walk.dangling, target);
      continue;
    }
    const sub = await count(inner, walk, depth + 1);
    total += sub.count;
    if (!sub.complete) complete = false;
  }
  return { count: total, complete };
}

/**
 * The DNS lookups an SPF record costs, its includes (and redirect) counted recursively, the included names that have no
 * SPF record (`dangling`) and every name looked up (`names`). Stops counting once it passes 10. `opts.countRepeats`:
 * a repeated include costs its lookups every time (own-mailbox mode's SPF row, review DOMAIN-1).
 */
export async function spfLookupReport(record: string, lookup: DnsLookup, depth = 0, opts: SpfWalkOptions = {}): Promise<SpfLookupReport> {
  const walk: Walk = { lookup, countRepeats: opts.countRepeats === true, seen: new Set(), answers: new Map(), dangling: [], names: [] };
  const res = await count(record, walk, depth);
  return { ...res, dangling: walk.dangling, names: walk.names };
}

/**
 * The DNS lookups an SPF record costs, its includes (and redirect) counted recursively. `complete` is false when a
 * lookup failed or the chain was too deep (the count is then a lower bound). Stops counting once it passes 10.
 * (The sending domain's SPF row; the From domain's row uses `spfLookupReport`, which also lists dangling includes.)
 */
export async function countSpfLookups(record: string, lookup: DnsLookup, depth = 0): Promise<{ count: number; complete: boolean }> {
  const { count: n, complete } = await spfLookupReport(record, lookup, depth);
  return { count: n, complete };
}
