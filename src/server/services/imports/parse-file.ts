import Papa from "papaparse";
import * as XLSX from "xlsx";
import * as cpexcel from "xlsx/dist/cpexcel.full.mjs";
import { buildTable, type Table } from "@/core/import/cells";
import {
  ImportFileError,
  MAX_IMPORT_CELLS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_RAW_COLUMNS,
  tooManyCellsMessage,
  tooManyColumnsMessage,
  tooManyRowsMessage,
  unsupportedFileMessage,
} from "@/core/import/limits";

/**
 * Reading uploaded files and pasted rows into a header + rows table (PLAN.md B6.13).
 *  - The type is detected from magic bytes: "PK" → xlsx, D0 CF 11 E0 → legacy xls, else text.
 *  - Spreadsheets: SheetJS with real dates, raw numbers and a sheet picker.
 *  - HTML tables saved as .xls: every cell stays the text the person typed (no type guessing).
 *  - Text: UTF-8 (strict), falling back to windows-1252; UTF-16 when it has a BOM (Excel's
 *    "Unicode text"); papaparse with an auto-detected delimiter (tab when pasted rows contain tabs).
 *  - Limits (rows, columns, cells) are checked before any big table is built.
 * No database access here.
 */

// Legacy .xls files store text in code pages (e.g. 1252 for umlauts): SheetJS needs the tables.
XLSX.set_cptable(cpexcel);

export { ImportFileError };

export type UploadKind = "xlsx" | "xls" | "csv" | "paste";
export type SheetInfo = { name: string; rows: number };
export type ParsedUpload = {
  kind: UploadKind;
  sheetNames: string[];
  sheet: string | null;
  sheets: SheetInfo[];
  table: Table;
};

export function detectKind(bytes: Uint8Array): "xlsx" | "xls" | "text" {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx";
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "xls";
  return "text";
}

/** Bytes → text: UTF-16 with BOM, else strict UTF-8, else windows-1252 (old Excel CSV exports). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

function finish(table: Table, what: "file" | "paste"): Table {
  if (table.headers.length === 0) {
    throw new ImportFileError(
      what === "paste"
        ? "We couldn't find any rows. Copy the rows in Excel or Google Sheets, including the header row, and paste them again."
        : "We couldn't find any rows in this file. Check that the first row has the column names and the companies are below it.",
    );
  }
  if (table.rows.length === 0) {
    throw new ImportFileError(
      what === "paste"
        ? "Only the header row came through. Copy the header row and the rows below it, then paste again."
        : "This file only has a header row. Add the companies below it and try again.",
    );
  }
  if (table.rows.length > MAX_IMPORT_ROWS) throw new ImportFileError(tooManyRowsMessage(table.rows.length));
  return table;
}

// ───────────────────────── text ─────────────────────────

/** Parses CSV/TSV text. Row numbers are the record numbers Excel shows (header = row 1). */
export function parseDelimitedText(text: string, opts: { pasted?: boolean } = {}): Table {
  let body = text.replace(/^﻿/, "");
  let delimiter = "";
  let offset = 0;
  // Excel's "sep=;" hint line.
  const sep = /^sep=(.)\r?\n/i.exec(body);
  if (sep) {
    delimiter = sep[1]!;
    body = body.slice(sep[0].length);
    offset = 1;
  }
  if (!delimiter && opts.pasted && body.includes("\t")) delimiter = "\t";
  if (body.includes("\u0000")) {
    throw new ImportFileError(
      "This file isn't a spreadsheet or CSV file we can read. Save it from Excel as .xlsx or .csv and try again.",
    );
  }
  if (!delimiter) {
    // Guess on a preview without blank lines (they'd spoil the guess for narrow files), then
    // parse everything with blank lines kept, so row numbers match what Excel shows.
    const guess = Papa.parse<string[]>(body, {
      delimitersToGuess: [",", ";", "\t", "|"],
      skipEmptyLines: "greedy",
      preview: 50,
    });
    delimiter = guess.meta.delimiter || ",";
  }
  const result = Papa.parse<string[]>(body, { delimiter, skipEmptyLines: false });
  const records = result.data.map((cells, i) => ({ rowNumber: i + 1 + offset, cells: Array.isArray(cells) ? cells : [] }));
  if (records.length > MAX_IMPORT_ROWS * 2 + 1000) throw new ImportFileError(tooManyRowsMessage(records.length - 1));
  // No real spreadsheet is wider than Excel's last column; buildTable checks the used width.
  for (const r of records) {
    if (r.cells.length > MAX_RAW_COLUMNS) throw new ImportFileError(tooManyColumnsMessage(r.cells.length));
  }
  return buildTable(records);
}

// ───────────────────────── spreadsheets ─────────────────────────

type DenseCell = { v?: unknown; t?: string } | null | undefined;

function filled(c: DenseCell): boolean {
  return Boolean(c) && c!.v !== undefined && c!.v !== null && c!.v !== "";
}

/**
 * The used range of a sheet, cut down to the last row and the last column that really have a
 * value. The sheet's own dimension (its "!ref") comes from the file and can claim 16,384 columns;
 * only cells that exist count.
 */
