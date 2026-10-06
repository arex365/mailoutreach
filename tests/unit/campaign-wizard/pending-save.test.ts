import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingSave } from "@/components/campaign-wizard/pending-save";

describe("a change waiting for its save (Schedule step, SPEC-3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves the latest change once the typing pauses", () => {
    const p = new PendingSave<string>();
    const run = vi.fn();
    p.schedule("10:00", 600, run);
    p.schedule("10:30", 600, run);
    vi.advanceTimersByTime(599);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("10:30");
    expect(p.hasWaiting).toBe(false);
  });

  it("leaving the step saves the change still waiting at once, and only once", () => {
    const p = new PendingSave<string>();
    const timed = vi.fn();
    const onLeave = vi.fn();
    p.schedule("2026-09-24T10:00", 600, timed);
    expect(p.flush(onLeave)).toBe(true);
    expect(onLeave).toHaveBeenCalledWith("2026-09-24T10:00");
    vi.advanceTimersByTime(1000);
    expect(timed).not.toHaveBeenCalled();
    // Nothing waiting: leaving saves nothing.
    expect(p.flush(onLeave)).toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("drops the waiting change when the caller saves the latest value itself (Launch)", () => {
    const p = new PendingSave<string>();
    const run = vi.fn();
    p.schedule("x", 0, run);
    p.cancel();
    vi.advanceTimersByTime(10);
    expect(run).not.toHaveBeenCalled();
    expect(p.flush(run)).toBe(false);
  });
});
