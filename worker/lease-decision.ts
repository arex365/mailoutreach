/**
 * Single-instance lease (PLAN.md B1). Pure rules, no database access, unit-tested.
 * The database functions that apply them live in ./lease.ts.
 */

/** A lease whose heartbeat is older than this can be taken over. */
export const LEASE_TTL_MS = 60_000;
/** How often the holder refreshes its heartbeat. */
export const HEARTBEAT_MS = 15_000;
/** How often a waiting worker tries again. */
export const LEASE_RETRY_MS = 15_000;
/**
 * The holder stops claiming work once its last successful heartbeat is this old, well before
 * another worker could take over (LEASE_TTL_MS).
 */
export const LEASE_SAFETY_MS = 45_000;

export type LeaseRow = { workerId: string; heartbeatAt: Date };
export type LeaseDecision = "take" | "renew" | "wait";

/**
 * - no lease row yet, or the holder's heartbeat is older than 60 s → "take"
 * - the lease is already mine → "renew"
 * - someone else holds a live lease → "wait" (retry later; never exit)
 */
export function decideLease(now: Date, row: LeaseRow | null, me: string): LeaseDecision {
  if (!row) return "take";
  if (row.workerId === me) return "renew";
  if (now.getTime() - row.heartbeatAt.getTime() > LEASE_TTL_MS) return "take";
  return "wait";
}

/** True while `me` holds a lease that is still fresh enough to keep claiming work. */
export function holdsLiveLease(now: Date, row: LeaseRow | null, me: string, maxAgeMs = LEASE_SAFETY_MS): boolean {
  if (!row || row.workerId !== me) return false;
  return now.getTime() - row.heartbeatAt.getTime() <= maxAgeMs;
}
