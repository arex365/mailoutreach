import { getUserOrNull } from "@/lib/auth/dal";
import { isSameOrigin } from "@/lib/request";
import { fileTooBigMessage, MAX_UPLOAD_BYTES } from "@/core/import/limits";
import type { UploadResponse } from "@/core/import/types";
import { ImportFileError, parsePastedText, parseUploadedFile, type ParsedUpload } from "@/server/services/imports/parse-file";
import { cleanUpAbandonedImports, createImportSession, discardImportSession } from "@/server/services/imports/sessions";

/**
 * POST /api/imports — step 1 of the import: a file (csv, txt, xlsx, xls; ≤ 8 MB) or pasted
 * rows. Parses it, stores the rows (ImportSession + ImportRow) and returns the new session.
 * Multipart fields: file | text, optional sheet (workbooks), optional replace (the id of an
 * import this one replaces, e.g. after picking another sheet).
 *
 * Route Handlers have no body limit of their own, so this one keeps it: the request must say
 * how big it is (Content-Length; browsers always do), and the body is read with a byte counter
 * that stops at the limit, before anything is parsed.
 */

export const runtime = "nodejs";

// Multipart overhead on top of the file itself.
const BODY_SLACK = 256 * 1024;
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + BODY_SLACK;

function error(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/** The request body, or null as soon as it passes `limit` bytes (the rest is never read). */
async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function POST(request: Request) {
  const user = await getUserOrNull();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  if (!isSameOrigin(request)) {
    return error("This upload didn't come from the app's own page. Reload the Import page and try again.", 403);
  }
  const lengthHeader = (request.headers.get("content-length") ?? "").trim();
  if (!/^\d{1,15}$/.test(lengthHeader)) {
    return error("The upload didn't say how big it is, so it wasn't accepted. Reload the Import page and try again.", 411);
  }
  const length = Number(lengthHeader);
  if (length > MAX_BODY_BYTES) return error(fileTooBigMessage(length), 413);

  let form: FormData;
  try {
    const bytes = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!bytes) return error("This upload is bigger than the 8 MB limit. Split the file into two files and import them one after the other.", 413);
    form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return error("We couldn't read the upload. Try again; if it keeps happening, reload the page.", 400);
  }
  const file = form.get("file");
  const text = form.get("text");
  const sheetField = form.get("sheet");
  const sheet = typeof sheetField === "string" && sheetField ? sheetField : null;
  const replaceField = form.get("replace");
  const replaceId = typeof replaceField === "string" ? Number.parseInt(replaceField, 10) : Number.NaN;

  let parsed: ParsedUpload;
  let fileName: string;
  try {
    if (file && typeof file !== "string") {
      if (file.size > MAX_UPLOAD_BYTES) return error(fileTooBigMessage(file.size), 413);
      fileName = (file.name || "upload.csv").split(/[\\/]/).pop()!.slice(0, 200);
      const bytes = new Uint8Array(await file.arrayBuffer());
      parsed = parseUploadedFile(bytes, fileName, sheet);
    } else if (typeof text === "string" && text.trim()) {
      const size = Buffer.byteLength(text, "utf8");
      if (size > MAX_UPLOAD_BYTES) return error(fileTooBigMessage(size, true), 413);
      fileName = "Pasted rows";
      parsed = parsePastedText(text);
    } else {
      return error("Choose a file, or paste some rows first.", 400);
    }
  } catch (err) {
    if (err instanceof ImportFileError) return error(err.message, 400);
    console.error("[import] reading the upload failed", err);
    return error(
      "Something went wrong while reading this file and nothing was saved. Try again; if it keeps happening, save it from Excel as .xlsx and try once more.",
      500,
    );
  }

  let id: number;
  try {
    id = await createImportSession({ userId: user.id, fileName, parsed });
  } catch (err) {
    console.error("[import] saving the rows failed", err);
    return error("The rows couldn't be saved just now. Wait a moment and try again.", 503);
  }
  if (Number.isInteger(replaceId) && replaceId > 0 && replaceId !== id) {
    await discardImportSession(replaceId).catch(() => undefined);
  }
  void cleanUpAbandonedImports();

  const body: UploadResponse = {
    id,
    fileName,
    kind: parsed.kind,
    sheet: parsed.sheet,
    sheets: parsed.sheets,
    rowCount: parsed.table.rows.length,
  };
  return Response.json(body, { status: 201 });
}
