import { describe, expect, it } from "vitest";
import {
  customFieldKey,
  ensureUniqueCustomKeys,
  isRoundTripMapping,
  isRoundTripNoteHeader,
  mappingProblem,
  mapRow,
  previewCell,
  previewColumns,
  retargetRoundTripColumns,
  ROUND_TRIP_NEEDS_EMAIL,
  suggestMapping,
  TARGET_LABELS,
  type ColumnMapping,
} from "@/core/import/column-matching";

function targets(headers: string[], samples: string[][] = []): string[] {
  return suggestMapping(headers, samples).map(({ mapping: m }) =>
    m.target === "custom" ? `custom:${m.key}` : m.target,
  );
}

describe("suggestMapping: English", () => {
  it("matches the usual headers", () => {
    expect(
      targets([
        "Company Name",
        "Website",
        "Email Address",
        "Contact Person",
        "Job Title",
        "Country",
        "Niche",
        "Tags",
        "Notes",
        "Personal line",
        "Instagram",
        "Priority",
        "Status",
        "Last contacted",
        "List",
        "First name",
        "Last name",
      ]),
    ).toEqual([
      "company",
      "website",
      "email",
      "name",
      "role",
      "country",
      "niche",
      "tags",
      "notes",
      "personal_line",
      "instagram",
      "priority",
      "status",
      "last_contacted",
      "list",
      "first_name",
      "last_name",
    ]);
  });

  it("says how sure it is", () => {
    const s = suggestMapping(["Company", "Favourite colour"]);
    expect(s[0]!.confidence).toBe("high");
    expect(s[1]!.confidence).toBe("low");
    expect(s[1]!.mapping).toEqual({ target: "custom", key: "favourite_colour", label: "Favourite colour" });
  });
});

describe("suggestMapping: German", () => {
  it("matches German headers", () => {
    expect(
      targets([
        "Firma",
        "Webseite",
        "E-Mail",
        "Ansprechpartner",
        "Position",
        "Land",
        "Branche",
        "Schlagworte",
        "Notizen",
        "Letzter Kontakt",
        "Priorität",
        "Vorname",
        "Nachname",
        "Unternehmen",
        "Homepage",
        "Kategorie",
        "Funktion",
      ]),
    ).toEqual([
      "company",
      "website",
      "email",
      "name",
      "role",
      "country",
      "niche",
      "tags",
      "notes",
      "last_contacted",
      "priority",
      "first_name",
      "last_name",
      "company",
      "website",
      "niche",
      "role",
    ]);
  });

  it("matches compound German headers by their parts", () => {
    expect(targets(["E-Mail-Adresse", "Firmenname", "Kontaktdatum"])).toEqual(["email", "company", "last_contacted"]);
  });
});

describe("suggestMapping: Norwegian", () => {
  it("matches Norwegian headers", () => {
    expect(
      targets([
        "Bedrift",
        "Nettside",
        "E-post",
        "Kontaktperson",
        "Stilling",
        "Land",
        "Kategori",
        "Notater",
        "Sist kontaktet",
        "Prioritet",
        "Selskap",
        "Fornavn",
        "Etternavn",
      ]),
    ).toEqual([
      "company",
      "website",
      "email",
      "name",
      "role",
      "country",
      "niche",
      "notes",
      "last_contacted",
      "priority",
      "company",
      "first_name",
      "last_name",
    ]);
  });
});

describe("suggestMapping: the old tool", () => {
  it("keeps members, est. revenue and platforms as custom fields", () => {
    const s = suggestMapping(["Name", "Priority", "Niche", "Members", "Est. Revenue", "Platforms", "Status", "Last Contact", "Notes"]);
    expect(s.map((x) => x.mapping)).toEqual([
      { target: "company" },
      { target: "priority" },
      { target: "niche" },
      { target: "custom", key: "followers", label: "Followers" },
      { target: "custom", key: "est_revenue", label: "Est. revenue" },
      { target: "custom", key: "platforms", label: "Platforms" },
      { target: "status" },
      { target: "last_contacted" },
      { target: "notes" },
    ]);
  });

  it("maps Followers too", () => {
    expect(targets(["Followers", "Følgere", "Instagram followers"])).toEqual([
      "custom:followers",
      "custom:followers_2",
      "custom:followers_3",
    ]);
  });
});

describe("the ambiguous Name column", () => {
  it("is the company when there's no company column", () => {
    const s = suggestMapping(["Name", "Email"]);
    expect(s[0]!.mapping).toEqual({ target: "company" });
    expect(s[0]!.confidence).toBe("medium");
  });

  it("is the person's name when there is a company column", () => {
    expect(targets(["Company", "Name", "Email"])).toEqual(["company", "name", "email"]);
    expect(targets(["Name", "Firma"])).toEqual(["name", "company"]);
  });

  it("only one lone Name becomes the company", () => {
    expect(targets(["Name", "Navn"])).toEqual(["company", "name"]);
  });
});

