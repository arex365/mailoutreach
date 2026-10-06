/**
 * Shared set-up for the check job tests (M5-DESIGN §8 P6): the fake Mailgun (its validate route answers by the address
 * rules of §7.1), an Owner and a Member, live sending after go-live, a clock the tests move by hand, a fake elapsed-time
 * clock that the job's sleeps advance (so back-offs and retry waits take no real time), and helpers to make people and
 * to run the next job of the `checks` lane through the real runner. Call createTestDb() first; everything here imports
 * the server modules lazily.
 *
 * Nothing here reaches a real Mailgun host: connectFakeMailgun points OUTREACH_MAILGUN_BASE_URL at the local fake.
 */
import type { Job, Prisma, Risk, VerificationStatus } from "@/generated/prisma/client";
import type { VerifyRunDeps } from "@/server/services/verification/run";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

/** Wednesday 23 Sep 2026, 10:00 in Berlin (13:00 in Karachi). */
export const WED_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
/** The fake's validate route (its fault key). */
export const VALIDATE = "GET /v4/address/validate";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

export type TestClock = { now: () => Date; set: (d: Date) => void; advance: (ms: number) => Date };

export function makeClock(start: Date = WED_10_BERLIN): TestClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = d.getTime();
    },
    advance: (ms) => {
      t += ms;
      return new Date(t);
    },
  };
}

export type PersonOptions = {
  companyStatus?: "NOT_CONTACTED" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT" | "CONTACTED";
  status?: VerificationStatus | null;
  risk?: Risk | null;
  verifiedAt?: Date | null;
  provider?: string | null;
  unknowns?: number;
  disposable?: boolean;
  unsubscribedAt?: Date | null;
  name?: string;
};

export type CheckWorld = {
  mg: FakeConnection;
  owner: { id: number; name: string };
  member: { id: number; name: string };
  clock: TestClock;
  /** The job's elapsed-time clock (ms): its sleeps add to it. */
  elapsed: { ms: number };
  /** Every sleep the job asked for (back-offs, retry waits), in ms. */
  sleeps: number[];
  deps: (extra?: Partial<VerifyRunDeps>) => VerifyRunDeps;
  /** Claims and runs the next due job of the checks lane at the test clock; null when none is due. */
  run: (opts?: { deps?: Partial<VerifyRunDeps>; signal?: AbortSignal }) => Promise<import("../../../worker/runner").RunJobResult | null>;
  enqueue: (payload: Prisma.InputJsonValue, opts?: { createdById?: number | null; priority?: number; dedupeKey?: string; maxAttempts?: number }) => Promise<Job>;
  person: (email: string, opts?: PersonOptions) => Promise<{ companyId: number; personId: number; emailNorm: string }>;
  job: (id: number) => Promise<Job>;
  /** Between tests: a fresh fake, no jobs, no pause or notices, no check rows, the clock back to Wednesday. */
  reset: () => Promise<void>;
};

let seq = 0;

