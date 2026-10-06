import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompaniesTable } from "@/components/contacts/companies-table";
import type { ContactRow } from "@/components/contacts/types";

function row(id: number, over: Partial<ContactRow> = {}): ContactRow {
  return {
    id,
    code: `C-${id}`,
    name: `Company ${id}`,
    subline: `company${id}.de`,
    status: "NOT_CONTACTED",
    priority: "NORMAL",
    countryCode: "DE",
    countryName: "Germany",
    niche: "miniatures",
    peopleCount: 2,
    emailCount: 1,
    lastEmailedLabel: "Ali · 12 days ago",
    lastEmailedTitle: "Emailed by Ali on 12 Oct 2026, 14:30",
    addedLabel: "5 Jan 2026",
    tags: [{ id: 1, name: "resin" }],
    custom: { members: "1200" },
    ...over,
  };
}

const noop = () => undefined;

function render(overrides: Partial<Parameters<typeof CompaniesTable>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CompaniesTable, {
      rows: [row(1), row(2, { emailCount: 0, lastEmailedLabel: "Never", lastEmailedTitle: null, status: "DO_NOT_CONTACT" })],
      total: 120,
      page: 2,
      pageCount: 3,
      pageSize: 50,
      sort: "lastEmailed",
      dir: "desc",
      customColumns: [{ key: "members", label: "Members" }],
      columnVisibility: { country: false, created: false, "cf:members": true },
      onColumnVisibilityChange: noop,
      onSortChange: noop,
      onPageChange: noop,
      selected: new Set([1]),
      onToggleRow: noop,
      onTogglePage: noop,
      onOpen: noop,
      companyHref: (id: number) => `/contacts?company=${id}`,
      loading: false,
      ...overrides,
    }),
  );
}

function headers(html: string): string[] {
  const thead = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  return [...thead.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
}

describe("CompaniesTable", () => {
  it("renders the always-on columns plus the visible optional ones", () => {
    const html = render();
    expect(headers(html)).toEqual(["", "Company", "Status", "People", "Last emailed", "Sequence", "Niche", "Priority", "Tags", "Members"]);
  });

  it("marks the server's sort column", () => {
    const html = render();
    expect(html).toMatch(/aria-sort="descending"[^>]*>.*?Last emailed/);
    expect((html.match(/aria-sort="none"/g) ?? []).length).toBe(4); // Company, People, Niche, Priority
  });

  it("doesn't offer a Status sort (the status tabs do that), but sorts Niche and People", () => {
    const html = render();
    const thead = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    const statusTh = thead.match(/<th[^>]*>(?:(?!<\/th>).)*?Status(?:(?!<\/th>).)*?<\/th>/)?.[0] ?? "";
    expect(statusTh).not.toContain("aria-sort");
    expect(statusTh).not.toContain("<button");
    for (const label of ["Niche", "People"]) {
      expect(thead).toMatch(new RegExp(`aria-sort="none"[^>]*><button[^>]*>${label}`));
    }
    const sorted = render({ sort: "people", dir: "asc" });
    expect(sorted).toMatch(/aria-sort="ascending"[^>]*><button[^>]*>People/);
  });

  it("shows each row with its cells, ticks and links", () => {
    const html = render();
    expect((html.match(/data-row-index=/g) ?? []).length).toBe(4); // table rows + phone cards
    expect(html).toContain('href="/contacts?company=1"');
    expect(html).toMatch(/data-company-id="1" data-state="selected"/);
    expect(html).toContain("2 people · 1 email");
    expect(html).toContain("No email");
    expect(html).toContain("Do not contact");
    expect(html).toContain("1200");
    expect(html).toContain("C-2");
  });

  it("shows the paging summary and enables both directions in the middle", () => {
    const html = render();
    expect(html).toContain("Page 2 of 3 · 120 companies");
    const buttons = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*?(Previous|Next)(?:(?!<\/button>).)*?<\/button>/g)];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => !/disabled=""/.test(b[0]))).toBe(true);
  });

  it("explains a test mailbox's Never in the Last emailed cell's tooltip (M6-DESIGN §2.2, L18)", () => {
    const html = render({
      rows: [row(3, { lastEmailedLabel: "Never", lastEmailedTitle: "Test emails before going live don't count as emailed." })],
    });
    expect(html).toMatch(/title="Test emails before going live don(?:'|&#x27;|&#39;)t count as emailed\."[^>]*>Never</);
  });

  it("disables Next on the last page", () => {
    const html = render({ page: 3 });
    const next = html.match(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*?Next/);
    expect(next).not.toBeNull();
  });
});
