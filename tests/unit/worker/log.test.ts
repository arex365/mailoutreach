import { describe, expect, it, vi } from "vitest";
import { createThrottledLogger, type Logger } from "../../../worker/log";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

describe("throttled error log", () => {
  it("logs a repeating problem once a minute with a count", () => {
    const logger = fakeLogger();
    const t = createThrottledLogger(logger, 60_000);
    t.error("db", "Database busy", undefined, 0);
    t.error("db", "Database busy", undefined, 2_000);
    t.error("db", "Database busy", undefined, 4_000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    t.error("db", "Database busy", undefined, 61_000);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[1]![0]).toBe("Database busy (happened 2 more times)");
  });

  it("keeps separate keys apart and logs again straight away after clear()", () => {
    const logger = fakeLogger();
    const t = createThrottledLogger(logger, 60_000);
    t.error("a", "A", undefined, 0);
    t.error("b", "B", undefined, 1);
    expect(logger.error).toHaveBeenCalledTimes(2);
    t.clear("a");
    t.error("a", "A", undefined, 2);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});
