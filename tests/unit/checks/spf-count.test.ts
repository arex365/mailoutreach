import { describe, expect, it } from "vitest";
import { countSpfLookups, spfLookupReport } from "@/server/services/checks/spf-count";
import { FakeDns } from "./fake-dns";

/**
 * The From domain's SPF record (SHARED-FROM-DESIGN §5, C2-6): the same walk as the lookup count also lists the
 * included names that have no SPF record ("dangling"), which makes receivers treat the whole record as broken. A timeout
 * never makes a name dangling; it only makes the count unsure. The sending domain's count is unchanged.
 */

const zone = new FakeDns({
  "zoho.com": { txt: ["v=spf1 include:transmail.net include:zcsend.net ~all"] },
  "transmail.net": { txt: ["v=spf1 ip4:136.143.188.0/24 ~all"] },
  "zcsend.net": { txt: ["v=spf1 ip4:135.84.80.0/24 ~all"] },
  "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org -all"] },
  "_spf.mailgun.org": { txt: ["v=spf1 ip4:1.2.3.0/24 ~all"] },
  // dc-aa11bb_spfm.example.com, gone.example.net and gone.example.org aren't listed: NXDOMAIN.
  "notspf.example.com": { txt: ["google-site-verification=abc"] },
  "slow.example.com": { txt: "timeout" },
  "nested.example.com": { txt: ["v=spf1 include:gone.example.net ~all"] },
});

describe("spfLookupReport: dangling includes", () => {
  it("lists none for a healthy record, with the same count as countSpfLookups", async () => {
    const record = "v=spf1 include:zoho.com include:mailgun.org ~all";
    const report = await spfLookupReport(record, zone);
    // 2 in the record, 2 in zoho.com's, 1 in mailgun.org's.
    expect(report).toEqual({ count: 5, complete: true, dangling: [], names: ["zoho.com", "transmail.net", "zcsend.net", "mailgun.org", "_spf.mailgun.org"] });
    expect(await countSpfLookups(record, zone)).toEqual({ count: 5, complete: true });
  });

  it("an include with NXDOMAIN, or a TXT without v=spf1, is dangling (at any depth, and a redirect too)", async () => {
    expect(await spfLookupReport("v=spf1 include:dc-aa11bb_spfm.example.com include:zoho.com ~all", zone)).toMatchObject({
      dangling: ["dc-aa11bb_spfm.example.com"],
      complete: true,
    });
    expect((await spfLookupReport("v=spf1 include:notspf.example.com ~all", zone)).dangling).toEqual(["notspf.example.com"]);
    expect((await spfLookupReport("v=spf1 include:nested.example.com ~all", zone)).dangling).toEqual(["gone.example.net"]);
    expect((await spfLookupReport("v=spf1 redirect=gone.example.org", zone)).dangling).toEqual(["gone.example.org"]);
  });

  it("a timeout is not dangling: the count is only incomplete", async () => {
    expect(await spfLookupReport("v=spf1 include:slow.example.com ~all", zone)).toEqual({
      count: 1,
      complete: false,
      dangling: [],
      names: ["slow.example.com"],
    });
  });
});

/**
 * MAIN-DOMAIN-DESIGN §5 (O11): the walk also lists every name it looked up, so own-mailbox mode's SPF row finds
 * Mailgun's include anywhere in the tree (GoDaddy wraps it in `dc-…._spfm.<domain>`).
 */
