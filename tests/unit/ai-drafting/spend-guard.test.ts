import { describe, expect, it } from "vitest";
import { SpendGuard } from "@/server/ai/spend-guard";

/**
 * The drafting run's spend guard (M5-DESIGN §3.3, D30): before every Claude call the call's ceiling is reserved; the
 * office month (spent + reserved + ceiling ≤ limit) and the run (≤ its cap) are both checked, counting calls in flight.
 */

describe("SpendGuard", () => {
  const base = { monthSpentUsd: 0, monthLimitUsd: 20, runSpentUsd: 0, runCapUsd: 1 };

  it("reserves a call that fits and refuses one that would pass the run's cap", () => {
    const g = new SpendGuard({ ...base, runCapUsd: 0.02 });
    const a = g.reserve(0.0085);
    expect(a).toMatchObject({ ok: true });
    const b = g.reserve(0.0085);
    expect(b).toMatchObject({ ok: true });
    // 0.017 reserved: another 0.0085 would pass 0.02.
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "run_cap" });
    expect(g.state).toMatchObject({ reservedUsd: 0.017, inFlight: 2 });
  });

  it("counts the calls in flight: the second company's reserved call makes the third one pass the cap", () => {
    const g = new SpendGuard({ ...base, runSpentUsd: 0.023, runCapUsd: 0.035 });
    const inFlight = g.reserve(0.0085);
    expect(inFlight.ok).toBe(true);
    // Alone, 0.023 + 0.0085 = 0.0315 would fit; with the other call in flight it is 0.04, past 0.035.
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "run_cap" });
    // Settled at its real cost: 0.0266 + 0.0085 = 0.0351 is still just past 0.035; a call with a smaller ceiling fits.
    if (inFlight.ok) g.settle(inFlight.token, 0.0036);
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "run_cap" });
    expect(g.reserve(0.0084).ok).toBe(true);
  });

  it("settle turns the reservation into the recorded cost (month and run), once", () => {
    const g = new SpendGuard({ ...base, monthSpentUsd: 1, runSpentUsd: 0.5 });
    const r = g.reserve(0.0085);
    if (!r.ok) throw new Error("refused");
    g.settle(r.token, 0.0036);
    expect(g.state).toMatchObject({ monthSpentUsd: 1.0036, runSpentUsd: 0.5036, reservedUsd: 0, inFlight: 0 });
    // A second settle of the same token changes nothing.
    g.settle(r.token, 0.0036);
    expect(g.state).toMatchObject({ monthSpentUsd: 1.0036, runSpentUsd: 0.5036 });
    // An unknown token too.
    g.settle(999, 5);
    expect(g.state.monthSpentUsd).toBe(1.0036);
  });

  it("a call that cost nothing (an error answer) releases its reservation", () => {
    const g = new SpendGuard({ ...base, runCapUsd: 0.01 });
    const r = g.reserve(0.0085);
    if (!r.ok) throw new Error("refused");
    expect(g.reserve(0.0085).ok).toBe(false);
    g.settle(r.token, 0);
    expect(g.reserve(0.0085).ok).toBe(true);
  });

  it("refuses a call that would pass the monthly limit, looked at before the run's cap", () => {
    const g = new SpendGuard({ monthSpentUsd: 19.995, monthLimitUsd: 20, runSpentUsd: 0, runCapUsd: 0.001 });
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "monthly_limit" });
    const h = new SpendGuard({ monthSpentUsd: 0.0036, monthLimitUsd: 0.01, runSpentUsd: 0, runCapUsd: 5 });
    expect(h.reserve(0.0085)).toEqual({ ok: false, why: "monthly_limit" });
    expect(h.reserve(0.0064).ok).toBe(true);
  });

  it("a call that fits exactly is allowed (float noise ignored)", () => {
    const g = new SpendGuard({ monthSpentUsd: 0.1 + 0.2, monthLimitUsd: 0.4, runSpentUsd: 0, runCapUsd: 1 });
    expect(g.reserve(0.1).ok).toBe(true);
  });

  it("the cap and the limit can change during a run (model change, a raised limit)", () => {
    const g = new SpendGuard({ ...base, monthLimitUsd: 0.005, runCapUsd: 0.005 });
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "monthly_limit" });
    g.setMonthLimit(20);
    expect(g.reserve(0.0085)).toEqual({ ok: false, why: "run_cap" });
    g.setRunCap(0.05);
    expect(g.reserve(0.0085).ok).toBe(true);
    expect(g.state).toMatchObject({ monthLimitUsd: 20, runCapUsd: 0.05 });
  });

  it("broken numbers count as zero (a zero limit refuses everything)", () => {
    const g = new SpendGuard({ monthSpentUsd: Number.NaN, monthLimitUsd: -1, runSpentUsd: Infinity, runCapUsd: 1 });
    expect(g.state).toMatchObject({ monthSpentUsd: 0, monthLimitUsd: 0, runSpentUsd: 0 });
    expect(g.reserve(0.001)).toEqual({ ok: false, why: "monthly_limit" });
    const h = new SpendGuard(base);
    const r = h.reserve(Number.NaN);
    expect(r.ok).toBe(true);
    if (r.ok) h.settle(r.token, Number.NaN);
    expect(h.state.runSpentUsd).toBe(0);
  });
});
