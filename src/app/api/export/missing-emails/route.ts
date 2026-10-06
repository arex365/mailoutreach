import type { NextRequest } from "next/server";
import { getUserOrNull } from "@/lib/auth/dal";
import { companyFiltersToParams, parseCompanyFilters } from "@/server/services/companies/filters";
import { attachmentHeader, exportMissingEmails, ExportTooBigError } from "@/server/services/export";
import { downloadErrorPage, signInRedirect } from "../_lib/download-response";

/**
 * GET /api/export/missing-emails — "Export for Claude" on the Missing email view (PLAN.md B6.13).
 *   ?format=csv|xlsx (default csv) · ?delimiter=semicolon · plus the Contacts filters
 *   (companyFiltersToParams). Always limited to companies without an email address.
 * Read-only: nothing is logged or changed. Problems come back as a page with a way back.
 */

export const runtime = "nodejs";

function contactsUrl(sp: URLSearchParams): string {
  const p = companyFiltersToParams({ ...parseCompanyFilters(sp), view: "missing-email", page: 1 });
  return `/contacts?${p.toString()}`;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const back = contactsUrl(sp);
  const user = await getUserOrNull();
  if (!user) return signInRedirect(back);
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  const delimiter = sp.get("delimiter") === "semicolon" ? ";" : ",";
  const problem = (message: string, status: number) =>
    downloadErrorPage({ title: "The export didn't work", message, status, back: { href: back, label: "Back to Contacts" } });

  try {
    const file = await exportMissingEmails({ filters: parseCompanyFilters(sp), format, delimiter, timeZone: user.timeZone });
    const body = typeof file.body === "string" ? file.body : new Blob([file.body as Uint8Array<ArrayBuffer>]);
    return new Response(body, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentHeader(file.fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ExportTooBigError) return problem(err.message, 413);
    console.error("[export] missing emails failed", err);
    return problem("The export couldn't be made just now. Try again in a moment; if it keeps failing, restart the app.", 500);
  }
}
