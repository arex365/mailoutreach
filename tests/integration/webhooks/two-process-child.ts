/**
 * The worker side of two-process.test.ts (PLAN B5.8, B12): while the parent posts ~200 signed webhooks through the route
 * handler, this child process works on the same temp database the way the worker does: the event lane, claims of
 * queued emails (autocommit compare-and-set, as the sending loop does) and a catch-up against the fake Mailgun.
 * Usage: node --import tsx two-process-child.ts <startAtMs> <runForMs> <claimId,claimId,…>
 * DATABASE_URL, OUTREACH_MAILGUN_BASE_URL and APP_ENCRYPTION_KEY come from the parent. Prints one JSON line.
 */
process.env.OUTREACH_PROCESS = "worker";

const [, , startAtRaw, runForRaw, idsRaw] = process.argv;
const startAt = Number(startAtRaw);
const runFor = Number(runForRaw);
const claimIds = (idsRaw ?? "").split(",").filter(Boolean).map(Number);

const { db } = await import("@/server/db");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { claimEmail } = await import("@/server/services/sending/claim");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { getMailgunContext } = await import("@/server/mailgun/context");

await db.systemState.count(); // open the connection before the start line
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

const errors: string[] = [];
const claimed: number[] = [];
let processed = 0;
let catchUps = 0;
const deadline = startAt + runFor;
const text = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

async function lane() {
  const failures = new Map<number, number>();
  while (Date.now() < deadline) {
    try {
      const r = await processPendingMailEvents({ failures, logger: { error: (m, err) => errors.push(`lane: ${m}: ${text(err)}`) } });
      processed += r.processed;
      if (r.processed === 0) await new Promise((res) => setTimeout(res, 20));
    } catch (err) {
      errors.push(`lane: ${text(err)}`);
    }
  }
}

async function claims() {
  for (const id of claimIds) {
    try {
      if (await claimEmail(id, new Date())) claimed.push(id);
    } catch (err) {
      errors.push(`claim ${id}: ${text(err)}`);
    }
    await new Promise((res) => setTimeout(res, 15));
  }
}

async function catchUp() {
  for (let i = 0; i < 2; i++) {
    try {
      await runCatchUp({ reason: "manual", mailgun: () => getMailgunContext({ retryDelayMs: () => 0 }) });
      catchUps += 1;
    } catch (err) {
      errors.push(`catch-up: ${text(err)}`);
    }
  }
}

await Promise.all([lane(), claims(), catchUp()]);
console.log(JSON.stringify({ pid: process.pid, claimed, processed, catchUps, errors }));
await db.$disconnect();

export {};
