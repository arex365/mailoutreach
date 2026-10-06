import { getUserOrNull } from "@/lib/auth/dal";
import { getJob, toPublicJob } from "@/server/jobs";

/**
 * GET /api/jobs/:id — progress of a background task, polled every 2–3 s by progress screens
 * (PLAN.md B6.14, B7). Only the whitelisted fields of toPublicJob() are returned; Mailgun tasks are
 * Owner-only.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const user = await getUserOrNull();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });

  const { id } = await ctx.params;
  const jobId = /^\d{1,10}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return Response.json({ error: "This task doesn't exist." }, { status: 404 });
  }

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "This task doesn't exist any more." }, { status: 404 });
  if (job.type.startsWith("mailgun.") && user.role !== "OWNER") {
    return Response.json({ error: "Only the Owner can see this task." }, { status: 403 });
  }
  return Response.json(toPublicJob(job), { headers: { "Cache-Control": "no-store" } });
}
