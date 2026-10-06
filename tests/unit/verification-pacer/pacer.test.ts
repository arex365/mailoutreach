import { describe, expect, it } from "vitest";
import {
  CheckPacer,
  PACER_CLIMB_AFTER,
  PACER_MAX_WAIT_MS,
  sleepFor,
} from "@/server/services/verification/pacer";

/**
 * The check job's pacer (M5-DESIGN §2.5.1, research verification-reference §4) with an injected clock: how many
 * checks run at once, the 429 back-off and the climb back.
 */

/** A fake clock that the pacer's sleep advances (every wait is recorded). */
function fakeTime(start = 1_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    waits,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("aborted");
      waits.push(ms);
      t += ms;
    },
  };
}

const neverAborted = () => new AbortController().signal;

describe("the limit", () => {
  it("starts at 2 (or the setting when it is lower) and never above the setting or 4", () => {
    expect(new CheckPacer({ max: 2 }).limit).toBe(2);
    expect(new CheckPacer({ max: 1 }).limit).toBe(1);
    expect(new CheckPacer({ max: 4 }).limit).toBe(2);
    expect(new CheckPacer({ max: 9 }).limit).toBe(2);
    expect(new CheckPacer({ max: Number.NaN }).limit).toBe(2);
    expect(new CheckPacer({ max: 0 }).limit).toBe(1);
  });

  it("lets `limit` checks in flight and makes the next one wait for a release", async () => {
    const pacer = new CheckPacer({ max: 2 });
    await pacer.acquire(neverAborted());
    await pacer.acquire(neverAborted());
    expect(pacer.active).toBe(2);
    let third = false;
    const waiting = pacer.acquire(neverAborted()).then(() => {
      third = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
    pacer.release();
    await waiting;
    expect(third).toBe(true);
    expect(pacer.active).toBe(2);
  });

  it("climbs by one after 25 answers in a row, up to the setting", () => {
    const pacer = new CheckPacer({ max: 4 });
    for (let i = 0; i < PACER_CLIMB_AFTER - 1; i++) pacer.onSuccess();
    expect(pacer.limit).toBe(2);
    pacer.onSuccess();
    expect(pacer.limit).toBe(3);
    for (let i = 0; i < PACER_CLIMB_AFTER; i++) pacer.onSuccess();
    expect(pacer.limit).toBe(4);
    for (let i = 0; i < PACER_CLIMB_AFTER * 2; i++) pacer.onSuccess();
    expect(pacer.limit).toBe(4);
  });

  it("a waiting acquire goes as soon as the limit rises", async () => {
    const pacer = new CheckPacer({ max: 3 });
    await pacer.acquire(neverAborted());
    await pacer.acquire(neverAborted());
    const waiting = pacer.acquire(neverAborted());
    for (let i = 0; i < PACER_CLIMB_AFTER; i++) pacer.onSuccess();
    await waiting;
    expect(pacer.active).toBe(3);
  });
});

describe("429 back-off", () => {
  it("drops to one at a time and pauses new starts for 2 s × 2^n with ±20 % jitter, at most 60 s", async () => {
    const time = fakeTime();
    const pacer = new CheckPacer({ max: 4, now: time.now, sleep: time.sleep, random: () => 0.5 });
    pacer.on429(null);
    expect(pacer.limit).toBe(1);
    expect(pacer.resumeAt - time.now()).toBe(2_000);
    await pacer.acquire(neverAborted());
    expect(time.waits).toEqual([2_000]);
    pacer.release();
    pacer.on429(null);
    expect(pacer.resumeAt - time.now()).toBe(4_000);
    pacer.on429(null);
    expect(pacer.resumeAt - time.now()).toBe(8_000);
    for (let i = 0; i < 10; i++) pacer.on429(null);
    expect(pacer.resumeAt - time.now()).toBe(PACER_MAX_WAIT_MS);
  });

  it("jitters by ±20 %", () => {
    const low = fakeTime();
    const a = new CheckPacer({ max: 2, now: low.now, sleep: low.sleep, random: () => 0 });
    a.on429(null);
    expect(a.resumeAt - low.now()).toBe(1_600);
    const high = fakeTime();
    const b = new CheckPacer({ max: 2, now: high.now, sleep: high.sleep, random: () => 0.999999 });
    b.on429(null);
    expect(b.resumeAt - high.now()).toBe(2_400);
  });

  it("uses Mailgun's own wait when it gave one (capped at 60 s)", () => {
    const time = fakeTime();
    const pacer = new CheckPacer({ max: 2, now: time.now, sleep: time.sleep });
    pacer.on429(7_000);
    expect(pacer.resumeAt - time.now()).toBe(7_000);
    pacer.on429(600_000);
    expect(pacer.resumeAt - time.now()).toBe(PACER_MAX_WAIT_MS);
  });

  it("a later, shorter pause never shortens an earlier one", () => {
    const time = fakeTime();
    const pacer = new CheckPacer({ max: 2, now: time.now, sleep: time.sleep, random: () => 0.5 });
    pacer.on429(30_000);
    pacer.on429(null);
    expect(pacer.resumeAt - time.now()).toBe(30_000);
  });

  it("an answer resets the 429 streak, and climbing starts again from one", () => {
    const time = fakeTime();
    const pacer = new CheckPacer({ max: 2, now: time.now, sleep: time.sleep, random: () => 0.5 });
    pacer.on429(null);
    pacer.on429(null);
    time.advance(60_000);
    pacer.onSuccess();
    pacer.on429(null);
    expect(pacer.resumeAt - time.now()).toBe(2_000);
    for (let i = 0; i < PACER_CLIMB_AFTER; i++) pacer.onSuccess();
    expect(pacer.limit).toBe(2);
  });
});

describe("stopping", () => {
  it("an aborted signal ends a wait for a slot, and nothing is counted", async () => {
    const pacer = new CheckPacer({ max: 1 });
    await pacer.acquire(neverAborted());
    const stop = new AbortController();
    const waiting = pacer.acquire(stop.signal);
    stop.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(pacer.active).toBe(1);
    pacer.release();
    expect(pacer.active).toBe(0);
  });

  it("an aborted signal ends a 429 pause", async () => {
    const pacer = new CheckPacer({ max: 2 });
    pacer.on429(60_000);
    const stop = new AbortController();
    const waiting = pacer.acquire(stop.signal);
    stop.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(pacer.active).toBe(0);
  });

  it("sleepFor resolves after the time and rejects when aborted", async () => {
    await expect(sleepFor(1, neverAborted())).resolves.toBeUndefined();
    const stop = new AbortController();
    stop.abort(new Error("gone"));
    await expect(sleepFor(10_000, stop.signal)).rejects.toThrow("gone");
    const later = new AbortController();
    const p = sleepFor(10_000, later.signal);
    later.abort(new Error("later"));
    await expect(p).rejects.toThrow("later");
  });

  it("release never goes below zero", () => {
    const pacer = new CheckPacer({ max: 2 });
    pacer.release();
    expect(pacer.active).toBe(0);
  });
});