describe("spfLookupReport: the names looked up", () => {
  const godaddy = new FakeDns({
    "dc-1._spfm.example.com": { txt: ["v=spf1 include:zoho.com ~all"] },
    "dc-2._spfm.example.com": { txt: ["v=spf1 include:mailgun.org ~all"] },
    "zoho.com": { txt: ["v=spf1 include:transmail.net include:zcsend.net ~all"] },
    "transmail.net": { txt: ["v=spf1 ip4:136.143.188.0/24 ~all"] },
    "zcsend.net": { txt: ["v=spf1 ip4:135.84.80.0/24 ~all"] },
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org -all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 ip4:1.2.3.0/24 ~all"] },
    "slow.example.com": { txt: "timeout" },
    // 10 lookups of its own: a, mx, ptr and seven includes (x1…x7, none of which exists).
    "big.example.com": { txt: [`v=spf1 a mx ptr ${[1, 2, 3, 4, 5, 6, 7].map((i) => `include:x${i}.example.com`).join(" ")} ~all`] },
    "after.example.com": { txt: ["v=spf1 include:mailgun.org ~all"] },
  });

  it("lists every include in walk order (depth first), Mailgun's among them however deep it is", async () => {
    const record = "v=spf1 include:dc-1._spfm.example.com include:dc-2._spfm.example.com ~all";
    const report = await spfLookupReport(record, godaddy);
    expect(report.names).toEqual([
      "dc-1._spfm.example.com",
      "zoho.com",
      "transmail.net",
      "zcsend.net",
      "dc-2._spfm.example.com",
      "mailgun.org",
      "_spf.mailgun.org",
    ]);
    expect(report).toMatchObject({ count: 7, complete: true, dangling: [] });
    // countSpfLookups is unchanged: the same count, no names.
    expect(await countSpfLookups(record, godaddy)).toEqual({ count: 7, complete: true });
  });

  it("includes dangling names, a timeout's name and a redirect, each once", async () => {
    const report = await spfLookupReport(
      "v=spf1 include:dc-1._spfm.example.com include:gone.example.net include:slow.example.com include:dc-1._spfm.example.com redirect=dc-2._spfm.example.com",
      godaddy,
    );
    expect(report.names).toEqual([
      "dc-1._spfm.example.com",
      "zoho.com",
      "transmail.net",
      "zcsend.net",
      "gone.example.net",
      "slow.example.com",
      "dc-2._spfm.example.com",
      "mailgun.org",
      "_spf.mailgun.org",
    ]);
    expect(report.dangling).toEqual(["gone.example.net"]);
    expect(report.complete).toBe(false);
  });

  it("review DOMAIN-1, countRepeats: a repeated include costs its lookups every time; each name is asked once, listed once", async () => {
    const tree = new FakeDns({
      "dc-1._spfm.example.com": { txt: ["v=spf1 include:zoho.com ~all"] },
      "dc-2._spfm.example.com": { txt: ["v=spf1 include:mailgun.org ~all"] },
      "zoho.com": { txt: ["v=spf1 include:transmail.net include:zcsend.net ~all"] },
      "transmail.net": { txt: ["v=spf1 ip4:136.143.188.0/24 ~all"] },
      "zcsend.net": { txt: ["v=spf1 ip4:135.84.80.0/24 ~all"] },
      "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org -all"] },
      "_spf.mailgun.org": { txt: ["v=spf1 ip4:1.2.3.0/24 ~all"] },
    });
    const owner = "v=spf1 include:dc-1._spfm.example.com include:dc-2._spfm.example.com ~all";
    // The owner's tree, and the same tree after someone added include:mailgun.org at the top as well: 7 → 7 + 2
    // (the include itself, and mailgun.org's own include again).
    expect(await spfLookupReport(owner, tree, 0, { countRepeats: true })).toMatchObject({ count: 7, complete: true, dangling: [] });
    const twice = "v=spf1 include:dc-1._spfm.example.com include:dc-2._spfm.example.com include:mailgun.org ~all";
    const repeated = await spfLookupReport(twice, tree, 0, { countRepeats: true });
    expect(repeated).toMatchObject({ count: 9, complete: true, dangling: [] });
    expect(repeated.names).toEqual(["dc-1._spfm.example.com", "zoho.com", "transmail.net", "zcsend.net", "dc-2._spfm.example.com", "mailgun.org", "_spf.mailgun.org"]);
    // The earlier walk (app mode, unchanged) skipped the repeat's subtree.
    expect((await spfLookupReport(twice, tree)).count).toBe(8);
    expect(await countSpfLookups(twice, tree)).toEqual({ count: 8, complete: true });
    // Each name is asked of the resolver once, however often it is included.
    const asking = new FakeDns({ "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org -all"] }, "_spf.mailgun.org": { txt: ["v=spf1 ip4:1.2.3.0/24 ~all"] } });
    const thrice = await spfLookupReport("v=spf1 include:mailgun.org include:mailgun.org include:mailgun.org ~all", asking, 0, { countRepeats: true });
    expect(thrice).toMatchObject({ count: 6, complete: true, names: ["mailgun.org", "_spf.mailgun.org"] });
    expect(asking.asked).toEqual(["TXT mailgun.org", "TXT _spf.mailgun.org"]);
    // A name without an SPF record, included twice: counted twice, listed once.
    expect(await spfLookupReport("v=spf1 include:gone.example include:gone.example ~all", tree, 0, { countRepeats: true })).toEqual({
      count: 2,
      complete: true,
      dangling: ["gone.example"],
      names: ["gone.example"],
    });
  });

  it("review DOMAIN-1, countRepeats: an include loop is over 10 (the depth limit cuts it), never a small sure count", async () => {
    const loop = new FakeDns({
      "a.loop.example": { txt: ["v=spf1 include:b.loop.example ~all"] },
      "b.loop.example": { txt: ["v=spf1 include:a.loop.example ~all"] },
    });
    const r = await spfLookupReport("v=spf1 include:a.loop.example ~all", loop, 0, { countRepeats: true });
    expect(r.count).toBeGreaterThan(10);
    expect(loop.asked).toEqual(["TXT a.loop.example", "TXT b.loop.example"]);
  });

  it("stops looking names up once the count passes 10 (a record over 10 may not list them all)", async () => {
    // 2 in the record + 10 in big.example.com = 12: after.example.com (and the Mailgun include in it) is never asked.
    const report = await spfLookupReport("v=spf1 include:big.example.com include:after.example.com ~all", godaddy);
    expect(report.count).toBe(12);
    expect(report.names).toEqual(["big.example.com", ...[1, 2, 3, 4, 5, 6, 7].map((i) => `x${i}.example.com`)]);
    expect(report.names).not.toContain("after.example.com");
    expect(report.names).not.toContain("mailgun.org");
  });
});
