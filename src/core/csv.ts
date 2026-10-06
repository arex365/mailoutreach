import Papa from "papaparse";

/**
 * The ONE CSV writer (PLAN.md B6.13, B10): every CSV the app produces — views, selections,
 * missing emails, problem rows — goes through toCsv().
 *  - UTF-8 with a BOM, so Excel (German/Norwegian too) reads umlauts and "ø" correctly.
 *  - CRLF line endings.
 *  - Formula escaping: a text cell starting with = + - @ tab or CR gets a leading apostrophe,
 *    so Excel shows it as text instead of running it. The importer removes that apostrophe
 *    again (stripFormulaEscape), so values like "+49 30 123" survive export → import.
 * Pure: safe in the browser, the server and the worker.
 */

export const CSV_BOM = "﻿";

export type CsvDelimiter = "," | ";";

export type CsvCell = string | number | boolean | Date | null | undefined;

/**
 * Cells that get an apostrophe on export. Papa's own pattern (/^[=+\-@\t\r].*$/) doesn't
 * match text with a line break after the first line, so a multi-line "=cmd…" would slip
 * through; ours only looks at the start. Values that already start with apostrophes before
 * a formula character get one more, so the importer's "remove one apostrophe" gives back
 * exactly what was exported.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/;

function cellText(value: CsvCell): string | number {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return value;
}

/**
 * Builds a CSV file (as a string, BOM included) from a header row and data rows.
 * Numbers stay numbers (a negative number isn't escaped); every string is formula-escaped.
 */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<CsvCell>>,
  columns: ReadonlyArray<string>,
  opts: { delimiter?: CsvDelimiter } = {},
): string {
  const body = Papa.unparse(
    {
      fields: [...columns],
      data: rows.map((r) => columns.map((_, i) => cellText(r[i]))),
    },
    {
      delimiter: opts.delimiter ?? ",",
      newline: "\r\n",
      escapeFormulae: FORMULA_START,
      header: true,
    },
  );
  return CSV_BOM + body + "\r\n";
}

/**
 * Undoes the export's formula escape: removes ONE leading apostrophe when it is followed by
 * = + - @ tab or CR (possibly after more apostrophes). Applied to every imported cell.
 */
export function stripFormulaEscape(value: string): string {
  return value.length > 1 && value.charCodeAt(0) === 39 /* ' */ && FORMULA_START.test(value.slice(1))
    ? value.slice(1)
    : value;
}
