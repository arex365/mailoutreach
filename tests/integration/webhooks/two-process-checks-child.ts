/**
 * The worker side of two-process.test.ts's Milestone 5 race (M5-DESIGN §9.1 "two processes writing at once"): while
 * the parent (the web app) approves AI lines, this child process stores address-check results the way the check job
 * does, through the one door `commitCheckResult`, two at a time (the pacer's default), each in its own short
 * transaction. Every fifth result says the address doesn't exist, so the commit also adds the do-not-email entry.
 * Usage: node --import tsx two-process-checks-child.ts <startAtMs> <warmUpPersonId> <personId,personId,…>
 * DATABASE_URL and APP_ENCRYPTION_KEY come from the parent. Prints one JSON line: which people it stored, and any
 * error that reached it (there must be none).
 */
process.env.OUTREACH_PROCESS = "worker";

const [, , startAtRaw, warmUpRaw, idsRaw] = process.argv;
const startAt = Number(startAtRaw);
const warmUpId = Number(warmUpRaw);
const ids = (idsRaw ?? "").split(",").filter(Boolean).map(Number);

const { db } = await import("@/server/db");
const { commitCheckResult } = await import("@/server/services/verification/commit");
type CheckResult = import("@/core/verification/types").CheckResult;

function resultFor(index: number): CheckResult {
  const invalid = index % 5 === 4;
  return {
    status: invalid ? "INVALID" : "VALID",
    risk: invalid ? "HIGH" : "LOW",
    isRole: false,
    isDisposable: false,
    didYouMean: null,
    reasons: invalid ? ["mailbox_does_not_exist"] : [],
    raw: { result: invalid ? "undeliverable" : "deliverable", risk: invalid ? "high" : "low" },
  };
}

async function commitOne(personId: number, index: number): Promise<void> {
  const p = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { id: true, companyId: true, email: true, emailNorm: true } });
  await commitCheckResult({
    person: { id: p.id, companyId: p.companyId, email: p.email!, emailNorm: p.emailNorm! },
    emailNorm: p.emailNorm!,
    result: resultFor(index),
    unreadable: false,
    provider: "mailgun-fake",
    costUsd: 0.012,
    jobId: null,
    source: "contacts",
    now: new Date(),
  });
}

// Before the start line: one commit of its own, so every query of the path is ready and the race is at full speed.
await commitOne(warmUpId, 0);
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

const stored: number[] = [];
const errors: string[] = [];
const text = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
const queue = ids.map((id, i) => ({ id, i }));

const startedAt = Date.now();
await Promise.all(
  Array.from({ length: 2 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await commitOne(item.id, item.i);
        stored.push(item.id);
      } catch (err) {
        errors.push(`person ${item.id}: ${text(err)}`);
      }
    }
  }),
);
const finishedAt = Date.now();

console.log(JSON.stringify({ pid: process.pid, stored, errors, startedAt, finishedAt }));
await db.$disconnect();

export {};
