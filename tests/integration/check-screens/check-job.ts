/**
 * A stand-in for the check job (worker/jobs/verify-addresses.ts, built by another package at the same time) for the
 * check screens' tests: it runs one queued `verify.addresses` job to the end with the real verifier (the fake Mailgun,
 * or the test checker in the practice copy) and the real `commitCheckResult`, then leaves the job the way the screens
 * read it (M5-DESIGN §2.5 step 9): `summary`, `counts`, `carry` and, for panel and Settings runs, `single`. It has none
 * of the job's pacing, retries or budget: one call per address, in order. Call createTestDb() first.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { CheckSingleOutcome, VerifyRunCarry } from "@/core/verification/types";

type Item = { personId: number | null; companyId: number | null; email: string | null; emailNorm: string | null; suppressed: boolean };

export async function runCheckJob(jobId: number, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const { db, dbWrite } = await import("@/server/db");
  const { getVerifier } = await import("@/server/verification");
  const { commitCheckResult } = await import("@/server/services/verification/commit");
  const { loadCheckPolicy } = await import("@/server/services/verification/settle");
  const { checkRunCounts, readVerifyRunPayload } = await import("@/server/services/verification/runs");
  const { checkRunSummary } = await import("@/core/verification/words");
  const { checkDecision } = await import("@/core/rules/eligibility");
  const { normalizeEmail } = await import("@/core/email-address");
  const { EMPTY_VERIFY_CARRY } = await import("@/core/verification/types");

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const payload = readVerifyRunPayload(job.payload);
  if (!payload) throw new Error(`Job #${jobId} isn't an address check run.`);
  await dbWrite((c) => c.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: now, attempts: { increment: 1 } } }));

  const verifier = await getVerifier();
  if (!verifier.ok) {
    await dbWrite((c) =>
      c.job.update({ where: { id: jobId }, data: { status: "FAILED", error: verifier.text, finishedAt: now, activeDedupeKey: null } }),
    );
    return;
  }

  const items: Item[] = [];
  if (payload.source === "settings") {
    items.push({ personId: null, companyId: null, email: payload.address, emailNorm: normalizeEmail(payload.address), suppressed: false });
  } else if (payload.source !== "recheck") {
    const people = await db.person.findMany({ where: { id: { in: payload.personIds } }, orderBy: { id: "asc" } });
    const norms = people.map((p) => p.emailNorm).filter((e): e is string => Boolean(e));
    const suppressed = new Set((await db.suppression.findMany({ where: { emailNorm: { in: norms } } })).map((s) => s.emailNorm));
    for (const p of people) {
      items.push({
        personId: p.id,
        companyId: p.companyId,
        email: p.email,
        emailNorm: p.emailNorm,
        suppressed: p.emailNorm ? suppressed.has(p.emailNorm) : false,
      });
    }
  }

  const policy = await loadCheckPolicy();
  const carry: VerifyRunCarry = structuredClone(EMPTY_VERIFY_CARRY);
  let single: CheckSingleOutcome | null = null;
  let done = 0;
  const base = { skipReason: null, status: null, risk: null, disposable: false, decision: null, ms: null, detail: null };
  for (const item of items) {
    done += 1;
    if (!item.email || !item.emailNorm) {
      carry.skipped.noEmail += 1;
      single = { ...base, personId: item.personId, outcome: "skipped", skipReason: "no-email" };
      continue;
    }
    if (item.suppressed) {
      carry.skipped.suppressed += 1;
      single = { ...base, personId: item.personId, outcome: "skipped", skipReason: "suppressed" };
      continue;
    }
    const out = await verifier.verifier.check(item.email, item.emailNorm);
    if (!out.ok) {
      if (out.kind === "rejected") {
        carry.refused += 1;
        carry.failed.push(item.personId ?? 0);
        single = { ...base, personId: item.personId, outcome: "refused", detail: out.detail };
      } else {
        carry.notReached += 1;
        single = { ...base, personId: item.personId, outcome: "not-reached", detail: out.detail };
      }
      continue;
    }
    const committed = await commitCheckResult({
      person:
        item.personId !== null && item.companyId !== null
          ? { id: item.personId, companyId: item.companyId, email: item.email, emailNorm: item.emailNorm }
          : null,
      emailNorm: item.emailNorm,
      result: out.result,
      unreadable: out.unreadable,
      provider: verifier.verifier.provider,
      costUsd: verifier.verifier.pricePerCheck,
      jobId,
      source: payload.source,
      now,
    });
    single = {
      ...base,
      personId: item.personId,
      outcome: out.unreadable ? "not-reached" : "checked",
      status: out.result.status,
      risk: out.result.risk,
      disposable: out.result.isDisposable,
      decision: committed.decision ?? checkDecision(out.result.status, out.result.risk, policy, { disposable: out.result.isDisposable }),
      ms: out.ms,
    };
  }

  const counts = await checkRunCounts(jobId, carry);
  const oneAddress = payload.source === "panel" || payload.source === "settings";
  const result = { summary: checkRunSummary(counts), counts, carry: { ...carry, single: oneAddress ? single : null }, ...(oneAddress ? { single } : {}) };
  await dbWrite((c) =>
    c.job.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        progressDone: done,
        progressTotal: items.length,
        result: result as unknown as Prisma.InputJsonValue,
        finishedAt: now,
        activeDedupeKey: null,
      },
    }),
  );
}

/** Puts a queued run in a state the screens show while it goes on (running, waiting after a deferral, …). */
export async function setRunState(
  jobId: number,
  state: { status: "QUEUED" | "RUNNING"; done?: number; total?: number; runAt?: Date; summary?: string | null },
): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  await dbWrite((c) =>
    c.job.update({
      where: { id: jobId },
      data: {
        status: state.status,
        progressDone: state.done ?? 0,
        progressTotal: state.total ?? 0,
        ...(state.runAt ? { runAt: state.runAt } : {}),
        ...(state.summary !== undefined ? { result: { summary: state.summary } } : {}),
      },
    }),
  );
}
