import { describe, expect, it } from "vitest";
import type { DnsRecordFact } from "@/core/dns/checklist";
import { FAKE_FROM_DOMAIN_RECORDS, GUIDE_DMARC_RECORD, mailgunRecordsLookup } from "@/server/services/checks/dns-lookup";
import { spfLookupReport } from "@/server/services/checks/spf-count";

/**
 * Fake mode (SHARED-FROM-DESIGN §5): besides Mailgun's own valid records, the lookup answers for the From domain as a
 * mail provider's domain would (MX, SPF with an include that isn't dangling, and the guide's DMARC record once every
 * Mailgun record is valid), so the lead's manual checks show from-mx and from-spf green without real DNS. Every other
 * name of the From domain is "missing".
 */

const D = "send.example.com";
const rec = (recordType: string, name: string | null, value: string, valid = "valid", priority: string | null = null): DnsRecordFact => ({
  recordType,
  name,
  value,
  priority,
  valid,
  isActive: true,
  cached: [],
});

function mailgun(valid = "valid") {
  return {
    sending: [
      rec("TXT", D, "v=spf1 include:mailgun.org ~all", valid),
      rec("TXT", "pdk1._domainkey.example.com", "k=rsa; p=MIIBfake", valid),
      rec("CNAME", `email.${D}`, "mailgun.org", valid),
    ],
    receiving: [rec("MX", null, "mxa.mailgun.org", valid, "10"), rec("MX", null, "mxb.mailgun.org", valid, "10")],
  };
}

describe("mailgunRecordsLookup with a From domain", () => {
  const lookup = mailgunRecordsLookup(D, mailgun(), { fromDomain: "Example.com" });

  it("answers the From domain's MX and SPF like a mail provider, and its DMARC once every record is valid", async () => {
    expect(await lookup.mx("example.com")).toEqual({ ok: true, value: [{ priority: 10, exchange: "mx.mail-provider.invalid" }] });
    expect(await lookup.txt("example.com")).toEqual({ ok: true, value: ["v=spf1 include:_spf.mail-provider.invalid ~all"] });
    expect(await lookup.txt("_spf.mail-provider.invalid")).toEqual({ ok: true, value: ["v=spf1 ip4:192.0.2.10 ~all"] });
    expect(await lookup.txt("_dmarc.example.com")).toEqual({ ok: true, value: [GUIDE_DMARC_RECORD] });
    expect(FAKE_FROM_DOMAIN_RECORDS.mx).toBe("mx.mail-provider.invalid");
  });

  it("keeps today's answers for the sending domain and Mailgun's DKIM record on the From domain", async () => {
    expect(await lookup.txt(D)).toEqual({ ok: true, value: ["v=spf1 include:mailgun.org ~all"] });
    expect(await lookup.txt(`_dmarc.${D}`)).toEqual({ ok: true, value: [GUIDE_DMARC_RECORD] });
    expect(await lookup.txt("pdk1._domainkey.example.com")).toEqual({ ok: true, value: ["k=rsa; p=MIIBfake"] });
    expect((await lookup.mx(D)).ok).toBe(true);
  });

  it("every other From-domain name is missing, and the include isn't dangling", async () => {
    expect(await lookup.txt("www.example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.mx("mail.example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.cname("example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.a("example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await spfLookupReport(FAKE_FROM_DOMAIN_RECORDS.spf, lookup)).toEqual({
      count: 1,
      complete: true,
      dangling: [],
      names: [FAKE_FROM_DOMAIN_RECORDS.includeName],
    });
  });

  it("no From-domain DMARC until every Mailgun record is valid; nothing for the From domain without the option", async () => {
    const pending = mailgunRecordsLookup(D, mailgun("unknown"), { fromDomain: "example.com" });
    expect(await pending.txt("_dmarc.example.com")).toMatchObject({ ok: false, code: "missing" });
    expect((await pending.mx("example.com")).ok).toBe(true);
    const plain = mailgunRecordsLookup(D, mailgun());
    expect(await plain.mx("example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await plain.txt("example.com")).toMatchObject({ ok: false, code: "missing" });
    expect(await plain.txt("_dmarc.example.com")).toMatchObject({ ok: false, code: "missing" });
  });
});
