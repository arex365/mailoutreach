import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CheckView, ImportResultSummary } from "@/core/import/types";

/** The import screens for the missing-emails round trip (M5-DESIGN §6.10). */

// The Server Actions module can't load outside Next (server-only); nothing here calls it.
vi.mock("@/app/(app)/import/actions", () => ({
  checkImportAction: vi.fn(),
  discardImportAction: vi.fn(),
  importJobAction: vi.fn(),
  saveImportMappingAction: vi.fn(),
  saveImportOptionsAction: vi.fn(),
  setImportChoiceAction: vi.fn(),
  setImportDefaultsAction: vi.fn(),
  startImportAction: vi.fn(),
  workerRunningAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const { MappingStep, nextMapping, RoundTripNote } = await import("@/components/import/mapping-step");
const { RoundTripOptionsStep } = await import("@/components/import/options-step");
const { CheckStep, outcomeText } = await import("@/components/import/check-step");
const { ImportResult } = await import("@/components/import/commit-step");
const { importButtonLabel } = await import("@/components/import/import-wizard");
const { suggestMapping } = await import("@/core/import/column-matching");
const { EMPTY_RESULT } = await import("@/core/import/types");

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const NOTE = "This file has a company_id column, so it adds people to companies that already exist. No companies are created or changed.";

describe("the mapping step", () => {
  const headers = ["ID", "company", "website", "email", "contact_name", "source_url", "note"];
  const samples = [["C-7", "Acme", "https://acme.de", "a@acme.de", "Anna", "https://acme.de/team", "On the team page"]];
  const suggested = suggestMapping(headers, samples).map((s) => s.mapping);

  it("setting a column to Company ID makes a round trip: source and note go to the person", () => {
    expect(suggested.map((m) => m.target)).toEqual(["ignore", "company", "website", "email", "name", "website", "notes"]);
    const on = nextMapping(headers, samples, suggested, 0, "t:company_id");
    expect(on.map((m) => m.target)).toEqual(["company_id", "company", "website", "email", "name", "person_notes", "person_notes"]);
    const off = nextMapping(headers, samples, on, 0, "ignore");
    expect(off.map((m) => m.target)).toEqual(["ignore", "company", "website", "email", "name", "website", "notes"]);
    // Other changes leave the rest alone.
    expect(nextMapping(headers, samples, on, 2, "ignore").map((m) => m.target)).toEqual([
      "company_id",
      "company",
      "ignore",
      "email",
      "name",
      "person_notes",
      "person_notes",
    ]);
  });

  it("keeps custom field keys unique", () => {
    const two = nextMapping(["Phone", "Phone 2"], [], [{ target: "custom", key: "phone", label: "Phone" }, { target: "ignore" }], 1, "custom");
    expect(two.map((m) => (m.target === "custom" ? m.key : m.target))).toEqual(["phone", "phone_2"]);
  });

  it("shows the round-trip note, with the way back, and marks company columns as not used", () => {
    const on = nextMapping(headers, samples, suggested, 0, "t:company_id");
    const out = html(
      createElement(MappingStep, {
        headers,
        sampleRows: samples,
        mapping: on,
        suggested,
        confidence: suggested.map(() => "high" as const),
        onChange: () => undefined,
      }),
    );
    expect(out).toContain(NOTE);
    expect(out).toContain("To import it as an ordinary file instead, set the company_id column to “Ignore this column”.");
    expect(out).toContain("Not used: this file only adds people.");
    // Only the ID column was chosen by hand; source and note follow the round trip's own suggestion.
    expect(out.match(/Chosen by you\./g) ?? []).toHaveLength(1);
    expect(out.match(/Matched automatically\./g) ?? []).toHaveLength(5);
  });

  it("an ordinary mapping has no note", () => {
    const out = html(
      createElement(MappingStep, {
        headers,
        sampleRows: samples,
        mapping: suggested,
        suggested,
        confidence: suggested.map(() => "high" as const),
        onChange: () => undefined,
      }),
    );
    expect(out).not.toContain(NOTE);
    expect(out).not.toContain("Not used");
  });
});

describe("the options step", () => {
  it("shows only the note", () => {
    const out = html(createElement(RoundTripOptionsStep));
    expect(out).toContain(NOTE);
    expect(out).not.toContain("Ignore this column");
    expect(out).not.toContain("Starting status");
    expect(html(createElement(RoundTripNote, { optOut: true }))).toContain("Ignore this column");
  });
});

function roundTripView(): CheckView {
  return {
    summary: {
      rows: 10,
      companies: 3,
      newCompanies: 0,
      updateCompanies: 1,
      skipCompanies: 2,
      restoreCompanies: 0,
      deletedFound: 0,
      possibleDuplicates: 0,
      peopleToAdd: 2,
      alreadyEmailed: 0,
      emptyRows: 0,
      invalidEmails: 0,
      problemRows: 3,
      noteRows: 0,
      noEmailRows: 1,
    },
    groups: [
      {
        key: "r2",
        rowNumbers: [2, 3],
        rowCount: 2,
        name: "Firma GmbH",
        website: "firma.de",
        country: "DE",
        people: [
          { name: "Anna Berg", email: "anna@firma.de" },
          { name: "General inbox", email: "info@firma.de" },
        ],
        peopleCount: 2,
        outcome: "update",
        existing: { id: 1042, code: "C-1042", name: "Firma GmbH", country: "DE", deleted: false },
        decision: null,
        flags: [],
        rowNotes: [],
        needsLook: false,
      },
      {
        key: "r6",
        rowNumbers: [6],
        rowCount: 1,
        name: "Butikk AS",
        website: null,
        country: "NO",
        people: [],
        peopleCount: 0,
        outcome: "skip",
        existing: { id: 1043, code: "C-1043", name: "Butikk AS", country: "NO", deleted: false },
        decision: null,
        flags: [],
        rowNotes: ["Row 6: No email found. Claude's note: “Only a contact form”"],
        needsLook: true,
      },
    ],
    totalGroups: 2,
    rowIssues: [
      { rowNumber: 5, tone: "problem", message: "C-9999 isn't a company in the app." },
      { rowNumber: 6, tone: "no-email", message: "No email found. Claude's note: “Only a contact form”" },
    ],
    totalRowIssues: 2,
    onlyProblems: false,
    duplicates: "skip",
    possibleDuplicates: "new",
    deletedMatches: "restore",
    roundTrip: true,
  };
}

describe("the check step", () => {
  it("shows the round-trip summary, the companies by code and the people to add", () => {
    const out = html(
      createElement(CheckStep, { view: roundTripView(), busy: false, onChoice: () => undefined, onDefaults: () => undefined, onOnlyProblems: () => undefined }),
    );
    expect(out).toContain("Adds 2 people to 1 company.");
    expect(out).toContain("1 row has no email (Claude's notes are listed below).");
    expect(out).toContain("3 rows need a look.");
    expect(out).not.toContain("New companies");
    expect(out).toContain("C-1042 </span>Firma GmbH");
    expect(out).toContain("People to add");
    expect(out).toContain("Anna Berg");
    expect(out).toContain(">Adds 2 people<");
    expect(out).toContain(">Nothing to add<");
    expect(out).toContain("Row 6: No email found. Claude's note: “Only a contact form”");
    expect(out).toContain(">No email<");
    expect(out).toContain("C-9999 isn't a company in the app.");
    expect(out).toContain("download the rows with a problem");
  });

  it("names what happens", () => {
    const [firma, butikk] = roundTripView().groups;
    expect(outcomeText(firma!, true)).toBe("Adds 2 people");
    expect(outcomeText(butikk!, true)).toBe("Nothing to add");
    expect(outcomeText({ ...firma!, peopleCount: 1 }, true)).toBe("Adds 1 person");
  });

  it("the import button says how many people are added", () => {
    const view = roundTripView();
    expect(importButtonLabel(view)).toBe("Add 2 people");
    expect(importButtonLabel({ ...view, summary: { ...view.summary, peopleToAdd: 1 } })).toBe("Add 1 person");
    expect(importButtonLabel({ ...view, summary: { ...view.summary, peopleToAdd: 0 } })).toBe("Finish the import");
    expect(importButtonLabel({ ...view, roundTrip: false, summary: { ...view.summary, newCompanies: 3 } })).toBe("Import 3 new companies");
  });
});

describe("the result step", () => {
  const summary: ImportResultSummary = {
    ...EMPTY_RESULT,
    roundTrip: true,
    rows: 44,
    updated: 30,
    unchanged: 7,
    peopleAdded: 37,
    noEmailRows: 5,
    problems: 2,
  };

  it("says what was added, the rows without email, and offers the problem rows", () => {
    const out = html(createElement(ImportResult, { sessionId: 12, fileLabel: "claude.csv", summary }));
    expect(out).toContain("Import finished");
    expect(out).toContain("Added 37 people to 30 companies.");
    expect(out).toContain("5 rows had no email.");
    expect(out).toContain("2 rows need a look.");
    expect(out).toContain('href="/api/imports/12/problems"');
    expect(out).toContain("Download problem rows (2)");
    expect(out).toContain('href="/contacts?view=missing-email"');
    expect(out).not.toContain("Skipped duplicates");
  });

  it("an ordinary import keeps its own result", () => {
    const out = html(createElement(ImportResult, { sessionId: 12, fileLabel: "a.csv", summary: { ...EMPTY_RESULT, created: 2, peopleAdded: 2 } }));
    expect(out).toContain("Imported a.csv: 2 new companies, 2 people added.");
    expect(out).toContain("Skipped duplicates");
  });
});