describe("guesses from the values", () => {
  it("reads a vague Contact column by its values", () => {
    expect(targets(["Company", "Contact"], [["Acme", "info@acme.de"], ["Beta", "hi@beta.no"]])).toEqual(["company", "email"]);
    expect(targets(["Company", "Contact"], [["Acme", "Anna Schmidt"]])).toEqual(["company", "name"]);
  });

  it("recognises links and emails in unknown columns", () => {
    expect(
      targets(["Company", "Links", "Mailbox"], [
        ["Acme", "https://acme.de", "info@acme.de"],
        ["Beta", "www.beta.no", "post@beta.no"],
      ]),
    ).toEqual(["company", "website", "email"]);
  });

  it("doesn't turn an 'Email status' column into email addresses", () => {
    expect(targets(["Company", "Email status"], [["Acme", "valid"], ["Beta", "bounced"]])).toEqual([
      "company",
      "custom:email_status",
    ]);
  });

  it("ignores our own export's bookkeeping columns; company_id is the Company ID (the round trip)", () => {
    expect(targets(["company_id", "company", "emailed_by", "person_name", "last_emailed"])).toEqual([
      "company_id",
      "company",
      "ignore",
      "name",
      "last_contacted",
    ]);
  });

  it("keeps a bare ID or # ignored (too ambiguous in other files)", () => {
    expect(targets(["ID", "#", "Company", "Email"])).toEqual(["ignore", "ignore", "company", "email"]);
  });
});

describe("custom field keys", () => {
  it("slugs headers", () => {
    expect(customFieldKey("Est. revenue")).toBe("est_revenue");
    expect(customFieldKey("Größe (m²)")).toBe("grosse_m2");
    expect(customFieldKey("2024 sales")).toBe("f_2024_sales");
    expect(customFieldKey("")).toBe("column_1");
    expect(customFieldKey("Company")).toBe("company_field");
  });

  it("keeps keys unique", () => {
    const m: ColumnMapping[] = [
      { target: "custom", key: "phone", label: "Phone" },
      { target: "custom", key: "phone", label: "Phone (2)" },
      { target: "email" },
    ];
    expect(ensureUniqueCustomKeys(m).map((x) => (x.target === "custom" ? x.key : x.target))).toEqual(["phone", "phone_2", "email"]);
  });
});

describe("mapping checks and preview", () => {
  it("needs at least one column that says which company a row is", () => {
    expect(mappingProblem([{ target: "niche" }, { target: "custom", key: "x", label: "X" }])).toMatch(/at least one column/);
    expect(mappingProblem([{ target: "email" }])).toBeNull();
  });

  it("a round-trip mapping needs an email column; the Company ID says which company", () => {
    expect(mappingProblem([{ target: "company_id" }, { target: "company" }])).toBe(ROUND_TRIP_NEEDS_EMAIL);
    expect(mappingProblem([{ target: "company_id" }, { target: "email" }])).toBeNull();
    expect(mappingProblem([{ target: "company_id" }, { target: "email" }, { target: "person_notes" }])).toBeNull();
  });

  it("maps a row and builds the preview", () => {
    const mapping: ColumnMapping[] = [
      { target: "company" },
      { target: "email" },
      { target: "email" },
      { target: "custom", key: "followers", label: "Followers" },
      { target: "ignore" },
    ];
    const row = mapRow(mapping, ["Acme", "a@acme.de", "b@acme.de", "12k", "whatever"]);
    expect(row.fields.email).toEqual(["a@acme.de", "b@acme.de"]);
    const cols = previewColumns(mapping);
    expect(cols.map((c) => c.label)).toEqual(["Company name", "Email", "Followers"]);
    expect(cols.map((c) => previewCell(row, c.id))).toEqual(["Acme", "a@acme.de, b@acme.de", "12k"]);
  });
});

