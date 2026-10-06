import { describe, expect, it } from "vitest";
import { MAX_URL_CHARS } from "@/core/ai/site-rules";
import { checkHopUrl, parseStartUrl } from "@/server/web/url-rules";

/** M5-DESIGN §3.4.2 and §8 P3 "URL rules": checked for the start URL and before every hop. */

function start(website: string, allowOrigin?: string) {
  const r = parseStartUrl(website, { allowOrigin });
  return r.ok ? { ok: true as const, href: r.url.href } : { ok: false as const, skip: r.skip, detail: r.detail };
}

describe("parseStartUrl", () => {
  it("adds https:// when there is no scheme and keeps http:// when given", () => {
    expect(start("  www.figuren-werkstatt.example  ")).toEqual({ ok: true, href: "https://www.figuren-werkstatt.example/" });
    expect(start("http://butikk.example/shop")).toEqual({ ok: true, href: "http://butikk.example/shop" });
  });

  it("turns an IDN host into punycode", () => {
    expect(start("bücher.example/über-uns")).toEqual({ ok: true, href: "https://xn--bcher-kva.example/%C3%BCber-uns" });
  });

  it("gives no_website for an empty value", () => {
    expect(start("   ")).toMatchObject({ ok: false, skip: "no_website" });
  });

  it.each([
    ["https://www.figuren-werkstatt.example:8443/", "bad_url", "unusual port"],
    ["http://butikk.example:8080", "bad_url", "unusual port"],
    ["https://user:secret@butikk.example/", "bad_url", "user name or password"],
    ["ftp://butikk.example/", "bad_url", "Only http and https"],
    ["file:///C:/Windows/win.ini", "bad_url", "Only http and https"],
    ["javascript://alert(1)", "bad_url", "Only http and https"],
    ["http://a..b/", "bad_url", "empty part"],
    ["localhost", "bad_url", "no domain ending"],
    ["http://[fe80::1%25eth0]/", "bad_url", "can't be read"],
  ])("refuses %s as %s", (website, skip, detail) => {
    const r = start(website);
    expect(r).toMatchObject({ ok: false, skip });
    expect(r.ok ? "" : r.detail).toContain(detail);
  });

  it.each([
    ["http://0x7f.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
    ["http://[::1]/", "::1"],
    ["http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["http://100.64.0.1/", "100.64.0.1"],
    ["http://192.168.1.10/", "192.168.1.10"],
    ["http://10.0.0.1/", "10.0.0.1"],
    ["http://0.0.0.0/", "0.0.0.0"],
  ])("refuses the IP literal %s as private_address (the parser normalises it to %s)", (website, host) => {
    const r = start(website);
    expect(r).toMatchObject({ ok: false, skip: "private_address" });
    expect(r.ok ? "" : r.detail).toContain(host);
  });

  it("lets a public IP literal through", () => {
    expect(start("http://93.184.216.34/")).toEqual({ ok: true, href: "http://93.184.216.34/" });
  });

  it.each([
    ["https://www.instagram.com/figuren_werkstatt"],
    ["https://instagram.com./figuren"],
    ["instagr.am/figuren"],
    ["https://m.facebook.com/figuren"],
    ["https://www.tiktok.com/@figuren"],
    ["https://linktr.ee/figuren"],
    ["https://www.etsy.com/shop/Figuren"],
    ["https://x.com/figuren"],
    ["https://www.linkedin.com/company/figuren"],
  ])("gives social_only for %s", (website) => {
    expect(start(website)).toMatchObject({ ok: false, skip: "social_only" });
  });

  it("keeps hosted subdomains as real sites, site builders' included", () => {
    expect(start("anna.wixsite.com/figuren")).toEqual({ ok: true, href: "https://anna.wixsite.com/figuren" });
    expect(start("anna-minis.wordpress.com")).toEqual({ ok: true, href: "https://anna-minis.wordpress.com/" });
    expect(start("https://dragonforge.bigcartel.com")).toEqual({ ok: true, href: "https://dragonforge.bigcartel.com/" });
    expect(start("https://wordpress.com/")).toMatchObject({ ok: false, skip: "social_only" });
  });

  it(`refuses addresses longer than ${MAX_URL_CHARS} characters (every hop, before any other rule)`, () => {
    const atLimit = new URL(`https://studio.example/${"a".repeat(MAX_URL_CHARS - "https://studio.example/".length)}`);
    expect(atLimit.href).toHaveLength(MAX_URL_CHARS);
    expect(checkHopUrl(atLimit)).toBeNull();
    const over = new URL(`${atLimit.href}b`);
    expect(checkHopUrl(over)).toEqual({ skip: "bad_url", detail: "The website address is too long." });
    expect(start(over.href)).toMatchObject({ ok: false, skip: "bad_url", detail: "The website address is too long." });
  });

  it.each([
    ["https://sedo.com/search/details/?domain=figuren.example"],
    ["https://dan.com/buy-domain/figuren.example"],
    ["https://www.hugedomains.com/domain_profile.cfm?d=figuren.example"],
    ["https://www.godaddy.com/forsale/figuren.example"],
  ])("gives parked for the domain-sale page %s", (website) => {
    expect(start(website)).toMatchObject({ ok: false, skip: "parked" });
  });

  it("doesn't treat GoDaddy's other pages as a domain sale", () => {
    expect(checkHopUrl(new URL("https://www.godaddy.com/websites"))).toBeNull();
  });
});

describe("checkHopUrl with a test origin", () => {
  const origin = "http://127.0.0.1:4567";

  it("lets exactly the test origin through the port and IP rules", () => {
    expect(checkHopUrl(new URL(`${origin}/page`), { allowOrigin: origin })).toBeNull();
    expect(start(`${origin}/`, origin)).toEqual({ ok: true, href: `${origin}/` });
  });

  it("still refuses loopback on any other port, and other ports on the test host", () => {
    expect(checkHopUrl(new URL("http://127.0.0.1/"), { allowOrigin: origin })).toMatchObject({ skip: "private_address" });
    expect(checkHopUrl(new URL("http://127.0.0.1:4568/"), { allowOrigin: origin })).toMatchObject({ skip: "bad_url" });
    expect(checkHopUrl(new URL("https://127.0.0.1:4567/"), { allowOrigin: origin })).toMatchObject({ skip: "bad_url" });
    expect(checkHopUrl(new URL(`${origin}/`))).toMatchObject({ skip: "bad_url" });
  });
});
