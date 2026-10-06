import type { Prisma } from "@/generated/prisma/client";
import { suggestMapping, type ColumnMapping } from "@/core/import/column-matching";
import {
  DEFAULT_IMPORT_OPTIONS,
  LIST_NAME_MAX,
  readImportOptions,
  readMapping,
  readResultSummary,
  type ImportOptions,
  type ImportSessionView,
  type ImportStatusValue,
} from "@/core/import/types";
import { db, dbWrite } from "@/server/db";
import type { ParsedUpload } from "./parse-file";

/**
 * ImportSession / ImportRow storage. Rows go into ImportRow first (PLAN.md B6.13) so the
 * check and the worker's commit read the same data, and a stopped import can resume.
 */

const ROW_INSERT_CHUNK = 1000;
const SAMPLE_ROWS = 10;
/** Unfinished imports are cleaned up after this many days. */
const ABANDONED_AFTER_DAYS = 14;

export function companyCode(id: number): string {
  return `C-${id}`;
}

/** Stores a parsed upload. Returns the new session id. */
export async function createImportSession(input: { userId: number; fileName: string; parsed: ParsedUpload }): Promise<number> {
  const { parsed } = input;
  const session = await dbWrite((c) =>
    c.importSession.create({
      data: {
        createdById: input.userId,
        fileName: input.fileName.slice(0, 200),
        kind: parsed.kind,
        ...(parsed.sheetNames.length ? { sheetNames: parsed.sheetNames } : {}),
        sheet: parsed.sheet,
        headers: parsed.table.headers,
        rowCount: parsed.table.rows.length,
        status: "UPLOADED",
      },
      select: { id: true },
    }),
  );
  try {
    const rows = parsed.table.rows;
    for (let i = 0; i < rows.length; i += ROW_INSERT_CHUNK) {
      const chunk = rows.slice(i, i + ROW_INSERT_CHUNK);
      await dbWrite((c) =>
        c.importRow.createMany({
          data: chunk.map((r) => ({ sessionId: session.id, rowNumber: r.rowNumber, data: r.cells })),
        }),
      );
    }
  } catch (err) {
    await dbWrite((c) => c.importSession.delete({ where: { id: session.id } })).catch(() => undefined);
    throw err;
  }
  return session.id;
}

/** Deletes an import that hasn't started (its rows go with it). Returns false when it can't. */
export async function discardImportSession(id: number): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.importSession.deleteMany({ where: { id, status: { in: ["UPLOADED", "MAPPED", "FAILED"] } } }),
  );
  return res.count === 1;
}

/** Removes imports that were started but never finished, after two weeks. Best-effort. */
export async function cleanUpAbandonedImports(now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - ABANDONED_AFTER_DAYS * 86_400_000);
  await dbWrite((c) =>
    c.importSession.deleteMany({ where: { status: { in: ["UPLOADED", "MAPPED"] }, createdAt: { lt: before } } }),
  ).catch(() => undefined);
}

function stringArray(json: Prisma.JsonValue | null): string[] {
  return Array.isArray(json) ? json.map((v) => String(v ?? "")) : [];
}

export function defaultOptionsFor(session: { fileName: string; kind: string; sheet: string | null; sheetNames: string[] }): ImportOptions {
  if (session.kind === "paste") return { ...DEFAULT_IMPORT_OPTIONS };
  const base =
    session.sheet && session.sheetNames.length > 1
      ? session.sheet
      : session.fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ");
  const name = base.replace(/\s+/g, " ").trim().slice(0, LIST_NAME_MAX);
  return { ...DEFAULT_IMPORT_OPTIONS, list: name ? { mode: "new", name } : { mode: "none" } };
}

export type StoredSession = {
  id: number;
  fileName: string;
  kind: string;
  status: ImportStatusValue;
  headers: string[];
  sheet: string | null;
  sheetNames: string[];
  mapping: ColumnMapping[] | null;
  options: ImportOptions;
  jobId: number | null;
  createdById: number;
  rowCount: number;
};

export async function loadStoredSession(id: number): Promise<StoredSession | null> {
  const s = await db.importSession.findUnique({ where: { id } });
  if (!s) return null;
  const headers = stringArray(s.headers);
  const sheetNames = stringArray(s.sheetNames);
  const base = { fileName: s.fileName, kind: s.kind, sheet: s.sheet, sheetNames };
  return {
    id: s.id,
    fileName: s.fileName,
    kind: s.kind,
    status: s.status,
    headers,
    sheet: s.sheet,
    sheetNames,
    mapping: readMapping(s.mapping, headers.length),
    options: s.options ? readImportOptions(s.options) : defaultOptionsFor(base),
    jobId: s.jobId,
    createdById: s.createdById,
    rowCount: s.rowCount,
  };
}

/** Everything the import screens need for one session. */
export async function getImportSessionView(id: number): Promise<ImportSessionView | null> {
  const s = await db.importSession.findUnique({
    where: { id },
    include: { createdBy: { select: { name: true } } },
  });
  if (!s) return null;
  const headers = stringArray(s.headers);
  const sheetNames = stringArray(s.sheetNames);
  const sample = await db.importRow.findMany({
    where: { sessionId: id },
    orderBy: { rowNumber: "asc" },
    take: 50,
    select: { data: true },
  });
  const sampleRows = sample.map((r) => stringArray(r.data));
  const suggestion = suggestMapping(headers, sampleRows);
  const saved = readMapping(s.mapping, headers.length);
  return {
    id: s.id,
    fileName: s.fileName,
    kind: s.kind,
    sheet: s.sheet,
    sheetNames,
    headers,
    rowCount: s.rowCount,
    sampleRows: sampleRows.slice(0, SAMPLE_ROWS),
    mapping: saved ?? suggestion.map((x) => x.mapping),
    suggestedMapping: suggestion.map((x) => x.mapping),
    confidence: suggestion.map((x) => x.confidence),
    options: s.options
      ? readImportOptions(s.options)
      : defaultOptionsFor({ fileName: s.fileName, kind: s.kind, sheet: s.sheet, sheetNames }),
    status: s.status,
    jobId: s.jobId,
    summary: readResultSummary(s.summary),
    createdByName: s.createdBy.name,
    createdAt: s.createdAt.toISOString(),
  };
}

export type RecentImport = {
  id: number;
  fileName: string;
  kind: string;
  status: ImportStatusValue;
  rowCount: number;
  createdAt: Date;
  createdByName: string;
  summary: ReturnType<typeof readResultSummary>;
};

export async function listRecentImports(limit = 10): Promise<RecentImport[]> {
  const rows = await db.importSession.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { createdBy: { select: { name: true } } },
  });
  return rows.map((s) => ({
    id: s.id,
    fileName: s.fileName,
    kind: s.kind,
    status: s.status,
    rowCount: s.rowCount,
    createdAt: s.createdAt,
    createdByName: s.createdBy.name,
    summary: readResultSummary(s.summary),
  }));
}

/** Loads every stored row of a session, in file order. */
export async function loadImportRows(
  sessionId: number,
): Promise<Array<{ id: number; rowNumber: number; cells: string[]; status: string; companyId: number | null }>> {
  const rows = await db.importRow.findMany({
    where: { sessionId },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true, data: true, status: true, companyId: true },
  });
  return rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, cells: stringArray(r.data), status: r.status, companyId: r.companyId }));
}
