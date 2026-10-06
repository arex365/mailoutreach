import { describe, expect, it } from "vitest";
import {
  appendPersonNotes,
  claudeNoteOf,
  CLAUDE_MISSING_EMAILS_INSTRUCTION,
  companyNamesDiffer,
  isLinkValue,
  isRoundTripMapping,
  parseCompanyCode,
  PERSON_NOTES_MAX,
  personNotesText,
  ROUND_TRIP_OPTIONS,
  ROUND_TRIP_TEXT,
  roundTripCheckLines,
  roundTripResultLines,
} from "@/core/import/round-trip";
import { DEFAULT_IMPORT_OPTIONS, EMPTY_RESULT, importSummarySentence, readResultSummary, type ImportResultSummary } from "@/core/import/types";

/** PLAN.md B6.13, word for word. */
const B6_13 =
  "I've attached a CSV of companies. For each row, find the best email address for contacting this company about 3D modelling work (print-ready 3D models such as figurines, creatures, busts and statues). Prefer, in this order: a named person responsible for products, design or purchasing; then the company's general address (info@, hello@, kontakt@, post@). Use only addresses published on the company's own website, its official social profiles or a business directory. Never guess or construct an address. Return a CSV with exactly these columns: company_id, company, email, contact_name, role, source_url, note. Keep company_id exactly as given. If you find two good contacts, add a second row with the same company_id. If you find nothing, leave email empty and say why in note.";

describe("CLAUDE_MISSING_EMAILS_INSTRUCTION", () => {
  it("is PLAN.md B6.13's instruction exactly", () => {
    expect(CLAUDE_MISSING_EMAILS_INSTRUCTION).toBe(B6_13);
  });

  it("names the export's own columns and keeps company_id", () => {
    expect(CLAUDE_MISSING_EMAILS_INSTRUCTION).toContain("company_id, company, email, contact_name, role, source_url, note");
    expect(CLAUDE_MISSING_EMAILS_INSTRUCTION).toContain("Keep company_id exactly as given.");
  });
});

describe("parseCompanyCode", () => {
  it.each([
    ["C-1042", 1042],
    ["c-1042", 1042],
    ["c1042", 1042],
    ["C1042", 1042],
    ["C 1042", 1042],
    ["C - 1042", 1042],
    ["1042", 1042],
    ["  C-1042  ", 1042],
    ["'C-1042", 1042],
    ["'1042", 1042],
    ["-1042", 1042],
    ["C-01042", 1042],
    ["C-999999999", 999_999_999],
  ])("reads %j as %i", (input, id) => {
    expect(parseCompanyCode(input)).toBe(id);
  });

  it.each([
    [""],
    ["   "],
    ["Firma"],
    ["C-"],
    ["C-12a"],
    ["CC-12"],
    ["D-12"],
    ["C-1042-2"],
    ["1,042"],
    ["C-1234567890"],
    ["C-0"],
    ["0"],
    ["''C-12"],
    ["12 34"],
  ])("refuses %j", (input) => {
    expect(parseCompanyCode(input)).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(parseCompanyCode(null)).toBeNull();
    expect(parseCompanyCode(undefined)).toBeNull();
  });
});

describe("isRoundTripMapping", () => {
  it("is a round trip when some column is the Company ID", () => {
    expect(isRoundTripMapping([{ target: "company" }, { target: "email" }])).toBe(false);
    expect(isRoundTripMapping([{ target: "ignore" }, { target: "company_id" }, { target: "email" }])).toBe(true);
  });
});

