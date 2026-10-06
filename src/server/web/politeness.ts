/**
 * Politeness towards websites (docs/dev/M5-DESIGN.md §3.4.5): in memory, per worker process, one request at a time per
 * host and at least max(2 s, crawl-delay) between requests to the same host. The drafting job's pool keeps at most 4
 * hosts in parallel; the reader waits here before every request (robots.txt, pages, redirect hops, retries).
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Politeness } from "./types";

/** The shortest gap between two requests to one host. */
export const MIN_HOST_GAP_MS = 2_000;
/** The longest gap the reader waits for (a huge crawl-delay would hold a pool slot for hours). */
export const MAX_HOST_GAP_MS = 60_000;

/** The gap for a host: max(2 s, crawl-delay), at most 60 s. */
export function hostGapMs(crawlDelaySec: number | null | undefined): number {
  const delayMs = crawlDelaySec && Number.isFinite(crawlDelaySec) && crawlDelaySec > 0 ? crawlDelaySec * 1000 : 0;
  return Math.min(MAX_HOST_GAP_MS, Math.max(MIN_HOST_GAP_MS, delayMs));
}

type HostState = { busy: boolean; lastEnd: number; waiters: Array<() => void> };

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

async function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/**
 * A per-host queue. `now` and `sleep` are injectable so tests can use a fake clock (the fake sleep advances it); the
 * defaults are the real clock and timers.
 */
export function createPoliteness(
  opts: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Politeness {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const hosts = new Map<string, HostState>();

  const stateOf = (host: string): HostState => {
    let s = hosts.get(host);
    if (!s) {
      s = { busy: false, lastEnd: Number.NEGATIVE_INFINITY, waiters: [] };
      hosts.set(host, s);
    }
    return s;
  };

  /** Hands the host to the next waiter, or frees it; forgets idle hosts now and then so the map stays small. */
  const handOver = (s: HostState) => {
    const next = s.waiters.shift();
    if (next) {
      next();
      return;
    }
    s.busy = false;
    if (hosts.size > 500) {
      const cutoff = now() - MAX_HOST_GAP_MS;
      for (const [h, st] of hosts) if (!st.busy && st.waiters.length === 0 && st.lastEnd < cutoff) hosts.delete(h);
    }
  };

  return {
    async acquire(rawHost, { signal, minGapMs }) {
      const host = rawHost.toLowerCase();
      if (signal.aborted) throw abortError(signal);
      const s = stateOf(host);
      if (s.busy) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            const i = s.waiters.indexOf(wake);
            if (i >= 0) s.waiters.splice(i, 1);
            reject(abortError(signal));
          };
          const wake = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          s.waiters.push(wake);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      s.busy = true;
      try {
        const wait = s.lastEnd + minGapMs - now();
        if (wait > 0) await sleep(wait, signal);
      } catch (err) {
        handOver(s);
        throw err;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        s.lastEnd = now();
        handOver(s);
      };
    },
  };
}

/** For tests with a fixed clock: no waiting between requests to one host. */
export const immediatePoliteness: Politeness = {
  async acquire() {
    return () => {};
  },
};
