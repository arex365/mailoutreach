import * as XLSX from "xlsx";
import type { Prisma } from "@/generated/prisma/client";
import { toCsv, type CsvDelimiter } from "@/core/csv";
import { countryName } from "@/core/geo/display";
import { MAX_EXPORT_COMPANIES } from "@/core/import/limits";
import { COMPANY_STATUS_LABELS, PRIORITY_LABELS, VERIFICATION_LABELS } from "@/core/labels";
import { db } from "@/server/db";
import { buildCompanyOrderBy, buildCompanyWhere, lastContactAt, type CompanyFilters } from "@/server/services/companies/filters";

/**
 * CSV / Excel export of any Contacts view or a selection (SPEC §4, PLAN.md A5.18, B6.13).
 * One row per person; a company without people gets one row. Read-only: logs nothing.
 * CSV goes through the one writer in core/csv (BOM, CRLF, formula escaping); .xlsx is
 * written by SheetJS (text cells stay text, so nothing is ever run as a formula).
 * "last_emailed" is what the Contacts column shows: the newer of this app's last email and
 * the old tool's last-contacted date ("emailed_by" then says "Old tool").
 */

export const EXPORT_COLUMNS = [
  "company_id",
  "company",
  "website",
  "instagram",
  "country",
  "niche",
  "priority",
  "status",
  "tags",
  "lists",
  "last_emailed",
  "emailed_by",
  "person_name",
  "email",
  "role",
  "verification",
  "unsubscribed",
  "notes",
  "personal_line",
] as const;

export type ExportFormat = "csv" | "xlsx";

export type ExportRequest = {
  /** Either the Contacts filters … */
  filters?: CompanyFilters;
  /** … or the ticked companies. */
  ids?: number[];
  format: ExportFormat;
  delimiter?: CsvDelimiter;
  /** The viewer's time zone, for dates and the file name. */
  timeZone: string;
  now?: Date;
};

export type ExportFile = { fileName: string; contentType: string; body: string | Uint8Array; rows: number; companies: number };

export class ExportTooBigError extends Error {
  constructor(readonly count: number) {
    super(
      `This view has ${count.toLocaleString("en-US")} companies; exports are limited to ${MAX_EXPORT_COMPANIES.toLocaleString("en-US")}. Add a filter (for example a list or a country) and export again.`,
    );
    this.name = "ExportTooBigError";
  }
}

const PAGE = 1000;
const XLSX_MAX_CELL = 32_767;

const exportSelect = {
  id: true,
  name: true,
  website: true,
  country: true,
  niche: true,
  priority: true,
  status: true,
  notes: true,
  personalLine: true,
  customFields: true,
  instagram: true,
  lastEmailedAt: true,
  importedLastContactAt: true,
  lastEmailedBy: { select: { name: true } },
  tags: { select: { tag: { select: { name: true } } } },
  lists: { select: { list: { select: { name: true } } } },
  people: {
    where: { deletedAt: null },
    orderBy: [{ isGeneric: "asc" }, { id: "asc" }],
    select: {
      name: true,
      email: true,
      role: true,
      verificationStatus: true,
      unsubscribedAt: true,
      personalLineOverride: true,
    },
  },
} satisfies Prisma.CompanySelect;

