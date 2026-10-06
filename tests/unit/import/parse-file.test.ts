import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { suggestMapping } from "@/core/import/column-matching";
import {
  decodeText,
  detectKind,
  ImportFileError,
  parseDelimitedText,
  parsePastedText,
  parseUploadedFile,
  parseWorkbookBytes,
} from "@/server/services/imports/parse-file";

const FIXTURES = path.resolve("tests/fixtures/import");

function workbook(sheets: Record<string, unknown[][]>, bookType: XLSX.BookType): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { UTC: true }), name);
  }
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType }) as Buffer);
}

function expectFileError(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ImportFileError);
    expect((err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected an ImportFileError");
}

describe("detecting the file type", () => {
  it("uses magic bytes, not the name", () => {
    expect(detectKind(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("xlsx");
    expect(detectKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe("xls");
    expect(detectKind(new TextEncoder().encode("a,b"))).toBe("text");
  });

  it("decodes UTF-8, windows-1252 and UTF-16", () => {
    expect(decodeText(new TextEncoder().encode("﻿Müller"))).toBe("Müller");
    expect(decodeText(Buffer.from("Müller €", "latin1").map((b, i, a) => (i === a.length - 1 ? 0x80 : b)))).toBe("Müller €");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ørsted", "utf16le")]);
    expect(decodeText(utf16)).toBe("Ørsted");
  });
});

describe("CSV files", () => {
  it("reads a semicolon CSV saved by German Excel in windows-1252", () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "semicolon-1252.csv"));
    const up = parseUploadedFile(bytes, "kunden.csv");
    expect(up.kind).toBe("csv");
    expect(up.table.headers).toEqual(["Firma", "Webseite", "E-Mail", "Ansprechpartner", "Land", "Nische", "Letzter Kontakt", "Notizen"]);
    expect(up.table.rows).toHaveLength(3);
    expect(up.table.rows[0]!.cells[0]).toBe("Müller 3D-Druck GmbH");
    expect(up.table.rows[0]!.cells[7]).toBe("Große Drucker, schnelle Lieferung");
    expect(up.table.rows[1]!.cells[3]).toBe("Jörg Weiß");
    expect(up.table.rows[1]!.cells[7]).toBe('Hat "Büsten" im Angebot');
    expect(up.table.rows[2]!.cells[3]).toBe("Åse Ødegård");
    expect(up.table.rows.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
    expect(suggestMapping(up.table.headers).map((s) => s.mapping.target)).toEqual([
      "company",
      "website",
      "email",
      "name",
      "country",
      "niche",
      "last_contacted",
      "notes",
    ]);
  });

  it("follows Excel's sep= line and keeps row numbers", () => {
    const t = parseDelimitedText("sep=;\r\nName;Email\r\nAcme;info@acme.de\r\n\r\nBeta;hi@beta.no\r\n");
    expect(t.headers).toEqual(["Name", "Email"]);
    // The blank row between two rows is kept (it's counted as an "empty row" in the summary).
    expect(t.rows.map((r) => [r.rowNumber, ...r.cells])).toEqual([
      [3, "Acme", "info@acme.de"],
      [4, "", ""],
      [5, "Beta", "hi@beta.no"],
    ]);
  });

  it("ignores blank lines after the last row", () => {
    const t = parseDelimitedText("Name;Email\r\nAcme;info@acme.de\r\n\r\n;\r\n\r\n");
    expect(t.rows.map((r) => r.rowNumber)).toEqual([2]);
  });

  it("skips a title line above the header", () => {
    const t = parseDelimitedText("German 3D Companies,,\nCompany,Website,Email\nAcme,acme.de,info@acme.de\n");
    expect(t.headers).toEqual(["Company", "Website", "Email"]);
    expect(t.rows[0]!.rowNumber).toBe(3);
  });

  it("names empty and repeated headers", () => {
    const t = parseDelimitedText("Email,,Email\na@x.de,1,b@x.de\n");
    expect(t.headers).toEqual(["Email", "Column 2", "Email (2)"]);
  });

  it("reads UTF-16 'Unicode text' from Excel", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Firma\tE-Mail\r\nØrsted AS\tpost@orsted.no\r\n", "utf16le")]);
    const up = parseUploadedFile(bytes, "export.txt");
    expect(up.table.rows[0]!.cells).toEqual(["Ørsted AS", "post@orsted.no"]);
  });
});

describe("pasted rows", () => {
  it("uses tabs when the pasted text has tabs", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "pasted.tsv"), "utf8");
    const up = parsePastedText(text);
    expect(up.kind).toBe("paste");
    expect(up.table.headers).toEqual(["Name", "Instagram", "Followers", "Email", "Status"]);
    expect(up.table.rows).toHaveLength(3);
    expect(up.table.rows[1]!.cells).toEqual(["Troll Forge", "https://www.instagram.com/trollforge/", "48000", "", "Contacted"]);
  });

  it("keeps commas inside tab-separated cells", () => {
    const up = parsePastedText("Company\tNotes\nAcme\tBig, fast printers\n");
    expect(up.table.rows[0]!.cells).toEqual(["Acme", "Big, fast printers"]);
  });

  it("explains what to do when only the header was pasted", () => {
    expectFileError(() => parsePastedText("Company\tEmail\n"), /Only the header row came through/);
  });
});

