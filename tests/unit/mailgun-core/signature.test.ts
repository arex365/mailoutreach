import { describe, expect, it } from "vitest";
import {
  EVENT_MAX_AGE_MS,
  INBOUND_MAX_AGE_MS,
  MAX_FUTURE_MS,
  checkTimestamp,
  signMailgun,
  verifyMailgunSignature,
} from "@/core/mailgun/signature";

// The research test vector (mailgun-api-reference §13.3, computed with Node 24.18).
const KEY = "key-0123456789abcdef0123456789abcdef";
const TS = "1770920772";
const TOKEN = "e0b5477167110d68991efc6b9f89f0a11066af27834600e123";
const SIG = "6ae8ba140d2536fd21c45a0db161e962a424ed6ca953c96a63182621e118ee13";

describe("verifyMailgunSignature", () => {
  it("accepts the research test vector", () => {
    expect(TOKEN).toHaveLength(50);
    expect(signMailgun(KEY, TS, TOKEN)).toBe(SIG);
    expect(verifyMailgunSignature(KEY, TS, TOKEN, SIG)).toBe(true);
    expect(verifyMailgunSignature(KEY, TS, TOKEN, SIG.toUpperCase())).toBe(true);
  });

  it("refuses a tampered signature, timestamp, token or key", () => {
    const flipped = SIG.slice(0, -1) + (SIG.endsWith("3") ? "4" : "3");
    expect(verifyMailgunSignature(KEY, TS, TOKEN, flipped)).toBe(false);
    expect(verifyMailgunSignature(KEY, "1770920773", TOKEN, SIG)).toBe(false);
    expect(verifyMailgunSignature(KEY, TS, `${TOKEN.slice(0, -1)}4`, SIG)).toBe(false);
    expect(verifyMailgunSignature("key-other", TS, TOKEN, SIG)).toBe(false);
  });

  it("refuses malformed input before computing anything", () => {
    expect(verifyMailgunSignature(KEY, TS, TOKEN, "z".repeat(64))).toBe(false); // not hex
    expect(verifyMailgunSignature(KEY, TS, TOKEN, SIG.slice(0, 63))).toBe(false); // too short
    expect(verifyMailgunSignature(KEY, TS, TOKEN, `${SIG}00`)).toBe(false); // too long
    expect(verifyMailgunSignature(KEY, TS, TOKEN, "")).toBe(false);
    expect(verifyMailgunSignature("", TS, TOKEN, SIG)).toBe(false);
    expect(verifyMailgunSignature(KEY, TS, "short", signMailgun(KEY, TS, "short"))).toBe(false);
    expect(verifyMailgunSignature(KEY, "17709207.72", TOKEN, SIG)).toBe(false);
    expect(verifyMailgunSignature(KEY, "abc", TOKEN, SIG)).toBe(false);
    expect(verifyMailgunSignature(KEY, 1770920772 as unknown as string, TOKEN, SIG)).toBe(false); // callers pass String(ts)
  });
});

describe("checkTimestamp", () => {
  const now = new Date(Number(TS) * 1000);
  const shifted = (seconds: number) => String(Number(TS) + seconds);

  it("has the design's limits", () => {
    expect(EVENT_MAX_AGE_MS).toBe(12 * 3_600_000);
    expect(INBOUND_MAX_AGE_MS).toBe(24 * 3_600_000);
    expect(MAX_FUTURE_MS).toBe(3_600_000);
  });

  it("accepts events up to 12 hours old", () => {
    expect(checkTimestamp(TS, now, EVENT_MAX_AGE_MS)).toBe("fresh");
    expect(checkTimestamp(shifted(-12 * 3600), now, EVENT_MAX_AGE_MS)).toBe("fresh");
    expect(checkTimestamp(shifted(-12 * 3600 - 1), now, EVENT_MAX_AGE_MS)).toBe("stale");
  });

  it("accepts inbound notifications up to 24 hours old", () => {
    expect(checkTimestamp(shifted(-24 * 3600), now, INBOUND_MAX_AGE_MS)).toBe("fresh");
    expect(checkTimestamp(shifted(-24 * 3600 - 1), now, INBOUND_MAX_AGE_MS)).toBe("stale");
  });

  it("allows a PC clock up to 1 hour slow", () => {
    expect(checkTimestamp(shifted(3600), now, EVENT_MAX_AGE_MS)).toBe("fresh");
    expect(checkTimestamp(shifted(3601), now, EVENT_MAX_AGE_MS)).toBe("future");
    expect(checkTimestamp(shifted(60), now, EVENT_MAX_AGE_MS, 30_000)).toBe("future");
  });

  it("reads decimal seconds and refuses anything else", () => {
    expect(checkTimestamp("1770920771.5", now, EVENT_MAX_AGE_MS)).toBe("fresh");
    expect(checkTimestamp("", now, EVENT_MAX_AGE_MS)).toBe("invalid");
    expect(checkTimestamp("yesterday", now, EVENT_MAX_AGE_MS)).toBe("invalid");
    expect(checkTimestamp("-1770920772", now, EVENT_MAX_AGE_MS)).toBe("invalid");
  });
});
