import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { billed, requestsFor, resultOf, setupCheckWorld, VALIDATE, type CheckWorld } from "./harness";

/**
 * Resuming, stopping and yielding (M5-DESIGN §2.5 step 7, §0.2 rules 11–12): a run stopped by a shutdown lets the
 * calls in flight finish and stores them, then goes on from where it was; a run that died without saving its place
 * never pays twice (this run's rows are skipped); Stop ends it at the next safe point with "Stopped after …"; a more
 * urgent check run gets its turn within one yield, and a run yields after its time slice.
 */

const t = await createTestDb("verification-run-resume");
let world: CheckWorld;
const { db } = await import("@/server/db");
const { requestJobCancel } = await import("@/server/jobs");
const { getVerifier } = await import("@/server/verification");
const { runVerifyAddresses } = await import("@/server/services/verification/run");
const { commitCheckResult } = await import("@/server/services/verification/commit");
type VerifierResult = import("@/server/verification").VerifierResult;

beforeAll(async () => {
  world = await setupCheckWorld();
});

beforeEach(async () => {
  await world.reset();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const contacts = (personIds: number[]) => ({ source: "contacts", personIds, confirmedCount: personIds.length, recheckRecent: false });

/** The fake Mailgun's verifier, with `after(n)` called after the n-th answer. */
function watched(after: (n: number) => void | Promise<void>): () => Promise<VerifierResult> {
  let n = 0;
  return async () => {
    const res = await getVerifier({ timeoutMs: 2_000 });
    if (!res.ok) return res;
    const inner = res.verifier;
    return {
      ok: true,
      verifier: {
        provider: inner.provider,
        pricePerCheck: inner.pricePerCheck,
        check: async (email: string, emailNorm: string) => {
          const out = await inner.check(email, emailNorm);
          n += 1;
          await after(n);
          return out;
        },
      },
    };
  };
}

async function people(prefix: string, count: number) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(await world.person(`${prefix}${i}@valid.test`));
  return out;
}

function totalBilled(): number {
  return Object.values(billed(world)).reduce((a, b) => a + b, 0);
}

describe("shutdown and restarts", () => {
  it("a shutdown lets the calls in flight finish and stores them; the next run goes on without paying twice", async () => {
    const list = await people("shut", 12);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    const stop = new AbortController();
    const first = await world.run({ signal: stop.signal, deps: { verifier: watched((n) => (n === 5 ? stop.abort() : undefined)) } });
    expect(first).toMatchObject({ outcome: "deferred", deferReason: "yield" });
    // Every answer that came back was stored (the one in flight at the shutdown too).
    const stored = await db.verificationCheck.count({ where: { jobId: job.id } });
    expect(stored).toBe(totalBilled());
    expect(stored).toBeGreaterThanOrEqual(5);
    expect(stored).toBeLessThan(12);
    const carry = resultOf(await world.job(job.id)).carry as { passQueue: number[]; done: number };
    expect(carry.done).toBe(stored);
    expect(carry.passQueue).toHaveLength(12 - stored);

    expect((await world.run())?.outcome).toBe("done");
    for (const p of list) expect(billed(world)[p.emailNorm]).toBe(1);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 12, costUsd: 0.144 });
  });

  it("a run that died without saving its place skips what it already checked (never pays twice)", async () => {
    const list = await people("kill", 8);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    const stop = new AbortController();
    await world.run({ signal: stop.signal, deps: { verifier: watched((n) => (n === 3 ? stop.abort() : undefined)) } });
    const before = totalBilled();
    expect(before).toBeGreaterThanOrEqual(3);
    // As if the process had died before the deferral was saved: the job runs again from the start of its list.
    await db.job.update({ where: { id: job.id }, data: { result: {} } });
    expect((await world.run())?.outcome).toBe("done");
    expect(totalBilled()).toBe(8);
    for (const p of list) expect(billed(world)[p.emailNorm]).toBe(1);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 8 });
  });

  it("the handler run directly (a stale carry) is just as careful", async () => {
    const list = await people("stale", 3);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    expect((await world.run())?.outcome).toBe("done");
    const progress: Array<[number, number]> = [];
    const again = await runVerifyAddresses(job.payload, {
      jobId: job.id,
      createdById: world.owner.id,
      signal: new AbortController().signal,
      progress: async (d, n) => void progress.push([d, n]),
      carry: null,
      queuedAt: job.createdAt,
    }, world.deps());
    expect(totalBilled()).toBe(3);
    expect(again.summary).toBe("3 addresses checked: 3 can be emailed. Cost $0.04.");
    expect(progress.at(-1)).toEqual([3, 3]);
  });
});

