import { describe, expect, it } from "vitest";
import { RestartPolicy } from "../../../scripts/lib/restart-policy.mjs";

const MIN = 60_000;

describe("RestartPolicy", () => {
  it("waits longer after each quick crash, up to the maximum", () => {
    const p = new RestartPolicy({ baseDelayMs: 1000, maxDelayMs: 8000 });
    const delays = [0, 1, 2, 3, 4, 5].map((i) => p.crashed(i * 1000, 500).delayMs);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("starts over after a run that lasted long enough", () => {
    const p = new RestartPolicy({ baseDelayMs: 1000, stableAfterMs: 5 * MIN });
    p.crashed(0, 100);
    p.crashed(1000, 100);
    expect(p.crashed(2000, 100).delayMs).toBe(4000);
    expect(p.crashed(10 * MIN, 6 * MIN).delayMs).toBe(1000);
  });

  it("gives up on the 6th crash within 10 minutes when limited to 5 restarts", () => {
    const p = new RestartPolicy({ maxRestarts: 5, windowMs: 10 * MIN });
    const results = [0, 1, 2, 3, 4].map((i) => p.crashed(i * MIN, 1000));
    expect(results.every((r) => r.restart)).toBe(true);
    const sixth = p.crashed(5 * MIN, 1000);
    expect(sixth).toMatchObject({ restart: false, recentCrashes: 6 });
  });

  it("forgets crashes older than the window", () => {
    const p = new RestartPolicy({ maxRestarts: 5, windowMs: 10 * MIN });
    for (let i = 0; i < 5; i++) p.crashed(i * MIN, 1000);
    // At minute 11 only the crashes at minutes 2, 3 and 4 are less than 10 minutes old; with this one that's 4.
    expect(p.crashed(11 * MIN, 1000)).toMatchObject({ restart: true, recentCrashes: 4 });
  });

  it("never gives up without a limit (the background sender)", () => {
    const p = new RestartPolicy({ baseDelayMs: 2000, maxDelayMs: 60_000 });
    let last = { restart: true, delayMs: 0 };
    for (let i = 0; i < 50; i++) last = p.crashed(i * 1000, 100);
    expect(last).toMatchObject({ restart: true, delayMs: 60_000 });
  });
});
