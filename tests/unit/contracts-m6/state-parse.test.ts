import { describe, expect, it } from "vitest";
import {
  OLD_DOMAIN_PROBLEMS_MAX,
  OLD_DOMAIN_TEXT_MAX,
  parseCatchUpState,
  parseInstanceState,
  parseRestoreState,
} from "@/core/system-state-parse";

/**
 * M6 step C contract (M6-DESIGN §7.2, §7.8): the new optional SystemState fields. Each is kept when valid and left out
 * otherwise, so states written before M6 parse exactly as before (existing `toEqual`s hold).
 */

const at = (h: number) => new Date(Date.UTC(2026, 8, 27, h)).toISOString();

describe("parseInstanceState: host (L8)", () => {
  const base = { dbPath: "C:/Outreach/data/app.db", id: "abc123", firstSeenAt: at(1) };

  it("keeps a non-empty host", () => {
    expect(parseInstanceState({ ...base, host: "OFFICE-PC" })).toEqual({ ...base, host: "OFFICE-PC" });
  });

  it("leaves host out when it is missing, empty or not a string", () => {
    for (const host of [undefined, "", 42, null, ["OFFICE-PC"]]) {
      const parsed = parseInstanceState({ ...base, host });
      expect(parsed).toEqual(base);
      expect(parsed).not.toHaveProperty("host");
    }
  });

  it("still needs all three original fields", () => {
    expect(parseInstanceState({ dbPath: base.dbPath, id: base.id, host: "OFFICE-PC" })).toBeNull();
    expect(parseInstanceState(null)).toBeNull();
  });
});

describe("parseCatchUpState: oldDomains (L10)", () => {
  const problem = (over: Record<string, unknown> = {}) => ({
    domain: "mail.example.com",
    since: at(1),
    lastAt: at(5),
    text: "Mailgun answered 403 Forbidden.",
    ...over,
  });

  it("leaves the field out for states written before M6, and when there are none", () => {
    for (const v of [null, {}, { oldDomains: [] }, { oldDomains: "mail.example.com" }, { oldDomains: [null, 3] }]) {
      expect(parseCatchUpState(v)).not.toHaveProperty("oldDomains");
    }
    expect(parseCatchUpState({ lastError: "x" })).toEqual({
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastError: "x",
      lastErrorKind: null,
      lastReason: null,
      lastSummary: null,
    });
  });

  it("keeps the valid entries, in order", () => {
    const second = problem({ domain: "old.example.com", text: "" });
    expect(parseCatchUpState({ oldDomains: [problem(), second] }).oldDomains).toEqual([problem(), second]);
  });

  it("drops entries without a domain, with dates that aren't ISO, or without a text", () => {
    const parsed = parseCatchUpState({
      oldDomains: [
        problem({ domain: "" }),
        problem({ domain: 5 }),
        problem({ since: "yesterday" }),
        problem({ lastAt: null }),
        problem({ text: 12 }),
        problem({ text: undefined }),
        "mail.example.com",
        problem({ domain: "kept.example.com" }),
      ],
    });
    expect(parsed.oldDomains).toEqual([problem({ domain: "kept.example.com" })]);
  });

  it("cuts a long text to 300 characters", () => {
    const parsed = parseCatchUpState({ oldDomains: [problem({ text: "x".repeat(450) })] });
    expect(OLD_DOMAIN_TEXT_MAX).toBe(300);
    expect(parsed.oldDomains?.[0]?.text).toBe("x".repeat(300));
  });

  it("keeps at most 10 entries, the newest (last) ones", () => {
    const many = Array.from({ length: 13 }, (_, i) => problem({ domain: `d${i}.example.com` }));
    const parsed = parseCatchUpState({ oldDomains: many });
    expect(OLD_DOMAIN_PROBLEMS_MAX).toBe(10);
    expect(parsed.oldDomains?.map((p) => p.domain)).toEqual(many.slice(3).map((p) => p.domain));
  });

  it("returns new objects, so changing the result never changes the stored value", () => {
    const stored = { oldDomains: [problem()] };
    const parsed = parseCatchUpState(stored);
    parsed.oldDomains![0]!.domain = "changed.example.com";
    parsed.oldDomains!.push(problem());
    expect(stored.oldDomains).toEqual([problem()]);
  });
});

describe("parseRestoreState: resumedAt and resumedById (§3.7)", () => {
  it("keeps a valid resume time and a positive user id", () => {
    const parsed = parseRestoreState({ status: "done", resumedAt: at(9), resumedById: 3 });
    expect(parsed.resumedAt).toBe(at(9));
    expect(parsed.resumedById).toBe(3);
  });

  it("leaves both out for states written before M6", () => {
    const parsed = parseRestoreState({ status: "done", acknowledgedAt: at(8), acknowledgedById: 1 });
    expect(parsed).not.toHaveProperty("resumedAt");
    expect(parsed).not.toHaveProperty("resumedById");
    expect(parseRestoreState(null)).toEqual({
      status: "none",
      restoredFrom: null,
      scanFrom: null,
      markerAt: null,
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
  });

  it("leaves each out on its own when it isn't valid", () => {
    for (const resumedAt of [null, "", "soon", 17]) {
      const parsed = parseRestoreState({ resumedAt, resumedById: 2 });
      expect(parsed).not.toHaveProperty("resumedAt");
      expect(parsed.resumedById).toBe(2);
    }
    for (const resumedById of [null, 0, -4, 1.5, "3"]) {
      const parsed = parseRestoreState({ resumedAt: at(9), resumedById });
      expect(parsed).not.toHaveProperty("resumedById");
      expect(parsed.resumedAt).toBe(at(9));
    }
  });
});
