import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dkimKeyBits, dkimPublicKey, sameCnameTarget } from "@/core/dns/dkim";
import { dmarcParents, dmarcRecords, parseDmarc, ruaAuthorizationName } from "@/core/dns/dmarc";
import { spfHasAll, spfIncludes, spfLookupTerms, spfRecords } from "@/core/dns/spf";
import { agree, joinTxtChunks, type DnsAnswer } from "@/core/dns/types";

const ok = <T>(value: T): DnsAnswer<T> => ({ ok: true, value });
const missing: DnsAnswer<string[]> = { ok: false, code: "missing", detail: "ENOTFOUND" };
const timeout: DnsAnswer<string[]> = { ok: false, code: "timeout", detail: "ETIMEOUT" };
const error: DnsAnswer<string[]> = { ok: false, code: "error", detail: "ESERVFAIL" };
const hasMailgun = (txt: string[]) => txt.some((r) => r.includes("include:mailgun.org"));

describe("agree", () => {
  const good = ok(["v=spf1 include:mailgun.org ~all"]);
  const wrong = ok(["v=spf1 -all"]);

  it("tells both, one, none and unknown apart", () => {
    expect(agree(good, good, hasMailgun)).toBe("both");
    expect(agree(good, missing, hasMailgun)).toBe("one");
    expect(agree(wrong, good, hasMailgun)).toBe("one");
    expect(agree(good, timeout, hasMailgun)).toBe("one");
    expect(agree(missing, missing, hasMailgun)).toBe("none");
    expect(agree(wrong, missing, hasMailgun)).toBe("none");
    // A resolver that couldn't be asked never makes a row red.
    expect(agree(missing, timeout, hasMailgun)).toBe("unknown");
    expect(agree(timeout, error, hasMailgun)).toBe("unknown");
  });
});

describe("SPF", () => {
  it("joins a record's chunks without adding spaces", () => {
    const records = joinTxtChunks([["v=spf1 include:mailgun.org", " ~all"], ["google-site-verification=abc"], "plain"]);
    expect(records).toEqual(["v=spf1 include:mailgun.org ~all", "google-site-verification=abc", "plain"]);
    expect(spfRecords(records)).toEqual(["v=spf1 include:mailgun.org ~all"]);
  });

  it("finds every SPF record, so two can be reported", () => {
    const txt = ["v=spf1 include:mailgun.org ~all", "V=SPF1 include:_spf.google.com -all", "v=spf10 nope", "v=spf1", "hello"];
    expect(spfRecords(txt)).toEqual(["v=spf1 include:mailgun.org ~all", "V=SPF1 include:_spf.google.com -all", "v=spf1"]);
  });

  it("lists the includes", () => {
    expect(spfIncludes("v=spf1 include:mailgun.org +include:_spf.Google.com. ip4:1.2.3.4 ~all")).toEqual([
      "mailgun.org",
      "_spf.google.com",
    ]);
    expect(spfIncludes("v=spf1 -all")).toEqual([]);
  });

  it("counts the lookup terms of one record", () => {
    expect(spfLookupTerms("v=spf1 include:mailgun.org ~all")).toBe(1);
    expect(
      spfLookupTerms(
        "v=spf1 include:mailgun.org a mx a:web.example.com/24 mx/24 ip4:1.2.3.4 ip6:2001:db8::1 ptr exists:%{i}.x.example redirect=_spf.example.com exp=explain.example.com ~all",
      ),
    ).toBe(8);
    expect(spfLookupTerms("v=spf1 ip4:1.2.3.4 all")).toBe(0);
    expect(spfLookupTerms("v=spf1 ~include:a.com ?mx -a")).toBe(3);
  });

  it("reads how the record ends", () => {
    expect(spfHasAll("v=spf1 include:mailgun.org ~all", "~")).toBe(true);
    expect(spfHasAll("v=spf1 include:mailgun.org ~all", "-")).toBe(false);
    expect(spfHasAll("v=spf1 include:mailgun.org all", "+")).toBe(true);
    expect(spfHasAll("v=spf1 +all", "+")).toBe(true);
    expect(spfHasAll("v=spf1 -ALL", "-")).toBe(true);
    expect(spfHasAll("v=spf1 include:mailgun.org", "~")).toBe(false);
  });
});

