import { toCsv } from "@/core/csv";
import { normalizeText } from "@/core/text";
import { db } from "@/server/db";

/**
 * "Download problem rows" on the import result: every row that wasn't imported cleanly
 * (invalid email, belongs to another company, nothing to import …) or carries a note,
 * with the reason first and then the row exactly as it was in the file, so it can be fixed
 * and imported again. Empty rows are left out.
 */

/** "Kunden Müller.xlsx" → "kunden-muller". */
export function fileNameBase(fileName: string): string {
  const base = normalizeText(fileName.replace(/\.[a-z0-9]+$/i, ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "import";
}

export async function buildProblemRowsCsv(sessionId: number): Promise<{ fileName: string; csv: string; count: number } | null> {
  const session = await db.importSession.findUnique({
    where: { id: sessionId },
    select: { id: true, fileName: true, kind: true, headers: true },
  });
  if (!session) return null;
  const headers = Array.isArray(session.headers) ? session.headers.map((h) => String(h ?? "")) : [];
  const rows = await db.importRow.findMany({
    where: {
      sessionId,
      OR: [{ status: { in: ["INVALID", "PROBLEM"] } }, { AND: [{ message: { not: null } }, { status: { not: "EMPTY" } }] }],
    },
    orderBy: { rowNumber: "asc" },
    select: { rowNumber: true, data: true, message: true },
  });
  const csvRows = rows.map((r) => {
    const cells = Array.isArray(r.data) ? r.data.map((c) => String(c ?? "")) : [];
    return [r.rowNumber, r.message ?? "", ...headers.map((_, i) => cells[i] ?? "")];
  });
  const base = session.kind === "paste" ? "pasted-rows" : fileNameBase(session.fileName);
  return {
    fileName: `problem-rows-${base}.csv`,
    csv: toCsv(csvRows, ["row", "problem", ...headers]),
    count: rows.length,
  };
}