function usedRange(ws: XLSX.WorkSheet): XLSX.Range | null {
  const ref = ws["!ref"];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const data = (ws as { "!data"?: DenseCell[][] })["!data"];
  if (Array.isArray(data)) {
    let lastRow = -1;
    let lastCol = -1;
    const endRow = Math.min(range.e.r, data.length - 1);
    for (let r = range.s.r; r <= endRow; r++) {
      const row = data[r];
      if (!row) continue;
      for (let c = Math.min(range.e.c, row.length - 1); c >= range.s.c; c--) {
        if (filled(row[c])) {
          lastRow = r;
          if (c > lastCol) lastCol = c;
          break;
        }
      }
    }
    if (lastRow < 0) return null;
    range.e.r = lastRow;
    range.e.c = lastCol;
  }
  return range;
}

function readWorkbook(input: Buffer | string, type: "buffer" | "string"): XLSX.WorkBook {
  try {
    // An HTML table (type "string") is text the person typed: `raw` stops SheetJS from turning
    // "0049301234" into a number or "3/4" into a US date in the PC's time zone.
    return type === "string"
      ? XLSX.read(input, { type, raw: true, dense: true })
      : XLSX.read(input, { type, cellDates: true, dense: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(msg)) {
      throw new ImportFileError(
        "This file is protected with a password. Open it in Excel, remove the password (File › Info › Protect Workbook), save and try again.",
      );
    }
    throw new ImportFileError(
      "We couldn't read this spreadsheet. Open it in Excel, choose File › Save As, pick Excel Workbook (.xlsx) and try again.",
    );
  }
}

function worksheetNames(wb: XLSX.WorkBook): string[] {
  return wb.SheetNames.filter((name) => {
    const ws = wb.Sheets[name];
    return ws && (ws as { "!type"?: string })["!type"] !== "chart";
  });
}

export function listSheets(wb: XLSX.WorkBook): SheetInfo[] {
  return worksheetNames(wb).map((name) => {
    const range = usedRange(wb.Sheets[name]!);
    return { name, rows: range ? Math.max(0, range.e.r - range.s.r) : 0 };
  });
}

function sheetTable(ws: XLSX.WorkSheet): Table {
  const range = usedRange(ws);
  if (!range) return { headers: [], rows: [] };
  const height = range.e.r - range.s.r + 1;
  const width = range.e.c - range.s.c + 1;
  if (height - 1 > MAX_IMPORT_ROWS * 2 + 1000) throw new ImportFileError(tooManyRowsMessage(height - 1));
  // Checked before sheet_to_json, which would pad every row to the full width.
  if (width > MAX_IMPORT_COLUMNS) throw new ImportFileError(tooManyColumnsMessage(width));
  if (width * height > MAX_IMPORT_CELLS) throw new ImportFileError(tooManyCellsMessage(height - 1, width));
  const records = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
    UTC: true,
    range: XLSX.utils.encode_range(range),
  });
  return buildTable(records.map((cells, i) => ({ rowNumber: range.s.r + i + 1, cells: Array.isArray(cells) ? cells : [] })));
}

export function parseWorkbookBytes(wb: XLSX.WorkBook, kind: "xlsx" | "xls", sheet?: string | null): ParsedUpload {
  const sheets = listSheets(wb);
  if (sheets.length === 0) throw new ImportFileError("This workbook has no sheets with rows in it.");
  const chosen =
    (sheet ? sheets.find((s) => s.name === sheet) : undefined) ?? sheets.find((s) => s.rows > 0) ?? sheets[0]!;
  const table = finish(sheetTable(wb.Sheets[chosen.name]!), "file");
  return { kind, sheetNames: sheets.map((s) => s.name), sheet: chosen.name, sheets, table };
}

// ───────────────────────── entry points ─────────────────────────

/** An uploaded file (bytes) → table. Throws ImportFileError with a plain message. */
export function parseUploadedFile(bytes: Uint8Array, fileName: string, sheet?: string | null): ParsedUpload {
  const unsupported = unsupportedFileMessage(fileName);
  if (unsupported) throw new ImportFileError(unsupported);
  if (bytes.length === 0) throw new ImportFileError("This file is empty. Check you picked the right file.");
  // The content decides the parser, whatever the file is called.
  const kind = detectKind(bytes);
  if (kind === "xlsx" || kind === "xls") {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return parseWorkbookBytes(readWorkbook(buf, "buffer"), kind, sheet);
  }
  const text = decodeText(bytes);
  // Some tools save an HTML table with an .xls name.
  if (/^\s*</.test(text) && /<table/i.test(text.slice(0, 50_000))) {
    return parseWorkbookBytes(readWorkbook(text, "string"), "xls", sheet);
  }
  const table = finish(parseDelimitedText(text), "file");
  return { kind: "csv", sheetNames: [], sheet: null, sheets: [], table };
}

/** Rows pasted from Excel or Google Sheets (tab-separated) or any CSV text. */
export function parsePastedText(text: string): ParsedUpload {
  const table = finish(parseDelimitedText(text, { pasted: true }), "paste");
  return { kind: "paste", sheetNames: [], sheet: null, sheets: [], table };
}
