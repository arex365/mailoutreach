import type { DnsAnswer, DnsLookup } from "@/core/dns/types";

/**
 * A fake DnsLookup for the checklist tests (research deliverability-dns.md "Plan implications": tests never call real
 * DNS). Each name maps to answers per record type; anything not listed is "missing" (NXDOMAIN/NODATA). Values can be
 * "timeout" or "error" to act like a resolver that couldn't be asked. TXT answers may be given as chunk arrays, which
 * are joined with "" as node:dns does after joinTxtChunks.
 */
export type FakeAnswer<T> = T | "timeout" | "error" | "missing";
export type FakeZone = Record<
  string,
  Partial<{
    txt: FakeAnswer<Array<string | string[]>>;
    mx: FakeAnswer<Array<{ priority: number; exchange: string }>>;
    cname: FakeAnswer<string[]>;
    a: FakeAnswer<string[]>;
  }>
>;

function answer<T, R>(v: FakeAnswer<T> | undefined, map: (x: T) => R): DnsAnswer<R> {
  if (v === undefined || v === "missing") return { ok: false, code: "missing", detail: "ENOTFOUND" };
  if (v === "timeout") return { ok: false, code: "timeout", detail: "ETIMEOUT" };
  if (v === "error") return { ok: false, code: "error", detail: "ESERVFAIL" };
  return { ok: true, value: map(v) };
}

export class FakeDns implements DnsLookup {
  readonly asked: string[] = [];
  constructor(private readonly zone: FakeZone) {}

  private entry(name: string) {
    const key = name.trim().toLowerCase().replace(/\.$/, "");
    return this.zone[key];
  }

  async txt(name: string): Promise<DnsAnswer<string[]>> {
    this.asked.push(`TXT ${name}`);
    return answer(this.entry(name)?.txt, (v) => v.map((r) => (Array.isArray(r) ? r.join("") : r)));
  }

  async mx(name: string): Promise<DnsAnswer<Array<{ priority: number; exchange: string }>>> {
    this.asked.push(`MX ${name}`);
    return answer(this.entry(name)?.mx, (v) => v);
  }

  async cname(name: string): Promise<DnsAnswer<string[]>> {
    this.asked.push(`CNAME ${name}`);
    return answer(this.entry(name)?.cname, (v) => v);
  }

  async a(name: string): Promise<DnsAnswer<string[]>> {
    this.asked.push(`A ${name}`);
    return answer(this.entry(name)?.a, (v) => v);
  }
}

/** A domain whose records all match the fake Mailgun's (tests/fake-mailgun/state.ts dnsRecords, EU). */
export function goodZone(domain = "send.example.com", dkim = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB"): FakeZone {
  return {
    [domain]: {
      txt: ["v=spf1 include:eu.mailgun.org ~all", "google-site-verification=abc123"],
      mx: [
        { priority: 10, exchange: "mxa.eu.mailgun.org" },
        { priority: 10, exchange: "mxb.eu.mailgun.org" },
      ],
    },
    "eu.mailgun.org": { txt: ["v=spf1 include:_spf.eu.mailgun.org -all"] },
    "_spf.eu.mailgun.org": { txt: ["v=spf1 ip4:141.193.32.0/23 ip4:159.135.140.80/29 ~all"] },
    [`pdk1._domainkey.${domain}`]: { txt: [[dkim.slice(0, 60), dkim.slice(60)]] },
    [`email.${domain}`]: { cname: ["eu.mailgun.org."] },
    [`_dmarc.${domain}`]: { txt: ["v=DMARC1; p=none"] },
  };
}
