import { getDomain as registrableDomain } from "tldts";
import {
  zoneOf,
  type DkimFact,
  type DnsFacts,
  type FromDomainFacts,
  type MailgunDomainFact,
  type SpfWalk,
  type SpfWalks,
  type TwoAnswers,
} from "@/core/dns/checklist";
import { dkimPublicKey } from "@/core/dns/dkim";
import { ruaAuthorizationName } from "@/core/dns/dmarc";
import { spfRecords } from "@/core/dns/spf";
import type { DnsAnswer, DnsLookup } from "@/core/dns/types";
import { findDmarc } from "./dmarc-walk";
import { spfLookupReport } from "./spf-count";

/**
 * Everything the DNS rows of the domain checklist need (M3-DESIGN §4.4.7), asked of both resolvers. The expected
 * values always come from Mailgun's record lists (never hard-coded). Extra lookups only when a record looks missing:
 * the A record of a missing CNAME (a proxied "orange cloud" CNAME answers IPs instead), and the doubled name
 * "<name>.<zone>" (a DNS panel that appended the zone to a full name).
 */

function clean(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

async function both<T>(lookups: readonly [DnsLookup, DnsLookup], ask: (l: DnsLookup) => Promise<DnsAnswer<T>>): Promise<TwoAnswers<T>> {
  const [a, b] = await Promise.all([ask(lookups[0]), ask(lookups[1])]);
  return { a, b };
}

function anyValue<T>(two: TwoAnswers<T[]>, good: (v: T) => boolean): boolean {
  return (two.a.ok && two.a.value.some(good)) || (two.b.ok && two.b.value.some(good));
}

async function dkimFacts(domain: string, m: MailgunDomainFact, lookups: readonly [DnsLookup, DnsLookup]): Promise<DkimFact[]> {
  const zone = zoneOf(domain);
  const out: DkimFact[] = [];
  for (const r of m.sending) {
    const type = r.recordType.toUpperCase();
    const name = clean(r.name ?? "");
    if (!r.isActive || !/\._domainkey\./i.test(name) || (type !== "TXT" && type !== "CNAME")) continue;
    if (type === "TXT") {
      // resolveTxt follows CNAMEs, which is fine for a TXT key record.
      const answers = await both(lookups, (l) => l.txt(name));
      const want = dkimPublicKey(r.value);
      const good = anyValue(answers, (t: string) => want !== null && dkimPublicKey(t) === want);
      const doubled = good ? null : await both(lookups, (l) => l.txt(`${name}.${zone}`));
      out.push({ name, recordType: "TXT", expected: r.value, answers, proxied: null, doubled });
    } else {
      // Automatic Sender Security: must be checked with resolveCname (resolveTxt would follow it to Mailgun's key).
      const answers = await both(lookups, (l) => l.cname(name));
      const any = anyValue(answers, () => true);
      const proxied = any ? null : await both(lookups, (l) => l.a(name));
      const doubled = any ? null : await both(lookups, (l) => l.cname(`${name}.${zone}`));
      out.push({ name, recordType: "CNAME", expected: r.value, answers, proxied, doubled });
    }
  }
  return out;
}

/** Report domains outside the policy's organisation → whether they published the authorisation record (RFC 9990). */
async function ruaAuthorisations(policyDomain: string, rua: string[], lookup: DnsLookup): Promise<Record<string, boolean | null>> {
  const out: Record<string, boolean | null> = {};
  const org = registrableDomain(policyDomain) ?? policyDomain;
  for (const uri of rua) {
    const rd = /^mailto:[^@]+@([^!\s,;]+)/i.exec(uri)?.[1]?.toLowerCase();
    if (!rd || (registrableDomain(rd) ?? rd) === org || rd in out) continue;
    const ans = await lookup.txt(ruaAuthorizationName(policyDomain, rd));
    out[rd] = ans.ok ? ans.value.some((t) => /^v\s*=\s*DMARC1/i.test(t.trim())) : ans.code === "missing" ? false : null;
  }
  return out;
}

/**
 * Review DOMAIN-1: the SPF facts of a domain whose SPF record also carries the Owner's everyday email (own-mailbox mode,
 * and a website domain checked in app mode, O37). Each resolver walks the include tree from the record it answered
 * itself, a repeated include counted every time (`countRepeats`), so the SPF row can tell a change that is still
 * spreading (the walks differ) from a real problem (both agree). The combined fields: the larger count, complete only
 * when both walks are, a name dangling only when both walks found it so, every name looked up. Null when neither
 * resolver answered an SPF record.
 */
async function everydaySpfLookups(
  txt: TwoAnswers<string[]>,
  lookups: readonly [DnsLookup, DnsLookup],
): Promise<{ count: number; complete: boolean; dangling: string[]; names: string[]; walks: SpfWalks } | null> {
  const recordOf = (ans: DnsAnswer<string[]>) => (ans.ok ? spfRecords(ans.value)[0] : undefined);
  const records = [recordOf(txt.a), recordOf(txt.b)] as const;
  if (!records[0] && !records[1]) return null;
  const walk = async (i: 0 | 1): Promise<SpfWalk | null> => {
    const record = records[i];
    if (!record) return null;
    const r = await spfLookupReport(record, lookups[i], 0, { countRepeats: true });
    return { count: r.count, complete: r.complete, dangling: r.dangling, names: r.names };
  };
  const [a, b] = await Promise.all([walk(0), walk(1)]);
  const done = [a, b].filter((w): w is SpfWalk => w !== null);
  return {
    count: Math.max(...done.map((w) => w.count)),
    complete: done.every((w) => w.complete),
    dangling: a && b ? a.dangling.filter((n) => b.dangling.includes(n)) : done[0]!.dangling,
    names: [...new Set(done.flatMap((w) => w.names))],
    walks: [a, b],
  };
}

/**
 * Asks both resolvers everything the checklist's DNS rows need for `domain`. `opts.everydaySpf` (a website domain in app
 * mode, O37, review DOMAIN-4): the SPF facts come from both resolvers' walks (`everydaySpfLookups`) with the dangling
 * includes, as in own-mailbox mode, so the guard's SPF row sees a lost `_spfm` helper. Absent = today's walk.
 */
export async function gatherDnsFacts(
  domain: string,
  m: MailgunDomainFact,
  lookups: readonly [DnsLookup, DnsLookup],
  opts: { everydaySpf?: boolean } = {},
): Promise<DnsFacts> {
  const d = clean(domain);
  const zone = zoneOf(d);

  const txt = await both(lookups, (l) => l.txt(d));
  const spf = [...(txt.a.ok ? spfRecords(txt.a.value) : []), ...(txt.b.ok ? spfRecords(txt.b.value) : [])][0];
  // The same walk as countSpfLookups (the same lookups, the same count); its `names` also let the SPF row of a stored
  // website domain in app mode find Mailgun's include anywhere in the tree (MAIN-DOMAIN-DESIGN O37). The app-mode SPF
  // row itself reads only the count, as before.
  let spfLookups: DnsFacts["spfLookups"];
  if (opts.everydaySpf) spfLookups = await everydaySpfLookups(txt, lookups);
  else {
    const report = spf ? await spfLookupReport(spf, lookups[0]) : null;
    spfLookups = report ? { count: report.count, complete: report.complete, names: report.names } : null;
  }

  const dkim = await dkimFacts(d, m, lookups);
  const mx = await both(lookups, (l) => l.mx(d));

  const host = clean(`${m.webPrefix || "email"}.${d}`);
  const expected =
    m.sending.find((r) => r.recordType.toUpperCase() === "CNAME" && clean(r.name ?? "") === host)?.value ?? null;
  const cname = await both(lookups, (l) => l.cname(host));
  const cnameGood = expected !== null && anyValue(cname, (t: string) => clean(t) === clean(expected));
  const aRecords = cnameGood ? null : await both(lookups, (l) => l.a(host));
  const doubled = cnameGood ? null : await both(lookups, (l) => l.cname(`${host}.${zone}`));

  const [dmarcA, dmarcB] = await Promise.all([findDmarc(d, lookups[0]), findDmarc(d, lookups[1])]);
  const policyOf = dmarcA.policy ? dmarcA : dmarcB;
  const ruaAuthorized = policyOf.policy ? await ruaAuthorisations(policyOf.at ?? d, policyOf.policy.rua, lookups[0]) : {};

  return {
    txt,
    spfLookups,
    dkim,
    mx,
    tracking: { host, expected, cname, a: aRecords, doubled },
    dmarc: { a: dmarcA, b: dmarcB, ruaAuthorized },
  };
}

/** True when this resolver's answer shows no SPF record at `name` ("missing", or TXT without v=spf1). */
async function hasNoSpf(lookup: DnsLookup, name: string): Promise<boolean> {
  const ans = await lookup.txt(name);
  if (!ans.ok) return ans.code === "missing";
  return spfRecords(ans.value).length === 0;
}

/**
 * Shared-From mode (SHARED-FROM-DESIGN §5): the From domain's own DNS, asked of both resolvers exactly as
 * `gatherDnsFacts` asks for the sending domain. DNS only: never a Mailgun call (the From domain is never a Mailgun
 * domain for the app, §2.5). TXT at the From domain (SPF and Google's verification), the SPF record's lookup count and
 * its dangling includes (counted with the first resolver; a name counts as dangling only when the second resolver has
 * no SPF record there either), its MX, and the DMARC walk from the From domain with the report authorisations.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §5) calls it for the sending domain itself (DNS only there too) and reads the
 * walk's `names`, every include looked up, to find Mailgun's include anywhere in the SPF record's tree. With
 * `opts.ownMailbox` (review DOMAIN-1) both resolvers walk the tree (`everydaySpfLookups`); shared-From mode keeps
 * today's walk.
 */
export async function gatherFromDomainFacts(
  fromDomain: string,
  lookups: readonly [DnsLookup, DnsLookup],
  opts: { ownMailbox?: boolean } = {},
): Promise<NonNullable<FromDomainFacts["dns"]>> {
  const d = clean(fromDomain);
  const txt = await both(lookups, (l) => l.txt(d));
  const spf = [...(txt.a.ok ? spfRecords(txt.a.value) : []), ...(txt.b.ok ? spfRecords(txt.b.value) : [])][0];
  let spfLookups: NonNullable<FromDomainFacts["dns"]>["spfLookups"] = null;
  if (opts.ownMailbox) spfLookups = await everydaySpfLookups(txt, lookups);
  else if (spf) {
    const report = await spfLookupReport(spf, lookups[0]);
    const dangling: string[] = [];
    for (const name of report.dangling) if (await hasNoSpf(lookups[1], name)) dangling.push(name);
    spfLookups = { count: report.count, complete: report.complete, dangling, names: report.names };
  }
  const mx = await both(lookups, (l) => l.mx(d));
  const [dmarcA, dmarcB] = await Promise.all([findDmarc(d, lookups[0]), findDmarc(d, lookups[1])]);
  const policyOf = dmarcA.policy ? dmarcA : dmarcB;
  const ruaAuthorized = policyOf.policy ? await ruaAuthorisations(policyOf.at ?? d, policyOf.policy.rua, lookups[0]) : {};
  return { txt, spfLookups, mx, dmarc: { a: dmarcA, b: dmarcB, ruaAuthorized } };
}
