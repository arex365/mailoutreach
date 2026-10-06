import { stripFormulaEscape } from "../csv";
import { ImportFileError, MAX_IMPORT_CELLS, MAX_IMPORT_COLUMNS, tooManyCellsMessage, tooManyColumnsMessage } from "./limits";

/**
 * Turning raw spreadsheet/CSV values into the plain strings we store in ImportRow.data.
 * Pure, browser-safe.
 */

const MAX_CELL_CHARS = 10_000;

/** Numbers as people typed them: never "1.2e+21", no float noise like 0.30000000000000004. */
export function formatNumberCell(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
}

/** Spreadsheet dates → "2026-03-04" (date only) or "2026-03-04T14:30" (with a time). UTC-based. */
export function formatDateCell(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const pad = (v: number) => String(v).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h === 0 && m === 0 && d.getUTCSeconds() === 0) return date;
  return `${date}T${pad(h)}:${pad(m)}`;
}

/** Any cell value → trimmed string, formula escape removed, line endings normalised. */
export function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = formatDateCell(value);
  else if (typeof value === "number") s = formatNumberCell(value);
  else if (typeof value === "boolean") s = value ? "TRUE" : "FALSE";
  else s = String(value);
  s = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  s = stripFormulaEscape(s).trim();
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s;
}

/** Header texts (already cleaned cells): one line, never empty ("Column 3"), unique ("Email", "Email (2)"). */
export function cleanHeaders(raw: ReadonlyArray<string | undefined>, width: number): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let h = (raw[i] ?? "").replace(/\s+/g, " ").trim();
    if (!h) h = `Column ${i + 1}`;
    if (h.length > 120) h = h.slice(0, 120).trim();
    const key = h.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push(n === 1 ? h : `${h} (${n})`);
  }
  return out;
}

function filledCount(cells: ReadonlyArray<string>): number {
  let n = 0;
  for (const c of cells) if (c !== "") n++;
  return n;
}

/**
 * Index of the header row among the first (already cleaned) records: skips a title line
 * such as "German 3D Companies" above the real header. The header is the first record that
 * has at least half as many filled cells as the fullest of the first 10 records (min. 2).
 */
export function findHeaderIndex(records: ReadonlyArray<ReadonlyArray<string>>): number {
  const firstNonBlank = records.findIndex((r) => filledCount(r) > 0);
  if (firstNonBlank < 0) return -1;
  const window = records.slice(firstNonBlank, firstNonBlank + 10);
  const max = Math.max(...window.map(filledCount));
  const need = Math.max(Math.min(2, max), Math.ceil(max / 2));
  const idx = window.findIndex((r) => filledCount(r) >= need);
  return firstNonBlank + (idx < 0 ? 0 : idx);
}

export type TableRow = { rowNumber: number; cells: string[] };
export type Table = { headers: string[]; rows: TableRow[] };

/**
 * Records (each with the row number the user sees in Excel) → header + data rows.
 * Every cell is cleaned once; blank rows between data rows are kept (they count as "empty
 * rows"), trailing blank rows are dropped; every data row has exactly
 * headers.length cells. Throws ImportFileError when the table would be wider than
 * MAX_IMPORT_COLUMNS or bigger than MAX_IMPORT_CELLS (checked BEFORE padding the rows).
 */
export function buildTable(records: ReadonlyArray<{ rowNumber: number; cells: ReadonlyArray<unknown> }>): Table {
  const cleaned = records.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.map(cleanCell) }));
  const headerIdx = findHeaderIndex(cleaned.map((r) => r.cells));
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headerCells = cleaned[headerIdx]!.cells;
  // Blank rows BETWEEN data rows are kept so the result can count them as "empty rows" (SPEC §4);
  // blank rows after the last real row (Excel and CSV files often end with some) are dropped.
  const afterHeader = cleaned.slice(headerIdx + 1);
  let lastFilled = afterHeader.length - 1;
  while (lastFilled >= 0 && filledCount(afterHeader[lastFilled]!.cells) === 0) lastFilled--;
  const dataRecords = afterHeader.slice(0, lastFilled + 1);
  // Width = the last column that has a header or any data (trailing empty cells don't count).
  let width = 0;
  for (const cells of [headerCells, ...dataRecords.map((r) => r.cells)]) {
    let last = cells.length - 1;
    while (last >= width && cells[last] === "") last--;
    width = Math.max(width, last + 1);
  }
  if (width > MAX_IMPORT_COLUMNS) throw new ImportFileError(tooManyColumnsMessage(width));
  if (width * (dataRecords.length + 1) > MAX_IMPORT_CELLS) {
    throw new ImportFileError(tooManyCellsMessage(dataRecords.length, width));
  }
  const headers = cleanHeaders(headerCells, width);
  const rows = dataRecords.map((r) => ({
    rowNumber: r.rowNumber,
    cells: Array.from({ length: width }, (_, i) => r.cells[i] ?? ""),
  }));
  return { headers, rows };
}
