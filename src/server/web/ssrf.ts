/**
 * SSRF guard for the website reader (docs/dev/M5-DESIGN.md §3.4.3; research ai-and-fetch-reference.md B2): only public
 * unicast addresses are ever connected to. Three layers: the URL rules refuse private IP literals before a request, the
 * DNS lookup refuses a host when ANY of its addresses is private (DNS rebinding with mixed answers), and the connector
 * checks the address it actually connected to (IP-literal hosts skip the lookup in Node). Worker only.
 */
import type { LookupAddress, LookupOptions } from "node:dns";
import { Resolver } from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { buildConnector } from "undici";

/** Error code for a refused private address; a blocked address is never retried and never falls back to http. */
export const BLOCKED_ADDRESS_CODE = "EBLOCKEDADDRESS";
/** Error code of the test-run socket guard: a test transport never opens a socket to anything but its own server. */
export const TEST_SOCKET_GUARD_CODE = "ETESTRUNSOCKET";

/**
 * Explicit denies that ipaddr.js may call "unicast": IPv4-compatible IPv6 (::/96, e.g. ::7f00:1 = 127.0.0.1),
 * deprecated site-local fec0::/10 and local-use NAT64 64:ff9b:1::/48.
 */
const IPV6_DENIES: ReadonlyArray<[ipaddr.IPv6, number]> = [
  ipaddr.IPv6.parseCIDR("::/96"),
  ipaddr.IPv6.parseCIDR("fec0::/10"),
  ipaddr.IPv6.parseCIDR("64:ff9b:1::/48"),
];

/** Brackets of an IPv6 URL host removed ("[::1]" → "::1"). */
export function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * True only for a public unicast address: after `ipaddr.process` (IPv4-mapped IPv6 becomes IPv4) the range must be
 * "unicast" (so loopback, private, link-local incl. 169.254.169.254, carrier-grade NAT, unique-local, multicast,
 * reserved, 6to4, Teredo and NAT64 are refused), and the address must not be inside the explicit denies above.
 */
export function isPublicIp(ip: string): boolean {
  const bare = stripBrackets(ip.trim());
  if (!bare || !ipaddr.isValid(bare)) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(bare);
  } catch {
    return false;
  }
  if (addr.range() !== "unicast") return false;
  if (addr.kind() === "ipv6") {
    for (const [range, bits] of IPV6_DENIES) if ((addr as ipaddr.IPv6).match(range, bits)) return false;
  }
  return true;
}

/** Resolves a host name to its A and AAAA addresses (never the hosts file). Injectable for tests. */
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

export const DNS_TIMEOUT_MS = 3_000;
export const DNS_TRIES = 2;

/**
 * The default resolver: a c-ares `Resolver` on the system's DNS servers asking A and AAAA (like the existing
 * createDnsLookup). Not `dns.lookup`: getaddrinfo runs on libuv's 4-thread pool, and slow company domains there would
 * starve the sending loop's Mailgun calls, file writes and zlib. Side effect, on purpose: the PC's hosts file can't
 * point a company domain at a LAN address.
 */
export function createSystemResolver(opts: { timeoutMs?: number; tries?: number } = {}): ResolveHost {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? DNS_TIMEOUT_MS, tries: opts.tries ?? DNS_TRIES });
  return async (hostname) => {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const list: LookupAddress[] = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (list.length > 0) return list;
    const reason = v4.status === "rejected" ? v4.reason : v6.status === "rejected" ? v6.reason : null;
    throw reason ?? Object.assign(new Error(`${hostname} has no addresses`), { code: "ENODATA" });
  };
}

let defaultResolver: ResolveHost | null = null;
function systemResolver(): ResolveHost {
  defaultResolver ??= createSystemResolver();
  return defaultResolver;
}

