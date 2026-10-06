/**
 * The real transport of the website reader (docs/dev/M5-DESIGN.md §3.4.3): undici's own `fetch` with a dedicated agent
 * whose connector only reaches public addresses. Never the global fetch and never `setGlobalDispatcher` (that would
 * route Anthropic's and Mailgun's calls through this agent's short timeouts). Worker only.
 *
 * A test run never builds one, except with `testAllowOrigin` (exactly http://127.0.0.1:<port>, a server the test started
 * itself): then every rule still applies (URL rules, the public-only lookup with the injected resolver, the
 * remote-address check), only that origin gets through the port and IP rules, and no socket is ever opened to anything
 * else, so a bug that lets a public host through can never reach the internet from a test.
 */
import { Agent, fetch } from "undici";
import { isTestRun } from "@/server/mailgun/base-url";
import { createGuardedConnector, makePublicOnlyLookup, type ResolveHost } from "./ssrf";
import type { Transport } from "./types";

/** The only form `testAllowOrigin` may take. */
export const TEST_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;

export const CONNECT_TIMEOUT_MS = 5_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const BODY_TIMEOUT_MS = 10_000;

export type RealTransportOptions = {
  /** Tests only: the loopback origin of the test's own server ("http://127.0.0.1:<port>"). */
  testAllowOrigin?: string;
  /** Tests only: the resolver behind the public-only lookup (default: c-ares on the system's DNS servers). */
  resolve?: ResolveHost;
};

export type RealTransport = Transport & {
  readonly testAllowOrigin: string | null;
  /** Closes a test transport's own agent (the shared production agent stays open). */
  close(): Promise<void>;
};

function createWebAgent(opts: { allowOrigin: string | null; testRun: boolean; resolve?: ResolveHost }): Agent {
  return new Agent({
    connect: createGuardedConnector({
      lookup: makePublicOnlyLookup(opts.resolve),
      timeoutMs: CONNECT_TIMEOUT_MS,
      allowOrigin: opts.allowOrigin,
      testRun: opts.testRun,
    }),
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connections: 2,
    keepAliveTimeout: 4_000,
  });
}

let sharedAgent: Agent | null = null;
/** The worker's one website agent (connection reuse per origin across companies). */
function webAgent(): Agent {
  sharedAgent ??= createWebAgent({ allowOrigin: null, testRun: false });
  return sharedAgent;
}

function validTestOrigin(origin: string): boolean {
  const m = TEST_ORIGIN_PATTERN.exec(origin);
  if (!m) return false;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * The undici transport (manual redirects, no cookies). Throws in a test run unless `testAllowOrigin` is given, and
 * throws for `testAllowOrigin` outside a test run or in any form but http://127.0.0.1:<port>.
 */
export function createRealTransport(opts: RealTransportOptions = {}): RealTransport {
  const testRun = isTestRun();
  const allowOrigin = opts.testAllowOrigin ?? null;
  if (allowOrigin !== null) {
    if (!testRun) throw new Error("testAllowOrigin is only for tests; the real website reader never uses it.");
    if (!validTestOrigin(allowOrigin)) {
      throw new Error(`testAllowOrigin must be exactly http://127.0.0.1:<port>, not ${allowOrigin}.`);
    }
  } else if (testRun) {
    throw new Error("Test runs never read real websites (set OUTREACH_WEB_FIXTURES).");
  }
  if (opts.resolve && !testRun) throw new Error("A custom resolver is only for tests.");
  const own = testRun ? createWebAgent({ allowOrigin, testRun, resolve: opts.resolve }) : null;
  const agent = own ?? webAgent();
  return {
    testAllowOrigin: allowOrigin,
    async get(url, { signal, headers }) {
      const res = await fetch(url, { dispatcher: agent, redirect: "manual", headers, signal });
      return { status: res.status, headers: res.headers, body: res.body };
    },
    async close() {
      if (own) await own.close();
    },
  };
}
