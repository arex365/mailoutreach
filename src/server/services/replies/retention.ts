import { db, dbWrite, pauseForOtherWriters } from "@/server/db";

/**
 * Reply texts are kept for 30 days only (M4-DESIGN §3.2, D26; SPEC "no inbox of its own"): 30 days after a reply was
 * processed its `bodyText` and `strippedText` are cleared; the first lines (`snippet`), the classifier's `signals` and
 * every decision stay, so the waiting-list card and the timeline keep working. The daily clean-up (P6,
 * `worker/jobs/cleanup.ts`) calls `clearOldReplyTexts` and counts the result.
 */

/** Days a processed reply keeps its full texts. */
export const REPLY_TEXT_DAYS = 30;
/** Rows per write (PLAN B5: ≤ 500 rows per transaction). */
const CHUNK = 500;

/** Between two writes: lets the worker's other loops and the web app write too. */
const yieldToEventLoop = pauseForOtherWriters;

/**
 * Clears `bodyText` and `strippedText` of every reply processed more than `days` (30) days before `now`, in writes of
 * at most 500 rows (the `processedAt` index finds them), yielding between them. Unprocessed replies are never touched
 * (the processor still needs their text). Returns how many replies lost their text.
 */
export async function clearOldReplyTexts(opts: { now?: Date; days?: number; chunk?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.floor(opts.days ?? REPLY_TEXT_DAYS));
  const chunk = Math.max(1, Math.min(CHUNK, Math.floor(opts.chunk ?? CHUNK)));
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const where = { processedAt: { lt: cutoff }, OR: [{ bodyText: { not: null } }, { strippedText: { not: null } }] };
  let cleared = 0;
  for (;;) {
    const rows = await db.inboundMessage.findMany({ where, orderBy: { id: "asc" }, take: chunk, select: { id: true } });
    if (rows.length === 0) break;
    const res = await dbWrite((c) =>
      c.inboundMessage.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, processedAt: { lt: cutoff } },
        data: { bodyText: null, strippedText: null },
      }),
    );
    cleared += res.count;
    if (rows.length < chunk) break;
    await yieldToEventLoop();
  }
  return cleared;
}
