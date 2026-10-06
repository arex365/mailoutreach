/**
 * The web side of two-process.test.ts's reply race (PLAN B12 "two processes writing at once", M4-DESIGN §10 P6): while
 * the parent runs the worker's event lane (`processPendingInbound`) over the stored replies, this child process calls
 * `processInboundMessage` for the very same rows, newest first, the way "Simulate a reply" does in the web app.
 * Usage: node --import tsx two-process-replies-child.ts <startAtMs> <warmUpInboundId> <inboundId,inboundId,…>
 * DATABASE_URL and APP_ENCRYPTION_KEY come from the parent. Prints one JSON line: which rows this process processed,
 * how many it found already done, and any error that reached it (there must be none).
 */
process.env.OUTREACH_PROCESS = "web";

const [, , startAtRaw, warmUpRaw, idsRaw] = process.argv;
const startAt = Number(startAtRaw);
const warmUpId = Number(warmUpRaw);
const ids = (idsRaw ?? "").split(",").filter(Boolean).map(Number);

const { db } = await import("@/server/db");
const { processInboundMessage } = await import("@/server/services/replies/process");

// Before the start line: one reply of its own, so every query of the processing path is ready (the parent's lane is
// warm too), and the race below is between two processes working at full speed.
await processInboundMessage(warmUpId);
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

const won: number[] = [];
let alreadyDone = 0;
const errors: string[] = [];
const text = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

const startedAt = Date.now();
for (const id of [...ids].reverse()) {
  try {
    const r = await processInboundMessage(id);
    if (r) won.push(id);
    else alreadyDone += 1;
  } catch (err) {
    errors.push(`reply ${id}: ${text(err)}`);
  }
}
const finishedAt = Date.now();

console.log(JSON.stringify({ pid: process.pid, won, alreadyDone, errors, startedAt, finishedAt }));
await db.$disconnect();

export {};
