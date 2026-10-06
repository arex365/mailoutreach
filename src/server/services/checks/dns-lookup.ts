import { Resolver } from "node:dns/promises";
import type { MailgunDomainFact } from "@/core/dns/checklist";
import { spfIncludes } from "@/core/dns/spf";
import { joinTxtChunks, type DnsAnswer, type DnsLookup } from "@/core/dns/types";

/**
 * The real DnsLookup (research deliverability-dns.md §3): one node:dns Resolver per public server, because a Resolver
 * given both servers doesn't ask the second when the first says "not found" and the checklist needs both answers to
 * tell "still spreading" from "missing". resolve* always asks the network (never the hosts file). Tests never use
 * this: they inject a fake DnsLookup table.
 */

export const DNS_TIMEOUT_MS = 4_000;
export const DNS_TRIES = 2;

/** node:dns error codes → DnsAnswer: NXDOMAIN/NODATA are "missing"; timeouts "timeout"; the rest "error". */
export function dnsFailure(err: unknown): Extract<DnsAnswer<never>, { ok: false }> {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  const detail = code || (err instanceof Error ? err.message : String(err));
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "NOTFOUND" || code === "NODATA") return { ok: false, code: "missing", detail };
  if (code === "ETIMEOUT" || code === "ETIMEDOUT" || code === "ECANCELLED" || code === "TIMEOUT") return { ok: false, code: "timeout", detail };
  return { ok: false, code: "error", detail };
}

async function answer<T>(fn: () => Promise<T>): Promise<DnsAnswer<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return dnsFailure(err);
  }
}

/** A DnsLookup asking only `server` (timeout 4 s, 2 tries: one timeout was seen with a single 3 s try). */
export function createDnsLookup(server: "1.1.1.1" | "8.8.8.8", opts: { timeoutMs?: number; tries?: number } = {}): DnsLookup {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? DNS_TIMEOUT_MS, tries: opts.tries ?? DNS_TRIES });
  resolver.setServers([server]);
  return {
    txt: (name) => answer(async () => joinTxtChunks(await resolver.resolveTxt(name))),
    mx: (name) => answer(() => resolver.resolveMx(name)),
    cname: (name) => answer(() => resolver.resolveCname(name)),
    a: (name) => answer(() => resolver.resolve4(name)),
  };
}

/** The DMARC record the Mailgun guide (step 7) has the Owner add; Mailgun's own record list doesn't include one. */
export const GUIDE_DMARC_RECORD = "v=DMARC1; p=none";

function host(name: string | null | undefined, domain: string): string {
  const n = (name ?? "").trim().toLowerCase().replace(/\.+$/, "");
  return n || domain;
}

/**
 * The From domain's own records in fake mode (SHARED-FROM-DESIGN §5): a made-up mail provider (".invalid" names never
 * resolve anywhere), so the from-mx and from-spf rows can be green without real DNS.
 */
export const FAKE_FROM_DOMAIN_RECORDS = {
  mx: "mx.mail-provider.invalid",
  spf: "v=spf1 include:_spf.mail-provider.invalid ~all",
  includeName: "_spf.mail-provider.invalid",
  includeSpf: "v=spf1 ip4:192.0.2.10 ~all",
} as const;

/**
 * Own-mailbox mode in fake mode (MAIN-DOMAIN-DESIGN §5): the sending domain is the Owner's own mailbox domain, so it
 * answers as a mail provider's domain whose DNS host wraps the SPF parts in GoDaddy-style `_spfm` includes: MX
 * `10 mx.mail-provider.invalid`; SPF `v=spf1 include:dc-1._spfm.<d> include:dc-2._spfm.<d> ~all`, the first include
 * pointing at the made-up provider and the second at Mailgun (4 lookups, Mailgun reached through the tree, nothing
 * dangling). Never a Mailgun MX record, never a merged SPF value.
 */
export const FAKE_OWN_MAILBOX_RECORDS = {
  mx: FAKE_FROM_DOMAIN_RECORDS.mx,
  spf: (d: string): string => `v=spf1 include:dc-1._spfm.${d} include:dc-2._spfm.${d} ~all`,
  providerName: (d: string): string => `dc-1._spfm.${d}`,
  mailgunName: (d: string): string => `dc-2._spfm.${d}`,
  /** `dc-1._spfm.<d>`: the mail provider's part. */
  providerSpf: FAKE_FROM_DOMAIN_RECORDS.spf,
  /** `dc-2._spfm.<d>` when Mailgun lists no SPF record of its own (Mailgun's value otherwise). */
  mailgunSpf: "v=spf1 include:mailgun.org ~all",
  /** `dc-2._spfm.<d>` while Mailgun's SPF record isn't "valid" yet: the part without Mailgun. */
  mailgunSpfPending: "v=spf1 ~all",
  /** Each of Mailgun's includes (mailgun.org, eu.mailgun.org): a made-up record with no further lookups. */
  mailgunIncludeSpf: "v=spf1 ip4:192.0.2.30 ~all",
} as const;