describe("spreadsheets", () => {
  const rows = [
    ["Firma", "E-Mail", "Letzter Kontakt", "Telefon", "Umsatz"],
    ["Müller GmbH", "info@mueller.de", new Date(Date.UTC(2026, 2, 4)), 4930123456789, 0.1 + 0.2],
    ["Ørsted AS", "post@orsted.no", new Date(Date.UTC(2026, 2, 4, 14, 30)), 12, 1e21],
  ];

  it("reads .xlsx with real dates and numbers without scientific notation", () => {
    const up = parseUploadedFile(workbook({ Kunden: rows }, "xlsx"), "kunden.xlsx");
    expect(up.kind).toBe("xlsx");
    expect(up.sheet).toBe("Kunden");
    expect(up.table.rows[0]!.cells).toEqual(["Müller GmbH", "info@mueller.de", "2026-03-04", "4930123456789", "0.3"]);
    expect(up.table.rows[1]!.cells).toEqual(["Ørsted AS", "post@orsted.no", "2026-03-04T14:30", "12", "1000000000000000000000"]);
  });

  it("reads legacy .xls (with umlauts from the code page)", () => {
    const up = parseUploadedFile(workbook({ Kunden: rows }, "biff8"), "kunden.xls");
    expect(up.kind).toBe("xls");
    expect(up.table.headers).toEqual(["Firma", "E-Mail", "Letzter Kontakt", "Telefon", "Umsatz"]);
    expect(up.table.rows[0]!.cells.slice(0, 3)).toEqual(["Müller GmbH", "info@mueller.de", "2026-03-04"]);
  });

  it("detects the type from the content, not the name", () => {
    const up = parseUploadedFile(workbook({ Kunden: rows }, "xlsx"), "kunden.csv");
    expect(up.kind).toBe("xlsx");
  });

  it("offers every sheet and picks the one asked for", () => {
    const bytes = workbook({ Empty: [], Germany: rows, Norway: [["Bedrift", "E-post"], ["Nordlys", "post@nordlys.no"]] }, "xlsx");
    const first = parseUploadedFile(bytes, "book.xlsx");
    expect(first.sheetNames).toEqual(["Empty", "Germany", "Norway"]);
    expect(first.sheet).toBe("Germany");
    expect(first.sheets).toEqual([
      { name: "Empty", rows: 0 },
      { name: "Germany", rows: 2 },
      { name: "Norway", rows: 1 },
    ]);
    const norway = parseUploadedFile(bytes, "book.xlsx", "Norway");
    expect(norway.sheet).toBe("Norway");
    expect(norway.table.rows[0]!.cells).toEqual(["Nordlys", "post@nordlys.no"]);
  });

  it("uses the row numbers Excel shows", () => {
    const up = parseUploadedFile(
      workbook({ S: [["Title of the list"], [], ["Company", "Email", "Notes"], ["Acme", "a@acme.de", ""], [], ["Beta", "b@beta.de", "x"]] }, "xlsx"),
      "s.xlsx",
    );
    expect(up.table.headers).toEqual(["Company", "Email", "Notes"]);
    expect(up.table.rows.map((r) => r.rowNumber)).toEqual([4, 5, 6]);
    expect(up.table.rows[1]!.cells).toEqual(["", "", ""]);
  });

  it("strips the export's formula apostrophe from spreadsheet cells too", () => {
    const up = parseUploadedFile(workbook({ S: [["Company", "Phone"], ["Acme", "'+49 30 123"]] }, "xlsx"), "s.xlsx");
    expect(up.table.rows[0]!.cells).toEqual(["Acme", "+49 30 123"]);
  });
});

