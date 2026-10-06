import { afterAll, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser } from "../campaigns/seed";

/**
 * Stop on a check run that waits between tries (M5-DESIGN §0.2 rules 11 and 14; the step C, P1, P4 and P6 reports):
 * a run whose paid answer couldn't be stored waits a minute with it in `carry.uncommitted`. `requestJobCancel` cancels
 * a waiting run at once, so Stop now stores those answers first (the job is already CANCELLED: the worker can't claim
 * it and store them twice), so the person's result and this month's check spend stay right. A run that had already
 * checked some says how far it got.
 */

const t = await createTestDb("m5-stop-carried");
const { db, dbWrite } = await import("@/server/db");
const { EMPTY_VERIFY_CARRY } = await import("@/core/verification/types");
const { stopCheckRun, storeStrandedAnswers } = await import("@/server/services/verification/start");
const { checksThisMonth } = await import("@/server/services/verification/spend");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const NOW = new Date("2026-09-23T08:00:00.000Z");

function validResult() {
  return { status: "VALID", risk: "LOW", isRole: false, isDisposable: false, didYouMean: null, reasons: [], raw: { result: "deliverable", risk: "low" } };
}

async function waitingRun(opts: { personIds: number[]; uncommitted: unknown[]; done?: number; status?: "QUEUED" | "RUNNING" }) {
  return dbWrite((c) =>
    c.job.create({
      data: {
        type: "verify.addresses",
        status: opts.status ?? "QUEUED",
        runAt: new Date(NOW.getTime() + 60_000),
        payload: { source: "contacts", personIds: opts.personIds, confirmedCount: opts.personIds.length, recheckRecent: false },
        result: JSON.parse(
          JSON.stringify({ carry: { ...EMPTY_VERIFY_CARRY, cursor: opts.personIds.length, uncommitted: opts.uncommitted, commitDefers: 1 }, deferred: "retry-later", defers: 1 }),
        ) as Prisma.InputJsonValue,
        progressDone: opts.done ?? 0,
        progressTotal: opts.personIds.length,
      },
    }),
  );
}

describe("Stop on a waiting check run", () => {
  it("stores the answers it had paid for but not stored yet, then says it stopped", async () => {
    const user = await makeUser("Ali", { role: "OWNER" });
    const { people } = await makeCompany({ name: "Stranded Co", people: [{ name: "Anna", email: "anna@stranded.test" }] });
    const anna = people[0]!;
    const job = await waitingRun({
      personIds: [anna.id],
      uncommitted: [{ personId: anna.id, emailNorm: "anna@stranded.test", result: validResult(), unreadable: false, provider: "mailgun-fake", costUsd: 0.012 }],
    });

    expect(await stopCheckRun({ id: user.id, name: user.name }, job.id, { now: NOW })).toEqual({ message: "Address checks stopped before they started." });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    const rows = await db.verificationCheck.findMany({ where: { jobId: job.id } });
    expect(rows.map((r) => [r.personId, r.emailNorm, r.status, r.costUsd, r.source, r.provider])).toEqual([
      [anna.id, "anna@stranded.test", "VALID", 0.012, "contacts", "mailgun-fake"],
    ]);
    expect(await db.person.findUniqueOrThrow({ where: { id: anna.id } })).toMatchObject({ verificationStatus: "VALID", verificationProvider: "mailgun-fake" });
    expect((await checksThisMonth(NOW)).costUsd).toBeCloseTo(0.012, 6);
    // The cancelled job keeps nothing to store; a second look stores nothing twice.
    const carry = ((await db.job.findUniqueOrThrow({ where: { id: job.id } })).result as { carry: { uncommitted: unknown[] } }).carry;
    expect(carry.uncommitted).toEqual([]);
    expect(await storeStrandedAnswers(job.id, NOW)).toBe(0);
    expect(await db.verificationCheck.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("a waiting run that had checked some says how far it got; a running one is asked to stop and stores nothing here", async () => {
    const user = await makeUser("Sara", { role: "MEMBER" });
    const waiting = await waitingRun({ personIds: [1, 2, 3, 4, 5], uncommitted: [], done: 3 });
    expect(await stopCheckRun({ id: user.id, name: user.name }, waiting.id, { now: NOW })).toEqual({ message: "Stopped after 3 of 5 addresses." });

    const { people } = await makeCompany({ name: "Running Co", people: [{ name: "Ben", email: "ben@running.test" }] });
    const running = await waitingRun({
      personIds: [people[0]!.id],
      status: "RUNNING",
      uncommitted: [{ personId: people[0]!.id, emailNorm: "ben@running.test", result: validResult(), unreadable: false, provider: "mailgun-fake", costUsd: 0.012 }],
    });
    expect(await stopCheckRun({ id: user.id, name: user.name }, running.id, { now: NOW })).toEqual({
      message: "Stopping the address checks. The checks already running finish first.",
    });
    // The running handler stores its carried answers itself (it runs them first).
    expect(await db.verificationCheck.count({ where: { jobId: running.id } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: running.id } })).cancelRequestedAt).not.toBeNull();
  });
});
