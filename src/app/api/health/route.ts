import { db } from "@/server/db";
import { getWorkerStatus } from "@/server/worker-status";

/**
 * GET /api/health — public, no sign-in (PLAN.md B7). Used by start.bat, status.bat, the services
 * installer and the "Apply recommended settings" tunnel check. Returns no secrets and no data:
 * only whether the database answers and when the background sender last checked in.
 */

// Always run at request time (the database answers synchronously, so it must never be prerendered).
export const dynamic = "force-dynamic";

export async function GET() {
  const time = new Date();
  let database: "ok" | "error" = "ok";
  let workerLastSeen: string | null = null;
  try {
    await db.$queryRawUnsafe("SELECT 1");
    const worker = await getWorkerStatus(time);
    // A cleanly stopped worker releases its lease by setting the heartbeat to 1970: report "never".
    workerLastSeen = worker.lastSeen && worker.lastSeen.getTime() > 0 ? worker.lastSeen.toISOString() : null;
  } catch {
    database = "error";
  }
  const ok = database === "ok";
  return Response.json(
    { ok, database, workerLastSeen, time: time.toISOString() },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