describe("DMARC", () => {
  it("parses the tags", () => {
    expect(parseDmarc("v=DMARC1; p=none; rua=mailto:dmarc@send.example.com, mailto:x@reports.example.net; adkim=r; aspf=s")).toEqual({
      p: "none",
      sp: null,
      rua: ["mailto:dmarc@send.example.com", "mailto:x@reports.example.net"],
      adkim: "r",
      aspf: "s",
      raw: "v=DMARC1; p=none; rua=mailto:dmarc@send.example.com, mailto:x@reports.example.net; adkim=r; aspf=s",
    });
    expect(parseDmarc("v=DMARC1;P=Quarantine;SP=reject;")).toMatchObject({ p: "quarantine", sp: "reject", rua: [] });
    expect(parseDmarc("v=DMARC1")).toMatchObject({ p: null, sp: null, rua: [] });
  });

  it("keeps only records that start with v=DMARC1, so duplicates can be reported", () => {
    const txt = ["v=DMARC1; p=none", "v=DMARC1; p=reject", "p=none; v=DMARC1", "v=DMARC2; p=none", "google-site-verification=x"];
    expect(dmarcRecords(txt)).toEqual(["v=DMARC1; p=none", "v=DMARC1; p=reject"]);
    expect(dmarcRecords([" v = DMARC1 ; p=none"])).toHaveLength(1);
  });

  it("walks up the tree to the registrable domain, not to the public suffix", () => {
    expect(dmarcParents("mail.polygonparadise.com")).toEqual(["mail.polygonparadise.com", "polygonparadise.com"]);
    expect(dmarcParents("Send.Example.co.uk.")).toEqual(["send.example.co.uk", "example.co.uk"]);
    expect(dmarcParents("polygonparadise.com")).toEqual(["polygonparadise.com"]);
    expect(dmarcParents("com")).toEqual([]);
    expect(dmarcParents("co.uk")).toEqual([]);
    expect(dmarcParents("")).toEqual([]);
  });

  it("asks at most 8 names for a very long name", () => {
    const walk = dmarcParents("a.b.c.d.e.f.g.h.i.example.com");
    expect(walk.length).toBeLessThanOrEqual(8);
    expect(walk[0]).toBe("a.b.c.d.e.f.g.h.i.example.com");
    expect(walk[1]).toBe("e.f.g.h.i.example.com");
    expect(walk[walk.length - 1]).toBe("example.com");
  });

  it("names the record that authorises reports to another domain", () => {
    expect(ruaAuthorizationName("Send.Example.com.", "reports.example.net")).toBe("send.example.com._report._dmarc.reports.example.net");
  });
});

describe("DKIM", () => {
  const spki = (bits: number) =>
    generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({ type: "spki", format: "der" }).toString("base64");

  it("reads the key and its size from real-looking records", () => {
    const k2048 = spki(2048);
    const k1024 = spki(1024);
    expect(k2048).toHaveLength(392);
    expect(k1024).toHaveLength(216);
    // DNS hosts show long values split; the key is read without the whitespace.
    const record = `k=rsa; p=${k2048.slice(0, 200)} ${k2048.slice(200)}`;
    expect(dkimPublicKey(record)).toBe(k2048);
    expect(dkimKeyBits(dkimPublicKey(record)!)).toBe(2048);
    expect(dkimKeyBits(k1024)).toBe(1024);
  });

  it("reads a bare PKCS#1 key too", () => {
    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ type: "pkcs1", format: "der" })
      .toString("base64");
    expect(dkimKeyBits(pkcs1)).toBe(1024);
  });

  it("returns null for a revoked, missing or unreadable key", () => {
    expect(dkimPublicKey("v=DKIM1; k=rsa; p=")).toBeNull();
    expect(dkimPublicKey("v=DKIM1; k=rsa")).toBeNull();
    expect(dkimKeyBits("not base64!")).toBeNull();
    expect(dkimKeyBits("QUJD")).toBeNull();
    const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(dkimKeyBits(ed)).toBeNull();
  });

  it("compares CNAME targets without case or trailing dots", () => {
    expect(sameCnameTarget("PDK1._domainkey.abc.dkim1.mailgun.com.", "pdk1._domainkey.abc.dkim1.mailgun.com")).toBe(true);
    expect(sameCnameTarget("eu.mailgun.org", "eu.mailgun.org.")).toBe(true);
    expect(sameCnameTarget("mailgun.org", "eu.mailgun.org")).toBe(false);
    expect(sameCnameTarget("", "")).toBe(false);
  });
});
