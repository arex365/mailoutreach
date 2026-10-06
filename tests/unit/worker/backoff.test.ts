import { describe, expect, it } from "vitest";
import { RETRY_DELAYS_MS, canRetry, nextRetryAt, retryDelayMs } from "../../../worker/backoff";

describe("retry schedule", () => {
  it("waits 1 minute, then 5 minutes, then 15 minutes", () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(3)).toBe(900_000);
  });

  it("keeps 15 minutes for later tries and treats nonsense as the first try", () => {
    expect(retryDelayMs(4)).toBe(900_000);
    expect(retryDelayMs(50)).toBe(900_000);
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(-3)).toBe(60_000);
  });

  it("computes the next run time from now", () => {
    const now = new Date("2026-09-23T10:00:00Z");
    expect(nextRetryAt(now, 1).toISOString()).toBe("2026-09-23T10:01:00.000Z");
    expect(nextRetryAt(now, 2).toISOString()).toBe("2026-09-23T10:05:00.000Z");
    expect(nextRetryAt(now, 3).toISOString()).toBe("2026-09-23T10:15:00.000Z");
  });

  it("retries only while attempts are below the maximum", () => {
    expect(canRetry(1, 3)).toBe(true);
    expect(canRetry(2, 3)).toBe(true);
    expect(canRetry(3, 3)).toBe(false);
    expect(canRetry(1, 1)).toBe(false);
  });
});
