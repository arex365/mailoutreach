import type { NextRequest } from "next/server";
import { getUserOrNull } from "@/lib/auth/dal";
import { downloadErrorPage, signInRedirect } from "@/app/api/export/_lib/download-response";
import { attachmentHeader } from "@/server/services/export";
import { buildProblemRowsCsv } from "@/server/services/imports/problems";

/**
 * GET /api/imports/:id/problems — the rows that need a look, as a CSV to fix and re-import.
 * Opened as a plain link: problems come back as a page with a way back to the import.
 */

export const runtime = "nodejs";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/imports/[id]/problems">) {
  const { id } = await ctx.params;
  const sessionId = Number.parseInt(id, 10);
  const valid = Number.isInteger(sessionId) && sessionId > 0;
  const user = await getUserOrNull();
  if (!user) return signInRedirect(valid ? `/import/${sessionId}` : "/import");
  const gone = () =>
    downloadErrorPage({
      title: "The problem rows couldn't be downloaded",
      message: "This import doesn't exist any more. Start a new import from the Import page.",
      status: 404,
      back: { href: "/import", label: "Back to Import" },
    });
  if (!valid) return gone();
  const file = await buildProblemRowsCsv(sessionId);
  if (!file) return gone();
  return new Response(file.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": attachmentHeader(file.fileName),
      "Cache-Control": "no-store",
    },
  });
}
