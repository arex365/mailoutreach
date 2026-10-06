import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KIND_PREFIXES,
  activityFiltersToParams,
  hasActivityFilters,
  isIsoDate,
  parseActivityFilters,
} from "@/components/activity/activity-filters";

describe("activity filters", () => {
  it("parses a full query", () => {
    const f = parseActivityFilters(new URLSearchParams("person=3&kind=team&from=2026-09-01&to=2026-09-30&page=2"));
    expect(f).toEqual({ person: 3, kind: "team", from: "2026-09-01", to: "2026-09-30", page: 2 });
  });

  it("accepts Next.js searchParams objects, including repeated keys", () => {
    const f = parseActivityFilters({ person: ["system", "4"], kind: "emails", page: undefined });
    expect(f).toEqual({ person: "system", kind: "emails", from: null, to: null, page: 1 });
  });

  it("ignores junk instead of failing", () => {
    const f = parseActivityFilters(
      new URLSearchParams("person=abc&kind=secrets&from=2026-02-30&to=yesterday&page=-4"),
    );
    expect(f).toEqual({ person: null, kind: "all", from: null, to: null, page: 1 });
    expect(parseActivityFilters(new URLSearchParams("person=0")).person).toBeNull();
    expect(parseActivityFilters(new URLSearchParams("page=2.7")).page).toBe(2);
  });

  it("swaps a reversed date range", () => {
    const f = parseActivityFilters(new URLSearchParams("from=2026-09-30&to=2026-09-01"));
    expect([f.from, f.to]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("round-trips through the URL and leaves defaults out", () => {
    const f = parseActivityFilters(new URLSearchParams("person=system&kind=companies&from=2026-01-05"));
    expect(activityFiltersToParams(f).toString()).toBe("person=system&kind=companies&from=2026-01-05");
    expect(activityFiltersToParams({ person: null, kind: "all", from: null, to: null, page: 1 }).toString()).toBe("");
    expect(activityFiltersToParams({ ...f, page: 3 }).get("page")).toBe("3");
  });

  it("knows when any filter is set", () => {
    expect(hasActivityFilters(parseActivityFilters(new URLSearchParams("page=3")))).toBe(false);
    expect(hasActivityFilters(parseActivityFilters(new URLSearchParams("kind=imports")))).toBe(true);
  });

  it("checks calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("2025-13-01")).toBe(false);
    expect(isIsoDate("2025-1-01")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });

  it("has a sentence-case label and prefixes for every kind", () => {
    for (const k of ACTIVITY_KINDS) {
      expect(ACTIVITY_KIND_LABELS[k]).toMatch(/^[A-Z][a-z]/);
      expect(Array.isArray(ACTIVITY_KIND_PREFIXES[k])).toBe(true);
    }
    expect(ACTIVITY_KIND_PREFIXES.all).toEqual([]);
    expect(ACTIVITY_KIND_PREFIXES.team).toContain("user.");
    // Milestone 2: campaign entries sit with emails, template changes have their own kind.
    expect(ACTIVITY_KIND_PREFIXES.emails).toContain("campaign.");
    expect(ACTIVITY_KIND_PREFIXES.templates).toEqual(["template."]);
    expect(parseActivityFilters(new URLSearchParams("kind=templates")).kind).toBe("templates");
  });

  it("files address checks and AI lines under Companies & people (Milestone 5)", () => {
    // verify.run, ai.run and ai.rejected would otherwise show only under Everything; person.checked and
    // company.personalLine already fit through their own prefixes.
    expect(ACTIVITY_KIND_PREFIXES.companies).toEqual(["company.", "person.", "list.", "verify.", "ai."]);
    for (const type of ["verify.run", "ai.run", "ai.rejected", "person.checked", "company.personalLine"]) {
      expect(ACTIVITY_KIND_PREFIXES.companies.some((p) => type.startsWith(p))).toBe(true);
      expect(ACTIVITY_KIND_PREFIXES.emails.some((p) => type.startsWith(p))).toBe(false);
    }
  });
});
