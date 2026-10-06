import type { NextRequest } from "next/server";
import { getUserOrNull } from "@/lib/auth/dal";
import { companyFiltersToParams, parseCompanyFilters } from "@/server/services/companies/filters";
import { attachmentHeader, exportCompanies, ExportTooBigError, parseExportIds } from "@/server/services/export";
import { downloadErrorPage, signInRedirect } from "../_lib/download-response";

/**
 * GET /api/export/companies — CSV or Excel of a Contacts view or of the ticked companies.
 *   ?format=csv|xlsx (default csv) · ?delimiter=semicolon (CSV for German/Norwegian Excel)
 *   ?ids=1,2,3 for a selection, otherwise the Contacts filters (companyFiltersToParams).
 * Read-only: nothing is logged or changed. It's opened as a plain link, so problems come back
 * as a page with a way back to the same Contacts view (signed out → the sign-in page).
 */

export const runtime = "nodejs";

/** The Contacts view this export was made from. */
function contactsUrl(sp: URLSearchParams, selection: boolean): string {
  if (selection) return "/contacts";
  const p = companyFiltersToParams({ ...parseCompanyFilters(sp), page: 1 });
  const s = p.toString();
  return s ? `/contacts?${s}` : "/contacts";
}

function problem(message: string, status: number, back: string) {
  return downloadErrorPage({ title: "The export didn't work", message, status, back: { href: back, label: "Back to Contacts" } });
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const ids = parseExportIds(sp.get("ids"));
  const back = contactsUrl(sp, ids !== null);
  const user = await getUserOrNull();
  if (!user) return signInRedirect(back);
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  const delimiter = sp.get("delimiter") === "semicolon" ? ";" : ",";
  if (ids && ids.length === 0) return problem("Tick at least one company, then export again.", 400, back);

  try {
    const file = await exportCompanies({
      ...(ids ? { ids } : { filters: parseCompanyFilters(sp) }),
      format,
      delimiter,
      timeZone: user.timeZone,
    });
    const body = typeof file.body === "string" ? file.body : new Blob([file.body as Uint8Array<ArrayBuffer>]);
    return new Response(body, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentHeader(file.fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ExportTooBigError) return problem(err.message, 413, back);
    console.error("[export] failed", err);
    return problem("The export couldn't be made just now. Try again in a moment; if it keeps failing, restart the app.", 500, back);
  }
}
