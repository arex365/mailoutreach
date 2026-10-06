/**
 * Capped request-body reading for public endpoints (M3-DESIGN §4.4.1). Route Handlers have no body limit of their
 * own, so a public endpoint must never read an unbounded body: a declared Content-Length above the cap is refused
 * before a single byte is read, and a body without one is read through a byte counter that stops at the cap.
 * The same streaming counter as the imports route (src/app/api/imports/route.ts), shared here for the webhooks.
 */

/** The declared Content-Length, or null when missing or unreadable. */
export function declaredLength(request: Request): number | null {
  const raw = (request.headers.get("content-length") ?? "").trim();
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The request body, or null as soon as it passes `limit` bytes (the rest is never read). A Content-Length above the
 * limit returns null at once without reading anything.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = declaredLength(request);
  if (declared !== null && declared > limit) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
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
