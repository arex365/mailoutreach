import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_ADDRESS_CODE,
  errorCodes,
  isBlockedAddressError,
  isPublicIp,
  makePublicOnlyLookup,
  type ResolveHost,
} from "@/server/web/ssrf";

/**
 * M5-DESIGN §3.4.3 and §8 P3 "SSRF unit": only public unicast addresses pass, including the explicit denies ipaddr.js
 * would call unicast, and the lookup refuses a host when ANY of its addresses is private.
 */

describe("isPublicIp", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["[::1]", "IPv6 loopback in URL brackets"],
    ["::1", "IPv6 loopback"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["[::ffff:7f00:1]", "IPv4-mapped loopback as the URL parser writes it"],
    ["169.254.169.254", "cloud metadata (link-local)"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["192.168.1.10", "private"],
    ["10.0.0.1", "private"],
    ["172.16.5.4", "private"],
    ["fe80::1%eth0", "link-local with a zone id"],
    ["64:ff9b::a00:1", "NAT64 embedding 10.0.0.1"],
    ["2002:c0a8:0101::", "6to4 embedding 192.168.1.1"],
    ["0.0.0.0", "unspecified"],
    ["::7f00:1", "IPv4-compatible (explicit deny ::/96)"],
    ["fec0::1", "site-local (explicit deny fec0::/10)"],
    ["64:ff9b:1::a00:1", "local-use NAT64 (explicit deny 64:ff9b:1::/48)"],
    ["fd12:3456::1", "unique-local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["", "empty"],
    ["not-an-ip", "garbage"],
  ];
  it.each(blocked)("refuses %s (%s)", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([["8.8.8.8"], ["93.184.216.34"], ["2606:4700::1111"], ["::ffff:8.8.8.8"], ["[2a00:1450:4001:80b::200e]"]])(
    "lets %s through",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

type Answer = { err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number };

function fakeResolver(table: Record<string, string[] | Error>): ResolveHost & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const entry = table[host];
    if (entry === undefined) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    if (entry instanceof Error) throw entry;
    return entry.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as ResolveHost & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function lookupOnce(lookup: ReturnType<typeof makePublicOnlyLookup>, host: string, all: boolean, family?: number): Promise<Answer> {
  return new Promise((resolve) => {
    lookup(host, { all, family }, (err, address, fam) => resolve({ err, address, family: fam }));
  });
}

describe("makePublicOnlyLookup", () => {
  const resolver = fakeResolver({
    "public.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    "private.example": ["10.0.0.1"],
    "mixed.example": ["93.184.216.34", "127.0.0.1"],
    "mapped.example": ["::ffff:192.168.1.1"],
    "empty.example": [],
    "trailing.example": ["93.184.216.34"],
    "broken.example": Object.assign(new Error("queryA ETIMEOUT broken.example"), { code: "ETIMEOUT" }),
  });
  const lookup = makePublicOnlyLookup(resolver);

  it("answers the list for all: true and the first address for all: false", async () => {
    const all = await lookupOnce(lookup, "public.example", true);
    expect(all.err).toBeNull();
    expect(all.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const one = await lookupOnce(lookup, "public.example", false);
    expect(one).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("honours a family filter after checking every address", async () => {
    const v6 = await lookupOnce(lookup, "public.example", false, 6);
    expect(v6.address).toBe("2606:2800:220:1:248:1893:25c8:1946");
    expect(v6.family).toBe(6);
  });

  it.each([
    ["private.example", "a private address"],
    ["mixed.example", "one public and one loopback address (DNS rebinding)"],
    ["mapped.example", "an IPv4-mapped private address"],
    ["empty.example", "no address at all"],
  ])("refuses %s (%s) with EBLOCKEDADDRESS in both shapes", async (host) => {
    for (const all of [true, false]) {
      const res = await lookupOnce(lookup, host, all);
      expect((res.err as NodeJS.ErrnoException | null)?.code).toBe(BLOCKED_ADDRESS_CODE);
      expect(res.address).toEqual(all ? [] : "");
    }
  });

  it("passes resolver errors through unchanged", async () => {
    const res = await lookupOnce(lookup, "broken.example", true);
    expect(res.err?.code).toBe("ETIMEOUT");
    const missing = await lookupOnce(lookup, "nowhere.example", false);
    expect(missing.err?.code).toBe("ENOTFOUND");
  });

  it("asks the resolver without the trailing dot", async () => {
    const res = await lookupOnce(lookup, "trailing.example.", false);
    expect(res.err).toBeNull();
    expect(resolver.calls).toContain("trailing.example");
  });
});

describe("error chains", () => {
  it("finds EBLOCKEDADDRESS anywhere in the cause chain or an AggregateError", () => {
    const inner = Object.assign(new Error("blocked"), { code: BLOCKED_ADDRESS_CODE });
    const fetchFailed = new TypeError("fetch failed", { cause: inner });
    expect(isBlockedAddressError(fetchFailed)).toBe(true);
    const aggregate = new TypeError("fetch failed", {
      cause: new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" }), inner]),
    });
    expect(isBlockedAddressError(aggregate)).toBe(true);
    expect(errorCodes(aggregate)).toEqual(["ECONNREFUSED", BLOCKED_ADDRESS_CODE]);
    expect(isBlockedAddressError(new Error("plain"))).toBe(false);
  });

  it("survives a cause cycle", () => {
    const a: Error & { cause?: unknown; code?: string } = Object.assign(new Error("a"), { code: "EA" });
    const b = Object.assign(new Error("b"), { code: "EB", cause: a });
    a.cause = b;
    expect(errorCodes(a)).toEqual(["EA", "EB"]);
  });
});