describe("the missing-emails round trip (M5-DESIGN §4.2)", () => {
  const CLAUDE_HEADERS = ["company_id", "company", "email", "contact_name", "role", "source_url", "note"];
  const CLAUDE_ROWS = [
    ["C-1042", "Firma GmbH", "anna@firma.de", "Anna Berg", "Buyer", "https://firma.de/kontakt", "Named on the contact page"],
    ["C-1043", "Butikk AS", "", "", "", "", "Only a contact form on the site."],
  ];

  it("has the two new targets with their labels", () => {
    expect(TARGET_LABELS.company_id).toBe("Company ID (like C-1042)");
    expect(TARGET_LABELS.person_notes).toBe("Notes about the person");
  });

  it("maps Claude's header row: company_id, and source_url and note to the person's notes", () => {
    const s = suggestMapping(CLAUDE_HEADERS, CLAUDE_ROWS);
    expect(s.map((x) => x.mapping)).toEqual([
      { target: "company_id" },
      { target: "company" },
      { target: "email" },
      { target: "name" },
      { target: "role" },
      { target: "person_notes" },
      { target: "person_notes" },
    ]);
    expect(s[0]!.confidence).toBe("high");
    expect(s[5]!.confidence).toBe("high");
    expect(isRoundTripMapping(s.map((x) => x.mapping))).toBe(true);
  });

  it("knows the German and Norwegian names of the columns", () => {
    expect(targets(["Firmen-ID", "E-Mail", "Quelle", "Notiz"])).toEqual(["company_id", "email", "person_notes", "person_notes"]);
    expect(targets(["bedrifts-id", "E-post", "Kilde", "Merknad"])).toEqual(["company_id", "email", "person_notes", "person_notes"]);
    expect(targets(["Company ID", "Email", "Source", "Notes"])).toEqual(["company_id", "email", "person_notes", "person_notes"]);
    expect(targets(["companyid", "Email"])).toEqual(["company_id", "email"]);
    expect(targets(["Company code", "Email"])).toEqual(["company_id", "email"]);
    expect(targets(["firmen_id", "bedrift_id"])).toEqual(["company_id", "company_id"]);
  });

  it("without a Company ID the same columns keep their ordinary meaning", () => {
    expect(targets(["company", "email", "source_url", "note"], [["Acme", "a@acme.de", "https://acme.de", "hi"]])).toEqual([
      "company",
      "email",
      "website",
      "notes",
    ]);
    expect(isRoundTripMapping(suggestMapping(["company", "email"]).map((x) => x.mapping))).toBe(false);
  });

  it("the round-trip switch can be forced either way", () => {
    const on = suggestMapping(["company", "email", "note"], [], { roundTrip: true }).map((x) => x.mapping.target);
    expect(on).toEqual(["company", "email", "person_notes"]);
    const off = suggestMapping(CLAUDE_HEADERS, CLAUDE_ROWS, { roundTrip: false }).map((x) => x.mapping.target);
    expect(off).toEqual(["company_id", "company", "email", "name", "role", "website", "notes"]);
  });

  it("knows which headers are round-trip note columns", () => {
    for (const h of ["source_url", "Source URL", "source", "Quelle", "kilde", "note", "Notes", "Notiz", "merknad"]) {
      expect(isRoundTripNoteHeader(h)).toBe(true);
    }
    for (const h of ["website", "comment", "email", "company_id"]) expect(isRoundTripNoteHeader(h)).toBe(false);
  });

  it("follows the switch when a column is set to or away from Company ID, keeping the person's own choices", () => {
    const headers = ["id", "company", "email", "source_url", "note", "comment"];
    const samples = [["C-7", "Acme", "a@acme.de", "https://acme.de/team", "found it", "x"]];
    const ordinary: ColumnMapping[] = suggestMapping(headers, samples).map((x) => x.mapping);
    expect(ordinary.map((m) => m.target)).toEqual(["ignore", "company", "email", "website", "notes", "notes"]);

    // The person sets "id" to Company ID: source_url and note go to the person; "comment" isn't a note header.
    const on = retargetRoundTripColumns(headers, samples, [{ target: "company_id" }, ...ordinary.slice(1)], true);
    expect(on.map((m) => m.target)).toEqual(["company_id", "company", "email", "person_notes", "person_notes", "notes"]);

    // A column the person chose themselves stays.
    const chosen = retargetRoundTripColumns(headers, samples, [{ target: "company_id" }, ordinary[1]!, ordinary[2]!, { target: "ignore" }, ordinary[4]!, ordinary[5]!], true);
    expect(chosen.map((m) => m.target)).toEqual(["company_id", "company", "email", "ignore", "person_notes", "notes"]);

    // Back to an ordinary import: every person-notes column goes back to its ordinary suggestion.
    const off = retargetRoundTripColumns(headers, samples, [{ target: "ignore" }, ...on.slice(1)], false);
    expect(off.map((m) => m.target)).toEqual(["ignore", "company", "email", "website", "notes", "notes"]);
  });

  it("maps person notes as a multi-value field and shows them in the preview", () => {
    const mapping: ColumnMapping[] = [{ target: "company_id" }, { target: "email" }, { target: "person_notes" }, { target: "person_notes" }];
    const row = mapRow(mapping, ["C-5", "a@b.de", "https://b.de", "Named on the site"]);
    expect(row.fields.company_id).toEqual(["C-5"]);
    expect(row.fields.person_notes).toEqual(["https://b.de", "Named on the site"]);
    const cols = previewColumns(mapping);
    expect(cols.map((c) => c.label)).toEqual(["Company ID (like C-1042)", "Email", "Notes about the person"]);
    expect(previewCell(row, "person_notes")).toBe("https://b.de, Named on the site");
  });
});
