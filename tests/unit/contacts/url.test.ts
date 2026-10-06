import { describe, expect, it } from "vitest";
import {
  clearFilterParams,
  clearFiltersHref,
  contactsHref,
  emptyKindFor,
  exportSelectionHref,
  exportViewHref,
  hasActiveFilters,
  missingEmailsExportHref,
  mutateParams,
  statusHref,
  toggleCsvValue,
  viewHref,
  withCompany,
} from "@/components/contacts/url";
import { parseCompanyFilters } from "@/server/services/companies/filters";

const f = (q: string) => parseCompanyFilters(new URLSearchParams(q));

describe("hasActiveFilters", () => {
  it("counts search, status and every popover filter, but not the list or view", () => {
    expect(hasActiveFilters(f(""))).toBe(false);
    expect(hasActiveFilters(f("list=3&view=missing-email&sort=country&size=100"))).toBe(false);
    for (const q of ["q=acme", "status=CLIENT", "tag=1", "country=DE", "niche=busts", "priority=HIGH", "emailed=no", "hasEmail=yes", "by=2"]) {
      expect(hasActiveFilters(f(q))).toBe(true);
    }
  });
});

describe("query string helpers", () => {
  it("toggles values in comma lists", () => {
    const p = new URLSearchParams("country=DE");
    toggleCsvValue(p, "country", "NO", true);
    expect(p.get("country")).toBe("DE,NO");
    toggleCsvValue(p, "country", "NO", true);
    expect(p.get("country")).toBe("DE,NO");
    toggleCsvValue(p, "country", "DE");
    expect(p.get("country")).toBe("NO");
    toggleCsvValue(p, "country", "NO", false);
    expect(p.has("country")).toBe(false);
  });

  it("clears filters but keeps the list, view and display settings", () => {
    const next = mutateParams("?q=a&status=CLIENT&tag=1&list=4&sort=country&page=3&size=100&company=9", clearFilterParams);
    expect(Object.fromEntries(new URLSearchParams(next))).toEqual({ list: "4", sort: "country", size: "100", company: "9" });
  });

  it("builds sidebar links that keep only sort, direction and size", () => {
    expect(viewHref("q=acme&status=CLIENT&sort=lastEmailed&dir=desc&page=4", { view: "all", listId: 7 })).toBe(
      "/contacts?sort=lastEmailed&dir=desc&list=7",
    );
    expect(viewHref("", { view: "missing-email" })).toBe("/contacts?view=missing-email");
    expect(viewHref("size=200", { view: "all" })).toBe("/contacts?size=200");
  });

  it("status tab links keep other filters and go back to page 1", () => {
    expect(statusHref(f("country=DE&page=5"), "CLIENT")).toBe("/contacts?status=CLIENT&country=DE");
    expect(statusHref(f("status=CLIENT&q=x"), undefined)).toBe("/contacts?q=x");
  });

  it("clear-filters link", () => {
    expect(clearFiltersHref(f("q=x&list=2&status=CLIENT&sort=priority&size=100"))).toBe("/contacts?list=2&sort=priority&size=100");
  });

  it("adds and removes the open company", () => {
    expect(withCompany("q=acme", 42)).toBe("q=acme&company=42");
    expect(withCompany("q=acme&company=42", null)).toBe("q=acme");
    expect(contactsHref("")).toBe("/contacts");
    expect(contactsHref("?a=1")).toBe("/contacts?a=1");
  });
});

describe("export links", () => {
  it("export the whole view without paging", () => {
    expect(exportViewHref(f("country=DE&page=3&size=200"), "xlsx")).toBe("/api/export/companies?country=DE&format=xlsx");
    expect(exportViewHref(f(""), "csv")).toBe("/api/export/companies?format=csv");
  });

  it("export a selection by ids", () => {
    expect(exportSelectionHref([1, 2, 3], "csv")).toBe("/api/export/companies?ids=1,2,3&format=csv");
  });

  it("export for Claude from the missing email view", () => {
    expect(missingEmailsExportHref(f("view=missing-email&country=NO"))).toBe("/api/export/missing-emails?country=NO");
    expect(missingEmailsExportHref(f("view=missing-email"))).toBe("/api/export/missing-emails");
  });
});

describe("emptyKindFor", () => {
  it("picks the PLAN.md A6 empty state", () => {
    expect(emptyKindFor(f(""), 5, 5)).toBe("none");
    expect(emptyKindFor(f(""), 0, 0)).toBe("no-companies");
    expect(emptyKindFor(f("list=3"), 0, 10)).toBe("empty-list");
    expect(emptyKindFor(f("view=missing-email"), 0, 10)).toBe("no-missing");
    expect(emptyKindFor(f("q=zzz"), 0, 10)).toBe("no-match");
    expect(emptyKindFor(f("list=3&status=CLIENT"), 0, 10)).toBe("no-match");
    expect(emptyKindFor(f("q=zzz"), 0, 0)).toBe("no-match");
  });

  it("says a list was deleted instead of calling it empty", () => {
    expect(emptyKindFor(f("list=3"), 0, 10, false)).toBe("deleted-list");
    // Even with filters on: clearing them wouldn't help.
    expect(emptyKindFor(f("list=3&status=CLIENT"), 0, 10, false)).toBe("deleted-list");
    expect(emptyKindFor(f("list=3"), 0, 10, true)).toBe("empty-list");
    // The flag only matters for list views.
    expect(emptyKindFor(f(""), 0, 10, false)).toBe("no-companies");
  });
});
