import { describe, expect, it } from "vitest";
import { dnsFailure } from "@/server/services/checks/dns-lookup";
import { findDmarc } from "@/server/services/checks/dmarc-walk";
import { countSpfLookups } from "@/server/services/checks/spf-count";
import { FakeDns } from "./fake-dns";

describe("dnsFailure (node:dns error codes)", () => {
  it("maps NXDOMAIN/NODATA to missing, timeouts to timeout and the rest to error", () => {
    const e = (code: string) => Object.assign(new Error(`query ${code}`), { code });
    expect(dnsFailure(e("ENOTFOUND"))).toMatchObject({ ok: false, code: "missing" });
    expect(dnsFailure(e("ENODATA"))).toMatchObject({ ok: false, code: "missing" });
    expect(dnsFailure(e("ETIMEOUT"))).toMatchObject({ ok: false, code: "timeout" });
    expect(dnsFailure(e("ECANCELLED"))).toMatchObject({ ok: false, code: "timeout" });
    expect(dnsFailure(e("ESERVFAIL"))).toMatchObject({ ok: false, code: "error", detail: "ESERVFAIL" });
    expect(dnsFailure(new Error("odd"))).toMatchObject({ ok: false, code: "error", detail: "odd" });
  });
});

describe("countSpfLookups", () => {
  // Today include:mailgun.org costs 5 lookups (research §1): mailgun.org → _spf.mailgun.org → _spf1/_spf2, + the EU one.
  const mailgun = new FakeDns({
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org include:_spf.eu.mailgun.org -all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 include:_spf1.mailgun.org include:_spf2.mailgun.org ~all"] },
    "_spf1.mailgun.org": { txt: ["v=spf1 ip4:1.2.3.0/24 ~all"] },
    "_spf2.mailgun.org": { txt: ["v=spf1 ip4:5.6.7.0/24 ~all"] },
    "_spf.eu.mailgun.org": { txt: ["v=spf1 ip4:9.9.9.0/24 ~all"] },
  });

  it("counts includes recursively", async () => {
    expect(await countSpfLookups("v=spf1 include:mailgun.org ~all", mailgun)).toEqual({ count: 5, complete: true });
    expect(await countSpfLookups("v=spf1 a mx include:mailgun.org ~all", mailgun)).toEqual({ count: 7, complete: true });
  });

  it("follows redirect=, survives a loop, and marks a timeout incomplete", async () => {
    const dns = new FakeDns({
      "loop.test": { txt: ["v=spf1 include:loop2.test ~all"] },
      "loop2.test": { txt: ["v=spf1 include:loop.test ~all"] },
      "slow.test": { txt: "timeout" },
      "gone.test": { txt: "missing" },
      "next.test": { txt: ["v=spf1 mx ~all"] },
    });
    expect(await countSpfLookups("v=spf1 include:loop.test ~all", dns)).toEqual({ count: 3, complete: true });
    expect(await countSpfLookups("v=spf1 include:slow.test ~all", dns)).toEqual({ count: 1, complete: false });
    expect(await countSpfLookups("v=spf1 include:gone.test ~all", dns)).toEqual({ count: 1, complete: true });
    expect(await countSpfLookups("v=spf1 redirect=next.test", dns)).toEqual({ count: 2, complete: true });
  });

  it("stops counting once it passes 10", async () => {
    const zone: Record<string, { txt: string[] }> = {};
    for (let i = 0; i < 15; i++) zone[`s${i}.test`] = { txt: ["v=spf1 a mx ~all"] };
    const record = `v=spf1 ${Array.from({ length: 15 }, (_, i) => `include:s${i}.test`).join(" ")} ~all`;
    const res = await countSpfLookups(record, new FakeDns(zone));
    expect(res.count).toBeGreaterThan(10);
  });
});

describe("findDmarc (RFC 9989 tree walk)", () => {
  it("finds the domain's own record", async () => {
    const dns = new FakeDns({ "_dmarc.send.example.com": { txt: ["v=DMARC1; p=none; rua=mailto:dmarc@send.example.com"] } });
    const r = await findDmarc("send.example.com", dns);
    expect(r).toMatchObject({ at: "send.example.com", duplicates: false, inherited: false, error: null });
    expect(r.policy?.p).toBe("none");
    expect(r.policy?.rua).toEqual(["mailto:dmarc@send.example.com"]);
  });

  it("inherits the parent's policy for a subdomain (mail.polygonparadise.com)", async () => {
    const dns = new FakeDns({ "_dmarc.polygonparadise.com": { txt: ["v=DMARC1; p=quarantine; sp=reject"] } });
    const r = await findDmarc("mail.polygonparadise.com", dns);
    expect(r).toMatchObject({ at: "polygonparadise.com", inherited: true, duplicates: false });
    expect(r.policy).toMatchObject({ p: "quarantine", sp: "reject" });
    expect(dns.asked).toEqual(["TXT _dmarc.mail.polygonparadise.com", "TXT _dmarc.polygonparadise.com"]);
  });

  it("reports two records as duplicates, skips non-DMARC TXT, and a timeout as an error", async () => {
    const dup = new FakeDns({ "_dmarc.d.example.com": { txt: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] } });
    expect(await findDmarc("d.example.com", dup)).toMatchObject({ at: "d.example.com", policy: null, duplicates: true });
    const noise = new FakeDns({ "_dmarc.n.example.com": { txt: ["some other text"] } });
    expect(await findDmarc("n.example.com", noise)).toMatchObject({ at: null, policy: null, duplicates: false, error: null });
    const slow = new FakeDns({ "_dmarc.s.example.com": { txt: "timeout" } });
    expect(await findDmarc("s.example.com", slow)).toMatchObject({ at: null, policy: null, error: "ETIMEOUT" });
  });
});