/** An Error carrying EBLOCKEDADDRESS (a private or otherwise non-public address). */
export function blockedAddressError(what: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${what} is not a public address`), { code: BLOCKED_ADDRESS_CODE });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/** Node's `net` lookup signature (both callback shapes: `all: true` gets the list). */
export type PublicOnlyLookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

/**
 * A `lookup` for net/tls/undici that resolves with every address and refuses the host (EBLOCKEDADDRESS) when the list
 * is empty or ANY address isn't public. Answers `callback(err, addresses[])` for `all: true` (what Node 24 asks with
 * autoSelectFamily) and `callback(err, address, family)` otherwise.
 */
export function makePublicOnlyLookup(resolve: ResolveHost = systemResolver()): PublicOnlyLookup {
  return (hostname, options, callback) => {
    const all = options?.all === true;
    const fail = (err: NodeJS.ErrnoException) => callback(err, all ? [] : "", undefined);
    let pending: Promise<LookupAddress[]>;
    try {
      pending = resolve(hostname.replace(/\.$/, ""));
    } catch (err) {
      fail(err as NodeJS.ErrnoException);
      return;
    }
    pending.then(
      (list) => {
        if (list.length === 0 || list.some((a) => !isPublicIp(a.address))) {
          fail(blockedAddressError(hostname));
          return;
        }
        const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
        const wanted = family ? list.filter((a) => a.family === family) : list;
        if (wanted.length === 0) {
          fail(Object.assign(new Error(`${hostname} has no IPv${family} address`), { code: "ENOTFOUND" }));
          return;
        }
        if (all) callback(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      (err: NodeJS.ErrnoException) => fail(err),
    );
  };
}

export type GuardedConnectorOptions = {
  lookup: PublicOnlyLookup;
  /** TCP connect timeout (undici's `connect.timeout`). */
  timeoutMs: number;
  /** The one loopback origin a test transport may connect to ("http://127.0.0.1:<port>"), or null. */
  allowOrigin: string | null;
  /**
   * Test run: every target but `allowOrigin` is refused before a socket is opened. The public-only rules still run
   * first, so a private target reports EBLOCKEDADDRESS exactly as in production.
   */
  testRun: boolean;
};

function originOf(o: buildConnector.Options): string {
  const port = o.port || (o.protocol === "https:" ? "443" : "80");
  return `${o.protocol}//${o.hostname}:${port}`;
}

/**
 * undici connector: connects through `lookup` (public addresses only), then checks `socket.remoteAddress` with
 * isPublicIp and destroys the socket otherwise (covers IP-literal hosts, where Node skips the lookup). The allowed test
 * origin may only end up on 127.0.0.1.
 */
export function createGuardedConnector(opts: GuardedConnectorOptions): buildConnector.connector {
  const base = buildConnector({ timeout: opts.timeoutMs, lookup: opts.lookup as unknown as net.LookupFunction });
  return (o, callback) => {
    const allowed = opts.allowOrigin !== null && originOf(o) === opts.allowOrigin;
    if (!allowed && o.port && o.port !== "80" && o.port !== "443") {
      callback(Object.assign(new Error(`Port ${o.port} is not allowed`), { code: BLOCKED_ADDRESS_CODE }), null);
      return;
    }
    if (opts.testRun && !allowed) {
      const refuse = () =>
        callback(
          Object.assign(new Error(`Test runs never open a socket to ${originOf(o)}`), { code: TEST_SOCKET_GUARD_CODE }),
          null,
        );
      const host = stripBrackets(o.hostname);
      if (net.isIP(host) !== 0) {
        if (isPublicIp(host)) refuse();
        else callback(blockedAddressError(host), null);
        return;
      }
      opts.lookup(host, { all: true }, (err) => (err ? callback(err, null) : refuse()));
      return;
    }
    base(o, (err, socket) => {
      if (err || !socket) {
        callback(err ?? new Error("The connection could not be opened"), null);
        return;
      }
      const remote = socket.remoteAddress ?? "";
      const ok = allowed ? stripBrackets(remote) === "127.0.0.1" : isPublicIp(remote);
      if (!ok) {
        socket.destroy();
        callback(blockedAddressError(remote || o.hostname), null);
        return;
      }
      callback(null, socket);
    });
  };
}

/** Every `code` in an error's `.cause` chain (and an AggregateError's `errors`), outermost first. */
export function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 20) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code) codes.push(code);
    const cause = (e as { cause?: unknown }).cause;
    if (cause) queue.push(cause);
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 5));
  }
  return codes;
}

/** True when a private address was refused anywhere in the error chain (skip `private_address` at once). */
export function isBlockedAddressError(err: unknown): boolean {
  return errorCodes(err).includes(BLOCKED_ADDRESS_CODE);
}
