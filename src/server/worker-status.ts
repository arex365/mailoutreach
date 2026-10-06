import { db } from "./db";

/** Whether the background sender (worker) is running, for the UI and /api/health. */
export async function getWorkerStatus(now = new Date()): Promise<{ running: boolean; lastSeen: Date | null }> {
  const lease = await db.workerLease.findUnique({ where: { id: 1 } });
  if (!lease) return { running: false, lastSeen: null };
  const running = now.getTime() - lease.heartbeatAt.getTime() < 60_000;
  // A clean stop releases the lease by setting the heartbeat to 1970: treat that as "no last check".
  return { running, lastSeen: lease.heartbeatAt.getTime() > 0 ? lease.heartbeatAt : null };
}