describe("refusals with plain messages", () => {
  it("refuses file types it can't read", () => {
    expectFileError(() => parseUploadedFile(new Uint8Array([1, 2, 3]), "notes.docx"), /document, not a spreadsheet/);
    expectFileError(() => parseUploadedFile(new Uint8Array([1, 2, 3]), "prices.numbers"), /Apple Numbers/);
  });

  it("refuses empty files and header-only files", () => {
    expectFileError(() => parseUploadedFile(new Uint8Array(), "empty.csv"), /This file is empty/);
    expectFileError(() => parseUploadedFile(new TextEncoder().encode("Company,Email\n"), "h.csv"), /only has a header row/);
  });

  it("refuses more than 50,000 rows", () => {
    const text = "Company\n" + Array.from({ length: 50_001 }, (_, i) => `C${i}`).join("\n");
    expectFileError(() => parseUploadedFile(new TextEncoder().encode(text), "big.csv"), /50,001 rows; the limit is 50,000/);
  });

  it("refuses binary junk", () => {
    expectFileError(() => parseUploadedFile(new Uint8Array([0, 1, 0, 2, 0, 3]), "junk.csv"), /isn't a spreadsheet or CSV/);
  });
});

describe("column limits (SECURITY-3)", () => {
  it("refuses a tiny CSV whose header claims 20,000 columns, before building the table", () => {
    const text = "Company" + ",".repeat(19_999) + "x\n" + Array.from({ length: 200 }, (_, i) => `C${i}`).join("\n");
    expect(text.length).toBeLessThan(25_000);
    expectFileError(() => parseUploadedFile(new TextEncoder().encode(text), "wide.csv"), /20,000 columns; the limit is 500/);
  });

  it("refuses rows wider than Excel allows, even when the cells are empty", () => {
    const text = "Company,Email\nAcme,a@acme.de" + ",".repeat(20_000) + "\n";
    expectFileError(() => parseDelimitedText(text), /columns; the limit is 500/);
  });

  it("ignores empty columns on the right, so a padded file still reads", () => {
    const text = "Company,Email" + ",".repeat(2_000) + "\nAcme,a@acme.de" + ",".repeat(2_000) + "\n";
    const t = parseDelimitedText(text);
    expect(t.headers).toEqual(["Company", "Email"]);
    expect(t.rows[0]!.cells).toEqual(["Acme", "a@acme.de"]);
  });

  it("refuses pasted rows that are too wide", () => {
    const text = Array.from({ length: 600 }, (_, i) => `H${i}`).join("\t") + "\n" + Array.from({ length: 600 }, () => "x").join("\t");
    expectFileError(() => parsePastedText(text), /600 columns; the limit is 500/);
  });

  it("refuses rows × columns over the cell limit", () => {
    const header = Array.from({ length: 400 }, (_, i) => `H${i}`).join(",");
    const rows = Array.from({ length: 16_000 }, () => ",".repeat(399) + "x");
    expectFileError(() => parseDelimitedText([header, ...rows].join("\n")), /too big to read in one go: 16,000 rows × 400 columns/);
  });

  it("uses the cells a sheet really has, not the dimension the file claims", () => {
    // What XLSX.read(…, { dense: true }) gives for a sheet whose file claims A1:XFD60000.
    // (SheetJS can't write such a file quickly, so the parsed workbook is built by hand.)
    const ws = XLSX.utils.aoa_to_sheet(
      [
        ["Company", "Email"],
        ["Acme", "a@acme.de"],
      ],
      { dense: true },
    );
    ws["!ref"] = "A1:XFD60000";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const started = Date.now();
    const up = parseWorkbookBytes(wb, "xlsx");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(up.sheets).toEqual([{ name: "S", rows: 1 }]);
    expect(up.table.headers).toEqual(["Company", "Email"]);
    expect(up.table.rows.map((r) => r.cells)).toEqual([["Acme", "a@acme.de"]]);
  });

  it("refuses a sheet whose cells really reach column XFD, before padding any row", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Company"], ["Acme"]], { dense: true });
    (ws as unknown as { "!data": Array<Array<{ t: string; v: string }>> })["!data"][1]![16_383] = { t: "s", v: "x" };
    ws["!ref"] = "A1:XFD60000";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    expectFileError(() => parseWorkbookBytes(wb, "xlsx"), /16,384 columns; the limit is 500/);
  });

  it("refuses a sheet that really has more than 500 columns", () => {
    const row = Array.from({ length: 700 }, (_, i) => `H${i}`);
    const up = () => parseUploadedFile(workbook({ S: [row, row] }, "xlsx"), "wide.xlsx");
    expectFileError(up, /700 columns; the limit is 500/);
  });
});

describe("HTML tables saved as .xls (DATA-6)", () => {
  it("keeps every cell as typed: leading zeros, decimals, day-first dates", () => {
    const html = `<html><body><table>
      <tr><td>Company</td><td>Phone</td><td>Size</td><td>Code</td><td>Last contacted</td><td>Range</td></tr>
      <tr><td>Acme</td><td>0049301234</td><td>12.10</td><td>01234</td><td>03/04/2026</td><td>1-2</td></tr>
    </table></body></html>`;
    const up = parseUploadedFile(new TextEncoder().encode(html), "old-tool.xls");
    expect(up.kind).toBe("xls");
    expect(up.table.headers).toEqual(["Company", "Phone", "Size", "Code", "Last contacted", "Range"]);
    expect(up.table.rows[0]!.cells).toEqual(["Acme", "0049301234", "12.10", "01234", "03/04/2026", "1-2"]);
  });
});
