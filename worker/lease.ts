import { Prisma } from "@/generated/prisma/client";
import { db, dbWrite } from "@/server/db";
import { LEASE_TTL_MS, decideLease, holdsLiveLease, type LeaseDecision, type LeaseRow } from "./lease-decision";

export { LEASE_TTL_MS, HEARTBEAT_MS, LEASE_RETRY_MS, LEASE_SAFETY_MS, decideLease, holdsLiveLease } from "./lease-decision";
export type { LeaseDecision, LeaseRow } from "./lease-decision";

/**
 * The single-instance lease row (WorkerLease id = 1), PLAN.md B1.
 * Every change is one conditional UPDATE, so two workers can never both believe they hold it.
 */

const LEASE_ID = 1;

export type AcquireResult =
  | { acquired: true; decision: Exclude<LeaseDecision, "wait">; previousOwner: string | null }
  | { acquired: false; holder: string; heartbeatAt: Date };

export async function readLease(): Promise<LeaseRow | null> {
  return db.workerLease.findUnique({ where: { id: LEASE_ID }, select: { workerId: true, heartbeatAt: true } });
}

/** Tries to take (or re-take) the lease for `me`. */
export async function acquireLease(me: string, now = new Date()): Promise<AcquireResult> {
  let row = await readLease();

  if (!row) {
    // First worker ever: create the row. If another worker creates it at the same moment, the
    // unique id makes one of the inserts fail and we fall through to the conditional update.
    try {
      await dbWrite((c) =>
        c.workerLease.create({ data: { id: LEASE_ID, workerId: me, heartbeatAt: now, startedAt: now } }),
      );
      return { acquired: true, decision: "take", previousOwner: null };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      row = await readLease();
    }
  }

  const decision = decideLease(now, row, me);
  if (decision === "wait") {
    return { acquired: false, holder: row!.workerId, heartbeatAt: row!.heartbeatAt };
  }

  const staleBefore = new Date(now.getTime() - LEASE_TTL_MS);
  const res = await dbWrite((c) =>
    c.workerLease.updateMany({
      where: { id: LEASE_ID, OR: [{ heartbeatAt: { lt: staleBefore } }, { workerId: me }] },
      data: decision === "take" ? { workerId: me, heartbeatAt: now, startedAt: now } : { heartbeatAt: now },
    }),
  );
  if (res.count === 1) return { acquired: true, decision, previousOwner: row?.workerId ?? null };

  // Someone else renewed or took it between our read and our update.
  const current = await readLease();
  return {
    acquired: false,
    holder: current?.workerId ?? "unknown",
    heartbeatAt: current?.heartbeatAt ?? now,
  };
}

/** Heartbeat. Returns false when the lease is no longer ours (another worker took it over). */
export async function renewLease(me: string, now = new Date()): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.workerLease.updateMany({ where: { id: LEASE_ID, workerId: me }, data: { heartbeatAt: now } }),
  );
  return res.count === 1;
}

/** Whether `me` still holds a fresh lease (checked before every claim). */
export async function ownsLease(me: string, now = new Date()): Promise<boolean> {
  return holdsLiveLease(now, await readLease(), me);
}

/** On a clean shutdown: make the lease immediately available to the next worker. */
export async function releaseLease(me: string): Promise<boolean> {
  const res = await dbWrite((c) =>
    c.workerLease.updateMany({ where: { id: LEASE_ID, workerId: me }, data: { heartbeatAt: new Date(0) } }),
  );
  return res.count === 1;
}