/**
 * Fake mode only (the local fake Mailgun server: the lead's manual checks and the screen checks, M3-DESIGN §6.3): the
 * fake's records are made up, so the public resolvers are never asked about them. This lookup answers as if the Owner
 * had published exactly the records Mailgun marks "valid" (the fake's `POST /__fake/dns {valid}` switches them), plus
 * the guide's DMARC record once all of them are valid. Every other name is "missing". Both resolvers use it, so the
 * rows agree.
 *
 * With `fromDomain` (shared-From mode, SHARED-FROM-DESIGN §5) it also answers for the From domain as a mail provider's
 * domain would: MX `10 mx.mail-provider.invalid`, the SPF record `v=spf1 include:_spf.mail-provider.invalid ~all` (and
 * that include's own record, so it isn't dangling), and `_dmarc.<fromDomain>` = the guide's DMARC record once every
 * Mailgun record is valid. Every other name of the From domain is "missing".
 *
 * With `ownMailbox` (MAIN-DOMAIN-DESIGN §5; `fromDomain` is then ignored: the From domain is the sending domain) the
 * sending domain answers as a mail provider's domain instead of with Mailgun's receiving records, which are never
 * answered (FAKE_OWN_MAILBOX_RECORDS): its MX is the made-up provider's, its SPF record is the `_spfm`-wrapped one,
 * `dc-2._spfm.<d>` carries Mailgun's SPF value while Mailgun marks its SPF record "valid" (else a record without
 * Mailgun), and `_dmarc.<d>` is the guide's record once every Mailgun sending record is valid (the receiving records
 * never are in this mode). DKIM and the tracking CNAME are answered as always.
 */
export function mailgunRecordsLookup(
  domain: string,
  m: Pick<MailgunDomainFact, "sending" | "receiving">,
  opts: { fromDomain?: string | null; ownMailbox?: boolean } = {},
): DnsLookup {
  const d = host(domain, domain);
  const own = opts.ownMailbox === true;
  const from = !own && opts.fromDomain ? host(opts.fromDomain, opts.fromDomain) : null;
  const records = (own ? [...m.sending] : [...m.sending, ...m.receiving]).filter((r) => r.isActive !== false);
  const valid = records.filter((r) => r.valid === "valid");
  const allValid = records.length > 0 && valid.length === records.length;
  const found = <T>(values: T[]): DnsAnswer<T[]> =>
    values.length > 0 ? { ok: true, value: values } : { ok: false, code: "missing", detail: "ENOTFOUND (fake mode)" };
  const of = (type: string, name: string) => valid.filter((r) => r.recordType.toUpperCase() === type && host(r.name, d) === host(name, d));
  const isSpf = (v: string) => /^v=spf1(\s|$)/i.test(v.trim());
  // Own-mailbox mode: Mailgun's own SPF record for the domain (TXT at the domain), whose includes dc-2._spfm carries.
  const mailgunSpfRecord = own ? records.find((r) => r.recordType.toUpperCase() === "TXT" && host(r.name, d) === d && isSpf(r.value)) : undefined;
  const mailgunSpf = mailgunSpfRecord?.value.trim() ?? FAKE_OWN_MAILBOX_RECORDS.mailgunSpf;
  const mailgunSpfValid = !mailgunSpfRecord || mailgunSpfRecord.valid === "valid";
  const mailgunIncludes = own ? spfIncludes(mailgunSpf) : [];
  return {
    txt: async (name) => {
      const n = host(name, d);
      let values = of("TXT", name).map((r) => r.value);
      if (own) {
        if (n === d) values = [...values.filter((v) => !isSpf(v)), FAKE_OWN_MAILBOX_RECORDS.spf(d)];
        if (n === FAKE_OWN_MAILBOX_RECORDS.providerName(d)) values.push(FAKE_OWN_MAILBOX_RECORDS.providerSpf);
        if (n === FAKE_OWN_MAILBOX_RECORDS.mailgunName(d)) values.push(mailgunSpfValid ? mailgunSpf : FAKE_OWN_MAILBOX_RECORDS.mailgunSpfPending);
        if (n === FAKE_FROM_DOMAIN_RECORDS.includeName) values.push(FAKE_FROM_DOMAIN_RECORDS.includeSpf);
        if (mailgunIncludes.includes(n)) values.push(FAKE_OWN_MAILBOX_RECORDS.mailgunIncludeSpf);
      }
      if (allValid && n === `_dmarc.${d}`) values.push(GUIDE_DMARC_RECORD);
      if (from) {
        if (n === from) values.push(FAKE_FROM_DOMAIN_RECORDS.spf);
        if (n === FAKE_FROM_DOMAIN_RECORDS.includeName) values.push(FAKE_FROM_DOMAIN_RECORDS.includeSpf);
        if (allValid && n === `_dmarc.${from}` && !values.includes(GUIDE_DMARC_RECORD)) values.push(GUIDE_DMARC_RECORD);
      }
      return found(values);
    },
    mx: async (name) => {
      if (own && host(name, d) === d) return found([{ priority: 10, exchange: FAKE_OWN_MAILBOX_RECORDS.mx }]);
      const values = of("MX", name).map((r) => ({ priority: Number(r.priority ?? 10) || 10, exchange: r.value }));
      if (from && host(name, d) === from) values.push({ priority: 10, exchange: FAKE_FROM_DOMAIN_RECORDS.mx });
      return found(values);
    },
    cname: async (name) => found(of("CNAME", name).map((r) => r.value)),
    a: async () => found<string>([]),
  };
}