describe("answers paid for but not stored yet (carried)", () => {
  it("are stored exactly once, even when the run that stored them fails next or the worker dies before saving its place", async () => {
    const u1 = await world.person("u1@timeout.test");
    const job = await world.enqueue(contacts([u1.personId]));
    // Run 1: the commit fails once, so the paid answer is carried and the run waits a minute.
    let failCommit = true;
    let armAfterCommit = true;
    let failAfterCommit = false;
    const commit: typeof commitCheckResult = async (input) => {
      if (failCommit) {
        failCommit = false;
        throw new Error("database is locked (test)");
      }
      const out = await commitCheckResult(input);
      if (armAfterCommit) {
        armAfterCommit = false;
        failAfterCommit = true;
      }
      return out;
    };
    // Run 2's next database step after storing it fails once (here: the clock of the monthly budget).
    const now = () => {
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("SQLITE_BUSY: database is locked (test)");
      }
      return world.clock.now();
    };
    expect(await world.run({ deps: { commit, now } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const carried = (await world.job(job.id)).result;
    expect((resultOf(await world.job(job.id)).carry as { uncommitted: unknown[] }).uncommitted).toHaveLength(1);

    world.clock.advance(60_000);
    expect(await world.run({ deps: { commit, now } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const after = await world.job(job.id);
    expect(after.attempts).toBe(0);
    expect((resultOf(after).carry as { uncommitted: unknown[] }).uncommitted).toEqual([]);
    expect(await db.verificationCheck.count({ where: { jobId: job.id } })).toBe(1);

    // As if the worker had died before saving the smaller carry: the answer is handed over again.
    await db.job.update({ where: { id: job.id }, data: { result: JSON.parse(JSON.stringify(carried)) } });
    world.clock.advance(60_000);
    expect((await world.run({ deps: { commit, now } }))?.outcome).toBe("done");

    expect(requestsFor(world, "u1@timeout.test")).toBe(1);
    expect(await db.verificationCheck.findMany({ where: { jobId: job.id } })).toMatchObject([{ emailNorm: "u1@timeout.test", costUsd: 0.012 }]);
    // One "no answer", not two: the person gets their 24-hour re-check instead of "Couldn't be checked".
    expect(await db.person.findUniqueOrThrow({ where: { id: u1.personId } })).toMatchObject({ verificationStatus: "UNKNOWN", verificationUnknowns: 1 });
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 1, unknown: 1, costUsd: 0.012 });
  });

  it("Stop while an answer can't be stored: the run waits with it, stores it, then stops (never dropped)", async () => {
    const list = await people("drop", 12);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    const late = list[9]!.emailNorm;
    let blocked = true;
    const commit: typeof commitCheckResult = async (input) => {
      if (blocked && input.emailNorm === late) throw new Error("database is locked (test)");
      return commitCheckResult(input);
    };
    const verifier = async (): Promise<VerifierResult> => {
      const res = await getVerifier({ timeoutMs: 2_000 });
      if (!res.ok) return res;
      const inner = res.verifier;
      let n = 0;
      return {
        ok: true,
        verifier: {
          provider: inner.provider,
          pricePerCheck: inner.pricePerCheck,
          check: async (email: string, emailNorm: string) => {
            const out = await inner.check(email, emailNorm);
            n += 1;
            if (n === 2) await requestJobCancel(job.id, { type: "verify.addresses" });
            // The 10th address answers after the run has noticed the Stop: its answer arrives while draining.
            if (emailNorm === late) await new Promise((r) => setTimeout(r, 200));
            return out;
          },
        },
      };
    };
    expect(await world.run({ deps: { commit, verifier } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const waiting = await world.job(job.id);
    expect(waiting.status).toBe("QUEUED");
    expect(waiting.cancelRequestedAt).not.toBeNull();
    expect((resultOf(waiting).carry as { uncommitted: Array<{ emailNorm: string }> }).uncommitted).toMatchObject([{ emailNorm: late }]);

    blocked = false;
    world.clock.advance(60_000);
    expect((await world.run({ deps: { commit, verifier } }))?.outcome).toBe("done");
    const done = await world.job(job.id);
    const result = resultOf(done);
    expect(result.stopped).toBe(true);
    expect((result.carry as { uncommitted: unknown[] }).uncommitted).toEqual([]);
    // Every paid answer has its row (so this month's check spend is right), the late one included, bought once.
    const stored = await db.verificationCheck.count({ where: { jobId: job.id } });
    expect(stored).toBe(totalBilled());
    expect(billed(world)[late]).toBe(1);
    expect(await db.verificationCheck.count({ where: { jobId: job.id, emailNorm: late } })).toBe(1);
    expect(result.summary).toBe(`Stopped after ${stored} of 12 addresses.`);
  });
});

describe("a problem in the middle of a run", () => {
  it("waits a minute with what the run learned: a time-out isn't forgotten and no address is skipped", async () => {
    const slow = await world.person("late7@valid.test");
    const other = await world.person("other7@valid.test");
    const job = await world.enqueue(contacts([slow.personId, other.personId]));
    world.mg.fake.failNext(VALIDATE, { kind: "delay", ms: 400 }, 1);
    let armed = true;
    let boom = false;
    const verifier = async (): Promise<VerifierResult> => {
      const res = await getVerifier({ timeoutMs: 100 });
      if (!res.ok) return res;
      const inner = res.verifier;
      return {
        ok: true,
        verifier: {
          provider: inner.provider,
          pricePerCheck: inner.pricePerCheck,
          check: (email: string, emailNorm: string) => {
            if (armed && emailNorm === slow.emailNorm) {
              armed = false;
              boom = true;
            }
            return inner.check(email, emailNorm);
          },
        },
      };
    };
    // While the first check is in flight, the next database step fails (here: the clock it reads).
    const now = () => {
      if (boom) {
        boom = false;
        throw new Error("SQLITE_BUSY: database is locked (test)");
      }
      return world.clock.now();
    };
    expect(await world.run({ deps: { verifier, now } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const waiting = await world.job(job.id);
    expect(waiting.attempts).toBe(0);
    const carry = resultOf(waiting).carry as { timeouts: Record<string, number>; pending: number[]; passQueue: number[]; commitDefers: number };
    // The time-out (it may have been billed) is kept, and the address being handled when it failed goes back.
    expect(carry.timeouts[String(slow.personId)]).toBe(1);
    expect(carry).toMatchObject({ pending: [slow.personId], passQueue: [other.personId], commitDefers: 1 });

    world.clock.advance(60_000);
    expect(await world.run({ deps: { verifier, now } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    world.clock.advance(10 * 60_000);
    expect((await world.run({ deps: { verifier, now } }))?.outcome).toBe("done");
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 2, canEmail: 2 });
    // Let the fake's delayed answer to the timed-out request arrive, then count: two requests for the slow address
    // (one timed out), never more, and one for the other.
    await new Promise((r) => setTimeout(r, 450));
    expect(requestsFor(world, "late7@valid.test")).toBe(2);
    expect(requestsFor(world, "other7@valid.test")).toBe(1);
  });
});

describe("Stop", () => {
  it("stops at the next safe point: 'Stopped after …', the calls in flight stored, no 'finished' notice", async () => {
    const list = await people("halt", 25);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    const res = await world.run({
      deps: {
        verifier: watched(async (n) => {
          if (n === 3) expect(await requestJobCancel(job.id, { type: "verify.addresses" })).toBe("requested");
        }),
      },
    });
    expect(res?.outcome).toBe("done");
    const done = await world.job(job.id);
    const result = resultOf(done);
    expect(result.stopped).toBe(true);
    expect(result.summary).toMatch(/^Stopped after \d+ of 25 addresses\.$/);
    const stored = await db.verificationCheck.count({ where: { jobId: job.id } });
    expect(stored).toBe(totalBilled());
    expect(stored).toBeLessThan(25);
    expect(result.summary).toBe(`Stopped after ${stored} of 25 addresses.`);
    expect(await db.notification.count({ where: { type: "verify.finished" } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: "verify.run" } })).toBe(1);
  });

  it("a stop button for another job type never touches a check run", async () => {
    const list = await people("other", 1);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    expect(await requestJobCancel(job.id, { type: "backup.run" })).toBe("not-found");
    expect((await world.job(job.id)).status).toBe("QUEUED");
  });
});

describe("yielding", () => {
  it("a panel check queued during a 40-address Contacts run runs within one yield", async () => {
    const list = await people("big", 40);
    const panelPerson = await world.person("urgent@valid.test");
    const run = await world.enqueue(contacts(list.map((p) => p.personId)));
    let panelId = 0;
    const first = await world.run({
      deps: {
        verifier: watched(async (n) => {
          if (n === 2) {
            panelId = (
              await world.enqueue(
                { source: "panel", personIds: [panelPerson.personId], confirmedCount: 1, recheckRecent: true },
                { priority: 25, createdById: world.member.id },
              )
            ).id;
          }
        }),
      },
    });
    expect(first).toMatchObject({ outcome: "deferred", deferReason: "yield" });
    const yielded = await db.verificationCheck.count({ where: { jobId: run.id } });
    expect(yielded).toBeLessThan(40);
    // The next claim is the panel check, then the Contacts run goes on.
    expect((await world.run())?.outcome).toBe("done");
    expect((await world.job(panelId)).status).toBe("DONE");
    expect((await world.job(run.id)).status).toBe("QUEUED");
    expect((await world.run())?.outcome).toBe("done");
    expect(resultOf(await world.job(run.id)).counts).toMatchObject({ checked: 40 });
    expect(billed(world)["urgent@valid.test"]).toBe(1);
  });

  it("yields after its time slice and picks up where it was", async () => {
    const list = await people("slice", 6);
    const job = await world.enqueue(contacts(list.map((p) => p.personId)));
    let runs = 0;
    for (;;) {
      runs += 1;
      const res = await world.run({ deps: { clockMs: () => Date.now(), yieldAfterMs: 0 } });
      if (res?.outcome === "done") break;
      expect(res).toMatchObject({ outcome: "deferred", deferReason: "yield" });
      expect(runs).toBeLessThan(20);
    }
    expect(runs).toBeGreaterThan(1);
    expect(totalBilled()).toBe(6);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 6 });
  });
});