describe("person notes", () => {
  it("puts source links first and joins with ' · '", () => {
    expect(personNotesText(["Named on the team page", "https://firma.de/team"])).toBe("https://firma.de/team · Named on the team page");
    expect(personNotesText(["www.firma.de/kontakt", "  Buyer  since   2020 "])).toBe("www.firma.de/kontakt · Buyer since 2020");
  });

  it("leaves out empty values and repeats; null when nothing is left", () => {
    expect(personNotesText(["", "  ", "Hi", "hi"])).toBe("Hi");
    expect(personNotesText([])).toBeNull();
    expect(personNotesText(["   "])).toBeNull();
  });

  it("cuts very long notes", () => {
    const long = personNotesText(["x".repeat(PERSON_NOTES_MAX + 500)])!;
    expect(long.length).toBe(PERSON_NOTES_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("Claude's note is the remark, not the link", () => {
    expect(claudeNoteOf(["https://firma.de", "Only a contact form on the site."])).toBe("Only a contact form on the site.");
    expect(claudeNoteOf(["https://firma.de"])).toBeNull();
    expect(claudeNoteOf([])).toBeNull();
    expect(claudeNoteOf(["y".repeat(500)])!.length).toBe(200);
  });

  it("tells links from remarks", () => {
    expect(isLinkValue("https://a.de/x")).toBe(true);
    expect(isLinkValue("http://a.de")).toBe(true);
    expect(isLinkValue("www.a.de")).toBe(true);
    expect(isLinkValue("see https://a.de")).toBe(false);
    expect(isLinkValue("Only a form")).toBe(false);
  });

  it("appends to a person's existing notes once", () => {
    expect(appendPersonNotes("", "https://a.de · Buyer")).toBe("https://a.de · Buyer");
    expect(appendPersonNotes(null, "x")).toBe("x");
    expect(appendPersonNotes("Met at the fair", "https://a.de")).toBe("Met at the fair\nhttps://a.de");
    expect(appendPersonNotes("Met at the fair\nhttps://a.de", "https://a.de")).toBeNull();
    expect(appendPersonNotes("Met at the fair", null)).toBeNull();
    expect(appendPersonNotes("Met at the fair", "  ")).toBeNull();
  });
});

describe("companyNamesDiffer", () => {
  it("is true only when the normalised names share no word", () => {
    expect(companyNamesDiffer("Foo Ltd", "Firma GmbH")).toBe(true);
    expect(companyNamesDiffer("Firma", "Firma GmbH")).toBe(false);
    expect(companyNamesDiffer("Figuren Werkstatt Berlin", "Werkstatt für Figuren")).toBe(false);
    expect(companyNamesDiffer("Müller 3D", "mueller 3d")).toBe(false);
    expect(companyNamesDiffer("GmbH", "Firma GmbH")).toBe(false);
    expect(companyNamesDiffer("", "Firma")).toBe(false);
    expect(companyNamesDiffer(null, "Firma")).toBe(false);
  });
});

describe("the row texts (M5-DESIGN §4.2)", () => {
  it("say what's wrong and what to do", () => {
    expect(ROUND_TRIP_TEXT.noCompanyId).toBe("No company_id. Use the file exported from the app.");
    expect(ROUND_TRIP_TEXT.notACompanyId("Firma")).toBe("“Firma” isn't a company ID like C-1042.");
    expect(ROUND_TRIP_TEXT.unknownCompany(9999)).toBe("C-9999 isn't a company in the app.");
    expect(ROUND_TRIP_TEXT.deletedCompany(1042, "Firma GmbH")).toBe("C-1042 (Firma GmbH) was deleted. Restore it first, or leave this row out.");
    expect(ROUND_TRIP_TEXT.noEmail("Only a contact form on the site.")).toBe(
      "No email found. Claude's note: “Only a contact form on the site.”",
    );
    expect(ROUND_TRIP_TEXT.noEmail(null)).toBe("No email found.");
    expect(ROUND_TRIP_TEXT.alreadyAtCompany("anna@firma.de", 1042, "Firma GmbH")).toBe("anna@firma.de is already at C-1042 (Firma GmbH).");
    expect(ROUND_TRIP_TEXT.removedPersonElsewhere("anna@firma.de", 1043, "Other GmbH")).toBe(
      "anna@firma.de belonged to a removed person at C-1043 (Other GmbH). Restore that person there, or leave this row out.",
    );
    expect(ROUND_TRIP_TEXT.nameDiffers("Foo Ltd", 1042, "Firma GmbH")).toBe("The file says “Foo Ltd” for C-1042 (Firma GmbH); the ID is used.");
  });

  it("shorten what the file says", () => {
    expect(ROUND_TRIP_TEXT.notACompanyId("x".repeat(100))).toBe(`“${"x".repeat(59)}…” isn't a company ID like C-1042.`);
  });
});

describe("the options a round trip saves", () => {
  it("are the defaults, unchanged", () => {
    expect(ROUND_TRIP_OPTIONS).toEqual({
      list: DEFAULT_IMPORT_OPTIONS.list,
      startStatus: DEFAULT_IMPORT_OPTIONS.startStatus,
      tag: DEFAULT_IMPORT_OPTIONS.tag,
      duplicates: DEFAULT_IMPORT_OPTIONS.duplicates,
      grouping: DEFAULT_IMPORT_OPTIONS.grouping,
    });
  });
});

describe("summary lines", () => {
  const check = { peopleToAdd: 37, updateCompanies: 30, noEmailRows: 5, problemRows: 1, invalidEmails: 1 };

  it("the check step: adds, no email, need a look", () => {
    expect(roundTripCheckLines(check)).toEqual([
      "Adds 37 people to 30 companies.",
      "5 rows have no email (Claude's notes are listed below).",
      "2 rows need a look.",
    ]);
    expect(roundTripCheckLines({ peopleToAdd: 1, updateCompanies: 1, noEmailRows: 1, problemRows: 0, invalidEmails: 0 })).toEqual([
      "Adds 1 person to 1 company.",
      "1 row has no email (Claude's notes are listed below).",
    ]);
    expect(roundTripCheckLines({ peopleToAdd: 0, updateCompanies: 0, noEmailRows: 0, problemRows: 1, invalidEmails: 0 })).toEqual([
      "Adds no new people.",
      "1 row needs a look.",
    ]);
  });

  const result: ImportResultSummary = { ...EMPTY_RESULT, roundTrip: true, rows: 44, peopleAdded: 37, updated: 30, noEmailRows: 5, problems: 2 };

  it("the result step: added, had no email, need a look", () => {
    expect(roundTripResultLines(result)).toEqual(["Added 37 people to 30 companies.", "5 rows had no email.", "2 rows need a look."]);
    expect(roundTripResultLines({ ...result, peopleAdded: 1, updated: 1, noEmailRows: 1, problems: 0 })).toEqual([
      "Added 1 person to 1 company.",
      "1 row had no email.",
    ]);
    expect(roundTripResultLines({ ...result, peopleAdded: 0, updated: 0, noEmailRows: 0, problems: 0 })).toEqual(["No people were added."]);
  });

  it("the activity sentence has a round-trip variant", () => {
    expect(importSummarySentence("claude.csv", { ...result, problems: 0 }, "Ali")).toBe(
      "Ali imported claude.csv: 37 people added to 30 companies, 5 rows without an email.",
    );
    expect(importSummarySentence("claude.csv", { ...result, invalidEmails: 1 })).toBe(
      "Imported claude.csv: 37 people added to 30 companies, 5 rows without an email, 1 invalid email, 2 rows need a look.",
    );
    expect(importSummarySentence("claude.csv", { ...result, peopleAdded: 0, updated: 0, noEmailRows: 1, problems: 0 })).toBe(
      "Imported claude.csv: 0 people added, 1 row without an email.",
    );
    // An ordinary import keeps its sentence.
    expect(importSummarySentence("a.csv", { ...EMPTY_RESULT, created: 2, peopleAdded: 2 })).toBe("Imported a.csv: 2 new companies, 2 people added.");
  });

  it("stored summaries remember the round trip; older ones read as ordinary imports", () => {
    expect(readResultSummary({ ...result })).toMatchObject({ roundTrip: true, noEmailRows: 5 });
    expect(readResultSummary({ created: 3 })).toMatchObject({ roundTrip: false, noEmailRows: 0, created: 3 });
    expect(readResultSummary({ roundTrip: "yes" })?.roundTrip).toBe(false);
  });
});
