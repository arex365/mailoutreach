import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createReader } from "@/server/web/reader";
import { immediatePoliteness } from "@/server/web/politeness";
import { memoryRobotsStore } from "@/server/web/robots";
import { TEST_SOCKET_GUARD_CODE, errorCodes, type ResolveHost } from "@/server/web/ssrf";
import { createRealTransport, type RealTransport } from "@/server/web/transport";

/**
 * M5-DESIGN §3.4.3–§3.4.4 and §8 P3 "Real transport": undici with the guarded connector against a loopback server this
 * test starts itself (`testAllowOrigin`), an injected resolver, and the B12 SSRF targets. Nothing leaves the PC: the
 * test-run socket guard refuses every socket but the test's own server.
 */

const PAGE = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loopback studio</title></head><body>${body}</body></html>`;
const TEXT = "<main><p>" + "We carve and cast small stone-look dragons for garden shops and collectors. ".repeat(6) + "</p></main>";

type Hit = { path: string; at: number };
const hits: Hit[] = [];
let bigClosedEarly = false;
let server: http.Server;
let origin = "";

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  hits.push({ path: url.pathname + url.search, at: Date.now() });
  const html = (status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  const redirect = (to: string) => {
    res.writeHead(302, { location: to });
    res.end();
  };
  switch (url.pathname) {
    case "/robots.txt":
      return html(404, "not found");
    case "/":
      return html(200, PAGE(`<nav><a href="/galerie">Galerie</a></nav>${TEXT}`));
    case "/galerie":
      return html(200, PAGE("<main><p>Stone-look dragons, 40 cm, cast in concrete and sealed for outdoor use.</p></main>"));
    case "/r":
      return redirect(url.searchParams.get("to") ?? "/");
    case "/slow":
      setTimeout(() => html(200, PAGE(TEXT)), 3_000).unref();
      return;
    case "/big": {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const chunk = Buffer.from("<p>" + "Dragon statue for gardens, cast in concrete. ".repeat(1_450) + "</p>\n");
      let sent = 0;
      res.on("close", () => {
        if (sent < 3 * 1024 * 1024) bigClosedEarly = true;
      });
      const pump = () => {
        while (sent < 3 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      res.write("<!doctype html><html><body>");
      pump();
      return;
    }
    case "/gzip-small": {
      const body = Buffer.from(PAGE(TEXT));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(body));
      return;
    }
    case "/gzip-bomb": {
      const lines: string[] = [];
      for (let i = 0, size = 0; size < 3 * 1024 * 1024; i++) {
        const line = `<p>Line ${i} of a page that is small on the wire and big once decoded.</p>\n`;
        lines.push(line);
        size += line.length;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(Buffer.from(`<html><body>${lines.join("")}</body></html>`)));
      return;
    }
    case "/a":
      return redirect("/b");
    case "/b":
      return redirect("/c");
    case "/c":
      return redirect("/home");
    case "/home":
      return html(200, PAGE(`<nav><a href="/gallery">Gallery</a></nav>${TEXT}`));
    case "/gallery":
      return redirect("/g1");
    case "/g1":
      return redirect("/g2");
    case "/g2":
      return redirect("/g3");
    default:
      return html(404, "not found");
  }
}

const resolverCalls: string[] = [];
const resolve: ResolveHost = async (host) => {
  resolverCalls.push(host);
  const table: Record<string, string[]> = {
    localhost: ["127.0.0.1", "::1"],
    "internal.example": ["10.0.0.1"],
    "public.example": ["93.184.216.34"],
  };
  const list = table[host];
  if (!list) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

let transport: RealTransport;

function reader(opts: { pageTimeoutMs?: number } = {}) {
  const r = createReader({ transport, robotsStore: memoryRobotsStore(), politeness: immediatePoliteness, sleep: async () => {}, ...opts });
  return (website: string) => r.read({ website, companyName: "Loopback" }, { signal: new AbortController().signal, now: new Date() });
}

beforeAll(async () => {
  server = http.createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  transport = createRealTransport({ testAllowOrigin: origin, resolve });
});

afterAll(async () => {
  await transport.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

afterEach(() => {
  hits.length = 0;
  resolverCalls.length = 0;
  vi.restoreAllMocks();
});

describe("the real transport against the test's own loopback server", () => {
  it("reads a normal page and its second page", async () => {
    const connect = vi.spyOn(net, "connect");
    const r = await reader()(`${origin}/`);
    expect(r.ok && r.pages.map((p) => [p.kind, p.finalUrl])).toEqual([
      ["homepage", `${origin}/`],
      ["second_page", `${origin}/galerie`],
    ]);
    expect(hits.map((h) => h.path)).toEqual(["/robots.txt", "/", "/galerie"]);
    expect(resolverCalls).toEqual([]);
    expect(connect).toHaveBeenCalled();
  });

  it.each([
    ["http://127.0.0.1/"],
    ["http://[::1]/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://169.254.169.254/latest/meta-data"],
    ["http://100.64.0.1/"],
    ["http://192.168.1.10/"],
    ["http://0x7f.1/"],
  ])("a redirect to %s: private_address, no connection, no fallback, no retry", async (target) => {
    const connect = vi.spyOn(net, "connect");
    const r = await reader()(`${origin}/r?to=${encodeURIComponent(target)}`);
    expect(r).toMatchObject({ ok: false, skip: "private_address", requests: 2 });
    expect(hits.map((h) => h.path)).toEqual(["/robots.txt", `/r?to=${encodeURIComponent(target)}`]);
    expect(resolverCalls).toEqual([]);
    expect(connect.mock.calls.every(([opts]) => (opts as { port?: unknown }).port !== 80)).toBe(true);
  });

  it("a redirect to http://localhost/: blocked by the public-only lookup before any socket", async () => {
    const connect = vi.spyOn(net, "connect");
    const tlsConnect = vi.spyOn(tls, "connect");
    const r = await reader()(`${origin}/r?to=${encodeURIComponent("http://localhost/")}`);
    expect(r).toMatchObject({ ok: false, skip: "private_address", requests: 3 });
    expect(resolverCalls).toEqual(["localhost"]);
    expect(hits).toHaveLength(2);
    expect(connect.mock.calls.filter(([opts]) => (opts as { host?: string }).host === "localhost")).toEqual([]);
    expect(tlsConnect).not.toHaveBeenCalled();
  });

  it("a host the resolver maps to 10.0.0.1: private_address, asked once, never retried", async () => {
    const r = await reader()(`${origin}/r?to=${encodeURIComponent("https://internal.example/")}`);
    expect(r).toMatchObject({ ok: false, skip: "private_address" });
    expect(resolverCalls).toEqual(["internal.example"]);
  });

  it("a host the resolver maps to a public IP is refused by the test-run socket guard (no socket opened)", async () => {
    const connect = vi.spyOn(net, "connect");
    const tlsConnect = vi.spyOn(tls, "connect");
    const err = await transport
      .get(new URL("http://public.example/"), { signal: AbortSignal.timeout(5_000), headers: {} })
      .then(() => null, (e: unknown) => e);
    expect(errorCodes(err)).toContain(TEST_SOCKET_GUARD_CODE);
    const r = await reader()(`${origin}/r?to=${encodeURIComponent("https://public.example/")}`);
    expect(r).toMatchObject({ ok: false, skip: "unreachable" });
    expect(connect).not.toHaveBeenCalled();
    expect(tlsConnect).not.toHaveBeenCalled();
  });

  it("keeps the first 2 MB of a 3 MB streamed body and cancels the rest", async () => {
    const r = await reader()(`${origin}/big`);
    expect(r.ok).toBe(true);
    const page = r.ok ? r.pages[0]! : null;
    expect(page?.bytes).toBe(2 * 1024 * 1024);
    expect(page?.truncated).toBe(true);
    await vi.waitFor(() => expect(bigClosedEarly).toBe(true), { timeout: 5_000 });
  });

  it("counts a gzip body decoded", async () => {
    const small = await reader()(`${origin}/gzip-small`);
    expect(small.ok && small.pages[0]!.bytes).toBe(Buffer.byteLength(PAGE(TEXT)));
    const bomb = await reader()(`${origin}/gzip-bomb`);
    expect(bomb.ok && bomb.pages[0]!.bytes).toBe(2 * 1024 * 1024);
    expect(bomb.ok && bomb.pages[0]!.truncated).toBe(true);
  });

  it("gives up on a slow server after the page timeout (300 ms here, 15 s in the worker), without a retry", async () => {
    const t0 = Date.now();
    const r = await reader({ pageTimeoutMs: 300 })(`${origin}/slow`);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r).toMatchObject({ ok: false, skip: "unreachable", detail: "The website took too long to answer." });
    expect(hits.map((h) => h.path)).toEqual(["/robots.txt", "/slow"]);
  });

  it("stops after 8 requests for one company and keeps the homepage", async () => {
    const r = await reader()(`${origin}/a`);
    expect(r.ok && r.notes).toEqual(["second-page-failed"]);
    expect(r.ok && r.pages.map((p) => p.finalUrl)).toEqual([`${origin}/home`]);
    expect(r.requests).toBe(8);
    expect(hits).toHaveLength(8);
  });
});

describe("testAllowOrigin", () => {
  it.each([
    ["http://localhost:4000"],
    ["http://127.0.0.1"],
    ["http://127.0.0.1:1"],
    ["http://127.0.0.1:99999"],
    ["https://127.0.0.1:4000"],
    ["http://127.0.0.1:4000/"],
    ["http://127.0.0.2:4000"],
    ["http://[::1]:4000"],
  ])("refuses %s", (value) => {
    expect(() => createRealTransport({ testAllowOrigin: value })).toThrow("testAllowOrigin must be exactly http://127.0.0.1:<port>");
  });

  it("throws outside a test run", () => {
    const saved = { run: process.env.OUTREACH_TEST_RUN, vitest: process.env.VITEST, env: process.env.NODE_ENV };
    try {
      process.env.OUTREACH_TEST_RUN = "0";
      delete process.env.VITEST;
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(() => createRealTransport({ testAllowOrigin: origin })).toThrow("testAllowOrigin is only for tests");
      expect(() => createRealTransport({ resolve })).toThrow("A custom resolver is only for tests.");
    } finally {
      process.env.OUTREACH_TEST_RUN = saved.run;
      process.env.VITEST = saved.vitest;
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.env;
    }
  });
});
