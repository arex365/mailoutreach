import { describe, expect, it } from "vitest";
import { MAX_HOST_GAP_MS, MIN_HOST_GAP_MS, createPoliteness, hostGapMs, immediatePoliteness } from "@/server/web/politeness";

/** M5-DESIGN §3.4.5: one request at a time per host, at least max(2 s, crawl-delay) apart; an injected clock in tests. */

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
      sleeps.push(ms);
      t += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe("hostGapMs", () => {
  it("is max(2 s, crawl-delay), at most 60 s", () => {
    expect(hostGapMs(null)).toBe(MIN_HOST_GAP_MS);
    expect(hostGapMs(1)).toBe(2_000);
    expect(hostGapMs(5)).toBe(5_000);
    expect(hostGapMs(20)).toBe(20_000);
    expect(hostGapMs(86_400)).toBe(MAX_HOST_GAP_MS);
    expect(hostGapMs(Number.NaN)).toBe(2_000);
  });
});

describe("createPoliteness", () => {
  it("lets the first request go at once and spaces the next ones by the gap", async () => {
    const clock = fakeClock();
    const p = createPoliteness(clock);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const release = await p.acquire("studio.example", { signal: signal(), minGapMs: 2_000 });
      starts.push(clock.now());
      clock.advance(300); // the request takes 300 ms
      release();
    }
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2_000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(2_000);
    expect(clock.sleeps).toEqual([2_000, 2_000]);
  });

  it("keeps one request at a time per host, while other hosts run freely", async () => {
    const clock = fakeClock();
    const p = createPoliteness(clock);
    const first = await p.acquire("a.example", { signal: signal(), minGapMs: 2_000 });
    let secondStarted = false;
    const second = p.acquire("A.EXAMPLE", { signal: signal(), minGapMs: 2_000 }).then((release) => {
      secondStarted = true;
      return release;
    });
    const other = await p.acquire("b.example", { signal: signal(), minGapMs: 2_000 });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    other();
    first();
    const releaseSecond = await second;
    expect(secondStarted).toBe(true);
    releaseSecond();
  });

  it("stops waiting when the signal aborts, and the host stays usable", async () => {
    const clock = fakeClock();
    const p = createPoliteness(clock);
    const first = await p.acquire("a.example", { signal: signal(), minGapMs: 2_000 });
    const ctrl = new AbortController();
    const waiting = p.acquire("a.example", { signal: ctrl.signal, minGapMs: 2_000 });
    ctrl.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    first();
    const next = await p.acquire("a.example", { signal: signal(), minGapMs: 2_000 });
    next();
    await expect(p.acquire("a.example", { signal: AbortSignal.abort(new Error("gone")), minGapMs: 0 })).rejects.toThrow("gone");
  });

  it("uses the longer crawl-delay gap when asked", async () => {
    const clock = fakeClock();
    const p = createPoliteness(clock);
    (await p.acquire("slow.example", { signal: signal(), minGapMs: hostGapMs(8) }))();
    (await p.acquire("slow.example", { signal: signal(), minGapMs: hostGapMs(8) }))();
    expect(clock.sleeps).toEqual([8_000]);
  });

  it("releasing twice is harmless", async () => {
    const p = createPoliteness(fakeClock());
    const release = await p.acquire("a.example", { signal: signal(), minGapMs: 0 });
    release();
    release();
    (await p.acquire("a.example", { signal: signal(), minGapMs: 0 }))();
  });
});

describe("immediatePoliteness", () => {
  it("never waits", async () => {
    const release = await immediatePoliteness.acquire("a.example", { signal: signal(), minGapMs: 60_000 });
    release();
    const again = await immediatePoliteness.acquire("a.example", { signal: signal(), minGapMs: 60_000 });
    again();
  });
});