/** Connects the fake Mailgun and makes an Owner (Arslan) and a Member (Ali); live sending after go-live. */
export async function setupCheckWorld(): Promise<CheckWorld> {
  const mg = await connectFakeMailgun();
  const { db, dbWrite } = await import("@/server/db");
  const { getVerifier } = await import("@/server/verification");
  const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  const member = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.goLive", true);
  await setSettingValue("sending.mode", "LIVE");
  const clock = makeClock();
  mg.fake.setNow(clock.now);
  const elapsed = { ms: 0 };
  const sleeps: number[] = [];

  const deps = (extra: Partial<VerifyRunDeps> = {}): VerifyRunDeps => ({
    now: clock.now,
    clockMs: () => elapsed.ms,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Stopped");
      sleeps.push(ms);
      elapsed.ms += ms;
    },
    random: () => 0.5,
    logger: quiet,
    verifier: () => getVerifier({ timeoutMs: 2_000 }),
    ...extra,
  });

  const world: CheckWorld = {
    mg,
    owner: { id: owner.id, name: owner.name },
    member: { id: member.id, name: member.name },
    clock,
    elapsed,
    sleeps,
    deps,
    run: async (opts = {}) => {
      const { claimNextJob, runClaimedJob, WORKER_LANES } = await import("../../../worker/runner");
      const { createVerifyAddressesJob } = await import("../../../worker/jobs/verify-addresses");
      const job = await claimNextJob("w-checks", clock.now(), WORKER_LANES.checks);
      if (!job) return null;
      const registry = { "verify.addresses": createVerifyAddressesJob(deps(opts.deps)) };
      return runClaimedJob(job, {
        workerId: "w-checks",
        registry,
        signal: opts.signal ?? new AbortController().signal,
        logger: quiet,
        lane: WORKER_LANES.checks,
        now: clock.now,
      });
    },
    enqueue: async (payload, opts = {}) => {
      const { enqueueJob } = await import("@/server/jobs");
      return enqueueJob({
        type: "verify.addresses",
        payload,
        runAt: clock.now(),
        priority: opts.priority ?? 10,
        maxAttempts: opts.maxAttempts ?? 3,
        dedupeKey: opts.dedupeKey,
        createdById: opts.createdById === undefined ? owner.id : opts.createdById,
      });
    },
    person: async (email, opts = {}) => {
      seq += 1;
      const { company, people } = await makeCompany({
        name: `Check Co ${seq}`,
        status: opts.companyStatus ?? "NOT_CONTACTED",
        people: [{ name: opts.name ?? `Person ${seq}`, email, unsubscribedAt: opts.unsubscribedAt ?? null }],
      });
      const p = people[0]!;
      if (opts.status !== undefined || opts.unknowns !== undefined || opts.disposable !== undefined) {
        await dbWrite((c) =>
          c.person.update({
            where: { id: p.id },
            data: {
              verificationStatus: opts.status ?? null,
              verificationRisk: opts.risk ?? (opts.status ? "LOW" : null),
              verifiedAt: opts.verifiedAt ?? (opts.status ? clock.now() : null),
              verificationProvider: opts.provider ?? (opts.status ? "mailgun-fake" : null),
              verificationUnknowns: opts.unknowns ?? (opts.status === "UNKNOWN" ? 1 : 0),
              verificationDisposable: opts.disposable ?? false,
            },
          }),
        );
      }
      return { companyId: company.id, personId: p.id, emailNorm: p.emailNorm! };
    },
    job: (id) => db.job.findUniqueOrThrow({ where: { id } }),
    reset: async () => {
      mg.fake.reset();
      mg.fake.setNow(clock.now);
      mg.fake.setSwitches({ validateMaxActive: null, validateSlowMs: 1_500 });
      clock.set(WED_10_BERLIN);
      elapsed.ms = 0;
      sleeps.length = 0;
      await dbWrite(async (c) => {
        await c.job.deleteMany({});
        await c.verificationCheck.deleteMany({});
        await c.notification.deleteMany({});
        await c.activityLog.deleteMany({});
        await c.systemState.deleteMany({ where: { key: { in: ["checks.pause", "notices"] } } });
      });
      await setSettingValue("verification.monthlyLimitUsd", 100);
      await setSettingValue("verification.includedPerMonth", 0);
      await setSettingValue("verification.concurrency", 2);
      await setSettingValue("verification.policy", {
        deliverableHighRisk: "block",
        catchAllLow: "send",
        catchAllMedium: "block",
        catchAllHigh: "block",
        disposable: "block",
        unknown: "recheck",
      });
    },
  };
  return world;
}

/** Billable validate answers per address (lowercase) the fake has given. */
export function billed(world: CheckWorld): Record<string, number> {
  return world.mg.fake.state().validations.byAddress;
}

/** Validate requests the fake answered for one address (billable or not). */
export function requestsFor(world: CheckWorld, address: string): number {
  return world.mg.fake.validations.filter((v) => v.address.toLowerCase() === address.toLowerCase()).length;
}

/** The job's result as stored (summary, counts, carry, single). */
export function resultOf(job: Job): Record<string, unknown> {
  return (job.result ?? {}) as Record<string, unknown>;
}
