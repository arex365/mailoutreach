import { describe, expect, it } from "vitest";
import {
  LOGIN_MISMATCH_MESSAGE,
  SOURCE_EXTRA_WAIT_MS,
  loginDelayMs,
  loginEmailKey,
  nextLoginAllowedAt,
  secondsUntil,
  tooManyTriesMessage,
  type RecentFailure,
} from "@/lib/auth/throttle-rules";

const T = Date.UTC(2026, 8, 23, 12, 0, 0);
const fail = (secondsAgo: number, sourceKey = "lan:10.0.0.5"): RecentFailure => ({ at: new Date(T - secondsAgo * 1000), sourceKey });

describe("per-account delay", () => {
  it("grows 1 s, 2 s, 4 s … and stops at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map(loginDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("counts from the last failure, whatever source it came from", () => {
    expect(nextLoginAllowedAt([], "lan:1")).toBe(0);
    const failures = [fail(20, "lan:a"), fail(3, "lan:b"), fail(10, "lan:c")];
    // 3 failures → 4 s after the newest one (3 s ago).
    expect(nextLoginAllowedAt(failures, "lan:new")).toBe(T - 3000 + 4000);
    expect(nextLoginAllowedAt(failures, "lan:a")).toBe(T - 3000 + 4000);
  });
});

describe("per-source extra wait (SECURITY-5: soft, never a lock)", () => {
  it("adds a one-minute wait after 5 failures from the same source only", () => {
    const five = [40, 39, 38, 37, 36].map((s) => fail(s, "lan:victim"));
    // Account-wide: 5 failures → 16 s after 36 s ago → already allowed.
    expect(nextLoginAllowedAt(five, "lan:other")).toBeLessThan(T);
    // That source: one minute after its last failure.
    expect(nextLoginAllowedAt(five, "lan:victim")).toBe(T - 36_000 + SOURCE_EXTRA_WAIT_MS);
    expect(nextLoginAllowedAt(five.slice(1), "lan:victim")).toBeLessThan(T);
  });

  it("is only ever a wait: however many failures, a source can try again after at most a minute", () => {
    const many = Array.from({ length: 40 }, (_, i) => fail(61 + i, "lan:victim"));
    expect(nextLoginAllowedAt(many, "lan:victim")).toBeLessThanOrEqual(T);
  });
});

describe("messages and input", () => {
  it("says how many seconds to wait", () => {
    expect(secondsUntil(T + 1, T)).toBe(1);
    expect(secondsUntil(T + 4001, T)).toBe(5);
    expect(secondsUntil(T - 5000, T)).toBe(1);
    expect(tooManyTriesMessage(1)).toBe("Too many tries. Wait 1 second and try again.");
    expect(tooManyTriesMessage(24)).toBe("Too many tries. Wait 24 seconds and try again.");
    expect(LOGIN_MISMATCH_MESSAGE).toBe("That email and password don't match. Check them and try again.");
  });

  it("normalises sign-in emails and refuses text that can't be an address (SECURITY-4)", () => {
    expect(loginEmailKey("  Ali.Khan@Example.COM ")).toBe("ali.khan@example.com");
    expect(loginEmailKey("owner@example.com")).toBe("owner@example.com");
    expect(loginEmailKey("")).toBeNull();
    expect(loginEmailKey("not an email")).toBeNull();
    expect(loginEmailKey("a".repeat(250) + "@example.com")).toBeNull();
    expect(loginEmailKey("x".repeat(2_000_000))).toBeNull();
  });
});