/** "2026-09-23" in the viewer's time zone. */
export function isoDay(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function customObject(json: Prisma.JsonValue | null): Record<string, string> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/** The profile link for a stored Instagram handle. */
export function instagramUrl(handle: string | null): string {
  return handle ? `https://www.instagram.com/${handle}/` : "";
}

export function parseExportIds(raw: string | null): number[] | null {
  if (raw === null) return null;
  const ids = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/** The export as a header + rows table (all strings). */
export async function buildCompanyExportTable(req: Pick<ExportRequest, "filters" | "ids" | "timeZone">): Promise<{
  columns: string[];
  rows: string[][];
  companies: number;
}> {
  const where: Prisma.CompanyWhereInput = req.ids
    ? { AND: [{ deletedAt: null }, { id: { in: req.ids.slice(0, MAX_EXPORT_COMPANIES + 1) } }] }
    : buildCompanyWhere(req.filters ?? {});
  const orderBy = req.ids || !req.filters ? [{ nameNorm: "asc" as const }, { id: "asc" as const }] : buildCompanyOrderBy(req.filters);
  const count = await db.company.count({ where });
  if (count > MAX_EXPORT_COMPANIES) throw new ExportTooBigError(count);

  const fields = await db.customField.findMany({ where: { entity: "COMPANY" }, orderBy: { id: "asc" }, select: { key: true } });
  const customKeys: string[] = fields.map((f) => f.key);
  const knownKeys = new Set(customKeys);

  const companies: Array<Prisma.CompanyGetPayload<{ select: typeof exportSelect }>> = [];
  for (let skip = 0; skip < count; skip += PAGE) {
    const page = await db.company.findMany({ where, orderBy, skip, take: PAGE, select: exportSelect });
    companies.push(...page);
    if (page.length < PAGE) break;
  }
  for (const c of companies) {
    for (const k of Object.keys(customObject(c.customFields))) {
      if (!knownKeys.has(k)) {
        knownKeys.add(k);
        customKeys.push(k);
      }
    }
  }

  const rows: string[][] = [];
  for (const c of companies) {
    const custom = customObject(c.customFields);
    const lastContact = lastContactAt(c.lastEmailedAt, c.importedLastContactAt);
    const fromApp = Boolean(lastContact && c.lastEmailedAt && lastContact.getTime() === c.lastEmailedAt.getTime());
    const company = [
      `C-${c.id}`,
      c.name,
      c.website ?? "",
      instagramUrl(c.instagram),
      c.country ? countryName(c.country) : "",
      c.niche ?? "",
      PRIORITY_LABELS[c.priority],
      COMPANY_STATUS_LABELS[c.status],
      c.tags.map((t) => t.tag.name).sort((a, b) => a.localeCompare(b)).join("; "),
      c.lists.map((l) => l.list.name).sort((a, b) => a.localeCompare(b)).join("; "),
      lastContact ? isoDay(lastContact, req.timeZone) : "",
      lastContact ? (fromApp ? (c.lastEmailedBy?.name ?? "") : "Old tool") : "",
    ];
    const tail = (personalLine: string) => [c.notes, personalLine, ...customKeys.map((k) => custom[k] ?? "")];
    if (c.people.length === 0) {
      rows.push([...company, "", "", "", "", "", ...tail(c.personalLine ?? "")]);
      continue;
    }
    for (const p of c.people) {
      rows.push([
        ...company,
        p.name,
        p.email ?? "",
        p.role ?? "",
        p.verificationStatus ? (VERIFICATION_LABELS[p.verificationStatus] ?? p.verificationStatus) : "",
        p.unsubscribedAt ? "Yes" : "",
        ...tail(p.personalLineOverride ?? c.personalLine ?? ""),
      ]);
    }
  }
  return { columns: [...EXPORT_COLUMNS, ...customKeys], rows, companies: companies.length };
}

export function xlsxBuffer(columns: string[], rows: string[][], sheetName = "Contacts"): Uint8Array {
  const clip = (v: string) => (v.length > XLSX_MAX_CELL ? v.slice(0, XLSX_MAX_CELL) : v);
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows.map((r) => r.map(clip))]);
  ws["!cols"] = columns.map((h, i) => {
    let width = h.length;
    for (let r = 0; r < Math.min(rows.length, 200); r++) width = Math.max(width, (rows[r]![i] ?? "").length);
    return { wch: Math.min(Math.max(width + 2, 10), 50) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
  return Uint8Array.from(buf);
}

/** Builds the file for GET /api/export/companies. Throws ExportTooBigError over 50,000 companies. */
export async function exportCompanies(req: ExportRequest): Promise<ExportFile> {
  const { columns, rows, companies } = await buildCompanyExportTable(req);
  const day = isoDay(req.now ?? new Date(), req.timeZone);
  if (req.format === "xlsx") {
    return {
      fileName: `contacts-${day}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: xlsxBuffer(columns, rows),
      rows: rows.length,
      companies,
    };
  }
  return {
    fileName: `contacts-${day}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: toCsv(rows, columns, { delimiter: req.delimiter ?? "," }),
    rows: rows.length,
    companies,
  };
}

/**
 * "Export for Claude" on the Missing email view (PLAN.md B6.13): the companies without an email
 * address, with a stable company_id plus empty columns for Claude to fill in. The dialog around the
 * download hands over the instruction (`CLAUDE_MISSING_EMAILS_INSTRUCTION`), and importing Claude's CSV
 * reads company_id back: a round-trip import only adds people to these companies (M5-DESIGN §4.2,
 * `analyzeRoundTrip`).
 */
export const MISSING_EMAIL_COLUMNS = [
  "company_id",
  "company",
  "website",
  "country",
  "email",
  "contact_name",
  "role",
  "source_url",
  "note",
] as const;

/** Builds the file for GET /api/export/missing-emails. Always limited to companies without an email. */
export async function exportMissingEmails(
  req: Omit<ExportRequest, "ids" | "filters"> & { filters: CompanyFilters },
): Promise<ExportFile> {
  const filters: CompanyFilters = { ...req.filters, view: "missing-email" };
  const where = buildCompanyWhere(filters);
  const orderBy = buildCompanyOrderBy(filters);
  const count = await db.company.count({ where });
  if (count > MAX_EXPORT_COMPANIES) throw new ExportTooBigError(count);

  const rows: string[][] = [];
  for (let skip = 0; skip < count; skip += PAGE) {
    const page = await db.company.findMany({
      where,
      orderBy,
      skip,
      take: PAGE,
      select: { id: true, name: true, website: true, instagram: true, country: true },
    });
    for (const c of page) {
      const site = c.website ?? instagramUrl(c.instagram);
      rows.push([`C-${c.id}`, c.name, site, c.country ? countryName(c.country) : "", "", "", "", "", ""]);
    }
    if (page.length < PAGE) break;
  }

  const columns = [...MISSING_EMAIL_COLUMNS];
  const day = isoDay(req.now ?? new Date(), req.timeZone);
  if (req.format === "xlsx") {
    return {
      fileName: `missing-emails-${day}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: xlsxBuffer(columns, rows, "Missing emails"),
      rows: rows.length,
      companies: rows.length,
    };
  }
  return {
    fileName: `missing-emails-${day}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: toCsv(rows, columns, { delimiter: req.delimiter ?? "," }),
    rows: rows.length,
    companies: rows.length,
  };
}

/** Content-Disposition for a download, with a plain-ASCII fallback name. */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
