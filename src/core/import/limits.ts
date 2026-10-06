/**
 * Import limits and the plain-language messages about them (PLAN.md A6, B6.13, B10).
 * Browser-safe: the upload screen checks the size before sending anything.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
/** Columns that hold something (empty columns on the right don't count). */
export const MAX_IMPORT_COLUMNS = 500;
/** Rows × columns, so a small file can't make the server build a huge table (PLAN.md B10). */
export const MAX_IMPORT_CELLS = 6_000_000;
/** No spreadsheet has more columns than Excel's XFD (16,384): anything wider is refused before reading on. */
export const MAX_RAW_COLUMNS = 16_384;
export const MAX_EXPORT_COMPANIES = 50_000;

/** A file or pasted text the importer can't take, with a plain message saying what to do. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

/** File types the importer reads (magic bytes decide the parser; this only filters obvious mistakes). */
export const IMPORT_EXTENSIONS = ["csv", "txt", "tsv", "tab", "xlsx", "xlsm", "xls"] as const;
export const IMPORT_ACCEPT = ".csv,.txt,.tsv,.tab,.xlsx,.xlsm,.xls,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** "12 MB", "8.4 MB", "900 KB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  const rounded = Math.round(mb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}

/** "This file is 12 MB; the limit is 8 MB. Split it into two files." */
export function fileTooBigMessage(bytes: number, pasted = false): string {
  if (pasted) {
    return `These rows add up to ${formatFileSize(bytes)}; the limit is 8 MB. Paste fewer rows at a time, or save them as a file and split it in two.`;
  }
  return `This file is ${formatFileSize(bytes)}; the limit is 8 MB. Split it into two files.`;
}

export function tooManyRowsMessage(rows: number): string {
  return `This file has ${rows.toLocaleString("en-US")} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString("en-US")}. Split it into two files and import them one after the other.`;
}

export function tooManyColumnsMessage(columns: number): string {
  return `This file has ${columns.toLocaleString("en-US")} columns; the limit is ${MAX_IMPORT_COLUMNS.toLocaleString("en-US")}. Delete the columns you don't need (also empty ones far to the right) and try again.`;
}

export function tooManyCellsMessage(rows: number, columns: number): string {
  return `This file is too big to read in one go: ${rows.toLocaleString("en-US")} rows × ${columns.toLocaleString("en-US")} columns. Delete the columns you don't need, or split it into two files.`;
}

export function fileExtension(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/** A friendly refusal for files we can't read, or null when the extension is fine. */
export function unsupportedFileMessage(fileName: string): string | null {
  const ext = fileExtension(fileName);
  if (!ext) return null;
  if ((IMPORT_EXTENSIONS as readonly string[]).includes(ext)) return null;
  if (ext === "numbers") {
    return "This is an Apple Numbers file. In Numbers choose File › Export To › Excel or CSV, then import that file.";
  }
  if (ext === "ods") {
    return "This is an OpenOffice/LibreOffice file. Choose File › Save As, pick Excel (.xlsx) or CSV, then import that file.";
  }
  if (ext === "doc" || ext === "docx" || ext === "pdf") {
    return "This looks like a document, not a spreadsheet. Put the rows in Excel or Google Sheets and save them as .xlsx or .csv.";
  }
  return "Only CSV, TXT, XLSX and XLS files can be imported. In Excel choose File › Save As and pick one of those.";
}
